# HQP Tools

Utilities for automating HQPlayer Embedded profile changes and exposing them in Roon/rooExtend.

## Packages

- `scripts/switch.js` – Node CLI that performs digest-auth against HQPlayer and loads the requested profile. Supports listing available profiles and passing connection overrides by flag or environment variable.
- `extension/` – Roon extension (“HQPlayer Embedded Profile Switcher”) that persists HQPlayer credentials, surfaces the discovered profiles in the settings UI, and issues the same load request.

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

### Docker Compose (no Extension Manager)

If you simply want to run the extension directly on a Docker host (QNAP, NAS, mini PC) without TheAppgineer’s Extension Manager, use the provided `docker-compose.yml`:

```yaml
services:
  hqp-profile-switcher:
    image: docker.io/muness/roon-extension-hqp-profile-switcher:latest
    container_name: hqp-profile-switcher
    restart: unless-stopped
    environment:
      - TZ=UTC
      - ROON_EXTENSION_PORT=9330
      - HQP_UI_PORT=9331
      - HQP_RESTART_GRACE_MS=10000
    ports:
      - "9330:9330"
      - "9331:9331"
```

Start it with:

```bash
docker compose up -d
```

Once running, point Roon to the host (Settings → Extensions) and configure HQPlayer credentials from the extension’s settings panel.
Set `ROON_EXTENSION_PORT` if you need the service to listen on a port other than `9330`.

The built-in web UI is available at `http://<host>:9331/ui` (or whatever you set `HQP_UI_PORT` to) for quick profile checks and manual switches. Adjust `HQP_RESTART_GRACE_MS` if HQPlayer takes longer than the default 60s to come back after loading a profile.

## License

ISC © 2024 Muness Castle
