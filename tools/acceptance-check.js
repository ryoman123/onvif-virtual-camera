#!/usr/bin/env node

const {
    evaluateAcceptance,
    fetchJson
} = require("../src/acceptance-check");

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
        else if (arg === "--soak-seconds") {
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

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run(options, dependencies = {}) {
    const request = dependencies.fetchJson || fetchJson;
    const wait = dependencies.delay || delay;
    const startedAt = Date.now();
    const deadline = startedAt + (options.soakSeconds * 1000);
    let samples = 0;

    while (true) {
        samples += 1;
        const status = await request(options.url, options.timeoutMs);
        const result = evaluateAcceptance(status, options);
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

module.exports = { parseArgs, run };
