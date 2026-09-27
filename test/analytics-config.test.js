const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { loadConfig } = require("../src/config-loader");

function yaml(analytics = "") {
    return `
runtime:
  probe_streams: false

host_sources:
  - name: source
    hostname: 192.0.2.10
    rtsp_port: 554
    http_port: 80

virtual_cameras:
  - name: VirtualCam1
    model: Test
    mac: "02:00:00:00:00:71"
    ip: "192.0.2.71/24"
    host_source: source
    rtsp_path_hq: "/main"
    rtsp_path_lq: "/sub"
    snapshot_path: "/snapshot.jpg"
    stream_hq:
      encoding: H264
      width: 1920
      height: 1080
      framerate: 15
      bitrate: 2048
      quality: 5
    stream_lq:
      encoding: H264
      width: 640
      height: 360
      framerate: 10
      bitrate: 512
      quality: 3

${analytics}
`;
}

function load(value) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "onvif-analytics-config-"));
    const file = path.join(dir, "config.yml");
    fs.writeFileSync(file, value);
    try {
        return loadConfig(file);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

test("Frigate analytics is disabled safely by default", () => {
    const config = load(yaml());
    assert.equal(config.analytics.frigate.enabled, false);
    assert.deepEqual(config.analytics.frigate.camera_map, {});
});

test("Frigate analytics config is normalized and validates camera mapping", () => {
    const config = load(yaml(`
analytics:
  frigate:
    enabled: true
    broker: mqtt://192.0.2.20:1883
    topic_prefix: /frigate/
    client_id: bridge-test
    camera_map:
      driveway: VirtualCam1
`));

    assert.equal(config.analytics.frigate.enabled, true);
    assert.equal(config.analytics.frigate.broker, "mqtt://192.0.2.20:1883");
    assert.equal(config.analytics.frigate.topic_prefix, "frigate");
    assert.equal(config.analytics.frigate.camera_map.driveway, "VirtualCam1");
});

test("Frigate mapping to an unknown virtual camera is rejected", () => {
    assert.throws(() => load(yaml(`
analytics:
  frigate:
    enabled: true
    broker: mqtt://192.0.2.20:1883
    camera_map:
      driveway: MissingCam
`)), /unknown virtual camera/);
});
