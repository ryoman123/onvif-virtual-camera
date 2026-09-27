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
    assert.deepEqual(config.analytics.recorders, []);
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


test("native recorder analytics config resolves host source and channel map", () => {
    const config = load(yaml(`
analytics:
  recorders:
    - name: lorex
      host_source: source
      channel_map:
        "0": VirtualCam1
`));

    assert.equal(config.analytics.recorders.length, 1);
    const recorder = config.analytics.recorders[0];
    assert.equal(recorder.name, "lorex");
    assert.equal(recorder.enabled, true);
    assert.equal(recorder.source, "lorex");
    assert.equal(recorder.url.startsWith("http://192.0.2.10/cgi-bin/eventManager.cgi"), true);
    assert.equal(recorder.channel_map["0"], "VirtualCam1");
    assert.equal(recorder.inactivity_timeout_ms, 20000);
});

test("native recorder analytics rejects unknown hosts and camera mappings", () => {
    assert.throws(() => load(yaml(`
analytics:
  recorders:
    - name: lorex
      host_source: missing
      channel_map:
        "0": VirtualCam1
`)), /unknown host_source/);

    assert.throws(() => load(yaml(`
analytics:
  recorders:
    - name: lorex
      host_source: source
      channel_map:
        "0": MissingCam
`)), /unknown virtual camera/);
});


test("Frigate camera_map auto derives stable names from virtual cameras", () => {
    const config = load(yaml(`
analytics:
  frigate:
    enabled: true
    broker: mqtt://192.0.2.20:1883
    camera_map: auto
`));

    assert.deepEqual(config.analytics.frigate.camera_map, {
        virtualcam1: "VirtualCam1"
    });
});
