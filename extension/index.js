#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const RoonApi = require("node-roon-api");
const RoonApiSettings = require("node-roon-api-settings");
const RoonApiStatus = require("node-roon-api-status");
const RoonApiSourceControl = require("node-roon-api-source-control");
const { startUiServer } = require("./ui/server");
const { HQPClient } = require("./lib/hqp-client");

const STORE_PATH = path.join(__dirname, "data", "settings.json");
const DEFAULT_CONFIG = {
  host: "",
  port: 8088,
  username: "",
  password: "",
  profile: "",
};
const MISSING_CREDENTIALS_MESSAGE =
  "Awaiting HQPlayer credentials. Enter host, username, and password, then press Save to connect.";
const EXTENSION_PORT = Number(process.env.ROON_EXTENSION_PORT || 9330);
const UI_PORT = Number(
  process.env.HQP_UI_PORT || (EXTENSION_PORT === 9330 ? 9331 : EXTENSION_PORT + 1)
);
const PROFILE_RESTART_GRACE_MS = Number(process.env.HQP_RESTART_GRACE_MS || 10000);

let availableProfiles = [];
let config = loadConfig();
let expectedRestartUntil = 0;
let core = null;
let svc_source_control = null;
const sourceControlDevices = new Map();
let currentProfileValue = stringValue(config.profile);

function timestamp() {
  return new Date().toISOString();
}

function logSourceControl(message, ...args) {
  console.log(`[${timestamp()}][HQP][SC] ${message}`, ...args);
}

const roon = new RoonApi({
  extension_id: "muness.hqp.profile.switcher",
  display_name: "HQP Profile Switcher",
  display_version: "1.1.0",
  publisher: "Unofficial HQPlayer Tools",
  email: "support@example.com",
  website: "https://github.com/muness/roon-extension-hqp-profile-switcher",
  core_found: handleCoreFound,
  core_lost: handleCoreLost,
});

// The Node Roon API listens on TCP 9330 by default; expose it explicitly so compose/packaging stays in sync.
roon.service_port = EXTENSION_PORT;

const svc_status = new RoonApiStatus(roon);
let lastStatus = { message: "Starting...", isError: false };

function isRestartGraceActive() {
  return expectedRestartUntil && Date.now() < expectedRestartUntil;
}

function isConnectivityErrorMessage(message) {
  if (!message) return false;
  const lowered = String(message).toLowerCase();
  return (
    lowered.indexOf("cannot reach hqplayer") !== -1 ||
    lowered.indexOf("unable to load hqplayer") !== -1 ||
    lowered.indexOf("failed to load profile on hqplayer") !== -1 ||
    lowered.indexOf("unable to resolve host") !== -1 ||
    lowered.indexOf("dns lookup failed") !== -1
  );
}

function normalizeStatus(message, isError) {
  if (isError && isRestartGraceActive() && isConnectivityErrorMessage(message)) {
    return {
      message: "Waiting for HQPlayer to restart after profile change...",
      isError: false,
    };
  }
  return { message, isError };
}

function updateStatus(message, isError) {
  const adjusted = normalizeStatus(message, isError);
  lastStatus = adjusted;
  svc_status.set_status(adjusted.message, adjusted.isError);
}

updateStatus("Starting...", false);
const svc_settings = new RoonApiSettings(roon, {
  get_settings(cb) {
    cb(buildSettingsState());
  },
  async save_settings(req, isDryRun, newSettings) {
    const incomingRaw = newSettings.values || {};
    const normalized = normalizeSettings({ ...config, ...incomingRaw });

    if (isDryRun) {
      req.send_complete("Success", {
        settings: buildSettingsState(normalized),
      });
      return;
    }

    config = normalized;
    currentProfileValue = stringValue(config.profile);

    if (!hasRequiredCredentials(config)) {
      availableProfiles = [];
      updateStatus(MISSING_CREDENTIALS_MESSAGE, false);
      initializeSourceControl();
      req.send_complete("Success", { settings: buildSettingsState() });
      return;
    }

    updateStatus("Connecting to HQPlayer...", false);

    try {
      const { candidate, selectedProfile } = await testConnection(config, {
        loadProfile: true,
      });
      config = candidate;
      currentProfileValue = stringValue(config.profile);
      saveConfig(config);
      initializeSourceControl();

      const message = selectedProfile
        ? `Loaded profile ${selectedProfile.title || selectedProfile.value || "Unnamed profile"}`
        : "Connected to HQPlayer. Profiles refreshed.";
      updateStatus(message, false);
      req.send_complete("Success", { settings: buildSettingsState() });
      svc_settings.update_settings(buildSettingsState());
    } catch (error) {
      const message = friendlyErrorMessage(error, (error && error.candidate) || config);
      const isMissing = message === MISSING_CREDENTIALS_MESSAGE;
      const display = isMissing ? message : `[ERROR] ${message}`;
      updateStatus(display, !isMissing);
      req.send_complete("Success", { settings: buildSettingsState() });
      svc_settings.update_settings(buildSettingsState());
      currentProfileValue = stringValue(config.profile);
      initializeSourceControl();
    }
  },
});

svc_source_control = new RoonApiSourceControl(roon);

roon.init_services({
  provided_services: [svc_settings, svc_status, svc_source_control],
});
initializeSourceControl();

async function startup() {
  if (!hasRequiredCredentials(config)) {
    availableProfiles = [];
    updateStatus(MISSING_CREDENTIALS_MESSAGE, false);
    currentProfileValue = "";
    initializeSourceControl();
    console.log(`[${timestamp()}][HQP][SC] Starting discovery on port ${EXTENSION_PORT}`);
    roon.start_discovery();
    return;
  }

  try {
    const { candidate } = await testConnection(config, { loadProfile: false });
    config = candidate;
    currentProfileValue = stringValue(config.profile);
    saveConfig(config);
    updateStatus("Ready.", false);
  } catch (error) {
    const message = friendlyErrorMessage(error, (error && error.candidate) || config);
    const isMissing = message === MISSING_CREDENTIALS_MESSAGE;
    const display = isMissing ? message : `[ERROR] ${message}`;
    updateStatus(display, !isMissing);
    currentProfileValue = stringValue(config.profile);
  } finally {
    initializeSourceControl();
    console.log(`[${timestamp()}][HQP][SC] Starting discovery on port ${EXTENSION_PORT}`);
    roon.start_discovery();
  }
}

startup();

function initSignalHandlers() {
  const handle = () => {
    process.exit(0);
  };

  process.on("SIGTERM", handle);
  process.on("SIGINT", handle);
}

initSignalHandlers();

function loadConfig() {
  try {
    const raw = fs.readFileSync(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return normalizeSettings({ ...DEFAULT_CONFIG, ...parsed });
  } catch (error) {
    return normalizeSettings({ ...DEFAULT_CONFIG });
  }
}

function saveConfig(data) {
  const folder = path.dirname(STORE_PATH);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2), "utf8");
}

function buildLayout(values) {
  return [
    {
      type: "group",
      title: "HQPlayer Connection",
      items: [
        { type: "string", title: "Host", setting: "host" },
        { type: "integer", title: "Port", setting: "port", min: 1, max: 65535 },
        { type: "string", title: "Username", setting: "username" },
        { type: "string", title: "Password", setting: "password" },
      ],
    },
    {
      type: "group",
      title: "Profile Selection",
      items: [
        {
          type: "dropdown",
          title: "Profile",
          values: buildProfileOptions(),
          setting: "profile",
        },
      ],
    },
  ];
}

function buildProfileOptions() {
  if (availableProfiles.length > 0) {
    return availableProfiles.map((entry) => ({
      title: entry.title || entry.value || "Unnamed profile",
      value: stringValue(entry.value),
    }));
  }

  return [
    {
      title: hasRequiredCredentials(config)
        ? "No profiles available"
        : "Save connection settings to load profiles",
      value: "",
    },
  ];
}

function buildSettingsState(overrides) {
  const values = overrides
    ? normalizeSettings({ ...config, ...overrides })
    : { ...config };

  return {
    values,
    layout: buildLayout(values),
    has_changed: false,
  };
}

function findProfile(profiles, value) {
  if (!profiles || !profiles.length) return null;
  if (value === null || value === undefined) return null;

  const target = String(value).trim();
  if (!target.length) {
    return (
      profiles.find((entry) => entry.value === "") ||
      profiles.find((entry) => !entry.value)
    );
  }

  const lowered = target.toLowerCase();
  return (
    profiles.find(
      (entry) =>
        (entry.value && entry.value.toLowerCase() === lowered) ||
        (entry.title && entry.title.toLowerCase() === lowered)
    ) || null
  );
}

async function testConnection(baseConfig, { loadProfile }) {
  const candidate = normalizeSettings(baseConfig || {});

  if (!hasRequiredCredentials(candidate)) {
    availableProfiles = [];
    const error = new Error(MISSING_CREDENTIALS_MESSAGE);
    error.candidate = candidate;
    throw error;
  }

  try {
    const client = new HQPClient({
      host: candidate.host,
      port: candidate.port,
      username: candidate.username,
      password: candidate.password,
    });

    const profiles = await client.fetchProfiles();
    availableProfiles = profiles;
    expectedRestartUntil = 0;

    let selectedProfile = findProfile(profiles, candidate.profile);
    if (!selectedProfile) {
      selectedProfile =
        profiles.find(
          (entry) =>
            entry.value && entry.value.toLowerCase() === "sda"
        ) || profiles[0] || null;
    }

    candidate.profile = selectedProfile ? selectedProfile.value || "" : "";
    if (loadProfile && selectedProfile) {
      await client.loadProfile(candidate.profile);
      expectedRestartUntil = Date.now() + PROFILE_RESTART_GRACE_MS;
      recordSourceControlProfileChange(selectedProfile, "selected", { persist: false });
    }

    return { candidate, selectedProfile };
  } catch (error) {
    availableProfiles = [];
    error.candidate = candidate;
    throw error;
  }
}

function normalizeSettings(values = {}) {
  const profileValue = stringValue(values.profile);
  const normalizedProfile = slugifyControlKey(profileValue) === "default" ? "" : profileValue;

  return {
    host: stringValue(values.host),
    port: normalizePort(values.port),
    username: stringValue(values.username),
    password: stringValue(values.password),
    profile: normalizedProfile,
  };
}

function stringValue(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value.trim();
  return String(value).trim();
}

function normalizePort(value) {
  const num = Number(value);
  if (Number.isFinite(num) && num > 0) {
    return Math.round(num);
  }
  return DEFAULT_CONFIG.port;
}

function hasRequiredCredentials(cfg) {
  return Boolean(cfg.host && cfg.username && cfg.password);
}

function slugifyControlKey(raw) {
  const text = stringValue(raw).toLowerCase();
  if (!text) return "";

  const slug = text
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .replace(/-{2,}/g, "-");

  return slug || "";
}

function publicConfig() {
  return {
    host: config.host,
    port: config.port,
    username: config.username,
    profile: config.profile,
  };
}

function initializeSourceControl() {
  if (!svc_source_control || !core) {
    logSourceControl("Skipping init (service=%s core=%s)", !!svc_source_control, !!core);
    return;
  }

  ensureProfileControls();
  updateSourceControlSelections();
}

function clearSourceControlDevices() {
  for (const [key, entry] of sourceControlDevices.entries()) {
    try {
      entry.device.destroy();
    } catch (error) {
      console.error(
        `[HQP] Failed to remove source control '${entry && entry.value ? entry.value : key}':`,
        error && error.message ? error.message : error
      );
    }
  }
  sourceControlDevices.clear();
  logSourceControl("Cleared all source control devices");
}

function ensureProfileControls() {
  if (!svc_source_control || !core) {
    return;
  }

  if (!hasRequiredCredentials(config)) {
    logSourceControl("No credentials; clearing devices");
    clearSourceControlDevices();
    return;
  }

  const desired = new Map();
  const profilesForControls = listProfilesForControls();

  profilesForControls.forEach((profile) => {
    const key = profileValueKey(profile);
    if (desired.has(key)) {
      logSourceControl(
        "Duplicate profile entry collapsed for key=%s (existing display=%s new display=%s)",
        key,
        profileDisplayTitle(desired.get(key)),
        profileDisplayTitle(profile)
      );
    }
    desired.set(key, profile);
  });

  for (const existing of Array.from(sourceControlDevices.keys())) {
    if (!desired.has(existing)) {
      destroySourceControlDevice(existing);
    }
  }

  for (const [key, profile] of desired.entries()) {
    const value = profileValueRaw(profile);
    const state = buildControlState(profile, value);
    const entry = sourceControlDevices.get(key);

    if (entry) {
      const updatedState = updateDeviceStateByKey(key, {}, { profile, value });
      if (updatedState) {
        logSourceControl("Updated device key=%s status=%s", updatedState.control_key, updatedState.status);
      }
    } else {
      const device = svc_source_control.new_device({
        state,
        convenience_switch: (req) => handleProfileConvenienceSwitch(req, value),
        standby: (req) => handleProfileStandby(req, value),
      });
      device.update_state(state);
      sourceControlDevices.set(key, { profile, value, device });
      logSourceControl("Created device key=%s name=%s", state.control_key, state.display_name);
    }
  }

  logSourceControl("Active devices=%d", sourceControlDevices.size);
}

function destroySourceControlDevice(key) {
  const entry = sourceControlDevices.get(key);
  if (!entry) return;
  try {
    entry.device.destroy();
  } catch (error) {
    console.error(
      `[HQP] Failed to remove source control '${entry && entry.value ? entry.value : key}':`,
      error && error.message ? error.message : error
    );
  }
  sourceControlDevices.delete(key);
  const destroyedLabel = entry && entry.value ? entry.value : "<none>";
  logSourceControl("Destroyed device for value=%s key=%s", destroyedLabel, key);
}

function profileDisplayTitle(profile) {
  if (!profile) return "Unnamed profile";
  const label = profile.title || profile.value;
  return label ? String(label) : "Unnamed profile";
}

function profileValueRaw(profile) {
  if (!profile) return "";
  if (profile.value === undefined || profile.value === null) return "";
  return stringValue(profile.value);
}

function profileValueKeyFromValue(value) {
  const normalized = stringValue(value);
  if (!normalized) return "__default__";
  return normalized.toLowerCase();
}

function profileValueKey(profile) {
  if (!profile) return "__default__";
  return profileValueKeyFromValue(profile.value);
}

function profileHasValue(profile) {
  if (!profile) return false;
  const value = profile.value !== undefined && profile.value !== null ? stringValue(profile.value) : "";
  if (!value.length) return false;
  const slug = slugifyControlKey(value);
  if (!slug.length) return false;
  return slug !== "default";
}

function normalizeRequestedStatus(input) {
  if (input === undefined || input === null) return null;
  if (typeof input === "boolean") {
    return input ? "selected" : "deselected";
  }
  if (typeof input === "number") {
    return input === 0 ? "deselected" : "selected";
  }
  const text = String(input).trim().toLowerCase();
  if (!text) return null;
  if (text === "selected" || text === "deselected" || text === "indeterminate") return text;
  if (text === "on" || text === "active" || text === "activated" || text === "power_on") return "selected";
  if (text === "off" || text === "inactive" || text === "power_off" || text === "standby") return "deselected";
  return null;
}

function requestedStatusFromBody(body, fallback) {
  if (!body || typeof body !== "object") return fallback;
  const candidates = ["status", "state", "target_status", "desired_status", "power"];
  for (const key of candidates) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      const normalized = normalizeRequestedStatus(body[key]);
      if (normalized) return normalized;
    }
  }
  return fallback;
}

function resolveRequestedStatus(req, fallback) {
  return requestedStatusFromBody(req && req.body ? req.body : null, fallback);
}

function resolveProfileForValue(value) {
  const normalized = stringValue(value);
  const match = findProfile(availableProfiles, normalized);
  if (match) {
    return match;
  }

  return {
    value: normalized,
    title: normalized ? normalized : "Unnamed profile",
  };
}

function lookupProfileForValue(value) {
  const normalized = stringValue(value);
  return findProfile(availableProfiles, normalized) || resolveProfileForValue(normalized);
}

function updateDeviceStateByKey(key, overrides = {}, options = {}) {
  const entry = sourceControlDevices.get(key);
  if (!entry) return null;

  const baseValue =
    options.value !== undefined
      ? stringValue(options.value)
      : entry.value !== undefined
        ? stringValue(entry.value)
        : profileValueRaw(entry.profile);
  const profile = options.profile || entry.profile || resolveProfileForValue(baseValue);

  entry.profile = profile;
  entry.value = baseValue;

  const baseState = buildControlState(profile, baseValue);
  const nextState = { ...baseState, ...overrides };
  entry.device.update_state(nextState);
  return nextState;
}

function controlKeyForProfile(value) {
  const suffix = slugifyControlKey(value);
  const finalSuffix = suffix || "default";
  return `hqp-${finalSuffix}`;
}

function buildControlState(profile, value) {
  const normalizedValue = stringValue(value);
  return {
    control_key: controlKeyForProfile(normalizedValue),
    display_name: profileDisplayTitle(profile),
    supports_standby: true,
    status: determineControlStatus(normalizedValue),
  };
}

function determineControlStatus(value) {
  if (!hasRequiredCredentials(config)) {
    return "indeterminate";
  }
  return value === currentProfileValue ? "selected" : "deselected";
}

function listProfilesForControls() {
  if (availableProfiles.length > 0) {
    return availableProfiles.slice();
  }

  return [];
}

function updateSourceControlSelections() {
  for (const key of sourceControlDevices.keys()) {
    updateDeviceStateByKey(key);
  }
}

async function processProfileSelection(req, profileValue) {
  if (!hasRequiredCredentials(config)) {
    req.send_complete("Failed", { error: MISSING_CREDENTIALS_MESSAGE });
    return;
  }

  const value = stringValue(profileValue);
  const profile = lookupProfileForValue(value);
  if (!profileHasValue(profile)) {
    logSourceControl("Rejected convenience switch for missing profile identifier (value=%s)", value || "<none>");
    req.send_complete("Failed", { error: "Profile identifier is required." });
    return;
  }
  const label = profileDisplayTitle(profile);
  const originLabel = `source control (${label})`;

  logSourceControl("Convenience switch requested for value=%s label=%s", value || "<none>", label);

  const previousValue = currentProfileValue;
  currentProfileValue = value;
  updateSourceControlSelections();

  try {
    await loadProfileByValue(value, originLabel, {
      sourceStatus: "selected",
    });
    req.send_complete("Success");
  } catch (error) {
    currentProfileValue = previousValue;
    updateSourceControlSelections();
    const message = friendlyErrorMessage(error, (error && error.candidate) || config);
    logSourceControl(
      "Convenience switch failed for value=%s label=%s error=%s",
      value || "<none>",
      label,
      message
    );
    req.send_complete("Failed", { error: message });
  }
}

async function handleProfileConvenienceSwitch(req, profileValue) {
  await processProfileSelection(req, profileValue);
}

function handleProfileStandby(req, profileValue) {
  const requestedStatus = resolveRequestedStatus(req, "selected");
  const value = stringValue(profileValue);
  logSourceControl("Standby requested for value=%s status=%s", value || "<none>", requestedStatus);

  if (requestedStatus === "selected") {
    return processProfileSelection(req, profileValue);
  }

  const key = profileValueKeyFromValue(value);
  const wasActive = profileValueKeyFromValue(currentProfileValue) === key;
  if (wasActive) {
    currentProfileValue = "";
  }

  const nextStatus = requestedStatus === "indeterminate" ? "indeterminate" : "deselected";
  const updated = updateDeviceStateByKey(key, { status: nextStatus }, { value });
  if (updated) {
    logSourceControl("Standby update -> key=%s status=%s", updated.control_key, updated.status);
  }

  if (wasActive) {
    updateSourceControlSelections();
  }

  req.send_complete("Success");
  return;
}

function recordSourceControlProfileChange(profile, status, options = {}) {
  ensureProfileControls();
  const value = profileValueRaw(profile);
  const key = profileValueKey(profile);
  currentProfileValue = value;

  const shouldPersist = options && options.persist === false ? false : true;
  if (shouldPersist && config.profile !== value) {
    config.profile = value;
    try {
      saveConfig(config);
    } catch (error) {
      console.error("[HQP] Failed to persist profile selection:", error.message);
    }
  }

  const nextStatus = status || (value ? "selected" : "deselected");
  updateSourceControlSelections();

  const updated = updateDeviceStateByKey(key, { status: nextStatus }, { profile, value });
  if (updated) {
    logSourceControl("Profile change -> key=%s status=%s", updated.control_key, updated.status);
  }
}

function handleCoreFound(foundCore) {
  core = foundCore;
  logSourceControl("Core found: %s", core && core.core_id);
  initializeSourceControl();
}

function handleCoreLost(lostCore) {
  if (core && lostCore && core.core_id !== lostCore.core_id) {
    return;
  }
  logSourceControl("Core lost");
  core = null;
  clearSourceControlDevices();
}

async function refreshProfiles() {
  const { candidate } = await testConnection(config, { loadProfile: false });
  config = candidate;
  currentProfileValue = stringValue(config.profile);
  initializeSourceControl();
  return availableProfiles;
}


async function loadProfileByValue(profileInput, originLabel, options = {}) {
  if (!hasRequiredCredentials(config)) {
    const error = new Error(MISSING_CREDENTIALS_MESSAGE);
    error.code = "MISSING_CREDENTIALS";
    throw error;
  }

  const labelSource = originLabel || "external caller";
  const requestedStatus =
    options && typeof options.sourceStatus === "string"
      ? options.sourceStatus
      : "selected";
  const desiredStatus =
    requestedStatus === "deselected"
      ? "deselected"
      : requestedStatus === "indeterminate"
        ? "indeterminate"
        : "selected";
  const normalized =
    profileInput === undefined || profileInput === null
      ? ""
      : String(profileInput).trim();

  const profiles =
    availableProfiles.length > 0 ? availableProfiles : await refreshProfiles();

  const target = findProfile(profiles, normalized);

  if (!target) {
    const error = new Error(`Profile '${normalized}' not found.`);
    error.code = "NOT_FOUND";
    throw error;
  }
  if (!profileHasValue(target)) {
    const error = new Error("Profile is missing an identifier.");
    error.code = "INVALID";
    throw error;
  }

  const client = new HQPClient({
    host: config.host,
    port: config.port,
    username: config.username,
    password: config.password,
  });

  await client.loadProfile(target.value);

  const label = target.title || target.value || "Unnamed profile";
  updateStatus(`Loaded profile ${label} via ${labelSource}.`, false);
  expectedRestartUntil = Date.now() + PROFILE_RESTART_GRACE_MS;
  recordSourceControlProfileChange(target, desiredStatus);

  return target;
}


function friendlyErrorMessage(error, candidate) {
  const cfg = normalizeSettings(candidate || config || {});

  if (!hasRequiredCredentials(cfg)) {
    return MISSING_CREDENTIALS_MESSAGE;
  }

  if (error && typeof error === "object") {
    if (error.code === "ECONNREFUSED") {
      return `Cannot reach HQPlayer at ${cfg.host}:${cfg.port}.`;
    }
    if (error.code === "ENOTFOUND") {
      return `Unable to resolve host ${cfg.host}.`;
    }
    if (error.code === "EAI_AGAIN") {
      return `DNS lookup failed for ${cfg.host}.`;
    }
  }

  const message =
    (error && typeof error.message === "string" && error.message) ||
    (error ? String(error) : "") ||
    "";
  const trimmedMessage = message.trim();

  if (/401/.test(trimmedMessage)) {
    return "Authentication failed. Verify HQPlayer username and password.";
  }
  if (/ECONNREFUSED/.test(trimmedMessage)) {
    return `Cannot reach HQPlayer at ${cfg.host}:${cfg.port}.`;
  }
  if (/ENOTFOUND/.test(trimmedMessage)) {
    return `Unable to resolve host ${cfg.host}.`;
  }
  if (/EAI_AGAIN/.test(trimmedMessage)) {
    return `DNS lookup failed for ${cfg.host}.`;
  }
  if (/Failed to load profile form/.test(trimmedMessage)) {
    return `Unable to load HQPlayer profile list from ${cfg.host}:${cfg.port}.`;
  }
  if (/Profile load request failed/.test(trimmedMessage)) {
    return `Failed to load profile on HQPlayer at ${cfg.host}:${cfg.port}.`;
  }
  if (/Host is required|Username is required|Password is required/.test(trimmedMessage)) {
    return MISSING_CREDENTIALS_MESSAGE;
  }

  if (trimmedMessage && trimmedMessage !== "[object Object]") {
    return trimmedMessage;
  }

  return "Unexpected error contacting HQPlayer.";
}

startUiServer({
  uiPort: UI_PORT,
  roonPort: EXTENSION_PORT,
  getStatus: () => lastStatus,
  getConfig: () => publicConfig(),
  hasCredentials: () => hasRequiredCredentials(config),
  listProfiles: () => availableProfiles.slice(),
  refreshProfiles: () => refreshProfiles(),
  loadProfile: (value) => loadProfileByValue(value, "web UI"),
  formatError: (error) => friendlyErrorMessage(error, (error && error.candidate) || config),
  missingCredentialsMessage: MISSING_CREDENTIALS_MESSAGE,
  isExpectingRestart: () => isRestartGraceActive(),
});
