# Changelog

## [0.1.9](https://github.com/alampros/homebridge-dihool-lifts/compare/v0.1.8...v0.1.9) (2026-08-27)

### Features

- add liftsense callback url on motor state changes ([e423424](https://github.com/alampros/homebridge-dihool-lifts/commit/e423424c4c8214e2fdc3101dfafa82e3f3157f79))

### Bug Fixes

- update liftSenseCallbackPort to accept string values and enhance validation ([fd3b192](https://github.com/alampros/homebridge-dihool-lifts/commit/fd3b192b791bc21d7a187ab6e9e00b9bc0e2da56))
- use liftSenseCallbackBaseUrl instead of separate host and port ([4e80c32](https://github.com/alampros/homebridge-dihool-lifts/commit/4e80c328dce5cf24e029fafde87ebc19d7d3f42e))

## [0.1.8](https://github.com/alampros/homebridge-dihool-lifts/compare/v0.1.7...v0.1.8) (2026-08-27)

### Features

- **config:** add esp32 debug logging option ([85ebdef](https://github.com/alampros/homebridge-dihool-lifts/commit/85ebdef5bc04717da49d8444d03ad3156222e8dd))
- gate sensor target position sync ([6276048](https://github.com/alampros/homebridge-dihool-lifts/commit/6276048ac396f8bc64755d7d7b63c570a31c7ce6))
- integrate LiftSense motor state ([6b5bab9](https://github.com/alampros/homebridge-dihool-lifts/commit/6b5bab9eebf8d8bbc572c27407cae88ecca14506))
- integrate with esp32 sensor ([72cba9e](https://github.com/alampros/homebridge-dihool-lifts/commit/72cba9ef5da622e07ca85ab7f0241da81ed4c4d1))

### Bug Fixes

- **config:** require device ID for each ([c8235af](https://github.com/alampros/homebridge-dihool-lifts/commit/c8235affafe0f51680ab17c12d66c8ea040663cd))
- derive read-only lift position from sensor bounds ([4cfcf4e](https://github.com/alampros/homebridge-dihool-lifts/commit/4cfcf4e556a01c14696ffe1f036e2a0d566387ca))
- require deviceId for each lift ([2476181](https://github.com/alampros/homebridge-dihool-lifts/commit/24761810bce340800e57cf96b8fc49eb4fab9d71))
- resolve esp32 host via mdns ([7823f22](https://github.com/alampros/homebridge-dihool-lifts/commit/7823f22c442dff860eddf72fcdaa65e3b43b7fe8))
- show position ([a45464d](https://github.com/alampros/homebridge-dihool-lifts/commit/a45464d20001d62311c51a65c3c7eb953558195c))
- smooth sensor position updates ([6271d5f](https://github.com/alampros/homebridge-dihool-lifts/commit/6271d5fc9dc008a3ff43044ba14740cad197e7b4))
- use filtered readings from esp32 ([5883174](https://github.com/alampros/homebridge-dihool-lifts/commit/588317417f4123167711da96f7614eb77e6e53ca))
- wait for esp32 init before polling ([30df521](https://github.com/alampros/homebridge-dihool-lifts/commit/30df521b35afec9c060ba671d9255b3a11eca97b))

## [0.1.7](https://github.com/alampros/homebridge-dihool-lifts/compare/v0.1.6...v0.1.7) (2026-07-11)

### Bug Fixes

- use ConfiguredName for manual switches ([50835a3](https://github.com/alampros/homebridge-dihool-lifts/commit/50835a3d4ec07811dc3fa1fab6ee8ab3106212bc))

## [0.1.6](https://github.com/alampros/homebridge-dihool-lifts/compare/v0.1.5...v0.1.6) (2026-07-11)

### Features

- add optional manual override switches ([9613932](https://github.com/alampros/homebridge-dihool-lifts/commit/9613932225c7e4cb7bbb233ab6b7094e7a522d65))
- replace position estimation with binary state model ([0050ef6](https://github.com/alampros/homebridge-dihool-lifts/commit/0050ef684fc935e9a1dee927cf6f61d65606037e))

### Bug Fixes

- calibration after unknown position and more ([a4c801e](https://github.com/alampros/homebridge-dihool-lifts/commit/a4c801e989a87e1945717b644949d0e0bd78eee3))

## [0.1.5](https://github.com/alampros/homebridge-dihool-lifts/compare/v0.1.4...v0.1.5) (2026-07-02)

### Bug Fixes

- config schema changes ([771e2ad](https://github.com/alampros/homebridge-dihool-lifts/commit/771e2ad9886f4518a80caf23f2a9ff6782745cb2))
- **config:** require a device id ([1825f88](https://github.com/alampros/homebridge-dihool-lifts/commit/1825f880e858acc1ebac0290e2e697b054feafd0))
- remove package name from tag versions ([ff8d805](https://github.com/alampros/homebridge-dihool-lifts/commit/ff8d8050c9c73f26e6bf9764812a73749bc47c62))

## [0.1.4](https://github.com/alampros/homebridge-dihool-lifts/compare/homebridge-dihool-lifts-v0.1.3...homebridge-dihool-lifts-v0.1.4) (2026-07-02)

### Bug Fixes

- **config:** reorder schema ([1589b6f](https://github.com/alampros/homebridge-dihool-lifts/commit/1589b6feb8d243afaab477e144fbe3adc7c9596e))
- use first device found if lookup by id returns none ([2c4dbec](https://github.com/alampros/homebridge-dihool-lifts/commit/2c4dbec88c542691a7f41451c60b668778e640f3))

## [0.1.3](https://github.com/alampros/homebridge-dihool-lifts/compare/homebridge-dihool-lifts-v0.1.2...homebridge-dihool-lifts-v0.1.3) (2026-07-02)

### Bug Fixes

- mdns discovery state ([52f4bc8](https://github.com/alampros/homebridge-dihool-lifts/commit/52f4bc84f64f65f8ee36118f10ddb12f37a01732))
- only calibrate at 0% — 100% uses timed stop ([f8145e1](https://github.com/alampros/homebridge-dihool-lifts/commit/f8145e144a1793f44a70b535d108c6c929e79cd5))

## [0.1.2](https://github.com/alampros/homebridge-dihool-lifts/compare/homebridge-dihool-lifts-v0.1.1...homebridge-dihool-lifts-v0.1.2) (2026-07-02)

### Bug Fixes

- refactor from garage door to windowcovering ([db698e5](https://github.com/alampros/homebridge-dihool-lifts/commit/db698e515a0991438477cd4be234c46a709fc816))

## [0.1.1](https://github.com/alampros/homebridge-dihool-lifts/compare/homebridge-dihool-lifts-v0.1.0...homebridge-dihool-lifts-v0.1.1) (2026-07-02)

### Features

- initial homebridge plugin for DIHOOL IPS-S2 scissor lifts ([bfe6329](https://github.com/alampros/homebridge-dihool-lifts/commit/bfe632926b172fc800df1924c1c040f8250cfbc0))

### Bug Fixes

- use corepack for npm version ([cdfc0a0](https://github.com/alampros/homebridge-dihool-lifts/commit/cdfc0a058bbe0dd8c1c2c15a6d781f5db34f0a9d))
