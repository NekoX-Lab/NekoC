import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {ReproRecorder,reproInput,REPRO_DT,MAX_REPRO_FRAMES} from '../web/repro.js';
import {StageInput} from '../web/input.js';
import {PlayerConnection} from '../web/player.js';
import {ExtensionRegistry} from '../web/extensions.js';

const hash='a'.repeat(64);
const metadata={runner:{name:'nekoc',version:'test',protocol:2},work_sha256:hash,seed:'1',dt:REPRO_DT};
const status=frame_count=>({state_sha256:hash,frame_count,budget_yields:0});
const flush=()=>new Promise(resolve=>setImmediate(resolve));

test('r2-repro: field allowlist excludes account, project, answers and host metadata',()=>{
  const recorder=new ReproRecorder({...metadata,project:{token:'secret'},user:'secret'},status(0));
  const payload={pressed:['65'],mouse:{x:2,y:3,token:'secret'},project:'secret',account:'secret',
    costumes:[{url:'secret'}],utc_offset:480,kn_microphone:{value:4},events:[
      {kind:'key',key:'65',down:true,token:'secret'},
      {kind:'pointer',target:'actor-a',state:'mouse_down',x:2,y:3,account:'secret'},
      {kind:'drag',target:'actor-a',x:3,y:4},{kind:'swipe',direction:'left'},
      {kind:'answer',id:1,text:'secret'},{kind:'extension_result',id:1,value:'secret'},
      {kind:'audio_done',id:1},{kind:'device_event',action:'secret'},
    ]};
  const input=recorder.prepare(payload);recorder.commit(input,status(1));
  payload.events[0].key='66';input.events[0].key='67';
  const bundle=recorder.package();assert.equal(bundle.timeline[0].input.events[0].key,'65');
  assert.equal(bundle.timeline[0].input.events.length,4);
  assert.equal(JSON.stringify(bundle).includes('secret'),false);
  assert.ok(bundle.diagnostics.warnings.includes('omitted_inputs'));
  for(const code of ['audio','real_time','cloud','external_inputs','asset_geometry'])assert.ok(bundle.diagnostics.warnings.includes(code));
  bundle.timeline[0].input.events.length=0;assert.equal(recorder.package().timeline[0].input.events.length,4);
});

test('r2-repro: only confirmed frames are exported, with logical time and bounded storage',()=>{
  const recorder=new ReproRecorder(metadata,status(0),{coalesced:10,rejected:3});
  const input=recorder.prepare({});
  assert.equal(recorder.package().timeline.length,0);
  assert.throws(()=>recorder.commit(input,status(2)),/确认/);
  recorder.commit(input,status(1));recorder.commit(input,status(2));
  recorder.interrupt();
  const bundle=recorder.package({coalesced:12,rejected:4});
  assert.deepEqual(bundle.timeline.map(e=>[e.frame,e.time_ms]),[[1,0],[2,1000/60]]);
  assert.deepEqual(bundle.diagnostics.input_queue,{coalesced:2,rejected:1});
  assert.equal(bundle.diagnostics.interrupted,true);assert.equal(bundle.diagnostics.frame_count,2);
  recorder.timeline.length=MAX_REPRO_FRAMES;assert.ok(recorder.full);assert.throws(()=>recorder.prepare({}),/上限/);
  assert.throws(()=>new ReproRecorder({...metadata,work_sha256:'bad'},status(0)),/不支持/);
  for(const payload of [{mouse:{x:NaN,y:0}},{events:[{kind:'key',key:'999',down:true}]},
    {events:[{kind:'pointer',state:'bogus',x:0,y:0}]},{events:Array(257).fill({kind:'swipe',direction:'up'})}])
    assert.throws(()=>reproInput(payload));
});

class Element {
  handlers=new Map();captures=new Set();
  addEventListener(type,fn){const list=this.handlers.get(type)||[];list.push(fn);this.handlers.set(type,list);}
  emit(type,init={}){for(const fn of this.handlers.get(type)||[])fn({preventDefault(){},...init});}
  focus(){} getBoundingClientRect(){return {left:0,top:0,right:960,bottom:720,width:960,height:720};}
  setPointerCapture(id){this.captures.add(id);}hasPointerCapture(id){return this.captures.has(id);}
  releasePointerCapture(id){this.captures.delete(id);this.emit('lostpointercapture',{pointerId:id});}
}
test('r2-repro: real StageInput retains quick key pairs, CSS-scaled drags and release order',t=>{
  const previous=globalThis.window;const win=new Element();globalThis.window=win;
  t.after(()=>{if(previous===undefined)delete globalThis.window;else globalThis.window=previous;});
  t.mock.method(performance,'now',()=>100);
  const canvas=new Element(),renderer={width:480,height:360,kitten4:false,sprites:[{id:'a',x:0,y:0,draggable:true}],hitTest:()=> 'a'};
  const input=new StageInput(canvas,renderer,()=>true);
  const pointer=(type,x,y)=>canvas.emit(type,{pointerId:1,isPrimary:true,button:0,clientX:x,clientY:y});
  canvas.emit('keydown',{keyCode:65});win.emit('keyup',{keyCode:65});
  pointer('pointerdown',480,360);pointer('pointermove',680,260);pointer('pointerup',680,260);
  const accepted=input.take(),recorder=new ReproRecorder(metadata,status(0));
  recorder.commit(recorder.prepare(accepted),status(1));
  assert.deepEqual(recorder.package().timeline[0].input,accepted);
  assert.deepEqual(accepted.events.slice(0,2).map(e=>e.down),[true,false]);
  assert.deepEqual(accepted.events.find(e=>e.kind==='drag'),{kind:'drag',target:'a',x:100,y:50});
  assert.deepEqual(accepted.events.slice(-2).map(e=>e.state),['mouse_up','mouse_click']);
});

test('r2-repro: connection sends deterministic handshake and no sensor or extension injection',async()=>{
  let socket;const sent=[],device={take(){throw Error('must not sample sensors');},requestPermission(){throw Error('must not request sensors');}};
  const backend={connect(){socket={send(text){sent.push(JSON.parse(text));},close(){}};queueMicrotask(()=>socket.onopen());return socket;}};
  const connection=new PlayerConnection(new ExtensionRegistry(),device);
  try{
    const opening=connection.open({toolType:'KN'},backend,{seed:'1'});await flush();
    assert.deepEqual(sent[0],{nekoc_extension_handshake:1,project:{toolType:'KN'},extensions:[],nekoc_repro:{seed:'1'}});
    socket.onmessage({data:JSON.stringify({ready:true,repro:metadata})});assert.deepEqual((await opening).repro,metadata);
    assert.equal(await connection.requestDevicePermission(),'unavailable');
    const pending=connection.frame({dt:9,costumes:[{url:'secret'}],utc_offset:480,events:[{kind:'answer',text:'secret'}]});
    assert.deepEqual(sent.at(-1),{pressed:[],mouse:{x:0,y:0},events:[],dt:REPRO_DT});
    socket.onmessage({data:new ArrayBuffer(4)});await pending;
    const read=connection.reproStatus();assert.deepEqual(sent.at(-1),{repro_status:true});
    socket.onmessage({data:JSON.stringify({repro_status:status(1)})});assert.deepEqual(await read,status(1));
  }finally{connection.close();}
});

test('r2-repro: module is shipped in native, static and extension players',async()=>{
  for(const filename of ['src/bin/web.rs','tools/build-pages.mjs','tools/build-extension.mjs'])
    assert.ok((await readFile(filename,'utf8')).includes('repro.js'),filename);
});

test('r2-repro: an older backend fails negotiation before any input frame',async()=>{
  let socket;const sent=[];
  const backend={connect(){socket={send(text){sent.push(JSON.parse(text));},close(){}};queueMicrotask(()=>socket.onopen());return socket;}};
  const connection=new PlayerConnection(new ExtensionRegistry(),null);
  try{
    const opening=connection.open({toolType:'KN'},backend,{seed:'1'});
    const rejection=assert.rejects(opening,/不支持复现录制/);
    await flush();socket.onmessage({data:JSON.stringify({ready:true})});await rejection;
    assert.equal(sent.length,1);assert.equal(connection.ready,false);
  }finally{connection.close();}
});
