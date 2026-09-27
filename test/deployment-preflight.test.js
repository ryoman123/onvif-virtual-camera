const test = require("node:test");
const assert = require("node:assert/strict");
const { buildDeploymentPreflight, collectRequiredEnvironment } = require("../src/deployment-preflight");

function configuration() {
    return {
        cameras: [
            { name: "Camera-1", ipAssignment: { mode: "static" } },
            { name: "Camera-2", ipAssignment: { mode: "dhcp" } },
            { name: "Camera-3", ipAssignment: { mode: "static" } }
        ],
        analytics: {
            frigate: {
                cameraMap: { front: "Camera-1" },
                usernameEnv: "MQTT_USER",
                passwordEnv: "MQTT_PASS"
            },
            recorders: [{
                usernameEnv: "NVR_USER",
                passwordEnv: "NVR_PASS",
                channelMap: { 0: "Camera-2", 1: "Camera-3" }
            }]
        }
    };
}

test("preflight proves camera count, environment, and complete analytics coverage", () => {
    const report = buildDeploymentPreflight(configuration(), {
        expectedCameraCount: 3,
        requireAnalyticsCoverage: true,
        env: { MQTT_USER: "viewer", MQTT_PASS: "secret", NVR_USER: "viewer", NVR_PASS: "secret" }
    });

    assert.equal(report.ok, true);
    assert.equal(report.cameraCount, 3);
    assert.equal(report.staticCameraCount, 2);
    assert.equal(report.dhcpCameraCount, 1);
    assert.equal(report.analytics.coveredCameraCount, 3);
    assert.equal(report.analytics.frigateMappings, 1);
    assert.equal(report.analytics.recorderMappings, 2);
    assert.deepEqual(report.missingEnvironment, []);
});

test("preflight fails closed on identity count, missing secrets, and uncovered cameras", () => {
    const config = configuration();
    delete config.analytics.recorders[0].channelMap[1];
    const report = buildDeploymentPreflight(config, {
        expectedCameraCount: 29,
        requireAnalyticsCoverage: true,
        env: { MQTT_USER: "viewer", MQTT_PASS: "secret" }
    });

    assert.equal(report.ok, false);
    assert.deepEqual(report.missingEnvironment, ["NVR_USER", "NVR_PASS"]);
    assert.deepEqual(report.analytics.uncoveredCameras, ["Camera-3"]);
    assert.match(report.failures.join("\n"), /Expected 29 virtual cameras/);
    assert.match(report.failures.join("\n"), /Missing required environment variables/);
    assert.match(report.failures.join("\n"), /Analytics coverage is missing/);
});

test("required environment names are deduplicated without reading secret values", () => {
    const config = configuration();
    config.analytics.recorders.push({
        usernameEnv: "NVR_USER", passwordEnv: "NVR_PASS", channelMap: { 2: "Camera-3" }
    });
    assert.deepEqual(collectRequiredEnvironment(config), ["MQTT_USER", "MQTT_PASS", "NVR_USER", "NVR_PASS"]);
});

test("expected camera count must be a positive integer", () => {
    assert.throws(() => buildDeploymentPreflight(configuration(), { expectedCameraCount: "all" }), /positive integer/);
});
