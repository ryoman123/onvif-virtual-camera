const test = require("node:test");
const assert = require("node:assert/strict");

const DiscoveryManager = require("../src/discovery-manager");

global.runtime = { enable_debug_logs: false };

function cameraFixture() {
    return {
        name: "Camera-Test",
        mac: "02:00:00:00:00:50",
        ip: "192.0.2.50",
        identity: {
            manufacturer: "VirtualCam",
            model: "Test Virtual Camera"
        },
        host: {
            hostname: "192.0.2.57"
        },
        endpoints: {
            deviceServiceUrl: "http://192.0.2.50/onvif/device_service"
        },
        lifecycle: {
            discoveryReady: true
        }
    };
}

function resolveXml(endpointAddress, messageId = "urn:uuid:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee") {
    return `<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope
    xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope"
    xmlns:wsa="http://schemas.xmlsoap.org/ws/2004/08/addressing"
    xmlns:wsd="http://schemas.xmlsoap.org/ws/2005/04/discovery">
  <SOAP-ENV:Header>
    <wsa:MessageID>${messageId}</wsa:MessageID>
  </SOAP-ENV:Header>
  <SOAP-ENV:Body>
    <wsd:Resolve>
      <wsa:EndpointReference>
        <wsa:Address>${endpointAddress}</wsa:Address>
      </wsa:EndpointReference>
    </wsd:Resolve>
  </SOAP-ENV:Body>
</SOAP-ENV:Envelope>`;
}

test("Resolve for a matching EndpointReference sends one immediate ResolveMatch", () => {
    const discovery = new DiscoveryManager();
    const camera = cameraFixture();
    const entry = discovery.createEntry(camera);
    entry.running = true;
    discovery.entries.set(camera.mac, entry);

    const sent = [];
    discovery.sendResolveMatch = (matchedEntry, relatesTo, rinfo) => {
        sent.push({ matchedEntry, relatesTo, rinfo });
    };

    discovery.handleMessage(
        Buffer.from(resolveXml(entry.endpointAddress), "utf8"),
        { address: "192.0.2.100", port: 3702 }
    );

    assert.equal(sent.length, 1);
    assert.equal(sent[0].matchedEntry, entry);
    assert.equal(sent[0].relatesTo, "urn:uuid:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    assert.deepEqual(sent[0].rinfo, { address: "192.0.2.100", port: 3702 });
});

test("Resolve for an unknown EndpointReference does not respond", () => {
    const discovery = new DiscoveryManager();
    const camera = cameraFixture();
    const entry = discovery.createEntry(camera);
    entry.running = true;
    discovery.entries.set(camera.mac, entry);

    let sent = 0;
    discovery.sendResolveMatch = () => {
        sent += 1;
    };

    discovery.handleMessage(
        Buffer.from(resolveXml("urn:uuid:ffffffff-ffff-4fff-8fff-ffffffffffff"), "utf8"),
        { address: "192.0.2.100", port: 3702 }
    );

    assert.equal(sent, 0);
});

test("duplicate Resolve MessageID from the same peer responds only once", () => {
    const discovery = new DiscoveryManager();
    const camera = cameraFixture();
    const entry = discovery.createEntry(camera);
    entry.running = true;
    discovery.entries.set(camera.mac, entry);

    let sent = 0;
    discovery.sendResolveMatch = () => {
        sent += 1;
    };

    const xml = Buffer.from(resolveXml(entry.endpointAddress), "utf8");
    const rinfo = { address: "192.0.2.100", port: 3702 };

    discovery.handleMessage(xml, rinfo);
    discovery.handleMessage(xml, rinfo);

    assert.equal(sent, 1);
});

test("Resolve parsing accepts alternate WS-Discovery prefixes", () => {
    const discovery = new DiscoveryManager();
    const camera = cameraFixture();
    const entry = discovery.createEntry(camera);

    const xml = resolveXml(entry.endpointAddress)
        .replaceAll("wsd:Resolve", "d:Resolve")
        .replace(
            'xmlns:wsd="http://schemas.xmlsoap.org/ws/2005/04/discovery"',
            'xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery"'
        );

    assert.equal(discovery.hasDiscoveryElement(xml, "Resolve"), true);
    assert.equal(discovery.extractResolveAddress(xml), entry.endpointAddress);
});

test("ResolveMatches echoes RelatesTo and preserves the camera metadata", () => {
    const discovery = new DiscoveryManager();
    const entry = discovery.createEntry(cameraFixture());

    const response = discovery.buildResolveMatchesResponse(
        entry,
        "urn:uuid:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
    );

    assert.match(
        response,
        /http:\/\/schemas\.xmlsoap\.org\/ws\/2005\/04\/discovery\/ResolveMatches/
    );
    assert.match(
        response,
        /<wsa:RelatesTo>urn:uuid:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee<\/wsa:RelatesTo>/
    );
    assert.match(
        response,
        /<wsa:Address>urn:uuid:02000000-0050-0000-0000-000000000000<\/wsa:Address>/
    );
    assert.match(
        response,
        /<wsd:Types>tds:Device dn:NetworkVideoTransmitter<\/wsd:Types>/
    );
    assert.match(
        response,
        /<wsd:XAddrs>http:\/\/192\.0\.2\.50\/onvif\/device_service<\/wsd:XAddrs>/
    );
    assert.match(response, /onvif:\/\/www\.onvif\.org\/Profile\/Streaming/);
});
