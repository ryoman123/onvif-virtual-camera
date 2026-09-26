// src/onvif-server.js
const fs = require("fs");
const http = require("http");
const soap = require("soap");
const path = require("path");
const logger = require("./log-manager");
const DeviceService = require("./services/device-service");
const MediaService = require("./services/media-service");
const { EventService } = require("./services/event-service");
const { EventBus } = require("./event-bus");
const { DEFAULT_TOPICS } = require("./event-topics");
const {
    EVENT_SERVICE_PATH,
    PULLPOINT_SERVICE_PATH,
    rewritePullPointRequest,
    isEventServiceRequest
} = require("./event-routing");
const RtspProxyService = require("./services/rtsp-proxy-service");
const SnapshotService = require("./services/snapshot-service");
const { UsernameTokenAuthenticator } = require("./ws-security");
const { inlineTypesXsd } = require("./wsdl-loader");

class OnvifServer {
    constructor(camera, discoveryManager) {
        this.camera = camera;
        this.hasAuth = !!(this.camera.auth && this.camera.auth.username && this.camera.auth.password);
        this.lastSoapMethod = "unknown";
        this.httpServer = null;
        this.authAuditWarnings = new Map();

        const wsSecurity = (global.runtime && global.runtime.ws_security) || {};
        this.wsSecurityPolicy = {
            mode: wsSecurity.mode || "audit",
            maxAgeSeconds: wsSecurity.max_age_seconds ?? 300,
            futureSkewSeconds: wsSecurity.future_skew_seconds ?? 300,
            nonceCacheSize: wsSecurity.nonce_cache_size ?? 2048,
            allowPasswordText: wsSecurity.allow_password_text !== false
        };
        this.usernameTokenAuthenticator = this.hasAuth
            ? new UsernameTokenAuthenticator({
                username: this.camera.auth.username,
                password: this.camera.auth.password,
                ...this.wsSecurityPolicy
            })
            : null;

        this.discoveryManager = discoveryManager;
        this.deviceService = new DeviceService(camera);
        this.mediaService = new MediaService(camera);
        this.eventBus = new EventBus({
            topics: DEFAULT_TOPICS
        });
        this.eventService = new EventService(camera, this.eventBus, {
            videoSourceConfigToken: this.mediaService.videoSourceConfigTokenHq
        });
        this.rtspProxyService = new RtspProxyService(camera, (err) => this.failFatal(err));
        this.snapshotService = new SnapshotService(camera);
    }

    failFatal(err) {
        process.nextTick(() => {
            throw err;
        });
    }

    logLifecycleState() {
        const lifecycle = this.camera.lifecycle;
        logger.debug("lifecycle",
            `Camera lifecycle ready for ${this.camera.name}: ` +
            `http=${lifecycle.httpReady}, events=${lifecycle.eventReady}, ` +
            `snapshot=${lifecycle.snapshotReady}, rtsp=${lifecycle.rtspProxyReady}, ` +
            `discovery=${lifecycle.discoveryReady}`
        );
    }

    logAuthAuditWarning(issue, credentialMode) {
        const now = Date.now();
        const lastLogged = this.authAuditWarnings.get(issue) || 0;

        if (now - lastLogged < 300000) {
            return;
        }

        this.authAuditWarnings.set(issue, now);
        logger.warn(
            `SOAP auth policy audit for ${this.camera.name}: issue=${issue}, ` +
            `credentialMode=${credentialMode || "<unknown>"}, policy=${this.wsSecurityPolicy.mode}`
        );
    }

    authenticateRequest(security) {
        if (!this.hasAuth) {
            logger.debug("auth", `SOAP auth disabled for ${this.camera.name}`);
            return true;
        }

        const result = this.usernameTokenAuthenticator.authenticate(security);

        if (result.accepted && this.wsSecurityPolicy.mode === "audit") {
            for (const warning of result.warnings) {
                this.logAuthAuditWarning(warning, result.credentialMode);
            }
        }

        if (!result.accepted) {
            if (result.reason === "missing-security") {
                logger.warn(`SOAP auth missing security object for ${this.camera.name} (method=${this.lastSoapMethod})`);
            } else if (result.reason === "missing-username-token") {
                logger.warn(`SOAP auth missing UsernameToken for ${this.camera.name}`);
            } else if (["digest-missing-required-fields", "invalid-nonce"].includes(result.reason)) {
                logger.warn(`SOAP auth rejected for ${this.camera.name}: reason=${result.reason}`);
            } else if (this.wsSecurityPolicy.mode === "enforce" && result.warnings.length > 0) {
                logger.warn(
                    `SOAP auth policy rejected for ${this.camera.name}: reason=${result.reason}, ` +
                    `credentialMode=${result.credentialMode || "<unknown>"}`
                );
            } else {
                logger.debug(
                    "auth",
                    `SOAP auth rejected for ${this.camera.name}: reason=${result.reason}, ` +
                    `credentialMode=${result.credentialMode || "<unknown>"}`
                );
            }

            return false;
        }

        logger.debug(
            "auth",
            `SOAP auth accepted for ${this.camera.name}: ` +
            `credentialMode=${result.credentialMode || "<unknown>"}, auditWarnings=${result.warnings.length}`
        );

        return true;
    }

    async stop() {
        try {
            await this.discoveryManager.stopCamera(this.camera);
        } catch (err) {
            logger.warn(`Failed to stop WS-Discovery for ${this.camera.name}: ${err.message}`);
        }

        try {
            this.rtspProxyService.stop();
        } catch (err) {
            logger.warn(`Failed to stop RTSP proxy for ${this.camera.name}: ${err.message}`);
        }

        this.eventBus.releaseAllWaiters();

        this.camera.lifecycle.httpReady = false;
        this.camera.lifecycle.eventReady = false;
        this.camera.lifecycle.snapshotReady = false;

        if (!this.httpServer) {
            return;
        }

        await new Promise((resolve, reject) => {
            this.httpServer.close((err) => {
                if (err) {
                    reject(err);
                    return;
                }

                logger.info(`HTTP listener stopped for ${this.camera.name} on ${this.camera.ip}:${this.camera.onvifPort}`);
                resolve();
            });
        });

        this.httpServer = null;
    }

    async start() {
        return new Promise((resolve, reject) => {
            const server = http.createServer(async (req, res) => {
                if (this.snapshotService.canHandleRequest(req)) {
                    await this.snapshotService.handleRequest(req, res);
                    return;
                }

                if (req.url && (
                    req.url.startsWith("/onvif/device_service")
                    || req.url.startsWith("/onvif/media_service")
                    || isEventServiceRequest(req.url)
                )) {
                    return;
                }

                res.statusCode = 404;
                res.end("Not Found");
            });
            this.httpServer = server;

            server.on("clientError", (err, socket) => {
                logger.error(`HTTP clientError for ${this.camera.name}: ${err.message}`);
            });
            server.prependListener("request", (req, res) => {
                logger.debug(
                    "http",
                    `HTTP request for ${this.camera.name}: ${req.method} ${req.url} ` +
                    `from ${req.socket.remoteAddress}`
                );
            });

            const wsdlFolder = path.resolve(__dirname, 'wsdl');
            const typesXsdPath = path.join(wsdlFolder, 'types.xsd');
            const deviceWsdlPath = path.join(wsdlFolder, 'device_service.wsdl');
            const mediaWsdlPath = path.join(wsdlFolder, 'media_service.wsdl');
            const eventWsdlPath = path.join(wsdlFolder, 'event_service.wsdl');
            const typesXsdXml = fs.readFileSync(typesXsdPath, 'utf8');
            const deviceWsdlXml = inlineTypesXsd(fs.readFileSync(deviceWsdlPath, 'utf8'), typesXsdXml);
            const mediaWsdlXml = inlineTypesXsd(fs.readFileSync(mediaWsdlPath, 'utf8'), typesXsdXml);
            const eventWsdlXml = inlineTypesXsd(fs.readFileSync(eventWsdlPath, 'utf8'), typesXsdXml);

            const deviceServiceDef = {
                DeviceService: {
                    DevicePort: this.deviceService.GetServiceDefinition()
                }
            };

            const mediaServiceDef = {
                MediaService: {
                    MediaPort: this.mediaService.GetServiceDefinition()
                }
            };

            const eventServiceDef = {
                EventService: {
                    EventPort: this.eventService.GetEventServiceDefinition()
                }
            };

            const pullPointServiceDef = {
                EventService: {
                    PullPointSubscriptionPort: this.eventService.GetPullPointServiceDefinition()
                }
            };

            server.listen(this.camera.onvifPort, this.camera.ip, async () => {
                try {
                    logger.info(`HTTP listener ready for ${this.camera.name} on ${this.camera.ip}:${this.camera.onvifPort}`);
                    this.camera.lifecycle.httpReady = true;
                    this.camera.lifecycle.snapshotReady = true;

                    const deviceSoapServer = soap.listen(server, {
                        path: "/onvif/device_service",
                        services: deviceServiceDef,
                        xml: deviceWsdlXml,
                        forceSoap12Headers: true,
                        attributesKey: '$attributes',
                        wsdl_options: {
                            attributesKey: '$attributes'
                        }
                    });
                    const mediaSoapServer = soap.listen(server, {
                        path: "/onvif/media_service",
                        services: mediaServiceDef,
                        xml: mediaWsdlXml,
                        forceSoap12Headers: true,
                        attributesKey: '$attributes',
                        wsdl_options: {
                            attributesKey: '$attributes'
                        }
                    });
                    const eventSoapServer = soap.listen(server, {
                        path: EVENT_SERVICE_PATH,
                        services: eventServiceDef,
                        xml: eventWsdlXml,
                        forceSoap12Headers: true,
                        attributesKey: '$attributes',
                        wsdl_options: {
                            attributesKey: '$attributes'
                        }
                    });
                    const pullPointSoapServer = soap.listen(server, {
                        path: PULLPOINT_SERVICE_PATH,
                        services: pullPointServiceDef,
                        xml: eventWsdlXml,
                        forceSoap12Headers: true,
                        attributesKey: '$attributes',
                        wsdl_options: {
                            attributesKey: '$attributes'
                        }
                    });

                    // node-soap wraps the HTTP server request listeners when mounted.
                    // Install this after all SOAP listeners so dynamic PullPoint URLs are
                    // normalized before node-soap performs its path/WSDL-port dispatch.
                    server.prependListener("request", (req) => {
                        const originalUrl = req.url;
                        if (rewritePullPointRequest(req)) {
                            logger.debug(
                                "events",
                                `Routed PullPoint request for ${this.camera.name}: ` +
                                `${originalUrl} -> ${req.url} (subscription=${req.onvifSubscriptionId})`
                            );
                        }
                    });

                    deviceSoapServer.authenticate = (security) => this.authenticateRequest(security);
                    mediaSoapServer.authenticate = (security) => this.authenticateRequest(security);
                    eventSoapServer.authenticate = (security) => this.authenticateRequest(security);
                    pullPointSoapServer.authenticate = (security) => this.authenticateRequest(security);

                    deviceSoapServer.on("request", (xml, methodName) => {
                        this.lastSoapMethod = methodName;
                        logger.debug('device', `SOAP Device request received for ${this.camera.name}: ${methodName}`);
                    });
                    deviceSoapServer.on("error", (err) => {
                        logger.error(`SOAP Device error for ${this.camera.name}: ${err.message}`);
                    });
                    mediaSoapServer.on("request", (xml, methodName) => {
                        this.lastSoapMethod = methodName;
                        logger.debug('media', `SOAP Media request received for ${this.camera.name}: ${methodName}`);
                    });
                    mediaSoapServer.on("error", (err) => {
                        logger.error(`SOAP Media error for ${this.camera.name}: ${err.message}`);
                    });
                    eventSoapServer.on("request", (xml, methodName) => {
                        this.lastSoapMethod = methodName;
                        logger.debug("events", `SOAP Event request received for ${this.camera.name}: ${methodName}`);
                    });
                    eventSoapServer.on("error", (err) => {
                        logger.error(`SOAP Event error for ${this.camera.name}: ${err.message}`);
                    });
                    pullPointSoapServer.on("request", (xml, methodName) => {
                        this.lastSoapMethod = methodName;
                        logger.debug("events", `SOAP PullPoint request received for ${this.camera.name}: ${methodName}`);
                    });
                    pullPointSoapServer.on("error", (err) => {
                        logger.error(`SOAP PullPoint error for ${this.camera.name}: ${err.message}`);
                    });

                    this.camera.lifecycle.eventReady = true;

                    await this.discoveryManager.startCamera(this.camera, (err) => this.failFatal(err));
                    this.rtspProxyService.start();

                    this.logLifecycleState();
                    resolve();
                } catch (err) {
                    logger.error(`Failed to fully start camera ${this.camera.name}: ${err.message}`);

                    try {
                        await this.stop();
                    } catch (stopErr) {
                        logger.warn(`Failed to clean up partially started camera ${this.camera.name}: ${stopErr.message}`);
                    }

                    reject(err);
                }
            });

            server.on("error", (err) => {
                logger.error(`ONVIF server error for ${this.camera.name}: ${err.message}`);
                if (this.camera.lifecycle.httpReady) {
                    this.failFatal(err);
                    return;
                }
                reject(err);
            });
        });
    }
}

module.exports = OnvifServer;