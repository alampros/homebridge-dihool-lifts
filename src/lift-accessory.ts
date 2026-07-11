import type { PlatformAccessory, Service, Characteristic, CharacteristicValue } from 'homebridge';
import type { DihoolLiftsPlatform } from './platform.js';
import type { DeviceParams, AccessoryContext } from './types.js';
import { LiftStateTracker } from './position-tracker.js';
import { DEFAULTS } from './utils/constants.js';

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

  private readonly tracker: LiftStateTracker;
  private coveringService: Service;

  private readonly manualSwitches: boolean;

  private isOnline = true;
  private cosmeticTimer: NodeJS.Timeout | undefined;
  private pendingOperation: Promise<void> = Promise.resolve();

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

    const operationTimeUp = deviceConfig?.operationTimeUp ?? DEFAULTS.operationTimeUp;
    const operationTimeDown = deviceConfig?.operationTimeDown ?? DEFAULTS.operationTimeDown;

    // State tracker — persists to Homebridge storage directory
    this.tracker = new LiftStateTracker({
      deviceId: this.deviceId,
      travelTimeUpSec: operationTimeUp,
      travelTimeDownSec: operationTimeDown,
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
        if (!this.isOnline) {
          throw new this.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
        return this.tracker.getPosition();
      });

    // Manual override switches — raw pulses that bypass state tracking
    this.configureManualSwitches();

    this.log.info(
      '[%s] Initialised (up=CH%d, down=CH%d, timeUp=%ds, timeDown=%ds, position=%d%%)',
      this.name, this.upChannel, this.downChannel,
      operationTimeUp, operationTimeDown, pos,
    );
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
        this.coveringService.updateCharacteristic(this.Characteristic.CurrentPosition, finalPos);
        this.coveringService.updateCharacteristic(this.Characteristic.TargetPosition, finalPos);
        this.coveringService.updateCharacteristic(
          this.Characteristic.PositionState,
          this.Characteristic.PositionState.STOPPED,
        );
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
    if (this.cosmeticTimer) {
      clearTimeout(this.cosmeticTimer);
      this.cosmeticTimer = undefined;
    }
    this.tracker.save();
  }
}
