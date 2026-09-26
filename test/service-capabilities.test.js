const test = require("node:test");
const assert = require("node:assert/strict");

const DeviceService = require("../src/services/device-service");
const MediaService = require("../src/services/media-service");
const {
    buildDeviceServiceCapabilities,
    buildMediaServiceCapabilities,
    buildEventServiceCapabilities,
    renderDeviceServiceCapabilitiesXml,
    renderMediaServiceCapabilitiesXml,
    renderEventServiceCapabilitiesXml
} = require("../src/service-capabilities");

global.runtime = { enable_debug_logs: false };

function cameraFixture() {
    return {
        name: "Camera-Test",
        mac: "02:00:00:00:00:80",
        identity: {
            manufacturer: "VirtualCam",
            model: "Test Virtual Camera",
            firmwareVersion: "1.0",
            serialNumber: "020000000080",
            hardwareId: "Test Virtual Camera-020000000080"
        },
        endpoints: {
            deviceServiceUrl: "http://192.0.2.80/onvif/device_service",
            mediaServiceUrl: "http://192.0.2.80/onvif/media_service",
            eventServiceUrl: "http://192.0.2.80/onvif/event_service",
            rtspUriHq: "rtsp://192.0.2.80:8554/main",
            rtspUriLq: "rtsp://192.0.2.80:8554/sub",
            snapshotUri: "http://192.0.2.80/snapshot.jpg"
        },
        streams: {
            hq: {
                encoding: "H265",
                width: 3840,
                height: 2160,
                framerate: 15,
                bitrate: 4096,
                quality: 5
            },
            lq: {
                encoding: "H265",
                width: 960,
                height: 480,
                framerate: 15,
                bitrate: 1024,
                quality: 3
            }
        }
    };
}

test("Media GetServiceCapabilities returns the shared service-specific payload", async () => {
    const media = new MediaService(cameraFixture());
    const response = await media.GetServiceCapabilities();

    assert.deepEqual(response.Capabilities, buildMediaServiceCapabilities());
    assert.equal(response.Capabilities.$attributes.SnapshotUri, true);
    assert.equal(
        response.Capabilities.ProfileCapabilities.$attributes.MaximumNumberOfProfiles,
        2
    );
    assert.equal(
        response.Capabilities.StreamingCapabilities.$attributes.RTPMulticast,
        false
    );
    assert.equal(
        response.Capabilities.StreamingCapabilities.$attributes.RTP_RTSP_TCP,
        true
    );
});

test("GetServices omits service capabilities unless requested", async () => {
    const device = new DeviceService(cameraFixture());
    const response = await device.GetServices({ IncludeCapability: false });

    assert.equal(response.Service.length, 3);
    assert.equal(Object.hasOwn(response.Service[0], "Capabilities"), false);
    assert.equal(Object.hasOwn(response.Service[1], "Capabilities"), false);
    assert.equal(Object.hasOwn(response.Service[2], "Capabilities"), false);
});

test("GetServices includes namespaced Device, Media and Event service capabilities", async () => {
    const device = new DeviceService(cameraFixture());
    const response = await device.GetServices({ IncludeCapability: true });

    const deviceXml = response.Service[0].Capabilities.$xml;
    const mediaXml = response.Service[1].Capabilities.$xml;
    const eventXml = response.Service[2].Capabilities.$xml;

    assert.equal(deviceXml, renderDeviceServiceCapabilitiesXml(buildDeviceServiceCapabilities()));
    assert.equal(mediaXml, renderMediaServiceCapabilitiesXml(buildMediaServiceCapabilities()));
    assert.equal(eventXml, renderEventServiceCapabilitiesXml(buildEventServiceCapabilities()));

    assert.match(deviceXml, /<tds:Capabilities[^>]*xmlns:tds="http:\/\/www\.onvif\.org\/ver10\/device\/wsdl"/);
    assert.match(deviceXml, /DiscoveryResolve="true"/);
    assert.match(deviceXml, /DiscoveryBye="true"/);

    assert.match(mediaXml, /<trt:Capabilities[^>]*xmlns:trt="http:\/\/www\.onvif\.org\/ver10\/media\/wsdl"/);
    assert.match(mediaXml, /SnapshotUri="true"/);
    assert.match(mediaXml, /MaximumNumberOfProfiles="2"/);
    assert.match(mediaXml, /RTPMulticast="false"/);
    assert.match(mediaXml, /RTP_RTSP_TCP="true"/);

    assert.match(eventXml, /<tev:Capabilities[^>]*xmlns:tev="http:\/\/www\.onvif\.org\/ver10\/events\/wsdl"/);
    assert.match(eventXml, /MaxPullPoints="32"/);
    assert.match(eventXml, /PersistentNotificationStorage="false"/);
});

test("legacy GetCapabilities advertises PullPoint Events support", async () => {
    const device = new DeviceService(cameraFixture());
    const response = await device.GetCapabilities({ Category: "Events" });

    assert.deepEqual(response.Capabilities.Events, {
        XAddr: "http://192.0.2.80/onvif/event_service",
        WSSubscriptionPolicySupport: false,
        WSPullPointSupport: true,
        WSPausableSubscriptionManagerInterfaceSupport: false
    });
});
