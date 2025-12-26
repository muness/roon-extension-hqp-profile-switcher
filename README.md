# HQP Profile Switcher

A Roon extension for managing HQPlayer Embedded profiles and audio pipeline settings.

## Features

- **Profile Switching**: Switch HQPlayer profiles from Roon's Settings UI or the built-in Web UI
- **Audio Pipeline Controls**: Adjust Mode, Sample Rate, Filters, and Dither directly from the Web UI
- **Mobile-Friendly**: Responsive Web UI designed for phones and tablets

## Installation

### Docker (Recommended)

Pull from Docker Hub:

```bash
docker pull muness/roon-extension-hqp-profile-switcher:latest
```

#### Docker Compose

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
      - "9330:9330/tcp"   # Roon extension
      - "9330:9330/udp"   # Roon discovery
      - "9331:9331/tcp"   # Web UI
    volumes:
      - hqp-profile-switcher-data:/home/node/app/data

volumes:
  hqp-profile-switcher-data:
```

Start with:

```bash
docker compose up -d
```

### Manual Installation

```bash
git clone https://github.com/muness/roon-extension-hqp-profile-switcher.git
cd roon-extension-hqp-profile-switcher
npm install
npm run roon-extension
```

## Configuration

1. Open Roon → Settings → Extensions → HQP Profile Switcher
2. Enter your HQPlayer Embedded credentials:
   - **Host**: IP address of HQPlayer (e.g., `192.168.1.61`)
   - **Port**: Web interface port (default: `8088`)
   - **Username/Password**: HQPlayer web credentials
3. Select a profile and save

## Web UI

Access the Web UI at `http://<host>:9331/ui`

Features:
- **Audio Pipeline**: View and change Mode, Sample Rate, Filter 1x, Filter Nx, and Dither
- **Status**: See current playback state, connection status, and active config
- **Profiles**: Quick profile switching

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ROON_EXTENSION_PORT` | `9330` | Port for Roon extension communication |
| `HQP_UI_PORT` | `9331` | Port for the Web UI |
| `HQP_RESTART_GRACE_MS` | `10000` | Grace period (ms) after profile load while HQPlayer restarts |

## CLI Tool

A standalone CLI is also included for scripting:

```bash
# Set credentials
export HQP_HOST=192.168.1.61
export HQP_USER=audiolinux
export HQP_PASS=audiolinux

# List profiles
node scripts/switch.js --list

# Load a profile
node scripts/switch.js Zen
```

## Links

- [Docker Hub](https://hub.docker.com/r/muness/roon-extension-hqp-profile-switcher)
- [GitHub](https://github.com/muness/roon-extension-hqp-profile-switcher)

## License

ISC © 2025 Muness Castle
