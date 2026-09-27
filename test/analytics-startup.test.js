const test = require("node:test");
const assert = require("node:assert/strict");
const EventEmitter = require("events");
const { configureAnalytics } = require("../main");
const { AnalyticsCoordinator } = require("../src/analytics-coordinator");

test("optional Frigate runtime connects and dispatches to a live camera", async () => {
    const coordinator = new AnalyticsCoordinator();
    const published = [];
    coordinator.dispatcher.registerTarget("Camera-Test", { eventBus: { publish: (event) => published.push(event) }, videoSourceConfigToken: "source" });
    const client = new EventEmitter();
    client.subscribe = (_topics, _options, done) => done(null);
    client.end = (_force, _options, done) => done();
    let receivedOptions;
    configureAnalytics({ analytics: { frigate: {
        url: "mqtt://broker:1883", cameraMap: { front: "Camera-Test" }, topicPrefix: "frigate",
        usernameEnv: "MQTT_USER", passwordEnv: "MQTT_PASS"
    } } }, coordinator, { MQTT_USER: "viewer", MQTT_PASS: "secret" }, (url, options) => {
        assert.equal(url, "mqtt://broker:1883");
        receivedOptions = options;
        return client;
    });
    await coordinator.start();
    assert.equal(receivedOptions.username, "viewer");
    assert.equal(receivedOptions.password, "secret");
    client.emit("connect");
    client.emit("message", "frigate/front/motion", "ON");
    assert.equal(published.length, 1);
    await coordinator.stop();
});

test("missing MQTT secret fails without starting an adapter", () => {
    const coordinator = new AnalyticsCoordinator();
    assert.throws(() => configureAnalytics({ analytics: { frigate: {
        url: "mqtt://broker", cameraMap: { front: "Camera-Test" },
        usernameEnv: "MQTT_USER", passwordEnv: "MQTT_PASS"
    } } }, coordinator, { MQTT_USER: "viewer" }), /credentials are missing/);
    assert.equal(coordinator.runtimes.length, 0);
});

test("configured recorder owns authenticated event transport lifecycle", async () => {
    const coordinator = new AnalyticsCoordinator();
    const requests = [];
    const request = (options, callback) => {
        const handle = new EventEmitter();
        handle.end = () => {
            requests.push(options);
            const response = new EventEmitter();
            response.statusCode = 200;
            response.headers = {};
            response.destroy = () => {};
            queueMicrotask(() => callback(response));
        };
        handle.destroy = () => {};
        return handle;
    };
    configureAnalytics({ analytics: { recorders: [{
        name: "lorex", source: "lorex", url: "http://recorder/events",
        usernameEnv: "NVR_USER", passwordEnv: "NVR_PASS", channelMap: { 0: "Camera-Test" },
        reconnectMinMs: 1000, reconnectMaxMs: 30000, inactivityTimeoutMs: 60000
    }] } }, coordinator, { NVR_USER: "viewer", NVR_PASS: "secret" }, undefined, request);
    await coordinator.start();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests.length, 1);
    assert.equal(coordinator.health().adapters["recorder:lorex"].state, "connected");
    await coordinator.stop();
    assert.equal(coordinator.health().state, "stopped");
});

test("missing recorder secret prevents adapter registration", () => {
    const coordinator = new AnalyticsCoordinator();
    assert.throws(() => configureAnalytics({ analytics: { recorders: [{
        name: "lorex", source: "lorex", url: "http://recorder/events",
        usernameEnv: "NVR_USER", passwordEnv: "NVR_PASS", channelMap: { 0: "Camera-Test" }
    }] } }, coordinator, { NVR_USER: "viewer" }), /credentials are missing/);
    assert.equal(coordinator.runtimes.length, 0);
});
