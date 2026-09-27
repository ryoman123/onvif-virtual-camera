const fs = require("fs");
const path = require("path");
const logger = require("./src/log-manager");
const configLoader = require("./src/config-loader");
const CameraManager = require("./src/camera-manager");
const DiscoveryManager = require("./src/discovery-manager");
const { stopCameraManagers } = require("./src/shutdown-manager");
const { AnalyticsCoordinator } = require("./src/analytics-coordinator");
const { FrigateMqttRouter } = require("./src/frigate-mqtt-router");
const { FrigateMqttRuntime } = require("./src/frigate-mqtt-runtime");
const { DahuaAnalyticsRouter, DahuaRecorderRuntime } = require("./src/dahua-recorder-runtime");
const { DahuaEventTransport } = require("./src/dahua-event-transport");

function configureAnalytics(config, coordinator, env = process.env, connect = require("mqtt").connect, recorderRequest) {
    const frigate = config.analytics?.frigate;
    if (frigate) {
        const connectionOptions = {};
        if (frigate.usernameEnv) {
            const username = env[frigate.usernameEnv];
            const password = env[frigate.passwordEnv];
            if (!username || !password) throw new Error("Frigate MQTT credentials are missing from environment");
            connectionOptions.username = username;
            connectionOptions.password = password;
        }
        const router = new FrigateMqttRouter({
            cameraMap: frigate.cameraMap, topicPrefix: frigate.topicPrefix,
            motionMode: frigate.motionMode, motionLabels: frigate.motionLabels
        });
        const runtime = new FrigateMqttRuntime({
            connect: (options) => connect(frigate.url, options),
            connectionOptions, router, dispatcher: coordinator.dispatcher
        });
        runtime.on("state", (health) => {
            logger.info(`Frigate MQTT state: ${health.state} (messages=${health.messagesReceived}, dispatched=${health.eventsDispatched}, errors=${health.errors})`);
        });
        runtime.on("subscribed", (topics) => {
            logger.info(`Frigate MQTT subscribed to: ${topics.join(", ")}`);
        });
        runtime.on("traffic", (health) => {
            logger.info(`Frigate MQTT traffic: messages=${health.messagesReceived}, dispatched=${health.eventsDispatched}, dropped=${health.droppedMessages}`);
        });
        runtime.on("runtimeError", (error) => logger.warn(`Frigate MQTT error: ${error.message}`));
        coordinator.addRuntime("frigate", runtime);
    }

    for (const recorder of config.analytics?.recorders || []) {
        const username = env[recorder.usernameEnv];
        const password = env[recorder.passwordEnv];
        if (!username || !password) throw new Error(`Recorder '${recorder.name}' credentials are missing from environment`);
        const router = new DahuaAnalyticsRouter({ source: recorder.source, channelMap: recorder.channelMap });
        const analyticsRuntime = new DahuaRecorderRuntime({ router, dispatcher: coordinator.dispatcher });
        const transport = new DahuaEventTransport({
            url: recorder.url, username, password, runtime: analyticsRuntime, request: recorderRequest,
            reconnectMinMs: recorder.reconnectMinMs, reconnectMaxMs: recorder.reconnectMaxMs,
            inactivityTimeoutMs: recorder.inactivityTimeoutMs
        });
        transport.on("runtimeError", (error) => logger.warn(`Recorder '${recorder.name}' event stream error: ${error.message}`));
        coordinator.addRuntime(`recorder:${recorder.name}`, transport);
    }
}

async function start() {
    const startupSummaries = [];
    const managers = [];
    const analytics = new AnalyticsCoordinator();
    let shuttingDown = false;

    logger.info("Starting ONVIF Virtual Camera Server...");

    const shutdown = async (reason, exitCode = 0) => {
        if (shuttingDown) {
            return;
        }

        shuttingDown = true;
        logger.info(`Graceful shutdown requested (${reason}); stopping ${managers.length} virtual camera(s)...`);

        const analyticsErrors = await analytics.stop();
        for (const failure of analyticsErrors) logger.warn(`Failed to stop ${failure.name}: ${failure.error.message}`);
        const errors = await stopCameraManagers(managers, reason);
        if (errors.length > 0 || analyticsErrors.length > 0) {
            exitCode = 1;
        }

        logger.info(`Graceful shutdown complete (${reason})`);
        process.exit(exitCode);
    };

    process.once("SIGTERM", () => {
        shutdown("SIGTERM").catch((err) => {
            logger.error(`Graceful shutdown failed after SIGTERM: ${err.message}`);
            process.exit(1);
        });
    });

    process.once("SIGINT", () => {
        shutdown("SIGINT").catch((err) => {
            logger.error(`Graceful shutdown failed after SIGINT: ${err.message}`);
            process.exit(1);
        });
    });

    const configPath = fs.existsSync(path.resolve("./config.yml"))
        ? path.resolve("./config.yml")
        : "/config.yml";

    let config;
    const discoveryManager = new DiscoveryManager();

    try {
        config = configLoader.loadConfig(configPath);
        logger.info(`Loaded configuration for ${config.cameras.length} virtual cameras`);
    } catch (err) {
        logger.error(`Failed to load config: ${err.message}`);
        await shutdown("configuration failure", 1);
        return;
    }

    for (const cam of config.cameras) {
        const manager = new CameraManager(cam, discoveryManager);
        managers.push(manager);

        try {
            const summary = await manager.start();
            startupSummaries.push(summary);
            logger.info(`${summary.name} is up at ${summary.ip} (${summary.interface}) using MAC: ${summary.mac}`);
        } catch (err) {
            logger.error(`Failed to initialize camera ${cam.name}: ${err.message}`);
            await shutdown(`startup failure: ${cam.name}`, 1);
            return;
        }
    }

    analytics.registerCameraManagers(managers);
    try {
        configureAnalytics(config, analytics);
        await analytics.start();
    } catch (err) {
        logger.warn(`Analytics startup failed; camera services remain available: ${err.message}`);
    }

    logger.info(`Initialization complete. ${startupSummaries.length} virtual camera(s) running.`);
}

if (require.main === module) {
    start().catch((err) => {
        logger.error(`Fatal startup error: ${err.message}`);
        process.exit(1);
    });
}

module.exports = { configureAnalytics, start };
