const EventEmitter = require("events");

class FrigateMqttRuntime extends EventEmitter {
    constructor(options = {}) {
        super();

        if (typeof options.connect !== "function") {
            throw new Error("Frigate MQTT runtime requires a connect function");
        }
        if (!options.router || typeof options.router.route !== "function") {
            throw new Error("Frigate MQTT runtime requires a router");
        }
        if (!options.dispatcher || typeof options.dispatcher.dispatch !== "function") {
            throw new Error("Frigate MQTT runtime requires a dispatcher");
        }

        this.connect = options.connect;
        this.router = options.router;
        this.dispatcher = options.dispatcher;
        this.connectionOptions = {
            reconnectPeriod: 5000,
            connectTimeout: 30000,
            clean: true,
            ...(options.connectionOptions || {})
        };

        this.client = null;
        this.started = false;
        this.stopping = false;
        this.state = "stopped";
        this.available = null;
        this.connectedAt = null;
        this.lastMessageAt = null;
        this.messagesReceived = 0;
        this.eventsDispatched = 0;
        this.droppedMessages = 0;
        this.errors = 0;

        this.handlers = {
            connect: () => this.handleConnect(),
            reconnect: () => this.setState("reconnecting"),
            offline: () => this.setState("offline"),
            close: () => {
                if (!this.stopping) this.setState("disconnected");
            },
            error: (error) => this.recordError(error),
            message: (topic, payload) => this.handleMessage(topic, payload)
        };
    }

    setState(state) {
        if (this.state === state) return;
        this.state = state;
        this.emit("state", this.health());
    }

    recordError(error) {
        this.errors += 1;
        this.emit("runtimeError", error);
    }

    handleConnect() {
        if (!this.client || this.stopping) return;

        this.setState("subscribing");
        const topics = this.router.topics();
        this.client.subscribe(topics, { qos: 0 }, (error) => {
            if (error) {
                this.recordError(error);
                this.setState("degraded");
                return;
            }

            this.connectedAt = new Date().toISOString();
            this.setState("connected");
            this.emit("subscribed", [...topics]);
        });
    }

    handleMessage(topic, payload) {
        this.messagesReceived += 1;
        this.lastMessageAt = new Date().toISOString();

        try {
            const events = this.router.route(topic, payload);
            if (!events.length) {
                if (topic.endsWith("/events") || topic.endsWith("/motion")) {
                    this.droppedMessages += 1;
                }
                return;
            }

            for (const event of events) {
                const published = this.dispatcher.dispatch(event);
                if (published) {
                    this.eventsDispatched += 1;
                } else {
                    this.droppedMessages += 1;
                }
            }
        } catch (error) {
            this.droppedMessages += 1;
            this.recordError(error);
        }

        if (topic === this.router.topicPrefix + "/available") {
            this.available = this.router.available;
        }
    }

    start() {
        if (this.started) return this.client;

        this.started = true;
        this.stopping = false;
        this.setState("connecting");
        this.client = this.connect(this.connectionOptions);

        for (const [event, handler] of Object.entries(this.handlers)) {
            this.client.on(event, handler);
        }

        return this.client;
    }

    async stop() {
        if (!this.started) return;

        this.stopping = true;
        const client = this.client;
        this.client = null;

        if (client) {
            for (const [event, handler] of Object.entries(this.handlers)) {
                if (typeof client.off === "function") {
                    client.off(event, handler);
                } else {
                    client.removeListener(event, handler);
                }
            }

            await new Promise((resolve) => {
                let settled = false;
                const done = () => {
                    if (settled) return;
                    settled = true;
                    resolve();
                };

                try {
                    const result = client.end(false, {}, done);
                    if (result && typeof result.then === "function") {
                        result.then(done, (error) => {
                            this.recordError(error);
                            done();
                        });
                    }
                } catch (error) {
                    this.recordError(error);
                    done();
                }
            });
        }

        this.started = false;
        this.stopping = false;
        this.setState("stopped");
    }

    health() {
        return Object.freeze({
            state: this.state,
            available: this.router.available ?? this.available,
            connectedAt: this.connectedAt,
            lastMessageAt: this.lastMessageAt,
            messagesReceived: this.messagesReceived,
            eventsDispatched: this.eventsDispatched,
            droppedMessages: this.droppedMessages,
            errors: this.errors
        });
    }
}

module.exports = { FrigateMqttRuntime };
