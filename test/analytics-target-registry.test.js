const test = require("node:test");
const assert = require("node:assert/strict");
const { AnalyticsDispatcher } = require("../src/analytics-dispatcher");
const { AnalyticsTargetRegistry } = require("../src/analytics-target-registry");
const { EventBus } = require("../src/event-bus");

function server(token) {
    return {
        eventBus: new EventBus(),
        mediaService: { videoSourceConfigTokenHq: token }
    };
}
function manager(name, currentServer) {
    return { cameraConfig: { name }, server: currentServer };
}

test("registry dispatches analytics to a live camera server", () => {
    const dispatcher = new AnalyticsDispatcher();
    const registry = new AnalyticsTargetRegistry(dispatcher);
    const mgr = manager("VCAM-01", server("source-1"));
    registry.registerManager(mgr);

    const event = dispatcher.dispatch({ source:"test", camera:"VCAM-01", type:"motion", active:true });
    assert.ok(event);
    assert.equal(event.source.VideoSourceConfigurationToken, "source-1");
    assert.equal(mgr.server.eventBus.retained.size, 1);
});

test("registry follows a replacement ONVIF server without re-registration", () => {
    const dispatcher = new AnalyticsDispatcher();
    const registry = new AnalyticsTargetRegistry(dispatcher);
    const first = server("source-old");
    const mgr = manager("VCAM-01", first);
    registry.registerManager(mgr);

    dispatcher.dispatch({ source:"test", camera:"VCAM-01", type:"motion", active:true });
    mgr.server = server("source-new");
    dispatcher.dispatch({ source:"test", camera:"VCAM-01", type:"motion", active:false });

    assert.equal(first.eventBus.retained.size, 1);
    assert.equal(mgr.server.eventBus.retained.size, 1);
    const retained = [...mgr.server.eventBus.retained.values()][0];
    assert.equal(retained.source.VideoSourceConfigurationToken, "source-new");
});

test("registry safely drops analytics while a camera server is unavailable", () => {
    const dispatcher = new AnalyticsDispatcher();
    const registry = new AnalyticsTargetRegistry(dispatcher);
    const mgr = manager("VCAM-01", server("source-1"));
    registry.registerManager(mgr);
    mgr.server = null;

    const event = dispatcher.dispatch({ source:"test", camera:"VCAM-01", type:"person", active:true });
    assert.equal(event, null);
});

test("unregister removes live target and contributor state", () => {
    const dispatcher = new AnalyticsDispatcher();
    const registry = new AnalyticsTargetRegistry(dispatcher);
    const mgr = manager("VCAM-01", server("source-1"));
    registry.registerManager(mgr);
    dispatcher.dispatch({ source:"test", camera:"VCAM-01", type:"motion", active:true });

    assert.equal(registry.unregisterManager(mgr), true);
    assert.equal(dispatcher.targets.has("VCAM-01"), false);
    assert.equal(dispatcher.activeContributors.size, 0);
});
