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
      const rawValue = this.getAttribute(optionMatch[0], "value") || text;
      const value = rawValue !== undefined && rawValue !== null ? String(rawValue).trim() : "";
      options.push({
        value: value,
        title: text || value || "Unnamed profile",
      });
    }
    return this.sanitizeProfiles(options);
  }

  sanitizeProfiles(list) {
    if (!Array.isArray(list)) return [];
    return list
      .map((entry) => {
        if (!entry || typeof entry !== "object") return null;
        const raw = entry.value !== undefined && entry.value !== null ? String(entry.value) : "";
        const value = raw.trim();
        const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "");
        if (!value || !slug.length || slug === "default") {
          console.log(
            "[HQP][SC] Dropping HQP profile option value=%s title=%s",
            value || "<empty>",
            entry.title || "<none>"
          );
          return null;
        }
        const title = entry.title && String(entry.title).trim();
        return {
          value,
          title: title || value || "Unnamed profile",
        };
      })
      .filter(Boolean);
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
    return this.sanitizeProfiles(form.profiles);
  }

  parseSelectOptions(html, selectName) {
    const selectRegex = new RegExp(
      `<select[^>]*name\\s*=\\s*["']${selectName}["'][^>]*>([\\s\\S]*?)<\\/select>`,
      "i"
    );
    const selectMatch = html.match(selectRegex);
    if (!selectMatch) return { selected: { value: "", label: "" }, options: [] };

    const content = selectMatch[1];
    const options = [];
    let selected = { value: "", label: "" };

    const optionRegex = /<option([^>]*)>([\s\S]*?)<\/option>/gi;
    let match;
    while ((match = optionRegex.exec(content)) !== null) {
      const attrs = match[1];
      const label = match[2].replace(/\s+/g, " ").trim();
      const value = this.getAttribute(match[0], "value") || label;
      const opt = { value, label };
      options.push(opt);
      if (/selected/i.test(attrs)) {
        selected = opt;
      }
    }

    // Fall back to first option if none selected
    if (!selected.value && options.length > 0) {
      selected = options[0];
    }

    return { selected, options };
  }

  parseStatusTable(html) {
    // Parse the status table: State, Track, Tracks, Limits/Apod, Mode, Filter, Shaper, Output, Offload
    const tableRegex = /<tr><th>State<\/th>.*?<\/tr>\s*<tr><td>(.*?)<\/td><td>(.*?)<\/td><td>(.*?)<\/td><td>(.*?)<\/td><td>(.*?)<\/td><td>(.*?)<\/td><td>(.*?)<\/td><td>(.*?)<\/td><td>(.*?)<\/td><\/tr>/is;
    const match = html.match(tableRegex);
    if (!match) return null;
    return {
      state: match[1].trim(),
      track: match[2].trim(),
      tracks: match[3].trim(),
      limits: match[4].trim(),
      activeMode: match[5].trim(),
      activeFilter: match[6].trim(),
      activeShaper: match[7].trim(),
      output: match[8].trim(),
      offload: match[9].trim(),
    };
  }

  parseVolume(html) {
    // Parse volume slider: <input type="range" id="volume" name="volume" min="-39" max="0" step="1" value="-12"/>
    const volumeRegex = /<input[^>]*name\s*=\s*["']volume["'][^>]*>/i;
    const match = html.match(volumeRegex);
    if (!match) return null;

    const tag = match[0];
    const value = parseFloat(this.getAttribute(tag, "value")) || 0;
    const min = parseFloat(this.getAttribute(tag, "min")) || -60;
    const max = parseFloat(this.getAttribute(tag, "max")) || 0;

    // Fixed volume typically shows as -3 to 0 range
    const isFixed = (max - min) <= 6;

    return { value, min, max, isFixed };
  }

  async fetchPipeline() {
    // Root page doesn't require auth
    const response = await this.makeRequest("/", { method: "GET", headers: this.baseHeaders() });
    if (response.statusCode >= 400) {
      throw new Error(`Failed to load HQPlayer main page (${response.statusCode}).`);
    }

    const html = response.body;
    const status = this.parseStatusTable(html);
    const volume = this.parseVolume(html);
    const mode = this.parseSelectOptions(html, "mode");
    const filter1x = this.parseSelectOptions(html, "filter1x");
    const filterNx = this.parseSelectOptions(html, "filterNx");
    const shaper = this.parseSelectOptions(html, "shaper");
    const samplerate = this.parseSelectOptions(html, "samplerate");

    return {
      status,
      volume,
      settings: {
        mode,
        filter1x,
        filterNx,
        shaper,
        samplerate,
      },
    };
  }

  async setPipelineSetting(name, value) {
    // POST to root page to change a setting
    const payload = new URLSearchParams({ [name]: value }).toString();
    const response = await this.makeRequest("/", {
      method: "POST",
      headers: {
        ...this.baseHeaders(),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: payload,
    });
    if (response.statusCode >= 400) {
      throw new Error(`Failed to set ${name} (${response.statusCode}).`);
    }
    return true;
  }

  async loadProfile(profileValue) {
    if (profileValue === undefined || profileValue === null) {
      throw new Error("Profile value is required");
    }
    const trimmed = String(profileValue).trim();
    if (!trimmed || trimmed.toLowerCase() === "default") {
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
