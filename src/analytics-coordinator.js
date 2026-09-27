const EventEmitter = require("events");
const { AnalyticsDispatcher } = require("./analytics-dispatcher");
const { AnalyticsTargetRegistry } = require("./analytics-target-registry");

class AnalyticsCoordinator extends EventEmitter {
    constructor(options = {}) {
        super();
        this.dispatcher = options.dispatcher || new AnalyticsDispatcher();
        this.registry = options.registry || new AnalyticsTargetRegistry(this.dispatcher);
        this.runtimes = [];
        this.started = false;
        this.stopping = false;
    }

    registerCameraManagers(managers) {
        for (const manager of managers || []) this.registry.registerManager(manager);
    }

    addRuntime(name, runtime) {
        const label = String(name || "").trim();
        if (!label) throw new Error("analytics runtime name must be non-empty");
        if (!runtime || typeof runtime !== "object") throw new Error("analytics runtime must be an object");
        if (this.runtimes.some((entry) => entry.name === label)) throw new Error("duplicate analytics runtime: " + label);
        this.runtimes.push({ name: label, runtime });
        return runtime;
    }

    async start() {
        if (this.started) return this.health();
        const started = [];
        try {
            for (const entry of this.runtimes) {
                if (typeof entry.runtime.start === "function") await entry.runtime.start();
                started.push(entry);
            }
            this.started = true;
            this.emit("state", this.health());
            return this.health();
        } catch (error) {
            for (const entry of started.reverse()) {
                try { if (typeof entry.runtime.stop === "function") await entry.runtime.stop(); }
                catch (stopError) { this.emit("runtimeError", { name: entry.name, error: stopError }); }
            }
            throw error;
        }
    }

    async stop() {
        if (this.stopping) return;
        this.stopping = true;
        const errors = [];
        for (const entry of [...this.runtimes].reverse()) {
            try { if (typeof entry.runtime.stop === "function") await entry.runtime.stop(); }
            catch (error) { errors.push({ name: entry.name, error }); }
        }
        this.registry.clear();
        this.started = false;
        this.stopping = false;
        this.emit("state", this.health());
        return errors;
    }

    health() {
        const adapters = {};
        for (const entry of this.runtimes) {
            adapters[entry.name] = typeof entry.runtime.health === "function"
                ? entry.runtime.health()
                : { state: this.started ? "started" : "stopped" };
        }
        return Object.freeze({ state: this.started ? "running" : "stopped", targets: this.registry.managers.size, adapters });
    }
}

module.exports = { AnalyticsCoordinator };
