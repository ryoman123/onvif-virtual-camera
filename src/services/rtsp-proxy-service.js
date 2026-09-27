const TcpProxy = require("node-tcp-proxy");
const logger = require("../log-manager");

class RtspProxyService {
    constructor(camera, onFatalError) {
        this.camera = camera;
        this.onFatalError = onFatalError;
        this.proxy = null;
        this.loggedSessions = new Set();
    }

    start() {
        if (this.proxy) {
            return;
        }

        logger.info(
            `Starting RTSP TCP proxy for ${this.camera.name}: ` +
            `${this.camera.ip}:${this.camera.rtspProxyPort} -> ` +
            `${this.camera.source.hostname}:${this.camera.source.rtspPort}`
        );

        this.proxy = TcpProxy.createProxy(
            this.camera.rtspProxyPort,
            this.camera.source.hostname,
            this.camera.source.rtspPort,
            {
                hostname: this.camera.ip,
                localAddress: this.camera.ip,
                quiet: true
            }
        );

        this.proxy.server?.on("error", (err) => {
            this.onFatalError?.(err);
        });

        this.proxy.server?.on("connection", (socket) => {
            const sessionKey = `${socket.remoteAddress}:${socket.remotePort}`;

            socket.on("data", (data) => {
                if (this.loggedSessions.has(sessionKey)) {
                    return;
                }

                const line = data.toString("utf8").split(/\r?\n/, 1)[0] || "";
                if (!line.startsWith("DESCRIBE ") && !line.startsWith("SETUP ") && !line.startsWith("PLAY ")) {
                    return;
                }

                this.loggedSessions.add(sessionKey);

                const requestPath = line.split(" ", 3)[1] || "<unknown>";
                const streamKind = requestPath.includes(this.camera.rtspPathLq)
                    ? "lq"
                    : requestPath.includes(this.camera.rtspPathHq)
                        ? "hq"
                        : "unknown";

                logger.debug("media", `RTSP request for ${this.camera.name} (client=${sessionKey}, kind=${streamKind}) -> ${requestPath}`);
            });

            const clearSession = () => {
                this.loggedSessions.delete(sessionKey);
            };

            socket.on("close", clearSession);
            socket.on("error", clearSession);
        });

        this.camera.lifecycle.rtspProxyReady = true;
    }

    health() {
        return Object.freeze({
            ready: !!this.proxy && this.camera.lifecycle.rtspProxyReady === true,
            activeSessions: this.loggedSessions.size
        });
    }

    stop() {
        if (!this.proxy) {
            return;
        }

        this.proxy.end();
        this.proxy = null;
        this.camera.lifecycle.rtspProxyReady = false;
    }
}

module.exports = RtspProxyService;
