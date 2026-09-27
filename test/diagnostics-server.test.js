const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const {
    DiagnosticsServer,
    buildSystemHealth,
    cameraHealthy,
    analyticsHealthy
} = require("../src/diagnostics-server");

const READY_LIFECYCLE = Object.freeze({
    configLoaded: true,
    networkResolved: true,
    httpReady: true,
    eventReady: true,
    snapshotReady: true,
    rtspProxyReady: true,
    discoveryReady: true
});

function camera(overrides = {}) {
    return {
        name: "VirtualCam1",
        state: "running",
        startedAt: "2026-09-27T14:00:00.000Z",
        restartCount: 0,
        lastNetworkChangeAt: null,
        interface: "vcam-1",
        ip: "192.168.50.225",
        sourceHost: "192.168.50.57",
        lifecycle: { ...READY_LIFECYCLE },
        rtsp: { ready: true, activeSessions: 2 },
        events: {
            topics: 4,
            subscriptions: 1,
            retained: 2,
            queued: 0,
            waiters: 1,
            sequence: 10
        },
        ...overrides
    };
}

function analytics(overrides = {}) {
    return {
        frigate: {
            state: "connected",
            available: true,
            connectedAt: "2026-09-27T14:00:00.000Z",
            lastMessageAt: "2026-09-27T14:01:00.000Z",
            messagesReceived: 12,
            eventsDispatched: 3,
            droppedMessages: 0,
            errors: 0
        },
        recorders: [{
            name: "lorex",
            client: { state: "connected", connections: 1, errors: 0 },
            runtime: {
                state: "connected",
                eventsReceived: 5,
                eventsDispatched: 5,
                droppedEvents: 0,
                errors: 0
            }
        }],
        targets: ["VirtualCam1"],
        ...overrides
    };
}

function request(port, path, method = "GET") {
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: "127.0.0.1",
            port,
            path,
            method
        }, (res) => {
            const chunks = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => {
                resolve({
                    statusCode: res.statusCode,
                    headers: res.headers,
                    body: Buffer.concat(chunks).toString("utf8")
                });
            });
        });
        req.on("error", reject);
        req.end();
    });
}

test("system health reports healthy cameras and analytics", () => {
    const manager = { health: () => camera() };
    const analyticsManager = { health: () => analytics() };

    const health = buildSystemHealth({
        cameraManagers: [manager],
        analyticsManager,
        startedAt: 1000,
        now: () => 11000
    });

    assert.equal(health.status, "healthy");
    assert.equal(health.uptimeSeconds, 10);
    assert.equal(health.cameras.total, 1);
    assert.equal(health.cameras.healthy, 1);
    assert.equal(cameraHealthy(health.cameras.items[0]), true);
    assert.equal(analyticsHealthy(health.analytics), true);
});

test("camera and analytics degradation affect readiness", () => {
    assert.equal(cameraHealthy(camera({
        lifecycle: { ...READY_LIFECYCLE, discoveryReady: false }
    })), false);

    assert.equal(analyticsHealthy(analytics({
        frigate: { state: "offline", available: false }
    })), false);

    assert.equal(analyticsHealthy({
        frigate: null,
        recorders: [{
            client: { state: "reconnecting" },
            runtime: { state: "disconnected" }
        }]
    }), false);
});

test("diagnostics HTTP server returns compact readiness and full status", { timeout: 5000 }, async () => {
    let current = buildSystemHealth({
        cameraManagers: [{ health: () => camera() }],
        analyticsManager: { health: () => analytics() },
        startedAt: Date.now()
    });

    const server = new DiagnosticsServer({
        host: "127.0.0.1",
        port: 0,
        healthProvider: () => current
    });

    await server.start();
    const port = server.address().port;

    try {
        const healthz = await request(port, "/healthz");
        assert.equal(healthz.statusCode, 200);
        assert.equal(healthz.headers["cache-control"], "no-store");
        const compact = JSON.parse(healthz.body);
        assert.equal(compact.status, "healthy");
        assert.deepEqual(compact.cameras, { total: 1, healthy: 1 });
        assert.equal(compact.analytics.frigate, "connected");

        const status = await request(port, "/status");
        assert.equal(status.statusCode, 200);
        const detailed = JSON.parse(status.body);
        assert.equal(detailed.cameras.items[0].rtsp.activeSessions, 2);
        assert.equal(detailed.cameras.items[0].events.subscriptions, 1);

        const serialized = JSON.stringify(detailed);
        assert.equal(serialized.includes("password"), false);
        assert.equal(serialized.includes("rtsp://"), false);

        current = {
            ...current,
            status: "degraded",
            cameras: {
                ...current.cameras,
                healthy: 0
            }
        };

        const degraded = await request(port, "/healthz");
        assert.equal(degraded.statusCode, 503);
        assert.equal(JSON.parse(degraded.body).status, "degraded");

        const notFound = await request(port, "/missing");
        assert.equal(notFound.statusCode, 404);

        const method = await request(port, "/healthz", "POST");
        assert.equal(method.statusCode, 405);
        assert.equal(method.headers.allow, "GET");
    } finally {
        await server.stop();
    }
});
