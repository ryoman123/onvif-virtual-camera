function collectRequiredEnvironment(config) {
    const required = [];
    const frigate = config.analytics?.frigate;
    if (frigate?.usernameEnv) required.push(frigate.usernameEnv, frigate.passwordEnv);
    for (const recorder of config.analytics?.recorders || []) {
        required.push(recorder.usernameEnv, recorder.passwordEnv);
    }
    return [...new Set(required.filter(Boolean))];
}

function buildDeploymentPreflight(config, options = {}) {
    if (!config || !Array.isArray(config.cameras)) {
        throw new Error("Deployment preflight requires a loaded configuration");
    }

    const env = options.env || process.env;
    const expectedCameraCount = options.expectedCameraCount == null
        ? null
        : Number(options.expectedCameraCount);
    if (expectedCameraCount != null && (!Number.isInteger(expectedCameraCount) || expectedCameraCount <= 0)) {
        throw new Error("Expected camera count must be a positive integer");
    }

    const cameraNames = new Set(config.cameras.map((camera) => camera.name));
    const coveredNames = new Set();
    const frigate = config.analytics?.frigate;
    for (const target of Object.values(frigate?.cameraMap || {})) coveredNames.add(target);

    const recorders = config.analytics?.recorders || [];
    let recorderMappings = 0;
    for (const recorder of recorders) {
        const targets = Object.values(recorder.channelMap || {});
        recorderMappings += targets.length;
        for (const target of targets) coveredNames.add(target);
    }

    const requiredEnvironment = collectRequiredEnvironment(config);
    const missingEnvironment = requiredEnvironment.filter((name) => !env[name]);
    const uncoveredCameras = [...cameraNames].filter((name) => !coveredNames.has(name));
    const failures = [];

    if (expectedCameraCount != null && config.cameras.length !== expectedCameraCount) {
        failures.push(`Expected ${expectedCameraCount} virtual cameras but configuration contains ${config.cameras.length}`);
    }
    if (missingEnvironment.length) {
        failures.push(`Missing required environment variables: ${missingEnvironment.join(", ")}`);
    }
    if (options.requireAnalyticsCoverage && uncoveredCameras.length) {
        failures.push(`Analytics coverage is missing for: ${uncoveredCameras.join(", ")}`);
    }

    return Object.freeze({
        ok: failures.length === 0,
        cameraCount: config.cameras.length,
        staticCameraCount: config.cameras.filter((camera) => camera.ipAssignment?.mode === "static").length,
        dhcpCameraCount: config.cameras.filter((camera) => camera.ipAssignment?.mode === "dhcp").length,
        analytics: Object.freeze({
            frigateMappings: Object.keys(frigate?.cameraMap || {}).length,
            recorderCount: recorders.length,
            recorderMappings,
            coveredCameraCount: coveredNames.size,
            uncoveredCameras: Object.freeze(uncoveredCameras)
        }),
        requiredEnvironment: Object.freeze(requiredEnvironment),
        missingEnvironment: Object.freeze(missingEnvironment),
        failures: Object.freeze(failures)
    });
}

module.exports = { buildDeploymentPreflight, collectRequiredEnvironment };
