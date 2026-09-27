const crypto = require("crypto");
const dgram = require("dgram");
const logger = require("./log-manager");
const { getDiscoveryScopeUris } = require("./onvif-scopes");
const { parseProbeConstraints, matchesProbe } = require("./discovery-matcher");

const MULTICAST_ADDRESS = "239.255.255.250";
const DISCOVERY_PORT = 3702;
const MAX_REPLY_JITTER_MS = 75;
const DUPLICATE_WINDOW_MS = 50;
const MAX_RECENT_PROBES = 50;
const HELLO_MAX_DELAY_MS = 500;
const DISCOVERY_TO = "urn:schemas-xmlsoap-org:ws:2005:04:discovery";

class DiscoveryManager {
    constructor() {
        this.entries = new Map();
        this.listenSocket = null;
        this.listeningReadyPromise = null;
        this.recentProbes = [];
        this.recentResolves = [];
        this.instanceId = Math.floor(Date.now() / 1000);
        this.messageNumber = 0;
    }

    async startCamera(camera, onFatalError) {
        const existingEntry = this.entries.get(camera.mac);
        if (existingEntry?.running) {
            return;
        }

        const entry = this.createEntry(camera, onFatalError);
        this.entries.set(camera.mac, entry);

        try {
            await this.bindEntry(entry);
        } catch (err) {
            this.entries.delete(camera.mac);
            throw err;
        }
    }

    async stopCamera(camera) {
        const entry = this.entries.get(camera.mac);
        if (!entry) {
            return;
        }

        await this.closeEntry(entry);
        this.entries.delete(camera.mac);
    }

    createEntry(camera, onFatalError) {
        return {
            camera,
            onFatalError,
            responseSocket: null,
            running: false,
            endpointAddress: this.buildEndpointAddress(camera),
            xaddr: this.buildXAddr(camera),
            helloTimer: null
        };
    }

    bindEntry(entry) {
        return new Promise((resolve, reject) => {
            let settled = false;
            const rejectStartup = (err) => {
                if (settled) {
                    return;
                }

                settled = true;

                try {
                    entry.responseSocket?.close();
                } catch (_) {
                    // Ignore cleanup errors during failed startup.
                }

                try {
                    this.listenSocket?.dropMembership(MULTICAST_ADDRESS, entry.camera.ip);
                } catch (_) {
                    // Ignore cleanup errors during failed startup.
                }

                entry.responseSocket = null;
                entry.running = false;
                entry.camera.lifecycle.discoveryReady = false;
                reject(err);
            };

            const resolveStartup = () => {
                if (settled) {
                    return;
                }

                settled = true;
                resolve();
            };

            entry.responseSocket = dgram.createSocket({ type: "udp4", reuseAddr: false });

            entry.responseSocket.on("error", (err) => {
                logger.error(`WS-Discovery response socket error for ${entry.camera.name} (${entry.camera.ip}): ${err.message}`);
                if (!entry.running) {
                    rejectStartup(err);
                    return;
                }
                entry.onFatalError?.(err);
            });

            entry.responseSocket.bind(0, entry.camera.ip, async () => {
                try {
                    await this.ensureListeningSocket();
                    this.listenSocket.addMembership(MULTICAST_ADDRESS, entry.camera.ip);
                } catch (err) {
                    logger.error(`Failed to join multicast group on ${entry.camera.ip} for ${entry.camera.name}: ${err.message}`);
                    rejectStartup(err);
                    return;
                }

                entry.running = true;
                entry.camera.lifecycle.discoveryReady = true;

                logger.debug("discovery", `WS-Discovery registered for ${entry.camera.name} on 0.0.0.0:${DISCOVERY_PORT} ` + `(reply source ${entry.camera.ip}, XAddr: ${entry.xaddr})`);

                this.scheduleHello(entry);
                resolveStartup();
            });
        });
    }

    closeEntry(entry) {
        return new Promise((resolve) => {
            if (!entry.running) {
                entry.camera.lifecycle.discoveryReady = false;
                resolve();
                return;
            }

            if (entry.helloTimer) {
                clearTimeout(entry.helloTimer);
                entry.helloTimer = null;
            }

            const finalizeStop = () => {
                logger.info(`WS-Discovery stopped for ${entry.camera.name} on ${entry.camera.ip}`);
                entry.running = false;
                entry.camera.lifecycle.discoveryReady = false;
                entry.responseSocket = null;
                resolve();
            };

            const closeSockets = () => {
                try {
                    this.listenSocket?.dropMembership(MULTICAST_ADDRESS, entry.camera.ip);
                } catch (err) {
                    logger.warn(`Failed to leave multicast group on ${entry.camera.ip} for ${entry.camera.name}: ${err.message}`);
                }

                if (!entry.responseSocket) {
                    this.closeListeningSocketIfIdle().finally(finalizeStop);
                    return;
                }

                entry.responseSocket.close(() => {
                    this.closeListeningSocketIfIdle().finally(finalizeStop);
                });
            };

            this.sendBye(entry).finally(closeSockets);
        });
    }
    ensureListeningSocket() {
        if (this.listenSocket) {
            return this.listeningReadyPromise || Promise.resolve();
        }

        const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
        this.listenSocket = socket;
        this.listeningReadyPromise = new Promise((resolve, reject) => {
            let settled = false;

            socket.on("error", (err) => {
                logger.error(`WS-Discovery shared socket error: ${err.message}`);
                if (!settled) {
                    settled = true;
                    this.listenSocket = null;
                    this.listeningReadyPromise = null;
                    reject(err);
                    return;
                }

                for (const entry of this.entries.values()) {
                    entry.onFatalError?.(err);
                }
            });

            socket.on("message", (msg, rinfo) => {
                try {
                    this.handleMessage(msg, rinfo);
                } catch (err) {
                    logger.error(`WS-Discovery message handling error from ${rinfo.address}:${rinfo.port}: ${err.message}`);
                }
            });

            socket.bind(DISCOVERY_PORT, "0.0.0.0", () => {
                settled = true;
                logger.debug("discovery", `WS-Discovery shared listener ready on 0.0.0.0:${DISCOVERY_PORT}`);
                resolve();
            });
        });

        return this.listeningReadyPromise;
    }

    closeListeningSocketIfIdle() {
        const hasOtherRunningEntries = Array.from(this.entries.values()).some((entry) => entry.running);
        if (hasOtherRunningEntries || !this.listenSocket) {
            return Promise.resolve();
        }

        const socket = this.listenSocket;
        this.listenSocket = null;
        this.listeningReadyPromise = null;

        return new Promise((resolve) => {
            socket.close(() => {
                logger.debug("discovery", `WS-Discovery shared listener stopped on 0.0.0.0:${DISCOVERY_PORT}`);
                resolve();
            });
        });
    }

    handleMessage(msg, rinfo) {
        const xml = msg.toString("utf8");
        const isProbe = this.hasDiscoveryElement(xml, "Probe");
        const isResolve = this.hasDiscoveryElement(xml, "Resolve");

        if (!isProbe && !isResolve) {
            return;
        }

        const activeEntries = Array.from(this.entries.values()).filter((entry) => entry.running);
        if (activeEntries.length === 0) {
            return;
        }

        const relatesTo = this.extractMessageId(xml);

        if (isResolve) {
            this.handleResolve(xml, relatesTo, rinfo, activeEntries);
            return;
        }

        if (this.isDuplicateProbe(relatesTo, xml, rinfo)) {
            logger.debug("discovery", `Skipping shared duplicate Probe from ${rinfo.address}:${rinfo.port} ` + `(messageId=${relatesTo || "<missing>"})`);
            return;
        }

        logger.debug("discovery", `WS-Discovery Probe received from ${rinfo.address}:${rinfo.port} ` + `(activeCameras=${activeEntries.length}, messageId=${relatesTo || "<missing>"})`);

        const constraints = parseProbeConstraints(xml);
        if (!constraints) {
            logger.debug("discovery", `Ignoring malformed WS-Discovery Probe from ${rinfo.address}:${rinfo.port}`);
            return;
        }

        const matchingEntries = activeEntries.filter((entry) =>
            matchesProbe(entry.camera, constraints, getDiscoveryScopeUris)
        );

        logger.debug("discovery",
            `WS-Discovery Probe constraints from ${rinfo.address}:${rinfo.port}: ` +
            `types=${constraints.types.length}, scopes=${constraints.scopes.length}, ` +
            `matchBy=${constraints.matchBy}, matches=${matchingEntries.length}`
        );

        for (const entry of matchingEntries) {
            const replyDelayMs = this.getReplyDelayMs(matchingEntries.length);
            logger.debug("discovery",
                `Scheduling ProbeMatches for ${entry.camera.name} to ${rinfo.address}:${rinfo.port} ` +
                `(delay=${replyDelayMs}ms, endpoint=${entry.endpointAddress}, xaddr=${entry.xaddr}, mac=${entry.camera.mac}, ip=${entry.camera.ip})`
            );

            setTimeout(() => {
                if (!entry.running) {
                    return;
                }

                this.sendProbeMatch(entry, relatesTo, rinfo);
            }, replyDelayMs);
        }
    }

    handleResolve(xml, relatesTo, rinfo, activeEntries) {
        const endpointAddress = this.extractResolveAddress(xml);
        if (!endpointAddress) {
            logger.debug("discovery", `Ignoring WS-Discovery Resolve from ${rinfo.address}:${rinfo.port} with no endpoint address`);
            return;
        }

        if (this.isDuplicateResolve(relatesTo, xml, rinfo)) {
            logger.debug("discovery", `Skipping shared duplicate Resolve from ${rinfo.address}:${rinfo.port} ` + `(messageId=${relatesTo || "<missing>"}, endpoint=${endpointAddress})`);
            return;
        }

        const entry = activeEntries.find((candidate) =>
            candidate.endpointAddress.toLowerCase() === endpointAddress.toLowerCase()
        );

        if (!entry) {
            logger.debug("discovery", `Ignoring WS-Discovery Resolve for unknown endpoint ${endpointAddress} ` + `from ${rinfo.address}:${rinfo.port}`);
            return;
        }

        logger.debug("discovery", `WS-Discovery Resolve matched ${entry.camera.name} from ${rinfo.address}:${rinfo.port} ` + `(messageId=${relatesTo || "<missing>"}, endpoint=${endpointAddress})`);

        this.sendResolveMatch(entry, relatesTo, rinfo);
    }
    sendProbeMatch(entry, relatesTo, rinfo) {
        const responseXml = this.buildProbeMatchesResponse(entry, relatesTo);
        const buf = Buffer.from(responseXml, "utf8");

        if (!entry.responseSocket) {
            logger.warn(`Skipping ProbeMatches for ${entry.camera.name}; response socket is not available`);
            return;
        }

        entry.responseSocket.send(buf, 0, buf.length, rinfo.port, rinfo.address, (err) => {
            if (err) {
                logger.error(`Failed to send ProbeMatches for ${entry.camera.name} to ${rinfo.address}:${rinfo.port} - ${err.message}`);
            } else {
                logger.debug("discovery",
                    `ProbeMatches sent for ${entry.camera.name} to ${rinfo.address}:${rinfo.port} ` +
                    `(endpoint=${entry.endpointAddress}, xaddr=${entry.xaddr}, mac=${entry.camera.mac}, ip=${entry.camera.ip})`
                );
            }
        });
    }

    sendResolveMatch(entry, relatesTo, rinfo) {
        const responseXml = this.buildResolveMatchesResponse(entry, relatesTo);
        const buf = Buffer.from(responseXml, "utf8");

        if (!entry.responseSocket) {
            logger.warn(`Skipping ResolveMatches for ${entry.camera.name}; response socket is not available`);
            return;
        }

        entry.responseSocket.send(buf, 0, buf.length, rinfo.port, rinfo.address, (err) => {
            if (err) {
                logger.error(`Failed to send ResolveMatches for ${entry.camera.name} to ${rinfo.address}:${rinfo.port} - ${err.message}`);
            } else {
                logger.debug("discovery",
                    `ResolveMatches sent for ${entry.camera.name} to ${rinfo.address}:${rinfo.port} ` +
                    `(endpoint=${entry.endpointAddress}, xaddr=${entry.xaddr}, mac=${entry.camera.mac}, ip=${entry.camera.ip})`
                );
            }
        });
    }
    getHelloDelayMs() {
        return Math.floor(Math.random() * (HELLO_MAX_DELAY_MS + 1));
    }

    scheduleHello(entry) {
        const delayMs = this.getHelloDelayMs();

        if (entry.helloTimer) {
            clearTimeout(entry.helloTimer);
        }

        entry.helloTimer = setTimeout(() => {
            entry.helloTimer = null;

            if (!entry.running) {
                return;
            }

            this.sendHello(entry);
        }, delayMs);

        logger.debug("discovery", `Scheduled Hello for ${entry.camera.name} in ${delayMs}ms`);
    }

    sendHello(entry) {
        return this.sendAnnouncement(entry, this.buildHelloMessage(entry), "Hello");
    }

    sendBye(entry) {
        return this.sendAnnouncement(entry, this.buildByeMessage(entry), "Bye");
    }

    sendAnnouncement(entry, xml, kind) {
        return new Promise((resolve) => {
            if (!entry.responseSocket) {
                logger.warn(`Skipping ${kind} for ${entry.camera.name}; response socket is not available`);
                resolve(false);
                return;
            }

            const buf = Buffer.from(xml, "utf8");
            entry.responseSocket.send(buf, 0, buf.length, DISCOVERY_PORT, MULTICAST_ADDRESS, (err) => {
                if (err) {
                    logger.warn(`Failed to send ${kind} for ${entry.camera.name}: ${err.message}`);
                    resolve(false);
                    return;
                }

                logger.debug("discovery", `${kind} sent for ${entry.camera.name} from ${entry.camera.ip}`);
                resolve(true);
            });
        });
    }
    getReplyDelayMs(activeCameraCount) {
        if (activeCameraCount <= 1) {
            return 0;
        }

        return Math.floor(Math.random() * MAX_REPLY_JITTER_MS);
    }

    isDuplicateProbe(messageId, xml, rinfo) {
        const now = Date.now();
        const fallbackId = crypto.createHash("sha1").update(xml, "utf8").digest("hex");
        const key = `${rinfo.address}|${rinfo.port}|${messageId || fallbackId}`;

        this.recentProbes = this.recentProbes
            .filter((probe) => now - probe.seenAt <= DUPLICATE_WINDOW_MS)
            .slice(-(MAX_RECENT_PROBES - 1));

        if (this.recentProbes.some((probe) => probe.key === key)) {
            return true;
        }

        this.recentProbes.push({ key, seenAt: now });
        return false;
    }

    isDuplicateResolve(messageId, xml, rinfo) {
        const now = Date.now();
        const fallbackId = crypto.createHash("sha1").update(xml, "utf8").digest("hex");
        const key = `${rinfo.address}|${rinfo.port}|${messageId || fallbackId}`;

        this.recentResolves = this.recentResolves
            .filter((resolve) => now - resolve.seenAt <= DUPLICATE_WINDOW_MS)
            .slice(-(MAX_RECENT_PROBES - 1));

        if (this.recentResolves.some((resolve) => resolve.key === key)) {
            return true;
        }

        this.recentResolves.push({ key, seenAt: now });
        return false;
    }

    getDiscoveryScopes(camera) {
        return getDiscoveryScopeUris(camera).join("\n          ");
    }

    buildEndpointAddress(camera) {
        const macClean = camera.mac.toLowerCase().replace(/[^0-9a-f]/g, "");
        const padded = (macClean + "00000000000000000000000000000000").slice(0, 32);
        const uuid = [
            padded.slice(0, 8),
            padded.slice(8, 12),
            padded.slice(12, 16),
            padded.slice(16, 20),
            padded.slice(20, 32)
        ].join("-");
        return `urn:uuid:${uuid}`;
    }

    buildXAddr(camera) {
        return camera.endpoints.deviceServiceUrl;
    }

    buildProbeMatchesResponse(entry, relatesTo) {
        const appSequence = this.nextAppSequence();

        return `
<SOAP-ENV:Envelope
    xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope"
    xmlns:wsa="http://schemas.xmlsoap.org/ws/2004/08/addressing"
    xmlns:wsd="http://schemas.xmlsoap.org/ws/2005/04/discovery"
    xmlns:tds="http://www.onvif.org/ver10/device/wsdl"
    xmlns:dn="http://www.onvif.org/ver10/network/wsdl">
  <SOAP-ENV:Header>
    <wsa:MessageID>${this.generateMessageId()}</wsa:MessageID>
    ${relatesTo ? `<wsa:RelatesTo>${relatesTo}</wsa:RelatesTo>` : ""}
    <wsa:To SOAP-ENV:mustUnderstand="true">
      http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous
    </wsa:To>
    <wsa:Action SOAP-ENV:mustUnderstand="true">
      http://schemas.xmlsoap.org/ws/2005/04/discovery/ProbeMatches
    </wsa:Action>
    <wsd:AppSequence SOAP-ENV:mustUnderstand="true" InstanceId="${appSequence.instanceId}" MessageNumber="${appSequence.messageNumber}" />
  </SOAP-ENV:Header>
  <SOAP-ENV:Body>
    <wsd:ProbeMatches>
      <wsd:ProbeMatch>
        <wsa:EndpointReference>
          <wsa:Address>${entry.endpointAddress}</wsa:Address>
        </wsa:EndpointReference>
        <wsd:Types>tds:Device dn:NetworkVideoTransmitter</wsd:Types>
        <wsd:Scopes>
          ${this.getDiscoveryScopes(entry.camera)}
        </wsd:Scopes>
        <wsd:XAddrs>${entry.xaddr}</wsd:XAddrs>
        <wsd:MetadataVersion>1</wsd:MetadataVersion>
      </wsd:ProbeMatch>
    </wsd:ProbeMatches>
  </SOAP-ENV:Body>
</SOAP-ENV:Envelope>`.trim();
    }

    buildResolveMatchesResponse(entry, relatesTo) {
        const appSequence = this.nextAppSequence();

        return `
<SOAP-ENV:Envelope
    xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope"
    xmlns:wsa="http://schemas.xmlsoap.org/ws/2004/08/addressing"
    xmlns:wsd="http://schemas.xmlsoap.org/ws/2005/04/discovery"
    xmlns:tds="http://www.onvif.org/ver10/device/wsdl"
    xmlns:dn="http://www.onvif.org/ver10/network/wsdl">
  <SOAP-ENV:Header>
    <wsa:MessageID>${this.generateMessageId()}</wsa:MessageID>
    ${relatesTo ? `<wsa:RelatesTo>${relatesTo}</wsa:RelatesTo>` : ""}
    <wsa:To SOAP-ENV:mustUnderstand="true">
      http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous
    </wsa:To>
    <wsa:Action SOAP-ENV:mustUnderstand="true">
      http://schemas.xmlsoap.org/ws/2005/04/discovery/ResolveMatches
    </wsa:Action>
    <wsd:AppSequence SOAP-ENV:mustUnderstand="true" InstanceId="${appSequence.instanceId}" MessageNumber="${appSequence.messageNumber}" />
  </SOAP-ENV:Header>
  <SOAP-ENV:Body>
    <wsd:ResolveMatches>
      <wsd:ResolveMatch>
        <wsa:EndpointReference>
          <wsa:Address>${entry.endpointAddress}</wsa:Address>
        </wsa:EndpointReference>
        <wsd:Types>tds:Device dn:NetworkVideoTransmitter</wsd:Types>
        <wsd:Scopes>
          ${this.getDiscoveryScopes(entry.camera)}
        </wsd:Scopes>
        <wsd:XAddrs>${entry.xaddr}</wsd:XAddrs>
        <wsd:MetadataVersion>1</wsd:MetadataVersion>
      </wsd:ResolveMatch>
    </wsd:ResolveMatches>
  </SOAP-ENV:Body>
</SOAP-ENV:Envelope>`.trim();
    }
    buildHelloMessage(entry) {
        const appSequence = this.nextAppSequence();

        return `
<SOAP-ENV:Envelope
    xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope"
    xmlns:wsa="http://schemas.xmlsoap.org/ws/2004/08/addressing"
    xmlns:wsd="http://schemas.xmlsoap.org/ws/2005/04/discovery"
    xmlns:tds="http://www.onvif.org/ver10/device/wsdl"
    xmlns:dn="http://www.onvif.org/ver10/network/wsdl">
  <SOAP-ENV:Header>
    <wsa:Action SOAP-ENV:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2005/04/discovery/Hello</wsa:Action>
    <wsa:MessageID>${this.generateMessageId()}</wsa:MessageID>
    <wsa:To SOAP-ENV:mustUnderstand="true">${DISCOVERY_TO}</wsa:To>
    <wsd:AppSequence SOAP-ENV:mustUnderstand="true" InstanceId="${appSequence.instanceId}" MessageNumber="${appSequence.messageNumber}" />
  </SOAP-ENV:Header>
  <SOAP-ENV:Body>
    <wsd:Hello>
      <wsa:EndpointReference>
        <wsa:Address>${entry.endpointAddress}</wsa:Address>
      </wsa:EndpointReference>
      <wsd:Types>tds:Device dn:NetworkVideoTransmitter</wsd:Types>
      <wsd:Scopes>
        ${this.getDiscoveryScopes(entry.camera)}
      </wsd:Scopes>
      <wsd:XAddrs>${entry.xaddr}</wsd:XAddrs>
      <wsd:MetadataVersion>1</wsd:MetadataVersion>
    </wsd:Hello>
  </SOAP-ENV:Body>
</SOAP-ENV:Envelope>`.trim();
    }

    buildByeMessage(entry) {
        const appSequence = this.nextAppSequence();

        return `
<SOAP-ENV:Envelope
    xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope"
    xmlns:wsa="http://schemas.xmlsoap.org/ws/2004/08/addressing"
    xmlns:wsd="http://schemas.xmlsoap.org/ws/2005/04/discovery">
  <SOAP-ENV:Header>
    <wsa:Action SOAP-ENV:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2005/04/discovery/Bye</wsa:Action>
    <wsa:MessageID>${this.generateMessageId()}</wsa:MessageID>
    <wsa:To SOAP-ENV:mustUnderstand="true">${DISCOVERY_TO}</wsa:To>
    <wsd:AppSequence SOAP-ENV:mustUnderstand="true" InstanceId="${appSequence.instanceId}" MessageNumber="${appSequence.messageNumber}" />
  </SOAP-ENV:Header>
  <SOAP-ENV:Body>
    <wsd:Bye>
      <wsa:EndpointReference>
        <wsa:Address>${entry.endpointAddress}</wsa:Address>
      </wsa:EndpointReference>
    </wsd:Bye>
  </SOAP-ENV:Body>
</SOAP-ENV:Envelope>`.trim();
    }
    generateMessageId() {
        return `urn:uuid:${crypto.randomUUID()}`;
    }

    nextAppSequence() {
        this.messageNumber += 1;

        return {
            instanceId: this.instanceId,
            messageNumber: this.messageNumber
        };
    }

    hasDiscoveryElement(xml, localName) {
        const pattern = new RegExp(`<(?:(?:[A-Za-z_][\\w.-]*):)?${localName}(?:\\s|>)`, "i");
        return pattern.test(xml);
    }

    extractResolveAddress(xml) {
        const resolveMatch = xml.match(/<(?:[A-Za-z_][\w.-]*:)?Resolve\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?Resolve>/i);
        if (!resolveMatch) {
            return null;
        }

        const addressMatch = resolveMatch[1].match(/<(?:[A-Za-z_][\w.-]*:)?Address\b[^>]*>([^<]+)<\/(?:[A-Za-z_][\w.-]*:)?Address>/i);
        return addressMatch ? addressMatch[1].trim() : null;
    }
    extractMessageId(xml) {
        const match = xml.match(/<[^:>]*:?MessageID[^>]*>([^<]+)<\/[^:>]*:?MessageID>/i);
        return match ? match[1].trim() : null;
    }

}

module.exports = DiscoveryManager;