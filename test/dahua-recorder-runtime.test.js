const test=require("node:test");
const assert=require("node:assert/strict");
const {AnalyticsDispatcher}=require("../src/analytics-dispatcher");
const {EventBus}=require("../src/event-bus");
const {DEFAULT_TOPICS,TOPICS}=require("../src/event-topics");
const {DahuaAnalyticsRouter,DahuaRecorderRuntime}=require("../src/dahua-recorder-runtime");

function fixture(){
 const bus=new EventBus({topics:DEFAULT_TOPICS}); const dispatcher=new AnalyticsDispatcher();
 dispatcher.registerTarget("VirtualCam6",{eventBus:bus,videoSourceConfigToken:"source-6"});
 const router=new DahuaAnalyticsRouter({source:"lorex",channelMap:{5:"VirtualCam6"}});
 return {bus,router,runtime:new DahuaRecorderRuntime({router,dispatcher})};
}
test("routes recorder channel analytics to the mapped ONVIF camera",()=>{
 const {bus,runtime}=fixture(); const sub=bus.createSubscription({ttlMs:60000});
 runtime.push("Code=SmartMotionHuman;action=Start;index=5\r\n");
 const pulled=bus.pull(sub.id,10); assert.equal(pulled.messages.length,1); assert.equal(pulled.messages[0].topic,TOPICS.PERSON);
 assert.equal(runtime.health().eventsDispatched,1); assert.equal(runtime.health().state,"connected");
});
test("contains unmapped recorder channels without cross-camera delivery",()=>{
 const {bus,runtime}=fixture(); const sub=bus.createSubscription({ttlMs:60000});
 runtime.push("Code=VideoMotion;action=Start;index=7\r\n");
 assert.equal(bus.pull(sub.id,10).messages.length,0); assert.equal(runtime.health().droppedEvents,1);
});
test("preserves recorder Start/Stop lifecycle as ONVIF boolean state",()=>{
 const {bus,runtime}=fixture(); const sub=bus.createSubscription({ttlMs:60000});
 runtime.push("Code=VideoMotion;action=Start;index=5\r\nCode=VideoMotion;action=Stop;index=5\r\n");
 const messages=bus.pull(sub.id,10).messages; assert.deepEqual(messages.map(x=>x.data.IsMotion),[true,false]);
 runtime.stop(); assert.equal(runtime.health().state,"stopped");
});
