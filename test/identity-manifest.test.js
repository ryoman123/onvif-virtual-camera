const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { buildIdentityManifest } = require("../src/identity-manifest");
const { parseArgs, run, writeManifest } = require("../tools/capture-identity-manifest");

function status() {
    return {
        status: "healthy",
        cameras: {
            total: 2,
            healthy: 2,
            items: [
                { name: "Cam B", mac: "02:00:00:00:00:02", identity: { serialNumber: "SER2", hardwareId: "HW2" } },
                { name: "Cam A", mac: "02:00:00:00:00:01", identity: { serialNumber: "SER1", hardwareId: "HW1" } }
            ]
        }
    };
}

test("identity manifest captures a deterministic healthy inventory", () => {
    const manifest = buildIdentityManifest(status(), 2);
    assert.deepEqual(manifest.cameras.map((camera) => camera.name), ["Cam A", "Cam B"]);
    assert.deepEqual(manifest.cameras[0], {
        name: "Cam A",
        mac: "02:00:00:00:00:01",
        serialNumber: "SER1",
        hardwareId: "HW1"
    });
});

test("identity capture fails closed on degraded, incomplete or duplicate inventories", () => {
    assert.throws(() => buildIdentityManifest({ ...status(), status: "degraded" }, 2), /must be healthy/);
    assert.throws(() => buildIdentityManifest(status(), 29), /expected 29 cameras, found 2/);

    const incomplete = status();
    incomplete.cameras.healthy = 1;
    assert.throws(() => buildIdentityManifest(incomplete, 2), /not fully healthy/);

    const duplicate = status();
    duplicate.cameras.items[1].identity.serialNumber = "SER2";
    assert.throws(() => buildIdentityManifest(duplicate, 2), /duplicate camera serialNumber/);
});

test("manifest writer is private and refuses accidental replacement", (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "onvif-manifest-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const output = path.join(directory, "identities.json");
    const manifest = buildIdentityManifest(status(), 2);

    writeManifest(output, manifest);
    assert.equal(fs.statSync(output).mode & 0o777, 0o600);
    assert.throws(() => writeManifest(output, manifest), /already exists/);

    writeManifest(output, { cameras: [manifest.cameras[0]] }, true);
    assert.equal(JSON.parse(fs.readFileSync(output, "utf8")).cameras.length, 1);
});

test("capture CLI supports the 29-camera deployment checkpoint", () => {
    assert.deepEqual(parseArgs([
        "--expected-cameras", "29",
        "--output", "/tmp/camera-identities.json",
        "--timeout-ms", "10000",
        "--force"
    ]), {
        url: "http://127.0.0.1:9090/status",
        expectedCameras: 29,
        output: "/tmp/camera-identities.json",
        timeoutMs: 10000,
        force: true
    });
});

test("capture fetches status before creating the manifest", async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "onvif-manifest-run-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const output = path.join(directory, "identities.json");
    let request;

    const result = await run({
        url: "http://bridge/status",
        expectedCameras: 2,
        output,
        timeoutMs: 1234,
        force: false
    }, {
        fetchJson: async (...args) => {
            request = args;
            return status();
        }
    });

    assert.deepEqual(request, ["http://bridge/status", 1234]);
    assert.equal(result.cameras, 2);
    assert.equal(result.output, output);
});
