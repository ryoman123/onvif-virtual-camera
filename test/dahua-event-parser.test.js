const test = require("node:test");
const assert = require("node:assert/strict");
const { parseDahuaEventLine, DahuaEventStreamParser } = require("../src/dahua-event-parser");

test("parses Dahua motion and smart-motion lifecycle events", () => {
    assert.deepEqual(parseDahuaEventLine("Code=VideoMotion;action=Start;index=5"), {source:"dahua",channel:5,type:"motion",active:true,action:"start",data:null});
    assert.equal(parseDahuaEventLine("Code=SmartMotionHuman;action=Stop;index=2").type, "person");
    assert.equal(parseDahuaEventLine("Code=SmartMotionVehicle;action=Start;index=3").type, "vehicle");
    const pulse = parseDahuaEventLine("Code=VideoMotion;action=Pulse;index=1");
    assert.equal(pulse.action, "pulse");
    assert.equal(pulse.active, true);
});

test("stream parser tolerates multipart boundaries and fragmented records", () => {
    const events=[]; const parser=new DahuaEventStreamParser((event)=>events.push(event));
    parser.push("--myboundary\r\nContent-Type: text/plain\r\n\r\nCode=SmartMotion");
    parser.push("Human;action=Start;index=7\r\n");
    assert.equal(events.length,1); assert.equal(events[0].channel,7); assert.equal(events[0].type,"person");
});

test("ignores unknown, malformed, and invalid-channel records", () => {
    assert.equal(parseDahuaEventLine("Code=VideoLoss;action=Start;index=0"),null);
    assert.equal(parseDahuaEventLine("Code=VideoMotion;action=Maybe;index=0"),null);
    assert.equal(parseDahuaEventLine("Code=VideoMotion;action=Start;index=nope"),null);
});
