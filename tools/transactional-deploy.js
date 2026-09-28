#!/usr/bin/env node

const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { evaluateAcceptance, fetchJson } = require("../src/acceptance-check");
const { buildIdentityManifest } = require("../src/identity-manifest");
const { writeManifest } = require("./capture-identity-manifest");

function positiveInteger(value, label) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
    return parsed;
}

function parseArgs(argv) {
    const options = {
        command: "deploy",
        container: "onvif-vcam-server",
        image: null,
        config: "config.yml",
        envFile: null,
        url: "http://127.0.0.1:9090/status",
        expectedCameras: 29,
        requireFrigate: false,
        requireRecorders: [],
        requirePullPointSubscribers: false,
        checkpointDir: "deployment-checkpoints",
        timeoutSeconds: 180,
        intervalSeconds: 2,
        apply: false,
        rollbackContainer: null
    };
    let index = 0;
    if (["deploy", "rollback"].includes(argv[0])) options.command = argv[index++];
    for (; index < argv.length; index += 1) {
        const arg = argv[index];
        const next = () => {
            index += 1;
            if (index >= argv.length) throw new Error(`${arg} requires a value`);
            return argv[index];
        };
        if (arg === "--container") options.container = next();
        else if (arg === "--image") options.image = next();
        else if (arg === "--config") options.config = next();
        else if (arg === "--env-file") options.envFile = next();
        else if (arg === "--url") options.url = next();
        else if (arg === "--expected-cameras") options.expectedCameras = positiveInteger(next(), arg);
        else if (arg === "--require-frigate") options.requireFrigate = true;
        else if (arg === "--require-recorder") options.requireRecorders.push(next());
        else if (arg === "--require-pullpoint-subscribers") options.requirePullPointSubscribers = true;
        else if (arg === "--checkpoint-dir") options.checkpointDir = next();
        else if (arg === "--timeout-seconds") options.timeoutSeconds = positiveInteger(next(), arg);
        else if (arg === "--interval-seconds") options.intervalSeconds = positiveInteger(next(), arg);
        else if (arg === "--rollback-container") options.rollbackContainer = next();
        else if (arg === "--apply") options.apply = true;
        else throw new Error(`unknown argument: ${arg}`);
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(options.container)) {
        throw new Error("--container is not a valid Docker container name");
    }
    if (options.command === "deploy" && !options.image) throw new Error("deploy requires --image");
    if (options.command === "rollback" && !options.rollbackContainer) {
        throw new Error("rollback requires --rollback-container");
    }
    return options;
}

function createDockerExecutor() {
    return {
        run(args) {
            const result = childProcess.spawnSync("docker", args, { encoding: "utf8" });
            if (result.error) throw result.error;
            return {
                ok: result.status === 0,
                stdout: (result.stdout || "").trim(),
                stderr: (result.stderr || "").trim()
            };
        }
    };
}

function requireDocker(result, operation) {
    if (!result.ok) throw new Error(`${operation} failed: ${result.stderr || "docker returned an error"}`);
    return result.stdout;
}

function timestampName(container, now = new Date()) {
    const timestamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    return `${container}-rollback-${timestamp}`;
}

async function waitForHealthy(container, options, dependencies) {
    const docker = dependencies.docker;
    const delay = dependencies.delay || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const deadline = dependencies.now() + (options.timeoutSeconds * 1000);
    while (true) {
        const result = docker.run([
            "inspect", "--format",
            "{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}",
            container
        ]);
        const state = requireDocker(result, "candidate health inspection");
        const [runtimeState, healthState] = state.includes(" ") ? state.split(/\s+/, 2) : ["running", state];
        if (["dead", "exited"].includes(runtimeState)) {
            throw new Error(`candidate entered ${runtimeState} state`);
        }
        if (healthState === "healthy") return healthState;
        if (healthState === "no-healthcheck") throw new Error("candidate image has no Docker healthcheck");
        if (dependencies.now() >= deadline) throw new Error("candidate health validation timed out");
        await delay(options.intervalSeconds * 1000);
    }
}

async function waitForAcceptance(options, identityManifest, dependencies) {
    const request = dependencies.fetchJson;
    const delay = dependencies.delay || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const deadline = dependencies.now() + (options.timeoutSeconds * 1000);
    let lastResult;
    while (true) {
        const status = await request(options.url, options.timeoutSeconds * 1000);
        lastResult = evaluateAcceptance(status, {
            expectedCameras: options.expectedCameras,
            expectedIdentities: identityManifest.cameras,
            requireFrigate: options.requireFrigate,
            requireRecorders: options.requireRecorders,
            requirePullPointSubscribers: options.requirePullPointSubscribers
        });
        if (lastResult.passed) return lastResult;
        if (dependencies.now() >= deadline) {
            throw new Error(`candidate acceptance timed out: ${lastResult.failures.join("; ")}`);
        }
        await delay(options.intervalSeconds * 1000);
    }
}

async function deploy(options, dependencies = {}) {
    const docker = dependencies.docker || createDockerExecutor();
    const request = dependencies.fetchJson || fetchJson;
    const nowDate = dependencies.nowDate || (() => new Date());
    const now = dependencies.now || (() => Date.now());
    const rollbackContainer = timestampName(options.container, nowDate());
    const config = path.resolve(options.config);
    const envFile = options.envFile ? path.resolve(options.envFile) : null;
    if (!fs.existsSync(config)) throw new Error(`candidate config does not exist: ${config}`);
    if (envFile && !fs.existsSync(envFile)) throw new Error(`environment file does not exist: ${envFile}`);

    const currentStatus = await request(options.url, options.timeoutSeconds * 1000);
    const identityManifest = buildIdentityManifest(currentStatus, options.expectedCameras);
    const current = requireDocker(
        docker.run(["inspect", "--format", "{{.State.Running}}", options.container]),
        "current container inspection"
    );
    if (current !== "true") throw new Error(`current container ${options.container} is not running`);
    if (docker.run(["inspect", rollbackContainer]).ok) {
        throw new Error(`rollback container already exists: ${rollbackContainer}`);
    }

    let imageResult = docker.run(["image", "inspect", options.image]);
    if (!imageResult.ok && options.apply) {
        requireDocker(docker.run(["pull", options.image]), "candidate image pull");
        imageResult = docker.run(["image", "inspect", options.image]);
    }
    if (options.apply) requireDocker(imageResult, "candidate image inspection");

    const runArgs = [
        "run", "-d", "--name", options.container,
        "--network", "host", "--restart", "unless-stopped",
        "-v", `${config}:/config.yml:ro`
    ];
    if (envFile) runArgs.push("--env-file", envFile);
    runArgs.push(options.image);

    const plan = Object.freeze({
        container: options.container,
        rollbackContainer,
        image: options.image,
        config,
        envFile,
        expectedCameras: options.expectedCameras
    });
    if (!options.apply) return { applied: false, plan };

    const checkpointDir = path.resolve(options.checkpointDir);
    fs.mkdirSync(checkpointDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(checkpointDir, 0o700);
    const identityPath = path.join(checkpointDir, `${rollbackContainer}.identities.json`);
    writeManifest(identityPath, identityManifest);

    let currentStopped = false;
    let oldRenamed = false;
    try {
        requireDocker(docker.run(["stop", options.container]), "current container stop");
        currentStopped = true;
        requireDocker(docker.run(["rename", options.container, rollbackContainer]), "rollback container rename");
        oldRenamed = true;
        requireDocker(docker.run(runArgs), "candidate container start");
        await waitForHealthy(options.container, options, { docker, delay: dependencies.delay, now });

        const acceptance = await waitForAcceptance(options, identityManifest, {
            fetchJson: request,
            delay: dependencies.delay,
            now
        });
        return { applied: true, plan, identityPath, acceptance };
    } catch (error) {
        if (oldRenamed) {
            if (docker.run(["inspect", options.container]).ok) docker.run(["rm", "-f", options.container]);
            requireDocker(docker.run(["rename", rollbackContainer, options.container]), "automatic rollback rename");
            requireDocker(docker.run(["start", options.container]), "automatic rollback start");
            throw new Error(`${error.message}; previous container restored automatically`);
        }
        if (currentStopped) {
            requireDocker(docker.run(["start", options.container]), "stopped container recovery");
            throw new Error(`${error.message}; current container restarted automatically`);
        }
        throw error;
    }
}

function rollback(options, dependencies = {}) {
    const docker = dependencies.docker || createDockerExecutor();
    if (!options.apply) return { applied: false, container: options.container, rollbackContainer: options.rollbackContainer };
    requireDocker(docker.run(["inspect", options.rollbackContainer]), "rollback container inspection");
    const replacedContainer = timestampName(options.container, dependencies.nowDate?.() || new Date())
        .replace("-rollback-", "-replaced-");
    const currentExists = docker.run(["inspect", options.container]).ok;
    if (currentExists) {
        if (docker.run(["inspect", replacedContainer]).ok) {
            throw new Error(`replacement checkpoint already exists: ${replacedContainer}`);
        }
        requireDocker(docker.run(["stop", options.container]), "candidate container stop");
        requireDocker(docker.run(["rename", options.container, replacedContainer]), "candidate container checkpoint");
    }
    let rollbackRenamed = false;
    try {
        requireDocker(docker.run(["rename", options.rollbackContainer, options.container]), "rollback container rename");
        rollbackRenamed = true;
        requireDocker(docker.run(["start", options.container]), "rollback container start");
    } catch (error) {
        if (rollbackRenamed) {
            requireDocker(
                docker.run(["rename", options.container, options.rollbackContainer]),
                "failed rollback checkpoint recovery"
            );
        }
        if (currentExists) {
            requireDocker(
                docker.run(["rename", replacedContainer, options.container]),
                "candidate checkpoint recovery"
            );
            requireDocker(docker.run(["start", options.container]), "candidate restart recovery");
        }
        throw new Error(`${error.message}; candidate container restored automatically`);
    }
    return { applied: true, container: options.container, replacedContainer: currentExists ? replacedContainer : null };
}

async function main() {
    try {
        const options = parseArgs(process.argv.slice(2));
        const result = options.command === "rollback" ? rollback(options) : await deploy(options);
        console.log(JSON.stringify(result, null, 2));
    } catch (error) {
        console.error(JSON.stringify({ applied: false, error: error.message }, null, 2));
        process.exitCode = 1;
    }
}

if (require.main === module) main();

module.exports = {
    createDockerExecutor,
    deploy,
    parseArgs,
    rollback,
    timestampName,
    waitForAcceptance,
    waitForHealthy
};
