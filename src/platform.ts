import type { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';
import { EWeLinkCloud } from './connection/ewelink-cloud.js';
import { EWeLinkLAN } from './connection/ewelink-lan.js';
import { LiftAccessory } from './lift-accessory.js';
import type { AccessoryContext, DihoolLiftConfig, DeviceConfig, DeviceUpdate } from './types.js';
import { DEFAULTS, DEFAULT_HTTP_HOST, DIHOOL_UIID, PLATFORM_NAME, PLUGIN_NAME } from './utils/constants.js';
import { parseError } from './utils/helpers.js';

interface DiscoveredDevice {
  deviceId: string;
  name: string;
  lanKey: string;
  uiid: number;
  model: string;
  firmware?: string;
}

export class DihoolLiftsPlatform implements DynamicPlatformPlugin {
  public readonly log: Logging;
  public readonly config: DihoolLiftConfig;
  public readonly api: API;

  private readonly accessories: Map<string, PlatformAccessory<AccessoryContext>>;
  private readonly liftHandlers: Map<string, LiftAccessory>;
  private lanClient?: EWeLinkLAN;

  constructor(log: Logging, config: PlatformConfig, api: API) {
    this.log = log;
    this.config = config as DihoolLiftConfig;
    this.api = api;

    this.accessories = new Map();
    this.liftHandlers = new Map();

    this.log.info('%s initialised', PLUGIN_NAME);

    this.api.on('didFinishLaunching', () => {
      this.discoverDevices().catch((err: unknown) => {
        this.log.error('Device discovery failed: %s', parseError(err));
      });
    });

    this.api.on('shutdown', () => {
      for (const handler of this.liftHandlers.values()) {
        handler.destroy();
      }
      this.lanClient?.closeConnection().catch(() => {});
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.accessories.set(accessory.UUID, accessory as PlatformAccessory<AccessoryContext>);
    this.log.info('Restored accessory from cache: %s', accessory.displayName);
  }

  async discoverDevices(): Promise<void> {
    // Step 1: Build device list from cloud and manual config
    const devices = await this.buildDeviceList();

    if (devices.length === 0) {
      this.log.warn('No devices found. Check your config or cloud credentials.');
      return;
    }

    // Step 2: Start LAN client
    await this.startLanClient(devices);

    // Step 3: Register accessories
    this.registerAccessories(devices);
  }

  private async buildDeviceList(): Promise<DiscoveredDevice[]> {
    const deviceMap = new Map<string, DiscoveredDevice>();

    // Cloud discovery
    if (this.config.username && this.config.password) {
      try {
        const cloud = new EWeLinkCloud(
          this.config.username,
          this.config.password,
          this.config.countryCode ?? DEFAULTS.countryCode,
          DEFAULT_HTTP_HOST,
          this.log,
          !!this.config.debug,
        );
        const cloudDevices = await cloud.discoverDevices();
        for (const d of cloudDevices) {
          if (d.uiid !== DIHOOL_UIID) {
            continue;
          }
          deviceMap.set(d.deviceid, {
            deviceId: d.deviceid,
            name: d.name,
            lanKey: d.devicekey,
            uiid: d.uiid,
            model: d.model || 'DIHOOL-IPS-S2',
            firmware: d.params.fwVersion as string | undefined,
          });
          this.log.info('Discovered via cloud: %s (%s)', d.name, d.deviceid);
        }
      } catch (err: unknown) {
        this.log.warn('Cloud discovery failed: %s', parseError(err));
      }
    }

    // Manual config devices (override cloud for same deviceId)
    if (this.config.devices) {
      for (const cfg of this.config.devices) {
        if (!cfg.deviceId || !cfg.lanKey) {
          continue;
        }
        deviceMap.set(cfg.deviceId, {
          deviceId: cfg.deviceId,
          name: cfg.label ?? cfg.deviceId,
          lanKey: cfg.lanKey,
          uiid: DIHOOL_UIID,
          model: 'DIHOOL-IPS-S2',
        });
        this.log.info('Configured manual device: %s', cfg.deviceId);
      }
    }

    return Array.from(deviceMap.values());
  }

  private async startLanClient(devices: DiscoveredDevice[]): Promise<void> {
    // Collect IP overrides from config
    const ipOverrides: Record<string, string> = {};
    if (this.config.devices) {
      for (const cfg of this.config.devices) {
        if (cfg.deviceId && cfg.ipAddress) {
          ipOverrides[cfg.deviceId] = cfg.ipAddress;
        }
      }
    }

    this.lanClient = new EWeLinkLAN(
      this.log,
      !!this.config.debug,
      this.config.mode ?? 'auto',
      ipOverrides,
    );

    await this.lanClient.getHosts();

    for (const device of devices) {
      this.lanClient.addDeviceToMap(device.deviceId, {
        deviceId: device.deviceId,
        uiid: device.uiid,
        model: device.model,
        lanKey: device.lanKey,
        channelCount: 4,
        firmware: device.firmware,
      } as AccessoryContext);
    }

    await this.lanClient.startMonitor();

    this.lanClient.receiveUpdate((update: DeviceUpdate) => this.receiveDeviceUpdate(update));
  }

  private registerAccessories(devices: DiscoveredDevice[]): void {
    const discoveredDeviceIds = new Set(devices.map((d) => d.deviceId));

    for (const device of devices) {
      const uuid = this.api.hap.uuid.generate(device.deviceId);
      const existingAccessory = this.accessories.get(uuid);

      if (existingAccessory) {
        this.log.info('Restoring existing accessory: %s (%s)', device.name, device.deviceId);

        existingAccessory.context = {
          deviceId: device.deviceId,
          uiid: device.uiid,
          model: device.model,
          lanKey: device.lanKey,
          channelCount: 4,
          firmware: device.firmware,
        };

        this.api.updatePlatformAccessories([existingAccessory]);

        const handler = new LiftAccessory(this, existingAccessory);
        this.liftHandlers.set(device.deviceId, handler);
      } else {
        this.log.info('Adding new accessory: %s (%s)', device.name, device.deviceId);

        const accessory = new this.api.platformAccessory<AccessoryContext>(device.name, uuid);
        accessory.context = {
          deviceId: device.deviceId,
          uiid: device.uiid,
          model: device.model,
          lanKey: device.lanKey,
          channelCount: 4,
          firmware: device.firmware,
        };

        accessory.category = this.api.hap.Categories.GARAGE_DOOR_OPENER;

        const handler = new LiftAccessory(this, accessory);
        this.liftHandlers.set(device.deviceId, handler);

        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.set(uuid, accessory);
      }
    }

    // Remove stale accessories not present in the discovered list
    const accessoriesToRemove: PlatformAccessory<AccessoryContext>[] = [];
    for (const accessory of this.accessories.values()) {
      const ctx = accessory.context;
      if (!discoveredDeviceIds.has(ctx.deviceId)) {
        this.log.info('Removing stale accessory: %s', ctx.deviceId);
        accessoriesToRemove.push(accessory);
      }
    }

    if (accessoriesToRemove.length > 0) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, accessoriesToRemove);
      for (const accessory of accessoriesToRemove) {
        this.accessories.delete(accessory.UUID);
      }
    }
  }

  receiveDeviceUpdate(update: DeviceUpdate): void {
    const handler = this.liftHandlers.get(update.deviceid);
    if (!handler) {
      return;
    }

    handler.externalUpdate(update.params);

    if (typeof update.params.online === 'boolean') {
      handler.markStatus(update.params.online);
    }
  }

  async sendDeviceUpdate(accessory: PlatformAccessory<AccessoryContext>, params: Record<string, unknown>): Promise<void> {
    const deviceId = accessory.context.deviceId;
    if (!this.lanClient) {
      throw new Error('LAN client not initialized');
    }
    const result = await this.lanClient.sendUpdate(deviceId, params);
    if (!result) {
      throw new Error(`Failed to send update to ${deviceId}`);
    }
  }

  getDeviceConfig(deviceId: string): DeviceConfig | undefined {
    return this.config.devices?.find((d) => d.deviceId === deviceId);
  }
}
