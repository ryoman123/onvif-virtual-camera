const EventEmitter = require("events");
const { frigateEventToAnalytics } = require("./frigate-adapter");
const { normalizeAnalyticsEvent } = require("./analytics-event");

class FrigateMqttRouter extends EventEmitter {
    constructor(options = {}) {
        super();
        this.topicPrefix = String(options.topicPrefix || "frigate").replace(/\/+$/, "");
        this.cameraMap = new Map(Object.entries(options.cameraMap || {}));
        this.available = null;
    }
    topics() {
        return [this.topicPrefix + "/available", this.topicPrefix + "/events", this.topicPrefix + "/+/motion"];
    }
    route(topic, payload) {
        const value = Buffer.isBuffer(payload) ? payload.toString("utf8") : String(payload);
        if (topic === this.topicPrefix + "/available") {
            const availability = value.trim().toLowerCase();
            this.available = availability === "online"
                ? true
                : availability === "offline" ? false : null;
            this.emit("availability", this.available);
            return [];
        }
        if (topic === this.topicPrefix + "/events") {
            const event = frigateEventToAnalytics(value);
            if (!event) return [];
            const mapped = this.cameraMap.get(event.camera);
            if (!mapped) { this.emit("unmapped", event.camera); return []; }
            const routed = normalizeAnalyticsEvent({ ...event, camera: mapped });
            this.emit("analytics", routed);
            return [routed];
        }
        const prefix = this.topicPrefix + "/";
        if (!topic.startsWith(prefix) || !topic.endsWith("/motion")) return [];
        const camera = topic.slice(prefix.length, -"/motion".length);
        if (!camera || camera.includes("/")) return [];
        const mapped = this.cameraMap.get(camera);
        if (!mapped) { this.emit("unmapped", camera); return []; }
        const state = value.trim().toUpperCase();
        if (state !== "ON" && state !== "OFF") return [];
        const event = normalizeAnalyticsEvent({ source:"frigate", camera:mapped, type:"motion", active:state === "ON" });
        this.emit("analytics", event);
        return [event];
    }
}
module.exports = { FrigateMqttRouter };
