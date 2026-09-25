const test = require("node:test");
const assert = require("node:assert/strict");

const MediaService = require("../src/services/media-service");\n\nglobal.runtime = { enable_debug_logs: false };

function cameraFixture() {
    return {
        name: "Camera-Test",
        mac: "02:00:00:00:00:10",
        identity: {
            serialNumber: "020000000010"
        },
        endpoints: {
            rtspUriHq: "rtsp://192.0.2.10:8554/main",
            rtspUriLq: "rtsp://192.0.2.10:8554/sub",
            snapshotUri: "http://192.0.2.10/snapshot.jpg"
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

function assertFault(error, expectedSubcodes) {
    assert.ok(error && error.Fault, "expected a structured SOAP fault");
    assert.equal(error.Fault.Code.Value, "soap:Sender");

    const actual = [];
    let subcode = error.Fault.Code.Subcode;
    while (subcode) {
        actual.push(subcode.Value);
        subcode = subcode.Subcode;
    }

    assert.deepEqual(actual, expectedSubcodes);
    return true;
}

test("unknown ProfileToken returns NoProfile instead of falling back to HQ", async () => {
    const media = new MediaService(cameraFixture());

    await assert.rejects(
        () => media.GetStreamUri({ ProfileToken: "not-a-real-profile" }),
        (error) => assertFault(error, ["ter:InvalidArgVal", "ter:NoProfile"])
    );
});

test("missing ProfileToken returns InvalidArgs", async () => {
    const media = new MediaService(cameraFixture());

    await assert.rejects(
        () => media.GetStreamUri({}),
        (error) => assertFault(error, ["ter:InvalidArgs"])
    );
});

test("GetSnapshotUri validates ProfileToken", async () => {
    const media = new MediaService(cameraFixture());

    await assert.rejects(
        () => media.GetSnapshotUri({ ProfileToken: "not-a-real-profile" }),
        (error) => assertFault(error, ["ter:InvalidArgVal", "ter:NoProfile"])
    );
});

test("source configuration lookup rejects encoder tokens", async () => {
    const media = new MediaService(cameraFixture());

    await assert.rejects(
        () => media.GetVideoSourceConfiguration({
            ConfigurationToken: media.videoEncoderTokenHq
        }),
        (error) => assertFault(error, ["ter:InvalidArgVal", "ter:NoConfig"])
    );
});

test("encoder configuration lookup rejects source tokens", async () => {
    const media = new MediaService(cameraFixture());

    await assert.rejects(
        () => media.GetVideoEncoderConfiguration({
            ConfigurationToken: media.videoSourceConfigTokenHq
        }),
        (error) => assertFault(error, ["ter:InvalidArgVal", "ter:NoConfig"])
    );
});

test("valid source and encoder configuration tokens still return their exact profiles", async () => {
    const media = new MediaService(cameraFixture());

    const sourceLq = await media.GetVideoSourceConfiguration({
        ConfigurationToken: media.videoSourceConfigTokenLq
    });
    const encoderHq = await media.GetVideoEncoderConfiguration({
        ConfigurationToken: media.videoEncoderTokenHq
    });

    assert.equal(
        sourceLq.VideoSourceConfiguration.$attributes.token,
        media.videoSourceConfigTokenLq
    );
    assert.equal(
        encoderHq.VideoEncoderConfiguration.$attributes.token,
        media.videoEncoderTokenHq
    );
});
