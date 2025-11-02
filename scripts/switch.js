#!/usr/bin/env node

const { HQPClient } = require("../extension/lib/hqp-client");

function parseArgs(argv) {
  const options = {
    profile: null,
    host: process.env.HQP_HOST || "",
    port: process.env.HQP_PORT ? Number(process.env.HQP_PORT) : 8088,
    username: process.env.HQP_USER || "",
    password: process.env.HQP_PASS || "",
    list: false,
  };

  argv.forEach((arg) => {
    if (arg.startsWith("--host=")) {
      options.host = arg.slice(7);
    } else if (arg.startsWith("--port=")) {
      options.port = Number(arg.slice(7));
    } else if (arg.startsWith("--user=")) {
      options.username = arg.slice(7);
    } else if (arg.startsWith("--pass=")) {
      options.password = arg.slice(7);
    } else if (arg === "--list") {
      options.list = true;
    } else if (options.profile === null) {
      options.profile = arg;
    }
  });

  return options;
}

function normalizeProfileValue(value) {
  if (value === null || value === undefined) return null;
  return String(value).trim();
}

async function main() {
  const args = process.argv.slice(2);
  const options = parseArgs(args);

  if (!options.host || !options.username || !options.password) {
    console.error(
      "Missing connection details. Provide host, username, and password via arguments or HQP_HOST/HQP_USER/HQP_PASS."
    );
    process.exit(1);
  }

  const client = new HQPClient({
    host: options.host,
    port: options.port,
    username: options.username,
    password: options.password,
  });

  const profiles = await client.fetchProfiles();

  if (options.list) {
    console.log("Available profiles:");
    profiles.forEach((entry) => {
      const label = entry.title || entry.value || "[default]";
      const value = entry.value === "" ? "(default)" : entry.value;
      console.log(`- ${label} ${entry.value === "" ? "" : `(${value})`}`.trim());
    });
    return;
  }

  const desiredProfile = normalizeProfileValue(options.profile);

  let targetProfile = null;
  if (desiredProfile) {
    targetProfile = profiles.find((entry) => {
      const valueMatch =
        entry.value !== undefined &&
        entry.value !== null &&
        entry.value.toLowerCase() === desiredProfile.toLowerCase();
      const titleMatch =
        entry.title &&
        entry.title.toLowerCase() === desiredProfile.toLowerCase();
      return valueMatch || titleMatch;
    });
  }

  if (!targetProfile) {
    // Default to SDA if available, otherwise use first option.
    const sda = profiles.find(
      (entry) =>
        entry.value && entry.value.toLowerCase() === "sda"
    );
    targetProfile = sda || profiles[0];
  }

  if (!targetProfile) {
    throw new Error("No profiles are available to load.");
  }

  await client.loadProfile(targetProfile.value);

  const label = targetProfile.title || targetProfile.value || "[default]";
  console.log(`Profile "${label}" loaded.`);
}

main().catch((error) => {
  console.error("Failed to switch profile:", error.message || error);
  process.exit(1);
});
