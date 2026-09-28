const test = require("node:test");
const assert = require("node:assert/strict");

const SnapshotService = require("../src/services/snapshot-service");

global.runtime = { enable_debug_logs: false };

function cameraFixture(snapshotSource = "native") {
    return {
        name: "Camera-Test",
        source: {
            snapshotUrl: "http://user:pass@192.0.2.40/snapshot.jpg",
            snapshotPath: "/snapshot.jpg",
            snapshotSource,
            rtspUrlHq: "rtsp://user:pass@192.0.2.40/main"
        }
    };
}

function responseFixture() {
    const headers = {};
    return {
        headers,
        statusCode: null,
        setHeader(name, value) { headers[name] = value; },
        end(value) { this.body = value; }
    };
}

test("HQ snapshot mode captures one JPEG frame from the configured main stream", async () => {
    const image = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    let invocation;
    const service = new SnapshotService(cameraFixture("hq"), {
        execFile(command, args, options, callback) {
            invocation = { command, args, options };
            process.nextTick(() => callback(null, image, Buffer.alloc(0)));
        }
    });
    const response = responseFixture();

    await service.forwardSnapshot(response);

    assert.equal(invocation.command, "/usr/bin/ffmpeg");
    assert.deepEqual(invocation.args.slice(0, 6), [
        "-hide_banner", "-loglevel", "error", "-rtsp_transport", "tcp", "-i"
    ]);
    assert.equal(invocation.args[6], "rtsp://user:pass@192.0.2.40/main");
    assert.equal(invocation.options.timeout, 15000);
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["Content-Type"], "image/jpeg");
    assert.equal(response.headers["Content-Length"], image.length);
    assert.equal(response.headers["Cache-Control"], "no-cache, no-store, must-revalidate");
    assert.deepEqual(response.body, image);
});

test("HQ snapshot errors do not expose credential-bearing FFmpeg output", async () => {
    const service = new SnapshotService(cameraFixture("hq"), {
        execFile(command, args, options, callback) {
            const error = new Error("rtsp://user:pass@192.0.2.40/main failed");
            error.code = 1;
            process.nextTick(() => callback(error, Buffer.alloc(0), Buffer.from(error.message)));
        }
    });

    await assert.rejects(
        () => service.forwardSnapshot(responseFixture()),
        (error) => {
            assert.match(error.message, /HQ snapshot capture failed \(exit 1\)/);
            assert.doesNotMatch(error.message, /user|pass|192\.0\.2\.40/);
            return true;
        }
    );
});
