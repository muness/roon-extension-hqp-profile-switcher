#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const RoonApi = require("node-roon-api");
const RoonApiSettings = require("node-roon-api-settings");
const RoonApiStatus = require("node-roon-api-status");
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
  "Enter HQPlayer host, username, and password in settings, then press Save.";

let config = loadConfig();
let availableProfiles = [];

const roon = new RoonApi({
  extension_id: "muness.hqp.profile.switcher",
  display_name: "HQPlayer Profile Switcher",
  display_version: "1.0.0",
  publisher: "muness",
  email: "support@example.com",
  website: "https://github.com/muness/hqp-profile-switcher",
});

const svc_status = new RoonApiStatus(roon);
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
      svc_status.set_status("profile_switcher", true, MISSING_CREDENTIALS_MESSAGE);
      req.send_complete("Success", { settings: buildSettingsState() });
      return;
    }

    svc_status.set_status("profile_switcher", false, "Connecting to HQPlayer...");

    try {
      const { candidate, selectedProfile } = await testConnection(config, {
        loadProfile: true,
      });
      config = candidate;
      saveConfig(config);

      const message = selectedProfile
        ? `Loaded profile ${selectedProfile.title || selectedProfile.value || "[default]"}`
        : "Connected to HQPlayer. Profiles refreshed.";
      svc_status.set_status("profile_switcher", false, message);
      req.send_complete("Success", { settings: buildSettingsState() });
    } catch (error) {
      const message = friendlyErrorMessage(error, error?.candidate || config);
      svc_status.set_status("profile_switcher", true, message);
      req.send_complete("Success", { settings: buildSettingsState() });
    }
  },
});

roon.init_services({
  provided_services: [svc_settings, svc_status],
});

async function startup() {
  if (!hasRequiredCredentials(config)) {
    availableProfiles = [];
    svc_status.set_status("profile_switcher", true, MISSING_CREDENTIALS_MESSAGE);
    roon.start_discovery();
    return;
  }

  try {
    const { candidate } = await testConnection(config, { loadProfile: false });
    config = candidate;
    saveConfig(config);
    svc_status.set_status("profile_switcher", false, "Ready.");
  } catch (error) {
    svc_status.set_status(
      "profile_switcher",
      true,
      friendlyErrorMessage(error, error?.candidate || config)
    );
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
