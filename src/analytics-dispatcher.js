const EventEmitter = require("events");
const { normalizeAnalyticsEvent, toOnvifEvent } = require("./analytics-event");

class AnalyticsDispatcher extends EventEmitter {
    constructor() {
        super();
        this.targets = new Map();
        this.activeObjects = new Map();
    }

    registerTarget(cameraName, target) {
        const name = String(cameraName || "").trim();
        if (!name) throw new Error("analytics target camera name must be non-empty");
        if (!target || (typeof target !== "function" && typeof target !== "object")) {
            throw new Error("analytics target must be an object or provider function");
        }
        this.targets.set(name, target);
    }

    unregisterTarget(cameraName) {
        const name = String(cameraName || "").trim();
        for (const key of this.activeObjects.keys()) {
            if (key.includes("|" + name + "|")) this.activeObjects.delete(key);
        }
        return this.targets.delete(name);
    }

    resolveTarget(cameraName) {
        const registered = this.targets.get(cameraName);
        return typeof registered === "function" ? registered() : registered;
    }

    aggregateObjectState(event) {
        if (!event.objectId) return event;
        const key = event.source + "|" + event.camera + "|" + event.type;
        let active = this.activeObjects.get(key);
        if (!active) {
            active = new Set();
            this.activeObjects.set(key, active);
        }
        const wasActive = active.size > 0;
        if (event.active) active.add(event.objectId);
        else active.delete(event.objectId);
        const isActive = active.size > 0;
        if (!isActive) this.activeObjects.delete(key);
        if (wasActive === isActive) return null;
        return normalizeAnalyticsEvent({ ...event, active: isActive, objectId: null });
    }

    dispatch(input) {
        let analytics = normalizeAnalyticsEvent(input);
        analytics = this.aggregateObjectState(analytics);
        if (!analytics) {
            this.emit("suppressed", normalizeAnalyticsEvent(input));
            return null;
        }
        const target = this.resolveTarget(analytics.camera);
        if (!target) {
            this.emit("unmapped", analytics.camera);
            return null;
        }
        if (!target.eventBus || typeof target.eventBus.publish !== "function") {
            throw new Error("analytics target for " + analytics.camera + " has no event bus");
        }
        const onvif = toOnvifEvent(analytics, {
            videoSourceConfigToken: target.videoSourceConfigToken,
            videoAnalyticsConfigToken: target.videoAnalyticsConfigToken,
            rule: target.rule
        });
        const published = target.eventBus.publish(onvif);
        this.emit("published", { analytics, onvif: published });
        return published;
    }
}
module.exports = { AnalyticsDispatcher };
