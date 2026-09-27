const { normalizeAnalyticsEvent } = require("./analytics-event");

const LABEL_MAP = Object.freeze({
    person: "person",
    car: "vehicle",
    motorcycle: "vehicle",
    bicycle: "vehicle",
    bus: "vehicle",
    truck: "vehicle",
    dog: "animal",
    cat: "animal",
    bird: "animal",
    package: "package"
});

function parsePayload(payload) {
    if (Buffer.isBuffer(payload)) payload = payload.toString("utf8");
    if (typeof payload === "string") payload = JSON.parse(payload);
    if (!payload || typeof payload !== "object") throw new Error("Frigate event payload must be an object");
    return payload;
}

function frigateEventToAnalytics(payload, options = {}) {
    const message = parsePayload(payload);
    const phase = String(message.type || "").toLowerCase();
    if (!["new", "update", "end"].includes(phase)) return null;
    const record = phase === "end" ? (message.after || message.before) : (message.after || message.before);
    if (!record) return null;
    const mappedType = (options.labelMap || LABEL_MAP)[String(record.label || "").toLowerCase()];
    if (!mappedType) return null;
    const snapshot = record.snapshot || {};
    const score = record.top_score ?? snapshot.score ?? null;
    const time = phase === "end"
        ? (record.end_time ?? record.frame_time ?? Date.now() / 1000)
        : (record.frame_time ?? record.start_time ?? Date.now() / 1000);
    return normalizeAnalyticsEvent({
        source: "frigate",
        camera: record.camera,
        type: mappedType,
        active: phase !== "end",
        utcTime: new Date(Number(time) * 1000),
        confidence: score,
        objectId: record.id,
        box: snapshot.box || record.box || null,
        zones: record.current_zones || record.entered_zones || []
    });
}

module.exports = { LABEL_MAP, frigateEventToAnalytics };
