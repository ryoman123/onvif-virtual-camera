const logger = require("../log-manager");
const faults = require("../onvif-fault");
const { EventSubscriptionError } = require("../event-bus");
const { TOPICS } = require("../event-topics");

const EVENT_NAMESPACE = "http://www.onvif.org/ver10/events/wsdl";
const TOPIC_NAMESPACE = "http://www.onvif.org/ver10/topics";
const TOPIC_NAMESPACE_LOCATION = "http://www.onvif.org/onvif/ver10/topics/topicns.xml";
const ONVIF_SCHEMA_LOCATION = "http://www.onvif.org/onvif/ver10/schema/onvif.xsd";
const WSNT_NAMESPACE = "http://docs.oasis-open.org/wsn/b-2";
const WSTOP_NAMESPACE = "http://docs.oasis-open.org/wsn/t-1";
const WSA_NAMESPACE = "http://www.w3.org/2005/08/addressing";
const ONVIF_SCHEMA_NAMESPACE = "http://www.onvif.org/ver10/schema";
const CONCRETE_TOPIC_DIALECT =
    "http://docs.oasis-open.org/wsn/t-1/TopicExpression/Concrete";
const CONCRETE_SET_TOPIC_DIALECT =
    "http://www.onvif.org/ver10/tev/topicExpression/ConcreteSet";

const DEFAULT_SUBSCRIPTION_TTL_MS = 60000;
const MAX_SUBSCRIPTION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PULL_TIMEOUT_MS = 60000;
const MAX_MESSAGE_LIMIT = 256;

function escapeXml(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&apos;");
}

function parseDurationMs(value) {
    if (typeof value !== "string") {
        return null;
    }

    const match = value.trim().match(
        /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/
    );

    if (!match) {
        return null;
    }

    const days = Number(match[1] || 0);
    const hours = Number(match[2] || 0);
    const minutes = Number(match[3] || 0);
    const seconds = Number(match[4] || 0);

    const total =
        days * 86400000 +
        hours * 3600000 +
        minutes * 60000 +
        seconds * 1000;

    return Number.isFinite(total) ? total : null;
}

function extractScalar(value) {
    if (value && typeof value === "object") {
        return value.$value ?? value._ ?? value.value;
    }
    return value;
}

function parseTerminationTtl(value, nowMs, fallbackMs = DEFAULT_SUBSCRIPTION_TTL_MS) {
    if (value === undefined || value === null || value === "") {
        return fallbackMs;
    }

    const raw = extractScalar(value);
    const durationMs = parseDurationMs(String(raw));

    if (durationMs !== null) {
        if (durationMs <= 0) {
            throw new Error("termination time must be in the future");
        }
        return Math.min(durationMs, MAX_SUBSCRIPTION_TTL_MS);
    }

    const absoluteMs = Date.parse(String(raw));
    if (!Number.isFinite(absoluteMs) || absoluteMs <= nowMs) {
        throw new Error("termination time must be a future xs:dateTime or duration");
    }

    return Math.min(absoluteMs - nowMs, MAX_SUBSCRIPTION_TTL_MS);
}

function normalizePullTimeout(value) {
    const raw = extractScalar(value);
    const parsed = parseDurationMs(String(raw || "PT0S"));

    if (parsed === null || parsed < 0) {
        throw new Error("PullMessages Timeout must be an xs:duration");
    }

    return Math.min(parsed, MAX_PULL_TIMEOUT_MS);
}

function normalizeMessageLimit(value) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error("PullMessages MessageLimit must be a positive integer");
    }
    return Math.min(parsed, MAX_MESSAGE_LIMIT);
}

function scalarValue(value) {
    if (value === null || value === undefined) {
        return "";
    }
    if (typeof value === "boolean") {
        return value ? "true" : "false";
    }
    return String(value);
}

function renderSimpleItems(containerName, values) {
    const entries = Object.entries(values || {});
    if (entries.length === 0) {
        return "<tt:" + containerName + "/>";
    }

    return [
        "<tt:" + containerName + ">",
        ...entries
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([name, value]) =>
                '<tt:SimpleItem Name="' + escapeXml(name) +
                '" Value="' + escapeXml(scalarValue(value)) + '"/>'
            ),
        "</tt:" + containerName + ">"
    ].join("");
}

function buildNotificationMessageXml(event) {
    return [
        '<wsnt:Topic xmlns:wsnt="' + WSNT_NAMESPACE +
            '" xmlns:tns1="' + TOPIC_NAMESPACE +
            '" Dialect="' + CONCRETE_TOPIC_DIALECT + '">tns1:' +
            escapeXml(event.topic) + "</wsnt:Topic>",
        '<wsnt:Message xmlns:wsnt="' + WSNT_NAMESPACE + '">',
        '<tt:Message xmlns:tt="' + ONVIF_SCHEMA_NAMESPACE +
            '" UtcTime="' + escapeXml(event.utcTime) +
            '" PropertyOperation="' + escapeXml(event.propertyOperation) + '">',
        renderSimpleItems("Source", event.source),
        renderSimpleItems("Data", event.data),
        "</tt:Message>",
        "</wsnt:Message>"
    ].join("");
}

function buildTopicTree(topics) {
    const root = {};

    for (const topic of topics) {
        const segments = String(topic)
            .split("/")
            .map((segment) => segment.trim())
            .filter(Boolean);

        let cursor = root;
        for (const segment of segments) {
            cursor[segment] ||= {};
            cursor = cursor[segment];
        }
        cursor.$topic = true;
    }

    return root;
}

function messageDescriptionForTopic(topicPath) {
    const dataName = topicPath === TOPICS.MOTION ? "IsMotion" : "State";

    return [
        '<tt:MessageDescription xmlns:tt="' + ONVIF_SCHEMA_NAMESPACE + '" IsProperty="true">',
        "<tt:Source>",
        '<tt:SimpleItemDescription Name="VideoSourceConfigurationToken" Type="tt:ReferenceToken"/>',
        '<tt:SimpleItemDescription Name="Rule" Type="xs:string" xmlns:xs="http://www.w3.org/2001/XMLSchema"/>',
        "</tt:Source>",
        "<tt:Data>",
        '<tt:SimpleItemDescription Name="' + dataName +
            '" Type="xs:boolean" xmlns:xs="http://www.w3.org/2001/XMLSchema"/>',
        "</tt:Data>",
        "</tt:MessageDescription>"
    ].join("");
}

function renderTopicTreeNode(name, node, pathParts) {
    const topicPath = [...pathParts, name].join("/");
    const children = Object.entries(node)
        .filter(([key]) => key !== "$topic")
        .sort(([left], [right]) => left.localeCompare(right));

    const attributes = node.$topic ? ' wstop:topic="true"' : "";
    const body = [];

    if (node.$topic) {
        body.push(messageDescriptionForTopic(topicPath));
    }

    for (const [childName, childNode] of children) {
        body.push(renderTopicTreeNode(childName, childNode, [...pathParts, name]));
    }

    return "<tns1:" + name + attributes + ">" +
        body.join("") +
        "</tns1:" + name + ">";
}

function buildTopicSetXml(topics) {
    const tree = buildTopicTree(topics);

    return [
        '<wstop:TopicSet xmlns:wstop="' + WSTOP_NAMESPACE +
            '" xmlns:tns1="' + TOPIC_NAMESPACE + '">',
        ...Object.entries(tree)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([name, node]) => renderTopicTreeNode(name, node, [])),
        "</wstop:TopicSet>"
    ].join("");
}

function collectTopicExpressions(value, found = []) {
    if (value === null || value === undefined) {
        return found;
    }

    if (Array.isArray(value)) {
        for (const item of value) {
            collectTopicExpressions(item, found);
        }
        return found;
    }

    if (typeof value !== "object") {
        return found;
    }

    for (const [key, item] of Object.entries(value)) {
        if (/TopicExpression$/i.test(key)) {
            const raw = extractScalar(item);
            if (typeof raw === "string" && raw.trim()) {
                found.push(raw.trim());
            }
        }
        collectTopicExpressions(item, found);
    }

    return found;
}

function normalizeTopicExpressionToken(token) {
    const trimmed = token.trim();
    if (!trimmed) {
        return null;
    }

    const withoutPrefix = trimmed.includes(":")
        ? trimmed.slice(trimmed.indexOf(":") + 1)
        : trimmed;

    return withoutPrefix.replace(/^\/+/, "");
}

function extractFilterTopics(filter) {
    if (!filter) {
        return null;
    }

    const expressions = collectTopicExpressions(filter);
    if (expressions.length === 0) {
        return null;
    }

    const topics = new Set();
    for (const expression of expressions) {
        for (const token of expression.split(/[|\s]+/)) {
            const normalized = normalizeTopicExpressionToken(token);
            if (normalized) {
                topics.add(normalized);
            }
        }
    }

    return topics.size > 0 ? topics : null;
}

function subscriptionIdFromRequest(req, args) {
    if (args && typeof args.SubscriptionId === "string" && args.SubscriptionId) {
        return args.SubscriptionId;
    }

    if (req && req.onvifSubscriptionId) {
        return req.onvifSubscriptionId;
    }

    if (req && typeof req.url === "string") {
        const match = req.url.match(
            /\/onvif\/event_service\/subscriptions\/([^/?#]+)/
        );
        if (match) {
            return decodeURIComponent(match[1]);
        }
    }

    return null;
}

class EventService {
    constructor(camera, eventBus, options = {}) {
        this.camera = camera;
        this.eventBus = eventBus;
        this.now = options.now || (() => Date.now());
        this.maxPullPoints = options.maxPullPoints ?? 32;
    }

    subscriptionAddress(id) {
        return this.camera.endpoints.eventServiceUrl +
            "/subscriptions/" +
            encodeURIComponent(id);
    }

    requireSubscriptionId(req, args) {
        const id = subscriptionIdFromRequest(req, args);
        if (!id) {
            throw faults.invalidArgs();
        }
        return id;
    }

    mapError(error) {
        if (error && error.Fault) {
            throw error;
        }

        if (error instanceof EventSubscriptionError) {
            throw faults.invalidArgs();
        }

        throw faults.invalidArgs();
    }

    async GetServiceCapabilities() {
        return {
            Capabilities: {
                $attributes: {
                    WSSubscriptionPolicySupport: false,
                    WSPausableSubscriptionManagerInterfaceSupport: false,
                    MaxNotificationProducers: 1,
                    MaxPullPoints: this.maxPullPoints,
                    PersistentNotificationStorage: false,
                    EventBrokerProtocols: "",
                    MaxEventBrokers: 0,
                    MetadataOverMQTT: false
                }
            }
        };
    }

    async GetEventProperties() {
        return {
            TopicNamespaceLocation: [TOPIC_NAMESPACE_LOCATION],
            FixedTopicSet: true,
            TopicSet: {
                $xml: buildTopicSetXml(this.eventBus.getTopics())
            },
            TopicExpressionDialect: [
                CONCRETE_TOPIC_DIALECT,
                CONCRETE_SET_TOPIC_DIALECT
            ],
            MessageContentFilterDialect: [""],
            MessageContentSchemaLocation: [ONVIF_SCHEMA_LOCATION]
        };
    }

    async CreatePullPointSubscription(args) {
        try {
            if (this.eventBus.subscriptions.size >= this.maxPullPoints) {
                throw new Error("maximum PullPoint subscriptions reached");
            }

            const nowMs = this.now();
            const ttlMs = parseTerminationTtl(
                args && args.InitialTerminationTime,
                nowMs
            );
            const topics = extractFilterTopics(args && args.Filter);
            const subscription = this.eventBus.createSubscription({
                ttlMs,
                topics
            });

            logger.debug(
                "events",
                "Created PullPoint for " + this.camera.name + ": " +
                subscription.id + " (expires=" + subscription.expiresAt +
                ", topics=" + (subscription.topics || "<all>") + ")"
            );

            return {
                SubscriptionReference: {
                    $xml:
                        '<wsa:Address xmlns:wsa="' + WSA_NAMESPACE + '">' +
                        escapeXml(this.subscriptionAddress(subscription.id)) +
                        "</wsa:Address>"
                },
                CurrentTime: new Date(nowMs).toISOString(),
                TerminationTime: subscription.expiresAt
            };
        } catch (error) {
            return this.mapError(error);
        }
    }

    async PullMessages(args, callback, headers, req) {
        try {
            const id = this.requireSubscriptionId(req, args);
            const timeoutMs = normalizePullTimeout(args && args.Timeout);
            const messageLimit = normalizeMessageLimit(args && args.MessageLimit);

            const result = await this.eventBus.pullAsync(
                id,
                messageLimit,
                timeoutMs
            );

            return {
                CurrentTime: new Date(this.now()).toISOString(),
                TerminationTime: result.subscription.expiresAt,
                NotificationMessage: result.messages.map((event) => ({
                    $xml: buildNotificationMessageXml(event)
                }))
            };
        } catch (error) {
            return this.mapError(error);
        }
    }

    async SetSynchronizationPoint(args, callback, headers, req) {
        try {
            const id = this.requireSubscriptionId(req, args);
            this.eventBus.setSynchronizationPoint(id);
            return {};
        } catch (error) {
            return this.mapError(error);
        }
    }

    async Renew(args, callback, headers, req) {
        try {
            const id = this.requireSubscriptionId(req, args);
            const nowMs = this.now();
            const ttlMs = parseTerminationTtl(
                args && args.TerminationTime,
                nowMs
            );
            const subscription = this.eventBus.renew(id, ttlMs);

            return {
                CurrentTime: new Date(nowMs).toISOString(),
                TerminationTime: subscription.expiresAt
            };
        } catch (error) {
            return this.mapError(error);
        }
    }

    async Unsubscribe(args, callback, headers, req) {
        try {
            const id = this.requireSubscriptionId(req, args);
            this.eventBus.unsubscribe(id);
            return {};
        } catch (error) {
            return this.mapError(error);
        }
    }

    GetEventServiceDefinition() {
        return {
            GetServiceCapabilities: this.GetServiceCapabilities.bind(this),
            CreatePullPointSubscription: this.CreatePullPointSubscription.bind(this),
            GetEventProperties: this.GetEventProperties.bind(this)
        };
    }

    GetPullPointServiceDefinition() {
        return {
            PullMessages: this.PullMessages.bind(this),
            SetSynchronizationPoint: this.SetSynchronizationPoint.bind(this),
            Renew: this.Renew.bind(this),
            Unsubscribe: this.Unsubscribe.bind(this)
        };
    }
}

module.exports = {
    EventService,
    EVENT_NAMESPACE,
    TOPIC_NAMESPACE,
    TOPIC_NAMESPACE_LOCATION,
    ONVIF_SCHEMA_LOCATION,
    WSNT_NAMESPACE,
    WSTOP_NAMESPACE,
    WSA_NAMESPACE,
    ONVIF_SCHEMA_NAMESPACE,
    CONCRETE_TOPIC_DIALECT,
    CONCRETE_SET_TOPIC_DIALECT,
    DEFAULT_SUBSCRIPTION_TTL_MS,
    MAX_PULL_TIMEOUT_MS,
    MAX_MESSAGE_LIMIT,
    escapeXml,
    parseDurationMs,
    parseTerminationTtl,
    normalizePullTimeout,
    normalizeMessageLimit,
    buildNotificationMessageXml,
    buildTopicSetXml,
    extractFilterTopics,
    subscriptionIdFromRequest
};
