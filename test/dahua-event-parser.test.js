const test = require("node:test");
const assert = require("node:assert/strict");
const { parseDahuaEventLine, DahuaEventStreamParser } = require("../src/dahua-event-parser");

test("parses Dahua motion and smart-motion lifecycle events", () => {
    assert.deepEqual(parseDahuaEventLine("Code=VideoMotion;action=Start;index=5"), {source:"dahua",channel:5,type:"motion",active:true,action:"start",data:null});
    assert.equal(parseDahuaEventLine("Code=SmartMotionHuman;action=Stop;index=2").type, "person");
    assert.equal(parseDahuaEventLine("Code=SmartMotionVehicle;action=Start;index=3").type, "vehicle");
});

test("normalizes native Dahua/Lorex IVS object classifications", () => {
    const human = parseDahuaEventLine('Code=CrossLineDetection;action=Start;index=4;data={"Object":{"ObjectType":"Human"}}');
    assert.equal(human.type, "person");
    assert.equal(human.channel, 4);
    const vehicle = parseDahuaEventLine('Code=CrossRegionDetection;action=Start;index=6;data={"Object":{"ObjectType":"Vehicle"}}');
    assert.equal(vehicle.type, "vehicle");
    const animal = parseDahuaEventLine('Code=CrossLineDetection;action=Start;index=7;data={"ObjectType":"Animal"}');
    assert.equal(animal.type, "animal");
});

test("keeps recognized IVS alarms useful when recorder omits object classification", () => {
    const event = parseDahuaEventLine("Code=CrossLineDetection;action=Pulse;index=1");
    assert.equal(event.type, "motion");
    assert.equal(event.active, true);
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
