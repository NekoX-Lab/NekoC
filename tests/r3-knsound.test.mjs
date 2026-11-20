import test from 'node:test';
import assert from 'node:assert/strict';
import {ProjectAudio} from '../web/audio.js';

const failure=name=>Object.assign(new Error(name),{name});
const tick=async()=>{await Promise.resolve();await Promise.resolve();};
function setup(t){
  const original=Object.getOwnPropertyDescriptor(globalThis,'Audio');
  const elements=[],done=[],errors=[];let now=0;
  t.mock.method(performance,'now',()=>now);
  class Audio {
    constructor(){this.currentTime=0;this.paused=true;this.ended=false;elements.push(this);}
    play(){this.paused=false;return Promise.resolve();}
    pause(){this.paused=true;}
    removeAttribute(){}
    load(){}
  }
  globalThis.Audio=Audio;
  const audio=new ProjectAudio(e=>errors.push(e),id=>done.push(id));
  audio.load({audios:{sortList:['tone'],audiosDict:{tone:{id:'tone',url:'tone.wav'}}}});
  audio.resume();
  t.after(()=>{audio.stop();if(original)Object.defineProperty(globalThis,'Audio',original);else delete globalThis.Audio;});
  const play=id=>audio.apply({audio_commands:[{audio:'tone',play:true,wait:id}]});
  const advance=ms=>{now+=ms;audio.apply({});};
  return {audio,Audio,elements,done,errors,play,advance};
}

for(const unavailable of ['missing','constructor'])test(`r3 KN missing audio device: ${unavailable} completes each wait`,t=>{
  const {audio,play,done,errors}=setup(t);
  globalThis.Audio=unavailable==='missing'?undefined:class {constructor(){throw failure('NotFoundError');}};
  audio.apply({audio_commands:[{audio:'tone',property:{rate:false,change:false,value:.25}}]});
  play(1);play(2);
  assert.deepEqual(done,[1,2]);assert.equal(audio.voices.size,0);assert.equal(errors.length,3);
});

for(const sync of [true,false])test(`r3 KN play device failure (${sync?'throw':'reject'}) releases once and recovers`,async t=>{
  const {audio,Audio,play,elements,done,errors}=setup(t);
  const original=Audio.prototype.play;
  Audio.prototype.play=function(){if(sync)throw failure('NotFoundError');return Promise.reject(failure('NotFoundError'));};
  play(1);await tick();assert.deepEqual(done,[1]);assert.equal(errors.length,1);assert.equal(elements[0].paused,true);
  elements[0].onerror?.();assert.deepEqual(done,[1]);
  Audio.prototype.play=original;play(2);elements[0].onended();assert.deepEqual(done,[1,2]);
  assert.ok([...audio.voices.values()].every(v=>!v.wanted));
});

test('r3 KN unresolved play with no media callbacks has bounded wait',t=>{
  const {Audio,play,advance,elements,done,errors}=setup(t);
  Audio.prototype.play=()=>new Promise(()=>{});
  play(1);const staleEnd=elements[0].onended;
  advance(14999);assert.deepEqual(done,[]);advance(1);assert.deepEqual(done,[1]);
  assert.equal(elements[0].paused,true);assert.match(errors[0],/15 秒/);
  play(2);staleEnd();assert.deepEqual(done,[1]);advance(15000);assert.deepEqual(done,[1,2]);
});

test('r3 KN progress and pause do not consume the stall deadline',t=>{
  const {audio,play,advance,elements,done}=setup(t);
  play(1);
  for(let i=1;i<=10;i++){elements[0].currentTime=i;advance(14000);assert.deepEqual(done,[]);}
  audio.pause();advance(60000);assert.deepEqual(done,[]);audio.resume();
  advance(14999);assert.deepEqual(done,[]);
  elements[0].ended=true;advance(1);assert.deepEqual(done,[1]);
});

test('r3 KN autoplay denial remains retryable and is not classified as a missing device',async t=>{
  const {audio,Audio,play,advance,elements,done,errors}=setup(t);
  const original=Audio.prototype.play;
  Audio.prototype.play=()=>Promise.reject(failure('NotAllowedError'));
  play(1);await tick();advance(60000);assert.deepEqual(done,[]);assert.match(errors[0],/启用声音/);
  Audio.prototype.play=original;audio.unlock();elements[0].onended();assert.deepEqual(done,[1]);
});

test('r3 KN late device rejection from a paused attempt cannot end resumed playback',async t=>{
  const {audio,Audio,play,elements,done,errors}=setup(t);
  let reject;Audio.prototype.play=()=>new Promise((_,r)=>{reject=r;});
  play(1);const staleReject=reject;audio.pause();audio.resume();
  staleReject(failure('NotFoundError'));await tick();assert.deepEqual(done,[]);assert.deepEqual(errors,[]);
  elements[0].onended();assert.deepEqual(done,[1]);
});

test('r3 KN timeout completion survives input backpressure and all_audio stop is idempotent',t=>{
  const {audio,play,advance,done}=setup(t);let accept=false;
  audio.onDone=id=>{if(!accept)return false;done.push(id);return true;};
  play(1);play(2);advance(15000);assert.deepEqual(done,[]);
  accept=true;audio.apply({audio_commands:[{audio:'all_audio',play:false}]});
  assert.deepEqual(done,[1,2]);audio.apply({});assert.deepEqual(done,[1,2]);
});

for(const phase of ['construct','voices','speak','resume'])test(`r3 KN speech device failure during ${phase} completes its wait`,t=>{
  const originals=new Map(['speechSynthesis','SpeechSynthesisUtterance'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  t.after(()=>{for(const [key,value]of originals)if(value)Object.defineProperty(globalThis,key,value);else delete globalThis[key];});
  const {audio,done,errors}=setup(t);
  globalThis.SpeechSynthesisUtterance=class {constructor(){if(phase==='construct')throw failure('NotFoundError');}};
  globalThis.speechSynthesis={
    getVoices(){if(phase==='voices')throw failure('NotFoundError');return [];},
    speak(){throw failure('NotFoundError');},pause(){},resume(){},cancel(){},
  };
  if(phase==='resume')audio.pause();
  audio.apply({speech_commands:[{text:'hello',wait:1,config:[0,10,10,10]}]});
  if(phase==='resume'){assert.deepEqual(done,[]);audio.resume();}
  assert.deepEqual(done,[1]);assert.equal(errors.length,1);assert.equal(audio.speech.size,0);
});

test('r3 KN silent speech device releases the queue, while boundaries and pauses keep it alive',t=>{
  const originals=new Map(['speechSynthesis','SpeechSynthesisUtterance'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  t.after(()=>{for(const [key,value]of originals)if(value)Object.defineProperty(globalThis,key,value);else delete globalThis[key];});
  const {audio,advance,done,errors}=setup(t);const utterances=[];
  globalThis.SpeechSynthesisUtterance=class {};
  globalThis.speechSynthesis={getVoices:()=>[],speak:u=>utterances.push(u),pause(){},resume(){},cancel(){}};
  audio.apply({speech_commands:[{text:'one',wait:1},{text:'two',wait:2}]});
  const [first,second]=utterances;first.onstart();
  for(let i=0;i<3;i++){advance(59000);first.onboundary();assert.deepEqual(done,[]);}
  audio.pause();advance(120000);assert.deepEqual(done,[]);audio.resume();advance(0);
  advance(59000);assert.deepEqual(done,[]);first.onend();assert.deepEqual(done,[1]);
  advance(0);advance(59000);assert.deepEqual(done,[1]);
  second.onmark();advance(59000);assert.deepEqual(done,[1]);
  advance(1000);assert.deepEqual(done,[1,2]);assert.equal(errors.length,1);assert.match(errors[0],/60 秒/);
  first.onend();second.onend();assert.deepEqual(done,[1,2]);assert.equal(audio.speech.size,0);
  audio.apply({speech_commands:[{text:'no callbacks',wait:3},{text:'also stuck',wait:4}]});
  advance(60000);assert.deepEqual(done,[1,2,3,4]);
});
