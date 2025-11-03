const fs = require("fs");
const path = require("path");
const http = require("http");

const TEMPLATE_PATH = path.join(__dirname, "template.html");
const APP_JS_PATH = path.join(__dirname, "assets", "app.js");

const templateHtml = fs.readFileSync(TEMPLATE_PATH, "utf8");
const appJs = fs.readFileSync(APP_JS_PATH, "utf8");

function startUiServer(options) {
  const {
    uiPort,
    roonPort,
    getStatus,
    getConfig,
    hasCredentials,
    listProfiles,
    refreshProfiles,
    loadProfile,
    formatError,
    missingCredentialsMessage,
    isExpectingRestart = () => false,
  } = options;

  const credentialsMessage =
    missingCredentialsMessage ||
    "Awaiting HQPlayer credentials. Enter host, username, and password, then press Save to connect.";

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const pathname = (url.pathname || "/").replace(/\/+$/, "") || "/";

    try {
      if (req.method === "GET" && (pathname === "/" || pathname === "/ui")) {
        return sendHtml(res, renderTemplate(uiPort, roonPort));
      }

      if (req.method === "GET" && pathname === "/assets/app.js") {
        return sendJavaScript(res, appJs);
      }

      if (req.method === "GET" && pathname === "/api/status") {
        return handleStatus(res, getStatus, getConfig, listProfiles, uiPort, roonPort);
      }

      if (req.method === "GET" && pathname === "/api/profiles") {
        return handleProfiles(res, hasCredentials, refreshProfiles, formatError, credentialsMessage, isExpectingRestart, listProfiles);
      }

      if (req.method === "POST" && pathname === "/api/load") {
        return handleLoad(req, res, {
          hasCredentials,
          loadProfile,
          refreshProfiles,
          formatError,
          credentialsMessage,
          isExpectingRestart,
        });
      }

      if (req.method === "GET" && pathname === "/favicon.ico") {
        res.writeHead(204).end();
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain" }).end("Not Found\n");
    } catch (error) {
      console.error("[HQP] UI request error:", error);
      sendJson(res, 500, { error: "Internal server error" });
    }
  });

  server
    .listen(uiPort, () => {
      console.log(
        `[HQP] Web UI listening at http://<host>:${uiPort}/ui (Roon port ${roonPort})`
      );
    })
    .on("error", (error) => {
      console.error(`[HQP] Failed to start web UI on port ${uiPort}:`, error.message);
    });

  return server;
}

function renderTemplate(uiPort, roonPort) {
  return templateHtml
    .replace(/{{UI_PORT}}/g, String(uiPort))
    .replace(/{{ROON_PORT}}/g, String(roonPort));
}

function sendHtml(res, html) {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(html),
  });
  res.end(html);
}

function sendJavaScript(res, js) {
  res.writeHead(200, {
    "Content-Type": "application/javascript; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(js),
  });
  res.end(js);
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  return JSON.parse(text);
}

function handleStatus(res, getStatus, getConfig, listProfiles, uiPort, roonPort) {
  const status = getStatus ? getStatus() : { message: "Unknown", isError: false };
  const config = getConfig ? getConfig() : {};
  const profiles = listProfiles ? listProfiles() : [];
  sendJson(res, 200, {
    status,
    config,
    profiles,
    ui_port: uiPort,
    roon_port: roonPort,
  });
}

async function handleProfiles(
  res,
  hasCredentials,
  refreshProfiles,
  formatError,
  credentialsMessage,
  isExpectingRestart,
  listProfiles
) {
  if (hasCredentials && !hasCredentials()) {
    sendJson(res, 400, { error: credentialsMessage });
    return;
  }

  try {
    const profiles = refreshProfiles ? await refreshProfiles() : [];
    sendJson(res, 200, { profiles });
  } catch (error) {
    if (isExpectingRestart && isExpectingRestart()) {
      const cached = listProfiles ? listProfiles() : [];
      sendJson(res, 200, { profiles: cached, restarting: true });
      return;
    }
    const message = formatError ? formatError(error) : error.message;
    sendJson(res, 502, { error: message });
  }
}

async function handleLoad(req, res, options) {
  const { hasCredentials, loadProfile, refreshProfiles, formatError, credentialsMessage, isExpectingRestart } = options;

  if (hasCredentials && !hasCredentials()) {
    sendJson(res, 400, { error: credentialsMessage });
    return;
  }

  let profileInput = null;
  try {
    const body = await readJsonBody(req);
    let rawInput = body.profile;
    if (rawInput === undefined || rawInput === null) {
      rawInput = body.value;
    }
    if (rawInput === undefined || rawInput === null) {
      rawInput = body.target;
    }
    profileInput = rawInput === undefined || rawInput === null ? null : String(rawInput);
  } catch (error) {
    sendJson(res, 400, { error: "Invalid JSON payload" });
    return;
  }

  if (!profileInput) {
    sendJson(res, 400, { error: "Profile value required." });
    return;
  }

  try {
    if (refreshProfiles && (!isExpectingRestart || !isExpectingRestart())) {
      await refreshProfiles();
    }
    if (!loadProfile) {
      throw new Error("Profile loading not supported");
    }
    const profile = await loadProfile(profileInput);
    sendJson(res, 200, { ok: true, profile });
  } catch (error) {
    const statusCode = error && error.code === "MISSING_CREDENTIALS" ? 400 : 502;
    let message = error && error.message ? error.message : "Request failed.";
    if (formatError) {
      message = formatError(error);
    }
    if (statusCode === 400 && message === error.message) {
      message = credentialsMessage;
    }
    sendJson(res, statusCode, { error: message });
  }
}

module.exports = { startUiServer };
