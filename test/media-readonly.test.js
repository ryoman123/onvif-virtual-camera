const test = require("node:test");
const assert = require("node:assert/strict");

const MediaService = require("../src/services/media-service");

global.runtime = { enable_debug_logs: false };

function cameraFixture() {
    return {
        name: "Camera-Test",
        mac: "02:00:00:00:00:20",
        identity: {
            serialNumber: "020000000020"
        },
        endpoints: {
            rtspUriHq: "rtsp://192.0.2.20:8554/main",
            rtspUriLq: "rtsp://192.0.2.20:8554/sub",
            snapshotUri: "http://192.0.2.20/snapshot.jpg"
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
                quality: 3
            }
        }
    };
}

function faultSubcodes(error) {
    const values = [];
    let subcode = error && error.Fault && error.Fault.Code && error.Fault.Code.Subcode;

    while (subcode) {
        values.push(subcode.Value);
        subcode = subcode.Subcode;
    }

    return values;
}

test("GetProfile returns the exact requested fixed profile", async () => {
    const media = new MediaService(cameraFixture());
    const response = await media.GetProfile({
        ProfileToken: media.profileTokenLq
    });

    assert.equal(response.Profile.$attributes.token, media.profileTokenLq);
    assert.equal(response.Profile.$attributes.fixed, true);
    assert.equal(response.Profile.VideoSourceConfiguration.$attributes.token, media.videoSourceConfigTokenLq);
    assert.equal(response.Profile.VideoEncoderConfiguration.$attributes.token, media.videoEncoderTokenLq);
    assert.equal(response.Profile.VideoEncoderConfiguration.Resolution.Width, 960);
});

test("configuration list operations return both stable HQ and LQ configurations", async () => {
    const media = new MediaService(cameraFixture());

    const sources = await media.GetVideoSourceConfigurations();
    const encoders = await media.GetVideoEncoderConfigurations();

    assert.deepEqual(
        sources.Configurations.map((config) => config.$attributes.token),
        [media.videoSourceConfigTokenHq, media.videoSourceConfigTokenLq]
    );
    assert.deepEqual(
        encoders.Configurations.map((config) => config.$attributes.token),
        [media.videoEncoderTokenHq, media.videoEncoderTokenLq]
    );
});

test("compatible configuration queries return the configuration already bound to the profile", async () => {
    const media = new MediaService(cameraFixture());

    const sources = await media.GetCompatibleVideoSourceConfigurations({
        ProfileToken: media.profileTokenLq
    });
    const encoders = await media.GetCompatibleVideoEncoderConfigurations({
        ProfileToken: media.profileTokenHq
    });

    assert.equal(sources.Configurations.length, 1);
    assert.equal(sources.Configurations[0].$attributes.token, media.videoSourceConfigTokenLq);
    assert.equal(encoders.Configurations.length, 1);
    assert.equal(encoders.Configurations[0].$attributes.token, media.videoEncoderTokenHq);
});

test("compatible configuration queries preserve strict NoProfile handling", async () => {
    const media = new MediaService(cameraFixture());

    await assert.rejects(
        () => media.GetCompatibleVideoEncoderConfigurations({
            ProfileToken: "missing-profile"
        }),
        (error) => {
            assert.deepEqual(faultSubcodes(error), ["ter:InvalidArgVal", "ter:NoProfile"]);
            return true;
        }
    );
});

test("encoder options expose only the fixed quality range for H265 streams", async () => {
    const media = new MediaService(cameraFixture());

    const generic = await media.GetVideoEncoderConfigurationOptions({});
    const lq = await media.GetVideoEncoderConfigurationOptions({
        ProfileToken: media.profileTokenLq
    });

    assert.deepEqual(generic.Options, {
        QualityRange: {
            Min: 3,
            Max: 5
        }
    });
    assert.deepEqual(lq.Options, {
        QualityRange: {
            Min: 3,
            Max: 3
        }
    });
    assert.equal(Object.hasOwn(generic.Options, "H264"), false);
});

test("encoder options validate optional configuration and profile tokens", async () => {
    const media = new MediaService(cameraFixture());

    await assert.rejects(
        () => media.GetVideoEncoderConfigurationOptions({
            ConfigurationToken: "missing-config"
        }),
        (error) => {
            assert.deepEqual(faultSubcodes(error), ["ter:InvalidArgVal", "ter:NoConfig"]);
            return true;
        }
    );

    await assert.rejects(
        () => media.GetVideoEncoderConfigurationOptions({
            ConfigurationToken: media.videoEncoderTokenHq,
            ProfileToken: media.profileTokenLq
        }),
        (error) => {
            assert.deepEqual(faultSubcodes(error), ["ter:InvalidArgs"]);
            return true;
        }
    );
});
