#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { fetchJson } = require("../src/acceptance-check");
const { buildIdentityManifest } = require("../src/identity-manifest");

function parsePositiveInteger(value, label) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`${label} must be a positive integer`);
    }
    return parsed;
}

function parseArgs(argv) {
    const options = {
        url: "http://127.0.0.1:9090/status",
        expectedCameras: undefined,
        output: "camera-identities.json",
        timeoutMs: 5000,
        force: false
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const next = () => {
            index += 1;
            if (index >= argv.length) throw new Error(`${arg} requires a value`);
            return argv[index];
        };
        if (arg === "--url") options.url = next();
        else if (arg === "--expected-cameras") {
            options.expectedCameras = parsePositiveInteger(next(), arg);
        } else if (arg === "--output") options.output = next();
        else if (arg === "--timeout-ms") options.timeoutMs = parsePositiveInteger(next(), arg);
        else if (arg === "--force") options.force = true;
        else throw new Error(`unknown argument: ${arg}`);
    }

    if (!options.output.trim()) throw new Error("--output must not be empty");
    return options;
}

function writeManifest(filePath, manifest, force = false) {
    const absolutePath = path.resolve(filePath);
    const directory = path.dirname(absolutePath);
    if (!fs.existsSync(directory)) {
        throw new Error(`output directory does not exist: ${directory}`);
    }

    const temporaryPath = path.join(
        directory,
        `.${path.basename(absolutePath)}.${process.pid}.${Date.now()}.tmp`
    );
    const content = `${JSON.stringify(manifest, null, 2)}\n`;

    try {
        fs.writeFileSync(temporaryPath, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
        fs.chmodSync(temporaryPath, 0o600);
        if (force) {
            fs.renameSync(temporaryPath, absolutePath);
        } else {
            fs.linkSync(temporaryPath, absolutePath);
            fs.unlinkSync(temporaryPath);
        }
    } catch (error) {
        try {
            fs.unlinkSync(temporaryPath);
        } catch (cleanupError) {
            if (cleanupError.code !== "ENOENT") throw cleanupError;
        }
        if (error.code === "EEXIST") {
            throw new Error(`identity manifest already exists: ${absolutePath}; use --force to replace it`);
        }
        throw error;
    }

    return absolutePath;
}

async function run(options, dependencies = {}) {
    const request = dependencies.fetchJson || fetchJson;
    const status = await request(options.url, options.timeoutMs);
    const manifest = buildIdentityManifest(status, options.expectedCameras);
    const output = writeManifest(options.output, manifest, options.force);
    return Object.freeze({ output, cameras: manifest.cameras.length });
}

async function main() {
    try {
        const result = await run(parseArgs(process.argv.slice(2)));
        console.log(JSON.stringify({ captured: true, ...result }, null, 2));
    } catch (error) {
        console.error(JSON.stringify({ captured: false, error: error.message }, null, 2));
        process.exitCode = 1;
    }
}

if (require.main === module) main();

module.exports = { parseArgs, run, writeManifest };
