import type { API, Logging, PlatformConfig } from 'homebridge';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DihoolLiftsPlatform } from './platform.js';

const cloudDevices = vi.hoisted(() => ({
  value: [] as Array<Record<string, unknown>>,
}));

vi.mock('./connection/ewelink-cloud.js', () => ({
  EWeLinkCloud: class {
    async discoverDevices(): Promise<Array<Record<string, unknown>>> {
      return cloudDevices.value;
    }
  },
}));

interface ResolvedDevice {
  deviceId: string;
  name: string;
  lanKey: string;
  model: string;
  firmware?: string;
}

function createPlatform(config: PlatformConfig): DihoolLiftsPlatform {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logging;
  const api = {
    on: vi.fn(),
  } as unknown as API;

  return new DihoolLiftsPlatform(log, config, api);
}

async function buildDeviceList(platform: DihoolLiftsPlatform): Promise<ResolvedDevice[]> {
  return (platform as unknown as {
    buildDeviceList(): Promise<ResolvedDevice[]>;
  }).buildDeviceList();
}

describe('device configuration precedence', () => {
  beforeEach(() => {
    cloudDevices.value = [{
      deviceid: 'device-1',
      name: 'eWeLink Name',
      devicekey: 'cloud-key',
      uiid: 139,
      model: 'cloud-model',
      params: { fwVersion: '1.2.3' },
    }];
  });

  it('uses the configured label for a cloud-discovered device', async () => {
    const platform = createPlatform({
      platform: 'DihoolLifts',
      username: 'user@example.com',
      password: 'secret',
      devices: [{ deviceId: 'device-1', label: 'Configured Lift' }],
    });

    await expect(buildDeviceList(platform)).resolves.toEqual([{
      deviceId: 'device-1',
      name: 'Configured Lift',
      lanKey: 'cloud-key',
      uiid: 139,
      model: 'cloud-model',
      firmware: '1.2.3',
    }]);
  });

  it('retains the cloud name when no configured label is present', async () => {
    const platform = createPlatform({
      platform: 'DihoolLifts',
      username: 'user@example.com',
      password: 'secret',
      devices: [{ deviceId: 'device-1', ipAddress: '192.168.1.10' }],
    });

    const [device] = await buildDeviceList(platform);

    expect(device.name).toBe('eWeLink Name');
    expect(device.lanKey).toBe('cloud-key');
  });
});
