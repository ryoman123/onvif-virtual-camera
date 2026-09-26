const test = require("node:test");
const assert = require("node:assert/strict");

const {
    EVENT_SERVICE_PATH,
    PULLPOINT_SERVICE_PATH,
    subscriptionIdFromUrl,
    rewritePullPointRequest,
    isEventServiceRequest
} = require("../src/event-routing");

test("dynamic PullPoint URL extracts and decodes the subscription id", () => {
    assert.equal(
        subscriptionIdFromUrl(
            "/onvif/event_service/subscriptions/sub%20123?ignored=yes"
        ),
        "sub 123"
    );
});

test("dynamic PullPoint request rewrites to the fixed SOAP listener path", () => {
    const req = {
        url: "/onvif/event_service/subscriptions/abc-123?ignored=yes"
    };

    assert.equal(rewritePullPointRequest(req), true);
    assert.equal(req.onvifSubscriptionId, "abc-123");
    assert.equal(
        req.onvifOriginalUrl,
        "/onvif/event_service/subscriptions/abc-123?ignored=yes"
    );
    assert.equal(req.url, PULLPOINT_SERVICE_PATH);
});

test("non-subscription requests are not rewritten", () => {
    const req = { url: EVENT_SERVICE_PATH };

    assert.equal(rewritePullPointRequest(req), false);
    assert.equal(req.url, EVENT_SERVICE_PATH);
    assert.equal(req.onvifSubscriptionId, undefined);
});

test("event request classifier includes base, fixed and dynamic Event paths", () => {
    assert.equal(isEventServiceRequest(EVENT_SERVICE_PATH), true);
    assert.equal(isEventServiceRequest(PULLPOINT_SERVICE_PATH), true);
    assert.equal(
        isEventServiceRequest(
            "/onvif/event_service/subscriptions/abc-123"
        ),
        true
    );
    assert.equal(isEventServiceRequest("/onvif/media_service"), false);
});
