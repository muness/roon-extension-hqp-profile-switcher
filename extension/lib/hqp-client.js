const http = require("http");
const crypto = require("crypto");

const PROFILE_PATH = "/config/profile/load";

class HQPClient {
  constructor({ host, port = 8088, username, password } = {}) {
    if (!host) throw new Error("Host is required");
    if (!username) throw new Error("Username is required");
    if (!password) throw new Error("Password is required");
    this.host = host;
    this.port = Number(port) || 8088;
    this.username = username;
    this.password = password;
    this.cookies = {};
    this.digest = null;
    this.lastHiddenFields = {};
    this.lastProfiles = [];
  }

  baseHeaders() {
    return {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      Connection: "keep-alive",
      "User-Agent": "HQPClient/1.0 (Node.js)",
    };
  }

  serializeCookies() {
    const entries = Object.entries(this.cookies);
    if (!entries.length) return "";
    return entries.map(([name, value]) => `${name}=${value}`).join("; ");
  }

  collectCookies(headers) {
    const setCookie = headers["set-cookie"];
    if (!setCookie) return;
    setCookie.forEach((raw) => {
      const [cookie] = raw.split(";");
      const [name, value] = cookie.split("=");
      if (name && value !== undefined) {
        this.cookies[name.trim()] = value.trim();
      }
    });
  }

  parseDigest(header) {
    const challenge = header.replace(/^Digest\s+/i, "");
    const parts = {};
    challenge.split(/,\s*/).forEach((chunk) => {
      const eq = chunk.indexOf("=");
      if (eq === -1) return;
      const key = chunk.slice(0, eq).trim();
      let value = chunk.slice(eq + 1).trim();
      value = value.replace(/^"|"$/g, "");
      parts[key] = value;
    });
    this.digest = {
      realm: parts.realm || "",
      nonce: parts.nonce || "",
      qop: parts.qop || "",
      opaque: parts.opaque || "",
      algorithm: (parts.algorithm || "MD5").toUpperCase(),
      nc: 0,
    };
  }

  md5(value) {
    return crypto.createHash("md5").update(value).digest("hex");
  }

  buildDigestHeader(method, uri) {
    if (!this.digest || !this.digest.nonce) return "";

    const { realm, nonce, qop, opaque, algorithm } = this.digest;
    const username = this.username;
    const password = this.password;

    this.digest.nc += 1;
    const nc = this.digest.nc.toString(16).padStart(8, "0");
    const cnonce = crypto.randomBytes(8).toString("hex");

    let ha1;
    if (algorithm === "MD5-SESS") {
      const initial = this.md5(`${username}:${realm}:${password}`);
      ha1 = this.md5(`${initial}:${nonce}:${cnonce}`);
    } else {
      ha1 = this.md5(`${username}:${realm}:${password}`);
    }

    const ha2 = this.md5(`${method}:${uri}`);
    let response;

    if (qop) {
      const qopValue = qop.split(",")[0].trim();
      response = this.md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qopValue}:${ha2}`);
      return [
        `Digest username="${username}"`,
        `realm="${realm}"`,
        `nonce="${nonce}"`,
        `uri="${uri}"`,
        `algorithm=${algorithm}`,
        `response="${response}"`,
        `qop=${qopValue}`,
        `nc=${nc}`,
        `cnonce="${cnonce}"`,
        opaque ? `opaque="${opaque}"` : null,
      ]
        .filter(Boolean)
        .join(", ");
    }

    response = this.md5(`${ha1}:${nonce}:${ha2}`);
    return [
      `Digest username="${username}"`,
      `realm="${realm}"`,
      `nonce="${nonce}"`,
      `uri="${uri}"`,
      `algorithm=${algorithm}`,
      `response="${response}"`,
      opaque ? `opaque="${opaque}"` : null,
    ]
      .filter(Boolean)
      .join(", ");
  }

  makeRequest(path, { method = "GET", headers = {}, body } = {}) {
    const options = {
      hostname: this.host,
      port: this.port,
      path,
      method,
      headers,
    };

    return new Promise((resolve, reject) => {
      const req = http.request(options, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const buffer = Buffer.concat(chunks);
          resolve({
            statusCode: res.statusCode || 0,
            headers: res.headers,
            body: buffer.toString("utf8"),
          });
        });
      });

      req.on("error", reject);
      if (body) req.write(body);
      req.end();
    });
  }

  async request(path, { method = "GET", headers = {}, body } = {}) {
    const payload = body || null;
    let mergedHeaders = { ...this.baseHeaders(), ...headers };
    const cookieHeader = this.serializeCookies();
    if (cookieHeader) mergedHeaders.Cookie = cookieHeader;

    if (payload && !mergedHeaders["Content-Length"]) {
      mergedHeaders["Content-Length"] = Buffer.byteLength(payload);
    }

    if (this.digest && this.digest.nonce) {
      const authHeader = this.buildDigestHeader(method, path);
      if (authHeader) mergedHeaders.Authorization = authHeader;
    }

    let response = await this.makeRequest(path, { method, headers: mergedHeaders, body: payload });
    this.collectCookies(response.headers);

    if (response.statusCode === 401) {
      const authHeader = response.headers["www-authenticate"];
      if (authHeader && /digest/i.test(authHeader)) {
        this.parseDigest(authHeader);
        const retryHeaders = { ...headers };
        const cookies = this.serializeCookies();
        mergedHeaders = { ...this.baseHeaders(), ...retryHeaders };
        if (cookies) mergedHeaders.Cookie = cookies;
        const digestHeader = this.buildDigestHeader(method, path);
        if (digestHeader) mergedHeaders.Authorization = digestHeader;
        if (payload && !mergedHeaders["Content-Length"]) {
          mergedHeaders["Content-Length"] = Buffer.byteLength(payload);
        }
        response = await this.makeRequest(path, { method, headers: mergedHeaders, body: payload });
        this.collectCookies(response.headers);
      }
    }

    return response;
  }

  getAttribute(tag, attribute) {
    const regex = new RegExp(`${attribute}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
    const match = tag.match(regex);
    if (!match) return "";
    if (match[1] !== undefined && match[1] !== null && match[1] !== "") {
      return match[1];
    }
    if (match[2] !== undefined && match[2] !== null && match[2] !== "") {
      return match[2];
    }
    if (match[3] !== undefined && match[3] !== null && match[3] !== "") {
      return match[3];
    }
    return "";
  }

  parseHiddenInputs(html) {
    const payload = {};
    const inputRegex = /<input[^>]*name\s*=\s*["']([^"'>\s]+)["'][^>]*>/gi;
    let match;
    while ((match = inputRegex.exec(html)) !== null) {
      const tag = match[0];
      const name = match[1];
      const type = this.getAttribute(tag, "type").toLowerCase();
      if (type === "hidden" || name === "_xsrf") {
        payload[name] = this.getAttribute(tag, "value") || "";
      }
    }
    return payload;
  }

  parseProfiles(html) {
    const selectMatch = html.match(
      /<select[^>]*name\s*=\s*["']profile["'][^>]*>([\s\S]*?)<\/select>/i
    );
    if (!selectMatch) return [];

    const content = selectMatch[1];
    const options = [];
    const optionRegex = /<option([^>]*)>([\s\S]*?)<\/option>/gi;
    let optionMatch;
    while ((optionMatch = optionRegex.exec(content)) !== null) {
      const text = optionMatch[2].replace(/\s+/g, " ").trim();
      const value = this.getAttribute(optionMatch[0], "value") || text;
      options.push({
        value: value,
        title: text || value || "[default]",
      });
    }
    return options;
  }

  async fetchProfileForm() {
    const response = await this.request(PROFILE_PATH);
    if (response.statusCode >= 400) {
      throw new Error(`Failed to load profile form (${response.statusCode}).`);
    }

    const hidden = { ...this.parseHiddenInputs(response.body) };
    const profiles = this.parseProfiles(response.body);

    this.lastHiddenFields = { ...hidden };
    this.lastProfiles = profiles;

    return { hidden, profiles };
  }

  async fetchProfiles() {
    const form = await this.fetchProfileForm();
    return form.profiles;
  }

  async loadProfile(profileValue) {
    if (profileValue === undefined || profileValue === null) {
      throw new Error("Profile value is required");
    }

    if (!this.lastProfiles.length || !Object.keys(this.lastHiddenFields).length) {
      await this.fetchProfileForm();
    }

    const payload = {
      ...this.lastHiddenFields,
      profile: profileValue,
    };

    const encoded = new URLSearchParams(payload).toString();
    const response = await this.request(PROFILE_PATH, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: `http://${this.host}:${this.port}`,
        Referer: `http://${this.host}:${this.port}${PROFILE_PATH}`,
      },
      body: encoded,
    });

    if (response.statusCode >= 400) {
      throw new Error(`Profile load request failed (${response.statusCode}).`);
    }

    return true;
  }
}

module.exports = { HQPClient };
