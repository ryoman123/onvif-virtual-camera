const test = require("node:test");
const assert = require("node:assert/strict");

const { EventBus } = require("../src/event-bus");
const { DEFAULT_TOPICS, TOPICS } = require("../src/event-topics");
const {
    EventService,
    CONCRETE_TOPIC_DIALECT,
    CONCRETE_SET_TOPIC_DIALECT,
    parseDurationMs,
    parseTerminationTtl,
    buildNotificationMessageXml,
    buildTopicSetXml,
    extractFilterTopics,
    subscriptionIdFromRequest
} = require("../src/services/event-service");

global.runtime = { enable_debug_logs: false };

function cameraFixture() {
    return {
        name: "Camera-Test",
        endpoints: {
            eventServiceUrl: "http://192.0.2.90/onvif/event_service"
        }
    };
}

function clock(start = Date.parse("2026-09-26T20:00:00.000Z")) {
    let now = start;
    return {
        now: () => now,
        advance(ms) {
            now += ms;
        }
    };
}

test("duration parsing supports ONVIF PullPoint relative times", () => {
    assert.equal(parseDurationMs("PT1M"), 60000);
    assert.equal(parseDurationMs("PT1.5S"), 1500);
    assert.equal(parseDurationMs("P1DT2H3M4S"), 93784000);
    assert.equal(parseDurationMs("not-a-duration"), null);
});

test("termination parsing accepts relative and absolute times", () => {
    const now = Date.parse("2026-09-26T20:00:00.000Z");
    assert.equal(parseTerminationTtl("PT5M", now), 300000);
    assert.equal(
        parseTerminationTtl("2026-09-26T20:10:00.000Z", now),
        600000
    );
});

test("GetServiceCapabilities advertises PullPoint-only event support", async () => {
    const bus = new EventBus({ topics: DEFAULT_TOPICS });
    const service = new EventService(cameraFixture(), bus);

    const response = await service.GetServiceCapabilities();
    const attrs = response.Capabilities.$attributes;

    assert.equal(attrs.WSSubscriptionPolicySupport, false);
    assert.equal(attrs.WSPausableSubscriptionManagerInterfaceSupport, false);
    assert.equal(attrs.MaxPullPoints, 32);
    assert.equal(attrs.PersistentNotificationStorage, false);
});

test("GetEventProperties exposes dialects and the detection topic set", async () => {
    const bus = new EventBus({ topics: DEFAULT_TOPICS });
    const service = new EventService(cameraFixture(), bus);

    const response = await service.GetEventProperties();

    assert.deepEqual(response.TopicExpressionDialect, [
        CONCRETE_TOPIC_DIALECT,
        CONCRETE_SET_TOPIC_DIALECT
    ]);
    assert.equal(response.FixedTopicSet, true);
    assert.match(response.TopicSet.$xml, /CellMotionDetector/);
    assert.match(response.TopicSet.$xml, /HumanShapeDetect/);
    assert.match(response.TopicSet.$xml, /wstop:topic="true"/);
});

test("topic filters normalize namespace prefixes and ConcreteSet unions", () => {
    const topics = extractFilterTopics({
        TopicExpression: {
            $value:
                "tns1:RuleEngine/CellMotionDetector/Motion | " +
                "tns1:UserAlarm/IVA/HumanShapeDetect"
        }
    });

    assert.deepEqual(
        [...topics].sort(),
        [TOPICS.MOTION, TOPICS.PERSON].sort()
    );
});

test("CreatePullPointSubscription returns a unique endpoint", async () => {
    const time = clock();
    const bus = new EventBus({
        topics: DEFAULT_TOPICS,
        now: time.now
    });
    const service = new EventService(cameraFixture(), bus, {
        now: time.now
    });

    const response = await service.CreatePullPointSubscription({
        InitialTerminationTime: "PT5M"
    });

    assert.match(
        response.SubscriptionReference.$xml,
        /http:\/\/192\.0\.2\.90\/onvif\/event_service\/subscriptions\//
    );
    assert.equal(response.CurrentTime, "2026-09-26T20:00:00.000Z");
    assert.equal(response.TerminationTime, "2026-09-26T20:05:00.000Z");
    assert.equal(bus.subscriptions.size, 1);
});

test("PullMessages long-polls and serializes queued ONVIF events", async () => {
    const time = clock();
    const bus = new EventBus({
        topics: DEFAULT_TOPICS,
        now: time.now
    });
    const service = new EventService(cameraFixture(), bus, {
        now: time.now
    });

    await service.CreatePullPointSubscription({
        InitialTerminationTime: "PT5M"
    });
    const subscription = [...bus.subscriptions.values()][0];

    const pending = service.PullMessages(
        {
            Timeout: "PT1S",
            MessageLimit: 10
        },
        null,
        null,
        {
            onvifSubscriptionId: subscription.id
        }
    );

    setTimeout(() => {
        bus.publish({
            topic: TOPICS.MOTION,
            utcTime: "2026-09-26T20:00:01.000Z",
            source: {
                VideoSourceConfigurationToken: "source-1",
                Rule: "Motion"
            },
            data: {
                IsMotion: true
            }
        });
    }, 20);

    const response = await pending;

    assert.equal(response.NotificationMessage.length, 1);
    assert.match(
        response.NotificationMessage[0].$xml,
        /tns1:RuleEngine\/CellMotionDetector\/Motion/
    );
    assert.match(
        response.NotificationMessage[0].$xml,
        /Name="IsMotion" Value="true"/
    );
});

test("SetSynchronizationPoint queues retained state as Initialized", async () => {
    const bus = new EventBus({ topics: DEFAULT_TOPICS });
    const service = new EventService(cameraFixture(), bus);

    bus.publish({
        topic: TOPICS.PERSON,
        source: {
            VideoSourceConfigurationToken: "source-1"
        },
        data: {
            State: true
        }
    });

    await service.CreatePullPointSubscription({});
    const subscription = [...bus.subscriptions.values()][0];

    await service.SetSynchronizationPoint(
        {},
        null,
        null,
        { onvifSubscriptionId: subscription.id }
    );

    const result = bus.pull(subscription.id, 10);

    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0].propertyOperation, "Initialized");
});

test("Renew and Unsubscribe use the subscription request identity", async () => {
    const time = clock();
    const bus = new EventBus({
        topics: DEFAULT_TOPICS,
        now: time.now
    });
    const service = new EventService(cameraFixture(), bus, {
        now: time.now
    });

    await service.CreatePullPointSubscription({
        InitialTerminationTime: "PT1M"
    });
    const subscription = [...bus.subscriptions.values()][0];
    const req = { onvifSubscriptionId: subscription.id };

    const renewed = await service.Renew(
        { TerminationTime: "PT10M" },
        null,
        null,
        req
    );

    assert.equal(renewed.TerminationTime, "2026-09-26T20:10:00.000Z");

    await service.Unsubscribe({}, null, null, req);
    assert.equal(bus.subscriptions.size, 0);
});

test("notification XML escapes values and uses ONVIF Message semantics", () => {
    const xml = buildNotificationMessageXml({
        topic: TOPICS.PERSON,
        utcTime: "2026-09-26T20:00:00.000Z",
        propertyOperation: "Changed",
        source: {
            Rule: 'A&B<"rule">'
        },
        data: {
            State: true
        }
    });

    assert.match(xml, /PropertyOperation="Changed"/);
    assert.match(xml, /A&amp;B&lt;&quot;rule&quot;&gt;/);
    assert.match(xml, /Name="State" Value="true"/);
});

test("topic set XML contains the registered detection hierarchy", () => {
    const xml = buildTopicSetXml(DEFAULT_TOPICS);

    assert.match(xml, /<tns1:RuleEngine>/);
    assert.match(xml, /<tns1:Motion wstop:topic="true">/);
    assert.match(xml, /<tns1:UserAlarm>/);
    assert.match(xml, /<tns1:HumanShapeDetect wstop:topic="true">/);
});

test("subscription id resolves from request metadata or URL", () => {
    assert.equal(
        subscriptionIdFromRequest({ onvifSubscriptionId: "abc" }, {}),
        "abc"
    );
    assert.equal(
        subscriptionIdFromRequest({
            url: "/onvif/event_service/subscriptions/xyz?foo=1"
        }, {}),
        "xyz"
    );
});
