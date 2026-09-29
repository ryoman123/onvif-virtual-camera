const test = require("node:test");
const assert = require("node:assert/strict");

const { pingFromInterface } = require("../src/network-manager");

test("interface keepalive uses execFile with an interface-bound single ping", async () => {
    let invocation = null;

    const result = await pingFromInterface(
        "vcam-7",
        "192.0.2.51",
        4,
        {
            pingPath: "/usr/bin/ping",
            execFile(command, args, options, callback) {
                invocation = { command, args, options };
                callback(null, "", "");
            }
        }
    );

    assert.deepEqual(result, { sent: true, replied: true });
    assert.equal(invocation.command, "/usr/bin/ping");
    assert.deepEqual(invocation.args, [
        "-I", "vcam-7",
        "-c", "1",
        "-W", "4",
        "192.0.2.51"
    ]);
    assert.equal(invocation.options.timeout, 6000);
});

test("a ping timeout still counts as a transmitted keepalive frame", async () => {
    const noReply = new Error("no reply");
    noReply.code = 1;

    const result = await pingFromInterface(
        "vcam-8",
        "192.0.2.52",
        2,
        {
            execFile(command, args, options, callback) {
                callback(noReply, "", "");
            }
        }
    );

    assert.deepEqual(result, { sent: true, replied: false });
});

test("keepalive rejects when ping cannot be executed", async () => {
    const missing = new Error("spawn ping ENOENT");
    missing.code = "ENOENT";

    await assert.rejects(
        pingFromInterface(
            "vcam-9",
            "192.0.2.53",
            3,
            {
                execFile(command, args, options, callback) {
                    callback(missing, "", "");
                }
            }
        ),
        /Interface keepalive failed for vcam-9: ENOENT/
    );
});
