const childProcess = require("node:child_process");
const os = require("os");
const logger = require("./log-manager");

function findInterfaceByMac(targetMac) {
    const normalizedTarget = targetMac.toLowerCase();

    const interfaces = os.networkInterfaces();

    for (const [ifaceName, entries] of Object.entries(interfaces)) {
        for (const entry of entries) {
            if (!entry.mac) continue;

            const mac = entry.mac.toLowerCase();

            if (mac === normalizedTarget) {
                return ifaceName;
            }
        }
    }

    throw new Error(`No interface found with MAC ${targetMac}`);
}

function getInterfaceIp(ifaceName) {
    const interfaces = os.networkInterfaces();
    const entries = interfaces[ifaceName];

    if (!entries) {
        throw new Error(`Interface '${ifaceName}' does not exist`);
    }

    // Prefer IPv4, non-internal
    for (const entry of entries) {
        if (entry.family === "IPv4" && !entry.internal) {
            if (!entry.address) {
                throw new Error(`Interface '${ifaceName}' has no IPv4 address`);
            }
            return entry.address;
        }
    }

    throw new Error(`Interface '${ifaceName}' has no usable IPv4 address`);
}

function pingFromInterface(ifaceName, target, timeoutSeconds = 3, dependencies = {}) {
    const execFile = dependencies.execFile || childProcess.execFile;
    const pingPath = dependencies.pingPath || process.env.PING_PATH || "ping";
    const timeout = Number(timeoutSeconds);
    const processTimeoutMs = (timeout + 2) * 1000;

    return new Promise((resolve, reject) => {
        execFile(
            pingPath,
            ["-I", ifaceName, "-c", "1", "-W", String(timeout), target],
            {
                timeout: processTimeoutMs,
                windowsHide: true
            },
            (error) => {
                if (!error) {
                    resolve({ sent: true, replied: true });
                    return;
                }

                // iputils ping uses exit status 1 when no reply was received. The
                // outbound frame was still transmitted, which is enough for the
                // switch-learning keepalive this helper is intended to provide.
                if (error.code === 1 || error.code === "1") {
                    resolve({ sent: true, replied: false });
                    return;
                }

                reject(new Error(
                    `Interface keepalive failed for ${ifaceName}: ${error.code || error.message}`
                ));
            }
        );
    });
}

module.exports = {
    findInterfaceByMac,
    getInterfaceIp,
    pingFromInterface
};
