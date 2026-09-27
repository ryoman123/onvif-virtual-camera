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
