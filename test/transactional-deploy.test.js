const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
    deploy,
    isImmutableImageReference,
    parseArgs,
    rollback,
    timestampName,
    waitForAcceptance,
    waitForHealthy
} = require("../tools/transactional-deploy");

const CANDIDATE_IMAGE =
    "ghcr.io/example/vcam@sha256:" + "a".repeat(64);

function status() {
    return {
        status: "healthy",
        cameras: {
            total: 1,
            healthy: 1,
            items: [{
                name: "Cam1",
                mac: "02:00:00:00:00:01",
                identity: { serialNumber: "SER1", hardwareId: "HW1" },
                state: "running",
                ip: "192.0.2.1",
                interface: "vcam-1",
                lifecycle: {
                    configLoaded: true, networkResolved: true, httpReady: true,
                    eventReady: true, snapshotReady: true, rtspProxyReady: true,
                    discoveryReady: true
                }
            }]
        },
        analytics: { targets: ["Cam1"], recorders: [] }
    };
}

function fakeDocker(handler) {
    const calls = [];
    return {
        calls,
        run(args) {
            calls.push(args);
            return handler(args, calls) || { ok: true, stdout: "", stderr: "" };
        }
    };
}

function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "onvif-deploy-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const config = path.join(directory, "config.yml");
    fs.writeFileSync(config, "virtual_cameras: []\n");
    return { directory, config };
}

test("deployment CLI is dry-run by default and requires an explicit image", () => {
    assert.throws(() => parseArgs(["deploy"]), /requires --image/);
    const options = parseArgs(["deploy", "--image", "ghcr.io/example/vcam@sha256:abc"]);
    assert.equal(options.apply, false);
    assert.equal(options.expectedCameras, 29);
    assert.equal(options.container, "onvif-vcam-server");
    const gated = parseArgs([
        "deploy", "--image", "candidate",
        "--require-pullpoint-subscribers",
        "--min-pullpoint-messages", "1",
        "--max-pullpoint-idle-seconds", "120",
        "--min-camera-analytics-events", "1",
        "--min-camera-smart-messages", "1"
    ]);
    assert.equal(gated.requirePullPointSubscribers, true);
    assert.equal(gated.minPullPointMessages, 1);
    assert.equal(gated.maxPullPointIdleSeconds, 120);
    assert.equal(gated.minCameraAnalyticsEvents, 1);
    assert.equal(gated.minCameraSmartMessages, 1);
    assert.throws(() => parseArgs([
        "deploy", "--image", "candidate", "--min-camera-smart-messages", "0"
    ]), /positive integer/);
    assert.throws(() => parseArgs([
        "deploy", "--image", "candidate", "--max-pullpoint-idle-seconds", "0"
    ]), /positive integer/);
});

test("applied deployment requires an immutable image before Docker changes", async (t) => {
    const { config } = fixture(t);
    const docker = fakeDocker(() => ({ ok: true, stdout: "", stderr: "" }));
    let fetched = false;

    assert.equal(isImmutableImageReference(CANDIDATE_IMAGE), true);
    assert.equal(isImmutableImageReference("ghcr.io/example/vcam:grand-design"), false);
    await assert.rejects(() => deploy(parseArgs([
        "deploy", "--image", "ghcr.io/example/vcam:grand-design",
        "--config", config, "--apply"
    ]), {
        docker,
        fetchJson: async () => {
            fetched = true;
            return status();
        }
    }), /immutable sha256 image digest/);

    assert.equal(fetched, false);
    assert.equal(docker.calls.length, 0);
});

test("deployment acceptance can require routed and delivered smart events", async () => {
    const current = status();
    current.cameras.items[0].events = {
        messagesDeliveredByTopic: { "UserAlarm/IVA/HumanShapeDetect": 1 }
    };
    current.analytics.routing = [{ camera: "Cam1", eventsDispatched: 1 }];

    const result = await waitForAcceptance({
        expectedCameras: 1,
        requireFrigate: false,
        requireRecorders: [],
        requirePullPointSubscribers: false,
        minCameraAnalyticsEvents: 1,
        minCameraSmartMessages: 1,
        url: "http://example/status",
        timeoutSeconds: 1,
        intervalSeconds: 1
    }, {
        cameras: [{
            name: "Cam1",
            mac: "02:00:00:00:00:01",
            serialNumber: "SER1",
            hardwareId: "HW1"
        }]
    }, {
        fetchJson: async () => current,
        now: () => 0,
        delay: async () => {}
    });

    assert.equal(result.passed, true);
});

test("deployment acceptance rejects stale or undelivered PullPoint consumers", async () => {
    const current = status();
    current.timestamp = "2026-09-28T18:00:00.000Z";
    current.cameras.items[0].events = {
        subscriptions: 1,
        messagesDelivered: 0,
        lastPullRequestAt: "2026-09-28T17:50:00.000Z"
    };
    let clock = 0;

    await assert.rejects(() => waitForAcceptance({
        expectedCameras: 1,
        requireFrigate: false,
        requireRecorders: [],
        requirePullPointSubscribers: true,
        minPullPointMessages: 1,
        maxPullPointIdleSeconds: 120,
        url: "http://example/status",
        timeoutSeconds: 1,
        intervalSeconds: 1
    }, {
        cameras: [{
            name: "Cam1",
            mac: "02:00:00:00:00:01",
            serialNumber: "SER1",
            hardwareId: "HW1"
        }]
    }, {
        fetchJson: async () => current,
        now: () => { clock += 1000; return clock; },
        delay: async () => {}
    }), /delivered 0 PullPoint message.*consumer idle for 600s/);
});

test("rollback names are deterministic and Docker-safe", () => {
    assert.equal(
        timestampName("onvif-vcam-server", new Date("2026-09-28T09:15:30.123Z")),
        "onvif-vcam-server-rollback-20260928T091530Z"
    );
});

test("health wait fails immediately when the candidate exits", async () => {
    const docker = fakeDocker(() => ({ ok: true, stdout: "exited unhealthy", stderr: "" }));
    await assert.rejects(() => waitForHealthy("candidate", {
        timeoutSeconds: 180,
        intervalSeconds: 2
    }, {
        docker,
        now: () => 0,
        delay: async () => {}
    }), /candidate entered exited state/);
});

test("dry-run validates the live identity without stopping the container", async (t) => {
    const { config } = fixture(t);
    const docker = fakeDocker((args) => {
        if (args[0] === "inspect" && args[1] === "--format") return { ok: true, stdout: "true", stderr: "" };
        if (args[0] === "inspect") return { ok: false, stdout: "", stderr: "missing" };
        if (args[0] === "image") return { ok: true, stdout: "{}", stderr: "" };
    });
    const result = await deploy({
        ...parseArgs(["deploy", "--image", "candidate", "--config", config, "--expected-cameras", "1"])
    }, { docker, fetchJson: async () => status(), nowDate: () => new Date("2026-09-28T09:15:30Z") });

    assert.equal(result.applied, false);
    assert.equal(docker.calls.some((args) => args[0] === "stop"), false);
});

test("successful deployment preserves the old container and passes identity acceptance", async (t) => {
    const { directory, config } = fixture(t);
    const docker = fakeDocker((args) => {
        if (args[0] === "inspect" && args[1] === "--format") {
            return { ok: true, stdout: args[2].includes("Health") ? "healthy" : "true", stderr: "" };
        }
        if (args[0] === "inspect") return { ok: false, stdout: "", stderr: "missing" };
        if (args[0] === "image") return { ok: true, stdout: "{}", stderr: "" };
    });
    const result = await deploy(parseArgs([
        "deploy", "--image", CANDIDATE_IMAGE, "--config", config,
        "--expected-cameras", "1", "--checkpoint-dir", directory, "--apply"
    ]), {
        docker,
        fetchJson: async () => status(),
        nowDate: () => new Date("2026-09-28T09:15:30Z"),
        now: () => 0,
        delay: async () => {}
    });

    assert.equal(result.applied, true);
    assert.equal(result.acceptance.passed, true);
    assert.equal(fs.statSync(result.identityPath).mode & 0o777, 0o600);
    assert.ok(docker.calls.some((args) => args[0] === "rename" && args[2].includes("rollback")));
    assert.equal(docker.calls.some((args) => args[0] === "rm"), false);
});

test("deployment waits for Protect to recreate its PullPoint subscription", async (t) => {
    const { directory, config } = fixture(t);
    const docker = fakeDocker((args) => {
        if (args[0] === "inspect" && args[1] === "--format") {
            return { ok: true, stdout: args[2].includes("Health") ? "healthy" : "true", stderr: "" };
        }
        if (args[0] === "inspect") return { ok: false, stdout: "", stderr: "missing" };
        if (args[0] === "image") return { ok: true, stdout: "{}", stderr: "" };
    });
    let requests = 0;
    let waits = 0;
    const result = await deploy(parseArgs([
        "deploy", "--image", CANDIDATE_IMAGE, "--config", config,
        "--expected-cameras", "1", "--checkpoint-dir", directory,
        "--require-pullpoint-subscribers", "--apply"
    ]), {
        docker,
        fetchJson: async () => {
            requests += 1;
            const value = status();
            value.cameras.items[0].events = { subscriptions: requests >= 3 ? 1 : 0 };
            return value;
        },
        nowDate: () => new Date("2026-09-28T09:15:30Z"),
        now: () => 0,
        delay: async () => { waits += 1; }
    });

    assert.equal(result.applied, true);
    assert.equal(requests, 3);
    assert.equal(waits, 1);
});

test("failed candidate acceptance restores the previous container automatically", async (t) => {
    const { directory, config } = fixture(t);
    const docker = fakeDocker((args) => {
        if (args[0] === "inspect" && args[1] === "--format") {
            return { ok: true, stdout: args[2].includes("Health") ? "healthy" : "true", stderr: "" };
        }
        if (args[0] === "inspect") {
            const isCandidateAfterRename = args.length === 2 && docker.calls.some((call) => call[0] === "rename");
            return { ok: isCandidateAfterRename, stdout: "{}", stderr: "missing" };
        }
        if (args[0] === "image") return { ok: true, stdout: "{}", stderr: "" };
    });
    let requests = 0;
    await assert.rejects(() => deploy(parseArgs([
        "deploy", "--image", CANDIDATE_IMAGE, "--config", config,
        "--expected-cameras", "1", "--checkpoint-dir", directory, "--apply"
    ]), {
        docker,
        fetchJson: async () => {
            requests += 1;
            const value = status();
            if (requests === 2) value.cameras.items[0].mac = "02:00:00:00:00:ff";
            return value;
        },
        nowDate: () => new Date("2026-09-28T09:15:30Z"),
        now: (() => { let clock = 0; return () => { clock += 200000; return clock; }; })(),
        delay: async () => {}
    }), /previous container restored automatically/);

    assert.ok(docker.calls.some((args) => args[0] === "rm" && args[1] === "-f"));
    assert.ok(docker.calls.some((args) => args[0] === "start" && args[1] === "onvif-vcam-server"));
});

test("failed rollback-container rename restarts the stopped current container", async (t) => {
    const { directory, config } = fixture(t);
    const docker = fakeDocker((args) => {
        if (args[0] === "inspect" && args[1] === "--format") return { ok: true, stdout: "true", stderr: "" };
        if (args[0] === "inspect") return { ok: false, stdout: "", stderr: "missing" };
        if (args[0] === "image") return { ok: true, stdout: "{}", stderr: "" };
        if (args[0] === "rename") return { ok: false, stdout: "", stderr: "rename failed" };
    });
    await assert.rejects(() => deploy(parseArgs([
        "deploy", "--image", CANDIDATE_IMAGE, "--config", config,
        "--expected-cameras", "1", "--checkpoint-dir", directory, "--apply"
    ]), {
        docker,
        fetchJson: async () => status(),
        nowDate: () => new Date("2026-09-28T09:15:30Z")
    }), /current container restarted automatically/);
    assert.ok(docker.calls.some((args) => args[0] === "start" && args[1] === "onvif-vcam-server"));
});

test("explicit rollback requires --apply before changing containers", () => {
    const docker = fakeDocker(() => ({ ok: true, stdout: "{}", stderr: "" }));
    const dryRun = rollback(parseArgs([
        "rollback", "--rollback-container", "onvif-vcam-server-rollback-20260928T091530Z"
    ]), { docker });
    assert.equal(dryRun.applied, false);
    assert.equal(docker.calls.length, 0);
});

test("explicit rollback preserves the replaced candidate container", () => {
    const docker = fakeDocker((args) => {
        if (args[0] === "inspect") {
            if (args[1]?.includes("replaced")) return { ok: false, stdout: "", stderr: "missing" };
            return { ok: true, stdout: "{}", stderr: "" };
        }
    });
    const result = rollback(parseArgs([
        "rollback", "--rollback-container", "onvif-vcam-server-rollback-20260928T091530Z", "--apply"
    ]), { docker, nowDate: () => new Date("2026-09-28T10:00:00Z") });

    assert.equal(result.applied, true);
    assert.equal(result.replacedContainer, "onvif-vcam-server-replaced-20260928T100000Z");
    assert.ok(docker.calls.some((args) => args[0] === "rename" && args[2] === result.replacedContainer));
    assert.equal(docker.calls.some((args) => args[0] === "rm"), false);
});

test("failed old-container startup restores the candidate and original rollback checkpoint", () => {
    let failedStart = false;
    const rollbackName = "onvif-vcam-server-rollback-20260928T091530Z";
    const docker = fakeDocker((args) => {
        if (args[0] === "inspect") {
            if (args[1]?.includes("replaced")) return { ok: false, stdout: "", stderr: "missing" };
            return { ok: true, stdout: "{}", stderr: "" };
        }
        if (args[0] === "start" && args[1] === "onvif-vcam-server" && !failedStart) {
            failedStart = true;
            return { ok: false, stdout: "", stderr: "old container failed" };
        }
    });

    assert.throws(() => rollback(parseArgs([
        "rollback", "--rollback-container", rollbackName, "--apply"
    ]), { docker, nowDate: () => new Date("2026-09-28T10:00:00Z") }), /candidate container restored automatically/);

    assert.ok(docker.calls.some((args) => args[0] === "rename"
        && args[1] === "onvif-vcam-server" && args[2] === rollbackName));
    assert.equal(docker.calls.at(-1)[0], "start");
    assert.equal(docker.calls.at(-1)[1], "onvif-vcam-server");
});
