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

For manual / LAN-only devices, each `devices` entry must include `deviceId` and `lanKey`. With cloud discovery, devices are found automatically; `devices` entries are only needed for overrides. If you have exactly one cloud-discovered lift, you may omit `deviceId` from a single override entry and it will apply to that lift.

| Option | Default | Description |
|--------|---------|-------------|
| `deviceId` | | eWeLink device ID. Required for manual/LAN-only devices and for matching overrides when multiple lifts are discovered |
| `lanKey` | | Device encryption key. Required for manual/LAN-only devices; cloud discovery supplies it automatically |
| `label` | Device ID or cloud name | Custom HomeKit display name |
| `operationTimeUp` | 8 | Seconds for full upward travel. Used only for the HomeKit status indicator timing. |
| `operationTimeDown` | 8 | Seconds for full downward travel. Used only for the HomeKit status indicator timing. |
| `upChannel` | 0 | eWeLink outlet index for UP |
| `downChannel` | 1 | eWeLink outlet index for DOWN |
| `ipAddress` | | Manual IP (skips mDNS discovery) |

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
