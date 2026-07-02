import { EventEmitter } from 'node:events';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import type { Logger } from 'homebridge';
import multicastDns from 'multicast-dns';
import type { DeviceUpdate, LanDeviceInfo, DeviceParams, AccessoryContext } from '../types.js';
import { EWELINK_LAN_PORT, PARAMS_TO_KEEP } from '../utils/constants.js';
import { sleep } from '../utils/helpers.js';

const MDNS_PTR_NAME = '_ewelink._tcp.local';

/**
 * Handles LAN communication with eWeLink devices via mDNS discovery
 * and AES-128-CBC encrypted HTTP commands.
 */
export class EWeLinkLAN {
  private readonly log: Logger;
  private readonly debug: boolean;
  private readonly mode: string;
  private readonly ipOverrides: Record<string, string>;
  private readonly deviceMap: Map<string, LanDeviceInfo>;
  private readonly emitter: EventEmitter;
  private mdns?: ReturnType<typeof multicastDns>;

  constructor(
    log: Logger,
    debug: boolean,
    mode: string,
    ipOverrides: Record<string, string>,
  ) {
    this.log = log;
    this.debug = debug;
    this.mode = mode;
    this.ipOverrides = ipOverrides;
    this.deviceMap = new Map();
    this.emitter = new EventEmitter();
  }

  /**
   * Discover devices on the local network via mDNS.
   *
   * Seeds the device map with manual IP overrides, then sends a PTR
   * query for `_ewelink._tcp.local` and collects responses for 5 seconds.
   */
  async getHosts(): Promise<Map<string, LanDeviceInfo>> {
    // Seed with manual IP overrides
    for (const [deviceId, ip] of Object.entries(this.ipOverrides)) {
      const existing = this.deviceMap.get(deviceId);
      if (!existing) {
        this.deviceMap.set(deviceId, { ip, ipOverride: true });
      } else if (!existing.ipOverride) {
        existing.ip = ip;
        existing.ipOverride = true;
      }
    }

    // Create a temporary mDNS instance for initial discovery
    let mdns: ReturnType<typeof multicastDns>;
    try {
      mdns = multicastDns();
    } catch (err) {
      this.log.warn(
        '[LAN] Failed to create mDNS socket for discovery: %s',
        err instanceof Error ? err.message : String(err),
      );
      return this.deviceMap;
    }

    await new Promise<void>((resolve) => {
      const cleanup = () => {
        mdns.removeAllListeners('response');
        mdns.removeAllListeners('error');
        mdns.destroy();
        resolve();
      };

      const timer = setTimeout(cleanup, 5000);

      mdns.on('error', (err: Error) => {
        this.log.warn('[LAN] mDNS discovery error: %s', err.message);
        clearTimeout(timer);
        cleanup();
      });

      mdns.on('response', (response) => {
        this.processResponseRecords(response);
      });

      // Query for eWeLink PTR records
      mdns.query([{ name: MDNS_PTR_NAME, type: 'PTR' }]);
    });

    // Log what we found
    const discovered = [...this.deviceMap.entries()]
      .filter(([, info]) => info.ip)
      .map(([id, info]) => `${id}@${info.ip}${info.ipOverride ? ' (manual)' : ''}`);
    if (discovered.length > 0) {
      this.log.info('[LAN] Discovered devices: %s', discovered.join(', '));
    } else {
      this.log.warn('[LAN] No device IPs discovered via mDNS. Devices with manual IP overrides may still work.');
    }

    return this.deviceMap;
  }

  /**
   * Process all record types from an mDNS response to extract device IPs
   * and update the device map. Used by both initial discovery and the
   * ongoing monitor.
   */
  private processResponseRecords(response: multicastDns.ResponsePacket): void {
    const allRecords = [
      ...(response.answers ?? []),
      ...(response.additionals ?? []),
    ];

    // Collect A records: hostname → IP
    const hostToIp = new Map<string, string>();
    for (const record of allRecords) {
      if (record.type === 'A') {
        hostToIp.set(record.name, record.data as string);
      }
    }

    // Collect SRV records: service name → target hostname
    const srvTargets = new Map<string, string>();
    for (const record of allRecords) {
      if (record.type === 'SRV') {
        const srvData = record.data as { target: string };
        srvTargets.set(record.name, srvData.target);
      }
    }

    // Process PTR records to find eWeLink devices
    for (const record of allRecords) {
      if (record.type === 'PTR' && record.name.includes('_ewelink')) {
        const ptr = record.data as string;
        const deviceId = ptr
          .replace(/\._ewelink\._tcp\.local\.?$/, '')
          .replace(/^eWeLink_/, '');

        if (!deviceId) continue;

        // Resolve IP: PTR → SRV target → A record
        let ip: string | undefined;
        const srvTarget = srvTargets.get(ptr);
        if (srvTarget) {
          ip = hostToIp.get(srvTarget);
        }
        // Fallback: check A records for the device hostname directly
        if (!ip) {
          ip = hostToIp.get(`eWeLink_${deviceId}.local`);
        }

        if (ip) {
          this.updateDeviceIp(deviceId, ip);
        }
      }
    }

    // Also try to extract IPs from A records matching the eWeLink_<id>.local pattern
    for (const [hostname, ip] of hostToIp) {
      const match = hostname.match(/^eWeLink_(\w+)\.local$/);
      if (match?.[1]) {
        this.updateDeviceIp(match[1], ip);
      }
    }
  }

  /**
   * Update a device's IP in the map (unless manually overridden).
   */
  private updateDeviceIp(deviceId: string, ip: string): void {
    const existing = this.deviceMap.get(deviceId);
    if (!existing) {
      this.deviceMap.set(deviceId, { ip, ipOverride: false });
      this.log.info('[LAN] Discovered %s at %s', deviceId, ip);
    } else if (!existing.ipOverride && existing.ip !== ip) {
      const oldIp = existing.ip;
      existing.ip = ip;
      this.log.info('[LAN] Updated %s: %s → %s', deviceId, oldIp ?? 'none', ip);
    } else if (!existing.ipOverride && !existing.ip) {
      existing.ip = ip;
      this.log.info('[LAN] Resolved %s at %s', deviceId, ip);
    }
  }

  /**
   * Start listening for mDNS state broadcasts from eWeLink devices.
   *
   * Creates a persistent mDNS listener that:
   * 1. Extracts device IPs from A/SRV records (keeping IPs fresh)
   * 2. Decrypts TXT record payloads and emits state change events
   */
  async startMonitor(): Promise<void> {
    try {
      this.mdns = multicastDns();
    } catch (err) {
      this.log.error(
        '[LAN] Failed to create mDNS socket for monitoring: %s. LAN control will not work.',
        err instanceof Error ? err.message : String(err),
      );
      return;
    }

    this.mdns.on('error', (err: Error) => {
      this.log.warn('[LAN] mDNS monitor error: %s', err.message);
    });

    this.mdns.on('response', (response) => {
      // Always process A/SRV/PTR records to keep IPs current
      this.processResponseRecords(response);

      // Process TXT records for state updates
      const allRecords = [
        ...(response.answers ?? []),
        ...(response.additionals ?? []),
      ];

      for (const record of allRecords) {
        if (record.type !== 'TXT') continue;
        if (!record.name.includes('_ewelink')) continue;

        const txt = this.parseTxtData(record.data);
        if (!txt?.id || !txt?.iv) continue;

        const deviceId = txt.id;
        const info = this.deviceMap.get(deviceId);
        if (!info?.lanKey) continue;

        // Deduplicate by IV
        if (txt.iv === info.lastIV) continue;
        info.lastIV = txt.iv;

        // Concatenate encrypted data fragments
        const data = [txt.data1, txt.data2, txt.data3, txt.data4]
          .filter(Boolean)
          .join('');

        if (!data) continue;

        let decrypted: DeviceParams;
        try {
          decrypted = this.decryptData(data, txt.iv, info.lanKey);
        } catch (err) {
          if (this.debug) {
            this.log.debug(
              '[LAN] Decryption failed for %s: %s',
              deviceId,
              err instanceof Error ? err.message : String(err),
            );
          }
          continue;
        }

        // Filter to only params we care about
        const params: DeviceParams = {};
        for (const key of PARAMS_TO_KEEP) {
          if (key in decrypted) {
            (params as Record<string, unknown>)[key] =
              (decrypted as Record<string, unknown>)[key];
          }
        }

        if (Object.keys(params).length === 0) continue;

        params.online = true;
        params.updateSource = 'LAN';

        if (this.debug) {
          this.log.debug('[LAN] Update from %s: %s', deviceId, JSON.stringify(params));
        }

        this.emitter.emit('update', { deviceid: deviceId, params } as DeviceUpdate);
      }
    });

    this.log.info('[LAN] Monitoring started.');
  }

  /**
   * Send an encrypted command to a device over the LAN.
   *
   * If the device IP is unknown, fires a one-shot mDNS query and waits
   * up to 3 seconds for discovery before giving up. Retries up to 10
   * times on ECONNRESET.
   */
  async sendUpdate(deviceId: string, params: DeviceParams): Promise<boolean> {
    const info = this.deviceMap.get(deviceId);
    if (!info?.lanKey) {
      this.log.warn('[LAN] Cannot send to %s: no lanKey', deviceId);
      return false;
    }

    // If we don't have an IP, try a quick mDNS re-query
    if (!info.ip) {
      this.log.info('[LAN] No IP for %s — sending mDNS query...', deviceId);
      await this.reQueryDevice(deviceId);
    }

    if (!info.ip) {
      this.log.warn('[LAN] Cannot send to %s: ip not discovered', deviceId);
      return false;
    }

    const { encryptedData, iv } = this.encryptData(params, info.lanKey);
    const url = `http://${info.ip}:${EWELINK_LAN_PORT}/zeroconf/switches`;

    this.log.info('[LAN] Sending to %s → %s', deviceId, url);

    const body = JSON.stringify({
      deviceid: deviceId,
      data: encryptedData,
      encrypt: true,
      iv,
      selfApikey: '123',
      sequence: String(Date.now()),
    });

    const timeoutMs = this.mode === 'lan' ? 9000 : 3000;
    const maxRetries = 10;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const json = await this.httpPost(info.ip, '/zeroconf/switches', body, timeoutMs);
        if (json.error === 0) {
          return true;
        }
        this.log.warn('[LAN] Device %s error: %s', deviceId, JSON.stringify(json));
        return false;
      } catch (err) {
        const code = err instanceof Error && 'code' in err
          ? (err as NodeJS.ErrnoException).code
          : undefined;

        if (code === 'ECONNRESET' && attempt < maxRetries) {
          if (this.debug) {
            this.log.debug('[LAN] ECONNRESET for %s, retry %d/%d', deviceId, attempt + 1, maxRetries);
          }
          await sleep(100);
          continue;
        }

        this.log.warn(
          '[LAN] Failed to send to %s at %s: %s',
          deviceId, url,
          err instanceof Error ? err.message : String(err),
        );
        return false;
      }
    }

    return false;
  }

  /** Register a callback for device state updates. */
  receiveUpdate(callback: (update: DeviceUpdate) => void): void {
    this.emitter.on('update', callback);
  }

  /** Add or update device metadata in the LAN map. */
  addDeviceToMap(deviceId: string, context: AccessoryContext): void {
    const info = this.deviceMap.get(deviceId) ?? { ipOverride: false };
    info.lanKey = context.lanKey;
    info.uiid = context.uiid;
    info.productModel = context.model;
    this.deviceMap.set(deviceId, info);
  }

  /** Stop mDNS monitoring and clean up. */
  async closeConnection(): Promise<void> {
    if (this.mdns) {
      this.mdns.destroy();
      this.mdns = undefined;
    }
    this.emitter.removeAllListeners();
  }

  // -- Private helpers --------------------------------------------------

  /**
   * Fire a one-shot mDNS query to try to resolve a device's IP.
   * Waits up to 3 seconds for a response.
   */
  private async reQueryDevice(deviceId: string): Promise<void> {
    const mdns = this.mdns;
    if (!mdns) return;

    return new Promise<void>((resolve) => {
      let resolved = false;
      let timer: NodeJS.Timeout;

      const cleanup = () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        mdns.removeListener('response', onResponse);
        resolve();
      };

      const onResponse = (response: multicastDns.ResponsePacket) => {
        this.processResponseRecords(response);
        const info = this.deviceMap.get(deviceId);
        if (info?.ip) {
          cleanup();
        }
      };

      timer = setTimeout(cleanup, 3000);
      mdns.on('response', onResponse);
      mdns.query([{ name: MDNS_PTR_NAME, type: 'PTR' }]);
    });
  }

  /**
   * Send an HTTP POST using node:http.
   *
   * We use node:http instead of fetch because the eWeLink device's
   * embedded web server (openresty on an ESP chip) doesn't handle
   * undici's HTTP/1.1 connection management correctly, causing
   * "socket hang up" errors. Raw node:http with Connection: close works.
   */
  private httpPost(ip: string, path: string, body: string, timeoutMs: number): Promise<{ error?: number }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: ip,
          port: EWELINK_LAN_PORT,
          path,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            'Connection': 'close',
          },
        },
        (res: IncomingMessage) => {
          let data = '';
          res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
          res.on('end', () => {
            try {
              resolve(JSON.parse(data) as { error?: number });
            } catch {
              reject(new Error(`Invalid JSON response: ${data}`));
            }
          });
        },
      );
      req.on('error', reject);
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
      });
      req.end(body);
    });
  }

  /**
   * Parse TXT record data from multicast-dns.
   * TXT data comes as Buffer[] of "key=value" entries.
   */
  private parseTxtData(
    data: unknown,
  ): Record<string, string> | undefined {
    if (!Array.isArray(data)) return undefined;

    const result: Record<string, string> = {};
    for (const entry of data) {
      const str = Buffer.isBuffer(entry) ? entry.toString('utf8') : String(entry);
      const eqIdx = str.indexOf('=');
      if (eqIdx > 0) {
        result[str.substring(0, eqIdx)] = str.substring(eqIdx + 1);
      }
    }
    return Object.keys(result).length > 0 ? result : undefined;
  }

  /**
   * Encrypt params for sending to a device.
   * Key = MD5(lanKey), algorithm = AES-128-CBC, per eWeLink LAN spec.
   */
  private encryptData(
    params: DeviceParams,
    lanKey: string,
  ): { encryptedData: string; iv: string } {
    const key = createHash('md5').update(Buffer.from(lanKey, 'utf8')).digest();
    const iv = randomBytes(16);
    const cipher = createCipheriv('aes-128-cbc', key, iv);
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(params)),
      cipher.final(),
    ]);
    return {
      encryptedData: encrypted.toString('base64'),
      iv: iv.toString('base64'),
    };
  }

  /**
   * Decrypt data received from a device.
   * Key = MD5(lanKey), algorithm = AES-128-CBC, per eWeLink LAN spec.
   */
  private decryptData(data: string, ivBase64: string, lanKey: string): DeviceParams {
    const key = createHash('md5').update(Buffer.from(lanKey, 'utf8')).digest();
    const decipher = createDecipheriv(
      'aes-128-cbc',
      key,
      Buffer.from(ivBase64, 'base64'),
    );
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(data, 'base64')),
      decipher.final(),
    ]).toString('utf8');

    // Clean up potential garbage bytes (seen in some eWeLink devices)
    // eslint-disable-next-line no-control-regex
    const cleaned = decrypted.replace(/[\x00-\x1F]+$/g, '');
    return JSON.parse(cleaned) as DeviceParams;
  }
}
