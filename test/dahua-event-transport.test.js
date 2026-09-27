const test = require("node:test");
const assert = require("node:assert/strict");
const EventEmitter = require("events");
const { DahuaEventTransport, parseDigestChallenge, createDigestAuthorization } = require("../src/dahua-event-transport");

class FakeResponse extends EventEmitter {
    constructor(statusCode, headers = {}) { super(); this.statusCode = statusCode; this.headers = headers; }
    resume() {}
    destroy() {}
}

function fakeRequest(responses, requests) {
    return (options, callback) => {
        const request = new EventEmitter();
        request.end = () => { requests.push(options); queueMicrotask(() => callback(responses.shift())); };
        request.destroy = () => {};
        return request;
    };
}

test("parses and answers a Dahua digest challenge", () => {
    const challenge = parseDigestChallenge('Digest realm="Login to NVR", qop="auth", nonce="abc", opaque="xyz"');
    assert.deepEqual(challenge, { realm: "Login to NVR", qop: "auth", nonce: "abc", opaque: "xyz" });
    const header = createDigestAuthorization({ challenge, username: "viewer", password: "secret", method: "GET",
        path: "/cgi-bin/eventManager.cgi?action=attach&codes=[All]", cnonce: "012345", nonceCount: 1 });
    assert.match(header, /^Digest username="viewer"/);
    assert.match(header, /qop=auth, nc=00000001, cnonce="012345"/);
    assert.match(header, /response="[a-f0-9]{32}"/);
});

test("authenticates, streams chunks, and exposes health", async () => {
    const unauthorized = new FakeResponse(401, { "www-authenticate": 'Digest realm="NVR", qop="auth", nonce="abc"' });
    const stream = new FakeResponse(200);
    const requests = [];
    const chunks = [];
    const runtime = { push: (chunk) => chunks.push(chunk.toString()), stop() {}, health: () => ({ eventsReceived: chunks.length }) };
    const transport = new DahuaEventTransport({
        url: "http://192.0.2.10/cgi-bin/eventManager.cgi?action=attach&codes=[All]",
        username: "viewer", password: "secret", runtime, request: fakeRequest([unauthorized, stream], requests),
        randomBytes: () => Buffer.from("0123456789ab"), inactivityTimeoutMs: 60000
    });
    transport.start();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests.length, 2);
    assert.equal(requests[0].headers.Authorization, undefined);
    assert.match(requests[1].headers.Authorization, /^Digest /);
    stream.emit("data", Buffer.from("Code=VideoMotion;action=Start;index=0\r\n"));
    assert.equal(chunks.length, 1);
    assert.equal(transport.health().state, "connected");
    assert.equal(transport.health().connections, 1);
    transport.stop();
    assert.equal(transport.health().state, "stopped");
});

test("reconnects after a stream ends", async () => {
    const first = new FakeResponse(200);
    const second = new FakeResponse(200);
    const requests = [];
    const transport = new DahuaEventTransport({ url: "http://recorder/events", username: "u", password: "p",
        runtime: { push() {}, stop() {} }, request: fakeRequest([first, second], requests),
        reconnectMinMs: 1, reconnectMaxMs: 2, inactivityTimeoutMs: 60000 });
    transport.start();
    await new Promise((resolve) => setImmediate(resolve));
    first.emit("end");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(requests.length, 2);
    assert.equal(transport.health().connections, 2);
    assert.equal(transport.health().reconnects, 1);
    transport.stop();
});

test("contains rejected credentials and retries without leaking secrets", async () => {
    const responses = [
        new FakeResponse(401, { "www-authenticate": 'Digest realm="NVR", nonce="one", qop="auth"' }),
        new FakeResponse(401, { "www-authenticate": 'Digest realm="NVR", nonce="two", qop="auth"' })
    ];
    const errors = [];
    const transport = new DahuaEventTransport({ url: "http://recorder/events", username: "u", password: "secret-value",
        runtime: { push() {}, stop() {} }, request: fakeRequest(responses, []), reconnectMinMs: 1000 });
    transport.on("runtimeError", (error) => errors.push(error.message));
    transport.start();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(transport.health().authenticationFailures, 1);
    assert.equal(transport.health().state, "reconnecting");
    assert.equal(errors.some((message) => message.includes("secret-value")), false);
    transport.stop();
});
