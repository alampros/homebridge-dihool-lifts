# homebridge-dihool-lifts

Homebridge plugin for [DIHOOL](https://www.dihool.com/) IPS-S2 scissor lifts. Exposes the lift as a HomeKit garage door opener -- open raises, close lowers, tap mid-travel to stop.

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

| Option | Default | Description |
|--------|---------|-------------|
| `operationTimeUp` | 25 | Seconds for full upward travel |
| `operationTimeDown` | 20 | Seconds for full downward travel |
| `upChannel` | 0 | eWeLink outlet index for UP |
| `downChannel` | 1 | eWeLink outlet index for DOWN |
| `ipAddress` | | Manual IP (skips mDNS discovery) |
| `showDebugSwitches` | false | Expose raw channel switches |

### Getting the LAN key

If you need the LAN key for manual configuration:

```
npx tsx scripts/get-lankey.ts your-ewelink-email
```

## How it works

The DIHOOL IPS-S2 (eWeLink UIID 139, CK-BL602-4SW-HS) is a 4-channel motor controller with pulse/inching mode. The plugin sends encrypted pulse commands to channel 0 (up) or channel 1 (down) over your local network. Position is estimated via configurable travel timers.

## Development

```bash
npm install
npm run build          # TypeScript 7 RC
npm run lint           # oxlint + tsc --noEmit
npm run dev            # build + run local Homebridge instance
```

## License

MIT
