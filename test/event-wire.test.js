const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const soap = require("soap");

const { EventBus } = require("../src/event-bus");
const { DEFAULT_TOPICS, TOPICS } = require("../src/event-topics");
const { EventService } = require("../src/services/event-service");
const { inlineTypesXsd } = require("../src/wsdl-loader");
const {
    EVENT_SERVICE_PATH,
    PULLPOINT_SERVICE_PATH,
    rewritePullPointRequest,
    isEventServiceRequest
} = require("../src/event-routing");

global.runtime = { enable_debug_logs: false };

function soapPost(port, requestPath, action, body) {
    return fetch(`http://127.0.0.1:${port}${requestPath}`, {
        method: "POST",
        headers: {
            "content-type":
                `application/soap+xml; charset=utf-8; action="${action}"`
        },
        body,
        signal: AbortSignal.timeout(3000)
    });
}

function envelope(body) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<env:Envelope
    xmlns:env="http://www.w3.org/2003/05/soap-envelope"
    xmlns:tev="http://www.onvif.org/ver10/events/wsdl"
    xmlns:wsnt="http://docs.oasis-open.org/wsn/b-2">
  <env:Body>
    ${body}
  </env:Body>
</env:Envelope>`;
}

async function startEventServer() {
    const wsdlDir = path.resolve(__dirname, "../src/wsdl");
    const wsdl = inlineTypesXsd(
        fs.readFileSync(path.join(wsdlDir, "event_service.wsdl"), "utf8"),
        fs.readFileSync(path.join(wsdlDir, "types.xsd"), "utf8")
    );

    const bus = new EventBus({
        topics: DEFAULT_TOPICS
    });
    const camera = {
        name: "Camera-Test",
        endpoints: {
            eventServiceUrl: "http://127.0.0.1/onvif/event_service"
        }
    };
    const eventService = new EventService(camera, bus, {
        videoSourceConfigToken: "video_source_config_hq_test"
    });

    const server = http.createServer((req, res) => {
        if (isEventServiceRequest(req.url)) {
            return;
        }

        res.statusCode = 404;
        res.end("Not Found");
    });

    server.prependListener("request", (req) => {
        rewritePullPointRequest(req);
    });

    const eventReady = new Promise((resolve, reject) => {
        soap.listen(server, {
            path: EVENT_SERVICE_PATH,
            services: {
                EventService: {
                    EventPort: eventService.GetEventServiceDefinition()
                }
            },
            xml: wsdl,
            forceSoap12Headers: true,
            attributesKey: "$attributes",
            wsdl_options: {
                attributesKey: "$attributes"
            },
            callback(err) {
                if (err) {
                    reject(err);
                    return;
                }
                resolve();
            }
        });
    });

    const pullReady = new Promise((resolve, reject) => {
        soap.listen(server, {
            path: PULLPOINT_SERVICE_PATH,
            services: {
                EventService: {
                    PullPointSubscriptionPort:
                        eventService.GetPullPointServiceDefinition()
                }
            },
            xml: wsdl,
            forceSoap12Headers: true,
            attributesKey: "$attributes",
            wsdl_options: {
                attributesKey: "$attributes"
            },
            callback(err) {
                if (err) {
                    reject(err);
                    return;
                }
                resolve();
            }
        });
    });

    await new Promise((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
    });
    await Promise.all([eventReady, pullReady]);

    return {
        server,
        bus,
        port: server.address().port
    };
}

async function closeServer(server) {
    if (typeof server.closeAllConnections === "function") {
        server.closeAllConnections();
    }

    await Promise.race([
        new Promise((resolve) => server.close(resolve)),
        new Promise((_, reject) => {
            setTimeout(
                () => reject(new Error("event test server did not close")),
                3000
            );
        })
    ]);
}

test("Event SOAP wire supports CreatePullPointSubscription then dynamic PullMessages", async () => {
    const { server, bus, port } = await startEventServer();

    try {
        const createResponse = await soapPost(
            port,
            EVENT_SERVICE_PATH,
            "http://www.onvif.org/ver10/events/wsdl/EventPortType/CreatePullPointSubscriptionRequest",
            envelope(
                "<tev:CreatePullPointSubscription>" +
                "<tev:InitialTerminationTime>PT5M</tev:InitialTerminationTime>" +
                "</tev:CreatePullPointSubscription>"
            )
        );
        const createBody = await createResponse.text();

        assert.equal(createResponse.status, 200);
        assert.match(createBody, /CreatePullPointSubscriptionResponse/);

        const addressMatch = createBody.match(
            /https?:\/\/[^<]+(\/onvif\/event_service\/subscriptions\/[^<]+)/
        );
        assert.ok(addressMatch, createBody);

        const dynamicPath = addressMatch[1];

        bus.publish({
            topic: TOPICS.PERSON,
            utcTime: "2026-09-26T20:00:00.000Z",
            data: {
                State: true
            }
        });

        const pullResponse = await soapPost(
            port,
            dynamicPath,
            "http://www.onvif.org/ver10/events/wsdl/PullPointSubscription/PullMessagesRequest",
            envelope(
                "<tev:PullMessages>" +
                "<tev:Timeout>PT0S</tev:Timeout>" +
                "<tev:MessageLimit>10</tev:MessageLimit>" +
                "</tev:PullMessages>"
            )
        );
        const pullBody = await pullResponse.text();

        assert.equal(pullResponse.status, 200);
        assert.match(pullBody, /PullMessagesResponse/);
        assert.match(
            pullBody,
            /tns1:UserAlarm\/IVA\/HumanShapeDetect/
        );
        assert.match(
            pullBody,
            /VideoSourceConfigurationToken/
        );
        assert.match(
            pullBody,
            /video_source_config_hq_test/
        );
        assert.match(pullBody, /Name="State"/);
        assert.match(pullBody, /Value="true"/);
    } finally {
        bus.releaseAllWaiters();
        await closeServer(server);
    }
});

test("Event SOAP wire exposes service capabilities and topic properties", async () => {
    const { server, bus, port } = await startEventServer();

    try {
        const capsResponse = await soapPost(
            port,
            EVENT_SERVICE_PATH,
            "http://www.onvif.org/ver10/events/wsdl/EventPortType/GetServiceCapabilitiesRequest",
            envelope("<tev:GetServiceCapabilities/>")
        );
        const capsBody = await capsResponse.text();

        assert.equal(capsResponse.status, 200);
        assert.match(capsBody, /GetServiceCapabilitiesResponse/);
        assert.match(capsBody, /MaxPullPoints="32"/);
        assert.match(capsBody, /PersistentNotificationStorage="false"/);

        const propsResponse = await soapPost(
            port,
            EVENT_SERVICE_PATH,
            "http://www.onvif.org/ver10/events/wsdl/EventPortType/GetEventPropertiesRequest",
            envelope("<tev:GetEventProperties/>")
        );
        const propsBody = await propsResponse.text();

        assert.equal(propsResponse.status, 200);
        assert.match(propsBody, /GetEventPropertiesResponse/);
        assert.match(propsBody, /CellMotionDetector/);
        assert.match(propsBody, /HumanShapeDetect/);
        assert.match(propsBody, /VehicleDetect/);
    } finally {
        bus.releaseAllWaiters();
        await closeServer(server);
    }
});
