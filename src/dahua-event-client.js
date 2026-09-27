const EventEmitter = require("events");
const crypto = require("crypto");
const http = require("http");
const https = require("https");

function hash(algorithm, value) {
    const normalized = String(algorithm || "MD5").toLowerCase();
    const name = normalized.startsWith("sha-256") ? "sha256" : "md5";
    return crypto.createHash(name).update(value).digest("hex");
}

function parseDigestChallenge(header) {
    const text = String(header || "").trim();
    if (!/^Digest\s+/i.test(text)) return null;

    const params = {};
    const body = text.replace(/^Digest\s+/i, "");
    const matcher = /([A-Za-z0-9_-]+)\s*=\s*("(?:[^"\\]|\\.)*"|[^,\s]+)/g;
    let match;

    while ((match = matcher.exec(body))) {
        let value = match[2];
        if (value.startsWith('"') && value.endsWith('"')) {
            value = value.slice(1, -1).replace(/\\(["\\])/g, "$1");
        }
        params[match[1].toLowerCase()] = value;
    }

    if (!params.realm || !params.nonce) return null;
    return params;
}

function chooseQop(value) {
    if (!value) return null;
    const qops = String(value)
        .split(",")
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean);

    return qops.includes("auth") ? "auth" : null;
}

function buildDigestAuthorization(options = {}) {
    const challenge = options.challenge || {};
    const username = String(options.username || "");
    const password = String(options.password || "");
    const method = String(options.method || "GET").toUpperCase();
    const uri = String(options.uri || "/");
    const realm = challenge.realm;
    const nonce = challenge.nonce;

    if (!realm || !nonce) {
        throw new Error("Digest challenge is missing realm or nonce");
    }

    const algorithm = String(challenge.algorithm || "MD5");
    const algorithmLower = algorithm.toLowerCase();
    if (!["md5", "md5-sess", "sha-256", "sha-256-sess"].includes(algorithmLower)) {
        throw new Error("Unsupported Digest algorithm: " + algorithm);
    }

    const qop = chooseQop(challenge.qop);
    if (challenge.qop && !qop) {
        throw new Error("Digest challenge does not offer qop=auth");
    }

    const cnonce = options.cnonce || crypto.randomBytes(12).toString("hex");
    const nc = options.nc || "00000001";

    let ha1 = hash(algorithm, username + ":" + realm + ":" + password);
    if (algorithmLower.endsWith("-sess")) {
        ha1 = hash(algorithm, ha1 + ":" + nonce + ":" + cnonce);
    }
    const ha2 = hash(algorithm, method + ":" + uri);

    const response = qop
        ? hash(algorithm, ha1 + ":" + nonce + ":" + nc + ":" + cnonce + ":" + qop + ":" + ha2)
        : hash(algorithm, ha1 + ":" + nonce + ":" + ha2);

    const fields = [
        'username="' + username.replace(/(["\\])/g, "\\$1") + '"',
        'realm="' + realm.replace(/(["\\])/g, "\\$1") + '"',
        'nonce="' + nonce.replace(/(["\\])/g, "\\$1") + '"',
        'uri="' + uri.replace(/(["\\])/g, "\\$1") + '"',
        'response="' + response + '"',
        "algorithm=" + algorithm
    ];

    if (challenge.opaque) {
        fields.push('opaque="' + challenge.opaque.replace(/(["\\])/g, "\\$1") + '"');
    }
    if (qop) {
        fields.push("qop=" + qop, "nc=" + nc, 'cnonce="' + cnonce + '"');
    }

    return "Digest " + fields.join(", ");
}

function buildAuthorization(header, options = {}) {
    const text = String(header || "");
    const digest = parseDigestChallenge(text);
    if (digest) {
        return buildDigestAuthorization({
            ...options,
            challenge: digest
        });
    }

    if (/^Basic(?:\s|$)/i.test(text)) {
        const token = Buffer.from(
            String(options.username || "") + ":" + String(options.password || ""),
            "utf8"
        ).toString("base64");
        return "Basic " + token;
    }

    return null;
}

class DahuaEventClient extends EventEmitter {
    constructor(options = {}) {
        super();

        if (!options.url) {
            throw new Error("Dahua event client requires a URL");
        }

        this.url = new URL(options.url);
        if (!["http:", "https:"].includes(this.url.protocol)) {
            throw new Error("Dahua event client URL must use http:// or https://");
        }

        this.username = options.username ?? null;
        this.password = options.password ?? null;
        if ((this.username && !this.password) || (!this.username && this.password)) {
            throw new Error("Dahua event client username/password must be provided together");
        }

        this.reconnectPeriod = Number(options.reconnectPeriod ?? 5000);
        this.connectTimeout = Number(options.connectTimeout ?? 10000);
        this.inactivityTimeout = Number(options.inactivityTimeout ?? 20000);
        this.rejectUnauthorized = options.rejectUnauthorized !== false;

        this.started = false;
        this.stopping = false;
        this.state = "stopped";
        this.request = null;
        this.response = null;
        this.reconnectTimer = null;
        this.lastDataAt = null;
        this.connectedAt = null;
        this.connections = 0;
        this.errors = 0;
        this.authChallenges = 0;
        this.generation = 0;
    }

    setState(state) {
        if (this.state === state) return;
        this.state = state;
        this.emit("state", this.health());
    }

    start() {
        if (this.started) return;
        this.started = true;
        this.stopping = false;
        this.connect(null, false);
    }

    connect(authorization, challenged) {
        if (!this.started || this.stopping) return;

        this.clearActive();
        const generation = ++this.generation;
        this.setState(challenged ? "authenticating" : "connecting");

        const transport = this.url.protocol === "https:" ? https : http;
        const headers = {
            Accept: "*/*",
            Connection: "keep-alive"
        };
        if (authorization) headers.Authorization = authorization;

        const request = transport.request({
            protocol: this.url.protocol,
            hostname: this.url.hostname,
            port: this.url.port || undefined,
            method: "GET",
            path: this.url.pathname + this.url.search,
            headers,
            rejectUnauthorized: this.rejectUnauthorized
        });

        this.request = request;

        request.setTimeout(this.connectTimeout, () => {
            request.destroy(new Error("Recorder event connection timed out"));
        });

        request.on("response", (response) => {
            if (generation !== this.generation || this.stopping) {
                response.destroy();
                return;
            }

            this.response = response;
            request.setTimeout(0);

            if (response.statusCode === 401) {
                this.handleUnauthorized(response, challenged, generation);
                return;
            }

            if (response.statusCode !== 200) {
                response.resume();
                this.recordError(
                    new Error("Recorder event stream returned HTTP " + response.statusCode)
                );
                response.once("end", () => this.scheduleReconnect(generation));
                return;
            }

            this.connections += 1;
            this.connectedAt = new Date().toISOString();
            this.setState("connected");
            this.armInactivityTimeout(response, generation);

            response.on("data", (chunk) => {
                if (generation !== this.generation || this.stopping) return;
                this.lastDataAt = new Date().toISOString();
                this.armInactivityTimeout(response, generation);
                this.emit("data", chunk);
            });

            response.on("end", () => {
                if (generation !== this.generation || this.stopping) return;
                this.setState("disconnected");
                this.scheduleReconnect(generation);
            });

            response.on("close", () => {
                if (generation !== this.generation || this.stopping) return;
                if (this.state === "connected") {
                    this.setState("disconnected");
                    this.scheduleReconnect(generation);
                }
            });

            response.on("error", (error) => {
                if (generation !== this.generation || this.stopping) return;
                this.recordError(error);
                this.scheduleReconnect(generation);
            });
        });

        request.on("error", (error) => {
            if (generation !== this.generation || this.stopping) return;
            this.recordError(error);
            this.scheduleReconnect(generation);
        });

        request.end();
    }

    handleUnauthorized(response, challenged, generation) {
        this.authChallenges += 1;
        const authenticate = response.headers["www-authenticate"];

        if (challenged || !this.username || !this.password || !authenticate) {
            response.resume();
            this.recordError(new Error("Recorder event stream authentication failed"));
            response.once("end", () => this.scheduleReconnect(generation));
            return;
        }

        let authorization;
        try {
            authorization = buildAuthorization(authenticate, {
                username: this.username,
                password: this.password,
                method: "GET",
                uri: this.url.pathname + this.url.search
            });
        } catch (error) {
            response.resume();
            this.recordError(error);
            response.once("end", () => this.scheduleReconnect(generation));
            return;
        }

        if (!authorization) {
            response.resume();
            this.recordError(new Error("Recorder returned an unsupported authentication challenge"));
            response.once("end", () => this.scheduleReconnect(generation));
            return;
        }

        this.setState("authenticating");
        response.resume();
        response.once("end", () => {
            if (generation !== this.generation || this.stopping) return;
            this.connect(authorization, true);
        });
    }

    armInactivityTimeout(response, generation) {
        if (!this.inactivityTimeout) return;
        response.setTimeout(this.inactivityTimeout, () => {
            if (generation !== this.generation || this.stopping) return;
            response.destroy(new Error("Recorder event stream became inactive"));
        });
    }

    recordError(error) {
        this.errors += 1;
        this.emit("runtimeError", error);
    }

    scheduleReconnect(generation) {
        if (!this.started || this.stopping || generation !== this.generation) return;
        if (this.reconnectTimer) return;

        this.clearActive();
        this.setState("reconnecting");

        const delay = Math.max(0, this.reconnectPeriod);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (!this.started || this.stopping) return;
            this.connect(null, false);
        }, delay);

        if (typeof this.reconnectTimer.unref === "function") {
            this.reconnectTimer.unref();
        }
    }

    clearActive() {
        const response = this.response;
        const request = this.request;
        this.response = null;
        this.request = null;

        if (response && !response.destroyed) response.destroy();
        if (request && !request.destroyed) request.destroy();
    }

    stop() {
        if (!this.started) return;

        this.stopping = true;
        this.started = false;
        this.generation += 1;

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        this.clearActive();
        this.stopping = false;
        this.setState("stopped");
    }

    health() {
        return Object.freeze({
            state: this.state,
            connectedAt: this.connectedAt,
            lastDataAt: this.lastDataAt,
            connections: this.connections,
            authChallenges: this.authChallenges,
            errors: this.errors
        });
    }
}

module.exports = {
    DahuaEventClient,
    parseDigestChallenge,
    buildDigestAuthorization,
    buildAuthorization
};
