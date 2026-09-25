const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const {
    PASSWORD_TEXT,
    PASSWORD_DIGEST,
    safeStringEqual,
    decodeBase64Strict,
    UsernameTokenAuthenticator
} = require("../src/ws-security");

function digestToken({
    username = "viewer",
    password = "secret",
    nonceBytes = Buffer.from("nonce-1234567890", "utf8"),
    created = "2026-09-25T23:00:00.000Z"
} = {}) {
    const nonce = nonceBytes.toString("base64");
    const digest = crypto
        .createHash("sha1")
        .update(Buffer.concat([
            nonceBytes,
            Buffer.from(created, "utf8"),
            Buffer.from(password, "utf8")
        ]))
        .digest("base64");

    return {
        UsernameToken: {
            Username: username,
            Password: {
                $attributes: {
                    Type: "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest"
                },
                $value: digest
            },
            Nonce: {
                $value: nonce
            },
            Created: created
        }
    };
}

function authenticator(overrides = {}) {
    return new UsernameTokenAuthenticator({
        username: "viewer",
        password: "secret",
        mode: "audit",
        maxAgeSeconds: 300,
        futureSkewSeconds: 300,
        nonceCacheSize: 4,
        allowPasswordText: true,
        ...overrides
    });
}

const NOW = Date.parse("2026-09-25T23:00:30.000Z");

test("constant-time helper accepts equal strings and rejects mismatches", () => {
    assert.equal(safeStringEqual("same", "same"), true);
    assert.equal(safeStringEqual("same", "diff"), false);
    assert.equal(safeStringEqual("short", "longer"), false);
});

test("strict base64 decoding rejects malformed nonce values", () => {
    assert.equal(decodeBase64Strict("%%%not-base64%%%"), null);
    assert.equal(decodeBase64Strict("A"), null);
    assert.deepEqual(
        decodeBase64Strict(Buffer.from("nonce", "utf8").toString("base64")),
        Buffer.from("nonce", "utf8")
    );
});

test("valid PasswordDigest authenticates with no policy warnings", () => {
    const auth = authenticator();
    const result = auth.authenticate(digestToken(), NOW);

    assert.equal(result.accepted, true);
    assert.equal(result.credentialMode, PASSWORD_DIGEST);
    assert.deepEqual(result.warnings, []);
});

test("invalid PasswordDigest is rejected before nonce cache insertion", () => {
    const auth = authenticator();
    const token = digestToken();
    token.UsernameToken.Password.$value = "definitely-wrong";

    const result = auth.authenticate(token, NOW);

    assert.equal(result.accepted, false);
    assert.equal(result.reason, "digest-mismatch");
    assert.equal(auth.nonceCache.size, 0);
});

test("wrong username is rejected", () => {
    const auth = authenticator();
    const result = auth.authenticate(
        digestToken({ username: "somebody-else" }),
        NOW
    );

    assert.equal(result.accepted, false);
    assert.equal(result.reason, "username-mismatch");
});

test("PasswordText remains compatible in audit mode but records missing replay controls", () => {
    const auth = authenticator();
    const result = auth.authenticate({
        UsernameToken: {
            Username: "viewer",
            Password: "secret"
        }
    }, NOW);

    assert.equal(result.accepted, true);
    assert.equal(result.credentialMode, PASSWORD_TEXT);
    assert.deepEqual(result.warnings, ["missing-nonce", "missing-created"]);
});

test("PasswordText object form is supported", () => {
    const auth = authenticator();
    const result = auth.authenticate({
        UsernameToken: {
            Username: "viewer",
            Password: {
                $attributes: {
                    Type: "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordText"
                },
                $value: "secret"
            },
            Nonce: Buffer.from("text-nonce", "utf8").toString("base64"),
            Created: "2026-09-25T23:00:00.000Z"
        }
    }, NOW);

    assert.equal(result.accepted, true);
    assert.equal(result.credentialMode, PASSWORD_TEXT);
    assert.deepEqual(result.warnings, []);
});

test("PasswordText can be disabled explicitly", () => {
    const auth = authenticator({ allowPasswordText: false });
    const result = auth.authenticate({
        UsernameToken: {
            Username: "viewer",
            Password: "secret"
        }
    }, NOW);

    assert.equal(result.accepted, false);
    assert.equal(result.reason, "password-text-disabled");
});

test("stale valid token is accepted in audit mode and flagged", () => {
    const auth = authenticator({ mode: "audit" });
    const result = auth.authenticate(
        digestToken({ created: "2026-09-25T22:50:00.000Z" }),
        NOW
    );

    assert.equal(result.accepted, true);
    assert.ok(result.warnings.includes("stale-created"));
});

test("stale valid token is rejected in enforce mode", () => {
    const auth = authenticator({ mode: "enforce" });
    const result = auth.authenticate(
        digestToken({ created: "2026-09-25T22:50:00.000Z" }),
        NOW
    );

    assert.equal(result.accepted, false);
    assert.equal(result.reason, "stale-created");
});

test("future timestamp outside configured skew is flagged and enforceable", () => {
    const audit = authenticator({ mode: "audit", futureSkewSeconds: 60 });
    const enforce = authenticator({ mode: "enforce", futureSkewSeconds: 60 });
    const token = digestToken({ created: "2026-09-25T23:05:00.000Z" });

    const auditResult = audit.authenticate(token, NOW);
    const enforceResult = enforce.authenticate(token, NOW);

    assert.equal(auditResult.accepted, true);
    assert.ok(auditResult.warnings.includes("future-created"));
    assert.equal(enforceResult.accepted, false);
    assert.equal(enforceResult.reason, "future-created");
});

test("invalid Created value is audited or rejected according to mode", () => {
    const token = digestToken({ created: "not-a-date" });

    const auditResult = authenticator({ mode: "audit" }).authenticate(token, NOW);
    const enforceResult = authenticator({ mode: "enforce" }).authenticate(token, NOW);

    assert.equal(auditResult.accepted, true);
    assert.ok(auditResult.warnings.includes("invalid-created"));
    assert.equal(enforceResult.accepted, false);
    assert.equal(enforceResult.reason, "invalid-created");
});

test("replayed nonce is accepted with an audit warning in audit mode", () => {
    const auth = authenticator({ mode: "audit" });
    const token = digestToken();

    const first = auth.authenticate(token, NOW);
    const second = auth.authenticate(token, NOW + 1000);

    assert.equal(first.accepted, true);
    assert.deepEqual(first.warnings, []);
    assert.equal(second.accepted, true);
    assert.ok(second.warnings.includes("replayed-nonce"));
});

test("replayed nonce is rejected in enforce mode", () => {
    const auth = authenticator({ mode: "enforce" });
    const token = digestToken();

    const first = auth.authenticate(token, NOW);
    const second = auth.authenticate(token, NOW + 1000);

    assert.equal(first.accepted, true);
    assert.equal(second.accepted, false);
    assert.equal(second.reason, "replayed-nonce");
});

test("nonce cache is bounded", () => {
    const auth = authenticator({ nonceCacheSize: 2 });

    for (let index = 0; index < 5; index += 1) {
        const token = digestToken({
            nonceBytes: Buffer.from(`nonce-${index}-abcdefghij`, "utf8")
        });
        assert.equal(auth.authenticate(token, NOW + index).accepted, true);
    }

    assert.ok(auth.nonceCache.size <= 2);
});

test("missing security and UsernameToken are rejected", () => {
    const auth = authenticator();

    assert.equal(auth.authenticate(null, NOW).reason, "missing-security");
    assert.equal(auth.authenticate({}, NOW).reason, "missing-username-token");
});
