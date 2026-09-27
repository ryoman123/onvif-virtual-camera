const test = require("node:test");
const assert = require("node:assert/strict");

const {
    EventSubscriptionError,
    EventBus,
    retainedEventKey
} = require("../src/event-bus");
const { TOPICS, DEFAULT_TOPICS } = require("../src/event-topics");

function clock(start = Date.parse("2026-09-26T20:00:00.000Z")) {
    let now = start;

    return {
        now: () => now,
        advance(ms) {
            now += ms;
        }
    };
}

test("topic registry exposes stable supported topics", () => {
    const bus = new EventBus({ topics: DEFAULT_TOPICS });

    assert.deepEqual(
        bus.getTopics(),
        [...DEFAULT_TOPICS].sort()
    );
    assert.equal(TOPICS.PERSON, "UserAlarm/IVA/HumanShapeDetect");
});

test("subscription queues matching published events", () => {
    const time = clock();
    const bus = new EventBus({ now: time.now });
    const sub = bus.createSubscription({ id: "sub-1" });

    const event = bus.publish({
        topic: TOPICS.MOTION,
        source: { VideoSourceConfigurationToken: "source-1" },
        data: { IsMotion: true }
    });

    const result = bus.pull(sub.id, 10);

    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0].id, event.id);
    assert.equal(result.messages[0].sequence, 1);
    assert.equal(result.messages[0].topic, TOPICS.MOTION);
    assert.equal(result.messages[0].utcTime, "2026-09-26T20:00:00.000Z");
    assert.deepEqual(result.messages[0].data, { IsMotion: true });
});

test("topic-filtered subscriptions receive only selected topics", () => {
    const bus = new EventBus();
    const sub = bus.createSubscription({
        id: "person-only",
        topics: [TOPICS.PERSON]
    });

    bus.publish({
        topic: TOPICS.MOTION,
        data: { IsMotion: true }
    });
    bus.publish({
        topic: TOPICS.PERSON,
        data: { State: true }
    });

    const result = bus.pull(sub.id, 10);
    assert.deepEqual(
        result.messages.map((event) => event.topic),
        [TOPICS.PERSON]
    );
});

test("pull respects message limit and leaves remaining messages queued", () => {
    const bus = new EventBus();
    const sub = bus.createSubscription({ id: "sub-limit" });

    for (let index = 0; index < 3; index += 1) {
        bus.publish({
            topic: TOPICS.MOTION,
            data: { index }
        });
    }

    assert.equal(bus.pull(sub.id, 2).messages.length, 2);
    assert.equal(bus.pull(sub.id, 2).messages.length, 1);
});

test("queue is bounded and retains the newest events", () => {
    const bus = new EventBus({ maxQueue: 2 });
    const sub = bus.createSubscription({ id: "bounded" });

    for (let index = 0; index < 4; index += 1) {
        bus.publish({
            topic: TOPICS.MOTION,
            data: { index },
            retain: false
        });
    }

    assert.deepEqual(
        bus.pull(sub.id, 10).messages.map((event) => event.data.index),
        [2, 3]
    );
});

test("retained state key is stable across source key ordering", () => {
    assert.equal(
        retainedEventKey({
            topic: TOPICS.PERSON,
            source: { b: "2", a: "1" }
        }),
        retainedEventKey({
            topic: TOPICS.PERSON,
            source: { a: "1", b: "2" }
        })
    );
});

test("synchronization point replays retained property state as Initialized", () => {
    const time = clock();
    const bus = new EventBus({ now: time.now });

    bus.publish({
        topic: TOPICS.PERSON,
        source: { VideoSourceConfigurationToken: "source-1" },
        data: { State: true }
    });

    const sub = bus.createSubscription({ id: "sync" });
    time.advance(5000);

    assert.equal(bus.setSynchronizationPoint(sub.id), 1);

    const message = bus.pull(sub.id, 10).messages[0];
    assert.equal(message.propertyOperation, "Initialized");
    assert.equal(message.utcTime, "2026-09-26T20:00:05.000Z");
    assert.deepEqual(message.data, { State: true });
});

test("publishing a changed retained property replaces prior synchronized state", () => {
    const bus = new EventBus();

    bus.publish({
        topic: TOPICS.PERSON,
        source: { VideoSourceConfigurationToken: "source-1" },
        data: { State: true }
    });
    bus.publish({
        topic: TOPICS.PERSON,
        source: { VideoSourceConfigurationToken: "source-1" },
        data: { State: false }
    });

    const sub = bus.createSubscription({ id: "latest-state" });
    assert.equal(bus.setSynchronizationPoint(sub.id), 1);

    const message = bus.pull(sub.id, 10).messages[0];
    assert.deepEqual(message.data, { State: false });
});

test("subscription renewal extends expiration", () => {
    const time = clock();
    const bus = new EventBus({
        now: time.now,
        defaultTtlMs: 1000
    });
    const sub = bus.createSubscription({ id: "renewable" });

    time.advance(500);
    const renewed = bus.renew(sub.id, 5000);

    assert.equal(
        renewed.expiresAt,
        "2026-09-26T20:00:05.500Z"
    );

    time.advance(2000);
    assert.equal(bus.pull(sub.id, 1).messages.length, 0);
});

test("expired subscriptions are removed and become resource unknown", () => {
    const time = clock();
    const bus = new EventBus({
        now: time.now,
        defaultTtlMs: 1000
    });

    bus.createSubscription({ id: "short" });
    time.advance(1001);

    assert.throws(
        () => bus.pull("short", 1),
        (error) => {
            assert.ok(error instanceof EventSubscriptionError);
            assert.equal(error.code, "resource-unknown");
            return true;
        }
    );
});

test("unsubscribe removes the subscription", () => {
    const bus = new EventBus();
    bus.createSubscription({ id: "remove-me" });
    bus.unsubscribe("remove-me");

    assert.throws(
        () => bus.pull("remove-me", 1),
        (error) => error.code === "resource-unknown"
    );
});

test("invalid event and pull arguments fail fast", () => {
    const bus = new EventBus();
    const sub = bus.createSubscription({ id: "validation" });

    assert.throws(() => bus.publish({}), /event\.topic/);
    assert.throws(
        () => bus.publish({
            topic: TOPICS.MOTION,
            utcTime: "not-a-date"
        }),
        /event\.utcTime/
    );
    assert.throws(() => bus.pull(sub.id, 0), /messageLimit/);
});


test("pullAsync returns immediately when messages are already queued", async () => {
    const bus = new EventBus();
    const sub = bus.createSubscription({ id: "queued-async" });

    bus.publish({
        topic: TOPICS.MOTION,
        data: { IsMotion: true }
    });

    const started = Date.now();
    const result = await bus.pullAsync(sub.id, 10, 1000);

    assert.equal(result.messages.length, 1);
    assert.ok(Date.now() - started < 100);
});

test("pullAsync wakes as soon as a matching event is published", async () => {
    const bus = new EventBus();
    const sub = bus.createSubscription({
        id: "waiting",
        topics: [TOPICS.PERSON]
    });

    const pending = bus.pullAsync(sub.id, 10, 1000);

    setTimeout(() => {
        bus.publish({
            topic: TOPICS.MOTION,
            data: { IsMotion: true }
        });
    }, 10);

    setTimeout(() => {
        bus.publish({
            topic: TOPICS.PERSON,
            data: { State: true }
        });
    }, 25);

    const result = await pending;

    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0].topic, TOPICS.PERSON);
});

test("pullAsync returns an empty batch on timeout", async () => {
    const bus = new EventBus();
    const sub = bus.createSubscription({ id: "timeout" });

    const started = Date.now();
    const result = await bus.pullAsync(sub.id, 10, 30);
    const elapsed = Date.now() - started;

    assert.deepEqual(result.messages, []);
    assert.ok(elapsed >= 20);
    assert.ok(elapsed < 500);
});

test("pullAsync rejects overlapping pulls for one subscription", async () => {
    const bus = new EventBus();
    const sub = bus.createSubscription({ id: "concurrent" });

    const first = bus.pullAsync(sub.id, 10, 1000);

    await assert.rejects(
        () => bus.pullAsync(sub.id, 10, 1000),
        (error) => {
            assert.ok(error instanceof EventSubscriptionError);
            assert.equal(error.code, "concurrent-pull");
            return true;
        }
    );

    bus.publish({
        topic: TOPICS.MOTION,
        data: { IsMotion: true }
    });

    const result = await first;
    assert.equal(result.messages.length, 1);
});

test("synchronization point wakes a pending pull", async () => {
    const bus = new EventBus();

    bus.publish({
        topic: TOPICS.MOTION,
        data: { IsMotion: false }
    });

    const sub = bus.createSubscription({ id: "sync-wakeup" });
    const pending = bus.pullAsync(sub.id, 10, 1000);

    setTimeout(() => {
        bus.setSynchronizationPoint(sub.id);
    }, 20);

    const result = await pending;

    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0].propertyOperation, "Initialized");
});

test("unsubscribe releases a pending pull and removes the subscription", async () => {
    const bus = new EventBus();
    const sub = bus.createSubscription({ id: "unsubscribe-waiter" });

    const pending = bus.pullAsync(sub.id, 10, 1000);
    setTimeout(() => bus.unsubscribe(sub.id), 20);

    await assert.rejects(
        pending,
        (error) => {
            assert.ok(error instanceof EventSubscriptionError);
            assert.equal(error.code, "resource-unknown");
            return true;
        }
    );
});


test("releaseAllWaiters unblocks pending PullMessages", async () => {
    const bus = new EventBus();
    const sub = bus.createSubscription({ id: "shutdown-waiter" });

    const pending = bus.pullAsync(sub.id, 10, 60000);

    setTimeout(() => {
        bus.releaseAllWaiters();
    }, 20);

    const result = await pending;

    assert.deepEqual(result.messages, []);
});
