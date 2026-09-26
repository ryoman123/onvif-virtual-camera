const { TOPICS, DEFAULT_TOPICS } = require("./event-topics");

const EVENT_NAMESPACE = "http://www.onvif.org/ver10/events/wsdl";
const TOPIC_NAMESPACE = "http://www.onvif.org/ver10/topics";
const TOPIC_NAMESPACE_LOCATION = "http://www.onvif.org/onvif/ver10/topics/topicns.xml";
const ONVIF_SCHEMA_LOCATION = "http://www.onvif.org/ver10/schema/onvif.xsd";
const CONCRETE_TOPIC_DIALECT = "http://docs.oasis-open.org/wsn/t-1/TopicExpression/Concrete";
const CONCRETE_SET_DIALECT = "http://www.onvif.org/ver10/tev/topicExpression/ConcreteSet";
const ITEM_FILTER_DIALECT = "http://www.onvif.org/ver10/tev/messageContentFilter/ItemFilter";

class UnsupportedTopicFilterError extends Error {
    constructor(message) {
        super(message);
        this.name = "UnsupportedTopicFilterError";
        this.code = "unsupported-topic-filter";
    }
}

function extractScalar(value) {
    if (value === undefined || value === null) {
        return undefined;
    }

    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        return String(value);
    }

    if (typeof value === "object") {
        return value.$value ?? value._ ?? value.value;
    }

    return undefined;
}

function parseDurationMs(value) {
    const scalar = extractScalar(value);
    if (!scalar) {
        return null;
    }

    const match = String(scalar).trim().match(
        /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/
    );

    if (!match) {
        return null;
    }

    const days = Number(match[1] || 0);
    const hours = Number(match[2] || 0);
    const minutes = Number(match[3] || 0);
    const seconds = Number(match[4] || 0);
    const milliseconds = (
        days * 86400 +
        hours * 3600 +
        minutes * 60 +
        seconds
    ) * 1000;

    return Number.isFinite(milliseconds) ? milliseconds : null;
}

function resolveTerminationTtlMs(value, nowMs, defaultTtlMs) {
    const scalar = extractScalar(value);

    if (scalar === undefined || scalar === null || String(scalar).trim() === "") {
        return defaultTtlMs;
    }

    const durationMs = parseDurationMs(scalar);
    if (durationMs !== null) {
        if (durationMs <= 0) {
            throw new Error("termination duration must be greater than zero");
        }
        return Math.floor(durationMs);
    }

    const absoluteMs = Date.parse(String(scalar));
    if (!Number.isFinite(absoluteMs)) {
        throw new Error("termination time must be an xs:duration or xs:dateTime");
    }

    const ttlMs = absoluteMs - nowMs;
    if (ttlMs <= 0) {
        throw new Error("termination time must be in the future");
    }

    return ttlMs;
}

function escapeXml(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&apos;");
}

function simpleValue(value) {
    if (typeof value === "boolean") {
        return value ? "true" : "false";
    }

    if (value === undefined || value === null) {
        return "";
    }

    return String(value);
}

function topicDataName(topic) {
    return topic === TOPICS.MOTION ? "IsMotion" : "State";
}

function normalizeTopicExpression(value) {
    return String(value)
        .trim()
        .replace(/^tns1:/, "")
        .replace(/^tns:/, "");
}

function collectTopicExpressions(value, output = []) {
    if (value === undefined || value === null) {
        return output;
    }

    if (Array.isArray(value)) {
        for (const item of value) {
            collectTopicExpressions(item, output);
        }
        return output;
    }

    if (typeof value === "string") {
        output.push(value);
        return output;
    }

    if (typeof value === "object") {
        const direct = extractScalar(value);
        if (typeof direct === "string") {
            output.push(direct);
        }

        for (const [key, item] of Object.entries(value)) {
            if (["$value", "_", "value", "$attributes"].includes(key)) {
                continue;
            }

            if (/TopicExpression$/i.test(key)) {
                collectTopicExpressions(item, output);
            } else if (key === "Filter") {
                collectTopicExpressions(item, output);
            }
        }
    }

    return output;
}

function parseTopicFilter(filter, knownTopics = DEFAULT_TOPICS) {
    if (filter === undefined || filter === null) {
        return null;
    }

    const expressions = collectTopicExpressions(filter)
        .flatMap((expression) => String(expression).split(/\s*\|\s*|\s+/))
        .map(normalizeTopicExpression)
        .filter(Boolean);

    if (expressions.length === 0) {
        throw new UnsupportedTopicFilterError("topic filter does not contain a supported TopicExpression");
    }

    const known = new Set(knownTopics);
    const selected = new Set();

    for (const expression of expressions) {
        if (known.has(expression)) {
            selected.add(expression);
            continue;
        }

        const descendants = Array.from(known).filter((topic) =>
            topic.startsWith(`${expression}/`)
        );

        if (descendants.length === 0) {
            throw new UnsupportedTopicFilterError(`unsupported topic expression: ${expression}`);
        }

        for (const topic of descendants) {
            selected.add(topic);
        }
    }

    return selected;
}

function renderSimpleItems(items) {
    return Object.entries(items || {})
        .map(([name, value]) =>
            `<tt:SimpleItem Name="${escapeXml(name)}" Value="${escapeXml(simpleValue(value))}"/>`
        )
        .join("");
}

function renderNotificationMessage(event, options = {}) {
    if (!event || typeof event !== "object") {
        throw new Error("event is required");
    }

    const topic = String(event.topic || "").trim();
    if (!topic) {
        throw new Error("event.topic is required");
    }

    const videoSourceConfigToken = options.videoSourceConfigToken;
    if (!videoSourceConfigToken) {
        throw new Error("videoSourceConfigToken is required");
    }

    const source = {
        VideoSourceConfigurationToken: videoSourceConfigToken,
        ...(event.source || {})
    };

    return [
        "<wsnt:NotificationMessage>",
        `<wsnt:Topic Dialect="${CONCRETE_SET_DIALECT}">tns1:${escapeXml(topic)}</wsnt:Topic>`,
        "<wsnt:Message>",
        `<tt:Message UtcTime="${escapeXml(event.utcTime)}" PropertyOperation="${escapeXml(event.propertyOperation || "Changed")}">`,
        `<tt:Source>${renderSimpleItems(source)}</tt:Source>`,
        `<tt:Data>${renderSimpleItems(event.data || {})}</tt:Data>`,
        "</tt:Message>",
        "</wsnt:Message>",
        "</wsnt:NotificationMessage>"
    ].join("");
}

function renderMessageDescription(dataName) {
    return [
        '<tt:MessageDescription IsProperty="true">',
        "<tt:Source>",
        '<tt:SimpleItemDescription Name="VideoSourceConfigurationToken" Type="tt:ReferenceToken"/>',
        "</tt:Source>",
        "<tt:Data>",
        `<tt:SimpleItemDescription Name="${dataName}" Type="xs:boolean"/>`,
        "</tt:Data>",
        "</tt:MessageDescription>"
    ].join("");
}

function renderTopicSetXml() {
    const motion = renderMessageDescription(topicDataName(TOPICS.MOTION));
    const state = renderMessageDescription("State");

    return [
        `<wstop:TopicSet xmlns:wstop="http://docs.oasis-open.org/wsn/t-1" xmlns:tns1="${TOPIC_NAMESPACE}" xmlns:tt="http://www.onvif.org/ver10/schema" xmlns:xs="http://www.w3.org/2001/XMLSchema">`,
        "<tns1:RuleEngine>",
        "<tns1:CellMotionDetector>",
        `<tns1:Motion wstop:topic="true">${motion}</tns1:Motion>`,
        "</tns1:CellMotionDetector>",
        "</tns1:RuleEngine>",
        "<tns1:UserAlarm>",
        "<tns1:IVA>",
        `<tns1:HumanShapeDetect wstop:topic="true">${state}</tns1:HumanShapeDetect>`,
        `<tns1:AnimalDetect wstop:topic="true">${state}</tns1:AnimalDetect>`,
        `<tns1:PackageDetect wstop:topic="true">${state}</tns1:PackageDetect>`,
        "</tns1:IVA>",
        "</tns1:UserAlarm>",
        "<tns1:VehicleAlarm>",
        "<tns1:IVB>",
        `<tns1:VehicleDetect wstop:topic="true">${state}</tns1:VehicleDetect>`,
        "</tns1:IVB>",
        "</tns1:VehicleAlarm>",
        "</wstop:TopicSet>"
    ].join("");
}

function buildEventServiceCapabilities(maxPullPoints = 32) {
    return {
        $attributes: {
            WSSubscriptionPolicySupport: false,
            WSPausableSubscriptionManagerInterfaceSupport: false,
            MaxNotificationProducers: 1,
            MaxPullPoints: maxPullPoints,
            PersistentNotificationStorage: false
        }
    };
}

module.exports = {
    EVENT_NAMESPACE,
    TOPIC_NAMESPACE,
    TOPIC_NAMESPACE_LOCATION,
    ONVIF_SCHEMA_LOCATION,
    CONCRETE_TOPIC_DIALECT,
    CONCRETE_SET_DIALECT,
    ITEM_FILTER_DIALECT,
    UnsupportedTopicFilterError,
    extractScalar,
    parseDurationMs,
    resolveTerminationTtlMs,
    escapeXml,
    simpleValue,
    topicDataName,
    parseTopicFilter,
    renderSimpleItems,
    renderNotificationMessage,
    renderTopicSetXml,
    buildEventServiceCapabilities
};
