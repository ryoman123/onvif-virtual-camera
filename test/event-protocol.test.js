const test = require("node:test");
const assert = require("node:assert/strict");

const { TOPICS, DEFAULT_TOPICS } = require("../src/event-topics");
const {
    CONCRETE_TOPIC_DIALECT,
    CONCRETE_SET_DIALECT,
    UnsupportedTopicFilterError,
    parseDurationMs,
    resolveTerminationTtlMs,
    parseTopicFilter,
    renderNotificationMessage,
    renderTopicSetXml,
    buildEventServiceCapabilities
} = require("../src/event-protocol");

test("ISO duration parser supports day/hour/minute/second durations", () => {
    assert.equal(parseDurationMs("PT30S"), 30000);
    assert.equal(parseDurationMs("PT2M5S"), 125000);
    assert.equal(parseDurationMs("P1DT1H"), 90000000);
    assert.equal(parseDurationMs("PT0.5S"), 500);
    assert.equal(parseDurationMs("invalid"), null);
});

test("termination time accepts relative durations and absolute future times", () => {
    const now = Date.parse("2026-09-26T20:00:00.000Z");

    assert.equal(resolveTerminationTtlMs(undefined, now, 60000), 60000);
    assert.equal(resolveTerminationTtlMs("PT10M", now, 60000), 600000);
    assert.equal(
        resolveTerminationTtlMs("2026-09-26T20:15:00.000Z", now, 60000),
        900000
    );

    assert.throws(
        () => resolveTerminationTtlMs("PT0S", now, 60000),
        /greater than zero/
    );

    assert.throws(
        () => resolveTerminationTtlMs("2026-09-26T19:59:59.000Z", now, 60000),
        /future/
    );
});

test("topic filters accept exact topics, namespace prefixes, unions, and parent topics", () => {
    assert.deepEqual(
        Array.from(parseTopicFilter({
            TopicExpression: "tns1:RuleEngine/CellMotionDetector/Motion"
        })),
        [TOPICS.MOTION]
    );

    assert.deepEqual(
        Array.from(parseTopicFilter({
            TopicExpression:
                "tns1:UserAlarm/IVA/HumanShapeDetect | tns1:VehicleAlarm/IVB/VehicleDetect"
        })).sort(),
        [TOPICS.PERSON, TOPICS.VEHICLE].sort()
    );

    assert.deepEqual(
        Array.from(parseTopicFilter({
            TopicExpression: "tns1:UserAlarm"
        })).sort(),
        [TOPICS.PERSON, TOPICS.ANIMAL, TOPICS.PACKAGE].sort()
    );
});

test("unknown topic filters fail closed", () => {
    assert.throws(
        () => parseTopicFilter({
            TopicExpression: "tns1:Unknown/Thing"
        }, DEFAULT_TOPICS),
        (error) => error instanceof UnsupportedTopicFilterError
    );
});

test("notification rendering uses the ConcreteSet dialect and stable Media source token", () => {
    const xml = renderNotificationMessage({
        topic: TOPICS.PERSON,
        utcTime: "2026-09-26T20:00:00.000Z",
        propertyOperation: "Changed",
        source: {
            Rule: "person"
        },
        data: {
            State: true
        }
    }, {
        videoSourceConfigToken: "video_source_config_hq_test"
    });

    assert.ok(xml.includes(`Dialect="${CONCRETE_SET_DIALECT}"`));
    assert.match(xml, /tns1:UserAlarm\/IVA\/HumanShapeDetect/);
    assert.match(xml, /PropertyOperation="Changed"/);
    assert.match(
        xml,
        /Name="VideoSourceConfigurationToken" Value="video_source_config_hq_test"/
    );
    assert.match(xml, /Name="Rule" Value="person"/);
    assert.match(xml, /Name="State" Value="true"/);
});

test("topic set advertises motion and all smart-detection leaves", () => {
    const xml = renderTopicSetXml();

    assert.match(xml, /<tns1:RuleEngine>/);
    assert.match(xml, /<tns1:CellMotionDetector>/);
    assert.match(xml, /<tns1:Motion wstop:topic="true">/);
    assert.match(xml, /Name="IsMotion" Type="xs:boolean"/);
    assert.match(xml, /<tns1:HumanShapeDetect wstop:topic="true">/);
    assert.match(xml, /<tns1:VehicleDetect wstop:topic="true">/);
    assert.match(xml, /<tns1:AnimalDetect wstop:topic="true">/);
    assert.match(xml, /<tns1:PackageDetect wstop:topic="true">/);
});

test("event capabilities advertise PullPoint capacity without unsupported features", () => {
    const capabilities = buildEventServiceCapabilities(16);

    assert.deepEqual(capabilities.$attributes, {
        WSSubscriptionPolicySupport: false,
        WSPausableSubscriptionManagerInterfaceSupport: false,
        MaxNotificationProducers: 1,
        MaxPullPoints: 16,
        PersistentNotificationStorage: false
    });
});

test("both mandatory ONVIF topic expression dialects are represented by the protocol constants", () => {
    assert.equal(
        CONCRETE_TOPIC_DIALECT,
        "http://docs.oasis-open.org/wsn/t-1/TopicExpression/Concrete"
    );
    assert.equal(
        CONCRETE_SET_DIALECT,
        "http://www.onvif.org/ver10/tev/topicExpression/ConcreteSet"
    );
});
