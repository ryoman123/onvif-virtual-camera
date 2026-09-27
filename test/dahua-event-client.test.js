const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const { once } = require("node:events");

const { AnalyticsDispatcher } = require("../src/analytics-dispatcher");
const { DahuaEventClient } = require("../src/dahua-event-client");
const { DahuaAnalyticsRouter, DahuaRecorderRuntime } = require("../src/dahua-recorder-runtime");
const { EventBus } = require("../src/event-bus");
const { DEFAULT_TOPICS, TOPICS } = require("../src/event-topics");

function md5(value) {
    return crypto.createHash("md5").update(value).digest("hex");
}

function parseAuthorization(header) {
    const result = {};
    const body = String(header || "").replace(/^Digest\s+/i, "");
    const matcher = /([A-Za-z0-9_-]+)=("(?:[^"\\]|\\.)*"|[^,\s]+)/g;
    let match;
    while ((match = matcher.exec(body))) {
        let value = match[2];
        if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
        result[match[1].toLowerCase()] = value;
    }
    return result;
}

test("Digest-auth recorder stream reaches the mapped ONVIF PullPoint bus", async () => {
    const realm = "Dahua";
    const nonce = "0123456789abcdef";
    const username = "admin";
    const password = "secret";
    let authenticatedRequests = 0;

    const server = http.createServer((req, res) => {
        const authorization = req.headers.authorization;
        if (!authorization) {
            res.writeHead(401, {
                "WWW-Authenticate":
                    'Digest realm="' + realm + '", nonce="' + nonce +
                    '", qop="auth", algorithm=MD5'
            });
            res.end();
            return;
        }

        const fields = parseAuthorization(authorization);
        const ha1 = md5(username + ":" + realm + ":" + password);
        const ha2 = md5("GET:" + fields.uri);
        const expected = md5(
            ha1 + ":" + nonce + ":" + fields.nc + ":" +
            fields.cnonce + ":auth:" + ha2
        );

        assert.equal(fields.username, username);
        assert.equal(fields.realm, realm);
        assert.equal(fields.nonce, nonce);
        assert.equal(fields.response, expected);
        authenticatedRequests += 1;

        res.writeHead(200, {
            "Content-Type": "multipart/x-mixed-replace; boundary=myboundary",
            "Cache-Control": "no-cache"
        });
        res.write(
            "--myboundary\r\n" +
            "Content-Type: text/plain\r\n\r\n" +
            "Code=SmartMotionHuman;action=Start;index=0\r\n"
        );
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    const bus = new EventBus({ topics: DEFAULT_TOPICS });
    const subscription = bus.createSubscription({ ttlMs: 60000 });
    const dispatcher = new AnalyticsDispatcher();
    dispatcher.registerTarget("VirtualCam1", {
        eventBus: bus,
        videoSourceConfigToken: "source-1"
    });

    const router = new DahuaAnalyticsRouter({
        source: "lorex",
        channelMap: { 0: "VirtualCam1" }
    });
    const runtime = new DahuaRecorderRuntime({ router, dispatcher });
    const client = new DahuaEventClient({
        url:
            "http://127.0.0.1:" + port +
            "/cgi-bin/eventManager.cgi?action=attach&codes=[All]&heartbeat=5",
        username,
        password,
        reconnectPeriod: 5000,
        connectTimeout: 2000,
        inactivityTimeout: 5000
    });

    client.on("data", (chunk) => runtime.push(chunk));
    client.on("state", (health) => {
        if (health.state === "connected") runtime.connect();
        if (health.state === "disconnected") runtime.disconnect();
    });

    try {
        const published = once(dispatcher, "published");
        client.start();
        await published;

        const messages = bus.pull(subscription.id, 10).messages;
        assert.equal(authenticatedRequests, 1);
        assert.equal(messages.length, 1);
        assert.equal(messages[0].topic, TOPICS.PERSON);
        assert.equal(messages[0].data.State, true);
        assert.equal(runtime.health().eventsDispatched, 1);
        assert.equal(client.health().authChallenges, 1);
    } finally {
        client.stop();
        runtime.stop();
        await new Promise((resolve) => server.close(resolve));
    }
});

test("unsupported Digest qop fails closed", () => {
    const { buildAuthorization } = require("../src/dahua-event-client");
    assert.throws(
        () => buildAuthorization(
            'Digest realm="Dahua", nonce="abc", qop="auth-int"',
            {
                username: "admin",
                password: "secret",
                method: "GET",
                uri: "/events"
            }
        ),
        /qop=auth/
    );
});
