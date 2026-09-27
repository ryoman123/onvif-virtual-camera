const test = require("node:test");
const assert = require("node:assert/strict");
const EventEmitter = require("events");

const { AnalyticsDispatcher } = require("../src/analytics-dispatcher");
const { EventBus } = require("../src/event-bus");
const { DEFAULT_TOPICS, TOPICS } = require("../src/event-topics");
const { FrigateMqttRouter } = require("../src/frigate-mqtt-router");
const { FrigateMqttRuntime } = require("../src/frigate-mqtt-runtime");

class FakeMqttClient extends EventEmitter {
    constructor() {
        super();
        this.subscriptions = [];
        this.ended = false;
    }

    subscribe(topics, options, callback) {
        this.subscriptions.push({ topics, options });
        callback(null);
    }

    end(force, options, callback) {
        this.ended = true;
        callback();
    }
}

function fixture() {
    const client = new FakeMqttClient();
    const bus = new EventBus({ topics: DEFAULT_TOPICS });
    const dispatcher = new AnalyticsDispatcher();
    const router = new FrigateMqttRouter({
        cameraMap: { front: "VirtualCam1" }
    });

    dispatcher.registerTarget("VirtualCam1", {
        eventBus: bus,
        videoSourceConfigToken: "source-token"
    });

    const runtime = new FrigateMqttRuntime({
        connect(options) {
            assert.equal(options.reconnectPeriod, 5000);
            return client;
        },
        router,
        dispatcher
    });

    return { client, bus, router, runtime };
}

test("MQTT runtime subscribes on connect and tracks lifecycle health", async () => {
    const { client, router, runtime } = fixture();

    assert.equal(runtime.start(), client);
    assert.equal(runtime.health().state, "connecting");

    client.emit("connect");

    assert.equal(runtime.health().state, "connected");
    assert.deepEqual(
        client.subscriptions[0].topics,
        router.topics()
    );
    assert.deepEqual(client.subscriptions[0].options, { qos: 0 });

    client.emit("reconnect");
    assert.equal(runtime.health().state, "reconnecting");
    client.emit("offline");
    assert.equal(runtime.health().state, "offline");

    await runtime.stop();

    assert.equal(client.ended, true);
    assert.equal(runtime.health().state, "stopped");
});

test("MQTT runtime dispatches motion and object events to the ONVIF bus", () => {
    const { client, bus, runtime } = fixture();
    const subscription = bus.createSubscription({ ttlMs: 60000 });

    runtime.start();
    client.emit("connect");
    client.emit("message", "frigate/available", Buffer.from("online"));
    client.emit("message", "frigate/front/motion", Buffer.from("ON"));
    client.emit("message", "frigate/events", Buffer.from(JSON.stringify({
        type: "new",
        after: {
            id: "event-1",
            camera: "front",
            label: "person",
            frame_time: 1790478000
        }
    })));

    const pulled = bus.pull(subscription.id, 10);
    assert.deepEqual(
        pulled.messages.map((event) => event.topic),
        [TOPICS.MOTION, TOPICS.PERSON]
    );

    const health = runtime.health();
    assert.equal(health.available, "online");
    assert.equal(health.messagesReceived, 3);
    assert.equal(health.eventsDispatched, 2);
    assert.equal(health.droppedMessages, 0);
});

test("MQTT runtime contains malformed and unmapped messages", () => {
    const { client, runtime } = fixture();
    const errors = [];
    runtime.on("runtimeError", (error) => errors.push(error));

    runtime.start();
    client.emit("connect");
    client.emit("message", "frigate/events", Buffer.from("{bad json"));
    client.emit("message", "frigate/unknown/motion", Buffer.from("ON"));

    const health = runtime.health();
    assert.equal(health.messagesReceived, 2);
    assert.equal(health.eventsDispatched, 0);
    assert.equal(health.droppedMessages, 2);
    assert.equal(health.errors, 1);
    assert.equal(errors.length, 1);
});
