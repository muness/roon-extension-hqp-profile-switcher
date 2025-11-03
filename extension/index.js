#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const RoonApi = require("node-roon-api");
const RoonApiSettings = require("node-roon-api-settings");
const RoonApiStatus = require("node-roon-api-status");
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

let config = loadConfig();
let availableProfiles = [];
let expectedRestartUntil = 0;

const roon = new RoonApi({
  extension_id: "muness.hqp.profile.switcher",
  display_name: "HQPlayer Embedded Profile Switcher",
  display_version: "1.0.2",
  publisher: "Unofficial HQPlayer Tools",
  email: "support@example.com",
  website: "https://github.com/muness/roon-extension-hqp-profile-switcher",
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

    if (!hasRequiredCredentials(config)) {
      availableProfiles = [];
      updateStatus(MISSING_CREDENTIALS_MESSAGE, false);
      req.send_complete("Success", { settings: buildSettingsState() });
      return;
    }

    updateStatus("Connecting to HQPlayer...", false);

    try {
      const { candidate, selectedProfile } = await testConnection(config, {
        loadProfile: true,
      });
      config = candidate;
      saveConfig(config);

      const message = selectedProfile
        ? `Loaded profile ${selectedProfile.title || selectedProfile.value || "[default]"}`
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
    }
  },
});

roon.init_services({
  provided_services: [svc_settings, svc_status],
});

async function startup() {
  if (!hasRequiredCredentials(config)) {
    availableProfiles = [];
    updateStatus(MISSING_CREDENTIALS_MESSAGE, false);
    roon.start_discovery();
    return;
  }

  try {
    const { candidate } = await testConnection(config, { loadProfile: false });
    config = candidate;
    saveConfig(config);
    updateStatus("Ready.", false);
  } catch (error) {
    const message = friendlyErrorMessage(error, (error && error.candidate) || config);
    const isMissing = message === MISSING_CREDENTIALS_MESSAGE;
    const display = isMissing ? message : `[ERROR] ${message}`;
    updateStatus(display, !isMissing);
  } finally {
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

function buildLayout() {
  const profileOptions =
    availableProfiles.length > 0
      ? availableProfiles.map((entry) => ({
          title: entry.title || entry.value || "[default]",
          value:
            entry.value !== undefined && entry.value !== null
              ? entry.value
              : "",
        }))
      : [
          {
            title: hasRequiredCredentials(config)
              ? "No profiles available"
              : "Save connection settings to load profiles",
            value: "",
          },
        ];

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
          values: profileOptions,
          setting: "profile",
        },
      ],
    },
  ];
}

function buildSettingsState(overrides) {
  const values = overrides
    ? normalizeSettings({ ...config, ...overrides })
    : { ...config };

  return {
    values,
    layout: buildLayout(),
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
    }

    return { candidate, selectedProfile };
  } catch (error) {
    availableProfiles = [];
    error.candidate = candidate;
    throw error;
  }
}

function normalizeSettings(values = {}) {
  return {
    host: stringValue(values.host),
    port: normalizePort(values.port),
    username: stringValue(values.username),
    password: stringValue(values.password),
    profile: stringValue(values.profile),
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

function publicConfig() {
  return {
    host: config.host,
    port: config.port,
    username: config.username,
    profile: config.profile,
  };
}

async function refreshProfiles() {
  const { candidate } = await testConnection(config, { loadProfile: false });
  config = candidate;
  return availableProfiles;
}


async function loadProfileByValue(profileInput, originLabel) {
  if (!hasRequiredCredentials(config)) {
    const error = new Error(MISSING_CREDENTIALS_MESSAGE);
    error.code = "MISSING_CREDENTIALS";
    throw error;
  }

  const labelSource = originLabel || "external caller";
  const normalized =
    profileInput === undefined || profileInput === null
      ? ""
      : String(profileInput).trim();

  if (!normalized) {
    const error = new Error("Profile value required.");
    error.code = "INPUT";
    throw error;
  }

  const profiles =
    availableProfiles.length > 0 ? availableProfiles : await refreshProfiles();

  const target = findProfile(profiles, normalized);

  if (!target) {
    const error = new Error(`Profile '${normalized}' not found.`);
    error.code = "NOT_FOUND";
    throw error;
  }

  const client = new HQPClient({
    host: config.host,
    port: config.port,
    username: config.username,
    password: config.password,
  });

  await client.loadProfile(target.value);

  const label = target.title || target.value || "[default]";
  updateStatus(`Loaded profile ${label} via ${labelSource}.`, false);
  expectedRestartUntil = Date.now() + PROFILE_RESTART_GRACE_MS;

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
