const test = require("node:test");
const assert = require("node:assert/strict");

const DiscoveryManager = require("../src/discovery-manager");

global.runtime = { enable_debug_logs: false };

function cameraFixture() {
    return {
        name: "Camera-Test",
        mac: "02:00:00:00:00:40",
        ip: "192.0.2.40",
        identity: {
            manufacturer: "VirtualCam",
            model: "Test Virtual Camera"
        },
        host: {
            hostname: "192.0.2.57"
        },
        endpoints: {
            deviceServiceUrl: "http://192.0.2.40/onvif/device_service"
        },
        lifecycle: {
            discoveryReady: false
        }
    };
}

function extract(xml, pattern) {
    const match = xml.match(pattern);
    assert.ok(match, `expected XML to match ${pattern}`);
    return match[1];
}

test("ProbeMatches uses standards-format UUID MessageIDs and preserves stable identity", () => {
    const discovery = new DiscoveryManager();
    const entry = discovery.createEntry(cameraFixture());

    const response = discovery.buildProbeMatchesResponse(
        entry,
        "urn:uuid:11111111-2222-4333-8444-555555555555"
    );

    const messageId = extract(
        response,
        /<wsa:MessageID>(urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})<\/wsa:MessageID>/i
    );

    assert.match(
        messageId,
        /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    assert.match(response, /xmlns:tds="http:\/\/www\.onvif\.org\/ver10\/device\/wsdl"/);
    assert.match(response, /<wsd:Types>tds:Device dn:NetworkVideoTransmitter<\/wsd:Types>/);
    assert.match(response, /<wsa:Address>urn:uuid:02000000-0040-0000-0000-000000000000<\/wsa:Address>/);
    assert.match(response, /<wsd:XAddrs>http:\/\/192\.0\.2\.40\/onvif\/device_service<\/wsd:XAddrs>/);
    assert.match(response, /<wsa:RelatesTo>urn:uuid:11111111-2222-4333-8444-555555555555<\/wsa:RelatesTo>/);
});

test("each ProbeMatches response gets a unique MessageID", () => {
    const discovery = new DiscoveryManager();
    const entry = discovery.createEntry(cameraFixture());

    const first = discovery.buildProbeMatchesResponse(entry, null);
    const second = discovery.buildProbeMatchesResponse(entry, null);

    const firstId = extract(first, /<wsa:MessageID>([^<]+)<\/wsa:MessageID>/);
    const secondId = extract(second, /<wsa:MessageID>([^<]+)<\/wsa:MessageID>/);

    assert.notEqual(firstId, secondId);
    assert.match(firstId, /^urn:uuid:/);
    assert.match(secondId, /^urn:uuid:/);
});

test("AppSequence keeps a stable InstanceId and increments MessageNumber", () => {
    const discovery = new DiscoveryManager();
    const entry = discovery.createEntry(cameraFixture());

    const first = discovery.buildProbeMatchesResponse(entry, null);
    const second = discovery.buildProbeMatchesResponse(entry, null);

    const appSequencePattern = /<wsd:AppSequence[^>]*InstanceId="(\d+)"[^>]*MessageNumber="(\d+)"[^>]*\/>/;
    const firstMatch = first.match(appSequencePattern);
    const secondMatch = second.match(appSequencePattern);

    assert.ok(firstMatch);
    assert.ok(secondMatch);

    assert.equal(firstMatch[1], secondMatch[1]);
    assert.equal(Number(secondMatch[2]), Number(firstMatch[2]) + 1);
    assert.equal(Number(firstMatch[1]), discovery.instanceId);
});

test("new DiscoveryManager process identity starts its own AppSequence", () => {
    const first = new DiscoveryManager();
    const second = new DiscoveryManager();

    assert.ok(Number.isInteger(first.instanceId));
    assert.ok(first.instanceId > 0);
    assert.equal(first.messageNumber, 0);
    assert.equal(second.messageNumber, 0);
});
