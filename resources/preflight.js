#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { loadConfig } = require("../src/config-loader");
const { buildDeploymentPreflight } = require("../src/deployment-preflight");

function parseArguments(argv) {
    const options = { configPath: null, expectedCameraCount: null, requireAnalyticsCoverage: false };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === "--config") {
            options.configPath = argv[++index];
        } else if (argument === "--expected-cameras") {
            options.expectedCameraCount = argv[++index];
        } else if (argument === "--require-analytics-coverage") {
            options.requireAnalyticsCoverage = true;
        } else {
            throw new Error(`Unknown preflight argument: ${argument}`);
        }
    }
    return options;
}

function defaultConfigPath() {
    const local = path.resolve("./config.yml");
    return fs.existsSync(local) ? local : "/config.yml";
}

function run(argv = process.argv.slice(2), env = process.env) {
    const options = parseArguments(argv);
    const configPath = path.resolve(options.configPath || defaultConfigPath());
    const config = loadConfig(configPath);
    const report = buildDeploymentPreflight(config, { ...options, env });

    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.ok ? 0 : 1;
}

if (require.main === module) {
    try {
        process.exitCode = run();
    } catch (error) {
        process.stderr.write(`Preflight failed: ${error.message}\n`);
        process.exitCode = 1;
    }
}

module.exports = { parseArguments, run };
