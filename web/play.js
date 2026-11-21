import {StageRenderer,decodeFrame,sensesColor} from './renderer.js';
import {PlayerConnection} from './player.js';
import {playerExtensions} from './extensions.js';
import {ProjectAudio} from './audio.js';
import {StageInput,VirtualControls} from './input.js';
import {StageOverlay} from './overlay.js';
import {PlayerFeedback} from './player-feedback.js';
import {httpBackend,wasmBackend} from './backend.js';
import {ReproRecorder,REPRO_DT} from './repro.js';
import {t,initI18n} from './i18n.js';

const extension=location.protocol==='chrome-extension:'?await import('./extension.js'):null;
const params=new URLSearchParams(location.search);
// App mode: stage, compact playback controls and performance settings.
const app=params.has('app');
document.body.classList.toggle('native',params.has('native'));
if(app){document.body.classList.add('app');document.querySelector('#settings').hidden=true;document.querySelector('#settings-toggle').setAttribute('aria-expanded','false');}
// ?engine=wasm (or the static site's meta tag) runs the VM in this browser.
const wasm=params.get('engine')==='wasm'||document.querySelector('meta[name=nekoc-engine]')?.content==='wasm';
const bundled=globalThis.nekoPlayerExport;
let backend,unsubscribeProgress;
let offline=null;
let offlineSource=null;

const $=selector=>document.querySelector(selector);
const canvas=$('#stage'),shell=$('#player-shell');
const feedback=new PlayerFeedback();
let renderer,input,overlay,sendCostumes=false,project=null,playable=false,busy=true,running=false,connection=null,inFlight=null,observing=false,epoch=0;
let lastTick=0,nextDue=0,lastFrame=null,roundtripMs=0,updates=0,draws=0,totalUpdates=0,pumpTimer=0;
let sampleStart=performance.now(),lastMonitor=0,drawFps=0,updateFps=0;
let recorder=null;
const audio=new ProjectAudio(notice,id=>input?.push({kind:'audio_done',id}));
const settings={limit:60,budget:12,resolution:0,coalesce:0};
const choices={limit:[0,30,60,120,240,480,1000,-1],budget:[2,4,8,12,16],resolution:[0,.5,1,2],coalesce:[0,1]};
let statusMessage='selectProject';
initI18n(()=>{syncControls();syncTitle();syncFullscreen();status(statusMessage);offline?.refresh();feedback.mode(backend?.kind??(bundled||wasm?'wasm':extension?null:'rust'));});
syncTitle();syncFullscreen();status(statusMessage);
try{
  const saved=JSON.parse(localStorage.getItem('neko-play-settings-v2')||'{}');
  for(const key of Object.keys(settings))if(choices[key].includes(saved[key]))settings[key]=saved[key];
}catch{/* Storage can be unavailable in private browsing. */}

const api=(path,data)=>backend.api(path,data);
function notice(message){feedback.notice(message);}
function status(message){statusMessage=message;$('#status').textContent=t(message);}
function syncTitle(){
  $('#project-name').textContent=project?project.projectName||t('untitled'):t('standalone');
  document.title=project?`${project.projectName||'Neko'} · ${t('player')}`:t('playerTitle');
}
function syncFullscreen(){
  const fallback=shell.classList.contains('fullscreen-fallback'),active=!!document.fullscreenElement||fallback,label=t(active?'exitFullscreen':'fullscreenPlay');
  document.body.classList.toggle('fullscreen-fallback-active',fallback);
  $('#fullscreen').setAttribute('aria-pressed',String(active));$('#fullscreen').setAttribute('aria-label',label);$('#fullscreen').title=label;
  $('#fullscreen span').textContent=t(active?'exitFullscreen':'fullscreen');fitStage();
}
function syncVirtualControls(){
  $('#virtual-toggle').textContent=t($('#virtual-controls').hidden?'showVirtualControls':'hideVirtualControls');
}
function syncControls(){
  $('#import').disabled=busy||!!recorder;$('#import').textContent=t(busy?'loading':'importPlayer');
  $('#toggle').disabled=busy||!playable||!!recorder&&(recorder.full||recorder.interrupted);$('#restart').disabled=busy||!playable||!!recorder;
  $('#record').disabled=busy||!playable;$('#record').textContent=t(recorder?'exportRecording':'startRecording');
  $('#record').setAttribute('aria-pressed',String(!!recorder));
  // A recording must be finalized through its export button, not discarded by stop.
  $('#stop').disabled=busy||!connection?.ready||!!recorder;
  $('#toggle').textContent=t(running?'pausePlay':connection?.ready?'resumePlay':'startPlay');
  $('#toggle').setAttribute('aria-pressed',String(running));
  for(const id of ['frame-limit','budget','resolution','coalesce'])$(`#${id}`).disabled=busy||!!recorder;
  shell.classList.toggle('running',running);
  syncVirtualControls();
  offline?.refresh();
}
function clearKeys(){input?.release();}
function resetMeter(){updates=0;draws=0;sampleStart=performance.now();drawFps=0;updateFps=0;}
function pause(message='paused'){
  running=false;connection?.pauseDevice();audio.pause();renderer?.pauseMedia();clearKeys();resetMeter();status(message);syncControls();
}
async function closeRuntime(){
  running=false;epoch++;clearKeys();connection?.close();connection=null;
  clearTimeout(pumpTimer);pumpTimer=0;
  input?.reset();overlay?.reset();
  audio.stop();renderer?.pauseMedia();
  await inFlight;resetMeter();
}
function fitStage(){
  if(!renderer||!project)return;
  $('#viewport').style.setProperty('--stage-aspect',`${renderer.width} / ${renderer.height}`);
  const area=$('#viewport'),scale=Math.max(0,Math.min(area.clientWidth/renderer.width,area.clientHeight/renderer.height));
  $('#stage-box').style.width=`${Math.max(1,renderer.width*scale)}px`;
  $('#stage-box').style.height=`${Math.max(1,renderer.height*scale)}px`;
}
async function install(report,offlineAssets=null){
  await closeRuntime();project=report.project;playable=false;lastFrame=null;totalUpdates=0;
  offlineSource=project;
  if(offlineAssets){
    // Reimport the untouched work before substituting local media; do not edit
    // K4 source provenance or persist a running VM's mutable state.
    project={...project};
    for(const [kind,container,table]of [['image','styles','stylesDict'],['audio','audios','audiosDict'],['video','videos','videosDict']]){
      const resources={...project[container]?.[table]};
      for(const [id,url]of Object.entries(offlineAssets[kind]||{}))if(resources[id]&&typeof url==='string'&&url.startsWith(`data:${kind}/`)){
        resources[id]={...resources[id],url,...(resources[id].cdn_url?{cdn_url:url}:{})};
      }
      project[container]={...project[container],[table]:resources};
    }
  }
  $('#timer').hidden=true;feedback.reset(report);
  syncTitle();
  await renderer.load(project,({completed,total})=>feedback.progress(t('loadingAssets'),completed,total));renderer.render();fitStage();
  audio.load(project);
  $('#stage-box').classList.add('loaded');$('#welcome').hidden=true;
   playable=report.fast_runtime_ready;
   if(playerExtensions.schemas().length){
     await api('extension-check',{project,extensions:playerExtensions.schemas()});
     playable=true;
   }
  if(playable)status(feedback.resourceErrors.length?'readyAssetsFailed':'readyPlay');
  else{
    const issues=report.script_diagnostics||[];
    notice(issues.length?issues.slice(0,4).map(issue=>`${issue.message}${issue.affected_scripts>1?t('affected',{count:issue.affected_scripts}):''}`).join('\n'):report.runtime_error||t('unsupported'));
    status('cannotRun');
  }
}
// Static deployments opt in explicitly. Local /api/project and extension
// imports must never enter persistent browser storage.
if(!extension&&!bundled&&wasm&&document.querySelector('meta[name=nekoc-offline]')?.content==='enabled'){
  void import('./offline.js').then(async({setupOffline})=>{
    offline=await setupOffline({getProject:()=>busy||recorder?null:offlineSource,isBusy:()=>busy||!!recorder,
      openProject:async({project,assets})=>{
        if(busy||recorder)throw Error(t('actionFailed'));
        let failed=false;
        await action(async()=>{
          try{pause('importing');await install(await api('import-player',project),assets);}
          catch(error){failed=true;throw error;}
        });
        if(failed)throw Error('offlineSaveFailed');
      },onError:notice});
  }).catch(()=>{/* Cache/worker denial must not prevent online playback. */});
}
async function launch(){
  if(!playable)return;
  if(recorder&&(recorder.interrupted||!connection?.ready||!connection.repro)){
    recorder.interrupt();pause('recordingInterrupted');return;
  }
  if(document.hidden){pause('backgroundPaused');return;}
  if(connection?.ready)void connection.requestDevicePermission();
  if(!connection?.ready){
    input?.reset();
    const next=new PlayerConnection(),devicePermission=next.requestDevicePermission();
    // A new VM must not inherit other scenes' pen surfaces, transitions or video
    // state. Keep the stopped final image until this fresh start; resume skips it.
    for(const animation of canvas.getAnimations?.()||[])animation.cancel();
    await renderer.load(project,({completed,total})=>feedback.progress(t('reloadingAssets'),completed,total));renderer.render();fitStage();
    feedback.progress(t('connecting'));
    connection=next;await next.open(project,backend);void devicePermission;sendCostumes=true;overlay.reset();
    // Opt-in observation before any scheduler tick, not an extra simulation frame.
    if(new URLSearchParams(location.search).has('compare'))window.nekoCompareZero=await next.snapshot();
    epoch++;lastFrame=null;totalUpdates=0;
  }
  if(document.hidden){pause('backgroundPaused');return;}
  clearKeys();resetMeter();running=true;lastTick=performance.now();nextDue=lastTick;queueMicrotask(pump);
  if(!recorder){audio.resume();renderer.pauseMedia(false);}extension?.reportStatus('connected');
  status(recorder?'recording':'running');focusStage();syncControls();
}
function focusStage(){
  const control=$('#stage-box').querySelector('.neko-ask input,.neko-ask button,.neko-stage-dialog button');
  (control||canvas).focus({preventScroll:true});
}
async function action(work){
  if(busy)return;busy=true;syncControls();
  try{await work();}catch(error){pause('actionFailed');notice(error);}
  finally{feedback.finish();busy=false;syncControls();}
}
async function importFile(file){
  if(!file||recorder)return;
  await action(async()=>{
    pause('importing');
    feedback.progress(t('readingFile',{name:file.name}));
    let value;
    try{value=JSON.parse((await file.text()).replace(/^\uFEFF/,''));}
    catch(error){throw Error(t('fileFailed',{name:file.name,error:error.message}));}
    await importValue(value);
  });
}
async function importValue(value){
  feedback.progress(t('checking'));
  await install(await api('import-player',value));
  if(playable)await launch();
}
// A same-origin page (the online compiler) can hand over a project object.
window.addEventListener('message',event=>{
  if(event.origin!==location.origin||event.data?.type!=='nekoc-play'||app||recorder)return;
  void action(async()=>{pause('importing');await importValue(event.data.project);});
});
async function advance(dt){
  const token=epoch,start=performance.now();
  try{
    // Costume geometry is sent once per connection, after the renderer decoded it.
    const costumes=sendCostumes&&!recorder?renderer.costumeInfo(sensesColor(project)):undefined;sendCostumes=false;
    const accepted=recorder?recorder.prepare(input.take()):null;
    const buffer=await connection.frame(accepted||{dt,...input.take(),costumes,videos:renderer.videoInfo(),budget_ms:settings.budget,coalesce:settings.coalesce===1,utc_offset:-new Date().getTimezoneOffset()});
    if(token!==epoch)return;
    // Commit only acknowledged frames; a disconnect exports the last confirmed prefix.
    if(recorder){const confirmed=await connection.reproStatus();if(token!==epoch)return;recorder.commit(accepted,confirmed);}
    roundtripMs=performance.now()-start;
    // Draw pen deltas now; the stage is composited once on the next display frame.
    const {frame,lines}=decodeFrame(buffer);renderer.apply(frame,lines,false);overlay.apply(frame);lastFrame=frame;
    if(!recorder)audio.apply(frame);connection?.applyFrame(frame);
    updates++;totalUpdates++;if(renderer.changed)draws++;
    if(recorder?.full)pause('recordingFull');
  }catch(error){
    if(token!==epoch)return;
    recorder?.interrupt();
    epoch++;connection?.close();connection=null;input?.reset();overlay?.reset();audio.stop();lastFrame=null;$('#timer').hidden=true;
    pause(recorder?'recordingInterrupted':'interrupted');feedback.runtimeError(error);
    extension?.reportStatus('lost');
  }
}
function monitor(now){
  if(now-sampleStart>=1000){
    drawFps=draws*1000/(now-sampleStart);updateFps=updates*1000/(now-sampleStart);
    updates=0;draws=0;sampleStart=now;
  }
  if(now-lastMonitor<250)return;lastMonitor=now;
  $('#fps').textContent=running?drawFps.toFixed(0):'—';
  $('#update-fps').textContent=running?`${updateFps.toFixed(0)} /s`:'—';
  $('#vm-time').textContent=lastFrame?`${(lastFrame.execute_us/1000).toFixed(2)} ms`:'—';
  $('#gpu-time').textContent=renderer.stats.gpuMs==null?t('unavailable'):`${renderer.stats.gpuMs.toFixed(2)} ms`;
  $('#roundtrip').textContent=lastFrame?`${roundtripMs.toFixed(2)} ms`:'—';
  $('#render-size').textContent=project?`${canvas.width}×${canvas.height}`:'—';
  $('#timer').hidden=!lastFrame?.timer_visible;
  if(lastFrame?.timer_visible)$('#timer').textContent=t('timer',{value:lastFrame.timer.toFixed(2)});
}
// Runtime updates are paced by the update limit, not by the display: a limit above
// the refresh rate (or a project that yields between compute and draw) is no longer
// capped at one round trip per animation frame. Only one request is ever in flight.
function step(now,continuation=false){
  const dt=recorder?REPRO_DT:Math.min((now-lastTick)/1000,.25);lastTick=now;
  const interval=recorder?1000/60:settings.limit>0?1000/settings.limit:0;
  // A continuation finishes work the last update ran out of budget for: it is not a
  // new paced update, so it neither waits for the limit nor delays the next one.
  if(!continuation)nextDue=interval?Math.max(nextDue+interval,now):now;
  inFlight=advance(dt).finally(()=>{inFlight=null;pump();});
}
const pumpChannel=new MessageChannel();
pumpChannel.port1.onmessage=()=>pump();
function pump(){
  clearTimeout(pumpTimer);pumpTimer=0;
  // "Follow screen" keeps exactly one update per display frame.
  if(!running||busy||inFlight||observing)return;
  if(!recorder&&lastFrame?.budget_yield){step(performance.now(),true);return;}
  if(!recorder&&!settings.limit)return;
  const now=performance.now(),wait=nextDue-now;
  if(wait<=.5)step(now);
  // Nested timers clamp to 4ms; shorter waits need a task that is not throttled.
  else if(wait<4)pumpChannel.port2.postMessage(0);
  else pumpTimer=setTimeout(pump,wait);
}
function loop(now){
  if(running&&!busy&&!inFlight&&!observing&&now>=nextDue-.5)step(now);
  if(renderer){renderer.render();overlay?.update();renderer.collectGpuTimes();monitor(now);}
  requestAnimationFrame(loop);
}

$('#import').onclick=()=>$('#file').click();
$('#file').onchange=async event=>{const file=event.target.files[0];event.target.value='';await importFile(file);};
$('#toggle').onclick=()=>action(async()=>{if(running)pause();else await launch();});
$('#record').onclick=()=>action(async()=>{
  if(recorder){
    running=false;await inFlight;
    const bundle=recorder.package(input.queueStats);recorder=null;await closeRuntime();
    const url=URL.createObjectURL(new Blob([JSON.stringify(bundle,null,2)],{type:'application/json'}));
    const link=document.createElement('a');link.href=url;link.download='neko-repro.json';link.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
    // Restore initial visual hit-test state before a new normal session.
    await renderer.load(project);renderer.render();fitStage();lastFrame=null;
    status(t(bundle.diagnostics.interrupted?'exportedPartialFrames':'exportedFrames',{count:bundle.timeline.length}));return;
  }
  if(playerExtensions.schemas().length)throw Error(t('recordingExtensions'));
  await closeRuntime();
  await renderer.load(project,({completed,total})=>feedback.progress(t('preparingRecording'),completed,total));renderer.render();fitStage();
  renderer.pauseMedia();
  input.mouse={x:0,y:0};
  const next=new PlayerConnection();connection=next;
  next.onFailure=error=>{
    if(connection!==next||!recorder)return;
    recorder.interrupt();epoch++;pause('recordingInterrupted');notice(error.message);
  };
  try{
    const ready=await next.open(offlineSource||project,backend,{seed:'1'});
    recorder=new ReproRecorder(ready.repro,await next.reproStatus(),input.queueStats);
    if(!next.ready)throw Error(t('recordingDisconnected'));
  }catch(error){next.close();connection=null;throw error;}
  epoch++;lastFrame=null;totalUpdates=0;sendCostumes=false;overlay.reset();
  await launch();
});
$('#stop').onclick=()=>action(async()=>{
  if(recorder)return;
  await closeRuntime();lastFrame=null;totalUpdates=0;$('#timer').hidden=true;status('stoppedPlay');
});
$('#restart').onclick=()=>action(async()=>{
  await closeRuntime();lastFrame=null;$('#timer').hidden=true;
  await launch();
});
$('#settings-toggle').onclick=()=>{
  const open=$('#settings').hidden;$('#settings').hidden=!open;$('#settings-toggle').setAttribute('aria-expanded',String(open));
};
for(const [id,key]of [['frame-limit','limit'],['budget','budget'],['resolution','resolution'],['coalesce','coalesce']]){
  const select=$(`#${id}`);select.value=String(settings[key]);
  select.onchange=()=>{
    const value=Number(select.value);if(!choices[key].includes(value))return;
    try{
      if(key==='resolution')renderer.setResolution(value);
      settings[key]=value;nextDue=performance.now();pump();
      lastMonitor=0;monitor(performance.now());
      try{localStorage.setItem('neko-play-settings-v2',JSON.stringify(settings));}catch{}
    }catch(error){select.value=String(settings[key]);notice(error.message);}
  };
}
$('#fullscreen').onclick=async()=>{
  clearKeys();
  try{
    if(shell.classList.contains('fullscreen-fallback'))shell.classList.remove('fullscreen-fallback');
    else if(document.fullscreenElement)await document.exitFullscreen();
    else await shell.requestFullscreen();
  }catch{shell.classList.add('fullscreen-fallback');notice(t('fullscreenFallback'));}
  syncFullscreen();if(running)focusStage();
};
document.addEventListener('fullscreenchange',()=>{clearKeys();syncFullscreen();});
window.addEventListener('keydown',event=>{
  if(event.key==='Escape'&&shell.classList.contains('fullscreen-fallback')){shell.classList.remove('fullscreen-fallback');clearKeys();syncFullscreen();}
});
window.addEventListener('pointerdown',()=>audio.unlock(),{capture:true});
window.addEventListener('keydown',()=>audio.unlock(),{capture:true});
document.addEventListener('visibilitychange',()=>{if(document.hidden&&running)pause('backgroundPaused');});
window.addEventListener('pagehide',()=>{clearKeys();connection?.close();audio.stop();});
window.addEventListener('orientationchange',()=>{clearKeys();requestAnimationFrame(fitStage);});
window.addEventListener('dragover',event=>{if(event.dataTransfer.types.includes('Files')){event.preventDefault();shell.classList.add('file-drag');}});
window.addEventListener('dragleave',event=>{if(!event.relatedTarget)shell.classList.remove('file-drag');});
window.addEventListener('drop',event=>{event.preventDefault();shell.classList.remove('file-drag');if(!app)void importFile(event.dataTransfer.files[0]);});
let resizeTimer=0;
new ResizeObserver(()=>{
  fitStage();
  clearTimeout(resizeTimer);
  resizeTimer=setTimeout(()=>{if(settings.resolution===0)renderer?.setResolution(0);},200);
}).observe($('#viewport'));

try{
  renderer=new StageRenderer(canvas);renderer.resolutionScale=settings.resolution;
  input=new StageInput(canvas,renderer,()=>running&&!busy,notice);
  new VirtualControls(input,$('#virtual-controls'),$('#virtual-toggle'),visible=>{shell.classList.toggle('virtual-controls-visible',visible);syncVirtualControls();});
  overlay=new StageOverlay($('#stage-box'),renderer,event=>{if(recorder){recorder.warnings.add('omitted_inputs');notice(t('recordingInputs'));return false;}const accepted=input.push(event);if(accepted)queueMicrotask(()=>{if(running)focusStage();});return accepted;});
  renderer.onError=message=>{if(!busy)pause('renderNotice');feedback.resourceError(message);};
  feedback.mode(bundled||wasm?'wasm':extension?null:'rust');
  backend=bundled?await bundled.createBackend():extension?await extension.backend():wasm?wasmBackend():httpBackend(location.origin);
  feedback.mode(backend.kind);
  unsubscribeProgress=backend.subscribeProgress?.(({label,completed,total})=>feedback.progress(label,completed,total));
  await backend.ready;unsubscribeProgress?.();unsubscribeProgress=null;
  // A static wasm page starts empty unless ?src= names a project URL.
  const source=bundled?null:extension||backend.kind==='rust'?'/api/project':params.get('src');
  if(bundled||source){
    feedback.progress(t('readProject'));
    const value=bundled?await bundled.loadProject():extension?await extension.loadWork(backend,status):await(async()=>{
      const response=await fetch(new URL(source,location.href),{signal:AbortSignal.timeout(60000)});
      if(!response.ok)throw Error(t('readHttpFailed',{status:response.status}));
      return response.json();
    })();
    feedback.progress(t('checking'));
    await install(await api('import-player',value));
    if(!bundled&&(extension||app)&&playable)await launch();
  }
}catch(error){notice(t('readFailed',{error:error.message}));status(extension?'connectionFailed':'importRetry');extension?.reportStatus('failed');}
finally{
  unsubscribeProgress?.();
  feedback.finish();busy=false;syncControls();requestAnimationFrame(loop);
  // Embedded in the online compiler: ready to receive a nekoc-play message.
  if(!extension&&window.parent!==window)window.parent.postMessage({type:'nekoc-player-ready'},location.origin);
}

// Read-only test/performance snapshot; the standalone page never builds editor DOM.
window.nekoPlayDiagnostics=()=>({running,busy,playable,recording:!!recorder,mode:backend?.kind,settings:{...settings},frame:lastFrame,totalUpdates,drawFps,updateFps,
  framebuffer:[canvas.width,canvas.height],renderer:{...renderer?.stats},inputQueue:{...input?.queueStats},pending:!!inFlight,projectName:project?.projectName,audio:audio.snapshot()});
// A detached read, serialized after an outstanding frame. No pause/resume or VM mutation.
window.nekoPlaySnapshot=async()=>{
  if(!connection?.ready)throw Error(t('notConnected'));
  if(observing)throw Error(t('snapshotPending'));
  observing=true;
  try{await inFlight;return await connection.snapshot();}
  finally{observing=false;pump();}
};
