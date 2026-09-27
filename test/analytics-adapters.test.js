const test = require("node:test");
const assert = require("node:assert/strict");
const { TOPICS } = require("../src/event-topics");
const { normalizeAnalyticsEvent, toOnvifEvent } = require("../src/analytics-event");
const { frigateEventToAnalytics } = require("../src/frigate-adapter");

test("normalizes analytics and maps person to ONVIF property event", () => {
    const normalized = normalizeAnalyticsEvent({ source:"frigate", camera:"vcam-1", type:"person", active:true, utcTime:"2026-09-27T03:00:00Z", confidence:0.91, objectId:"evt-1" });
    assert.equal(normalized.type, "person");
    const event = toOnvifEvent(normalized, { videoSourceConfigToken:"VideoSourceConfig_HQ" });
    assert.equal(event.topic, TOPICS.PERSON);
    assert.deepEqual(event.data, { State:true });
    assert.equal(event.source.VideoSourceConfigurationToken, "VideoSourceConfig_HQ");
});

test("maps Frigate tracked object lifecycle to active and inactive analytics", () => {
    const base={id:"abc",camera:"vcam-7",label:"car",frame_time:1790478000,top_score:0.88,current_zones:["driveway"],snapshot:{box:[1,2,3,4],score:0.82}};
    const start=frigateEventToAnalytics({type:"new",after:base});
    assert.equal(start.type,"vehicle"); assert.equal(start.active,true); assert.equal(start.objectId,"abc"); assert.equal(start.confidence,0.88); assert.deepEqual(start.zones,["driveway"]);
    const end=frigateEventToAnalytics({type:"end",after:{...base,end_time:1790478010}});
    assert.equal(end.active,false); assert.equal(end.utcTime,"2026-09-27T03:00:10.000Z");
});

test("ignores unsupported Frigate labels and message types", () => {
    assert.equal(frigateEventToAnalytics({type:"new",after:{camera:"vcam-1",label:"chair"}}),null);
    assert.equal(frigateEventToAnalytics({type:"snapshot",after:{camera:"vcam-1",label:"person"}}),null);
});

test("maps motion to canonical CellMotionDetector source", () => {
    const event=toOnvifEvent({source:"native",camera:"vcam-1",type:"motion",active:true,utcTime:"2026-09-27T03:00:00Z"});
    assert.equal(event.topic,TOPICS.MOTION); assert.equal(event.data.IsMotion,true);
    assert.equal(event.source.Rule,"MotionDetector"); assert.ok(event.source.VideoAnalyticsConfigurationToken);
});
