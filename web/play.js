import {StageRenderer,decodeFrame,sensesColor} from './renderer.js';
import {PlayerConnection} from './player.js';
import {playerExtensions} from './extensions.js';
import {ProjectAudio} from './audio.js';
import {StageInput,VirtualControls} from './input.js';
import {StageOverlay} from './overlay.js';
import {PlayerFeedback} from './player-feedback.js';
import {httpBackend,wasmBackend} from './backend.js';
import {ReproRecorder,REPRO_DT} from './repro.js';

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
try{
  const saved=JSON.parse(localStorage.getItem('neko-play-settings-v2')||'{}');
  for(const key of Object.keys(settings))if(choices[key].includes(saved[key]))settings[key]=saved[key];
}catch{/* Storage can be unavailable in private browsing. */}

const api=(path,data)=>backend.api(path,data);
function notice(message){feedback.notice(message);}
function status(message){$('#status').textContent=message;}
function syncControls(){
  $('#import').disabled=busy||!!recorder;$('#import').textContent=busy?'载入中…':'＋ 导入作品';
  $('#toggle').disabled=busy||!playable||!!recorder&&(recorder.full||recorder.interrupted);$('#restart').disabled=busy||!playable||!!recorder;
  $('#record').disabled=busy||!playable;$('#record').textContent=recorder?'■ 停止录制并导出 JSON':'● 录制复现（从头开始）';
  $('#record').setAttribute('aria-pressed',String(!!recorder));
  // A recording must be finalized through its export button, not discarded by stop.
  $('#stop').disabled=busy||!connection?.ready||!!recorder;
  $('#toggle').textContent=running?'Ⅱ 暂停':connection?.ready?'▶ 继续游玩':'▶ 开始游玩';
  $('#toggle').setAttribute('aria-pressed',String(running));
  for(const id of ['frame-limit','budget','resolution','coalesce'])$(`#${id}`).disabled=busy||!!recorder;
  shell.classList.toggle('running',running);
}
function clearKeys(){input?.release();}
function resetMeter(){updates=0;draws=0;sampleStart=performance.now();drawFps=0;updateFps=0;}
function pause(message='已暂停'){
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
async function install(report){
  await closeRuntime();project=report.project;playable=false;lastFrame=null;totalUpdates=0;
  $('#timer').hidden=true;feedback.reset(report);
  $('#project-name').textContent=project.projectName||'未命名作品';document.title=`${project.projectName||'Neko'} · 播放器`;
  await renderer.load(project,({completed,total})=>feedback.progress('加载图片 / 视频…',completed,total));renderer.render();fitStage();
  audio.load(project);
  $('#stage-box').classList.add('loaded');$('#welcome').hidden=true;
   playable=report.fast_runtime_ready;
   if(playerExtensions.schemas().length){
     await api('extension-check',{project,extensions:playerExtensions.schemas()});
     playable=true;
   }
  if(playable)status(feedback.resourceErrors.length?'就绪 · 部分素材加载失败（查看报告）':'就绪 · 点击开始游玩');
  else{
    const issues=report.script_diagnostics||[];
    notice(issues.length?issues.slice(0,4).map(issue=>`${issue.message}${issue.affected_scripts>1?`（影响 ${issue.affected_scripts} 个脚本）`:''}`).join('\n'):report.runtime_error||'此作品包含尚未支持的积木');
    status('作品暂无法运行');
  }
}
async function launch(){
  if(!playable)return;
  if(recorder&&(recorder.interrupted||!connection?.ready||!connection.repro)){
    recorder.interrupt();pause('录制已中断 · 请停止并导出');return;
  }
  if(document.hidden){pause('已暂停 · 页面切到后台');return;}
  if(connection?.ready)void connection.requestDevicePermission();
  if(!connection?.ready){
    input?.reset();
    const next=new PlayerConnection(),devicePermission=next.requestDevicePermission();
    // A new VM must not inherit other scenes' pen surfaces, transitions or video
    // state. Keep the stopped final image until this fresh start; resume skips it.
    for(const animation of canvas.getAnimations?.()||[])animation.cancel();
    await renderer.load(project,({completed,total})=>feedback.progress('重新加载图片 / 视频…',completed,total));renderer.render();fitStage();
    feedback.progress('正在连接运行时…');
    connection=next;await next.open(project,backend);void devicePermission;sendCostumes=true;overlay.reset();
    // Opt-in observation before any scheduler tick, not an extra simulation frame.
    if(new URLSearchParams(location.search).has('compare'))window.nekoCompareZero=await next.snapshot();
    epoch++;lastFrame=null;totalUpdates=0;
  }
  if(document.hidden){pause('已暂停 · 页面切到后台');return;}
  clearKeys();resetMeter();running=true;lastTick=performance.now();nextDue=lastTick;queueMicrotask(pump);
  if(!recorder){audio.resume();renderer.pauseMedia(false);}extension?.reportStatus('connected');
  status(recorder?'录制中 · 固定 60 Hz / 种子 1':'运行中');focusStage();syncControls();
}
function focusStage(){
  const control=$('#stage-box').querySelector('.neko-ask input,.neko-ask button,.neko-stage-dialog button');
  (control||canvas).focus({preventScroll:true});
}
async function action(work){
  if(busy)return;busy=true;syncControls();
  try{await work();}catch(error){pause('操作失败 · 可重试或重新导入');notice(error);}
  finally{feedback.finish();busy=false;syncControls();}
}
async function importFile(file){
  if(!file||recorder)return;
  await action(async()=>{
    pause('正在导入…');
    feedback.progress(`正在读取 ${file.name}…`);
    let value;
    try{value=JSON.parse((await file.text()).replace(/^\uFEFF/,''));}
    catch(error){throw Error(`无法读取作品「${file.name}」：${error.message}`);}
    await importValue(value);
  });
}
async function importValue(value){
  feedback.progress('正在检查作品兼容性…');
  await install(await api('import-player',value));
  if(playable)await launch();
}
// A same-origin page (the online compiler) can hand over a project object.
window.addEventListener('message',event=>{
  if(event.origin!==location.origin||event.data?.type!=='nekoc-play'||app||recorder)return;
  void action(async()=>{pause('正在导入…');await importValue(event.data.project);});
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
    if(recorder?.full)pause('录制已达上限 · 请停止并导出');
  }catch(error){
    if(token!==epoch)return;
    recorder?.interrupt();
    epoch++;connection?.close();connection=null;input?.reset();overlay?.reset();audio.stop();lastFrame=null;$('#timer').hidden=true;
    pause(recorder?'录制已中断 · 请停止并导出':'运行已中断 · 可重新开始');feedback.runtimeError(error);
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
  $('#gpu-time').textContent=renderer.stats.gpuMs==null?'不可用':`${renderer.stats.gpuMs.toFixed(2)} ms`;
  $('#roundtrip').textContent=lastFrame?`${roundtripMs.toFixed(2)} ms`:'—';
  $('#render-size').textContent=project?`${canvas.width}×${canvas.height}`:'—';
  $('#timer').hidden=!lastFrame?.timer_visible;
  if(lastFrame?.timer_visible)$('#timer').textContent=`计时器 ${lastFrame.timer.toFixed(2)}`;
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
    status(`已导出 ${bundle.timeline.length} 帧${bundle.diagnostics.interrupted?'（中断前已确认片段）':''}`);return;
  }
  if(playerExtensions.schemas().length)throw Error('复现录制暂不支持远程扩展，请先停用扩展');
  await closeRuntime();
  await renderer.load(project,({completed,total})=>feedback.progress('准备确定性录制…',completed,total));renderer.render();fitStage();
  renderer.pauseMedia();
  input.mouse={x:0,y:0};
  const next=new PlayerConnection();connection=next;
  next.onFailure=error=>{
    if(connection!==next||!recorder)return;
    recorder.interrupt();epoch++;pause('录制已中断 · 请停止并导出');notice(error.message);
  };
  try{
    const ready=await next.open(project,backend,{seed:'1'});
    recorder=new ReproRecorder(ready.repro,await next.reproStatus(),input.queueStats);
    if(!next.ready)throw Error('录制会话已断开');
  }catch(error){next.close();connection=null;throw error;}
  epoch++;lastFrame=null;totalUpdates=0;sendCostumes=false;overlay.reset();
  await launch();
});
$('#stop').onclick=()=>action(async()=>{
  if(recorder)return;
  await closeRuntime();lastFrame=null;totalUpdates=0;$('#timer').hidden=true;status('已停止 · 点击开始将从头运行');
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
  }catch{shell.classList.add('fullscreen-fallback');notice('当前浏览器无法进入全屏，已切换为窗口内全屏；可点退出或按 Esc。');}
  syncFullscreen();if(running)focusStage();
};
function syncFullscreen(){
  const fallback=shell.classList.contains('fullscreen-fallback'),active=!!document.fullscreenElement||fallback;
  document.body.classList.toggle('fullscreen-fallback-active',fallback);
  $('#fullscreen').setAttribute('aria-pressed',String(active));$('#fullscreen').setAttribute('aria-label',active?'退出全屏':'全屏游玩');
  $('#fullscreen').title=active?'退出全屏':'全屏游玩';$('#fullscreen span').textContent=active?'退出全屏':'全屏';fitStage();
}
document.addEventListener('fullscreenchange',()=>{clearKeys();syncFullscreen();});
window.addEventListener('keydown',event=>{
  if(event.key==='Escape'&&shell.classList.contains('fullscreen-fallback')){shell.classList.remove('fullscreen-fallback');clearKeys();syncFullscreen();}
});
window.addEventListener('pointerdown',()=>audio.unlock(),{capture:true});
window.addEventListener('keydown',()=>audio.unlock(),{capture:true});
document.addEventListener('visibilitychange',()=>{if(document.hidden&&running)pause('已暂停 · 页面切到后台');});
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
  new VirtualControls(input,$('#virtual-controls'),$('#virtual-toggle'),visible=>shell.classList.toggle('virtual-controls-visible',visible));
  overlay=new StageOverlay($('#stage-box'),renderer,event=>{if(recorder){recorder.warnings.add('omitted_inputs');notice('录制模式仅接收舞台键鼠输入；问答、云服务和外部输入未录制。');return false;}const accepted=input.push(event);if(accepted)queueMicrotask(()=>{if(running)focusStage();});return accepted;});
  renderer.onError=message=>{if(!busy)pause('渲染提示');feedback.resourceError(message);};
  feedback.mode(bundled||wasm?'wasm':extension?null:'rust');
  backend=bundled?await bundled.createBackend():extension?await extension.backend():wasm?wasmBackend():httpBackend(location.origin);
  feedback.mode(backend.kind);
  unsubscribeProgress=backend.subscribeProgress?.(({label,completed,total})=>feedback.progress(label,completed,total));
  await backend.ready;unsubscribeProgress?.();unsubscribeProgress=null;
  // A static wasm page starts empty unless ?src= names a project URL.
  const source=bundled?null:extension||backend.kind==='rust'?'/api/project':params.get('src');
  if(bundled||source){
    feedback.progress('正在读取作品…');
    const value=bundled?await bundled.loadProject():extension?await extension.loadWork(backend,status):await(async()=>{
      const response=await fetch(new URL(source,location.href),{signal:AbortSignal.timeout(60000)});
      if(!response.ok)throw Error(`读取作品失败：HTTP ${response.status}`);
      return response.json();
    })();
    feedback.progress('正在检查作品兼容性…');
    await install(await api('import-player',value));
    if(!bundled&&(extension||app)&&playable)await launch();
  }
}catch(error){notice(`读取作品失败：${error.message}`);status(extension?'连接或载入失败 · 请重试': '读取失败 · 请导入作品重试');extension?.reportStatus('failed');}
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
  if(!connection?.ready)throw Error('运行时尚未连接');
  if(observing)throw Error('已有状态读取等待响应');
  observing=true;
  try{await inFlight;return await connection.snapshot();}
  finally{observing=false;pump();}
};
