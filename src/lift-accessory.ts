import type { PlatformAccessory, Service, Characteristic, CharacteristicValue } from 'homebridge';
import type { DihoolLiftsPlatform } from './platform.js';
import type { DeviceParams, AccessoryContext } from './types.js';
import { PositionTracker } from './position-tracker.js';
import type { MovementPlan } from './position-tracker.js';
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
 * Position is estimated via timer-based tracking: we know the full travel
 * time and integrate elapsed motor run-time to approximate position.
 * Commanding 0% or 100% runs the motor for full travel + extra time,
 * letting the physical limit switches stop the motor and recalibrating
 * the position estimate (correcting drift).
 *
 * On first boot (or after a crash during movement), position is unknown.
 * The first user command triggers a calibration move (the tracker decides
 * direction based on whether target is <= 50 or > 50).
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

  private readonly tracker: PositionTracker;
  private coveringService: Service;

  private isOnline = true;
  private operationTimer: NodeJS.Timeout | undefined;
  private pendingOperation: Promise<void> = Promise.resolve();
  /** True while we are actively driving the motor. Suppresses external updates. */
  private inFlight = false;
  /**
   * Whether the current in-flight operation is a calibration move.
   * Calibration moves should NOT send a stop pulse on completion because
   * the motor already stopped at the physical limit switch — pulsing
   * again would restart it.
   */
  private inFlightCalibration = false;

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
    this.debug = (platform.config as { debug?: boolean }).debug ?? false;

    const operationTimeUp = deviceConfig?.operationTimeUp ?? DEFAULTS.operationTimeUp;
    const operationTimeDown = deviceConfig?.operationTimeDown ?? DEFAULTS.operationTimeDown;
    const calibrationExtra = deviceConfig?.calibrationExtra ?? DEFAULTS.calibrationExtra;

    // Position tracker — persists to Homebridge storage directory
    this.tracker = new PositionTracker({
      deviceId: this.deviceId,
      travelTimeUpSec: operationTimeUp,
      travelTimeDownSec: operationTimeDown,
      calibrationExtraSec: calibrationExtra,
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
    const pos = this.tracker.getCurrentPosition();
    this.coveringService.setCharacteristic(
      this.Characteristic.CurrentPosition,
      pos ?? 0,
    );
    this.coveringService.setCharacteristic(
      this.Characteristic.TargetPosition,
      pos ?? 0,
    );
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
        return this.tracker.getCurrentPosition() ?? 0;
      });

    // Log initial position state (calibration is lazy — triggered by first command)
    const state = this.tracker.getState();
    if (state.phase === 'unknown') {
      this.log.warn(
        '[%s] Position unknown — will calibrate on first command',
        this.name,
      );
    }

    this.log.info(
      '[%s] Initialised (up=CH%d, down=CH%d, timeUp=%ds, timeDown=%ds, position=%s)',
      this.name, this.upChannel, this.downChannel,
      operationTimeUp, operationTimeDown,
      pos !== null ? `${Math.round(pos)}%` : 'unknown',
    );
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
   *   1. If currently moving, snapshot the interpolated position and stop motor.
   *   2. Ask the tracker for a movement plan (direction, duration).
   *   3. Pulse the appropriate motor channel.
   *   4. Set a timer for the planned duration.
   *   5. On timer fire: stop motor (if not calibration), finalize position,
   *      update HomeKit.
   */
  private async _handleTargetPositionSet(value: CharacteristicValue): Promise<void> {
    const target = value as number;
    this.log.info('[%s] Target position set to %d%%', this.name, target);

    try {
      // If currently moving, stop first
      if (this.inFlight) {
        await this.stopMotor();
      }

      // Ask tracker for a plan
      const plan = this.tracker.startMovement(target);

      if (!plan) {
        // Already at target or calibrating — sync HomeKit and bail
        const pos = this.tracker.getCurrentPosition() ?? 0;
        this.coveringService.updateCharacteristic(this.Characteristic.CurrentPosition, pos);
        this.coveringService.updateCharacteristic(this.Characteristic.TargetPosition, pos);
        this.coveringService.updateCharacteristic(
          this.Characteristic.PositionState,
          this.Characteristic.PositionState.STOPPED,
        );
        this.log.info('[%s] No movement needed (position=%d%%)', this.name, Math.round(pos));
        return;
      }

      await this.executePlan(plan, target);
    } catch (err) {
      await this.handleError(err);
    }
  }

  /**
   * Execute a movement plan: pulse motor, set timer, update HomeKit.
   */
  private async executePlan(plan: MovementPlan, target: number): Promise<void> {
    this.inFlight = true;
    this.inFlightCalibration = plan.isCalibration;

    const channel = plan.direction === 'up' ? this.upChannel : this.downChannel;
    const positionState = plan.direction === 'up'
      ? this.Characteristic.PositionState.INCREASING
      : this.Characteristic.PositionState.DECREASING;

    // Update HomeKit to show movement
    this.coveringService.updateCharacteristic(this.Characteristic.PositionState, positionState);
    this.coveringService.updateCharacteristic(this.Characteristic.TargetPosition, target);

    this.log.info(
      '[%s] %s → %d%% (CH%d, %dms%s)',
      this.name,
      plan.direction === 'up' ? 'Raising' : 'Lowering',
      target,
      channel,
      plan.durationMs,
      plan.isCalibration ? ', calibration' : '',
    );

    // Pulse the motor channel to start movement
    await this.pulseChannel(channel);

    // Set timer to finalize at the planned duration
    this.operationTimer = setTimeout(() => {
      this.onMovementComplete().catch((err: unknown) => {
        this.log.error('[%s] Movement completion error: %s', this.name, err instanceof Error ? err.message : String(err));
      });
    }, plan.durationMs);
  }

  /**
   * Called when the movement timer fires. Finalizes position.
   *
   * For regular (non-calibration) moves, sends a stop pulse to halt the
   * motor. For calibration moves, the motor has already been stopped by
   * the physical limit switch — sending another pulse would restart it.
   */
  private async onMovementComplete(): Promise<void> {
    this.operationTimer = undefined;
    const wasCalibration = this.inFlightCalibration;

    // Only send a stop pulse for non-calibration moves.
    // Calibration moves run until the physical limit switch stops the
    // motor. Pulsing again would toggle it back on.
    if (!wasCalibration) {
      const state = this.tracker.getState();
      if (state.phase === 'moving') {
        const channel = state.direction === 'up' ? this.upChannel : this.downChannel;
        this.log.info('[%s] Sending stop pulse (CH%d)', this.name, channel);
        try {
          await this.pulseChannel(channel);
        } catch (err) {
          this.log.warn('[%s] Failed to send stop pulse: %s', this.name, err instanceof Error ? err.message : String(err));
        }
      }
    } else {
      this.log.info('[%s] Calibration complete — no stop pulse (limit switch stopped motor)', this.name);
    }

    this.tracker.completeMovement();
    this.inFlight = false;
    this.inFlightCalibration = false;

    const finalPos = this.tracker.getCurrentPosition() ?? 0;

    this.coveringService.updateCharacteristic(this.Characteristic.CurrentPosition, finalPos);
    this.coveringService.updateCharacteristic(this.Characteristic.TargetPosition, finalPos);
    this.coveringService.updateCharacteristic(
      this.Characteristic.PositionState,
      this.Characteristic.PositionState.STOPPED,
    );

    this.log.info('[%s] Arrived at %d%%', this.name, Math.round(finalPos));
  }

  /**
   * Stop the motor mid-movement. Snapshots the interpolated position.
   *
   * Only sends a stop pulse for non-calibration moves. If we're
   * interrupting a calibration, the motor needs to be stopped (it hasn't
   * hit the limit yet), so we DO send a stop pulse in that case.
   */
  private async stopMotor(): Promise<void> {
    if (this.operationTimer) {
      clearTimeout(this.operationTimer);
      this.operationTimer = undefined;
    }

    const state = this.tracker.getState();
    if (state.phase === 'moving' || state.phase === 'calibrating') {
      const channel = state.direction === 'up' ? this.upChannel : this.downChannel;
      this.log.info('[%s] Interrupting %s — sending stop pulse (CH%d)', this.name, state.phase, channel);
      try {
        await this.pulseChannel(channel);
      } catch (err) {
        this.log.warn('[%s] Failed to send stop pulse: %s', this.name, err instanceof Error ? err.message : String(err));
      }
    }

    const pos = this.tracker.snapshotPosition();
    this.inFlight = false;
    this.inFlightCalibration = false;

    if (pos !== null) {
      this.coveringService.updateCharacteristic(this.Characteristic.CurrentPosition, pos);
    }
    this.coveringService.updateCharacteristic(
      this.Characteristic.PositionState,
      this.Characteristic.PositionState.STOPPED,
    );

    this.log.info('[%s] Stopped at %s', this.name, pos !== null ? `${Math.round(pos)}%` : 'unknown position');
  }

  /**
   * Handle errors during movement. Resets state and notifies HomeKit.
   */
  private async handleError(err: unknown): Promise<void> {
    if (this.operationTimer) {
      clearTimeout(this.operationTimer);
      this.operationTimer = undefined;
    }

    const pos = this.tracker.snapshotPosition() ?? this.tracker.getCurrentPosition() ?? 0;
    this.inFlight = false;
    this.inFlightCalibration = false;

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
    const switches = Array.from({ length: 4 }, (_, i) => ({
      switch: (i === channel ? 'on' : 'off') as 'on' | 'off',
      outlet: i,
    }));
    await this.platform.sendDeviceUpdate(this.accessory, { switches });
  }

  // -----------------------------------------------------------------------
  // External updates
  // -----------------------------------------------------------------------

  /**
   * Called when the device broadcasts state via mDNS.
   */
  public externalUpdate(params: DeviceParams): void {
    if (this.inFlight) {
      return;
    }

    if (params.switches) {
      // Future: monitor CH2/CH3 for limit-switch position feedback
      if (this.debug) {
        this.log.debug('[%s] externalUpdate: %s', this.name, JSON.stringify(params.switches));
      }
    }
  }

  public markStatus(isOnline: boolean): void {
    this.isOnline = isOnline;
  }

  public destroy(): void {
    if (this.operationTimer) {
      clearTimeout(this.operationTimer);
      this.operationTimer = undefined;
    }
    // Persist position on shutdown
    this.tracker.save();
  }
}
