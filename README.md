# homebridge-dihool-lifts

Homebridge plugin for [DIHOOL](https://www.dihool.com/) IPS-S2 scissor lifts. Exposes the lift as a HomeKit WindowCovering -- 0% lowers, 100% raises, and changing target position mid-travel stops or redirects the lift.

Communicates via the eWeLink LAN protocol (AES-encrypted commands over your local network). Cloud login is only used once to discover devices; all control is LAN-only after that.

## Install

```
npm install -g homebridge-dihool-lifts
```

Or search "dihool" in the Homebridge UI plugin tab.

## Configuration

The plugin supports two modes:

**Cloud discovery** (recommended) -- enter your eWeLink credentials and the plugin finds your lifts automatically:

```json
{
  "platform": "DihoolLifts",
  "name": "Dihool Lifts",
  "username": "your-ewelink-email",
  "password": "your-ewelink-password",
  "countryCode": "+1"
}
```

**Manual / LAN-only** -- no cloud dependency, but you need the device ID and LAN key:

```json
{
  "platform": "DihoolLifts",
  "name": "Dihool Lifts",
  "mode": "lan",
  "devices": [
    {
      "deviceId": "your-device-id",
      "lanKey": "your-lan-key",
      "ipAddress": "192.168.1.100",
      "label": "Sunroom Lift"
    }
  ]
}
```

Use the Homebridge Config UI for a guided setup, or see `config.schema.json` for all options.

### Per-device options

Every `devices` entry must include `deviceId` so its settings stay attached to the correct lift. Manual / LAN-only devices must also include `lanKey`. With cloud discovery, devices are found automatically; `devices` entries are only needed for overrides.

| Option                         | Default                 | Description                                                                                            |
| ------------------------------ | ----------------------- | ------------------------------------------------------------------------------------------------------ |
| `deviceId`                     |                         | eWeLink device ID. Required for every device entry                                                     |
| `lanKey`                       |                         | Device encryption key. Required for manual/LAN-only devices; cloud discovery supplies it automatically |
| `label`                        | Device ID or cloud name | Custom HomeKit display name                                                                            |
| `operationTimeUp`              | 8                       | Seconds for full upward travel. Used only for the HomeKit status indicator timing.                     |
| `operationTimeDown`            | 8                       | Seconds for full downward travel. Used only for the HomeKit status indicator timing.                   |
| `upChannel`                    | 0                       | eWeLink outlet index for UP                                                                            |
| `downChannel`                  | 1                       | eWeLink outlet index for DOWN                                                                          |
| `ipAddress`                    |                         | Manual IP (skips mDNS discovery)                                                                       |
| `esp32Host`                    |                         | LiftSense hostname or IPv4 address; enables physical position and motor-state polling                  |
| `esp32Token`                   |                         | LiftSense API token                                                                                    |
| `esp32PollIntervalSec`         | 2                       | Seconds between LiftSense status polls                                                                 |
| `esp32DebugLogging`            | false                   | Log each LiftSense distance and motor-state reading                                                    |
| `esp32SyncTargetPosition`      | false                   | Show measured position as HomeKit's target after the motor stops; never sends a command                |
| `invertMotorChannelDirections` | false                   | Swap motor detector channel 1/2 direction meanings; affects HomeKit display only                       |
| `minDistanceMm`                | 150                     | Distance measured at fully raised (100%)                                                               |
| `maxDistanceMm`                | 1000                    | Distance measured at fully lowered (0%)                                                                |

Set the global `liftSenseCallbackBaseUrl` option to the full local HTTP base URL
that the ESP32 can use to reach Homebridge, such as
`http://10.0.0.10:8582/`. The plugin listens on the port in that URL and
advertises the full callback URL on every status poll, so no Homebridge address
is stored in the firmware configuration. A callback immediately changes that lift to 10 Hz polling; it
returns to the configured `esp32PollIntervalSec` two seconds after the motor
stops. Regular polling remains active as a fallback if a callback is missed.

The callback listener is local-network only and uses the configured
`esp32Token` as its bearer token. Each lift must use a unique token. Leave
`liftSenseCallbackBaseUrl` blank to disable callbacks.

### Getting the LAN key

If you need the LAN key for manual configuration:

```
npx tsx scripts/get-lankey.ts your-ewelink-email
```

## How it works

The DIHOOL IPS-S2 (eWeLink UIID 139, CK-BL602-4SW-HS) is a 4-channel motor controller with pulse/inching mode. The plugin sends a single encrypted pulse command to channel 0 (up) or channel 1 (down) over your local network to start movement. Optional hardware limit switches stop the motor at the top and bottom positions — the software never sends a stop pulse. Travel times are used only for the cosmetic HomeKit status indicator.

## Development

```bash
npm install
npm run build          # TypeScript 7 RC
npm run lint           # oxlint + tsc --noEmit
npm run dev            # build + run local Homebridge instance
```

## License

MIT
