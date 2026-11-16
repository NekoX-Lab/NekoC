import test from 'node:test';
import assert from 'node:assert/strict';
import {StageInput} from '../web/input.js';
import {ProjectAudio} from '../web/audio.js';

class Element {
  handlers=new Map();captures=new Set();
  addEventListener(type,fn){const list=this.handlers.get(type)||[];list.push(fn);this.handlers.set(type,list);}
  emit(type,init={}){const e={preventDefault(){},...init};for(const fn of this.handlers.get(type)||[])fn(e);}
  focus(){} getBoundingClientRect(){return {left:0,top:0,right:480,bottom:360,width:480,height:360};}
  setPointerCapture(id){this.captures.add(id);} hasPointerCapture(id){return this.captures.has(id);}
  releasePointerCapture(id){this.captures.delete(id);this.emit('lostpointercapture',{pointerId:id});}
}
function fixture(t,kitten4){
  const window=new Element(),canvas=new Element(),warnings=[];
  const previous=Object.getOwnPropertyDescriptor(globalThis,'window');
  Object.defineProperty(globalThis,'window',{configurable:true,value:window});
  t.after(()=>{if(previous)Object.defineProperty(globalThis,'window',previous);else delete globalThis.window;});
  t.mock.method(performance,'now',()=>0);
  const renderer={width:480,height:360,kitten4,sprites:[{id:'a',x:0,y:0,draggable:true},{id:'b',x:0,y:0,draggable:true}],hitTest:()=>target};
  let target='a';const input=new StageInput(canvas,renderer,()=>true,message=>warnings.push(message));
  return {input,window,canvas,renderer,warnings,target(value){target=value;},
    pointer(type,x=0,y=0){canvas.emit(type,{pointerId:1,isPrimary:true,button:0,clientX:x+240,clientY:180-y});},
    key(down,keyCode=65){(down?canvas:window).emit(down?'keydown':'keyup',{keyCode});},
    flood(count=4096){for(let i=0;i<count;i++)this.pointer('pointermove',i%101,i%61);},
  };
}

for(const kitten4 of [false,true]){
  const name=kitten4?'K4':'KN';
  for(const end of ['pointerup','pointercancel','blur','lostpointercapture','outside']){
    test(`${name} overloaded drag releases on ${end} and retains final position`,t=>{
      const f=fixture(t,kitten4);f.pointer('pointerdown');f.key(true);f.input.take();
      f.flood();f.pointer('pointermove',100,60);
      // Mix non-replayable producers into the drag stream, up to backpressure.
      for(let i=0;i<300;i++){
        f.input.push({kind:'audio_done',id:i});f.pointer('pointermove',100,60);
      }
      f.key(false);f.pointer('pointermove',101,61);
      if(end==='blur')f.window.emit('blur');
      else if(end==='lostpointercapture')f.canvas.releasePointerCapture(1);
      else f.pointer(end==='outside'?'pointerup':end,end==='outside'?300:101,61);
      const frame=f.input.take(),drags=frame.events.filter(e=>e.kind==='drag');
      assert.ok(frame.events.length<=256);assert.ok(f.input.queueStats.highWater<=256);
      assert.deepEqual(drags.at(-1),{kind:'drag',target:'a',x:101,y:61});
      assert.equal(f.input.pointer,null);assert.equal(f.canvas.captures.size,0);
      assert.deepEqual(frame.pressed,[]);assert.ok(frame.events.some(e=>e.kind==='key'&&!e.down));
      const releases=frame.events.filter(e=>e.kind==='pointer');
      assert.equal(releases[0].state,end==='pointerup'||(!kitten4&&end!=='outside')?'mouse_up':'');
      assert.ok(f.input.queueStats.rejected>0);assert.equal(f.warnings.length,1);
      f.pointer('pointermove',120,80);assert.deepEqual(f.input.take().events,[]);
    });
  }
  test(`${name} original 256-move probe and long drag do not lose up`,t=>{
    const f=fixture(t,kitten4);
    for(const count of [256,257,10000]){
      f.pointer('pointerdown');f.input.take();f.flood(count);f.pointer('pointermove',99,59);f.pointer('pointerup',99,59);
      const events=f.input.take().events;
      assert.deepEqual({...events[0],y:Math.round(events[0].y)},{kind:'drag',target:'a',x:99,y:59});
      assert.equal(events.filter(e=>e.kind==='drag').length,1);
      assert.ok(events.some(e=>e.state==='mouse_up'));assert.deepEqual(f.input.take().events,[]);
    }
    assert.equal(f.input.queueStats.rejected,0);assert.equal(f.warnings.length,0);
  });
  test(`${name} barriers preserve short clicks, key pairs, target changes and cancel order`,t=>{
    const f=fixture(t,kitten4),expected=[];
    for(const target of ['a','b','a']){
      f.target(target);f.pointer('pointerdown');f.flood();
      expected.push(['pointer','mouse_down',target],['drag',undefined,target]);
      f.key(true);f.key(false);expected.push(['key',undefined,undefined],['key',undefined,undefined]);
      f.flood();expected.push(['drag',undefined,target]);
      f.pointer('pointerup');expected.push(['pointer','mouse_up',target],['pointer','mouse_click',target]);
    }
    const events=f.input.take().events;
    assert.deepEqual(events.map(e=>[e.kind,e.state,e.target]),expected);
    assert.deepEqual(events.filter(e=>e.kind==='key').map(e=>e.down),[true,false,true,false,true,false]);
    f.pointer('pointerdown');f.flood();f.pointer('pointercancel');f.target('b');f.pointer('pointerdown');f.flood();f.window.emit('blur');
    assert.deepEqual(f.input.take().events.map(e=>[e.kind,e.state,e.target]),[
      ['pointer','mouse_down','a'],['drag',undefined,'a'],['pointer',kitten4?'':'mouse_up','a'],
      ['pointer','mouse_down','b'],['drag',undefined,'b'],['pointer',kitten4?'':'mouse_up','b'],
    ]);
  });
  test(`${name} full controls cannot swallow admitted releases or accept partial gestures`,t=>{
    const f=fixture(t,kitten4);f.key(true);f.pointer('pointerdown');f.input.take();
    while(f.input.push({kind:'answer',id:1,text:'ok'})){}
    f.flood();f.window.emit('blur');const events=f.input.take().events;
    assert.ok(events.length<=256);assert.ok(events.some(e=>e.kind==='key'&&!e.down));
    assert.ok(events.some(e=>e.kind==='pointer'&&e.state!=='mouse_down'));
    for(let i=0;i<256;i++)assert.equal(f.input.push({kind:'audio_done',id:i}),true);
    f.key(true);f.pointer('pointerdown');assert.equal(f.input.pointer,null);assert.equal(f.input.pressed.size,0);
    assert.equal(f.input.push({kind:'answer',id:2,text:'retry'}),false);
    assert.equal(f.input.events.length,256);f.input.take();
    f.key(true);f.key(false);f.pointer('pointerdown');f.pointer('pointerup');
    assert.deepEqual(f.input.take().events.map(e=>e.kind),['key','key','pointer','pointer','pointer']);
  });
  test(`${name} saturation retains every admitted short key pair and click in order`,t=>{
    const f=fixture(t,kitten4);
    for(let i=0;i<2000;i++){
      f.key(true);f.key(false);f.pointer('pointerdown');f.pointer('pointerup');
      assert.ok(f.input.events.length<=256);
    }
    const events=f.input.take().events;
    for(let i=0;i<events.length;){
      if(events[i].kind==='key'){
        assert.deepEqual(events.slice(i,i+2).map(e=>e.down),[true,false]);i+=2;
      }else{
        assert.deepEqual(events.slice(i,i+3).map(e=>e.state),['mouse_down','mouse_up','mouse_click']);i+=3;
      }
    }
    assert.equal(f.input.pressed.size,0);assert.equal(f.input.pointer,null);
  });
  test(`${name} saturation keeps old-target clear and all release-time swipes`,t=>{
    const f=fixture(t,kitten4);f.pointer('pointerdown');
    while(f.input.push({kind:'stage_dialog_click',id:1})){}
    f.flood();f.pointer('pointermove',200,100);f.target('b');f.pointer('pointerup',200,100);
    const events=f.input.take().events;
    assert.ok(events.length<=256);
    assert.deepEqual(events.slice(-2).map(e=>[e.state,e.target]),[['','a'],['mouse_up','b']]);
    assert.deepEqual(events.filter(e=>e.kind==='swipe').map(e=>e.direction),kitten4?['right']:['up','right']);
  });
}

test('audio completion backpressure retries once, in order, and reset clears retries',()=>{
  let accepting=false;const sent=[];
  const audio=new ProjectAudio(()=>{},id=>{if(!accepting)return false;sent.push(id);return true;});
  audio.finish({wanted:true,generation:0,waits:[1,2]});assert.deepEqual([...audio.completions],[1,2]);
  audio.apply({});assert.deepEqual(sent,[]);accepting=true;audio.apply({});audio.apply({});
  assert.deepEqual(sent,[1,2]);assert.equal(audio.completions.size,0);
  accepting=false;audio.complete(3);audio.stop();assert.equal(audio.completions.size,0);
});

test('audio completion retry storage is bounded and overflow is reported',()=>{
  const errors=[];const audio=new ProjectAudio(message=>errors.push(message),()=>false);
  for(let id=0;id<1000;id++)audio.complete(id);
  assert.equal(audio.completions.size,256);assert.ok(errors.length>0);assert.match(errors[0],/256/);
});
