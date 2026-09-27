#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const http = require("http");
const yaml = require("js-yaml");

function findConfigPath() {
    const local = path.resolve("./config.yml");
    return fs.existsSync(local) ? local : "/config.yml";
}

function resolveDiagnosticsTarget(rawConfig = {}) {
    const diagnostics = rawConfig.runtime?.diagnostics || {};
    const enabled = diagnostics.enabled !== false;
    const configuredHost = diagnostics.host || "127.0.0.1";
    const port = Number(diagnostics.port ?? 9090);

    let host = configuredHost;
    if (host === "0.0.0.0") host = "127.0.0.1";
    if (host === "::" || host === "[::]") host = "::1";

    return {
        enabled,
        host,
        port
    };
}

function checkHealth(target, timeoutMs = 4000) {
    if (!target.enabled) return Promise.resolve(true);

    return new Promise((resolve) => {
        const req = http.get({
            host: target.host,
            port: target.port,
            path: "/healthz",
            timeout: timeoutMs
        }, (res) => {
            res.resume();
            resolve(res.statusCode === 200);
        });

        req.on("timeout", () => {
            req.destroy();
            resolve(false);
        });
        req.on("error", () => resolve(false));
    });
}

async function main() {
    const configPath = findConfigPath();
    const raw = yaml.load(fs.readFileSync(configPath, "utf8")) || {};
    const target = resolveDiagnosticsTarget(raw);
    const healthy = await checkHealth(target);
    process.exitCode = healthy ? 0 : 1;
}

if (require.main === module) {
    main().catch(() => {
        process.exitCode = 1;
    });
}

module.exports = {
    findConfigPath,
    resolveDiagnosticsTarget,
    checkHealth
};
