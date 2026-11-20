import test from 'node:test';
import assert from 'node:assert/strict';
import {StageInput,VirtualControls} from '../web/input.js';
import {ReproRecorder,REPRO_DT} from '../web/repro.js';

class Element {
  listeners=new Map();captures=new Set();attributes={};dataset={};hidden=false;
  addEventListener(type,fn){const list=this.listeners.get(type)||[];list.push(fn);this.listeners.set(type,list);}
  emit(type,init={}){const e={target:this,preventDefault(){this.defaultPrevented=true;},...init};for(const fn of this.listeners.get(type)||[])fn(e);return e;}
  setAttribute(key,value){this.attributes[key]=value;}
  closest(){return this.dataset.key?this:null;}
  focus(){}
  getBoundingClientRect(){return {left:0,top:0,right:240,bottom:180,width:240,height:180};}
  setPointerCapture(id){this.captures.add(id);}
  hasPointerCapture(id){return this.captures.has(id);}
  releasePointerCapture(id){this.captures.delete(id);this.emit('lostpointercapture',{pointerId:id});}
}
function fixture(t){
  const window=new Element(),canvas=new Element(),root=new Element(),toggle=new Element();
  const previous=Object.getOwnPropertyDescriptor(globalThis,'window');
  Object.defineProperty(globalThis,'window',{configurable:true,value:window});
  t.after(()=>{if(previous)Object.defineProperty(globalThis,'window',previous);else delete globalThis.window;});
  let active=true;const warnings=[];
  const input=new StageInput(canvas,{width:480,height:360,kitten4:true,sprites:[],hitTest:()=>null},()=>active,message=>warnings.push(message));
  const controls=new VirtualControls(input,root,toggle);
  const button=code=>{const button=new Element();button.dataset.key=String(code);return button;};
  return {input,controls,root,toggle,canvas,window,warnings,button,active(value){active=value;},
    touch(type,button,id=1){return root.emit(type,{target:button,pointerId:id,button:0,pointerType:'touch',isPrimary:id===1});}};
}
const key=(code,down)=>({kind:'key',key:String(code),down});

test('r3-mobile recording consumes virtual keys and secondary stage touch from the shared queue',t=>{
  const f=fixture(t),button=f.button(37);f.controls.setVisible(true);
  const hash='a'.repeat(64),status=frame_count=>({frame_count,state_sha256:hash,budget_yields:0});
  const recorder=new ReproRecorder({runner:{name:'nekoc',version:'test',protocol:2},work_sha256:hash,seed:'1',dt:REPRO_DT},status(0));
  const pointer={pointerId:2,pointerType:'touch',isPrimary:false,button:0,clientX:120,clientY:90};
  f.touch('pointerdown',button);f.canvas.emit('pointerdown',pointer);
  const held=f.input.take();recorder.commit(recorder.prepare(held),status(1));
  assert.deepEqual(held.pressed,['37']);assert.equal(held.events[1].state,'mouse_down');
  f.canvas.emit('pointerup',pointer);f.touch('pointerup',button);
  const released=f.input.take();recorder.commit(recorder.prepare(released),status(2));
  const bundle=recorder.package(f.input.queueStats);
  assert.deepEqual(bundle.timeline.map(frame=>frame.input),[held,released]);
  assert.deepEqual(bundle.timeline.flatMap(frame=>frame.input.events).filter(e=>e.kind==='key'),[key(37,true),key(37,false)]);
  assert.equal(bundle.diagnostics.warnings.includes('omitted_inputs'),false);
  assert.deepEqual(f.input.take().events,[]);
});

test('r3-mobile hidden controls ignore touches; visible simultaneous directions/actions emit pairs',t=>{
  const f=fixture(t),left=f.button(37),space=f.button(32);
  assert.equal(f.root.hidden,true);f.touch('pointerdown',left);assert.deepEqual(f.input.take().events,[]);
  f.toggle.emit('click');assert.equal(f.toggle.attributes['aria-expanded'],'true');
  f.touch('pointerdown',left);f.touch('pointerdown',space,2);f.touch('pointerdown',left);
  assert.deepEqual(f.input.take().pressed,['37','32']);
  f.touch('pointerup',left);assert.equal(left.attributes['aria-pressed'],'false');
  assert.deepEqual(f.input.take(),{pressed:['32'],events:[key(37,false)],mouse:{x:0,y:0}});
  f.touch('pointercancel',space,2);f.touch('lostpointercapture',space,2);
  assert.deepEqual(f.input.take().events,[key(32,false)]);assert.equal(f.controls.holds.size,0);
});

test('r3-mobile keyboard and multiple touch owners release only their own hold',t=>{
  const f=fixture(t),button=f.button(65);f.controls.setVisible(true);
  f.canvas.emit('keydown',{keyCode:65,code:'KeyA'});
  f.touch('pointerdown',button);f.touch('pointerdown',button,2);
  assert.deepEqual(f.input.take().events,[key(65,true)]);
  f.window.emit('keyup',{keyCode:65,code:'KeyA'});f.touch('pointerup',button);
  assert.deepEqual(f.input.take().pressed,['65']);assert.equal(button.attributes['aria-pressed'],'true');
  f.touch('pointerup',button,2);assert.deepEqual(f.input.take().events,[key(65,false)]);
  f.canvas.emit('keydown',{keyCode:48,code:'Digit0'});f.canvas.emit('keydown',{keyCode:96,code:'Numpad0'});
  f.window.emit('keyup',{keyCode:48,code:'Digit0'});assert.deepEqual(f.input.take().pressed,['48']);
  f.window.emit('keyup',{keyCode:96,code:'Numpad0'});assert.deepEqual(f.input.take().events,[key(48,false)]);
});

for(const end of ['hide','blur','reset','release','lostpointercapture','pointercancel']){
  test(`r3-mobile ${end} clears visual holds and capture without duplicate key-up`,t=>{
    const f=fixture(t),button=f.button(39);f.controls.setVisible(true);f.touch('pointerdown',button);f.input.take();
    if(end==='hide')f.controls.setVisible(false);
    else if(end==='blur')f.window.emit('blur');
    else if(end==='reset'||end==='release')f.input[end]();
    else f.touch(end,button);
    f.touch('pointerup',button);
    assert.deepEqual(f.input.take().events,end==='reset'?[]:[key(39,false)]);
    assert.equal(button.attributes['aria-pressed'],'false');assert.equal(button.captures.size,0);assert.equal(f.controls.holds.size,0);
    f.controls.setVisible(true);f.touch('pointerdown',button);f.touch('pointerup',button);
    assert.deepEqual(f.input.take().events,[key(39,true),key(39,false)]);
  });
}

test('r3-mobile button focusout releases only its keyboard hold, preserving captured fingers',t=>{
  const f=fixture(t),up=f.button(38),left=f.button(37);f.controls.setVisible(true);
  f.root.emit('keydown',{target:up,key:' ',code:'Space'});
  f.touch('pointerdown',left);f.touch('pointerdown',up,2);f.input.take();
  f.root.emit('focusout',{target:up});
  assert.deepEqual(f.input.take().events,[]);
  assert.deepEqual([...f.input.pressed],['38','37']);
  assert.equal(up.attributes['aria-pressed'],'true');assert.equal(left.attributes['aria-pressed'],'true');
  assert.equal(up.hasPointerCapture(2),true);assert.equal(left.hasPointerCapture(1),true);
  assert.equal(f.controls.holds.has('button:Space'),false);
  f.touch('pointerup',up,2);assert.deepEqual(f.input.take().events,[key(38,false)]);
  f.window.emit('blur');assert.deepEqual(f.input.take().events,[key(37,false)]);
  assert.equal(f.controls.holds.size,0);assert.equal(left.captures.size,0);
  f.root.emit('keyup',{target:up,key:' ',code:'Space'});f.touch('pointerup',left);
  assert.deepEqual(f.input.take().events,[]);
});

test('r3-mobile leaving a keyboard-activated button releases its key without lifting another touch',t=>{
  const f=fixture(t),up=f.button(38),left=f.button(37);f.controls.setVisible(true);
  f.root.emit('keydown',{target:up,key:' ',code:'Space'});f.touch('pointerdown',left);f.input.take();
  f.root.emit('focusout',{target:up});
  assert.deepEqual(f.input.take().events,[key(38,false)]);assert.deepEqual([...f.input.pressed],['37']);
  assert.equal(left.hasPointerCapture(1),true);
  f.touch('pointercancel',left);assert.deepEqual(f.input.take().events,[key(37,false)]);
});

test('r3-mobile rejected/inactive keys never acquire holds; admitted keys can release a full queue',t=>{
  const f=fixture(t),left=f.button(37),space=f.button(32);f.controls.setVisible(true);
  f.active(false);f.touch('pointerdown',left);assert.equal(f.controls.holds.size,0);
  f.active(true);f.touch('pointerdown',left);
  while(f.input.push({kind:'audio_done',id:1})){}
  f.touch('pointerdown',space,2);assert.equal(space.captures.size,0);assert.equal(f.controls.holds.size,1);
  f.active(false);f.controls.setVisible(false);
  const frame=f.input.take();assert.deepEqual(frame.pressed,[]);assert.deepEqual(frame.events.at(-1),key(37,false));
  assert.ok(frame.events.length<=256);assert.equal(f.warnings.length,1);
});

test('r3-mobile virtual keys support keyboard/assistive activation and ignore compatibility click',t=>{
  const f=fixture(t),button=f.button(90);f.controls.setVisible(true);
  f.root.emit('keydown',{target:button,key:' ',code:'Space'});f.root.emit('keydown',{target:button,key:' ',code:'Space',repeat:true});
  f.root.emit('keyup',{target:button,key:' ',code:'Space'});f.root.emit('click',{target:button,detail:1});
  assert.deepEqual(f.input.take().events,[key(90,true),key(90,false)]);
  f.root.emit('click',{target:button,detail:0});assert.deepEqual(f.input.take().events,[key(90,true),key(90,false)]);
});

test('r3-mobile virtual primary finger permits a separate canvas touch without stealing gestures',t=>{
  const f=fixture(t),button=f.button(32);f.controls.setVisible(true);f.touch('pointerdown',button);
  const event={pointerId:2,pointerType:'touch',isPrimary:false,button:0,clientX:120,clientY:90};
  f.canvas.emit('pointerdown',event);assert.equal(f.input.pointer.id,2);
  f.canvas.emit('pointermove',{...event,clientX:180});assert.deepEqual(f.input.mouse,{x:120,y:0});
  f.canvas.emit('pointerdown',{...event,pointerId:3});assert.equal(f.input.pointer.id,2);
  f.canvas.emit('pointerup',{...event,clientX:180});assert.equal(f.input.pointer,null);
  assert.deepEqual(f.input.take().pressed,['32']);f.touch('pointerup',button);assert.deepEqual(f.input.take().events,[key(32,false)]);
});

test('r3-mobile retargeted clicks are consumed but a reused mouse pointer is not swallowed',t=>{
  const f=fixture(t),button=f.button(32);f.controls.setVisible(true);
  f.window.emit('pointerdown',{pointerId:1});f.touch('pointerdown',button);
  f.controls.setVisible(false);f.touch('pointerup',button);
  let stopped=false;
  assert.equal(f.window.emit('click',{pointerId:1,stopImmediatePropagation(){stopped=true;}}).defaultPrevented,true);
  assert.equal(stopped,true);
  f.controls.setVisible(true);f.window.emit('pointerdown',{pointerId:1});f.touch('pointerdown',button);f.touch('pointercancel',button);
  f.window.emit('pointerdown',{pointerId:1});
  assert.equal(f.window.emit('click',{pointerId:1,stopImmediatePropagation(){assert.fail('unrelated click');}}).defaultPrevented,undefined);
});
