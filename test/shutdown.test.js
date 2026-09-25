const test = require("node:test");
const assert = require("node:assert/strict");

const CameraManager = require("../src/camera-manager");
const { stopCameraManagers } = require("../src/shutdown-manager");

global.runtime = {
    enable_debug_logs: false,
    ip_monitor_interval_ms: 5000
};

test("CameraManager.stop clears monitoring and stops its ONVIF server once", async () => {
    const manager = new CameraManager(
        { name: "Camera-Test", ipAssignment: { mode: "static", value: "192.0.2.90/24" } },
        {}
    );

    let stops = 0;
    manager.monitorTimer = setInterval(() => {}, 100000);
    manager.server = {
        async stop() {
            stops += 1;
        }
    };

    await manager.stop();

    assert.equal(stops, 1);
    assert.equal(manager.monitorTimer, null);
    assert.equal(manager.server, null);
    assert.equal(manager.stopping, true);

    await manager.stop();
    assert.equal(stops, 1);
});

test("multi-camera shutdown stops managers in reverse startup order", async () => {
    const order = [];
    const managers = ["one", "two", "three"].map((name) => ({
        cameraConfig: { name },
        async stop() {
            order.push(name);
        }
    }));

    const errors = await stopCameraManagers(managers, "test");

    assert.deepEqual(order, ["three", "two", "one"]);
    assert.deepEqual(errors, []);
});

test("multi-camera shutdown continues after an individual stop failure", async () => {
    const order = [];
    const managers = [
        {
            cameraConfig: { name: "one" },
            async stop() {
                order.push("one");
            }
        },
        {
            cameraConfig: { name: "two" },
            async stop() {
                order.push("two");
                throw new Error("expected test failure");
            }
        },
        {
            cameraConfig: { name: "three" },
            async stop() {
                order.push("three");
            }
        }
    ];

    const errors = await stopCameraManagers(managers, "test");

    assert.deepEqual(order, ["three", "two", "one"]);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].name, "two");
    assert.match(errors[0].error.message, /expected test failure/);
});
