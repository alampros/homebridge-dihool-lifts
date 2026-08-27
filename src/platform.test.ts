import type { API, Logging, PlatformConfig } from 'homebridge';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DihoolLiftsPlatform, parseLiftSenseCallbackBaseUrl } from './platform.js';

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

describe('LiftSense callback base URL', () => {
  it('builds the callback URL and listener port from one setting', () => {
    expect(parseLiftSenseCallbackBaseUrl('http://10.0.0.10:8582/')).toEqual({
      callbackUrl: 'http://10.0.0.10:8582/v1/liftsense/motor',
      listenPort: 8582,
    });
  });

  it('uses port 80 when the HTTP URL omits a port', () => {
    expect(parseLiftSenseCallbackBaseUrl('http://homebridge.local')).toEqual({
      callbackUrl: 'http://homebridge.local/v1/liftsense/motor',
      listenPort: 80,
    });
  });

  it('disables callbacks and keeps the dormant default port for invalid values', () => {
    expect(parseLiftSenseCallbackBaseUrl(undefined)).toEqual({ listenPort: 8582 });
    expect(parseLiftSenseCallbackBaseUrl('not-a-url')).toEqual({ listenPort: 8582 });
    expect(parseLiftSenseCallbackBaseUrl('https://10.0.0.10:8582/')).toEqual({ listenPort: 8582 });
  });
});

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
