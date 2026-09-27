const test = require("node:test");
const assert = require("node:assert/strict");

const { AnalyticsDispatcher } = require("../src/analytics-dispatcher");
const { EventBus } = require("../src/event-bus");
const { DEFAULT_TOPICS } = require("../src/event-topics");

function fixture() {
    const bus = new EventBus({ topics: DEFAULT_TOPICS });
    const dispatcher = new AnalyticsDispatcher();

    dispatcher.registerTarget("Cam", {
        eventBus: bus,
        videoSourceConfigToken: "source"
    });

    return { bus, dispatcher };
}

test("object analytics publish only aggregate boolean state transitions", () => {
    const { bus, dispatcher } = fixture();
    const subscription = bus.createSubscription({ ttlMs: 60000 });

    assert.ok(dispatcher.dispatch({
        source: "frigate",
        camera: "Cam",
        type: "person",
        active: true,
        objectId: "a"
    }));
    assert.equal(dispatcher.dispatch({
        source: "frigate",
        camera: "Cam",
        type: "person",
        active: true,
        objectId: "b"
    }), null);
    assert.equal(dispatcher.dispatch({
        source: "frigate",
        camera: "Cam",
        type: "person",
        active: false,
        objectId: "a"
    }), null);
    assert.ok(dispatcher.dispatch({
        source: "frigate",
        camera: "Cam",
        type: "person",
        active: false,
        objectId: "b"
    }));

    const messages = bus.pull(subscription.id, 10).messages;

    assert.deepEqual(messages.map((event) => event.data.State), [true, false]);
    assert.equal(bus.retained.size, 1);
});

test("duplicate object updates do not spam PullPoint or retained state", () => {
    const { bus, dispatcher } = fixture();
    const subscription = bus.createSubscription({ ttlMs: 60000 });

    dispatcher.dispatch({
        source: "frigate",
        camera: "Cam",
        type: "vehicle",
        active: true,
        objectId: "v1"
    });
    dispatcher.dispatch({
        source: "frigate",
        camera: "Cam",
        type: "vehicle",
        active: true,
        objectId: "v1",
        confidence: 0.95
    });
    dispatcher.dispatch({
        source: "frigate",
        camera: "Cam",
        type: "vehicle",
        active: true,
        objectId: "v1",
        confidence: 0.97
    });

    assert.equal(bus.pull(subscription.id, 10).messages.length, 1);
    assert.equal(bus.retained.size, 1);
});

test("multiple analytics sources contribute one stable ONVIF property state", () => {
    const { bus, dispatcher } = fixture();
    const subscription = bus.createSubscription({ ttlMs: 60000 });

    assert.ok(dispatcher.dispatch({
        source: "frigate",
        camera: "Cam",
        type: "person",
        active: true,
        objectId: "a"
    }));
    assert.equal(dispatcher.dispatch({
        source: "nvr",
        camera: "Cam",
        type: "person",
        active: true
    }), null);
    assert.equal(dispatcher.dispatch({
        source: "frigate",
        camera: "Cam",
        type: "person",
        active: false,
        objectId: "a"
    }), null);
    assert.ok(dispatcher.dispatch({
        source: "nvr",
        camera: "Cam",
        type: "person",
        active: false
    }));

    const messages = bus.pull(subscription.id, 10).messages;

    assert.deepEqual(messages.map((event) => event.data.State), [true, false]);
    assert.equal(bus.retained.size, 1);
});

test("unregistering a camera clears its aggregate contributors", () => {
    const { dispatcher } = fixture();

    dispatcher.dispatch({
        source: "frigate",
        camera: "Cam",
        type: "person",
        active: true,
        objectId: "a"
    });

    assert.equal(dispatcher.activeContributors.size, 1);
    assert.equal(dispatcher.unregisterTarget("Cam"), true);
    assert.equal(dispatcher.activeContributors.size, 0);
});
