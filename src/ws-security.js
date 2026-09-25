const crypto = require("crypto");

const PASSWORD_TEXT = "PasswordText";
const PASSWORD_DIGEST = "PasswordDigest";

function extractValue(raw) {
    if (typeof raw === "string") {
        return raw;
    }

    if (!raw || typeof raw !== "object") {
        return undefined;
    }

    return raw.$value ?? raw._ ?? raw.value;
}

function extractType(raw) {
    if (!raw || typeof raw !== "object") {
        return "";
    }

    return raw?.$attributes?.Type || raw?.Type || raw?.type || "";
}

function safeStringEqual(left, right) {
    if (typeof left !== "string" || typeof right !== "string") {
        return false;
    }

    const leftBuffer = Buffer.from(left, "utf8");
    const rightBuffer = Buffer.from(right, "utf8");

    if (leftBuffer.length !== rightBuffer.length) {
        return false;
    }

    return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function decodeBase64Strict(value) {
    if (typeof value !== "string" || value.trim() === "") {
        return null;
    }

    const normalized = value.trim().replace(/\s+/g, "");

    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
        return null;
    }

    if (normalized.length % 4 === 1) {
        return null;
    }

    let decoded;
    try {
        decoded = Buffer.from(normalized, "base64");
    } catch (_) {
        return null;
    }

    if (decoded.length === 0) {
        return null;
    }

    const canonicalInput = normalized.replace(/=+$/, "");
    const canonicalDecoded = decoded.toString("base64").replace(/=+$/, "");

    return canonicalInput === canonicalDecoded ? decoded : null;
}

function classifyPassword(passwordRaw, nonceValue, createdValue) {
    if (typeof passwordRaw === "string") {
        return PASSWORD_TEXT;
    }

    const type = extractType(passwordRaw);
    if (type.endsWith("#PasswordDigest")) {
        return PASSWORD_DIGEST;
    }

    if (type.endsWith("#PasswordText")) {
        return PASSWORD_TEXT;
    }

    if (nonceValue !== undefined || createdValue !== undefined) {
        return PASSWORD_DIGEST;
    }

    return null;
}

class UsernameTokenAuthenticator {
    constructor(options) {
        this.username = options.username;
        this.password = options.password;
        this.mode = options.mode || "audit";
        this.maxAgeMs = (options.maxAgeSeconds ?? 300) * 1000;
        this.futureSkewMs = (options.futureSkewSeconds ?? 300) * 1000;
        this.nonceCacheSize = options.nonceCacheSize ?? 2048;
        this.allowPasswordText = options.allowPasswordText !== false;
        this.nonceCache = new Map();
    }

    authenticate(security, nowMs = Date.now()) {
        if (!security) {
            return this.reject("missing-security");
        }

        const token = security.UsernameToken;
        if (!token) {
            return this.reject("missing-username-token");
        }

        const username = extractValue(token.Username) ?? token.Username;
        const passwordRaw = token.Password;
        const passwordValue = extractValue(passwordRaw);
        const nonceValue = extractValue(token.Nonce);
        const createdValue = extractValue(token.Created);

        if (!safeStringEqual(username, this.username)) {
            return this.reject("username-mismatch");
        }

        const credentialMode = classifyPassword(passwordRaw, nonceValue, createdValue);

        if (credentialMode === PASSWORD_TEXT) {
            if (!this.allowPasswordText) {
                return this.reject("password-text-disabled", credentialMode);
            }

            if (!safeStringEqual(passwordValue, this.password)) {
                return this.reject("password-mismatch", credentialMode);
            }
        } else if (credentialMode === PASSWORD_DIGEST) {
            if (!passwordValue || !nonceValue || !createdValue) {
                return this.reject("digest-missing-required-fields", credentialMode);
            }

            const nonceBuffer = decodeBase64Strict(nonceValue);
            if (!nonceBuffer) {
                return this.reject("invalid-nonce", credentialMode);
            }

            const expectedDigest = crypto
                .createHash("sha1")
                .update(Buffer.concat([
                    nonceBuffer,
                    Buffer.from(createdValue, "utf8"),
                    Buffer.from(this.password, "utf8")
                ]))
                .digest("base64");

            if (!safeStringEqual(passwordValue, expectedDigest)) {
                return this.reject("digest-mismatch", credentialMode);
            }
        } else {
            return this.reject("unsupported-password-format");
        }

        const policy = this.evaluateReplayPolicy({
            username,
            nonceValue,
            createdValue,
            nowMs
        });

        if (this.mode === "enforce" && policy.warnings.length > 0) {
            return this.reject(policy.warnings[0], credentialMode, policy.warnings);
        }

        if (nonceValue) {
            this.rememberNonce(username, nonceValue, nowMs);
        }

        return {
            accepted: true,
            credentialMode,
            warnings: policy.warnings,
            reason: null
        };
    }

    evaluateReplayPolicy({ username, nonceValue, createdValue, nowMs }) {
        const warnings = [];

        if (!nonceValue) {
            warnings.push("missing-nonce");
        }

        if (!createdValue) {
            warnings.push("missing-created");
        }

        if (createdValue) {
            const createdMs = Date.parse(createdValue);

            if (!Number.isFinite(createdMs)) {
                warnings.push("invalid-created");
            } else {
                if (nowMs - createdMs > this.maxAgeMs) {
                    warnings.push("stale-created");
                }

                if (createdMs - nowMs > this.futureSkewMs) {
                    warnings.push("future-created");
                }
            }
        }

        if (nonceValue && this.hasSeenNonce(username, nonceValue, nowMs)) {
            warnings.push("replayed-nonce");
        }

        return { warnings };
    }

    nonceKey(username, nonceValue) {
        return crypto
            .createHash("sha256")
            .update(String(username), "utf8")
            .update("\0", "utf8")
            .update(String(nonceValue), "utf8")
            .digest("hex");
    }

    pruneNonceCache(nowMs) {
        for (const [key, expiresAt] of this.nonceCache.entries()) {
            if (expiresAt <= nowMs) {
                this.nonceCache.delete(key);
            }
        }

        while (this.nonceCache.size > this.nonceCacheSize) {
            const oldestKey = this.nonceCache.keys().next().value;
            if (oldestKey === undefined) {
                break;
            }
            this.nonceCache.delete(oldestKey);
        }
    }

    hasSeenNonce(username, nonceValue, nowMs) {
        this.pruneNonceCache(nowMs);
        const key = this.nonceKey(username, nonceValue);
        const expiresAt = this.nonceCache.get(key);

        return Number.isFinite(expiresAt) && expiresAt > nowMs;
    }

    rememberNonce(username, nonceValue, nowMs) {
        this.pruneNonceCache(nowMs);

        const key = this.nonceKey(username, nonceValue);
        const ttlMs = Math.max(this.maxAgeMs + this.futureSkewMs, this.maxAgeMs);
        this.nonceCache.set(key, nowMs + ttlMs);

        this.pruneNonceCache(nowMs);
    }

    reject(reason, credentialMode = null, warnings = []) {
        return {
            accepted: false,
            credentialMode,
            warnings,
            reason
        };
    }
}

module.exports = {
    PASSWORD_TEXT,
    PASSWORD_DIGEST,
    extractValue,
    extractType,
    safeStringEqual,
    decodeBase64Strict,
    classifyPassword,
    UsernameTokenAuthenticator
};
