const test = require("node:test");
const assert = require("node:assert/strict");

const { AnalyticsDispatcher } = require("../src/analytics-dispatcher");
const { EventBus } = require("../src/event-bus");
const { DEFAULT_TOPICS, TOPICS } = require("../src/event-topics");
const { FrigateMqttRouter } = require("../src/frigate-mqtt-router");

test("Frigate MQTT events reach the mapped virtual camera ONVIF bus", () => {
    const bus = new EventBus({ topics: DEFAULT_TOPICS });
    const subscription = bus.createSubscription({ ttlMs: 60000 });
    const dispatcher = new AnalyticsDispatcher();
    const router = new FrigateMqttRouter({
        cameraMap: {
            front: "VirtualCam1"
        }
    });

    dispatcher.registerTarget("VirtualCam1", {
        eventBus: bus,
        videoSourceConfigToken: "video_source_config_hq_virtual_cam_1"
    });
    router.on("analytics", (event) => dispatcher.dispatch(event));

    router.route("frigate/front/motion", "ON");
    router.route("frigate/events", JSON.stringify({
        type: "new",
        after: {
            id: "person-1",
            camera: "front",
            label: "person",
            frame_time: 1790478000,
            top_score: 0.94
        }
    }));

    const pulled = bus.pull(subscription.id, 10);

    assert.equal(pulled.messages.length, 2);
    assert.deepEqual(
        pulled.messages.map((event) => event.topic),
        [TOPICS.MOTION, TOPICS.PERSON]
    );
    assert.deepEqual(pulled.messages[0].data, { IsMotion: true });
    assert.deepEqual(pulled.messages[1].data, { State: true });
    assert.equal(
        pulled.messages[1].source.VideoSourceConfigurationToken,
        "video_source_config_hq_virtual_cam_1"
    );
});

test("dispatcher resolves live target providers and drops unknown cameras safely", () => {
    const firstBus = new EventBus({ topics: DEFAULT_TOPICS });
    const secondBus = new EventBus({ topics: DEFAULT_TOPICS });
    let activeBus = firstBus;
    const dispatcher = new AnalyticsDispatcher();
    const unmapped = [];

    dispatcher.registerTarget("VirtualCam1", () => ({
        eventBus: activeBus,
        videoSourceConfigToken: "source-token"
    }));
    dispatcher.on("unmapped", (camera) => unmapped.push(camera));

    dispatcher.dispatch({
        source: "frigate",
        camera: "VirtualCam1",
        type: "motion",
        active: true
    });
    activeBus = secondBus;
    dispatcher.dispatch({
        source: "frigate",
        camera: "VirtualCam1",
        type: "motion",
        active: false
    });

    assert.equal(firstBus.retained.size, 1);
    assert.equal(secondBus.retained.size, 1);
    assert.equal(dispatcher.dispatch({
        source: "frigate",
        camera: "MissingCam",
        type: "motion",
        active: true
    }), null);
    assert.deepEqual(unmapped, ["MissingCam"]);
});

test("a detection while its camera is offline can publish when the camera returns", () => {
    const bus = new EventBus({ topics: DEFAULT_TOPICS });
    const dispatcher = new AnalyticsDispatcher();
    let online = false;
    dispatcher.registerTarget("Camera", () => online ? { eventBus: bus, videoSourceConfigToken: "source" } : null);
    const event = { source: "frigate", camera: "Camera", type: "person", objectId: "one", active: true };
    assert.equal(dispatcher.dispatch(event), null);
    online = true;
    assert.ok(dispatcher.dispatch(event));
    assert.equal(bus.retained.size, 1);
});
