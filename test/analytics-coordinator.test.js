const test=require("node:test");
const assert=require("node:assert/strict");
const {AnalyticsCoordinator}=require("../src/analytics-coordinator");

function runtime(name,calls,fail=false){return {async start(){calls.push("start:"+name);if(fail)throw new Error("boom");},async stop(){calls.push("stop:"+name);},health(){return {state:"ok"};}};}
function manager(name){return {cameraConfig:{name},server:null};}

test("coordinator owns analytics runtime lifecycle and camera targets",async()=>{
 const calls=[];const c=new AnalyticsCoordinator();c.registerCameraManagers([manager("A"),manager("B")]);
 c.addRuntime("frigate",runtime("frigate",calls));c.addRuntime("recorder",runtime("recorder",calls));
 const h=await c.start();assert.equal(h.state,"running");assert.equal(h.targets,2);assert.deepEqual(calls,["start:frigate","start:recorder"]);
 const errors=await c.stop();assert.deepEqual(errors,[]);assert.deepEqual(calls,["start:frigate","start:recorder","stop:recorder","stop:frigate"]);assert.equal(c.health().targets,0);
});

test("coordinator rolls back already-started adapters when startup fails",async()=>{
 const calls=[];const c=new AnalyticsCoordinator();c.addRuntime("good",runtime("good",calls));c.addRuntime("bad",runtime("bad",calls,true));
 await assert.rejects(()=>c.start(),/boom/);assert.deepEqual(calls,["start:good","start:bad","stop:good"]);assert.equal(c.health().state,"stopped");
});

test("coordinator rejects duplicate runtime names",()=>{const c=new AnalyticsCoordinator();c.addRuntime("frigate",{});assert.throws(()=>c.addRuntime("frigate",{}),/duplicate/);});
