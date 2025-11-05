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
  const trimmed = String(value).trim();
  return trimmed.length ? trimmed : null;
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
  const usableProfiles = profiles.filter((entry) => {
    const value = normalizeProfileValue(entry.value);
    if (!value) return false;
    return value.toLowerCase() !== "default";
  });

  if (options.list) {
    console.log("Available profiles:");
    if (!usableProfiles.length) {
      console.log("(none)");
      return;
    }
    usableProfiles.forEach((entry) => {
      const value = normalizeProfileValue(entry.value);
      const label = entry.title || value || "Unnamed profile";
      console.log(`- ${label}${value ? ` (${value})` : ""}`);
    });
    return;
  }

  const desiredProfile = normalizeProfileValue(options.profile);

  let targetProfile = null;
  if (desiredProfile) {
    targetProfile = usableProfiles.find((entry) => {
      const value = normalizeProfileValue(entry.value);
      const title = entry.title ? entry.title.trim().toLowerCase() : null;
      const lowered = desiredProfile.toLowerCase();
      const valueMatch = value && value.toLowerCase() === lowered;
      const titleMatch = title && title === lowered;
      return valueMatch || titleMatch;
    });
  }

  if (!targetProfile) {
    const sda = usableProfiles.find((entry) => {
      const value = normalizeProfileValue(entry.value);
      return value && value.toLowerCase() === "sda";
    });
    targetProfile = sda || usableProfiles[0];
  }

  if (!targetProfile) {
    throw new Error("No profiles are available to load.");
  }

  await client.loadProfile(targetProfile.value);

  const label = targetProfile.title || targetProfile.value || "Unnamed profile";
  console.log(`Profile "${label}" loaded.`);
}

main().catch((error) => {
  console.error("Failed to switch profile:", error.message || error);
  process.exit(1);
});
