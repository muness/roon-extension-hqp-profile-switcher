# Source Control API Experiment: HQPlayer Profile Switching

## Summary

We attempted to expose HQPlayer profiles as Roon Source Control devices, allowing users to switch profiles directly from Roon's "Now Playing" controls. This approach ultimately failed due to fundamental API mismatches and timing issues.

## What We Tried

### The Goal

Allow users to switch HQPlayer profiles (e.g., "Zen", "SDA", "GaN") from the Roon UI without navigating to extension settings. The Source Control API seemed promising because it appears in the Now Playing area as clickable device icons.

### Implementation Approach

1. **Registered each HQPlayer profile as a Source Control device** using `RoonApiSourceControl`
2. **Handled two callbacks:**
   - `convenience_switch`: Called when Roon wants to "restore" a source for a zone
   - `standby`: Called when user explicitly clicks on a source control
3. **Added playback coordination** using `RoonApiTransport` to trigger play after profile switches
4. **Implemented HQPlayer readiness detection** by polling the HTTP interface until it responds

### Key Code Components Added

```javascript
// Source control registration for each profile
svc_source_control.new_device(profile, {
  state: { status: "deselected", ... },
  convenience_switch: (req) => handleProfileConvenienceSwitch(req, value),
  standby: (req) => handleProfileStandby(req, value),
});

// Readiness polling
async function waitForHQPlayerReady() {
  while (Date.now() - startTime < READY_POLL_TIMEOUT_MS) {
    const profiles = await client.fetchProfiles();
    if (profiles.length >= expectedProfileCount) return true;
    await sleep(READY_POLL_INTERVAL_MS);
  }
}

// Play trigger after profile switch
function triggerPlayOnHQPlayerZone() {
  const zone = findHQPlayerZone();
  transport.control(zone, "play");
}
```

## Why It Failed

### 1. API Mismatch: Source Control vs. DSP Profiles

The Source Control API was designed for **physical input switching on AVRs** (e.g., "switch to HDMI1", "switch to Optical"). It assumes:
- Switching is instantaneous
- The device remains available during switch
- Multiple sources can be "associated" with a zone

HQPlayer profiles are fundamentally different:
- **HQPlayer restarts when loading a profile** (2-11 seconds downtime)
- Profiles aren't "inputs" - they're entire DSP configurations
- Only one profile is active at a time

### 2. Roon's `convenience_switch` Auto-Restore Behavior

When playback starts, Roon automatically calls `convenience_switch` on source controls it has "associated" with that zone. This is designed for AVRs where you want "when I play to Living Room, switch receiver to the right input."

For HQPlayer profiles, this caused:
- Roon trying to switch profiles when we just wanted to play
- Race conditions between our intended profile and Roon's "restore" attempt
- Unexpected profile switches mid-playback

We tried ignoring `convenience_switch` entirely and only responding to `standby` (explicit clicks), but this created other timing issues.

### 3. HQPlayer Restart Timing is Unpredictable

HQPlayer Embedded restarts completely when loading a new profile. The restart time varies significantly:
- **Ethernet-connected DAC (SDA):** ~2.2 seconds
- **WiFi-connected DAC (Zen):** ~10.7 seconds

Even after HQPlayer's HTTP interface responds, the audio subsystem may not be ready. We tried:
- Grace periods (10s, then 15s)
- Readiness polling (wait for HTTP to respond)
- Buffer delays (3s, then 5s after HTTP ready)
- Race condition fixes (clear timers immediately on ready)

The WiFi case remained unreliable despite all these mitigations.

### 4. No Feedback Mechanism

Roon has no toast/notification API to inform users during the long profile switch. Users would click a profile and see nothing happen for 10-20 seconds, then playback might or might not start.

## Complexity Accumulated

Over the debugging sessions, we added:
- Zone tracking (`knownZones` Map)
- HQPlayer zone detection (`findHQPlayerZone()`)
- Readiness polling with configurable timeouts
- Grace period timers with race condition handling
- Transport control for auto-play
- Distinction between `convenience_switch` (ignored) and `standby` (handled)
- Multiple timing constants (grace period, poll interval, poll timeout, ready buffer)

This complexity indicated we were fighting the API rather than using it as intended.

## Lessons Learned

1. **Source Control API is for physical input switching**, not software configuration changes
2. **HQPlayer's restart-on-profile-load** makes it incompatible with Roon's expectation of instant switching
3. **Network latency (WiFi vs Ethernet)** adds unpredictable delays that are hard to accommodate
4. **Roon's auto-restore behavior** (`convenience_switch`) assumes sources are inputs, not configurations
5. **When workarounds accumulate**, it's a sign the fundamental approach is wrong

## Alternative Approaches (Not Implemented)

1. **Settings-based switching**: Keep profile selection in extension settings only (current approach after removal)
2. **Request Roon API enhancement**: A "configuration" or "preset" API distinct from Source Control
3. **External UI**: A separate web UI or mobile app for profile switching
4. **HQPlayer API improvement**: Request HQPlayer add a "hot reload" that doesn't restart the service

## Files Changed (Now Reverted)

- `extension/index.js`: Added ~400 lines of source control handling
- `package.json`: Added `node-roon-api-source-control` and `node-roon-api-transport` dependencies

## Related

- GitHub Issue #3: "Playback to HQPlayer fails when Source Control profiles are enabled"
- Branch: `fix/source-control-playback-failure`
