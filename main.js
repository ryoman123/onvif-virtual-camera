const fs = require("fs");
const path = require("path");
const logger = require("./src/log-manager");
const configLoader = require("./src/config-loader");
const CameraManager = require("./src/camera-manager");
const DiscoveryManager = require("./src/discovery-manager");
const { stopCameraManagers } = require("./src/shutdown-manager");

async function start() {
    const startupSummaries = [];
    const managers = [];
    let shuttingDown = false;

    logger.info("Starting ONVIF Virtual Camera Server...");

    const shutdown = async (reason, exitCode = 0) => {
        if (shuttingDown) {
            return;
        }

        shuttingDown = true;
        logger.info(`Graceful shutdown requested (${reason}); stopping ${managers.length} virtual camera(s)...`);

        const errors = await stopCameraManagers(managers, reason);
        if (errors.length > 0 && exitCode === 0) {
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

    logger.info(`Initialization complete. ${startupSummaries.length} virtual camera(s) running.`);
}

start().catch((err) => {
    logger.error(`Fatal startup error: ${err.message}`);
    process.exit(1);
});
