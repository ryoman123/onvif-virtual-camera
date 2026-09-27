const test = require("node:test");
const assert = require("node:assert/strict");
const EventEmitter = require("node:events");

const { AnalyticsRuntimeManager } = require("../src/analytics-runtime-manager");
const { EventBus } = require("../src/event-bus");
const { DEFAULT_TOPICS, TOPICS } = require("../src/event-topics");

class FakeMqttClient extends EventEmitter {
    subscribe(topics, options, callback) {
        this.topics = topics;
        callback(null);
    }

    end(force, options, callback) {
        callback();
    }
}

test("runtime manager wires Frigate MQTT detections into a live camera event bus", async () => {
    const eventBus = new EventBus({ topics: DEFAULT_TOPICS });
    const subscription = eventBus.createSubscription({ ttlMs: 60000 });
    const client = new FakeMqttClient();

    const cameraManager = {
        cameraConfig: { name: "VirtualCam1" },
        getAnalyticsTarget() {
            return {
                eventBus,
                videoSourceConfigToken: "source-1"
            };
        }
    };

    const runtime = new AnalyticsRuntimeManager({
        config: {
            frigate: {
                enabled: true,
                broker: "mqtt://127.0.0.1:1883",
                username: null,
                password: null,
                topic_prefix: "frigate",
                client_id: "test",
                reconnect_period_ms: 0,
                connect_timeout_ms: 1000,
                keepalive_seconds: 0,
                camera_map: {
                    driveway: "VirtualCam1"
                }
            }
        },
        cameraManagers: [cameraManager],
        mqttConnect() {
            return client;
        }
    });

    try {
        runtime.start();
        client.emit("connect");

        const payload = Buffer.from(JSON.stringify({
            type: "new",
            after: {
                id: "object-1",
                camera: "driveway",
                label: "person"
            }
        }));
        client.emit("message", "frigate/events", payload);

        const messages = eventBus.pull(subscription.id, 10).messages;
        assert.equal(messages.length, 1);
        assert.equal(messages[0].topic, TOPICS.PERSON);
        assert.equal(messages[0].data.IsMotion, true);
        assert.equal(runtime.health().frigate.eventsDispatched, 1);
    } finally {
        await runtime.stop();
    }
});
