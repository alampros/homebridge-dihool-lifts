import { request } from 'node:http';
import { isIP } from 'node:net';
import multicastDns from 'multicast-dns';

export const ACTIVE_POLL_INTERVAL_MS = 100;
export const POST_STOP_ACTIVE_MS = 2000;

export interface LiftSenseStatus {
  /** Filtered distance used for position calculations. */
  distanceMm: number;
  /** Latest unfiltered sample, when provided by newer firmware. */
  rawDistanceMm?: number;
  sensorTimeout: boolean;
  /** Raw, isolated motor-output detector states from the LiftSense firmware. */
  motorChannel1Active?: boolean;
  motorChannel2Active?: boolean;
}

export type LiftSenseMotorDirection = 'up' | 'down' | 'stopped' | 'invalid' | 'unknown';

interface LiftSenseStatusResponse {
  distance_mm?: unknown;
  raw_distance_mm?: unknown;
  filtered_distance_mm?: unknown;
  filter_ready?: unknown;
  sensor_timeout?: unknown;
  motor_channel_1_active?: unknown;
  motor_channel_2_active?: unknown;
}

export function parseLiftSenseStatus(body: string): LiftSenseStatus {
  const data = JSON.parse(body) as LiftSenseStatusResponse;
  const distanceMm = typeof data.filtered_distance_mm === 'number'
    ? data.filtered_distance_mm
    : data.distance_mm;

  if (
    typeof distanceMm !== 'number' ||
    typeof data.sensor_timeout !== 'boolean' ||
    (data.filter_ready !== undefined && typeof data.filter_ready !== 'boolean') ||
    (data.raw_distance_mm !== undefined && typeof data.raw_distance_mm !== 'number') ||
    (data.motor_channel_1_active !== undefined && typeof data.motor_channel_1_active !== 'boolean') ||
    (data.motor_channel_2_active !== undefined && typeof data.motor_channel_2_active !== 'boolean') ||
    ((data.motor_channel_1_active === undefined) !== (data.motor_channel_2_active === undefined))
  ) {
    throw new Error('ESP32 returned an invalid status response');
  }

  return {
    distanceMm,
    rawDistanceMm: typeof data.raw_distance_mm === 'number' ? data.raw_distance_mm : undefined,
    sensorTimeout: data.sensor_timeout || data.filter_ready === false,
    motorChannel1Active: typeof data.motor_channel_1_active === 'boolean'
      ? data.motor_channel_1_active
      : undefined,
    motorChannel2Active: typeof data.motor_channel_2_active === 'boolean'
      ? data.motor_channel_2_active
      : undefined,
  };
}

/**
 * Translate the firmware's raw detector channels into a presentation-only
 * direction. This never affects which DIHOOL relay channel receives commands.
 */
export function motorDirectionFromStatus(
  status: LiftSenseStatus,
  invertMotorChannelDirections = false,
): LiftSenseMotorDirection {
  const channel1 = status.motorChannel1Active;
  const channel2 = status.motorChannel2Active;

  if (channel1 === undefined || channel2 === undefined) return 'unknown';
  if (channel1 && channel2) return 'invalid';
  if (!channel1 && !channel2) return 'stopped';

  const channel1Direction = invertMotorChannelDirections ? 'down' : 'up';
  if (channel1) return channel1Direction;
  return channel1Direction === 'up' ? 'down' : 'up';
}

export function liftSensePollDelay(
  idlePollIntervalMs: number,
  motorActive: boolean,
  postStopUntilMs: number,
  nowMs: number,
): number {
  return motorActive || nowMs < postStopUntilMs
    ? ACTIVE_POLL_INTERVAL_MS
    : idlePollIntervalMs;
}

export function liftSenseStatusPath(callbackUrl?: string): string {
  return callbackUrl
    ? `/v1/status?callback_url=${encodeURIComponent(callbackUrl)}`
    : '/v1/status';
}

export class LiftSenseEsp32 {
  private timer?: NodeJS.Timeout;
  private running = false;
  private pollInProgress = false;
  private resolvedHost?: string;
  private motorActive = false;
  private postStopUntilMs = 0;

  constructor(
    private readonly host: string,
    private readonly token: string,
    private readonly pollIntervalMs: number,
    private readonly onStatus: (status: LiftSenseStatus | undefined, error?: Error) => void,
    private readonly callbackUrl?: string,
  ) {}

  start(): void {
    this.stop();
    this.running = true;
    void this.poll();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  notifyMotorState(channel1Active: boolean, channel2Active: boolean): void {
    this.updateActiveMode(channel1Active, channel2Active);
    if (!this.running) return;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.pollInProgress) void this.poll();
  }

  private async poll(): Promise<void> {
    if (this.pollInProgress) {
      return;
    }

    this.pollInProgress = true;
    try {
      const status = await this.getStatus();
      if (
        status.motorChannel1Active !== undefined &&
        status.motorChannel2Active !== undefined
      ) {
        this.updateActiveMode(status.motorChannel1Active, status.motorChannel2Active);
      }
      this.onStatus(status);
    } catch (error) {
      // Let mDNS resolve a fresh address after a failed request. This handles
      // DHCP address changes without doing multicast discovery on every poll.
      this.resolvedHost = undefined;
      this.onStatus(undefined, error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.pollInProgress = false;
      this.scheduleNextPoll();
    }
  }

  private updateActiveMode(channel1Active: boolean, channel2Active: boolean): void {
    const nextMotorActive = channel1Active || channel2Active;
    if (nextMotorActive) {
      this.motorActive = true;
      this.postStopUntilMs = 0;
    } else if (this.motorActive) {
      this.motorActive = false;
      this.postStopUntilMs = Date.now() + POST_STOP_ACTIVE_MS;
    }
  }

  private scheduleNextPoll(): void {
    if (!this.running) return;
    const delayMs = liftSensePollDelay(
      this.pollIntervalMs,
      this.motorActive,
      this.postStopUntilMs,
      Date.now(),
    );
    this.timer = setTimeout(() => void this.poll(), delayMs);
  }

  private getStatus(): Promise<LiftSenseStatus> {
    return this.resolveHost().then((host) => this.requestStatus(host));
  }

  private resolveHost(): Promise<string> {
    if (this.resolvedHost) {
      return Promise.resolve(this.resolvedHost);
    }

    if (isIP(this.host) !== 0 || !this.host.endsWith('.local')) {
      this.resolvedHost = this.host;
      return Promise.resolve(this.resolvedHost);
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
        else {
          this.resolvedHost = address;
          resolve(address!);
        }
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
        // LiftSense discovery deliberately resolves only mDNS A records. Keep
        // the HTTP path IPv4-only as well so Node never waits on an AAAA lookup.
        family: 4,
        port: 80,
        path: liftSenseStatusPath(this.callbackUrl),
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
            resolve(parseLiftSenseStatus(body));
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
