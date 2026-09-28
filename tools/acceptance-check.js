#!/usr/bin/env node

const {
    evaluateAcceptance,
    evaluateContinuity,
    fetchJson
} = require("../src/acceptance-check");
const fs = require("fs");

function parsePositiveInteger(value, label, allowZero = false) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || (allowZero ? parsed < 0 : parsed <= 0)) {
        throw new Error(`${label} must be ${allowZero ? "a non-negative" : "a positive"} integer`);
    }
    return parsed;
}

function parseArgs(argv) {
    const options = {
        url: "http://127.0.0.1:9090/status",
        expectedCameras: undefined,
        requireFrigate: false,
        requireRecorders: [],
        identityManifest: null,
        minFrigateEvents: undefined,
        minRecorderEvents: {},
        minRecorderConnections: {},
        requirePullPointSubscribers: false,
        minPullPointMessages: undefined,
        soakSeconds: 0,
        intervalSeconds: 30,
        timeoutMs: 5000
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
        } else if (arg === "--require-frigate") options.requireFrigate = true;
        else if (arg === "--require-recorder") options.requireRecorders.push(next());
        else if (arg === "--identity-manifest") options.identityManifest = next();
        else if (arg === "--min-frigate-events") {
            options.minFrigateEvents = parsePositiveInteger(next(), arg, true);
        } else if (arg === "--min-recorder-events") {
            const [name, value] = parseNamedMinimum(next(), arg);
            options.minRecorderEvents[name] = value;
        } else if (arg === "--min-recorder-connections") {
            const [name, value] = parseNamedMinimum(next(), arg);
            options.minRecorderConnections[name] = value;
        } else if (arg === "--require-pullpoint-subscribers") {
            options.requirePullPointSubscribers = true;
        } else if (arg === "--min-pullpoint-messages") {
            options.minPullPointMessages = parsePositiveInteger(next(), arg, true);
        } else if (arg === "--soak-seconds") {
            options.soakSeconds = parsePositiveInteger(next(), arg, true);
        } else if (arg === "--interval-seconds") {
            options.intervalSeconds = parsePositiveInteger(next(), arg);
        } else if (arg === "--timeout-ms") {
            options.timeoutMs = parsePositiveInteger(next(), arg);
        } else {
            throw new Error(`unknown argument: ${arg}`);
        }
    }

    return options;
}

function parseNamedMinimum(value, label) {
    const separator = value.lastIndexOf("=");
    if (separator <= 0) throw new Error(`${label} must use name=minimum`);
    const name = value.slice(0, separator).trim();
    if (!name) throw new Error(`${label} must include a name`);
    return [name, parsePositiveInteger(value.slice(separator + 1), label, true)];
}

function readIdentityManifest(filePath) {
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (error) {
        throw new Error(`unable to read identity manifest: ${error.message}`);
    }
    const cameras = Array.isArray(parsed) ? parsed : parsed?.cameras;
    if (!Array.isArray(cameras) || cameras.length === 0) {
        throw new Error("identity manifest must contain a non-empty cameras array");
    }
    const required = ["name", "mac", "serialNumber", "hardwareId"];
    for (const [index, camera] of cameras.entries()) {
        for (const field of required) {
            if (typeof camera?.[field] !== "string" || !camera[field].trim()) {
                throw new Error(`identity manifest camera ${index} is missing ${field}`);
            }
        }
    }
    return cameras;
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run(options, dependencies = {}) {
    const request = dependencies.fetchJson || fetchJson;
    const wait = dependencies.delay || delay;
    const expectedIdentities = options.expectedIdentities
        || (options.identityManifest ? readIdentityManifest(options.identityManifest) : undefined);
    const acceptanceOptions = { ...options, expectedIdentities };
    const startedAt = Date.now();
    const deadline = startedAt + (options.soakSeconds * 1000);
    let samples = 0;
    let previousContinuity = null;

    while (true) {
        samples += 1;
        const status = await request(options.url, options.timeoutMs);
        let result = evaluateAcceptance(status, acceptanceOptions);
        if (options.soakSeconds > 0) {
            const continuity = evaluateContinuity(status, previousContinuity);
            previousContinuity = continuity.current;
            if (continuity.failures.length > 0) {
                result = {
                    ...result,
                    passed: false,
                    failures: Object.freeze([
                        ...result.failures,
                        ...continuity.failures
                    ])
                };
            }
        }
        if (!result.passed) {
            return {
                ...result,
                samples,
                elapsedSeconds: Math.floor((Date.now() - startedAt) / 1000)
            };
        }

        if (Date.now() >= deadline) {
            return {
                ...result,
                samples,
                elapsedSeconds: Math.floor((Date.now() - startedAt) / 1000)
            };
        }

        const remainingMs = deadline - Date.now();
        await wait(Math.min(options.intervalSeconds * 1000, remainingMs));
    }
}

async function main() {
    try {
        const options = parseArgs(process.argv.slice(2));
        const result = await run(options);
        console.log(JSON.stringify(result, null, 2));
        process.exitCode = result.passed ? 0 : 1;
    } catch (error) {
        console.error(JSON.stringify({
            passed: false,
            error: error.message
        }, null, 2));
        process.exitCode = 1;
    }
}

if (require.main === module) {
    main();
}

module.exports = { parseArgs, parseNamedMinimum, readIdentityManifest, run };
