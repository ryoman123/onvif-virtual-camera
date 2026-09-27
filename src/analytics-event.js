const { TOPICS } = require("./event-topics");

const TYPE_TO_TOPIC = Object.freeze({
    motion: TOPICS.MOTION,
    person: TOPICS.PERSON,
    vehicle: TOPICS.VEHICLE,
    animal: TOPICS.ANIMAL,
    package: TOPICS.PACKAGE
});

function normalizeAnalyticsEvent(input) {
    if (!input || typeof input !== "object") throw new Error("analytics event must be an object");
    const camera = String(input.camera || "").trim();
    const type = String(input.type || "").trim().toLowerCase();
    if (!camera) throw new Error("analytics event.camera must be non-empty");
    if (!TYPE_TO_TOPIC[type]) throw new Error(`unsupported analytics event type: ${type || "<empty>"}`);
    const active = input.active !== false;
    const confidence = input.confidence == null ? null : Number(input.confidence);
    if (confidence !== null && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)) {
        throw new Error("analytics event.confidence must be between 0 and 1");
    }
    return Object.freeze({
        source: String(input.source || "unknown"),
        camera,
        type,
        active,
        utcTime: new Date(input.utcTime || Date.now()).toISOString(),
        confidence,
        objectId: input.objectId == null ? null : String(input.objectId),
        box: Array.isArray(input.box) ? Object.freeze([...input.box]) : null,
        zones: Object.freeze(Array.isArray(input.zones) ? [...input.zones].map(String) : [])
    });
}

function toOnvifEvent(input, options = {}) {
    const event = normalizeAnalyticsEvent(input);
    const topic = TYPE_TO_TOPIC[event.type];
    const source = { VideoSourceConfigurationToken: options.videoSourceConfigToken || "video_source_config" };
    const data = event.type === "motion" ? { IsMotion: event.active } : { State: event.active };
    if (event.type === "motion") {
        source.VideoAnalyticsConfigurationToken = options.videoAnalyticsConfigToken || "video_analytics_config";
        source.Rule = options.rule || "MotionDetector";
    }
    return {
        id: event.objectId || undefined,
        key: `${event.source}|${event.camera}|${event.type}|${event.objectId || "state"}`,
        topic,
        utcTime: event.utcTime,
        propertyOperation: "Changed",
        source,
        data,
        retain: true,
        analytics: event
    };
}

module.exports = { TYPE_TO_TOPIC, normalizeAnalyticsEvent, toOnvifEvent };
