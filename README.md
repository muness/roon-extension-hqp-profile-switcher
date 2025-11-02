# HQP Tools

Utilities for automating HQPlayer Embedded profile changes and exposing them in Roon/rooExtend.

## Packages

- `scripts/switch.js` – Node CLI that performs digest-auth against HQPlayer and loads the requested profile. Supports listing available profiles and passing connection overrides by flag or environment variable.
- `extension/` – Roon extension (“HQP Profile Switcher”) that persists HQPlayer credentials, surfaces the discovered profiles in the settings UI, and issues the same load request.

## Quick Start

```bash
# install dependencies
npm install
npm install --prefix extension

# list HQPlayer profiles
HQP_HOST=192.168.1.61 HQP_USER=audiolinux HQP_PASS=audiolinux \
node scripts/switch.js --list

# load a profile
node scripts/switch.js Zen
```

## Roon Extension

```bash
# run locally (Roon → Settings → Extensions → HQP Profile Switcher)
npm run roon-extension
```

For Docker builds and publishing via rooExtend, follow the instructions in `README_dev.md`.

## License

ISC © 2024 Muness Castle
