const logger = require("./log-manager");
const http = require("http");

function cameraHealthy(camera) {
    if (!camera || camera.state !== "running") return false;

    const lifecycle = camera.lifecycle || {};
    return [
        "configLoaded",
        "networkResolved",
        "httpReady",
        "eventReady",
        "snapshotReady",
        "rtspProxyReady",
        "discoveryReady"
    ].every((key) => lifecycle[key] === true);
}

function analyticsHealthy(analytics) {
    if (!analytics) return true;

    const frigate = analytics.frigate;
    if (frigate && (
        frigate.state !== "connected"
        || frigate.available === false
    )) {
        return false;
    }

    for (const recorder of analytics.recorders || []) {
        if (
            recorder.client?.state !== "connected"
            || recorder.runtime?.state !== "connected"
        ) {
            return false;
        }
    }

    return true;
}

function buildSystemHealth(options = {}) {
    const cameraManagers = options.cameraManagers || [];
    const analyticsManager = options.analyticsManager || null;
    const now = options.now || (() => Date.now());
    const startedAt = options.startedAt ?? now();
    const observedAt = now();

    const cameras = cameraManagers.map((manager) => manager.health());
    const healthyCameras = cameras.filter(cameraHealthy).length;
    const analytics = analyticsManager ? analyticsManager.health() : null;
    const healthy =
        healthyCameras === cameras.length
        && analyticsHealthy(analytics);

    return Object.freeze({
        status: healthy ? "healthy" : "degraded",
        timestamp: new Date(observedAt).toISOString(),
        startedAt: new Date(startedAt).toISOString(),
        uptimeSeconds: Math.max(0, Math.floor((observedAt - startedAt) / 1000)),
        cameras: Object.freeze({
            total: cameras.length,
            healthy: healthyCameras,
            items: cameras
        }),
        analytics
    });
}

class DiagnosticsServer {
    constructor(options = {}) {
        if (typeof options.healthProvider !== "function") {
            throw new Error("Diagnostics server requires a healthProvider function");
        }

        this.host = options.host || "127.0.0.1";
        this.port = options.port ?? 9090;
        this.healthProvider = options.healthProvider;
        this.server = null;
    }

    async start() {
        if (this.server) return;

        await new Promise((resolve, reject) => {
            const server = http.createServer((req, res) => {
                this.handleRequest(req, res);
            });
            this.server = server;

            const onError = (error) => {
                if (!server.listening) {
                    this.server = null;
                    reject(error);
                }
            };

            server.once("error", onError);
            server.listen(this.port, this.host, () => {
                server.removeListener("error", onError);
                server.on("error", (error) => {
                    logger.error("Diagnostics server error: " + error.message);
                });
                resolve();
            });
        });
    }

    handleRequest(req, res) {
        res.setHeader("Cache-Control", "no-store");

        if (req.method !== "GET") {
            res.statusCode = 405;
            res.setHeader("Allow", "GET");
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(JSON.stringify({ error: "method-not-allowed" }));
            return;
        }

        if (req.url !== "/healthz" && req.url !== "/status") {
            res.statusCode = 404;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(JSON.stringify({ error: "not-found" }));
            return;
        }

        let health;
        try {
            health = this.healthProvider();
        } catch (error) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(JSON.stringify({
                status: "error",
                error: error.message
            }));
            return;
        }

        res.statusCode =
            req.url === "/healthz" && health.status !== "healthy"
                ? 503
                : 200;
        res.setHeader("Content-Type", "application/json; charset=utf-8");

        if (req.url === "/healthz") {
            res.end(JSON.stringify({
                status: health.status,
                timestamp: health.timestamp,
                uptimeSeconds: health.uptimeSeconds,
                cameras: {
                    total: health.cameras.total,
                    healthy: health.cameras.healthy
                },
                analytics: {
                    frigate: health.analytics?.frigate?.state || null,
                    recorders: (health.analytics?.recorders || []).map((entry) => ({
                        name: entry.name,
                        client: entry.client?.state || null,
                        runtime: entry.runtime?.state || null
                    }))
                }
            }));
            return;
        }

        res.end(JSON.stringify(health, null, 2));
    }

    async stop() {
        const server = this.server;
        this.server = null;
        if (!server) return;

        await new Promise((resolve, reject) => {
            server.close((error) => {
                if (error) reject(error);
                else resolve();
            });
        });
    }

    address() {
        return this.server?.address() || null;
    }
}

module.exports = {
    DiagnosticsServer,
    buildSystemHealth,
    cameraHealthy,
    analyticsHealthy
};
