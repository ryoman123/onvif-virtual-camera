const fs = require("fs");
const { spawnSync } = require("child_process");
const yaml = require("js-yaml");
const logger = require("./log-manager");

function hasAuth(object) {
    return !!(
        object.auth &&
        object.auth.username &&
        object.auth.password
    );
}

function getDefaultRuntime() {
    return {
        enable_debug_logs: false,
        probe_streams: true,
        probe_timeout_ms: 15000,
        ip_monitor_interval_ms: 5000,
        ws_security: {
            mode: "audit",
            max_age_seconds: 300,
            future_skew_seconds: 300,
            nonce_cache_size: 2048,
            allow_password_text: true
        }
    };
}

function getDefaultStreamConfig() {
    return {
        encoding: "H264",
        width: 1920,
        height: 1080,
        framerate: 15,
        bitrate: 2048,
        quality: 5
    };
}

function getMinimumStreamConfig() {
    return {
        framerate: 5
    };
}

function normalizeRtspPath(path, label) {
    if (typeof path !== "string") {
        throw new Error(`${label} must be a string.`);
    }

    const trimmed = path.trim();
    if (trimmed === "") {
        throw new Error(`${label} must not be empty.`);
    }

    return trimmed.startsWith("/")
        ? trimmed
        : `/${trimmed}`;
}

function loadConfig(configPath) {
    if (!fs.existsSync(configPath)) {
        throw new Error(`Config file not found at ${configPath}`);
    }

    let raw;
    try {
        raw = fs.readFileSync(configPath, "utf8");
    } catch (err) {
        throw new Error(`Failed to read config file: ${err.message}`);
    }

    let config;
    try {
        config = yaml.load(raw);
    } catch (err) {
        logger.error(`Failed to parse config file as YAML: ${err.message}`);
        throw new Error(`Failed to parse YAML: ${err.message}`);
    }

    // Validate top-level structure
    if (!config.host_sources || !Array.isArray(config.host_sources)) {
        throw new Error("Config must contain 'host_sources' as an array.");
    }

    if (!config.virtual_cameras || !Array.isArray(config.virtual_cameras)) {
        throw new Error("Config must contain 'virtual_cameras' as an array.");
    }

    // Set runtime values
    const defaultRuntime = getDefaultRuntime();
    const runtime = {
        ...defaultRuntime,
        ...(config.runtime || {}),
        ws_security: {
            ...defaultRuntime.ws_security,
            ...((config.runtime && config.runtime.ws_security) || {})
        }
    };
    validateRuntimeSettings(runtime);
    runtime.ws_security = Object.freeze({ ...runtime.ws_security });
    global.runtime = Object.freeze(runtime);

    // Build host source lookup map
    const sourcesByName = {};
    for (const src of config.host_sources) {
        validateHostSource(src);

        if (sourcesByName[src.name]) {
            throw new Error(`Duplicate host_source name '${src.name}' found in config.`);
        }

        sourcesByName[src.name] = {
            hostname: src.hostname,
            rtsp_port: src.rtsp_port,
            http_port: src.http_port,
            auth: hasAuth(src) ? {
                username: src.auth.username,
                password: src.auth.password
            } : null
        };
    }

    // Resolve virtual cameras
    const seenCameraNames = new Set();
    const seenCameraMacs = new Set();

    const cameras = config.virtual_cameras.map((cam) => {
        validateVirtualCamera(cam);

        if (seenCameraNames.has(cam.name)) {
            throw new Error(`Duplicate virtual_camera name '${cam.name}' found in config.`);
        }
        seenCameraNames.add(cam.name);

        const source = sourcesByName[cam.host_source];
        if (!source) {
            throw new Error(
                `Virtual camera '${cam.name}' references unknown host_source '${cam.host_source}'.`
            );
        }

        // Normalize MAC
        const mac = cam.mac.toLowerCase();
        if (seenCameraMacs.has(mac)) {
            throw new Error(`Duplicate virtual_camera MAC '${mac}' found in config.`);
        }
        seenCameraMacs.add(mac);

        const rtspPathHq = normalizeRtspPath(cam.rtsp_path_hq, `virtual_camera '${cam.name}'.rtsp_path_hq`);
        const rtspPathLq = normalizeRtspPath(cam.rtsp_path_lq, `virtual_camera '${cam.name}'.rtsp_path_lq`);
        const snapshotPath = cam.snapshot_path.startsWith("/")
            ? cam.snapshot_path
            : `/${cam.snapshot_path}`;

        // Construct full URLs with optional authentication
        const authPrefix = hasAuth(source)
            ? `${encodeURIComponent(source.auth.username)}:${encodeURIComponent(source.auth.password)}@`
            : "";

        // RTSP URL
        const rtspUrlHq = `rtsp://${authPrefix}${source.hostname}:${source.rtsp_port}${rtspPathHq}`;
        const rtspUrlLq = `rtsp://${authPrefix}${source.hostname}:${source.rtsp_port}${rtspPathLq}`;

        // Snapshot URL
        const snapshotUrl =
            `http://${authPrefix}${source.hostname}:${source.http_port}${snapshotPath}`;

        // Construct our camera object
        const camera = {
            name: cam.name,
            model: cam.model,
            mac,
            ipAssignment: normalizeIpAssignment(cam.ip, `virtual_camera '${cam.name}'.ip`),
            rtspPathHq,
            rtspPathLq,
            snapshotPath,
            rtspUrlHq,
            rtspUrlLq,
            snapshotUrl,
            streamConfigHq: normalizeConfiguredStream(cam.stream_hq, `virtual_camera '${cam.name}'.stream_hq`),
            streamConfigLq: normalizeConfiguredStream(cam.stream_lq, `virtual_camera '${cam.name}'.stream_lq`),
            identity: normalizeIdentity(cam),
            auth: hasAuth(source) ? {
                username: source.auth.username,
                password: source.auth.password
            } : null,
            host: {
                hostname: source.hostname,
                rtsp_port: source.rtsp_port,
                http_port: source.http_port
            }
        };

        camera.streams = {
            hq: resolveStreamDetails(camera, runtime, "hq"),
            lq: resolveStreamDetails(camera, runtime, "lq")
        };

        return camera;
    });

    return { runtime, cameras };
}

function resolveStreamDetails(cam, runtime, streamKind) {
    const defaults = getDefaultStreamConfig();
    const configured = streamKind === "lq"
        ? (cam.streamConfigLq || {})
        : (cam.streamConfigHq || {});
    const streamLabel = streamKind.toUpperCase();

    if (Object.keys(configured).length > 0) {
        logger.info(`Skipping ffprobe for '${cam.name}' ${streamLabel} stream because stream config was provided`);
        return {
            ...defaults,
            ...configured
        };
    }

    if (!runtime.probe_streams) {
        logger.info(`Skipping ffprobe for '${cam.name}' ${streamLabel} stream because runtime.probe_streams=false`);
        return {
            ...defaults,
            ...configured
        };
    }

    const probed = fetchStreamDetails(cam, runtime, streamKind);
    return {
        ...defaults,
        ...probed,
        ...configured
    };
}

function fetchStreamDetails(cam, runtime, streamKind) {
    const defaults = getDefaultStreamConfig();
    const minimums = getMinimumStreamConfig();
    const ffprobePath = process.env.FFPROBE_PATH || "/usr/bin/ffprobe";
    const streamLabel = streamKind.toUpperCase();
    const rtspUrl = streamKind === "lq" ? cam.rtspUrlLq : cam.rtspUrlHq;
    logger.debug('config', `Using ffprobe path: ${ffprobePath}`);

    logger.debug('config', `Calling ffprobe for '${cam.name}' ${streamLabel} stream with URL: ${rtspUrl}`);
    const result = spawnSync(
        ffprobePath,
        [
            "-v", "error",
            "-rtsp_transport", "tcp",
            "-select_streams", "v:0",
            "-show_entries", "stream=codec_name,width,height,avg_frame_rate,bit_rate",
            "-of", "json",
            rtspUrl
        ],
        {
            encoding: "utf8",
            timeout: runtime.probe_timeout_ms
        }
    );

    if (result.error) {
        logger.warn(`ffprobe failed for '${cam.name}' ${streamLabel} stream: ${result.error.message}; using defaults`);
        return defaults;
    }

    if (result.status !== 0) {
        logger.warn(
            `ffprobe returned non-zero for '${cam.name}' ${streamLabel} stream: ` +
            `${(result.stderr || "").trim() || `exit ${result.status}`}; using defaults`
        );
        return defaults;
    }

    let parsed;
    try {
        parsed = JSON.parse(result.stdout);
    } catch (err) {
        logger.warn(`Failed to parse ffprobe output for '${cam.name}' ${streamLabel} stream: ${err.message}; using defaults`);
        return defaults;
    }

    const stream = parsed?.streams?.[0];
    if (!stream) {
        logger.warn(`ffprobe returned no video stream for '${cam.name}' ${streamLabel} stream; using defaults`);
        return defaults;
    }

    const parseFrameRate = (value) => {
        const [num, den] = String(value || "").split("/", 2).map(Number);
        if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) {
            return null;
        }

        const fps = num / den;
        return Number.isFinite(fps) && fps > 0 ? Math.round(fps) : null;
    };

    const codecMap = {
        h264: "H264",
        hevc: "H265",
        h265: "H265",
        mjpeg: "MJPEG"
    };

    const detected = {
        encoding: codecMap[String(stream.codec_name || "").toLowerCase()] || defaults.encoding,
        width: Number.isFinite(stream.width) && stream.width > 0 ? stream.width : defaults.width,
        height: Number.isFinite(stream.height) && stream.height > 0 ? stream.height : defaults.height,
        framerate: Math.max(parseFrameRate(stream.avg_frame_rate) || defaults.framerate, minimums.framerate),
        bitrate: Number.isFinite(Number(stream.bit_rate)) && Number(stream.bit_rate) > 0
            ? Math.round(Number(stream.bit_rate) / 1000)
            : defaults.bitrate,
        quality: defaults.quality
    };

    logger.debug('config', `Detected ${streamLabel} stream details for '${cam.name}': ${detected.encoding}, ${detected.width}x${detected.height}, ${detected.framerate}fps, ${detected.bitrate}kbps`);

    return detected;
}

function normalizeConfiguredStream(stream, label) {
    if (stream === undefined || stream === null) {
        return null;
    }

    const normalized = {
        encoding: stream.encoding,
        width: normalizePositiveInteger(stream.width, `${label}.width`),
        height: normalizePositiveInteger(stream.height, `${label}.height`),
        framerate: normalizePositiveInteger(stream.framerate, `${label}.framerate`),
        bitrate: normalizePositiveInteger(stream.bitrate, `${label}.bitrate`),
        quality: normalizePositiveNumber(stream.quality, `${label}.quality`)
    };

    const requiredKeys = ["encoding", "width", "height", "framerate", "bitrate", "quality"];
    const missingKeys = requiredKeys.filter((key) => normalized[key] === undefined);
    if (missingKeys.length > 0) {
        throw new Error(`${label} config is missing required field(s): ${missingKeys.join(", ")}.`);
    }

    return normalized;
}

function normalizeIdentity(cam) {
    const defaultHardwareId = [normalizeOptionalString(cam.model, "model"), cam.mac.replace(/:/g, "").toUpperCase()]
        .filter(Boolean)
        .join("-");

    return {
        manufacturer: normalizeOptionalString(cam.manufacturer, "manufacturer") || "VirtualCam",
        model: normalizeOptionalString(cam.model, "model") || cam.name,
        firmwareVersion: normalizeOptionalString(cam.firmware_version, "firmware_version") || "1.0",
        serialNumber: normalizeOptionalString(cam.serial_number, "serial_number")
            || cam.mac.replace(/:/g, "").toUpperCase(),
        hardwareId: normalizeOptionalString(cam.hardware_id, "hardware_id")
            || defaultHardwareId
            || cam.mac.replace(/:/g, "").toUpperCase()
    };
}

function validateRuntimeSettings(runtime) {
    if (typeof runtime.probe_streams !== "boolean") {
        throw new Error("runtime.probe_streams must be true or false.");
    }

    normalizePositiveInteger(runtime.probe_timeout_ms, "runtime.probe_timeout_ms");
    normalizePositiveInteger(runtime.ip_monitor_interval_ms, "runtime.ip_monitor_interval_ms");

    if (!runtime.ws_security || typeof runtime.ws_security !== "object" || Array.isArray(runtime.ws_security)) {
        throw new Error("runtime.ws_security must be an object.");
    }

    if (!["audit", "enforce"].includes(runtime.ws_security.mode)) {
        throw new Error("runtime.ws_security.mode must be 'audit' or 'enforce'.");
    }

    normalizePositiveInteger(runtime.ws_security.max_age_seconds, "runtime.ws_security.max_age_seconds");
    normalizeNonNegativeInteger(runtime.ws_security.future_skew_seconds, "runtime.ws_security.future_skew_seconds");
    normalizePositiveInteger(runtime.ws_security.nonce_cache_size, "runtime.ws_security.nonce_cache_size");

    if (typeof runtime.ws_security.allow_password_text !== "boolean") {
        throw new Error("runtime.ws_security.allow_password_text must be true or false.");
    }
}

function normalizeIpAssignment(value, label) {
    if (typeof value !== "string") {
        throw new Error(`${label} must be a string.`);
    }

    const trimmed = value.trim();
    if (trimmed === "") {
        throw new Error(`${label} must not be empty.`);
    }

    if (trimmed.toUpperCase() === "DHCP") {
        return {
            mode: "dhcp",
            value: "DHCP"
        };
    }

    const match = trimmed.match(/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/);
    if (!match) {
        throw new Error(`${label} must be 'DHCP' or an IPv4 CIDR address.`);
    }

    const octets = match[1].split(".").map(Number);
    if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
        throw new Error(`${label} must contain a valid IPv4 address.`);
    }

    const prefix = Number(match[2]);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
        throw new Error(`${label} must contain a valid CIDR prefix.`);
    }

    return {
        mode: "static",
        value: `${octets.join(".")}/${prefix}`,
        address: octets.join("."),
        prefix
    };
}

function validateHostSource(src) {
    const required = ["name", "hostname", "rtsp_port", "http_port"];
    for (const key of required) {
        if (!src[key]) {
            throw new Error(`host_source missing required field '${key}'.`);
        }
    }

    if (src.auth) {
        const hasUsername = !!src.auth.username;
        const hasPassword = !!src.auth.password;

        if (hasUsername !== hasPassword) {
            throw new Error(
                "host_source.auth must contain both username and password if either is specified."
            );
        }
    }

    normalizePositiveInteger(src.rtsp_port, `host_source '${src.name}'.rtsp_port`);
    normalizePositiveInteger(src.http_port, `host_source '${src.name}'.http_port`);
}

function validateVirtualCamera(cam) {
    const required = ["name", "model", "mac", "ip", "host_source", "rtsp_path_hq", "rtsp_path_lq", "snapshot_path"];
    for (const key of required) {
        if (!cam[key]) {
            throw new Error(`virtual_camera missing required field '${key}'.`);
        }
    }

    if (!/^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/.test(cam.mac)) {
        throw new Error(`virtual_camera '${cam.name}' has invalid MAC address '${cam.mac}'.`);
    }

    normalizeRtspPath(cam.rtsp_path_hq, `virtual_camera '${cam.name}'.rtsp_path_hq`);
    normalizeRtspPath(cam.rtsp_path_lq, `virtual_camera '${cam.name}'.rtsp_path_lq`);

    if (cam.stream_hq) {
        normalizeConfiguredStream(cam.stream_hq, `virtual_camera '${cam.name}'.stream_hq`);
    }

    if (cam.stream_lq) {
        normalizeConfiguredStream(cam.stream_lq, `virtual_camera '${cam.name}'.stream_lq`);
    }

    normalizeIdentity(cam);
    normalizeIpAssignment(cam.ip, `virtual_camera '${cam.name}'.ip`);
}

function normalizePositiveInteger(value, label) {
    if (value === undefined || value === null) {
        return undefined;
    }

    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`${label} must be a positive integer.`);
    }

    return parsed;
}

function normalizeNonNegativeInteger(value, label) {
    if (value === undefined || value === null) {
        return undefined;
    }

    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error(`${label} must be a non-negative integer.`);
    }

    return parsed;
}

function normalizePositiveNumber(value, label) {
    if (value === undefined || value === null) {
        return undefined;
    }

    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`${label} must be a positive number.`);
    }

    return parsed;
}

function normalizeOptionalString(value, label) {
    if (value === undefined || value === null) {
        return undefined;
    }

    if (typeof value !== "string") {
        throw new Error(`${label} must be a string.`);
    }

    const trimmed = value.trim();
    if (trimmed === "") {
        throw new Error(`${label} must not be empty.`);
    }

    return trimmed;
}

module.exports = { loadConfig };