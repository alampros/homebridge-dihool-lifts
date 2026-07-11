/** eWeLink cloud API credentials (same as homebridge-ewelink) */
export const EWELINK_APP_ID = 'Uw83EKZFxdif7XFXEsrpduz5YyjP7nTl';
export const EWELINK_APP_SECRET = 'mXLOjea0woSMvK9gw7Fjsy7YlFO4iSu6';

/** eWeLink API hosts by region */
export const EWELINK_HOSTS: Record<string, string> = {
  us: 'us-apia.coolkit.cc',
  eu: 'eu-apia.coolkit.cc',
  as: 'as-apia.coolkit.cc',
  cn: 'cn-apia.coolkit.cn',
};

/** Default HTTP host (US region) */
export const DEFAULT_HTTP_HOST = EWELINK_HOSTS.us;

/** UIID for DIHOOL IPS-S2 (CK-BL602-4SW-HS) */
export const DIHOOL_UIID = 139;

/** eWeLink LAN device port */
export const EWELINK_LAN_PORT = 8081;

/** HTTP retry-able error codes */
export const HTTP_RETRY_CODES = ['ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNABORTED'];

/**
 * Parameters from device state that we care about.
 * mDNS TXT record decrypted payloads are filtered to only include these.
 */
export const PARAMS_TO_KEEP = [
  'configure',
  'fwVersion',
  'online',
  'pulses',
  'rssi',
  'sledOnline',
  'switch',
  'switches',
] as const;

/** Default configuration values */
export const DEFAULTS = {
  /** Seconds for lift to travel fully up (0% → 100%) */
  operationTimeUp: 8,
  /** Seconds for lift to travel fully down (100% → 0%) */
  operationTimeDown: 8,
  /** eWeLink outlet index for the UP motor channel */
  upChannel: 0,
  /** eWeLink outlet index for the DOWN motor channel */
  downChannel: 1,
  /** Country code for eWeLink login */
  countryCode: '+1',
} as const;

/** Plugin identifiers */
export const PLUGIN_NAME = 'homebridge-dihool-lifts';
export const PLATFORM_NAME = 'DihoolLifts';
