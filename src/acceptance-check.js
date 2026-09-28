const http = require("http");
const https = require("https");
const { SMART_DETECTION_TOPICS } = require("./event-topics");

const READY_LIFECYCLE = Object.freeze([
    "configLoaded",
    "networkResolved",
    "httpReady",
    "eventReady",
    "snapshotReady",
    "rtspProxyReady",
    "discoveryReady"
]);

function evaluateAcceptance(status, options = {}) {
    const failures = [];
    const cameras = status?.cameras?.items || [];
    const expectedCameras = options.expectedCameras;

    if (status?.status !== "healthy") {
        failures.push(`bridge status is '${status?.status || "missing"}'`);
    }

    if (Number.isInteger(expectedCameras) && cameras.length !== expectedCameras) {
        failures.push(`expected ${expectedCameras} cameras, found ${cameras.length}`);
    }
    if (cameras.length === 0) {
        failures.push("no virtual cameras were reported");
    }
    if (status?.cameras?.total !== cameras.length) {
        failures.push(
            `camera total reports ${status?.cameras?.total ?? "missing"}, but ${cameras.length} item(s) were returned`
        );
    }
    if (status?.cameras?.healthy !== cameras.length) {
        failures.push(
            `only ${status?.cameras?.healthy ?? 0} of ${cameras.length} cameras are healthy`
        );
    }

    const names = cameras.map((camera) => camera.name);
    const uniqueNames = new Set(names);
    if (uniqueNames.size !== names.length) {
        failures.push("camera names are not unique");
    }

    const camerasByName = new Map(cameras.map((camera) => [camera.name, camera]));
    if (
        Array.isArray(options.expectedIdentities)
        && cameras.length !== options.expectedIdentities.length
    ) {
        failures.push(
            `identity manifest contains ${options.expectedIdentities.length} cameras, found ${cameras.length}`
        );
    }
    for (const expected of options.expectedIdentities || []) {
        const camera = camerasByName.get(expected.name);
        if (!camera) {
            failures.push(`expected camera identity '${expected.name}' is missing`);
            continue;
        }
        for (const field of ["mac", "serialNumber", "hardwareId"]) {
            const actual = field === "mac" ? camera.mac : camera.identity?.[field];
            if (actual !== expected[field]) {
                failures.push(
                    `${expected.name}: identity.${field} expected '${expected[field]}', found '${actual ?? "missing"}'`
                );
            }
        }
    }

    for (const camera of cameras) {
        if (camera.state !== "running") {
            failures.push(`${camera.name}: state is '${camera.state}'`);
        }
        if (!camera.ip || !camera.interface) {
            failures.push(`${camera.name}: missing live IP or interface`);
        }
        for (const key of READY_LIFECYCLE) {
            if (camera.lifecycle?.[key] !== true) {
                failures.push(`${camera.name}: lifecycle.${key} is not ready`);
            }
        }
        if (
            options.requirePullPointSubscribers
            && (camera.events?.subscriptions ?? 0) < 1
        ) {
            failures.push(`${camera.name}: no active PullPoint subscriber`);
        }
        if (Number.isInteger(options.minPullPointMessages)) {
            const delivered = camera.events?.messagesDelivered ?? 0;
            if (delivered < options.minPullPointMessages) {
                failures.push(
                    `${camera.name}: delivered ${delivered} PullPoint message(s), ` +
                    `expected at least ${options.minPullPointMessages}`
                );
            }
        }
        if (Number.isInteger(options.minCameraSmartMessages)) {
            const byTopic = camera.events?.messagesDeliveredByTopic || {};
            const delivered = SMART_DETECTION_TOPICS.reduce(
                (total, topic) => total + (byTopic[topic] ?? 0),
                0
            );
            if (delivered < options.minCameraSmartMessages) {
                failures.push(
                    `${camera.name}: delivered ${delivered} smart-detection PullPoint message(s), ` +
                    `expected at least ${options.minCameraSmartMessages}`
                );
            }
        }
        if (Number.isInteger(options.maxPullPointIdleSeconds)) {
            const observedAt = Date.parse(status?.timestamp);
            const lastPullAt = Date.parse(camera.events?.lastPullRequestAt);
            if (!Number.isFinite(observedAt) || !Number.isFinite(lastPullAt)) {
                failures.push(`${camera.name}: no valid recent PullPoint request timestamp`);
            } else {
                const idleSeconds = Math.max(0, Math.floor((observedAt - lastPullAt) / 1000));
                if (idleSeconds > options.maxPullPointIdleSeconds) {
                    failures.push(
                        `${camera.name}: PullPoint consumer idle for ${idleSeconds}s, ` +
                        `maximum is ${options.maxPullPointIdleSeconds}s`
                    );
                }
            }
        }
    }

    const analytics = status?.analytics;
    if (analytics) {
        const targets = new Set(analytics.targets || []);
        for (const name of names) {
            if (!targets.has(name)) {
                failures.push(`${name}: missing analytics target`);
            }
        }
        for (const target of targets) {
            if (!uniqueNames.has(target)) {
                failures.push(`analytics target '${target}' has no camera`);
            }
        }
    }

    if (Number.isInteger(options.minCameraAnalyticsEvents)) {
        const routing = new Map(
            (analytics?.routing || []).map((entry) => [entry.camera, entry])
        );
        for (const name of names) {
            const dispatched = routing.get(name)?.eventsDispatched ?? 0;
            if (dispatched < options.minCameraAnalyticsEvents) {
                failures.push(
                    `${name}: received ${dispatched} routed analytics event(s), ` +
                    `expected at least ${options.minCameraAnalyticsEvents}`
                );
            }
        }
    }

    if (options.requireFrigate) {
        if (!analytics?.frigate) {
            failures.push("Frigate analytics is not configured");
        } else {
            if (analytics.frigate.state !== "connected") {
                failures.push(`Frigate state is '${analytics.frigate.state}'`);
            }
            if (analytics.frigate.available !== true) {
                failures.push(
                    `Frigate availability is '${analytics.frigate.available ?? "unknown"}'`
                );
            }
        }
    }
    if (Number.isInteger(options.minFrigateEvents)) {
        const dispatched = analytics?.frigate?.eventsDispatched ?? 0;
        if (dispatched < options.minFrigateEvents) {
            failures.push(
                `Frigate dispatched ${dispatched} event(s), expected at least ${options.minFrigateEvents}`
            );
        }
    }

    const recorderNames = new Set(
        (analytics?.recorders || []).map((recorder) => recorder.name)
    );
    for (const required of options.requireRecorders || []) {
        if (!recorderNames.has(required)) {
            failures.push(`required recorder '${required}' is missing`);
        }
    }
    for (const name of Object.keys(options.minRecorderEvents || {})) {
        if (!recorderNames.has(name)) {
            failures.push(`event minimum references missing recorder '${name}'`);
        }
    }
    for (const name of Object.keys(options.minRecorderConnections || {})) {
        if (!recorderNames.has(name)) {
            failures.push(`connection minimum references missing recorder '${name}'`);
        }
    }
    for (const recorder of analytics?.recorders || []) {
        if (recorder.client?.state !== "connected") {
            failures.push(`${recorder.name}: client state is '${recorder.client?.state}'`);
        }
        if (recorder.runtime?.state !== "connected") {
            failures.push(`${recorder.name}: runtime state is '${recorder.runtime?.state}'`);
        }
        const minimumEvents = options.minRecorderEvents?.[recorder.name];
        if (Number.isInteger(minimumEvents)) {
            const dispatched = recorder.runtime?.eventsDispatched ?? 0;
            if (dispatched < minimumEvents) {
                failures.push(
                    `${recorder.name}: dispatched ${dispatched} event(s), expected at least ${minimumEvents}`
                );
            }
        }
        const minimumConnections = options.minRecorderConnections?.[recorder.name];
        if (Number.isInteger(minimumConnections)) {
            const connections = recorder.client?.connections ?? 0;
            if (connections < minimumConnections) {
                failures.push(
                    `${recorder.name}: established ${connections} connection(s), expected at least ${minimumConnections}`
                );
            }
        }
    }

    return Object.freeze({
        passed: failures.length === 0,
        failures: Object.freeze(failures),
        cameras: Object.freeze({
            expected: expectedCameras ?? null,
            found: cameras.length,
            healthy: status?.cameras?.healthy ?? 0
        })
    });
}

function fetchJson(url, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const transport = parsed.protocol === "https:" ? https : http;
        const request = transport.get(parsed, { timeout: timeoutMs }, (response) => {
            const chunks = [];
            response.on("data", (chunk) => chunks.push(chunk));
            response.on("end", () => {
                if (response.statusCode !== 200) {
                    reject(new Error(`status endpoint returned HTTP ${response.statusCode}`));
                    return;
                }
                try {
                    resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
                } catch (error) {
                    reject(new Error(`status endpoint returned invalid JSON: ${error.message}`));
                }
            });
        });
        request.on("timeout", () => {
            request.destroy(new Error(`status request timed out after ${timeoutMs}ms`));
        });
        request.on("error", reject);
    });
}

function evaluateContinuity(status, previous = null) {
    const failures = [];
    const startedAt = status?.startedAt;
    const uptimeSeconds = status?.uptimeSeconds;

    if (typeof startedAt !== "string" || !Number.isFinite(Date.parse(startedAt))) {
        failures.push("bridge startedAt is missing or invalid");
    }
    if (!Number.isFinite(uptimeSeconds) || uptimeSeconds < 0) {
        failures.push("bridge uptimeSeconds is missing or invalid");
    }

    if (previous) {
        if (startedAt !== previous.startedAt) {
            failures.push(
                `bridge process restarted during soak (${previous.startedAt} -> ${startedAt || "missing"})`
            );
        }
        if (
            Number.isFinite(uptimeSeconds)
            && Number.isFinite(previous.uptimeSeconds)
            && uptimeSeconds < previous.uptimeSeconds
        ) {
            failures.push(
                `bridge uptime regressed during soak (${previous.uptimeSeconds} -> ${uptimeSeconds})`
            );
        }
    }

    return {
        failures,
        current: { startedAt, uptimeSeconds }
    };
}

module.exports = {
    READY_LIFECYCLE,
    evaluateAcceptance,
    evaluateContinuity,
    fetchJson
};
