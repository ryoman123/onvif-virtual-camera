const EventEmitter = require("events");
const { DahuaEventStreamParser } = require("./dahua-event-parser");
const { normalizeAnalyticsEvent } = require("./analytics-event");

class DahuaAnalyticsRouter extends EventEmitter {
    constructor(options = {}) {
        super();
        this.channelMap = new Map(Object.entries(options.channelMap || {}).map(([channel, camera]) => [Number(channel), camera]));
        this.source = options.source || "dahua";
        this.pulseSequence = 0;
    }

    route(input) {
        if (!input || !Number.isInteger(input.channel)) return null;
        const camera = this.channelMap.get(input.channel);
        if (!camera) {
            this.emit("unmapped", input.channel);
            return null;
        }
        const event = normalizeAnalyticsEvent({
            source: this.source,
            camera,
            type: input.type,
            active: input.active,
            objectId: input.action === "pulse"
                ? "pulse-" + (++this.pulseSequence)
                : null
        });
        this.emit("analytics", event);
        return event;
    }
}

class DahuaRecorderRuntime extends EventEmitter {
    constructor(options = {}) {
        super();
        if (!options.router || typeof options.router.route !== "function") throw new Error("Dahua runtime requires a router");
        if (!options.dispatcher || typeof options.dispatcher.dispatch !== "function") throw new Error("Dahua runtime requires a dispatcher");
        this.router = options.router;
        this.dispatcher = options.dispatcher;
        this.state = "stopped";
        this.eventsReceived = 0;
        this.eventsDispatched = 0;
        this.droppedEvents = 0;
        this.errors = 0;
        this.lastEventAt = null;
        this.parser = new DahuaEventStreamParser((event) => this.handleEvent(event));
    }

    setState(state) {
        if (this.state === state) return;
        this.state = state;
        this.emit("state", this.health());
    }

    connect() {
        this.parser.reset();
        this.setState("connected");
    }

    disconnect() {
        this.parser.reset();
        if (this.state !== "stopped") this.setState("disconnected");
    }

    push(chunk) {
        if (this.state !== "connected") this.setState("connected");
        try { this.parser.push(chunk); }
        catch (error) { this.errors += 1; this.emit("runtimeError", error); }
    }

    handleEvent(input) {
        this.eventsReceived += 1;
        this.lastEventAt = new Date().toISOString();
        try {
            const event = this.router.route(input);
            if (!event) { this.droppedEvents += 1; return; }
            const published = this.dispatcher.dispatch(event);
            if (published) this.eventsDispatched += 1;
            else this.droppedEvents += 1;

            if (input.action === "pulse") {
                const cleared = this.dispatcher.dispatch({
                    ...event,
                    active: false
                });
                if (cleared) this.eventsDispatched += 1;
                else this.droppedEvents += 1;
            }
        } catch (error) {
            this.droppedEvents += 1;
            this.errors += 1;
            this.emit("runtimeError", error);
        }
    }

    stop() {
        this.parser.reset();
        this.setState("stopped");
    }

    health() {
        return Object.freeze({state:this.state,lastEventAt:this.lastEventAt,eventsReceived:this.eventsReceived,eventsDispatched:this.eventsDispatched,droppedEvents:this.droppedEvents,errors:this.errors});
    }
}
module.exports = { DahuaAnalyticsRouter, DahuaRecorderRuntime };
