const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const configLoader = require("../src/config-loader");
const DeviceService = require("../src/services/device-service");
const MediaService = require("../src/services/media-service");
const DiscoveryManager = require("../src/discovery-manager");

function buildCameraFixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "onvif-vcam-test-"));
    const configPath = path.join(dir, "config.yml");

    fs.writeFileSync(configPath, `
runtime:
  enable_debug_logs: false
  probe_streams: false

host_sources:
  - name: source1
    hostname: 192.0.2.57
    rtsp_port: 554
    http_port: 80
    auth:
      username: viewer
      password: secret

virtual_cameras:
  - name: Camera-05
    model: Test Virtual Camera
    mac: "02:00:00:00:00:05"
    ip: "192.0.2.204/24"
    host_source: source1
    rtsp_path_hq: "/cam/realmonitor?channel=5&subtype=0"
    rtsp_path_lq: "/cam/realmonitor?channel=5&subtype=1"
    snapshot_path: "/cgi-bin/snapshot.cgi?channel=5"
    stream_hq:
      encoding: H265
      width: 3840
      height: 2160
      framerate: 7
      bitrate: 2048
      quality: 5
    stream_lq:
      encoding: H265
      width: 960
      height: 480
      framerate: 7
      bitrate: 2048
      quality: 5
`);

    const loaded = configLoader.loadConfig(configPath);
    fs.rmSync(dir, { recursive: true, force: true });

    const camera = loaded.cameras[0];
    camera.interface = "vcam-5";
    camera.ip = "192.0.2.204";
    camera.endpoints = {
        deviceServiceUrl: "http://192.0.2.204:80/onvif/device_service",
        mediaServiceUrl: "http://192.0.2.204:80/onvif/media_service",
        rtspUriHq: "rtsp://192.0.2.204:8554/cam/realmonitor?channel=5&subtype=0",
        rtspUriLq: "rtsp://192.0.2.204:8554/cam/realmonitor?channel=5&subtype=1",
        snapshotUri: "http://192.0.2.204:80/cgi-bin/snapshot.cgi?channel=5"
    };

    return camera;
}

test("config parsing preserves the current virtual-camera identity and stream metadata", () => {
    const camera = buildCameraFixture();

    assert.equal(camera.name, "Camera-05");
    assert.equal(camera.mac, "02:00:00:00:00:05");
    assert.deepEqual(camera.ipAssignment, {
        mode: "static",
        value: "192.0.2.204/24",
        address: "192.0.2.204",
        prefix: 24
    });

    assert.equal(camera.identity.serialNumber, "020000000005");
    assert.equal(camera.identity.manufacturer, "VirtualCam");

    assert.deepEqual(camera.streams.hq, {
        encoding: "H265",
        width: 3840,
        height: 2160,
        framerate: 7,
        bitrate: 2048,
        quality: 5
    });

    assert.deepEqual(camera.streams.lq, {
        encoding: "H265",
        width: 960,
        height: 480,
        framerate: 7,
        bitrate: 2048,
        quality: 5
    });
});

test("DeviceService returns the stable virtual-device identity", async () => {
    const camera = buildCameraFixture();
    const device = new DeviceService(camera);

    assert.deepEqual(await device.GetDeviceInformation(), {
        Manufacturer: "VirtualCam",
        Model: "Test Virtual Camera",
        FirmwareVersion: "1.0",
        SerialNumber: "020000000005",
        HardwareId: "Test Virtual Camera-020000000005"
    });
});

test("MediaService preserves stable HQ/LQ profile tokens and stream URIs", async () => {
    const camera = buildCameraFixture();
    const media = new MediaService(camera);

    assert.equal(media.profileTokenHq, "profile_hq_020000000005");
    assert.equal(media.profileTokenLq, "profile_lq_020000000005");

    const hq = await media.GetStreamUri({ ProfileToken: media.profileTokenHq });
    const lq = await media.GetStreamUri({ ProfileToken: media.profileTokenLq });

    assert.equal(
        hq.MediaUri.Uri,
        "rtsp://192.0.2.204:8554/cam/realmonitor?channel=5&subtype=0"
    );
    assert.equal(
        lq.MediaUri.Uri,
        "rtsp://192.0.2.204:8554/cam/realmonitor?channel=5&subtype=1"
    );
});

test("MediaService keeps the same snapshot URI for both current profiles", async () => {
    const camera = buildCameraFixture();
    const media = new MediaService(camera);

    const hq = await media.GetSnapshotUri({ ProfileToken: media.profileTokenHq });
    const lq = await media.GetSnapshotUri({ ProfileToken: media.profileTokenLq });

    assert.equal(
        hq.MediaUri.Uri,
        "http://192.0.2.204:80/cgi-bin/snapshot.cgi?channel=5"
    );
    assert.equal(lq.MediaUri.Uri, hq.MediaUri.Uri);
});

test("WS-Discovery EndpointReference stays deterministic for the current MAC", () => {
    const camera = buildCameraFixture();
    const discovery = new DiscoveryManager();

    assert.equal(
        discovery.buildEndpointAddress(camera),
        "urn:uuid:02000000-0005-0000-0000-000000000000"
    );
});

test("WS-Discovery scopes preserve the current identity/location inputs", () => {
    const camera = buildCameraFixture();
    const discovery = new DiscoveryManager();
    const scopes = discovery.getDiscoveryScopes(camera);

    assert.match(scopes, /onvif:\/\/www\.onvif\.org\/type\/video_encoder/);
    assert.match(scopes, /onvif:\/\/www\.onvif\.org\/Profile\/Streaming/);
    assert.match(scopes, /onvif:\/\/www\.onvif\.org\/name\/VirtualCam%20Test%20Virtual%20Camera/);
    assert.match(scopes, /onvif:\/\/www\.onvif\.org\/hardware\/Test%20Virtual%20Camera/);
    assert.match(scopes, /onvif:\/\/www\.onvif\.org\/location\/192\.0\.2\.57/);
});
