const logger = require("./log-manager");
const { AnalyticsDispatcher } = require("./analytics-dispatcher");
const { FrigateMqttRouter } = require("./frigate-mqtt-router");
const { FrigateMqttRuntime } = require("./frigate-mqtt-runtime");
const { connectMqtt } = require("./simple-mqtt-client");

class AnalyticsRuntimeManager {
    constructor(options = {}) {
        this.config = options.config || {};
        this.cameraManagers = options.cameraManagers || [];
        this.dispatcher = options.dispatcher || new AnalyticsDispatcher();
        this.mqttConnect = options.mqttConnect || connectMqtt;
        this.frigateRuntime = null;
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

    start() {
        this.registerCameraTargets();
        this.startFrigate();
    }

    async stop() {
        if (this.frigateRuntime) {
            await this.frigateRuntime.stop();
            this.frigateRuntime = null;
        }

        for (const cameraName of this.registeredTargets) {
            this.dispatcher.unregisterTarget(cameraName);
        }
        this.registeredTargets = [];
    }

    health() {
        return Object.freeze({
            frigate: this.frigateRuntime ? this.frigateRuntime.health() : null,
            targets: [...this.registeredTargets]
        });
    }
}

module.exports = { AnalyticsRuntimeManager };
