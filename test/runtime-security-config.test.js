const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { loadConfig } = require("../src/config-loader");

function baseConfig(runtimeBlock = "") {
    return `
runtime:
  probe_streams: false
  ${runtimeBlock}

host_sources:
  - name: source
    hostname: 192.0.2.10
    rtsp_port: 554
    http_port: 80
    auth:
      username: viewer
      password: secret

virtual_cameras:
  - name: Camera-Test
    model: Test
    mac: "02:00:00:00:00:70"
    ip: "192.0.2.70/24"
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
`;
}

function loadYaml(yaml) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "onvif-runtime-test-"));
    const file = path.join(dir, "config.yml");
    fs.writeFileSync(file, yaml);

    try {
        return loadConfig(file);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

test("Frigate mapping validates configured virtual camera names", () => {
    const valid = loadYaml(baseConfig() + `\nanalytics:\n  frigate:\n    url: mqtt://192.0.2.20:1883\n    camera_map:\n      front: Camera-Test\n    username_env: MQTT_USER\n    password_env: MQTT_PASS\n`);
    assert.deepEqual(valid.analytics.frigate.cameraMap, { front: "Camera-Test" });
    assert.throws(() => loadYaml(baseConfig() + `\nanalytics:\n  frigate:\n    url: mqtt://192.0.2.20:1883\n    camera_map:\n      front: Wrong-Camera\n`), /invalid mapping/);
    assert.throws(() => loadYaml(baseConfig() + `\nanalytics:\n  frigate:\n    url: mqtt://user:password@broker\n    camera_map:\n      front: Camera-Test\n`), /without credentials/);
});

test("recorder analytics validates secret references and explicit channel mapping", () => {
    const valid = loadYaml(baseConfig() + `
analytics:
  recorders:
    - name: lorex-primary
      url: http://192.0.2.21/cgi-bin/eventManager.cgi?action=attach&codes=[All]
      username_env: LOREX_USER
      password_env: LOREX_PASS
      channel_map:
        0: Camera-Test
`);
    assert.deepEqual(valid.analytics.recorders[0].channelMap, { 0: "Camera-Test" });
    assert.equal(valid.analytics.recorders[0].usernameEnv, "LOREX_USER");
    assert.equal(valid.analytics.recorders[0].url.includes("@"), false);
    assert.throws(() => loadYaml(baseConfig() + `
analytics:
  recorders:
    - name: unsafe
      url: http://admin:password@192.0.2.21/events
      username_env: USER
      password_env: PASS
      channel_map: { 0: Camera-Test }
`), /without credentials/);
    assert.throws(() => loadYaml(baseConfig() + `
analytics:
  recorders:
    - name: wrong-map
      url: http://192.0.2.21/events
      username_env: USER
      password_env: PASS
      channel_map: { 0: Missing-Camera }
`), /invalid mapping/);
});

test("WS-Security defaults are audit-first and frozen", () => {
    const { runtime } = loadYaml(baseConfig());

    assert.deepEqual(runtime.ws_security, {
        mode: "audit",
        max_age_seconds: 300,
        future_skew_seconds: 300,
        nonce_cache_size: 2048,
        allow_password_text: true
    });
    assert.equal(Object.isFrozen(runtime.ws_security), true);
    assert.equal(Object.isFrozen(runtime), true);
});

test("partial WS-Security config preserves unspecified safe defaults", () => {
    const { runtime } = loadYaml(baseConfig(`
  ws_security:
    mode: enforce
    allow_password_text: false`));

    assert.equal(runtime.ws_security.mode, "enforce");
    assert.equal(runtime.ws_security.allow_password_text, false);
    assert.equal(runtime.ws_security.max_age_seconds, 300);
    assert.equal(runtime.ws_security.future_skew_seconds, 300);
    assert.equal(runtime.ws_security.nonce_cache_size, 2048);
});

test("invalid WS-Security mode is rejected", () => {
    assert.throws(
        () => loadYaml(baseConfig(`
  ws_security:
    mode: broken`)),
        /runtime\.ws_security\.mode/
    );
});

test("negative future clock skew is rejected", () => {
    assert.throws(
        () => loadYaml(baseConfig(`
  ws_security:
    future_skew_seconds: -1`)),
        /runtime\.ws_security\.future_skew_seconds/
    );
});
