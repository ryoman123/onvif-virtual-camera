const logger = require("./log-manager");
const { AnalyticsDispatcher } = require("./analytics-dispatcher");
const { FrigateMqttRouter } = require("./frigate-mqtt-router");
const { FrigateMqttRuntime } = require("./frigate-mqtt-runtime");
const { connectMqtt } = require("./simple-mqtt-client");
const { DahuaAnalyticsRouter, DahuaRecorderRuntime } = require("./dahua-recorder-runtime");
const { DahuaEventClient } = require("./dahua-event-client");

class AnalyticsRuntimeManager {
    constructor(options = {}) {
        this.config = options.config || {};
        this.cameraManagers = options.cameraManagers || [];
        this.dispatcher = options.dispatcher || new AnalyticsDispatcher();
        this.mqttConnect = options.mqttConnect || connectMqtt;
        this.recorderClientFactory = options.recorderClientFactory
            || ((clientOptions) => new DahuaEventClient(clientOptions));
        this.frigateRuntime = null;
        this.recorderRuntimes = [];
        this.registeredTargets = [];
    }

    registerCameraTargets() {
        for (const manager of this.cameraManagers) {
            const cameraName = manager.cameraConfig?.name;
            if (!cameraName) continue;

            this.dispatcher.registerTarget(cameraName, () => manager.getAnalyticsTarget());
            this.registeredTargets.push(cameraName);
        }
    }

    startFrigate() {
        const config = this.config.frigate;
        if (!config?.enabled) return;

        const router = new FrigateMqttRouter({
            topicPrefix: config.topic_prefix,
            cameraMap: config.camera_map
        });

        this.frigateRuntime = new FrigateMqttRuntime({
            router,
            dispatcher: this.dispatcher,
            connectionOptions: {
                reconnectPeriod: config.reconnect_period_ms,
                connectTimeout: config.connect_timeout_ms,
                clean: true,
                keepalive: config.keepalive_seconds,
                clientId: config.client_id,
                username: config.username,
                password: config.password
            },
            connect: (connectionOptions) => this.mqttConnect(
                config.broker,
                connectionOptions
            )
        });

        this.frigateRuntime.on("state", (health) => {
            logger.info(
                "Frigate MQTT state=" + health.state +
                ", available=" + (health.available ?? "unknown") +
                ", messages=" + health.messagesReceived +
                ", events=" + health.eventsDispatched
            );
        });
        this.frigateRuntime.on("runtimeError", (error) => {
            logger.warn("Frigate MQTT runtime error: " + error.message);
        });
        this.frigateRuntime.on("subscribed", (topics) => {
            logger.info("Frigate MQTT subscribed to: " + topics.join(", "));
        });
        this.frigateRuntime.on("traffic", (health) => {
            logger.info(
                "Frigate MQTT traffic messages=" + health.messagesReceived +
                ", dispatched=" + health.eventsDispatched +
                ", dropped=" + health.droppedMessages
            );
        });
        router.on("unmapped", (camera) => {
            logger.warn("Frigate event ignored for unmapped camera '" + camera + "'");
        });

        this.frigateRuntime.start();
        logger.info(
            "Frigate analytics enabled for " +
            Object.keys(config.camera_map).length +
            " mapped camera(s) via " + config.broker
        );
    }

    startRecorders() {
        for (const config of this.config.recorders || []) {
            if (!config.enabled) continue;

            const router = new DahuaAnalyticsRouter({
                source: config.source,
                channelMap: config.channel_map
            });
            const runtime = new DahuaRecorderRuntime({
                router,
                dispatcher: this.dispatcher
            });
            const client = this.recorderClientFactory({
                url: config.url,
                username: config.username,
                password: config.password,
                reconnectPeriod: config.reconnect_period_ms,
                connectTimeout: config.connect_timeout_ms,
                inactivityTimeout: config.inactivity_timeout_ms,
                rejectUnauthorized: config.tls_reject_unauthorized
            });

            client.on("data", (chunk) => runtime.push(chunk));
            client.on("state", (health) => {
                if (health.state === "connected") {
                    runtime.connect();
                } else if (
                    ["disconnected", "reconnecting"].includes(health.state)
                ) {
                    runtime.disconnect();
                }

                logger.info(
                    "Recorder analytics " + config.name +
                    " state=" + health.state +
                    ", connections=" + health.connections +
                    ", errors=" + health.errors
                );
            });
            client.on("runtimeError", (error) => {
                logger.warn(
                    "Recorder analytics " + config.name +
                    " error: " + error.message
                );
            });
            runtime.on("runtimeError", (error) => {
                logger.warn(
                    "Recorder parser " + config.name +
                    " error: " + error.message
                );
            });
            router.on("unmapped", (channel) => {
                logger.warn(
                    "Recorder analytics " + config.name +
                    " ignored unmapped channel " + channel
                );
            });

            this.recorderRuntimes.push({ config, router, runtime, client });
            client.start();

            logger.info(
                "Native recorder analytics enabled for " + config.name +
                " with " + Object.keys(config.channel_map).length +
                " mapped channel(s)"
            );
        }
    }

    start() {
        this.registerCameraTargets();
        this.startFrigate();
        this.startRecorders();
    }

    async stop() {
        if (this.frigateRuntime) {
            await this.frigateRuntime.stop();
            this.frigateRuntime = null;
        }

        for (const entry of this.recorderRuntimes) {
            entry.client.stop();
            entry.runtime.stop();
        }
        this.recorderRuntimes = [];

        for (const cameraName of this.registeredTargets) {
            this.dispatcher.unregisterTarget(cameraName);
        }
        this.registeredTargets = [];
    }

    health() {
        return Object.freeze({
            frigate: this.frigateRuntime ? this.frigateRuntime.health() : null,
            recorders: this.recorderRuntimes.map((entry) => Object.freeze({
                name: entry.config.name,
                client: entry.client.health(),
                runtime: entry.runtime.health()
            })),
            targets: [...this.registeredTargets],
            routing: this.dispatcher.health()
        });
    }
}

module.exports = { AnalyticsRuntimeManager };
