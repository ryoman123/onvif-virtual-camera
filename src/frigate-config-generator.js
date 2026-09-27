const yaml = require("js-yaml");
const { toFrigateCameraName } = require("./frigate-naming");

const DEFAULT_TRACKED_OBJECTS = Object.freeze([
    "person",
    "car",
    "motorcycle",
    "bicycle",
    "bus",
    "dog",
    "cat",
    "bird"
]);

function assertArray(value, label) {
    if (!Array.isArray(value)) throw new Error(label + " must be an array");
    return value;
}

function requireString(value, label) {
    if (typeof value !== "string" || !value.trim()) {
        throw new Error(label + " must be a non-empty string");
    }
    return value.trim();
}

function normalizeRtspPath(value, label) {
    const path = requireString(value, label);
    return path.startsWith("/") ? path : "/" + path;
}

function formatHost(hostname) {
    return hostname.includes(":") && !hostname.startsWith("[")
        ? "[" + hostname + "]"
        : hostname;
}

function buildRtspUrl(source, path) {
    const host = formatHost(requireString(source.hostname, "host_source.hostname"));
    const port = Number(source.rtsp_port);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new Error("host_source.rtsp_port must be a valid TCP port");
    }

    let auth = "";
    if (source.auth) {
        const username = requireString(source.auth.username, "host_source.auth.username");
        const password = requireString(source.auth.password, "host_source.auth.password");
        auth = encodeURIComponent(username) + ":" + encodeURIComponent(password) + "@";
    }

    return "rtsp://" + auth + host + ":" + port + path;
}

function dotenvValue(value) {
    const text = String(value);
    if (/[\r\n]/.test(text)) {
        throw new Error("Generated environment values must not contain newlines");
    }

    return "'" + text
        .replace(/\\/g, "\\\\")
        .replace(/'/g, "\\'") + "'";
}

function parseMqtt(config, options = {}) {
    const frigate = config.analytics?.frigate || {};
    const broker = options.mqttBroker || frigate.broker;
    if (!broker) {
        throw new Error(
            "analytics.frigate.broker is required to generate the Frigate sidecar config"
        );
    }

    let parsed;
    try {
        parsed = new URL(broker);
    } catch {
        throw new Error("analytics.frigate.broker must be a valid MQTT URL");
    }

    if (!["mqtt:", "mqtts:"].includes(parsed.protocol)) {
        throw new Error("analytics.frigate.broker must use mqtt:// or mqtts://");
    }
    if (parsed.username || parsed.password) {
        throw new Error(
            "MQTT credentials must use analytics.frigate username/password fields"
        );
    }

    const username = frigate.username || null;
    const password = frigate.password || null;
    if ((username && !password) || (!username && password)) {
        throw new Error(
            "analytics.frigate.username and password must be provided together"
        );
    }

    const secure = parsed.protocol === "mqtts:";
    const port = Number(parsed.port || (secure ? 8883 : 1883));
    return {
        host: parsed.hostname,
        port,
        secure,
        topicPrefix: frigate.topic_prefix || "frigate",
        username,
        password,
        caCerts: options.mqttCaCerts || "/etc/ssl/certs/ca-certificates.crt"
    };
}

function generateFrigateBundle(config, options = {}) {
    if (!config || typeof config !== "object" || Array.isArray(config)) {
        throw new Error("Bridge config must be an object");
    }

    const sources = new Map();
    for (const source of assertArray(config.host_sources, "host_sources")) {
        const name = requireString(source.name, "host_source.name");
        if (sources.has(name)) {
            throw new Error("Duplicate host_source name '" + name + "'");
        }
        sources.set(name, source);
    }

    const cameras = assertArray(config.virtual_cameras, "virtual_cameras");
    if (cameras.length === 0) {
        throw new Error("virtual_cameras must contain at least one camera");
    }

    const mqtt = parseMqtt(config, options);
    const trackedObjects = options.trackedObjects || DEFAULT_TRACKED_OBJECTS;
    const detectFps = Number(options.detectFps ?? 3);
    if (!Number.isInteger(detectFps) || detectFps <= 0) {
        throw new Error("detectFps must be a positive integer");
    }
    const openvinoThreads = Number(options.openvinoThreads ?? 3);
    if (!Number.isInteger(openvinoThreads) || openvinoThreads <= 0) {
        throw new Error("openvinoThreads must be a positive integer");
    }

    const frigateConfig = {
        mqtt: {
            enabled: true,
            host: "{FRIGATE_MQTT_HOST}",
            port: mqtt.port,
            topic_prefix: mqtt.topicPrefix,
            client_id: options.clientId || "frigate-onvif-vcam"
        },
        record: { enabled: false },
        snapshots: { enabled: false },
        detectors: {
            ov: {
                type: "openvino",
                device: "CPU",
                num_threads: openvinoThreads
            }
        },
        model: {
            width: 300,
            height: 300,
            input_tensor: "nhwc",
            input_pixel_format: "bgr",
            model_type: "ssd",
            path: "/openvino-model/ssdlite_mobilenet_v2.xml",
            labelmap_path: "/openvino-model/coco_91cl_bkgr.txt"
        },
        objects: { track: [...trackedObjects] },
        go2rtc: { streams: {} },
        cameras: {}
    };

    if (mqtt.username) {
        frigateConfig.mqtt.user = "{FRIGATE_MQTT_USER}";
        frigateConfig.mqtt.password = "{FRIGATE_MQTT_PASSWORD}";
    }
    if (mqtt.secure) {
        frigateConfig.mqtt.tls_ca_certs = "{FRIGATE_MQTT_CA_CERTS}";
    }

    const env = {
        FRIGATE_MQTT_HOST: mqtt.host
    };
    if (mqtt.username) {
        env.FRIGATE_MQTT_USER = mqtt.username;
        env.FRIGATE_MQTT_PASSWORD = mqtt.password || "";
    }
    if (mqtt.secure) {
        env.FRIGATE_MQTT_CA_CERTS = mqtt.caCerts;
    }

    const bridgeCameraMap = {};
    const usedNames = new Map();

    for (const camera of cameras) {
        const originalName = requireString(camera.name, "virtual_camera.name");
        const frigateName = toFrigateCameraName(originalName);
        const collision = usedNames.get(frigateName);
        if (collision) {
            throw new Error(
                "Frigate camera name collision: '" + collision +
                "' and '" + originalName + "' both become '" + frigateName + "'"
            );
        }
        usedNames.set(frigateName, originalName);

        const sourceName = requireString(
            camera.host_source,
            "virtual_camera '" + originalName + "'.host_source"
        );
        const source = sources.get(sourceName);
        if (!source) {
            throw new Error(
                "virtual_camera '" + originalName +
                "' references unknown host_source '" + sourceName + "'"
            );
        }

        const detectPath = normalizeRtspPath(
            camera.rtsp_path_lq,
            "virtual_camera '" + originalName + "'.rtsp_path_lq"
        );
        const detectUrl = buildRtspUrl(source, detectPath);
        const envName =
            "FRIGATE_CAMERA_" + frigateName.toUpperCase() + "_DETECT_URL";
        env[envName] = detectUrl;

        frigateConfig.go2rtc.streams[frigateName] = [
            "{" + envName + "}"
        ];

        const detect = {
            enabled: true,
            fps: Math.min(
                Number(camera.stream_lq?.framerate) || detectFps,
                detectFps
            )
        };
        const width = Number(camera.stream_lq?.width);
        const height = Number(camera.stream_lq?.height);
        if (Number.isInteger(width) && width > 0) detect.width = width;
        if (Number.isInteger(height) && height > 0) detect.height = height;

        frigateConfig.cameras[frigateName] = {
            friendly_name: originalName,
            enabled: true,
            ffmpeg: {
                inputs: [{
                    path: "rtsp://127.0.0.1:8554/" + frigateName,
                    input_args: "preset-rtsp-restream",
                    roles: ["detect"]
                }]
            },
            detect,
            live: {
                streams: {
                    "Detect Stream": frigateName
                }
            }
        };

        bridgeCameraMap[frigateName] = originalName;
    }

    const envText = Object.entries(env)
        .map(([key, value]) => key + "=" + dotenvValue(value))
        .join("\n") + "\n";

    const bridgeFragment = {
        analytics: {
            frigate: {
                enabled: true,
                broker:
                    (mqtt.secure ? "mqtts://" : "mqtt://") +
                    formatHost(mqtt.host) + ":" + mqtt.port,
                topic_prefix: mqtt.topicPrefix,
                camera_map: bridgeCameraMap
            }
        }
    };

    return Object.freeze({
        cameraCount: cameras.length,
        frigateConfig,
        frigateYaml: yaml.dump(frigateConfig, {
            noRefs: true,
            lineWidth: 120,
            sortKeys: false
        }),
        env,
        envText,
        bridgeCameraMap: Object.freeze({ ...bridgeCameraMap }),
        bridgeFragment,
        bridgeFragmentYaml: yaml.dump(bridgeFragment, {
            noRefs: true,
            lineWidth: 120,
            sortKeys: false
        })
    });
}

module.exports = {
    DEFAULT_TRACKED_OBJECTS,
    generateFrigateBundle
};
