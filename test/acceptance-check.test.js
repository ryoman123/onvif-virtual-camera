const test = require("node:test");
const assert = require("node:assert/strict");

const { evaluateAcceptance } = require("../src/acceptance-check");
const { parseArgs, run } = require("../tools/acceptance-check");

const lifecycle = Object.freeze({
    configLoaded: true,
    networkResolved: true,
    httpReady: true,
    eventReady: true,
    snapshotReady: true,
    rtspProxyReady: true,
    discoveryReady: true
});

function status(overrides = {}) {
    return {
        status: "healthy",
        cameras: {
            total: 2,
            healthy: 2,
            items: [
                { name: "Cam1", state: "running", ip: "192.0.2.1", interface: "vcam-1", lifecycle },
                { name: "Cam2", state: "running", ip: "192.0.2.2", interface: "vcam-2", lifecycle }
            ]
        },
        analytics: {
            targets: ["Cam1", "Cam2"],
            frigate: { state: "connected", available: true },
            recorders: [{
                name: "lorex",
                client: { state: "connected" },
                runtime: { state: "connected" }
            }]
        },
        ...overrides
    };
}

test("acceptance validates camera identities and required analytics", () => {
    const result = evaluateAcceptance(status(), {
        expectedCameras: 2,
        requireFrigate: true,
        requireRecorders: ["lorex"]
    });
    assert.equal(result.passed, true);
    assert.equal(result.cameras.found, 2);
});

test("acceptance reports routing, lifecycle and connection failures", () => {
    const broken = status();
    broken.cameras.items[1] = {
        ...broken.cameras.items[1],
        lifecycle: { ...lifecycle, eventReady: false }
    };
    broken.analytics.targets = ["Cam1", "Ghost"];
    broken.analytics.frigate.state = "reconnecting";
    broken.analytics.recorders[0].client.state = "reconnecting";

    const result = evaluateAcceptance(broken, {
        expectedCameras: 29,
        requireFrigate: true
    });
    assert.equal(result.passed, false);
    assert.ok(result.failures.some((failure) => failure.includes("expected 29")));
    assert.ok(result.failures.some((failure) => failure.includes("eventReady")));
    assert.ok(result.failures.some((failure) => failure.includes("missing analytics target")));
    assert.ok(result.failures.some((failure) => failure.includes("Frigate state")));
    assert.ok(result.failures.some((failure) => failure.includes("client state")));
});

test("acceptance never passes an empty or internally inconsistent inventory", () => {
    const result = evaluateAcceptance({
        status: "healthy",
        cameras: { total: 29, healthy: 29, items: [] },
        analytics: { targets: [], recorders: [] }
    });

    assert.equal(result.passed, false);
    assert.ok(result.failures.some((failure) => failure.includes("no virtual cameras")));
    assert.ok(result.failures.some((failure) => failure.includes("camera total reports 29")));
    assert.ok(result.failures.some((failure) => failure.includes("only 29 of 0")));
});

test("CLI arguments support 29-camera soak acceptance", () => {
    assert.deepEqual(parseArgs([
        "--expected-cameras", "29",
        "--require-frigate",
        "--require-recorder", "lorex",
        "--require-recorder", "nvr69",
        "--soak-seconds", "3600",
        "--interval-seconds", "15"
    ]), {
        url: "http://127.0.0.1:9090/status",
        expectedCameras: 29,
        requireFrigate: true,
        requireRecorders: ["lorex", "nvr69"],
        soakSeconds: 3600,
        intervalSeconds: 15,
        timeoutMs: 5000
    });
});

test("soak exits on the first degraded sample", async () => {
    let requests = 0;
    let waits = 0;
    const result = await run({
        url: "http://example/status",
        expectedCameras: 2,
        requireFrigate: false,
        requireRecorders: [],
        soakSeconds: 60,
        intervalSeconds: 1,
        timeoutMs: 100
    }, {
        fetchJson: async () => {
            requests += 1;
            return requests === 1 ? status() : status({ status: "degraded" });
        },
        delay: async () => {
            waits += 1;
        }
    });

    assert.equal(result.passed, false);
    assert.equal(result.samples, 2);
    assert.equal(waits, 1);
});
