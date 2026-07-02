import { createHmac, randomBytes } from 'node:crypto';
import type { Logger } from 'homebridge';
import { EWELINK_APP_ID, EWELINK_APP_SECRET, HTTP_RETRY_CODES } from '../utils/constants.js';
import { sleep } from '../utils/helpers.js';

/* ------------------------------------------------------------------
 * Types
 * ---------------------------------------------------------------- */

interface EWeLinkResponse<T> {
  error: number;
  msg: string;
  data: T;
}

interface LoginData {
  at: string;
  user: {
    apikey: string;
  };
  region?: string;
}

interface FamilyData {
  familyList?: Array<{ id: string; name: string }>;
}

interface ThingData {
  thingList?: Array<Record<string, unknown>>;
}

export interface DiscoveredDevice {
  deviceid: string;
  name: string;
  devicekey: string;
  uiid: number;
  model: string;
  params: Record<string, unknown>;
}

/* ------------------------------------------------------------------
 * Errors
 * ---------------------------------------------------------------- */

class EWeLinkAPIError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = 'EWeLinkAPIError';
  }
}

/* ------------------------------------------------------------------
 * EWeLink Cloud Connection
 * ---------------------------------------------------------------- */

/**
 * Handles eWeLink cloud API authentication and device discovery.
 *
 * Adapted from homebridge-ewelink's lib/connection/http.js.
 */
export class EWeLinkCloud {
  private aToken?: string;
  private apiKey?: string;

  constructor(
    private readonly username: string,
    private readonly password: string,
    private readonly countryCode: string,
    private httpHost: string,
    private readonly log: Logger,
    private readonly debug: boolean,
  ) {}

  /* ------------------------------------------------------------------
   * Public API
   * ---------------------------------------------------------------- */

  /**
   * Authenticate with the eWeLink cloud API.
   *
   * Handles region redirects (error 10004) and base64-encoded password
   * retries (errors 10001 / 10014).
   *
   * @returns Authentication tokens and the resolved HTTP host.
   */
  async login(): Promise<{ aToken: string; apiKey: string; httpHost: string }> {
    const isEmail = this.username.includes('@');

    const buildBody = (pwd: string): string => {
      const body: Record<string, string> = {
        countryCode: this.countryCode,
        password: pwd,
      };
      if (isEmail) {
        body.email = this.username;
      } else {
        body.phoneNumber = this.username;
      }
      return JSON.stringify(body);
    };

    const doLogin = async (pwd: string, isDecoded = false): Promise<{ aToken: string; apiKey: string; httpHost: string }> => {
      const body = buildBody(pwd);
      const nonce = this.generateNonce();
      const signature = this.generateSignature(body);

      const url = `https://${this.httpHost}/v2/user/login`;

      try {
        const data = await this.fetchWithRetry<LoginData>(url, {
          method: 'POST',
          headers: {
            Authorization: `Sign ${signature}`,
            'Content-Type': 'application/json',
            'X-CK-Appid': EWELINK_APP_ID,
            'X-CK-Nonce': nonce,
          },
          body,
        });

        this.aToken = data.at;
        this.apiKey = data.user.apikey;

        if (this.debug) {
          this.log.debug('[eWeLink Cloud] Login successful');
        }

        return { aToken: data.at, apiKey: data.user.apikey, httpHost: this.httpHost };
      } catch (error) {
        if (error instanceof EWeLinkAPIError) {
          // Region redirect — update host and retry
          if (error.code === 10004 && error.data && typeof error.data === 'object') {
            const region = (error.data as Record<string, unknown>).region;
            if (typeof region === 'string') {
              const newHost = region.includes('.') ? region : `${region}-apia.coolkit.cc`;
              if (this.debug) {
                this.log.debug('[eWeLink Cloud] Redirecting to region: %s (%s)', region, newHost);
              }
              this.httpHost = newHost;
              return doLogin(pwd, isDecoded);
            }
          }

          // Password error — try base64-decoding the password once
          if ((error.code === 10001 || error.code === 10014) && !isDecoded) {
            try {
              const decodedPwd = Buffer.from(pwd, 'base64').toString('utf8');
              if (this.debug) {
                this.log.debug('[eWeLink Cloud] Retrying login with base64-decoded password');
              }
              return doLogin(decodedPwd, true);
            } catch {
              // Fall through to throw the original error
            }
          }
        }

        throw error;
      }
    };

    return doLogin(this.password);
  }

  /**
   * Fetch the list of homes (families) associated with the account.
   *
   * @returns Array of home objects with id and name.
   */
  async getHomes(): Promise<Array<{ id: string; name: string }>> {
    if (!this.aToken) {
      throw new Error('Not logged in');
    }

    const nonce = this.generateNonce();
    const url = `https://${this.httpHost}/v2/family`;

    const data = await this.fetchWithRetry<FamilyData>(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.aToken}`,
        'X-CK-Appid': EWELINK_APP_ID,
        'X-CK-Nonce': nonce,
      },
    });

    return data.familyList || [];
  }

  /**
   * Fetch devices for a given home.
   *
   * @param familyId - The home/family identifier.
   * @returns Raw thingList array from the eWeLink API.
   */
  async getDevices(familyId: string): Promise<unknown[]> {
    if (!this.aToken) {
      throw new Error('Not logged in');
    }

    const nonce = this.generateNonce();
    const url = `https://${this.httpHost}/v2/device/thing?num=0&familyid=${encodeURIComponent(familyId)}`;

    const data = await this.fetchWithRetry<ThingData>(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.aToken}`,
        'X-CK-Appid': EWELINK_APP_ID,
        'X-CK-Nonce': nonce,
      },
    });

    return data.thingList || [];
  }

  /**
   * Convenience method that logs in, discovers all homes, and fetches
   * devices from each home.
   *
   * @returns Flat array of discovered device objects.
   */
  async discoverDevices(): Promise<DiscoveredDevice[]> {
    await this.login();

    if (this.debug) {
      this.log.debug('[eWeLink Cloud] Starting device discovery (host: %s)', this.httpHost);
    }

    const homes = await this.getHomes();
    const devices: DiscoveredDevice[] = [];

    for (const home of homes) {
      if (this.debug) {
        this.log.debug('[eWeLink Cloud] Fetching devices for home: %s (%s)', home.name, home.id);
      }

      const thingList = await this.getDevices(home.id);

      for (const item of thingList) {
        const thing = item as Record<string, unknown>;
        const itemType = thing.itemType;
        const rawItemData = thing.itemData;

        if (
          (itemType === 1 || itemType === 2) &&
          typeof rawItemData === 'object' &&
          rawItemData !== null
        ) {
          const itemData = rawItemData as Record<string, unknown>;
          const extra = itemData.extra as Record<string, unknown> | undefined;

          if (extra?.uiid !== undefined) {
            devices.push({
              deviceid: String(itemData.deviceid),
              name: String(itemData.name),
              devicekey: String(itemData.devicekey || itemData.apikey),
              uiid: Number(extra.uiid),
              model: String(extra.model || itemData.productModel || ''),
              params: (itemData.params as Record<string, unknown>) || {},
            });
          }
        }
      }
    }

    if (this.debug) {
      this.log.debug('[eWeLink Cloud] Discovered %d devices', devices.length);
    }

    return devices;
  }

  /* ------------------------------------------------------------------
   * Private helpers
   * ---------------------------------------------------------------- */

  private generateNonce(): string {
    return randomBytes(4).toString('hex');
  }

  private generateSignature(body: string): string {
    return createHmac('sha256', EWELINK_APP_SECRET).update(body).digest('base64');
  }

  private async fetchWithRetry<T>(
    url: string,
    options: RequestInit,
    retries = 3,
    backoff = 1000,
  ): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        if (this.debug) {
          this.log.debug(
            '[eWeLink HTTP] %s %s (attempt %d/%d)',
            options.method || 'GET',
            url,
            attempt + 1,
            retries + 1,
          );
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);

        try {
          const response = await fetch(url, {
            ...options,
            signal: controller.signal,
          });

          let json: EWeLinkResponse<T>;
          try {
            json = (await response.json()) as EWeLinkResponse<T>;
          } catch {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
          }

          if (json.error !== 0) {
            throw new EWeLinkAPIError(
              json.error,
              json.msg || `eWeLink API error ${json.error}`,
              json.data,
            );
          }

          return json.data;
        } finally {
          clearTimeout(timeout);
        }
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        lastError = err;

        // API errors are not retried
        if (error instanceof EWeLinkAPIError) {
          throw error;
        }

        const shouldRetry = HTTP_RETRY_CODES.some((code) => err.message.includes(code));
        if (!shouldRetry || attempt >= retries) {
          throw err;
        }

        if (this.debug) {
          this.log.debug(
            '[eWeLink HTTP] Network error, retrying in %d ms: %s',
            backoff,
            err.message,
          );
        }

        await sleep(backoff);
        backoff *= 2;
      }
    }

    throw lastError!;
  }
}
