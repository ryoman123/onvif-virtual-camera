const EVENT_SERVICE_PATH = "/onvif/event_service";
const PULLPOINT_SERVICE_PATH = "/onvif/event_service/subscriptions";
const PULLPOINT_SERVICE_PATTERN = /^\\/onvif\\/event_service\\/subscriptions\\/[^/]+\\/?$/;

function pathnameFromUrl(value) {
    try {
        return new URL(value || "/", "http://localhost").pathname;
    } catch (_) {
        return "/";
    }
}

function subscriptionIdFromUrl(value) {
    const pathname = pathnameFromUrl(value);
    const match = pathname.match(
        /^\/onvif\/event_service\/subscriptions\/([^/]+)$/
    );

    if (!match) {
        return null;
    }

    try {
        return decodeURIComponent(match[1]);
    } catch (_) {
        return null;
    }
}

function rewritePullPointRequest(req) {
    const id = subscriptionIdFromUrl(req && req.url);
    if (!id) {
        return false;
    }

    req.onvifSubscriptionId = id;
    req.onvifOriginalUrl = req.url;
    req.url = PULLPOINT_SERVICE_PATH;

    return true;
}

function isEventServiceRequest(value) {
    const pathname = pathnameFromUrl(value);

    return pathname === EVENT_SERVICE_PATH
        || pathname === PULLPOINT_SERVICE_PATH
        || pathname.startsWith(PULLPOINT_SERVICE_PATH + "/");
}

module.exports = {
    EVENT_SERVICE_PATH,
    PULLPOINT_SERVICE_PATH,
    PULLPOINT_SERVICE_PATTERN,
    pathnameFromUrl,
    subscriptionIdFromUrl,
    rewritePullPointRequest,
    isEventServiceRequest
};
