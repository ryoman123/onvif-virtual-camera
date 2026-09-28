const crypto = require("crypto");
const childProcess = require("node:child_process");
const http = require("http");
const https = require("https");
const logger = require("../log-manager");

class SnapshotService {
    constructor(camera, dependencies = {}) {
        this.camera = camera;
        this.snapshotUrl = new URL(camera.source.snapshotUrl);
        this.execFile = dependencies.execFile || childProcess.execFile;
    }

    canHandleRequest(req) {
        if (req.method !== "GET") {
            return false;
        }

        return req.url === this.camera.source.snapshotPath;
    }

    async handleRequest(req, res) {
        logger.debug("snapshot",
            `Snapshot request for ${this.camera.name}: ${req.method} ${req.url}`
        );

        try {
            await this.forwardSnapshot(res);
        } catch (err) {
            logger.error(`Snapshot proxy failed for ${this.camera.name}: ${err.message}`);
            if (!res.headersSent) {
                res.statusCode = 502;
                res.setHeader("Content-Type", "text/plain");
            }
            res.end("Snapshot proxy error");
        }
    }

    async forwardSnapshot(res) {
        if (this.camera.source.snapshotSource === "hq") {
            await this.captureHqSnapshot(res);
            return;
        }

        const client = this.snapshotUrl.protocol === "https:" ? https : http;
        const baseHeaders = {
            Accept: "image/*,*/*;q=0.8"
        };
        const credentials = this.getCredentials();
        let upstreamRes = await this.sendSnapshotRequest(client, baseHeaders);

        if (upstreamRes.statusCode === 401 && credentials) {
            const digestHeader = upstreamRes.headers["www-authenticate"];
            const digestAuth = this.buildDigestAuthorizationHeader(digestHeader, credentials);

            upstreamRes.resume();

            if (digestAuth) {
                logger.debug("snapshot",
                    `Retrying snapshot request for ${this.camera.name} with Digest auth`
                );
                upstreamRes = await this.sendSnapshotRequest(client, {
                    ...baseHeaders,
                    Authorization: digestAuth
                });
            }
        }

        if (upstreamRes.statusCode && upstreamRes.statusCode >= 400) {
            upstreamRes.resume();
            throw new Error(`upstream returned HTTP ${upstreamRes.statusCode}`);
        }

        await this.pipeSnapshotResponse(upstreamRes, res);
    }

    captureHqSnapshot(res) {
        const ffmpegPath = process.env.FFMPEG_PATH || "/usr/bin/ffmpeg";
        const args = [
            "-hide_banner", "-loglevel", "error",
            "-rtsp_transport", "tcp",
            "-i", this.camera.source.rtspUrlHq,
            "-frames:v", "1",
            "-an",
            "-f", "image2pipe",
            "-vcodec", "mjpeg",
            "pipe:1"
        ];

        return new Promise((resolve, reject) => {
            this.execFile(ffmpegPath, args, {
                encoding: null,
                timeout: 15000,
                maxBuffer: 32 * 1024 * 1024
            }, (error, stdout) => {
                if (error) {
                    reject(new Error(
                        `HQ snapshot capture failed${error.code ? ` (exit ${error.code})` : ""}`
                    ));
                    return;
                }

                if (!Buffer.isBuffer(stdout) || stdout.length === 0) {
                    reject(new Error("HQ snapshot capture returned no image"));
                    return;
                }

                res.statusCode = 200;
                res.setHeader("Content-Type", "image/jpeg");
                res.setHeader("Content-Length", stdout.length);
                this.setNoCacheHeaders(res);
                res.end(stdout);
                resolve();
            });
        });
    }

    getCredentials() {
        if (!this.snapshotUrl.username && !this.snapshotUrl.password) {
            return null;
        }

        return {
            username: decodeURIComponent(this.snapshotUrl.username),
            password: decodeURIComponent(this.snapshotUrl.password)
        };
    }

    sendSnapshotRequest(client, headers) {
        const requestOptions = {
            protocol: this.snapshotUrl.protocol,
            hostname: this.snapshotUrl.hostname,
            port: this.snapshotUrl.port || (this.snapshotUrl.protocol === "https:" ? 443 : 80),
            path: `${this.snapshotUrl.pathname}${this.snapshotUrl.search}`,
            method: "GET",
            headers
        };

        return new Promise((resolve, reject) => {
            const upstreamReq = client.request(requestOptions, resolve);
            upstreamReq.on("error", reject);
            upstreamReq.setTimeout(15000, () => {
                upstreamReq.destroy(new Error("snapshot request timed out"));
            });
            upstreamReq.end();
        });
    }

    pipeSnapshotResponse(upstreamRes, res) {
        return new Promise((resolve, reject) => {
            res.statusCode = upstreamRes.statusCode || 200;

            const contentType = upstreamRes.headers["content-type"] || "image/jpeg";
            res.setHeader("Content-Type", contentType);

            const contentLength = upstreamRes.headers["content-length"];
            if (contentLength) {
                res.setHeader("Content-Length", contentLength);
            }
            this.setNoCacheHeaders(res);

            upstreamRes.on("error", reject);
            upstreamRes.on("end", resolve);
            upstreamRes.pipe(res);
        });
    }

    setNoCacheHeaders(res) {
        res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
        res.setHeader("Pragma", "no-cache");
        res.setHeader("Expires", "0");
    }

    buildDigestAuthorizationHeader(wwwAuthenticateHeader, credentials) {
        const digestChallenge = this.parseDigestChallenge(wwwAuthenticateHeader);
        if (!digestChallenge || !digestChallenge.realm || !digestChallenge.nonce) {
            return null;
        }

        const algorithm = (digestChallenge.algorithm || "MD5").toUpperCase();
        if (algorithm !== "MD5") {
            logger.warn(
                `Snapshot digest auth for ${this.camera.name} uses unsupported algorithm '${algorithm}'`
            );
            return null;
        }

        const uri = `${this.snapshotUrl.pathname}${this.snapshotUrl.search}`;
        const nc = "00000001";
        const cnonce = crypto.randomBytes(8).toString("hex");
        const qop = this.selectDigestQop(digestChallenge.qop);

        const ha1 = this.md5(
            `${credentials.username}:${digestChallenge.realm}:${credentials.password}`
        );
        const ha2 = this.md5(`GET:${uri}`);
        const response = qop
            ? this.md5(`${ha1}:${digestChallenge.nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
            : this.md5(`${ha1}:${digestChallenge.nonce}:${ha2}`);

        const parts = [
            `Digest username="${this.escapeDigestValue(credentials.username)}"`,
            `realm="${this.escapeDigestValue(digestChallenge.realm)}"`,
            `nonce="${this.escapeDigestValue(digestChallenge.nonce)}"`,
            `uri="${this.escapeDigestValue(uri)}"`,
            `response="${response}"`,
            `algorithm=${algorithm}`
        ];

        if (digestChallenge.opaque) {
            parts.push(`opaque="${this.escapeDigestValue(digestChallenge.opaque)}"`);
        }

        if (qop) {
            parts.push(`qop=${qop}`);
            parts.push(`nc=${nc}`);
            parts.push(`cnonce="${cnonce}"`);
        }

        return parts.join(", ");
    }

    parseDigestChallenge(headerValue) {
        if (!headerValue || typeof headerValue !== "string") {
            return null;
        }

        const match = headerValue.match(/^Digest\s+(.+)$/i);
        if (!match) {
            return null;
        }

        const challenge = {};
        const pattern = /([a-z0-9_-]+)=(?:"([^"]*)"|([^,\s]+))/gi;
        let pair;
        while ((pair = pattern.exec(match[1])) !== null) {
            challenge[pair[1].toLowerCase()] = pair[2] !== undefined ? pair[2] : pair[3];
        }

        return challenge;
    }

    selectDigestQop(qopValue) {
        if (!qopValue) {
            return null;
        }

        const qops = String(qopValue)
            .split(",")
            .map((value) => value.trim().toLowerCase())
            .filter(Boolean);

        if (qops.includes("auth")) {
            return "auth";
        }

        return qops[0] || null;
    }

    md5(value) {
        return crypto.createHash("md5").update(value, "utf8").digest("hex");
    }

    escapeDigestValue(value) {
        return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    }
}

module.exports = SnapshotService;
