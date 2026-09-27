const http = require("http");
const https = require("https");

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

    if (options.requireFrigate) {
        if (!analytics?.frigate) {
            failures.push("Frigate analytics is not configured");
        } else {
            if (analytics.frigate.state !== "connected") {
                failures.push(`Frigate state is '${analytics.frigate.state}'`);
            }
            if (analytics.frigate.available === false) {
                failures.push("Frigate reports unavailable");
            }
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
    for (const recorder of analytics?.recorders || []) {
        if (recorder.client?.state !== "connected") {
            failures.push(`${recorder.name}: client state is '${recorder.client?.state}'`);
        }
        if (recorder.runtime?.state !== "connected") {
            failures.push(`${recorder.name}: runtime state is '${recorder.runtime?.state}'`);
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

module.exports = {
    READY_LIFECYCLE,
    evaluateAcceptance,
    fetchJson
};
