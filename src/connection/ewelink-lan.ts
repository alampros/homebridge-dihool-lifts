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

    // Create a temporary mDNS instance for discovery
    const mdns = multicastDns();

    await new Promise<void>((resolve) => {
      setTimeout(() => {
        mdns.removeAllListeners('response');
        mdns.destroy();
        resolve();
      }, 5000);

      mdns.on('response', (response) => {
        this.processDiscoveryResponse(response);
      });

      // Query for eWeLink PTR records
      mdns.query([{ name: MDNS_PTR_NAME, type: 'PTR' }]);
    });

    return this.deviceMap;
  }

  /**
   * Parse a discovery response to extract device IDs and IPs.
   */
  private processDiscoveryResponse(response: multicastDns.ResponsePacket): void {
    const allRecords = [
      ...(response.answers ?? []),
      ...(response.additionals ?? []),
    ];

    // Collect SRV/A records to map hostnames to IPs
    const hostToIp = new Map<string, string>();
    for (const record of allRecords) {
      if (record.type === 'A') {
        hostToIp.set(record.name, record.data as string);
      }
    }

    // Look for PTR records pointing to eWeLink devices
    for (const record of allRecords) {
      if (record.type === 'PTR' && record.name.includes('_ewelink')) {
        const ptr = record.data as string;
        const deviceId = ptr
          .replace(/\._ewelink\._tcp\.local\.?$/, '')
          .replace(/^eWeLink_/, '');

        if (!deviceId) continue;

        // Try to find the IP from SRV → A record chain
        const srvRecord = allRecords.find(
          (r) => r.type === 'SRV' && r.name === ptr,
        );
        let ip: string | undefined;
        if (srvRecord && srvRecord.type === 'SRV') {
          const srvData = srvRecord.data as { target: string };
          ip = hostToIp.get(srvData.target);
        }

        // Fallback: check A records for the device hostname
        if (!ip) {
          const deviceHost = `eWeLink_${deviceId}.local`;
          ip = hostToIp.get(deviceHost);
        }

        if (ip && !this.deviceMap.has(deviceId)) {
          this.deviceMap.set(deviceId, { ip, ipOverride: false });
          if (this.debug) {
            this.log.debug('[LAN] Discovered %s at %s', deviceId, ip);
          }
        } else if (ip) {
          const info = this.deviceMap.get(deviceId)!;
          if (!info.ipOverride) {
            info.ip = ip;
          }
        }
      }

      // Also extract device IDs from TXT records (which include the id field)
      if (record.type === 'TXT' && record.name.includes('_ewelink')) {
        const txt = this.parseTxtData(record.data);
        if (txt?.id) {
          // We may not have the IP from this record alone, but we know the device exists
          if (!this.deviceMap.has(txt.id)) {
            this.deviceMap.set(txt.id, { ipOverride: false });
          }
        }
      }
    }
  }

  /**
   * Start listening for mDNS state broadcasts from eWeLink devices.
   *
   * Creates a persistent mDNS listener that decrypts TXT record
   * payloads and emits 'update' events on state changes.
   */
  async startMonitor(): Promise<void> {
    this.mdns = multicastDns();

    this.mdns.on('response', (response) => {
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

        // Update IP if it changed
        // response object doesn't directly carry the sender IP in multicast-dns,
        // but SRV/A records in additionals might

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

    this.log.info('LAN monitoring started.');
  }

  /**
   * Send an encrypted command to a device over the LAN.
   * Retries up to 10 times on ECONNRESET.
   */
  async sendUpdate(deviceId: string, params: DeviceParams): Promise<boolean> {
    const info = this.deviceMap.get(deviceId);
    if (!info?.ip || !info?.lanKey) {
      this.log.warn('[LAN] Cannot send to %s: ip=%s lanKey=%s', deviceId, info?.ip ?? 'none', info?.lanKey ? 'set' : 'none');
      return false;
    }

    const { encryptedData, iv } = this.encryptData(params, info.lanKey);
    const url = `http://${info.ip}:${EWELINK_LAN_PORT}/zeroconf/switches`;

    if (this.debug) {
      this.log.debug('[LAN] Sending to %s → %s', deviceId, url);
    }
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
