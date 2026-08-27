import type { PlatformAccessory, Service, Characteristic, CharacteristicValue } from 'homebridge';
import type { DihoolLiftsPlatform } from './platform.js';
import type { DeviceParams, AccessoryContext } from './types.js';
import type { LiftSenseMotorEvent } from './connection/liftsense-callback-server.js';
import { LiftStateTracker } from './position-tracker.js';
import {
  LiftSenseEsp32,
  motorDirectionFromStatus,
  type LiftSenseMotorDirection,
  type LiftSenseStatus,
} from './connection/liftsense-esp32.js';
import { positionFromDistance } from './position-from-distance.js';
import { DEFAULTS } from './utils/constants.js';

const POSITION_PUBLISH_DEADBAND_PERCENT = 2;

/**
 * Core device handler for a DIHOOL IPS-S2 scissor lift, exposed as a
 * HomeKit WindowCovering.
 *
 * WindowCovering was chosen over GarageDoorOpener because garage doors
 * require phone authentication for Siri/HomePod control, making them
 * impractical for hands-free accessibility use.
 *
 * Position mapping:
 *   0%   = fully lowered (closed)
 *   100% = fully raised (open)
 *
 * The IPS-S2 is a 4-channel eWeLink device (UIID 139) where:
 *   CH0 = UP motor   (500ms pulse mode)
 *   CH1 = DOWN motor (500ms pulse mode)
 *   CH2, CH3 = unused / always "on"
 *
 * This implementation uses binary state only (0% or 100%). The software
 * sends a SINGLE pulse to start movement and NEVER sends a stop pulse —
 * hardware limit switches handle all stopping.
 */
export class LiftAccessory {
  private readonly platform: DihoolLiftsPlatform;
  private readonly accessory: PlatformAccessory<AccessoryContext>;
  private readonly log: DihoolLiftsPlatform['log'];
  private readonly Characteristic: typeof Characteristic;
  private readonly Service: typeof Service;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly HapStatusError: any;

  private readonly deviceId: string;
  private readonly upChannel: number;
  private readonly downChannel: number;
  private readonly name: string;
  private readonly debug: boolean;
  private readonly esp32DebugLogging: boolean;
  private readonly esp32SyncTargetPosition: boolean;
  private readonly invertMotorChannelDirections: boolean;

  private readonly tracker: LiftStateTracker;
  private coveringService: Service;

  private readonly manualSwitches: boolean;

  private isOnline = true;
  private cosmeticTimer: NodeJS.Timeout | undefined;
  private pendingOperation: Promise<void> = Promise.resolve();
  private esp32Client?: LiftSenseEsp32;
  private unregisterLiftSenseCallback?: () => void;
  private esp32Position?: number;
  private esp32Available?: boolean;
  private invalidCalibrationLogged = false;
  private invalidMotorStateLogged = false;
  private esp32MotorDirection?: LiftSenseMotorDirection;

  constructor(platform: DihoolLiftsPlatform, accessory: PlatformAccessory<AccessoryContext>) {
    this.platform = platform;
    this.accessory = accessory;
    this.log = platform.log;

    const hap = platform.api.hap;
    this.Characteristic = hap.Characteristic;
    this.Service = hap.Service;
    this.HapStatusError = (hap as Record<string, unknown>).HapStatusError ?? (hap as Record<string, unknown>).HAPStatusError;
    if (!this.HapStatusError) {
      this.HapStatusError = class extends Error {
        constructor(status: number) { super(`HAP Status Error: ${status}`); }
      };
    }

    this.deviceId = accessory.context.deviceId;
    this.name = accessory.displayName;

    // Read per-device overrides from platform config
    const deviceConfig = platform.getDeviceConfig(this.deviceId);
    this.upChannel = deviceConfig?.upChannel ?? DEFAULTS.upChannel;
    this.downChannel = deviceConfig?.downChannel ?? DEFAULTS.downChannel;
    this.manualSwitches = deviceConfig?.manualSwitches ?? false;
    this.debug = (platform.config as { debug?: boolean }).debug ?? false;
    this.esp32DebugLogging = deviceConfig?.esp32DebugLogging ?? false;
    this.esp32SyncTargetPosition = deviceConfig?.esp32SyncTargetPosition ?? false;
    this.invertMotorChannelDirections = deviceConfig?.invertMotorChannelDirections ?? false;

    // State tracker — persists to Homebridge storage directory
    this.tracker = new LiftStateTracker({
      deviceId: this.deviceId,
      travelTimeUpSec: DEFAULTS.operationTimeUp,
      travelTimeDownSec: DEFAULTS.operationTimeDown,
      storagePath: platform.api.user.storagePath(),
      log: (msg) => this.log.info('[%s] [tracker] %s', this.name, msg),
    });

    // Remove stale services from previous configurations
    const staleServices = [
      this.Service.Switch,
      this.Service.ContactSensor,
      this.Service.GarageDoorOpener,
    ];
    for (const serviceType of staleServices) {
      const existing = this.accessory.getService(serviceType);
      if (existing) {
        this.accessory.removeService(existing);
      }
    }

    // Add or get the WindowCovering service
    this.coveringService =
      this.accessory.getService(this.Service.WindowCovering) ??
      this.accessory.addService(this.Service.WindowCovering);

    // StatusActive is not part of the WindowCovering service definition and
    // Home.app can render it as persistent activity. Remove it from cached
    // accessories created by earlier plugin versions.
    if (this.coveringService.testCharacteristic(this.Characteristic.StatusActive)) {
      this.coveringService.removeCharacteristic(
        this.coveringService.getCharacteristic(this.Characteristic.StatusActive),
      );
    }

    // Initialize characteristics from tracker state
    const pos = this.tracker.getPosition();
    this.coveringService.setCharacteristic(this.Characteristic.CurrentPosition, pos);
    this.coveringService.setCharacteristic(this.Characteristic.TargetPosition, pos);
    this.coveringService.setCharacteristic(
      this.Characteristic.PositionState,
      this.Characteristic.PositionState.STOPPED,
    );

    // AccessoryInformation
    const infoService =
      this.accessory.getService(this.Service.AccessoryInformation) ??
      this.accessory.addService(this.Service.AccessoryInformation);
    infoService
      .setCharacteristic(this.Characteristic.Manufacturer, 'DIHOOL')
      .setCharacteristic(this.Characteristic.Model, 'IPS-S2');

    // Register handlers
    this.coveringService
      .getCharacteristic(this.Characteristic.TargetPosition)
      .onSet(this.handleTargetPositionSet.bind(this));

    this.coveringService
      .getCharacteristic(this.Characteristic.CurrentPosition)
      .onGet(() => {
        if (this.esp32Available === true && this.esp32Position !== undefined) {
          return this.esp32Position;
        }
        if (!this.isOnline) {
          throw new this.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
        return this.tracker.getPosition();
      });

    // Manual override switches — raw pulses that bypass state tracking
    this.configureManualSwitches();
    this.configureEsp32Status();

    this.log.info(
      '[%s] Initialised (up=CH%d, down=CH%d, position=%d%%)',
      this.name, this.upChannel, this.downChannel,
      pos,
    );
  }

  private configureEsp32Status(): void {
    const config = this.platform.getDeviceConfig(this.deviceId);
    if (!config?.esp32Host || !config.esp32Token) {
      return;
    }

    const pollIntervalMs = Math.max(1, config.esp32PollIntervalSec ?? 2) * 1000;
    const callbackUrl = this.platform.getLiftSenseCallbackUrl();
    this.esp32Client = new LiftSenseEsp32(
      config.esp32Host,
      config.esp32Token,
      pollIntervalMs,
      (status, error) => this.handleEsp32Status(status, error),
      callbackUrl,
    );
    if (callbackUrl) {
      this.unregisterLiftSenseCallback = this.platform.registerLiftSenseCallback(
        this.deviceId,
        config.esp32Token,
        (event) => this.handleLiftSenseMotorEvent(event),
      );
    }
    this.esp32Client.start();
    this.log.info('[%s] Polling LiftSense ESP32 at %s', this.name, config.esp32Host);
  }

  private handleLiftSenseMotorEvent(event: LiftSenseMotorEvent): void {
    this.esp32Client?.notifyMotorState(
      event.motorChannel1Active,
      event.motorChannel2Active,
    );
    this.updateMotorPositionState(motorDirectionFromStatus({
      distanceMm: 0,
      sensorTimeout: false,
      motorChannel1Active: event.motorChannel1Active,
      motorChannel2Active: event.motorChannel2Active,
    }, this.invertMotorChannelDirections));
  }

  private handleEsp32Status(status: LiftSenseStatus | undefined, error?: Error): void {
    const active = !!status && !status.sensorTimeout;

    if (status && !status.sensorTimeout) {
      const position = this.positionFromDistance(status.distanceMm);
      if (position === undefined) {
        if (!this.invalidCalibrationLogged) {
          this.log.error(
            '[%s] Invalid LiftSense calibration: maxDistanceMm must be greater than minDistanceMm',
            this.name,
          );
          this.invalidCalibrationLogged = true;
        }
        this.esp32Available = false;
        return;
      }

      this.invalidCalibrationLogged = false;
      const motorDirection = motorDirectionFromStatus(status, this.invertMotorChannelDirections);
      const previousPosition = this.esp32Position;
      const positionChanged = previousPosition === undefined ||
        Math.abs(position - previousPosition) >= POSITION_PUBLISH_DEADBAND_PERCENT ||
        ((position === 0 || position === 100) && position !== previousPosition);
      if (positionChanged) {
        this.esp32Position = position;
        this.coveringService.updateCharacteristic(this.Characteristic.CurrentPosition, position);
      }
      if (this.esp32SyncTargetPosition && motorDirection === 'stopped') {
        // A stopped WindowCovering needs matching current and target values
        // for Home.app to render "46% Open" instead of the generic "Open".
        // updateCharacteristic() publishes cached HomeKit state without
        // invoking handleTargetPositionSet(), so this cannot send a pulse.
        this.coveringService.updateCharacteristic(this.Characteristic.TargetPosition, position);
      }
      this.updateMotorPositionState(motorDirection);
      if (this.esp32Available !== true) {
        this.log.info(
          '[%s] LiftSense ESP32 connected (distance=%d mm, position=%d%%)',
          this.name, status.distanceMm, position,
        );
      }
      if (this.esp32DebugLogging) {
        const rawDistance = status.rawDistanceMm === undefined
          ? ''
          : ` (raw: ${status.rawDistanceMm} mm)`;
        this.log.info(
          '[%s] ESP32 distance: %d mm%s → position: %d%%, motor: %s',
          this.name, status.distanceMm, rawDistance, position, motorDirection,
        );
      }
    } else if (this.esp32Available !== false) {
      const reason = error?.message ?? 'sensor timeout';
      this.log.warn('[%s] LiftSense ESP32 unavailable: %s', this.name, reason);
    }

    this.esp32Available = active;
  }

  private updateMotorPositionState(direction: LiftSenseMotorDirection): void {
    if (direction === 'unknown') {
      // Backward compatibility with firmware that predates motor telemetry:
      // leave the current HomeKit movement state alone.
      return;
    }

    if (direction !== this.esp32MotorDirection) {
      this.log.info('[%s] LiftSense motor state: %s', this.name, direction);
      this.esp32MotorDirection = direction;
    }

    if (direction === 'invalid') {
      if (!this.invalidMotorStateLogged) {
        this.log.warn(
          '[%s] LiftSense reports both motor channels active; showing stopped until the inputs are valid',
          this.name,
        );
        this.invalidMotorStateLogged = true;
      }
    } else {
      this.invalidMotorStateLogged = false;
    }

    const positionState = direction === 'up'
      ? this.Characteristic.PositionState.INCREASING
      : direction === 'down'
        ? this.Characteristic.PositionState.DECREASING
        : this.Characteristic.PositionState.STOPPED;
    this.coveringService.updateCharacteristic(this.Characteristic.PositionState, positionState);
  }

  private positionFromDistance(distanceMm: number): number | undefined {
    const config = this.platform.getDeviceConfig(this.deviceId);
    let minDistanceMm = config?.minDistanceMm;
    let maxDistanceMm = config?.maxDistanceMm;

    // Backward compatibility for configurations created before the endpoint
    // names explicitly described the min/max distance contract.
    if (minDistanceMm === undefined || maxDistanceMm === undefined) {
      const raisedDistanceMm = config?.raisedDistanceMm ?? 150;
      const loweredDistanceMm = config?.loweredDistanceMm ?? 1000;
      const decreasesWhenRising = config?.distanceDecreasesWhenRising ?? true;
      const legacyPosition = positionFromDistance(distanceMm, {
        minDistanceMm: Math.min(raisedDistanceMm, loweredDistanceMm),
        maxDistanceMm: Math.max(raisedDistanceMm, loweredDistanceMm),
      });
      return decreasesWhenRising || legacyPosition === undefined
        ? legacyPosition
        : 100 - legacyPosition;
    }

    return positionFromDistance(distanceMm, {
      minDistanceMm,
      maxDistanceMm,
    });
  }

  // -----------------------------------------------------------------------
  // Manual override switches
  // -----------------------------------------------------------------------

  private configureManualSwitches(): void {
    const SUBTYPE_UP = 'manual-up';
    const SUBTYPE_DOWN = 'manual-down';

    if (!this.manualSwitches) {
      // Remove manual switch services if they exist from a previous config
      for (const subtype of [SUBTYPE_UP, SUBTYPE_DOWN]) {
        const existing = this.accessory.getServiceById(this.Service.Switch, subtype);
        if (existing) {
          this.accessory.removeService(existing);
        }
      }
      return;
    }

    // Manual Up switch
    const upSwitch =
      this.accessory.getServiceById(this.Service.Switch, SUBTYPE_UP) ??
      this.accessory.addService(this.Service.Switch, 'Manual Up', SUBTYPE_UP);
    upSwitch.setCharacteristic(this.Characteristic.Name, 'Manual Up');
    if (this.Characteristic.ConfiguredName) {
      upSwitch.setCharacteristic(this.Characteristic.ConfiguredName, 'Manual Up');
    }
    upSwitch.getCharacteristic(this.Characteristic.On)
      .onSet(async (value: CharacteristicValue) => {
        if (!value) return; // ignore off
        this.log.info('[%s] Manual UP pulse (CH%d)', this.name, this.upChannel);
        try {
          await this.pulseChannel(this.upChannel);
        } catch (err) {
          this.log.warn('[%s] Manual UP failed: %s', this.name, err instanceof Error ? err.message : String(err));
        }
        // Flip back to off (momentary)
        setTimeout(() => {
          upSwitch.updateCharacteristic(this.Characteristic.On, false);
        }, 500);
      })
      .onGet(() => false);

    // Manual Down switch
    const downSwitch =
      this.accessory.getServiceById(this.Service.Switch, SUBTYPE_DOWN) ??
      this.accessory.addService(this.Service.Switch, 'Manual Down', SUBTYPE_DOWN);
    downSwitch.setCharacteristic(this.Characteristic.Name, 'Manual Down');
    if (this.Characteristic.ConfiguredName) {
      downSwitch.setCharacteristic(this.Characteristic.ConfiguredName, 'Manual Down');
    }
    downSwitch.getCharacteristic(this.Characteristic.On)
      .onSet(async (value: CharacteristicValue) => {
        if (!value) return; // ignore off
        this.log.info('[%s] Manual DOWN pulse (CH%d)', this.name, this.downChannel);
        try {
          await this.pulseChannel(this.downChannel);
        } catch (err) {
          this.log.warn('[%s] Manual DOWN failed: %s', this.name, err instanceof Error ? err.message : String(err));
        }
        // Flip back to off (momentary)
        setTimeout(() => {
          downSwitch.updateCharacteristic(this.Characteristic.On, false);
        }, 500);
      })
      .onGet(() => false);
  }

  // -----------------------------------------------------------------------
  // HomeKit handlers
  // -----------------------------------------------------------------------

  private async handleTargetPositionSet(value: CharacteristicValue): Promise<void> {
    this.pendingOperation = this.pendingOperation.then(
      () => this._handleTargetPositionSet(value),
      () => this._handleTargetPositionSet(value),
    );
    return this.pendingOperation;
  }

  /**
   * Called when the user sets a target position in the Home app (0–100).
   *
   * Flow:
   *   1. Clamp target to binary 0 or 100.
   *   2. Ask tracker to start movement. If it returns false, no-op.
   *   3. Pulse the appropriate motor channel (ONE pulse, no stop pulse ever).
   *   4. Set a cosmetic timer. When it fires, call completeMovement() and
   *      update HomeKit. This timer NEVER sends any command to the hardware.
   */
  private async _handleTargetPositionSet(value: CharacteristicValue): Promise<void> {
    const target = value as number;
    this.log.info('[%s] Target position set to %d%%', this.name, target);

    try {
      // Clamp to binary: >= 50 → 100 (up), < 50 → 0 (down)
      const binaryTarget = target >= 50 ? 100 : 0;
      const direction: 'up' | 'down' = binaryTarget === 100 ? 'up' : 'down';

      // Motor decisions intentionally use only the existing command tracker.
      // ESP32 distance data is read-only telemetry and must never cause a
      // pulse, suppress a pulse, or otherwise control lift movement.
      const shouldPulse = this.tracker.startMovement(direction);

      if (!shouldPulse) {
        // Already at destination or already moving that direction — sync HomeKit and bail
        const pos = this.tracker.getPosition();
        this.coveringService.updateCharacteristic(this.Characteristic.CurrentPosition, pos);
        this.coveringService.updateCharacteristic(this.Characteristic.TargetPosition, pos);
        this.coveringService.updateCharacteristic(
          this.Characteristic.PositionState,
          this.Characteristic.PositionState.STOPPED,
        );
        this.log.info('[%s] No movement needed (position=%d%%)', this.name, pos);
        return;
      }

      // Update HomeKit to show movement
      const positionState = direction === 'up'
        ? this.Characteristic.PositionState.INCREASING
        : this.Characteristic.PositionState.DECREASING;
      this.coveringService.updateCharacteristic(this.Characteristic.PositionState, positionState);
      this.coveringService.updateCharacteristic(this.Characteristic.TargetPosition, binaryTarget);

      const channel = direction === 'up' ? this.upChannel : this.downChannel;
      this.log.info('[%s] %s → %d%% (CH%d)', this.name, direction === 'up' ? 'Raising' : 'Lowering', binaryTarget, channel);

      // Pulse the motor channel to start movement
      await this.pulseChannel(channel);

      // Set cosmetic timer — never sends a command to hardware
      const settledAt = this.tracker.settledAt();
      const delayMs = Math.max(0, settledAt - Date.now());
      this.cosmeticTimer = setTimeout(() => {
        this.tracker.completeMovement();
        const finalPos = this.tracker.getPosition();
        if (this.esp32Available !== true) {
          this.coveringService.updateCharacteristic(this.Characteristic.CurrentPosition, finalPos);
          this.coveringService.updateCharacteristic(this.Characteristic.TargetPosition, finalPos);
          this.coveringService.updateCharacteristic(
            this.Characteristic.PositionState,
            this.Characteristic.PositionState.STOPPED,
          );
        }
        this.log.info('[%s] Arrived at %d%%', this.name, finalPos);
      }, delayMs);
    } catch (err) {
      await this.handleError(err);
    }
  }

  /**
   * Handle errors during movement. Resets state and notifies HomeKit.
   */
  private async handleError(err: unknown): Promise<void> {
    if (this.cosmeticTimer) {
      clearTimeout(this.cosmeticTimer);
      this.cosmeticTimer = undefined;
    }

    const pos = this.tracker.getPosition();
    this.coveringService.updateCharacteristic(this.Characteristic.CurrentPosition, pos);
    this.coveringService.updateCharacteristic(this.Characteristic.TargetPosition, pos);
    this.coveringService.updateCharacteristic(
      this.Characteristic.PositionState,
      this.Characteristic.PositionState.STOPPED,
    );

    this.log.error('[%s] Error: %s', this.name, err instanceof Error ? err.message : String(err));
    throw new this.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }

  // -----------------------------------------------------------------------
  // Device communication
  // -----------------------------------------------------------------------

  /**
   * Send a single 500ms pulse to the specified outlet channel.
   * The device's inching mode auto-reverts the switch after the pulse.
   */
  private async pulseChannel(channel: number): Promise<void> {
    await this.platform.sendDeviceUpdate(this.accessory, {
      switches: [{ switch: 'on', outlet: channel }],
    });
  }

  // -----------------------------------------------------------------------
  // External updates
  // -----------------------------------------------------------------------

  /**
   * Called when the device broadcasts state via mDNS.
   */
  public externalUpdate(params: DeviceParams): void {
    if (this.debug) {
      this.log.debug('[%s] externalUpdate: %s', this.name, JSON.stringify(params.switches));
    }
  }

  public markStatus(isOnline: boolean): void {
    this.isOnline = isOnline;
  }

  public destroy(): void {
    this.unregisterLiftSenseCallback?.();
    this.esp32Client?.stop();
    if (this.cosmeticTimer) {
      clearTimeout(this.cosmeticTimer);
      this.cosmeticTimer = undefined;
    }
    this.tracker.save();
  }
}
