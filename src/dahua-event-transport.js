const EventEmitter = require("events");
const crypto = require("crypto");
const http = require("http");
const https = require("https");

function md5(value) {
    return crypto.createHash("md5").update(value).digest("hex");
}

function parseDigestChallenge(header) {
    const value = String(header || "");
    if (!/^Digest\s/i.test(value)) return null;
    const challenge = {};
    const fields = value.replace(/^Digest\s+/i, "").matchAll(/([A-Za-z0-9_-]+)=(?:"([^"]*)"|([^,\s]+))/g);
    for (const match of fields) challenge[match[1].toLowerCase()] = match[2] ?? match[3];
    if (!challenge.realm || !challenge.nonce) return null;
    return challenge;
}

function createDigestAuthorization({ challenge, username, password, method, path, nonceCount = 1, cnonce }) {
    const algorithm = String(challenge.algorithm || "MD5").toUpperCase();
    if (algorithm !== "MD5" && algorithm !== "MD5-SESS") throw new Error(`Unsupported recorder digest algorithm: ${algorithm}`);
    const qops = String(challenge.qop || "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
    const qop = qops.includes("auth") ? "auth" : null;
    if (qops.length && !qop) throw new Error("Recorder digest challenge does not support qop=auth");
    const clientNonce = cnonce || crypto.randomBytes(12).toString("hex");
    const nc = nonceCount.toString(16).padStart(8, "0");
    let ha1 = md5(`${username}:${challenge.realm}:${password}`);
    if (algorithm === "MD5-SESS") ha1 = md5(`${ha1}:${challenge.nonce}:${clientNonce}`);
    const ha2 = md5(`${method}:${path}`);
    const response = qop
        ? md5(`${ha1}:${challenge.nonce}:${nc}:${clientNonce}:${qop}:${ha2}`)
        : md5(`${ha1}:${challenge.nonce}:${ha2}`);
    const fields = [
        `username="${username.replace(/["\\]/g, "\\$&")}"`, `realm="${challenge.realm}"`,
        `nonce="${challenge.nonce}"`, `uri="${path}"`, `response="${response}"`, `algorithm=${algorithm}`
    ];
    if (challenge.opaque) fields.push(`opaque="${challenge.opaque}"`);
    if (qop) fields.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${clientNonce}"`);
    return `Digest ${fields.join(", ")}`;
}

class DahuaEventTransport extends EventEmitter {
    constructor(options = {}) {
        super();
        if (!options.url) throw new Error("Dahua event transport requires a URL");
        if (!options.username || !options.password) throw new Error("Dahua event transport requires credentials");
        if (!options.runtime || typeof options.runtime.push !== "function") throw new Error("Dahua event transport requires a runtime");
        this.url = new URL(options.url);
        if (!["http:", "https:"].includes(this.url.protocol)) throw new Error("Dahua event transport URL must use HTTP or HTTPS");
        this.username = options.username;
        this.password = options.password;
        this.runtime = options.runtime;
        this.request = options.request || (this.url.protocol === "https:" ? https.request : http.request);
        this.reconnectMinMs = options.reconnectMinMs || 1000;
        this.reconnectMaxMs = options.reconnectMaxMs || 30000;
        this.inactivityTimeoutMs = options.inactivityTimeoutMs || 90000;
        this.randomBytes = options.randomBytes || crypto.randomBytes;
        this.state = "stopped";
        this.started = false;
        this.requestHandle = null;
        this.response = null;
        this.reconnectTimer = null;
        this.inactivityTimer = null;
        this.retryDelayMs = this.reconnectMinMs;
        this.connections = 0;
        this.reconnects = 0;
        this.authenticationFailures = 0;
        this.lastConnectedAt = null;
        this.lastError = null;
    }

    start() {
        if (this.started) return this.health();
        this.started = true;
        this.retryDelayMs = this.reconnectMinMs;
        this.open();
        return this.health();
    }

    open(challenge = null) {
        if (!this.started) return;
        this.clearConnection();
        this.setState(challenge ? "authenticating" : "connecting");
        const path = `${this.url.pathname}${this.url.search}`;
        const headers = { Accept: "multipart/x-mixed-replace" };
        if (challenge) {
            headers.Authorization = createDigestAuthorization({
                challenge, username: this.username, password: this.password, method: "GET", path,
                cnonce: this.randomBytes(12).toString("hex")
            });
        }
        const requestOptions = {
            protocol: this.url.protocol, hostname: this.url.hostname,
            port: this.url.port || undefined, method: "GET", path, headers
        };
        const requestHandle = this.request(requestOptions, (response) => this.handleResponse(response, challenge));
        this.requestHandle = requestHandle;
        requestHandle.on("error", (error) => this.handleDisconnect(error));
        requestHandle.end();
    }

    handleResponse(response, attemptedChallenge) {
        if (!this.started) { response.destroy(); return; }
        if (response.statusCode === 401) {
            const challenge = parseDigestChallenge(response.headers["www-authenticate"]);
            response.resume();
            if (!challenge || attemptedChallenge) {
                this.authenticationFailures += 1;
                this.handleDisconnect(new Error("Recorder authentication failed"));
                return;
            }
            this.requestHandle = null;
            this.open(challenge);
            return;
        }
        if (response.statusCode !== 200) {
            response.resume();
            this.handleDisconnect(new Error(`Recorder event stream returned HTTP ${response.statusCode}`));
            return;
        }
        this.response = response;
        this.connections += 1;
        this.lastConnectedAt = new Date().toISOString();
        this.retryDelayMs = this.reconnectMinMs;
        this.setState("connected");
        this.armInactivityTimer();
        response.on("data", (chunk) => {
            this.armInactivityTimer();
            this.runtime.push(chunk);
        });
        response.once("end", () => this.handleDisconnect(new Error("Recorder event stream ended")));
        response.once("error", (error) => this.handleDisconnect(error));
        response.once("aborted", () => this.handleDisconnect(new Error("Recorder event stream aborted")));
    }

    armInactivityTimer() {
        if (this.inactivityTimer) clearTimeout(this.inactivityTimer);
        this.inactivityTimer = setTimeout(() => {
            if (this.response) this.response.destroy(new Error("Recorder event stream timed out"));
            this.handleDisconnect(new Error("Recorder event stream timed out"));
        }, this.inactivityTimeoutMs);
        this.inactivityTimer.unref?.();
    }

    handleDisconnect(error) {
        if (!this.started || this.reconnectTimer) return;
        this.lastError = error.message;
        this.emit("runtimeError", error);
        this.clearConnection();
        this.setState("reconnecting");
        const delay = this.retryDelayMs;
        this.retryDelayMs = Math.min(this.retryDelayMs * 2, this.reconnectMaxMs);
        this.reconnects += 1;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.open();
        }, delay);
        this.reconnectTimer.unref?.();
    }

    clearConnection() {
        if (this.inactivityTimer) clearTimeout(this.inactivityTimer);
        this.inactivityTimer = null;
        if (this.response) this.response.destroy();
        if (this.requestHandle) this.requestHandle.destroy();
        this.response = null;
        this.requestHandle = null;
    }

    stop() {
        this.started = false;
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        this.clearConnection();
        if (typeof this.runtime.stop === "function") this.runtime.stop();
        this.setState("stopped");
    }

    setState(state) {
        if (this.state === state) return;
        this.state = state;
        this.emit("state", this.health());
    }

    health() {
        return Object.freeze({ state: this.state, connections: this.connections, reconnects: this.reconnects,
            authenticationFailures: this.authenticationFailures, lastConnectedAt: this.lastConnectedAt,
            lastError: this.lastError, analytics: this.runtime.health?.() });
    }
}

module.exports = { DahuaEventTransport, parseDigestChallenge, createDigestAuthorization };
