const test = require("node:test");
const assert = require("node:assert/strict");

const DiscoveryManager = require("../src/discovery-manager");

global.runtime = { enable_debug_logs: false };

function cameraFixture() {
    return {
        name: "Camera-Test",
        mac: "02:00:00:00:00:60",
        ip: "192.0.2.60",
        identity: {
            manufacturer: "VirtualCam",
            model: "Test Virtual Camera"
        },
        host: {
            hostname: "192.0.2.57"
        },
        endpoints: {
            deviceServiceUrl: "http://192.0.2.60/onvif/device_service"
        },
        lifecycle: {
            discoveryReady: true
        }
    };
}

test("Hello uses multicast discovery destination and complete camera metadata", async () => {
    const discovery = new DiscoveryManager();
    const entry = discovery.createEntry(cameraFixture());

    const sends = [];
    entry.responseSocket = {
        send(buf, offset, length, port, address, callback) {
            sends.push({
                xml: buf.toString("utf8", offset, offset + length),
                port,
                address
            });
            callback(null);
        }
    };

    const sent = await discovery.sendHello(entry);

    assert.equal(sent, true);
    assert.equal(sends.length, 1);
    assert.equal(sends[0].address, "239.255.255.250");
    assert.equal(sends[0].port, 3702);
    assert.match(sends[0].xml, /http:\/\/schemas\.xmlsoap\.org\/ws\/2005\/04\/discovery\/Hello/);
    assert.match(sends[0].xml, /urn:schemas-xmlsoap-org:ws:2005:04:discovery/);
    assert.match(sends[0].xml, /<wsa:Address>urn:uuid:02000000-0060-0000-0000-000000000000<\/wsa:Address>/);
    assert.match(sends[0].xml, /<wsd:Types>tds:Device dn:NetworkVideoTransmitter<\/wsd:Types>/);
    assert.match(sends[0].xml, /onvif:\/\/www\.onvif\.org\/Profile\/Streaming/);
    assert.match(sends[0].xml, /<wsd:XAddrs>http:\/\/192\.0\.2\.60\/onvif\/device_service<\/wsd:XAddrs>/);
    assert.match(sends[0].xml, /<wsd:MetadataVersion>1<\/wsd:MetadataVersion>/);
});

test("Bye uses multicast discovery destination and the stable EndpointReference", async () => {
    const discovery = new DiscoveryManager();
    const entry = discovery.createEntry(cameraFixture());

    const sends = [];
    entry.responseSocket = {
        send(buf, offset, length, port, address, callback) {
            sends.push({
                xml: buf.toString("utf8", offset, offset + length),
                port,
                address
            });
            callback(null);
        }
    };

    const sent = await discovery.sendBye(entry);

    assert.equal(sent, true);
    assert.equal(sends.length, 1);
    assert.equal(sends[0].address, "239.255.255.250");
    assert.equal(sends[0].port, 3702);
    assert.match(sends[0].xml, /http:\/\/schemas\.xmlsoap\.org\/ws\/2005\/04\/discovery\/Bye/);
    assert.match(sends[0].xml, /urn:schemas-xmlsoap-org:ws:2005:04:discovery/);
    assert.match(sends[0].xml, /<wsa:Address>urn:uuid:02000000-0060-0000-0000-000000000000<\/wsa:Address>/);
});

test("Hello delay stays within the WS-Discovery startup jitter window", () => {
    const discovery = new DiscoveryManager();

    for (let i = 0; i < 500; i += 1) {
        const delay = discovery.getHelloDelayMs();
        assert.ok(delay >= 0);
        assert.ok(delay <= 500);
    }
});

test("Hello and Bye participate in the same monotonic AppSequence", () => {
    const discovery = new DiscoveryManager();
    const entry = discovery.createEntry(cameraFixture());

    const hello = discovery.buildHelloMessage(entry);
    const bye = discovery.buildByeMessage(entry);

    const pattern = /<wsd:AppSequence[^>]*InstanceId="(\d+)"[^>]*MessageNumber="(\d+)"[^>]*\/>/;
    const helloMatch = hello.match(pattern);
    const byeMatch = bye.match(pattern);

    assert.ok(helloMatch);
    assert.ok(byeMatch);
    assert.equal(helloMatch[1], byeMatch[1]);
    assert.equal(Number(byeMatch[2]), Number(helloMatch[2]) + 1);
});

test("controlled close sends Bye before closing the response socket", async () => {
    const discovery = new DiscoveryManager();
    const camera = cameraFixture();
    const entry = discovery.createEntry(camera);
    entry.running = true;

    const order = [];
    discovery.entries.set(camera.mac, entry);
    discovery.listenSocket = {
        dropMembership() {
            order.push("drop-membership");
        },
        close(callback) {
            order.push("close-listener");
            callback();
        }
    };

    entry.responseSocket = {
        close(callback) {
            order.push("close-response");
            callback();
        }
    };

    discovery.sendBye = async () => {
        order.push("bye");
        return true;
    };

    await discovery.closeEntry(entry);

    assert.equal(order[0], "bye");
    assert.ok(order.indexOf("drop-membership") > order.indexOf("bye"));
    assert.ok(order.indexOf("close-response") > order.indexOf("bye"));
    assert.equal(entry.running, false);
    assert.equal(camera.lifecycle.discoveryReady, false);
});
