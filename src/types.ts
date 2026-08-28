/**
 * Shared TypeScript interfaces for the homebridge-dihool-lifts plugin.
 *
 * This plugin controls DIHOOL IPS-S2 motor controllers via the eWeLink LAN protocol.
 */

/**
 * Individual switch channel state for multi-channel eWeLink devices.
 */
export interface SwitchState {
  /** Channel power state. */
  switch: 'on' | 'off'
  /** Outlet index (0-3). */
  outlet: number
}

/**
 * Device data returned from the eWeLink cloud API.
 */
export interface EWeLinkDevice {
  /** eWeLink device ID (e.g. "100293a98d"). */
  deviceid: string
  /** Human-readable device name (e.g. "Sunroom Hydraulic Lift"). */
  name: string
  /** The lanKey used for AES encryption in LAN mode. */
  devicekey: string
  /** Device type info (uiid, model, etc.). */
  extra?: {
    uiid: number
    model?: string
  }
  /** Current device state parameters. */
  params?: {
    switches?: SwitchState[]
    [key: string]: unknown
  }
}

/**
 * Parameters in a device update (received from mDNS or sent to device).
 */
export interface DeviceParams {
  /** Current switch states for multi-channel devices. */
  switches?: SwitchState[]
  /** Whether the device is currently online. */
  online?: boolean
  /** Source of the update: LAN (mDNS/UDP) or WS (WebSocket/cloud). */
  updateSource?: 'LAN' | 'WS'
  /** IP address of the device on the local network. */
  ip?: string
  /** Additional eWeLink params. */
  [key: string]: unknown
}

/**
 * Update payload received from mDNS or sent to the device.
 */
export interface DeviceUpdate {
  /** eWeLink device ID. */
  deviceid: string
  /** Updated device parameters. */
  params: DeviceParams
}

/**
 * Entry in the LAN device map, tracking discovered or configured local devices.
 */
export interface LanDeviceInfo {
  /** Discovered or configured IP address. */
  ip?: string
  /** Whether the IP was manually overridden (not discovered via mDNS). */
  ipOverride: boolean
  /** AES encryption key for LAN communication. */
  lanKey?: string
  /** eWeLink UIID (device type identifier). */
  uiid?: number
  /** Product model string. */
  productModel?: string
  /** Last initialization vector used for AES encryption. */
  lastIV?: string
}

/**
 * Per-device configuration from config.json.
 */
export interface DeviceConfig {
  /** eWeLink device ID. Required for manual/LAN-only devices. Optional for a single cloud-discovered lift override. */
  deviceId?: string
  /** Optional display label (overrides cloud name). */
  label?: string
  /** Manual IP address override (skips mDNS discovery for this device). */
  ipAddress?: string
  /** Manual lanKey override (skips cloud login for this device). */
  lanKey?: string
  /** Outlet index for the "up" direction (default: 0). */
  upChannel?: number
  /** Outlet index for the "down" direction (default: 1). */
  downChannel?: number
  /** Expose Manual Up / Manual Down switches that send raw pulses, bypassing state tracking. */
  manualSwitches?: boolean
  /** mDNS hostname or IP address of the LiftSense ESP32 (for example, liftsense.local). */
  esp32Host?: string
  /** Shared API token configured on the LiftSense ESP32. */
  esp32Token?: string
  /** ESP32 status poll interval in seconds. Default: 2. */
  esp32PollIntervalSec?: number
  /** Log each ESP32 sensor poll. Default: false. */
  esp32DebugLogging?: boolean
  /**
   * Synchronize HomeKit TargetPosition with measured ESP32 position so the
   * Home app displays an exact percentage. Keep false until the sensor is
   * installed and calibrated. Default: false.
   */
  esp32SyncTargetPosition?: boolean
  /** Swap the observed meanings of LiftSense motor channels 1 and 2. Default: false. */
  invertMotorChannelDirections?: boolean
  /** Minimum sensor distance in mm, at the fully raised (100%) position. Default: 150. */
  minDistanceMm?: number
  /** Maximum sensor distance in mm, at the fully lowered (0%) position. Default: 1000. */
  maxDistanceMm?: number
  /** @deprecated Use minDistanceMm. Sensor distance when fully raised. */
  raisedDistanceMm?: number
  /** @deprecated Use maxDistanceMm. Sensor distance when fully lowered. */
  loweredDistanceMm?: number
  /** @deprecated Used only with legacy raised/lowered distance settings. */
  distanceDecreasesWhenRising?: boolean
}

/**
 * Plugin configuration from Homebridge config.json.
 */
export interface DihoolLiftConfig {
  /** Plugin instance name. */
  name?: string
  /** eWeLink account email or phone number. */
  username?: string
  /** eWeLink account password. */
  password?: string
  /** Country code for eWeLink login (default: "+1"). */
  countryCode?: string
  /** Connection mode: 'auto' (cloud + LAN fallback) or 'lan' (LAN only) (default: "auto"). */
  mode?: 'auto' | 'lan'
  /** Enable verbose debug logging. */
  debug?: boolean
  /** Base URL advertised to LiftSense for callbacks, for example http://10.0.0.10:8582/. */
  liftSenseCallbackBaseUrl?: string
  /** Per-device overrides and settings. */
  devices?: DeviceConfig[]
}

/**
 * Context stored on a Homebridge PlatformAccessory for this plugin.
 */
export interface AccessoryContext {
  /** eWeLink device ID. */
  deviceId: string
  /** eWeLink UIID (device type identifier). */
  uiid: number
  /** Device model string. */
  model: string
  /** AES encryption key for LAN communication. */
  lanKey: string
  /** Number of switch channels the device supports. */
  channelCount: number
  /** Device firmware version (if known). */
  firmware?: string
}
