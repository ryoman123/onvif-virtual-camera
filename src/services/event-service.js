const logger = require("../log-manager");
const faults = require("../onvif-fault");
const {
    DEFAULT_SUBSCRIPTION_TTL_MS,
    EventSubscriptionError
} = require("../event-bus");
const { DEFAULT_TOPICS } = require("../event-topics");
const {
    EVENT_NAMESPACE,
    TOPIC_NAMESPACE,
    TOPIC_NAMESPACE_LOCATION,
    ONVIF_SCHEMA_LOCATION,
    CONCRETE_TOPIC_DIALECT,
    CONCRETE_SET_DIALECT,
    parseDurationMs,
    resolveTerminationTtlMs,
    parseTopicFilter,
    renderNotificationMessage,
    renderTopicSetXml,
    buildEventServiceCapabilities,
    escapeXml
} = require("../event-protocol");

const WSNT_NAMESPACE = "http://docs.oasis-open.org/wsn/b-2";
const WSTOP_NAMESPACE = "http://docs.oasis-open.org/wsn/t-1";
const WSA_NAMESPACE = "http://www.w3.org/2005/08/addressing";
const ONVIF_SCHEMA_NAMESPACE = "http://www.onvif.org/ver10/schema";
const CONCRETE_SET_TOPIC_DIALECT = CONCRETE_SET_DIALECT;
const MAX_SUBSCRIPTION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PULL_TIMEOUT_MS = 60000;
const MAX_MESSAGE_LIMIT = 256;

function parseTerminationTtl(value, nowMs, fallbackMs = DEFAULT_SUBSCRIPTION_TTL_MS) {
    return Math.min(
        resolveTerminationTtlMs(value, nowMs, fallbackMs),
        MAX_SUBSCRIPTION_TTL_MS
    );
}

function normalizePullTimeout(value) {
    const parsed = parseDurationMs(value ?? "PT0S");

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

function buildNotificationMessageXml(event, videoSourceConfigToken) {
    const token =
        videoSourceConfigToken ||
        (event && event.source && event.source.VideoSourceConfigurationToken);

    return renderNotificationMessage(event, {
        videoSourceConfigToken: token
    });
}

function buildTopicSetXml(topics = DEFAULT_TOPICS) {
    return renderTopicSetXml(topics);
}

function extractFilterTopics(filter, knownTopics = DEFAULT_TOPICS) {
    return parseTopicFilter(filter, knownTopics);
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
        this.videoSourceConfigToken = options.videoSourceConfigToken || null;
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
        const capabilities = buildEventServiceCapabilities(this.maxPullPoints);
        Object.assign(capabilities.$attributes, {
            EventBrokerProtocols: "",
            MaxEventBrokers: 0,
            MetadataOverMQTT: false
        });

        return {
            Capabilities: capabilities
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
            const topics = extractFilterTopics(args && args.Filter, this.eventBus.getTopics());
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
                    $xml: buildNotificationMessageXml(
                        event,
                        this.videoSourceConfigToken
                    )
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
