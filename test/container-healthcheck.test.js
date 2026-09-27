const test = require("node:test");
const assert = require("node:assert/strict");

const {
    resolveDiagnosticsTarget
} = require("../tools/container-healthcheck");

test("container healthcheck follows diagnostics defaults and custom settings", () => {
    assert.deepEqual(resolveDiagnosticsTarget({}), {
        enabled: true,
        host: "127.0.0.1",
        port: 9090
    });

    assert.deepEqual(resolveDiagnosticsTarget({
        runtime: {
            diagnostics: {
                enabled: true,
                host: "0.0.0.0",
                port: 9191
            }
        }
    }), {
        enabled: true,
        host: "127.0.0.1",
        port: 9191
    });

    assert.deepEqual(resolveDiagnosticsTarget({
        runtime: {
            diagnostics: {
                enabled: false,
                host: "192.0.2.10",
                port: 9292
            }
        }
    }), {
        enabled: false,
        host: "192.0.2.10",
        port: 9292
    });
});

test("container healthcheck uses IPv6 loopback for wildcard IPv6 binds", () => {
    assert.equal(resolveDiagnosticsTarget({
        runtime: {
            diagnostics: {
                host: "::"
            }
        }
    }).host, "::1");
});
