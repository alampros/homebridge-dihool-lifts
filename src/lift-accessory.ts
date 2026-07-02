import type { PlatformAccessory, Service, Characteristic, CharacteristicValue } from 'homebridge';
import type { DihoolLiftsPlatform } from './platform.js';
import type { DeviceParams, AccessoryContext } from './types.js';
import { DEFAULTS } from './utils/constants.js';

/**
 * Core device handler for a DIHOOL IPS-S2 scissor lift, exposed as a
 * HomeKit GarageDoorOpener.
 *
 * The IPS-S2 is a 4-channel eWeLink device (UIID 139) where:
 *   CH0 = UP motor   (500ms pulse mode)
 *   CH1 = DOWN motor (500ms pulse mode)
 *   CH2, CH3 = unused / always "on"
 *
 * Because the device does not report motor run-state (switches auto-revert
 * after the pulse), door position is estimated via operation timers.
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
  private readonly lanKey: string;
  private readonly upChannel: number;
  private readonly downChannel: number;
  private readonly operationTimeUp: number;
  private readonly operationTimeDown: number;
  private readonly name: string;

  private garageDoorService: Service;

  private isOnline = true;
  private inUse = false;
  private operationTimer: NodeJS.Timeout | undefined;
  private pendingOperation: Promise<void> = Promise.resolve();
  private readonly debug: boolean;

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

    // Read context from the accessory
    const context = accessory.context as {
      deviceId: string;
      lanKey: string;
      upChannel?: number;
      downChannel?: number;
    };

    this.deviceId = context.deviceId;
    this.lanKey = context.lanKey;
    this.name = accessory.displayName;

    // Read per-device overrides from platform config
    const deviceConfig = platform.getDeviceConfig(this.deviceId);
    this.upChannel = deviceConfig?.upChannel ?? DEFAULTS.upChannel;
    this.downChannel = deviceConfig?.downChannel ?? DEFAULTS.downChannel;
    this.operationTimeUp = deviceConfig?.operationTimeUp ?? DEFAULTS.operationTimeUp;
    this.operationTimeDown = deviceConfig?.operationTimeDown ?? DEFAULTS.operationTimeDown;
    this.debug = (platform.config as { debug?: boolean }).debug ?? false;

    // Remove stale Switch / ContactSensor services left over from earlier configs
    const staleServices = [
      this.Service.Switch,
      this.Service.ContactSensor,
    ];
    for (const serviceType of staleServices) {
      const existing = this.accessory.getService(serviceType);
      if (existing) {
        this.accessory.removeService(existing);
      }
    }

    // Add or get the GarageDoorOpener service
    this.garageDoorService =
      this.accessory.getService(this.Service.GarageDoorOpener) ??
      this.accessory.addService(this.Service.GarageDoorOpener);

    // Initialize characteristics if this is a brand-new service
    const currentDoorValue = this.garageDoorService.getCharacteristic(this.Characteristic.CurrentDoorState).value;
    if (currentDoorValue === undefined || currentDoorValue === null) {
      this.garageDoorService.setCharacteristic(this.Characteristic.CurrentDoorState, this.Characteristic.CurrentDoorState.CLOSED);
      this.garageDoorService.setCharacteristic(this.Characteristic.TargetDoorState, this.Characteristic.TargetDoorState.CLOSED);
      this.garageDoorService.setCharacteristic(this.Characteristic.ObstructionDetected, false);
    }

    // AccessoryInformation
    const infoService =
      this.accessory.getService(this.Service.AccessoryInformation) ??
      this.accessory.addService(this.Service.AccessoryInformation);
    infoService
      .setCharacteristic(this.Characteristic.Manufacturer, 'DIHOOL')
      .setCharacteristic(this.Characteristic.Model, 'IPS-S2');

    // Register handlers
    this.garageDoorService
      .getCharacteristic(this.Characteristic.TargetDoorState)
      .onSet(this.handleTargetStateSet.bind(this));

    this.garageDoorService
      .getCharacteristic(this.Characteristic.CurrentDoorState)
      .onGet(() => {
        if (!this.isOnline) {
          throw new this.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
        return this.garageDoorService.getCharacteristic(this.Characteristic.CurrentDoorState).value as CharacteristicValue;
      });
  }

  private async handleTargetStateSet(value: CharacteristicValue): Promise<void> {
    this.pendingOperation = this.pendingOperation.then(
      () => this._handleTargetStateSet(value),
      () => this._handleTargetStateSet(value), // also handle rejected
    );
    return this.pendingOperation;
  }

  /**
   * Called when the user taps Open / Close / Stop in the Home app.
   */
  private async _handleTargetStateSet(value: CharacteristicValue): Promise<void> {
    const newTarget = value as number; // 0 = Open, 1 = Closed
    const currentState = this.getCurrentDoorState();
    try {

      // If currently transitioning (Opening=2 or Closing=3), this is a STOP request
      if (currentState === this.Characteristic.CurrentDoorState.OPENING ||
          currentState === this.Characteristic.CurrentDoorState.CLOSING) {
        const activeChannel = currentState === this.Characteristic.CurrentDoorState.OPENING
          ? this.upChannel
          : this.downChannel;
        await this.pulseChannel(activeChannel);
        clearTimeout(this.operationTimer);
        this.operationTimer = undefined;
        this.updateCurrentState(this.Characteristic.CurrentDoorState.STOPPED);
        this.inUse = false;
        return;
      }

      // If already at target position, do nothing
      if (newTarget === currentState % 2) {
        return;
      }

      this.inUse = true;

      // Determine direction and pulse the appropriate channel
      const channel = newTarget === this.Characteristic.TargetDoorState.OPEN
        ? this.upChannel
        : this.downChannel;
      const operationTime = newTarget === this.Characteristic.TargetDoorState.OPEN
        ? this.operationTimeUp
        : this.operationTimeDown;

      // Update HomeKit to show transitioning state
      this.updateTargetState(newTarget);
      this.updateCurrentState(newTarget + 2); // 2 = Opening, 3 = Closing

      // Send pulse command to device
      await this.pulseChannel(channel);

      // Start timer to mark completion
      this.operationTimer = setTimeout(() => {
        this.updateCurrentState(newTarget); // 0 = Open, 1 = Closed
        this.inUse = false;
        this.log.info('[%s] %s.', this.name, newTarget === this.Characteristic.TargetDoorState.OPEN ? 'Opened' : 'Closed');
      }, operationTime * 1000);
    } catch (err) {
      clearTimeout(this.operationTimer);
      this.operationTimer = undefined;
      this.updateCurrentState(currentState);
      this.inUse = false;
      this.platform.log.error('[%s] Error setting target state: %s', this.name, err instanceof Error ? err.message : String(err));
      // Revert TargetDoorState so HomeKit stays in sync
      this.garageDoorService.updateCharacteristic(
        this.Characteristic.TargetDoorState,
        this.getCurrentDoorState() % 2,
      );
      throw new this.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

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

  /**
   * Called when the device broadcasts state via mDNS.
   * Skips processing while we are actively managing a transition.
   */
  public externalUpdate(params: DeviceParams): void {
    if (this.inUse) {
      return;
    }

    if (params.switches) {
      // Future: monitor CH2/CH3 for limit-switch position feedback
      if (this.debug) {
        this.log.debug('[%s] externalUpdate (ignored while idle): %s', this.name, JSON.stringify(params.switches));
      }
    }
  }

  /**
   * Update the online/offline status of the accessory.
   */
  public markStatus(isOnline: boolean): void {
    this.isOnline = isOnline;
  }

  /**
   * Clean up any pending timers.
   */
  public destroy(): void {
    if (this.operationTimer) {
      clearTimeout(this.operationTimer);
      this.operationTimer = undefined;
    }
  }

  /* ------------------------------------------------------------------
   * Helper methods
   * ---------------------------------------------------------------- */

  private getCurrentDoorState(): number {
    return this.garageDoorService.getCharacteristic(this.Characteristic.CurrentDoorState).value as number;
  }

  private updateCurrentState(state: number): void {
    this.garageDoorService.updateCharacteristic(this.Characteristic.CurrentDoorState, state);
  }

  private updateTargetState(state: number): void {
    this.garageDoorService.updateCharacteristic(this.Characteristic.TargetDoorState, state);
  }
}
