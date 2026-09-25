const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const soap = require("soap");

function createClient(wsdlPath) {
    return new Promise((resolve, reject) => {
        soap.createClient(wsdlPath, (err, client) => {
            if (err) {
                reject(err);
                return;
            }
            resolve(client);
        });
    });
}

test("Device WSDL loads and exposes the read-only discovery operations", async () => {
    const wsdlPath = path.resolve(__dirname, "../src/wsdl/device_service.wsdl");
    const client = await createClient(wsdlPath);
    const description = client.describe();

    assert.ok(description.DeviceService.DevicePort.GetScopes);
    assert.ok(description.DeviceService.DevicePort.GetDiscoveryMode);
    assert.ok(description.DeviceService.DevicePort.GetServiceCapabilities);
});
