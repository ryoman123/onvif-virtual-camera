class AnalyticsTargetRegistry {
    constructor(dispatcher) {
        if (!dispatcher || typeof dispatcher.registerTarget !== "function" || typeof dispatcher.unregisterTarget !== "function") {
            throw new Error("analytics target registry requires a dispatcher");
        }
        this.dispatcher = dispatcher;
        this.managers = new Map();
    }

    registerManager(manager) {
        const name = String(manager?.cameraConfig?.name || "").trim();
        if (!name) throw new Error("camera manager must have a configured name");
        if (this.managers.has(name)) throw new Error("analytics target already registered: " + name);

        this.managers.set(name, manager);
        this.dispatcher.registerTarget(name, () => this.resolveManagerTarget(name));
    }

    resolveManagerTarget(name) {
        const manager = this.managers.get(name);
        const server = manager?.server;
        if (!server || !server.eventBus || !server.mediaService) return null;

        return {
            eventBus: server.eventBus,
            videoSourceConfigToken: server.mediaService.videoSourceConfigTokenHq,
            videoAnalyticsConfigToken: server.mediaService.videoAnalyticsConfigToken || "video_analytics_config",
            rule: "MotionDetector"
        };
    }

    unregisterManager(managerOrName) {
        const name = typeof managerOrName === "string"
            ? managerOrName.trim()
            : String(managerOrName?.cameraConfig?.name || "").trim();
        if (!name) return false;

        const existed = this.managers.delete(name);
        this.dispatcher.unregisterTarget(name);
        return existed;
    }

    clear() {
        for (const name of [...this.managers.keys()]) this.unregisterManager(name);
    }
}

module.exports = { AnalyticsTargetRegistry };
