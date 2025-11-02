# HQP Profile Switcher

Switch HQPlayer Embedded profiles directly from Roon. The extension exposes a settings panel where you can enter HQPlayer connection credentials, pick one of the profiles discovered from the `/config/profile/load` form, and trigger a load. Status updates reflect the last action or any connection errors.

NOTE: This is an unofficial switcher that relies on HQPlayer Embedded's web interface to retrieve and switch profiles.


## Folder Layout

- `index.js` – Roon extension entrypoint, including settings + status services.
- `lib/hqp-client.js` – Digest-auth HTTP client that scrapes the HQP profile dropdown and posts the selected profile.
- `Dockerfile` – Multi-arch container build (matches rooExtend generator expectations).
- `.reg/` – Metadata used by the rooExtend Extension Manager (extend as needed for publishing).
- `data/settings.json` – Persisted credentials and last-selected profile (written at runtime).
- After entering host, port, username, and password, press **Save** to connect and refresh the profile dropdown.

## Running Locally

```bash
# install deps
npm install --prefix extension

# run the extension (Roon UI: Settings → Extensions)
npm run roon-extension
```

Use the CLI helper for quick checks without Roon:

```bash
HQP_HOST=192.168.1.61 HQP_USER=audiolinux HQP_PASS=secret \
node scripts/switch.js --list
```
