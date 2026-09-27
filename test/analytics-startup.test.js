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
