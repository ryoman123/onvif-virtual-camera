const test = require("node:test");
const assert = require("node:assert/strict");
const { FrigateMqttRouter } = require("../src/frigate-mqtt-router");
test("Frigate MQTT router exposes required subscriptions",()=>{const r=new FrigateMqttRouter();assert.deepEqual(r.topics(),["frigate/available","frigate/events","frigate/+/motion"]);});
test("routes Frigate object events through explicit camera mapping",()=>{const r=new FrigateMqttRouter({cameraMap:{front:"VirtualCam1"}});const o=r.route("frigate/events",JSON.stringify({type:"new",after:{id:"e1",camera:"front",label:"person",frame_time:1790478000,top_score:.9}}));assert.equal(o.length,1);assert.equal(o[0].camera,"VirtualCam1");assert.equal(o[0].type,"person");});
test("routes true Frigate motion ON/OFF independently from objects",()=>{const r=new FrigateMqttRouter({cameraMap:{front:"VirtualCam1"}});assert.equal(r.route("frigate/front/motion","ON")[0].active,true);assert.equal(r.route("frigate/front/motion","OFF")[0].active,false);});
test("tracks availability and drops unmapped cameras safely",()=>{const r=new FrigateMqttRouter({cameraMap:{front:"VirtualCam1"}});r.route("frigate/available","online");assert.equal(r.available,"online");assert.deepEqual(r.route("frigate/events",JSON.stringify({type:"new",after:{id:"e1",camera:"unknown",label:"person",frame_time:1790478000}})),[]);});

test("object motion mode emits person activity as ONVIF motion and ignores raw motion",()=>{
 const r=new FrigateMqttRouter({cameraMap:{front:"VirtualCam1"},motionMode:"objects",motionLabels:["person"]});
 assert.deepEqual(r.topics(),["frigate/available","frigate/events"]);
 assert.deepEqual(r.route("frigate/front/motion","ON"),[]);
 const make=(type,label,id)=>r.route("frigate/events",JSON.stringify({type,after:{id,camera:"front",label,frame_time:1790478000}}));
 assert.deepEqual(make("new","person","one").map(x=>x.type),["person","motion"]);
 assert.deepEqual(make("new","car","two").map(x=>x.type),["vehicle"]);
 assert.deepEqual(make("end","person","one").map(x=>x.active),[false,false]);
});
