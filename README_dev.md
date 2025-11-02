# Local Development & Testing

This document covers how to work on the HQP Profile Switcher project, test the Node CLI helper, and exercise the Roon/rooExtend extension locally or in Docker.

## Prerequisites

- Node.js 18+ and npm
- Docker (for container builds or rooExtend-style validation)
- Access to the target HQPlayer Embedded host (digest auth enabled)
- A Roon Core if you want to test the extension UI end-to-end

## Install Dependencies

```bash
# install top-level deps (Playwright + shared libs)
npm install

# install extension-specific deps (runs inside Docker image too)
npm install --prefix extension
```

## CLI Quick Tests

```bash
# list profiles scraped from HQPlayer
HQP_HOST=192.168.1.61 \
HQP_USER=audiolinux \
HQP_PASS=audiolinux \
node scripts/switch.js --list

# load a profile by name/value
node scripts/switch.js Zen
```

Environment variables are optional; use `--host=`, `--user=`, etc., for overrides.

## Roon Extension Development

```bash
# run the extension in watch mode (restart manually after edits)
npm run roon-extension
```

Within Roon: go to **Settings → Extensions**, enable “HQP Profile Switcher,” then open the settings gear to enter HQPlayer credentials and select a profile. Status updates appear beneath the extension name.

### Persisted Data

Runtime settings persist in `extension/data/settings.json`. Delete the file to reset credentials between tests.

## Docker Build & Test

```bash
# build a local amd64 image
docker build -f extension/Dockerfile -t hqp-profile-switcher:dev extension

# run it, exposing any ports you need (none by default)
docker run --rm \
  -v $(pwd)/extension/data:/home/node/app/data \
  hqp-profile-switcher:dev
```

The Extension Manager expects additional run/publish helpers. Use the `extension/.reg/settings` metadata with the [roon-extension-generator](roon-extension-generator/README.md) scripts (`generate.sh`, `build.sh`, `publish.sh`) if you plan to distribute via rooExtend.

## Updating Digest Auth Client

The digest-auth implementation lives in `extension/lib/hqp-client.js` and is shared by both the CLI and the extension. Make changes there, then rerun the CLI and UI tests to ensure nothing regresses.

## Troubleshooting

- **401 Unauthorized** – double-check HQPlayer credentials and confirm Digest auth is enabled.
- **Profile dropdown empty** – confirm HQPlayer is reachable and the `/config/profile/load` page renders the `<select name="profile">` element.
- **Extension missing in Roon** – ensure the process is running and that Roon Core can reach the device running the extension (same subnet recommended).
