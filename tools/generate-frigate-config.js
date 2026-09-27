#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const { generateFrigateBundle } = require("../src/frigate-config-generator");

function parseArgs(argv) {
    const args = {
        input: "./config.yml",
        outputDir: "./frigate-sidecar",
        detectFps: 5,
        force: false
    };

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === "--force") {
            args.force = true;
        } else if (arg === "--input") {
            args.input = argv[++i];
        } else if (arg === "--output-dir") {
            args.outputDir = argv[++i];
        } else if (arg === "--detect-fps") {
            args.detectFps = Number(argv[++i]);
        } else if (arg === "--mqtt-ca-certs") {
            args.mqttCaCerts = argv[++i];
        } else if (arg === "--help" || arg === "-h") {
            args.help = true;
        } else {
            throw new Error("Unknown argument: " + arg);
        }
    }

    return args;
}

function usage() {
    return [
        "Generate a Frigate AI sidecar from the ONVIF bridge config.",
        "",
        "Usage:",
        "  node tools/generate-frigate-config.js [options]",
        "",
        "Options:",
        "  --input PATH          Bridge config.yml (default: ./config.yml)",
        "  --output-dir PATH     Output directory (default: ./frigate-sidecar)",
        "  --detect-fps NUMBER   Maximum detection FPS per camera (default: 5)",
        "  --mqtt-ca-certs PATH  CA bundle path inside Frigate for mqtts://",
        "  --force               Replace generated files if they already exist",
        "  -h, --help            Show this help"
    ].join("\n");
}

function writeGeneratedFile(filePath, content, options = {}) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, {
        encoding: "utf8",
        mode: options.mode
    });
    if (options.mode) fs.chmodSync(filePath, options.mode);
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        process.stdout.write(usage() + "\n");
        return;
    }

    const inputPath = path.resolve(args.input);
    const outputDir = path.resolve(args.outputDir);
    const raw = fs.readFileSync(inputPath, "utf8");
    const config = yaml.load(raw);
    const bundle = generateFrigateBundle(config, {
        detectFps: args.detectFps,
        mqttCaCerts: args.mqttCaCerts
    });

    const outputs = {
        frigateConfig: path.join(outputDir, "config", "config.yml"),
        env: path.join(outputDir, ".env"),
        cameraMap: path.join(outputDir, "bridge-frigate-map.yml"),
        compose: path.join(outputDir, "docker-compose.yml")
    };

    const existing = Object.values(outputs).filter((filePath) => fs.existsSync(filePath));
    if (existing.length > 0 && !args.force) {
        throw new Error(
            "Refusing to overwrite generated files without --force:\n" +
            existing.map((item) => "  " + item).join("\n")
        );
    }

    const composeTemplate = fs.readFileSync(
        path.join(__dirname, "..", "resources", "frigate", "docker-compose.yml"),
        "utf8"
    );

    writeGeneratedFile(outputs.frigateConfig, bundle.frigateYaml);
    writeGeneratedFile(outputs.env, bundle.envText, { mode: 0o600 });
    writeGeneratedFile(outputs.cameraMap, bundle.bridgeFragmentYaml);
    writeGeneratedFile(outputs.compose, composeTemplate);

    fs.mkdirSync(path.join(outputDir, "media"), { recursive: true });

    process.stdout.write(
        "Generated Frigate AI sidecar for " + bundle.cameraCount + " camera(s).\n" +
        "Output: " + outputDir + "\n" +
        "Bridge camera_map can be set to 'auto' or copied from bridge-frigate-map.yml.\n"
    );
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        process.stderr.write("Frigate generator failed: " + error.message + "\n");
        process.exitCode = 1;
    }
}

module.exports = { parseArgs, main };
