const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const soap = require("soap");

const DeviceService = require("../src/services/device-service");
const { inlineTypesXsd } = require("../src/wsdl-loader");

global.runtime = { enable_debug_logs: false };

function cameraFixture() {
    return {
        name: "Camera-Test",
        identity: {
            manufacturer: "VirtualCam",
            model: "Test Virtual Camera",
            firmwareVersion: "1.0",
            serialNumber: "020000000100",
            hardwareId: "Test Virtual Camera-020000000100"
        },
        endpoints: {
            deviceServiceUrl: "http://127.0.0.1/onvif/device_service",
            mediaServiceUrl: "http://127.0.0.1/onvif/media_service"
        }
    };
}

function startSoapServer() {
    return new Promise((resolve, reject) => {
        const wsdlDir = path.resolve(__dirname, "../src/wsdl");
        const wsdl = inlineTypesXsd(
            fs.readFileSync(path.join(wsdlDir, "device_service.wsdl"), "utf8"),
            fs.readFileSync(path.join(wsdlDir, "types.xsd"), "utf8")
        );
        const device = new DeviceService(cameraFixture());
        const server = http.createServer();

        soap.listen(server, {
            path: "/onvif/device_service",
            services: {
                DeviceService: {
                    DevicePort: device.GetServiceDefinition()
                }
            },
            xml: wsdl,
            forceSoap12Headers: true,
            attributesKey: "$attributes",
            wsdl_options: {
                attributesKey: "$attributes"
            },
            callback(err) {
                if (err) {
                    reject(err);
                    return;
                }
                resolve(server);
            }
        });

        server.listen(0, "127.0.0.1");
    });
}

test("GetServices wire response carries service-specific Device and Media capabilities", async () => {
    const server = await startSoapServer();

    try {
        const { port } = server.address();
        const response = await fetch(`http://127.0.0.1:${port}/onvif/device_service`, {
            method: "POST",
            headers: {
                "content-type": 'application/soap+xml; charset=utf-8; action="http://www.onvif.org/ver10/device/wsdl/GetServices"'
            },
            body: `<?xml version="1.0" encoding="UTF-8"?>
<env:Envelope
    xmlns:env="http://www.w3.org/2003/05/soap-envelope"
    xmlns:tds="http://www.onvif.org/ver10/device/wsdl">
  <env:Body>
    <tds:GetServices>
      <tds:IncludeCapability>true</tds:IncludeCapability>
    </tds:GetServices>
  </env:Body>
</env:Envelope>`
        });

        const body = await response.text();

        assert.equal(response.status, 200);
        assert.match(body, /GetServicesResponse/);

        assert.match(
            body,
            /<tds:Capabilities[^>]*xmlns:tds="http:\/\/www\.onvif\.org\/ver10\/device\/wsdl"/
        );
        assert.match(body, /DiscoveryResolve="true"/);
        assert.match(body, /DiscoveryBye="true"/);
        assert.match(body, /UsernameToken="true"/);

        assert.match(
            body,
            /<trt:Capabilities[^>]*xmlns:trt="http:\/\/www\.onvif\.org\/ver10\/media\/wsdl"/
        );
        assert.match(body, /SnapshotUri="true"/);
        assert.match(body, /MaximumNumberOfProfiles="2"/);
        assert.match(body, /RTPMulticast="false"/);
        assert.match(body, /RTP_TCP="true"/);
        assert.match(body, /RTP_RTSP_TCP="true"/);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});
