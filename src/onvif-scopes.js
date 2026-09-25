function escapeScope(value) {
    if (!value) {
        return "";
    }

    return encodeURIComponent(String(value));
}

function getDiscoveryScopeUris(camera) {
    const manufacturer = camera.identity?.manufacturer || "";
    const model = camera.identity?.model || "";
    const discoveryName = [manufacturer, model].filter(Boolean).join(" ") || camera.name;
    const location = (camera.host && camera.host.hostname) || "virtual";

    return [
        "onvif://www.onvif.org/type/video_encoder",
        "onvif://www.onvif.org/Profile/Streaming",
        `onvif://www.onvif.org/name/${escapeScope(discoveryName)}`,
        `onvif://www.onvif.org/hardware/${escapeScope(model)}`,
        `onvif://www.onvif.org/location/${escapeScope(location)}`
    ];
}

function getFixedScopeObjects(camera) {
    return getDiscoveryScopeUris(camera).map((scope) => ({
        ScopeDef: "Fixed",
        ScopeItem: scope
    }));
}

module.exports = {
    escapeScope,
    getDiscoveryScopeUris,
    getFixedScopeObjects
};
