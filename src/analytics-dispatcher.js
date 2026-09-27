const EventEmitter = require("events");
const {
    normalizeAnalyticsEvent,
    toOnvifEvent
} = require("./analytics-event");

class AnalyticsDispatcher extends EventEmitter {
    constructor() {
        super();
        this.targets = new Map();
    }

    registerTarget(cameraName, target) {
        const name = String(cameraName || "").trim();
        if (!name) {
            throw new Error("analytics target camera name must be non-empty");
        }
        if (!target || (
            typeof target !== "function" &&
            typeof target !== "object"
        )) {
            throw new Error("analytics target must be an object or provider function");
        }

        this.targets.set(name, target);
    }

    unregisterTarget(cameraName) {
        return this.targets.delete(String(cameraName || "").trim());
    }

    resolveTarget(cameraName) {
        const registered = this.targets.get(cameraName);
        return typeof registered === "function"
            ? registered()
            : registered;
    }

    dispatch(input) {
        const analytics = normalizeAnalyticsEvent(input);
        const target = this.resolveTarget(analytics.camera);

        if (!target) {
            this.emit("unmapped", analytics.camera);
            return null;
        }

        if (!target.eventBus || typeof target.eventBus.publish !== "function") {
            throw new Error(
                `analytics target for ${analytics.camera} has no event bus`
            );
        }

        const onvif = toOnvifEvent(analytics, {
            videoSourceConfigToken: target.videoSourceConfigToken,
            videoAnalyticsConfigToken: target.videoAnalyticsConfigToken,
            rule: target.rule
        });
        const published = target.eventBus.publish(onvif);

        this.emit("published", {
            analytics,
            onvif: published
        });

        return published;
    }
}

module.exports = { AnalyticsDispatcher };
