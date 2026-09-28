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
    assert.equal(dispatcher.health()[0].eventsDispatched, 2);
    assert.match(dispatcher.health()[0].lastEventAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("dispatcher reports routed event evidence separately for every camera", () => {
    const dispatcher = new AnalyticsDispatcher({
        now: () => Date.parse("2026-09-28T12:00:00.000Z")
    });
    const firstBus = new EventBus({ topics: DEFAULT_TOPICS });
    const secondBus = new EventBus({ topics: DEFAULT_TOPICS });

    dispatcher.registerTarget("VirtualCam1", { eventBus: firstBus });
    dispatcher.registerTarget("VirtualCam2", { eventBus: secondBus });
    dispatcher.dispatch({
        source: "frigate",
        camera: "VirtualCam1",
        type: "motion",
        active: true
    });

    assert.deepEqual(dispatcher.health(), [
        {
            camera: "VirtualCam1",
            eventsDispatched: 1,
            lastEventAt: "2026-09-28T12:00:00.000Z"
        },
        { camera: "VirtualCam2", eventsDispatched: 0, lastEventAt: null }
    ]);
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
