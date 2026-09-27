const test = require("node:test");
const assert = require("node:assert/strict");

const MediaService = require("../src/services/media-service");

global.runtime = { enable_debug_logs: false };

function cameraFixture() {
    return {
        name: "Camera-Test",
        mac: "02:00:00:00:00:30",
        identity: {
            serialNumber: "020000000030"
        },
        endpoints: {
            rtspUriHq: "rtsp://192.0.2.30:8554/main",
            rtspUriLq: "rtsp://192.0.2.30:8554/sub",
            snapshotUri: "http://192.0.2.30/snapshot.jpg"
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
                quality: 5
            }
        }
    };
}

function setup(stream = "RTP-Unicast", protocol = "RTSP") {
    return {
        Stream: stream,
        Transport: {
            Protocol: protocol
        }
    };
}

function assertFault(error, expectedSubcodes) {
    const actual = [];
    let subcode = error && error.Fault && error.Fault.Code && error.Fault.Code.Subcode;

    while (subcode) {
        actual.push(subcode.Value);
        subcode = subcode.Subcode;
    }

    assert.deepEqual(actual, expectedSubcodes);
    return true;
}

test("GetStreamUri accepts RTP-Unicast over RTSP and TCP", async () => {
    const media = new MediaService(cameraFixture());

    const rtsp = await media.GetStreamUri({
        StreamSetup: setup("RTP-Unicast", "RTSP"),
        ProfileToken: media.profileTokenHq
    });
    const tcp = await media.GetStreamUri({
        StreamSetup: setup("RTP-Unicast", "TCP"),
        ProfileToken: media.profileTokenLq
    });

    assert.equal(rtsp.MediaUri.Uri, "rtsp://192.0.2.30:8554/main");
    assert.equal(tcp.MediaUri.Uri, "rtsp://192.0.2.30:8554/sub");
});

test("GetStreamUri requires StreamSetup", async () => {
    const media = new MediaService(cameraFixture());

    await assert.rejects(
        () => media.GetStreamUri({
            ProfileToken: media.profileTokenHq
        }),
        (error) => assertFault(error, ["ter:InvalidArgs"])
    );
});

test("GetStreamUri rejects incomplete StreamSetup", async () => {
    const media = new MediaService(cameraFixture());

    await assert.rejects(
        () => media.GetStreamUri({
            StreamSetup: {
                Stream: "RTP-Unicast",
                Transport: {}
            },
            ProfileToken: media.profileTokenHq
        }),
        (error) => assertFault(error, ["ter:InvalidArgVal", "ter:InvalidStreamSetup"])
    );
});

test("GetStreamUri rejects multicast", async () => {
    const media = new MediaService(cameraFixture());

    await assert.rejects(
        () => media.GetStreamUri({
            StreamSetup: setup("RTP-Multicast", "RTSP"),
            ProfileToken: media.profileTokenHq
        }),
        (error) => assertFault(error, ["ter:InvalidArgVal", "ter:InvalidStreamSetup"])
    );
});

test("GetStreamUri rejects UDP and HTTP transports", async () => {
    const media = new MediaService(cameraFixture());

    for (const protocol of ["UDP", "HTTP"]) {
        await assert.rejects(
            () => media.GetStreamUri({
                StreamSetup: setup("RTP-Unicast", protocol),
                ProfileToken: media.profileTokenHq
            }),
            (error) => assertFault(error, ["ter:InvalidArgVal", "ter:InvalidStreamSetup"])
        );
    }
});
