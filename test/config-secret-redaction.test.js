const test = require("node:test");
const assert = require("node:assert/strict");
const { redactUrlCredentials } = require("../src/config-loader");

test("redacts authenticated source URLs from ffprobe diagnostics", () => {
    const diagnostic = [
        "Connection failed for",
        "rtsp://camera-user:p%40ssword@192.0.2.10:554/live",
        "and http://snapshot-user:other-secret@192.0.2.10/snapshot.jpg"
    ].join(" ");
    const sanitized = redactUrlCredentials(diagnostic);

    assert.equal(sanitized.includes("camera-user"), false);
    assert.equal(sanitized.includes("p%40ssword"), false);
    assert.equal(sanitized.includes("snapshot-user"), false);
    assert.equal(sanitized.includes("other-secret"), false);
    assert.match(sanitized, /rtsp:\/\/\[redacted\]@192\.0\.2\.10:554\/live/);
    assert.match(sanitized, /http:\/\/\[redacted\]@192\.0\.2\.10\/snapshot\.jpg/);
});

test("leaves unauthenticated diagnostics unchanged", () => {
    const diagnostic = "rtsp://192.0.2.10:554/live: network unreachable";
    assert.equal(redactUrlCredentials(diagnostic), diagnostic);
});
