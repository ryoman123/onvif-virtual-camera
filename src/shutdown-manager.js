const logger = require("./log-manager");

async function stopCameraManagers(managers, reason = "shutdown") {
    const list = Array.from(managers || []);
    const errors = [];

    for (const manager of list.reverse()) {
        try {
            await manager.stop();
        } catch (err) {
            errors.push({
                name: manager?.cameraConfig?.name || "<unknown>",
                error: err
            });
            logger.warn(
                `Failed to stop virtual camera ${manager?.cameraConfig?.name || "<unknown>"} ` +
                `during ${reason}: ${err.message}`
            );
        }
    }

    return errors;
}

module.exports = {
    stopCameraManagers
};
