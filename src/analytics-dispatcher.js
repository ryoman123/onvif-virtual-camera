const EventEmitter = require("events");
const {
    normalizeAnalyticsEvent,
    toOnvifEvent
} = require("./analytics-event");

class AnalyticsDispatcher extends EventEmitter {
    constructor(options = {}) {
        super();
        this.targets = new Map();
        this.targetStats = new Map();
        this.activeContributors = new Map();
        this.now = options.now || (() => Date.now());
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
        if (!this.targetStats.has(name)) {
            this.targetStats.set(name, {
                eventsDispatched: 0,
                lastEventAt: null
            });
        }
    }

    unregisterTarget(cameraName) {
        const name = String(cameraName || "").trim();

        for (const key of this.activeContributors.keys()) {
            if (key.startsWith(name + "|")) {
                this.activeContributors.delete(key);
            }
        }

        this.targetStats.delete(name);
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
        const analytics = this.aggregatePropertyState(inputEvent);

        if (!analytics) {
            this.emit("suppressed", inputEvent);
            return null;
        }

        const target = this.resolveTarget(analytics.camera);
        if (!target) {
            this.emit("unmapped", analytics.camera);
            return null;
        }

        if (!target.eventBus || typeof target.eventBus.publish !== "function") {
            throw new Error(
                "analytics target for " + analytics.camera + " has no event bus"
            );
        }

        const onvif = toOnvifEvent(analytics, {
            videoSourceConfigToken: target.videoSourceConfigToken,
            videoAnalyticsConfigToken: target.videoAnalyticsConfigToken,
            rule: target.rule
        });
        const published = target.eventBus.publish(onvif);

        if (published) {
            const stats = this.targetStats.get(analytics.camera);
            if (stats) {
                stats.eventsDispatched += 1;
                stats.lastEventAt = new Date(this.now()).toISOString();
            }
        }

        this.emit("published", {
            analytics,
            onvif: published
        });

        return published;
    }

    health() {
        return Object.freeze([...this.targetStats.entries()].map(([camera, stats]) => (
            Object.freeze({ camera, ...stats })
        )));
    }
}

module.exports = { AnalyticsDispatcher };
