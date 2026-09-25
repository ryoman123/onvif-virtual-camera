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

test("Media WSDL loads and exposes the read-only query operations", async () => {
    const wsdlPath = path.resolve(__dirname, "../src/wsdl/media_service.wsdl");
    const client = await createClient(wsdlPath);
    const port = client.describe().MediaService.MediaPort;

    assert.ok(port.GetServiceCapabilities);
    assert.ok(port.GetProfile);
    assert.ok(port.GetVideoSourceConfigurations);
    assert.ok(port.GetCompatibleVideoSourceConfigurations);
    assert.ok(port.GetVideoEncoderConfigurations);
    assert.ok(port.GetCompatibleVideoEncoderConfigurations);
    assert.ok(port.GetVideoEncoderConfigurationOptions);
});
