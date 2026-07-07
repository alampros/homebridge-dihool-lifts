# AGENTS.md

Homebridge plugin controlling DIHOOL IPS-S2 scissor lifts via eWeLink LAN protocol.

## Commands

```sh
npm run lint          # oxlint + tsc --noEmit (not ESLint)
npm test              # vitest run
npm run build         # tsc -> dist/
npm run dev           # build + launch homebridge with local .homebridge-dev/ config
```

CI runs: `lint -> test -> build` on Node 22 and 24. Match that order locally.

## Toolchain

- **ESM-only** (`"type": "module"`) -- all local imports must use `.js` extensions
- **TypeScript 7** targeting ES2022 / NodeNext
- **Linter**: oxlint (Rust-based), not ESLint -- no `.eslintrc`
- **Tests**: vitest, not Jest -- no config file, defaults are fine
- **Node**: 22+ (pinned in `.node-version`)
- **Package manager**: npm with corepack (`corepack enable`)
- **Releases**: release-please on `main`; non-release pushes publish a `-dev` tag to npm

## Architecture

```
src/
  index.ts                  # Plugin registration (entrypoint)
  platform.ts               # Homebridge platform -- discovers devices, creates accessories
  lift-accessory.ts          # Per-device HomeKit WindowCovering service
  position-tracker.ts        # Timer-based position estimation (no encoder feedback)
  types.ts                   # Shared interfaces
  connection/
    ewelink-cloud.ts         # Cloud API (device discovery + lanKey retrieval only)
    ewelink-lan.ts           # LAN protocol: mDNS discovery + AES-128-CBC encrypted HTTP
  utils/
    constants.ts
    helpers.ts
```

Key design decisions:
- Uses **WindowCovering** (not GarageDoorOpener) to enable Siri percentage commands
- **Cloud is discovery-only** -- all control commands go over LAN
- Uses `node:http` for device requests because eWeLink's HTTP server has issues with `undici`/`fetch`
- Position tracking is purely time-based with calibration overshoot on limit-switch endpoints

## Testing

Tests live next to source (`*.test.ts`). Currently only `position-tracker.test.ts` exists.

Tests use an injectable clock (`now` parameter) for deterministic time simulation -- follow this pattern for new tests. Tests create real temp directories for persistence testing; cleanup is in `afterEach`.

## Scripts

Utility scripts in `scripts/` are run with `npx tsx`:
```sh
npx tsx scripts/get-lankey.ts <email> [countryCode] [region]
npx tsx scripts/monitor-device.ts ...
npx tsx scripts/probe-device.ts ...
```

## Config

- `config.schema.json` -- Homebridge UI config schema (validated by Homebridge)
- `.homebridge-dev/` -- local dev Homebridge config directory (used by `npm run dev`)
