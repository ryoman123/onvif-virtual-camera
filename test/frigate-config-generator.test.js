const test = require("node:test");
const assert = require("node:assert/strict");

const {
    DEFAULT_TRACKED_OBJECTS,
    generateFrigateBundle
} = require("../src/frigate-config-generator");
const { toFrigateCameraName } = require("../src/frigate-naming");

function bridgeConfig() {
    return {
        analytics: {
            frigate: {
                enabled: true,
                broker: "mqtt://192.0.2.20:1883",
                username: "mqtt-user",
                password: "mqtt-$secret",
                topic_prefix: "frigate"
            }
        },
        host_sources: [{
            name: "lorex",
            hostname: "192.0.2.10",
            rtsp_port: 554,
            http_port: 80,
            auth: {
                username: "viewer",
                password: "camera-secret"
            }
        }],
        virtual_cameras: [{
            name: "Front Door",
            host_source: "lorex",
            rtsp_path_hq: "/cam/realmonitor?channel=1&subtype=0",
            rtsp_path_lq: "/cam/realmonitor?channel=1&subtype=1",
            stream_lq: {
                width: 960,
                height: 480,
                framerate: 7
            }
        }, {
            name: "Driveway 2",
            host_source: "lorex",
            rtsp_path_hq: "/cam/realmonitor?channel=2&subtype=0",
            rtsp_path_lq: "/cam/realmonitor?channel=2&subtype=1",
            stream_lq: {
                width: 640,
                height: 360,
                framerate: 4
            }
        }]
    };
}

test("Frigate sidecar generator produces AI-only LQ camera inventory without YAML secrets", () => {
    const bundle = generateFrigateBundle(bridgeConfig());

    assert.equal(bundle.cameraCount, 2);
    assert.equal(bundle.frigateConfig.record.enabled, false);
    assert.equal(bundle.frigateConfig.snapshots.enabled, false);
    assert.deepEqual(bundle.frigateConfig.objects.track, [...DEFAULT_TRACKED_OBJECTS]);

    const front = bundle.frigateConfig.cameras.front_door;
    assert.equal(front.friendly_name, "Front Door");
    assert.equal(front.detect.width, 960);
    assert.equal(front.detect.height, 480);
    assert.equal(front.detect.fps, 3);
    assert.equal(front.ffmpeg.inputs[0].roles[0], "detect");
    assert.equal(
        front.ffmpeg.inputs[0].path,
        "rtsp://127.0.0.1:8554/front_door"
    );

    assert.equal(bundle.frigateConfig.cameras.driveway_2.detect.fps, 3);
    assert.deepEqual(bundle.frigateConfig.detectors.ov, {
        type: "openvino",
        device: "CPU",
        num_threads: 3
    });
    assert.equal(
        bundle.frigateConfig.model.path,
        "/openvino-model/ssdlite_mobilenet_v2.xml"
    );
    assert.equal(bundle.bridgeCameraMap.front_door, "Front Door");
    assert.equal(bundle.bridgeCameraMap.driveway_2, "Driveway 2");

    assert.equal(bundle.frigateYaml.includes("camera-secret"), false);
    assert.equal(bundle.frigateYaml.includes("mqtt-$secret"), false);
    assert.equal(bundle.envText.includes("camera-secret"), true);
    assert.equal(bundle.envText.includes("mqtt-$secret"), true);
    assert.equal(
        bundle.envText.includes("FRIGATE_MQTT_PASSWORD='mqtt-$secret'"),
        true
    );
    assert.equal(
        bundle.env.FRIGATE_CAMERA_FRONT_DOOR_DETECT_URL.includes("subtype=1"),
        true
    );
    assert.equal(
        bundle.env.FRIGATE_CAMERA_FRONT_DOOR_DETECT_URL.includes("subtype=0"),
        false
    );
});

test("Frigate OpenVINO CPU tuning is validated and configurable", () => {
    const bundle = generateFrigateBundle(bridgeConfig(), {
        detectFps: 2,
        openvinoThreads: 4
    });

    assert.equal(bundle.frigateConfig.detectors.ov.num_threads, 4);
    assert.equal(bundle.frigateConfig.cameras.front_door.detect.fps, 2);
    assert.throws(
        () => generateFrigateBundle(bridgeConfig(), { openvinoThreads: 0 }),
        /openvinoThreads must be a positive integer/
    );
});

test("Frigate naming is deterministic and rejects collisions", () => {
    assert.equal(toFrigateCameraName(" Bedroom #1 "), "bedroom_1");
    assert.equal(toFrigateCameraName("Entrée"), "entree");

    const config = bridgeConfig();
    config.virtual_cameras[1].name = "Front-Door";

    assert.throws(
        () => generateFrigateBundle(config),
        /name collision/
    );
});

test("mqtts sidecars emit a CA bundle environment reference", () => {
    const config = bridgeConfig();
    config.analytics.frigate.broker = "mqtts://mqtt.example.test:8883";

    const bundle = generateFrigateBundle(config, {
        mqttCaCerts: "/config/step-ca-root.pem"
    });

    assert.equal(
        bundle.frigateConfig.mqtt.tls_ca_certs,
        "{FRIGATE_MQTT_CA_CERTS}"
    );
    assert.equal(
        bundle.env.FRIGATE_MQTT_CA_CERTS,
        "/config/step-ca-root.pem"
    );
});
