#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const RoonApi = require("node-roon-api");
const RoonApiSettings = require("node-roon-api-settings");
const RoonApiStatus = require("node-roon-api-status");
const { HQPClient } = require("./lib/hqp-client");

const STORE_PATH = path.join(__dirname, "data", "settings.json");
const DEFAULT_CONFIG = {
  host: "192.168.1.61",
  port: 8088,
  username: "audiolinux",
  password: "audiolinux",
  profile: "",
};

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
    const incoming = newSettings.values || {};

    if (isDryRun) {
      req.send_complete("Success", { settings: buildSettingsState(incoming) });
      return;
    }

    svc_status.set_status("profile_switcher", false, "Updating HQPlayer profile...");

    const previousConfig = { ...config };
    try {
      const { candidate, selectedProfile } = await testConnection(incoming, {
        loadProfile: true,
      });
      config = candidate;
      saveConfig(config);

      const message = selectedProfile
        ? `Loaded profile ${selectedProfile.title || selectedProfile.value || "[default]"}`
        : "Updated HQPlayer connection.";
      svc_status.set_status("profile_switcher", false, message);
      req.send_complete("Success", { settings: buildSettingsState() });
    } catch (error) {
      config = previousConfig;
      const message = error.message || "Failed to update profile.";
      svc_status.set_status("profile_switcher", true, message);
      req.send_complete("Success", { settings: buildSettingsState() });
    }
  },
});

roon.init_services({
  provided_services: [svc_settings, svc_status],
});

async function startup() {
  try {
    const { candidate } = await testConnection({}, { loadProfile: false });
    config = candidate;
    saveConfig(config);
    svc_status.set_status("profile_switcher", false, "Ready.");
  } catch (error) {
    svc_status.set_status(
      "profile_switcher",
      true,
      error.message || "Unable to reach HQPlayer."
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
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch (error) {
    return { ...DEFAULT_CONFIG };
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
      : [{ title: "No profiles available", value: "" }];

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

function buildSettingsState(overrides = {}) {
  const values = {
    host: overrides.host ?? config.host ?? DEFAULT_CONFIG.host,
    port: Number(overrides.port ?? config.port ?? DEFAULT_CONFIG.port),
    username: overrides.username ?? config.username ?? DEFAULT_CONFIG.username,
    password: overrides.password ?? config.password ?? DEFAULT_CONFIG.password,
    profile: overrides.profile ?? config.profile ?? DEFAULT_CONFIG.profile,
  };

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

async function testConnection(overrides, { loadProfile }) {
  const candidate = {
    ...config,
    ...overrides,
  };

  candidate.port = Number(candidate.port) || DEFAULT_CONFIG.port;

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
}
