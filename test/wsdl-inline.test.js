const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const soap = require("soap");

const { inlineTypesXsd } = require("../src/wsdl-loader");

const wsdlDir = path.resolve(__dirname, "../src/wsdl");
const typesXml = fs.readFileSync(path.join(wsdlDir, "types.xsd"), "utf8");

function inline(name) {
    return inlineTypesXsd(
        fs.readFileSync(path.join(wsdlDir, name), "utf8"),
        typesXml
    );
}

function parseWithSoap(xml, serviceName, portName, endpointPath) {
    return new Promise((resolve, reject) => {
        const server = http.createServer();

        const listener = soap.listen(server, {
            path: endpointPath,
            services: {
                [serviceName]: {
                    [portName]: {}
                }
            },
            xml,
            forceSoap12Headers: true,
            callback(err) {
                if (err) {
                    reject(err);
                    return;
                }
                resolve({ server, listener });
            }
        });

        server.listen(0, "127.0.0.1");
    });
}

async function closeServer(server) {
    await new Promise((resolve) => server.close(resolve));
}

test("inlined Device WSDL preserves separate Device and ONVIF schema namespaces", () => {
    const xml = inline("device_service.wsdl");

    assert.match(
        xml,
        /<xs:schema[^>]*targetNamespace="http:\/\/www\.onvif\.org\/ver10\/device\/wsdl"/
    );
    assert.match(
        xml,
        /<xs:schema[\s\S]*targetNamespace="http:\/\/www\.onvif\.org\/ver10\/schema"/
    );
    assert.match(
        xml,
        /<xs:import namespace="http:\/\/www\.onvif\.org\/ver10\/schema"\s*\/>/
    );
    assert.doesNotMatch(xml, /schemaLocation=["']types\.xsd["']/);
});

test("inlined Media WSDL preserves separate Media and ONVIF schema namespaces", () => {
    const xml = inline("media_service.wsdl");

    assert.match(
        xml,
        /<xs:schema[^>]*targetNamespace="http:\/\/www\.onvif\.org\/ver10\/media\/wsdl"/
    );
    assert.match(
        xml,
        /<xs:schema[\s\S]*targetNamespace="http:\/\/www\.onvif\.org\/ver10\/schema"/
    );
    assert.match(
        xml,
        /<xs:import namespace="http:\/\/www\.onvif\.org\/ver10\/schema"\s*\/>/
    );
    assert.doesNotMatch(xml, /schemaLocation=["']types\.xsd["']/);
});

test("node-soap loads the namespace-correct inlined Device WSDL", async () => {
    const { server } = await parseWithSoap(
        inline("device_service.wsdl"),
        "DeviceService",
        "DevicePort",
        "/onvif/device_service"
    );

    try {
        assert.ok(server.listening);
    } finally {
        await closeServer(server);
    }
});

test("node-soap loads the namespace-correct inlined Media WSDL", async () => {
    const { server } = await parseWithSoap(
        inline("media_service.wsdl"),
        "MediaService",
        "MediaPort",
        "/onvif/media_service"
    );

    try {
        assert.ok(server.listening);
    } finally {
        await closeServer(server);
    }
});
