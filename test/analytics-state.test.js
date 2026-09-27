const test=require("node:test");
const assert=require("node:assert/strict");
const {AnalyticsDispatcher}=require("../src/analytics-dispatcher");
const {EventBus}=require("../src/event-bus");
const {DEFAULT_TOPICS}=require("../src/event-topics");

function fixture(){const bus=new EventBus({topics:DEFAULT_TOPICS});const dispatcher=new AnalyticsDispatcher();dispatcher.registerTarget("Cam",{eventBus:bus,videoSourceConfigToken:"source"});return {bus,dispatcher};}

test("object analytics publish only aggregate boolean state transitions",()=>{
 const {bus,dispatcher}=fixture(); const sub=bus.createSubscription({ttlMs:60000});
 assert.ok(dispatcher.dispatch({source:"frigate",camera:"Cam",type:"person",active:true,objectId:"a"}));
 assert.equal(dispatcher.dispatch({source:"frigate",camera:"Cam",type:"person",active:true,objectId:"b"}),null);
 assert.equal(dispatcher.dispatch({source:"frigate",camera:"Cam",type:"person",active:false,objectId:"a"}),null);
 assert.ok(dispatcher.dispatch({source:"frigate",camera:"Cam",type:"person",active:false,objectId:"b"}));
 const messages=bus.pull(sub.id,10).messages;
 assert.deepEqual(messages.map(x=>x.data.State),[true,false]);
 assert.equal(bus.retained.size,1);
});

test("duplicate object updates do not spam PullPoint or retained state",()=>{
 const {bus,dispatcher}=fixture(); const sub=bus.createSubscription({ttlMs:60000});
 dispatcher.dispatch({source:"frigate",camera:"Cam",type:"vehicle",active:true,objectId:"v1"});
 dispatcher.dispatch({source:"frigate",camera:"Cam",type:"vehicle",active:true,objectId:"v1",confidence:.95});
 dispatcher.dispatch({source:"frigate",camera:"Cam",type:"vehicle",active:true,objectId:"v1",confidence:.97});
 assert.equal(bus.pull(sub.id,10).messages.length,1);
 assert.equal(bus.retained.size,1);
});

test("independent sources maintain independent aggregate state",()=>{
 const {bus,dispatcher}=fixture(); const sub=bus.createSubscription({ttlMs:60000});
 dispatcher.dispatch({source:"frigate",camera:"Cam",type:"person",active:true,objectId:"a"});
 dispatcher.dispatch({source:"nvr",camera:"Cam",type:"person",active:true,objectId:"b"});
 dispatcher.dispatch({source:"frigate",camera:"Cam",type:"person",active:false,objectId:"a"});
 const messages=bus.pull(sub.id,10).messages;
 assert.deepEqual(messages.map(x=>x.data.State),[true,true,false]);
});
