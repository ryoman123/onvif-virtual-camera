const EventEmitter = require("events");
const {
    normalizeAnalyticsEvent,
    toOnvifEvent
} = require("./analytics-event");

class AnalyticsDispatcher extends EventEmitter {
    constructor() {
        super();
        this.targets = new Map();
        this.activeContributors = new Map();
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
        const name = String(cameraName || "").trim();

        for (const key of this.activeContributors.keys()) {
            if (key.startsWith(name + "|")) {
                this.activeContributors.delete(key);
            }
        }

        return this.targets.delete(name);
    }

    resolveTarget(cameraName) {
        const registered = this.targets.get(cameraName);
        return typeof registered === "function"
            ? registered()
            : registered;
    }

    aggregatePropertyState(event) {
        const propertyKey = event.camera + "|" + event.type;
        const contributor = event.source + "|" + (
            event.objectId
                ? "object:" + event.objectId
                : "state"
        );
        let active = this.activeContributors.get(propertyKey);

        if (!active) {
            active = new Set();
            this.activeContributors.set(propertyKey, active);
        }

        const wasActive = active.size > 0;

        if (event.active) {
            active.add(contributor);
        } else {
            active.delete(contributor);
        }

        const isActive = active.size > 0;
        if (!isActive) {
            this.activeContributors.delete(propertyKey);
        }

        if (wasActive === isActive) {
            return null;
        }

        return normalizeAnalyticsEvent({
            ...event,
            source: "aggregate",
            active: isActive,
            objectId: null
        });
    }

    dispatch(input) {
        const inputEvent = normalizeAnalyticsEvent(input);
        const target = this.resolveTarget(inputEvent.camera);
        if (!target) {
            this.emit("unmapped", inputEvent.camera);
            return null;
        }
        if (!target.eventBus || typeof target.eventBus.publish !== "function") {
            throw new Error("analytics target for " + inputEvent.camera + " has no event bus");
        }
        const analytics = this.aggregatePropertyState(inputEvent);

        if (!analytics) {
            this.emit("suppressed", inputEvent);
            return null;
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
