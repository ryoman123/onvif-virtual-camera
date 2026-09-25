const test = require("node:test");
const assert = require("node:assert/strict");

const DeviceService = require("../src/services/device-service");
const { getDiscoveryScopeUris } = require("../src/onvif-scopes");

global.runtime = { enable_debug_logs: false };

function cameraFixture() {
    return {
        name: "Camera-Test",
        identity: {
            manufacturer: "VirtualCam",
            model: "Test Virtual Camera",
            firmwareVersion: "1.0",
            serialNumber: "020000000010",
            hardwareId: "Test Virtual Camera-020000000010"
        },
        host: {
            hostname: "192.0.2.57"
        },
        endpoints: {
            deviceServiceUrl: "http://192.0.2.10/onvif/device_service",
            mediaServiceUrl: "http://192.0.2.10/onvif/media_service"
        }
    };
}

test("GetScopes returns the exact fixed scopes advertised by discovery", async () => {
    const camera = cameraFixture();
    const device = new DeviceService(camera);
    const response = await device.GetScopes();
    const expected = getDiscoveryScopeUris(camera);

    assert.equal(response.Scopes.length, expected.length);
    assert.deepEqual(
        response.Scopes.map((scope) => scope.ScopeItem),
        expected
    );
    assert.ok(response.Scopes.every((scope) => scope.ScopeDef === "Fixed"));
    assert.ok(expected.includes("onvif://www.onvif.org/Profile/Streaming"));
});

test("GetDiscoveryMode reports Discoverable", async () => {
    const device = new DeviceService(cameraFixture());

    assert.deepEqual(await device.GetDiscoveryMode(), {
        DiscoveryMode: "Discoverable"
    });
});

test("GetServiceCapabilities conservatively reports implemented Device features", async () => {
    const device = new DeviceService(cameraFixture());
    const response = await device.GetServiceCapabilities();

    assert.equal(response.Capabilities.Security.$attributes.UsernameToken, true);
    assert.equal(response.Capabilities.Security.$attributes["TLS1.2"], false);
    assert.equal(response.Capabilities.System.$attributes.DiscoveryResolve, true);
    assert.equal(response.Capabilities.System.$attributes.DiscoveryBye, false);
    assert.equal(response.Capabilities.Network.$attributes.IPVersion6, false);
});


test("legacy GetCapabilities also advertises DiscoveryResolve", async () => {
    const device = new DeviceService(cameraFixture());
    const response = await device.GetCapabilities({ Category: "Device" });

    assert.equal(response.Capabilities.Device.System.DiscoveryResolve, true);
});
