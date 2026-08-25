import { request } from 'node:http';
import { isIP } from 'node:net';
import multicastDns from 'multicast-dns';

export interface LiftSenseStatus {
  distanceMm: number;
  sensorTimeout: boolean;
}

export class LiftSenseEsp32 {
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly host: string,
    private readonly token: string,
    private readonly pollIntervalMs: number,
    private readonly onStatus: (status: LiftSenseStatus | undefined, error?: Error) => void,
  ) {}

  start(): void {
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async poll(): Promise<void> {
    try {
      this.onStatus(await this.getStatus());
    } catch (error) {
      this.onStatus(undefined, error instanceof Error ? error : new Error(String(error)));
    }
  }

  private getStatus(): Promise<LiftSenseStatus> {
    return this.resolveHost().then((host) => this.requestStatus(host));
  }

  private resolveHost(): Promise<string> {
    if (isIP(this.host) !== 0 || !this.host.endsWith('.local')) {
      return Promise.resolve(this.host);
    }

    return new Promise((resolve, reject) => {
      const mdns = multicastDns();
      let finished = false;
      const hostname = this.host.toLowerCase();

      const finish = (error?: Error, address?: string) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        mdns.removeAllListeners();
        mdns.destroy();
        if (error) reject(error);
        else resolve(address!);
      };

      const timeout = setTimeout(
        () => finish(new Error(`mDNS could not resolve ${this.host}`)),
        3000,
      );

      mdns.on('error', (error: Error) => finish(error));
      mdns.on('response', (response: multicastDns.ResponsePacket) => {
        const records = [...(response.answers ?? []), ...(response.additionals ?? [])];
        for (const record of records) {
          if (
            record.type === 'A' &&
            record.name.toLowerCase() === hostname &&
            'data' in record &&
            typeof record.data === 'string'
          ) {
            finish(undefined, record.data);
            return;
          }
        }
      });
      mdns.query([{ name: this.host, type: 'A' }]);
    });
  }

  private requestStatus(host: string): Promise<LiftSenseStatus> {
    return new Promise((resolve, reject) => {
      const req = request({
        host,
        port: 80,
        path: '/v1/status',
        method: 'GET',
        headers: { Authorization: `Bearer ${this.token}` },
        timeout: 5000,
      }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => { body += chunk; });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`ESP32 returned HTTP ${res.statusCode ?? 'unknown'}`));
            return;
          }
          try {
            const data = JSON.parse(body) as { distance_mm?: unknown; sensor_timeout?: unknown };
            if (typeof data.distance_mm !== 'number' || typeof data.sensor_timeout !== 'boolean') {
              throw new Error('ESP32 returned an invalid status response');
            }
            resolve({ distanceMm: data.distance_mm, sensorTimeout: data.sensor_timeout });
          } catch (error) {
            reject(error);
          }
        });
      });
      req.on('timeout', () => req.destroy(new Error('ESP32 request timed out')));
      req.on('error', reject);
      req.end();
    });
  }
}
