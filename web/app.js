import {StageRenderer,decodeFrame,sensesColor} from './renderer.js';
import {PlayerConnection} from './player.js';
import {playerExtensions} from './extensions.js';
import {needsMicrophone} from './kn-microphone.js';
import {ProjectAudio} from './audio.js';
import {StageInput} from './input.js';
import {StageOverlay} from './overlay.js';
import {t,blockLabel,fieldLabel,initI18n} from './i18n.js';
const audio=new ProjectAudio(message=>log(message,true),id=>input?.push({kind:'audio_done',id}));
let overlay=null,sendCostumes=false;
window.addEventListener('pointerdown',()=>audio.unlock(),{capture:true});
window.addEventListener('keydown',()=>audio.unlock(),{capture:true});
window.addEventListener('pagehide',()=>{player?.close();audio.stop();});
const $=s=>document.querySelector(s);
const palette=[
  ['on_running_group_activated','event',{}],
  ['self_go_forward','motion',{steps:10}],
  ['self_rotate','motion',{degrees:24}],
  ['self_move_to','motion',{x:0,y:0}],
  ['repeat_n_times','control',{times:15}],
  ['repeat_forever','control',{}],
  ['warp','control',{}],
  ['wait','control',{time:1}],
  ['self_pen_down','pen',{}],
  ['self_pen_up','pen',{}],
  ['self_set_pen_color','pen',{}],
  ['self_set_pen_size','pen',{size:4}],
  ['clear_drawing','pen',{}],
];
// Flat category colours: [fill, accent bar, ink].
const colors={event:['#fdf1c7','#e9b824','#6b4e00'],motion:['#dcebfb','#3d8bd9','#1c4a7a'],control:['#ece4fb','#8b62d9','#43277a'],pen:['#d9f2e2','#2f9e5b','#1d5e37']};
const symbols={event:'⚑',motion:'↗',control:'↻',pen:'⌁'};
let project,owner='',selected='',dirty=false,undo=[],redo=[],renderer,input;
let running=false,started=false,inFlight=null,epoch=0,lastTick=0,lastFrame=null,lastBytes=0;
let player=null,starting=null;
const timerLabel=make('div','stage-timer');timerLabel.hidden=true;$('#stage').parentElement.append(timerLabel);
let pipeline={roundtripMs:0,decodeMs:0,completedFrames:0,transport:'websocket'};
let fps=0,frames=0,fpsStart=performance.now(),lastMonitor=0,history=[];
let categoryFilter='';
let runtimeState='ready',dirtyState='localProject',compileMessage={key:'waiting',values:{}};
function setCompile(key,values={}){compileMessage={key,values};$('#compile-status').textContent=t(key,values);}
initI18n(()=>{
  if(project){renderEditor();renderPalette();}
  $('#dirty').textContent=t(dirtyState);$('#compile-status').textContent=t(compileMessage.key,compileMessage.values);state(runtimeState);
});
$('#compile-status').textContent=t('waiting');$('#dirty').textContent=t(dirtyState);state(runtimeState);
for(const el of document.querySelectorAll('.category-pills button')){
  el.onclick=()=>{categoryFilter=el.dataset.category;for(const item of document.querySelectorAll('.category-pills button')){item.classList.toggle('chosen',item===el);item.setAttribute('aria-pressed',String(item===el));}renderPalette();};
}
const api=async(path,data)=>{
  const response=await fetch(`/api/${path}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data??{})});
  if(!response.ok){const value=await response.json();throw Error(value.error||`HTTP ${response.status}`);}
  return response;
};
function log(message,error=false){const node=document.createElement('p');node.textContent=`${error?'!':'›'} ${message}`;if(error)node.className='error';$('#logs .muted')?.remove();$('#logs').append(node);while($('#logs').children.length>100)$('#logs').firstChild.remove();$('#logs').scrollTop=$('#logs').scrollHeight;}
function notify(message){const el=$('#toast');el.textContent=message;el.classList.add('show');clearTimeout(notify.timer);notify.timer=setTimeout(()=>el.classList.remove('show'),3000);}
function markDirty(){dirty=true;dirtyState='unsaved';$('#dirty').textContent=t(dirtyState);setCompile('changed');}
function transaction(fn){if(started){notify(t('stopBeforeEdit'));return;}const before=JSON.stringify(project);fn();if(JSON.stringify(project)!==before){undo.push(before);if(undo.length>80)undo.shift();redo=[];markDirty();}renderEditor();}
function find(id,value=entity()?.nekoBlockJsonList){if(!value||typeof value!=='object')return null;if(value.id===id&&value.type)return value;for(const v of Object.values(value)){const b=find(id,v);if(b)return b;}return null;}
function entity(){return project.actors?.actorsDict?.[owner]||project.scenes?.scenesDict?.[owner];}
function kitten4(value=project){return Object.hasOwn(value,'_nekocKitten4');}
function extension(value=project){return kitten4(value)?'bcm':'bcmkn';}
function chooseOwner(){if(!entity())owner=project.scenes?.scenesDict?.[project.scenes.currentSceneId]?.actorIds?.find(id=>project.actors.actorsDict[id])||project.scenes.currentSceneId||Object.keys(project.actors.actorsDict)[0]||Object.keys(project.scenes.scenesDict)[0]||'';}
function repair(block,parent=null){block.parent_id=parent;for(const map of [block.inputs,block.statements])for(const child of Object.values(map||{}))repair(child,block.id);if(block.next)repair(block.next,block.id);}
function newBlock([type,,args]){const block={id:crypto.randomUUID(),type,fields:{},inputs:{}};for(const [name,value]of Object.entries(args))block.inputs[name]={id:crypto.randomUUID(),type:'math_number',fields:{NUM:value}};if(type==='self_set_pen_color')block.fields.color='#608fee';if(['repeat_n_times','repeat_forever','warp'].includes(type))block.statements={};return block;}
function make(tag,cls,text){const el=document.createElement(tag);if(cls)el.className=cls;if(text!==undefined)el.textContent=text;return el;}
function category(type){return palette.find(b=>b[0]===type)?.[1]||(type==='on_keydown'?'event':type==='stamp'||type.includes('_pen_')?'pen':type.startsWith('self_')?'motion':'control');}
function renderEntities(){
  for(const [selector,dict,scene]of [['#scenes',project.scenes.scenesDict,true],['#sprites',project.actors.actorsDict,false]]){
    const root=$(selector);root.replaceChildren();
    for(const [id,value]of Object.entries(dict)){
      const button=make('button',`entity ${owner===id?'active':''}`),thumb=make('span','thumb');
      const style=project.styles?.stylesDict?.[value.currentStyleId];if(style?.url){const img=make('img');img.src=style.url;img.alt='';thumb.append(img);}else thumb.textContent=scene?'▧':'◉';
      const name=make('span','',value.screenName||value.name||id);name.append(make('span','sub',t(scene?'scene':'sprite')));button.setAttribute('aria-pressed',String(owner===id));button.dataset.owner=id;button.append(thumb,name);
      button.onclick=()=>{
        if(!started){const sceneId=scene?id:Object.entries(project.scenes.scenesDict).find(([,s])=>s.actorIds?.includes(id))?.[0];
          if(sceneId&&sceneId!==project.scenes.currentSceneId){transaction(()=>project.scenes.currentSceneId=sceneId);void renderer.load(project).catch(handleError);}}
        owner=id;selected='';renderEditor();document.querySelector(`[data-owner="${CSS.escape(id)}"]`)?.focus();
      };root.append(button);
    }
  }
}
function editInput(value,onChange,type='text'){
  const input=make('input');input.value=value;input.type=type;input.disabled=started;
  input.onclick=e=>e.stopPropagation();input.onchange=()=>transaction(()=>onChange(type==='number'?Number(input.value):input.value));return input;
}
function expressionText(b,depth=0){
  if(depth>12)return '…';if(b.type==='math_number')return String(b.fields?.NUM??0);
  if(b.type==='variables_get')return b.fields?.variable||fieldLabel('variable');
  const args=b.inputs||{},op=b.fields?.type||b.fields?.OP||'';
  if(args.A&&args.B)return `(${expressionText(args.A,depth+1)} ${{add:'+',minus:'−',multiply:'×',divide:'÷',EQ:'=',LT:'<',GT:'>'}[op]||op} ${expressionText(args.B,depth+1)})`;
  if(args.num)return `${op}(${expressionText(args.num,depth+1)})`;
  return blockLabel(b.type);
}
function blockNode(block,depth=0){
  if(depth>128)return make('div','',t('tooDeep'));
  const cat=category(block.type),[bg,border,ink]=colors[cat];
  const node=make('div',`block ${block.type.startsWith('on_')?'hat':''} ${selected===block.id?'selected':''}`);node.dataset.block=block.id;
  node.style.setProperty('--bg',bg);node.style.setProperty('--border',border);node.style.setProperty('--ink',ink);
  const select=()=>{selected=block.id;syncBlockSelection();};
  node.onclick=e=>{e.stopPropagation();select();};
  const title=make('button','block-label'),symbol=make('span','symbol',symbols[cat]);symbol.setAttribute('aria-hidden','true');title.type='button';title.setAttribute('aria-pressed',String(selected===block.id));title.onclick=e=>{e.stopPropagation();select();};title.append(symbol,make('span','',blockLabel(block.type)));node.append(title);
  const fields=make('div','fields');
  for(const [key,value]of Object.entries(block.fields||{})){
    if(typeof value==='object')continue;
    const label=make('label','',fieldLabel(key));const input=editInput(value,v=>block.fields[key]=v,key==='color'?'color':typeof value==='number'?'number':'text');label.append(input);fields.append(label);
  }
  for(const [key,value]of Object.entries(block.inputs||{})){
    if(['math_number','text'].includes(value.type)){
      const f=value.type==='text'?'TEXT':'NUM',label=make('label','',fieldLabel(key)),input=editInput(value.fields?.[f]??'',v=>value.fields[f]=v,value.type==='text'?'text':'number');
      if(value.type==='text')input.className='text-value';label.append(input);fields.append(label);
    }else{const label=make('div','expression-field',fieldLabel(key)),details=make('details','expression'),summary=make('summary','',expressionText(value));
      summary.onclick=e=>e.stopPropagation();details.append(summary);
      details.ontoggle=()=>{if(details.open&&details.children.length===1)details.append(blockNode(value,depth+1));};
      label.append(details);fields.append(label);}
  }
  if(fields.children.length)node.append(fields);
  const branches=block.statements||(['repeat_n_times','repeat_forever','warp'].includes(block.type)?{DO:null}:{});
  for(const [key,value]of Object.entries(branches)){
    const branch=make('div','branch');branch.append(make('div','branch-label',key==='DO'?t('branch'):key));
    if(value)renderChain(branch,value,depth+1);
    else branch.append(make('span','branch-label',t('branchHint')));
    node.append(branch);
  }
  if(block.statements&&!Object.keys(block.statements).length){const empty=make('div','branch',t('branchHint'));empty.style.fontSize='10px';node.append(empty);}
  return node;
}
function renderChain(parent,block,depth){let n=0;while(block&&n++<5000){parent.append(blockNode(block,depth));block=block.next;}}
function syncBlockSelection(){for(const node of document.querySelectorAll('[data-block]')){const active=node.dataset.block===selected;node.classList.toggle('selected',active);node.querySelector(':scope > .block-label').setAttribute('aria-pressed',String(active));}}
function renderBlocks(){const root=$('#blocks');root.replaceChildren();for(const block of entity()?.nekoBlockJsonList||[]){const stack=make('div','stack');renderChain(stack,block,0);root.append(stack);}if(!root.children.length)root.append(make('p','context-note',t('emptyBlocks')));}
function renderProperties(){
  const root=$('#properties');root.replaceChildren();const a=entity();if(!a)return;
  const grid=make('div','property-grid');
  for(const [name,value,set]of [['X',a.position?.x??0,v=>{a.position??={};a.position.x=v;}],['Y',a.position?.y??0,v=>{a.position??={};a.position.y=v;}],[fieldLabel('size'),a.scale??100,v=>a.scale=v]]){
    const label=make('label','',name);label.append(editInput(value,v=>{set(v);void renderer.load(project).catch(e=>log(e.message,true));},'number'));grid.append(label);
  }root.append(grid);
}
function renderEditor(){
  const active=document.activeElement,block=active?.closest('[data-block]'),property=active?.closest('#properties');
  const focusBlock=block?.dataset.block,focusIndex=block?[...block.querySelectorAll('input')].indexOf(active):property?[...property.querySelectorAll('input')].indexOf(active):-1;
  $('#project-name').value=project.projectName||'Untitled';$('#project-version').textContent=kitten4()?'Kitten4 · BCM':project.version||'?';$('#owner-name').textContent=entity()?.screenName||entity()?.name||t('stage');
  $('#save').textContent=t('export',{format:extension()});
  $('#json-note').textContent=t(kitten4()?'k4JsonNote':'jsonNote');
  $('#stage-size').textContent=`${project.stageSize?.width||900} × ${project.stageSize?.height||562}`;
  $('#undo').disabled=!undo.length||started;$('#redo').disabled=!redo.length||started;
  renderEntities();renderBlocks();renderProperties();
  if(focusIndex>=0){const root=focusBlock?document.querySelector(`[data-block="${CSS.escape(focusBlock)}"]`):$('#properties');root?.querySelectorAll('input')[focusIndex]?.focus({preventScroll:true});}
}
function renderPalette(){
  const root=$('#palette');root.replaceChildren();for(const item of palette){if(categoryFilter&&item[1]!==categoryFilter)continue;const name=blockLabel(item[0]),query=$('#search').value.toLowerCase();if(!name.toLowerCase().includes(query)&&!item[0].includes(query))continue;
    const button=make('button','palette-block',`${symbols[item[1]]}  ${name}`);button.setAttribute('aria-label',name);button.style.setProperty('--accent',colors[item[1]][2]);button.disabled=started;
    button.onclick=()=>transaction(()=>{
      const b=newBlock(item),target=find(selected);const a=entity();a.nekoBlockJsonList??=[];
      if(!target||b.type.startsWith('on_'))a.nekoBlockJsonList.push(b);
      else if(target.statements&&!target.statements.DO)target.statements.DO=b;
      else{let tail=target;while(tail.next)tail=tail.next;tail.next=b;}
      for(const block of a.nekoBlockJsonList)repair(block);selected=b.id;
    });root.append(button);
  }
}
function compiled(stats){setCompile('compiled',{kind:kitten4()?'Kitten4 · ':''});$('#instruction-count').textContent=`${stats.instructions} OPS · ${stats.expression_ops} EXPR`;}
async function start(resume=true){
  if(starting)return starting;
  // Request inside the play gesture, before the project upload or a pending
  // frame can consume transient browser user activation.
  if(!started)player=new PlayerConnection();
  if(resume)void player?.requestDevicePermission?.();
  starting=startRuntime(resume).catch(error=>{if(!started)player?.close();throw error;}).finally(()=>{starting=null;});return starting;
}
async function startRuntime(resume=true){
  if(running)return;await inFlight;
  if(!started){await api('project',project);audio.load(project);const ready=await player.open(playerExtensions.schemas().length||needsMicrophone(project)?project:null);compiled(ready.stats);started=true;sendCostumes=true;overlay?.reset();epoch++;input.reset();lastFrame=null;lastBytes=0;history=[];pipeline.completedFrames=0;renderEditor();renderPalette();}
  frames=0;fpsStart=performance.now();fps=0;
   running=resume;if(resume){audio.resume();renderer.pauseMedia(false);}else{audio.pause();renderer.pauseMedia();}lastTick=performance.now();state(resume?'running':'paused');$('#stage').focus();
}
function state(key){runtimeState=key;$('#runtime-state').replaceChildren(make('i'),document.createTextNode(t(key)));$('#run').disabled=running;}
async function stop(){await starting;running=false;audio.stop();epoch++;player?.close();player=null;await inFlight;await api('stop');started=false;input.reset();overlay?.reset();timerLabel.hidden=true;await renderer.load(project);renderEditor();renderPalette();state('ready');}
async function nextFrame(dt){
  const token=epoch,start=performance.now();let buffer;
  try{const costumes=sendCostumes?renderer.costumeInfo(sensesColor(project)):undefined;sendCostumes=false;
   buffer=await player.frame({dt,...input.take(),costumes,videos:renderer.videoInfo(),utc_offset:-new Date().getTimezoneOffset()});}catch(error){if(token!==epoch)return;throw error;}if(token!==epoch)return;
  pipeline.roundtripMs=performance.now()-start;
  const decodeStart=performance.now(),{frame,lines}=decodeFrame(buffer);pipeline.decodeMs=performance.now()-decodeStart;lastBytes=buffer.byteLength;lastFrame=frame;
   renderer.apply(frame,lines);overlay?.apply(frame);audio.apply(frame);player?.applyFrame(frame);for(const message of frame.logs)log(message);
   timerLabel.hidden=!frame.timer_visible;if(frame.timer_visible)timerLabel.textContent=t('timer',{value:frame.timer.toFixed(2)});
  pipeline.completedFrames++;frames++;
}
function handleError(error){running=false;player?.pauseDevice();audio.pause();renderer?.pauseMedia();state('paused');log(error.message,true);compileMessage={key:error.message,values:{}};$('#compile-status').textContent=error.message;notify(error.message);}
function monitor(now){
  if(now-fpsStart>=1000){fps=frames*1000/(now-fpsStart);frames=0;fpsStart=now;}
  if(now-lastMonitor<250)return;lastMonitor=now;
  $('#vm-time').textContent=lastFrame?(Number(lastFrame.execute_us)/1000).toFixed(2):'—';$('#render-time').textContent=renderer.stats.submitMs.toFixed(2);$('#fps').textContent=fps?fps.toFixed(0):'—';
  $('#ops').textContent=lastFrame?.instructions.toLocaleString()||'0';$('#bytes').textContent=lastBytes>1024?`${(lastBytes/1024).toFixed(1)} KB`:`${lastBytes} B`;$('#draws').textContent=renderer.stats.drawCalls;
  $('#roundtrip').textContent=`${pipeline.roundtripMs.toFixed(2)} ms`;$('#decode-time').textContent=`${pipeline.decodeMs.toFixed(2)} ms`;
  $('#gpu-time').textContent=renderer.stats.gpuMs==null?t('unavailable'):`${renderer.stats.gpuMs.toFixed(2)} ms`;
  history.push(lastFrame?Number(lastFrame.execute_us)/1000:0);if(history.length>80)history.shift();
  const canvas=$('#chart'),ctx=canvas.getContext('2d'),w=canvas.width,h=canvas.height;ctx.clearRect(0,0,w,h);ctx.strokeStyle='#e3e3e3';ctx.lineWidth=1;
  for(let y=12;y<h;y+=16){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke();}
  ctx.beginPath();history.forEach((v,i)=>{const x=i/79*w,y=h-5-Math.min(v,8)/8*(h-10);if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);});ctx.strokeStyle='#1a1a1a';ctx.lineWidth=2;ctx.stroke();
}
function loop(now){
  if(running&&!inFlight){const dt=Math.min((now-lastTick)/1000,.25);lastTick=now;inFlight=nextFrame(dt).catch(handleError).finally(()=>{inFlight=null;});}
  renderer.render();overlay?.update();renderer.collectGpuTimes();monitor(now);requestAnimationFrame(loop);
}
async function loadProject(value){
  await starting;
  const report=await(await api('import',value)).json();
  running=false;audio.stop();epoch++;player?.close();player=null;await inFlight;
  player?.close();player=null;input.reset();$('#logs').replaceChildren();
   started=false;lastFrame=null;lastBytes=0;timerLabel.hidden=true;pipeline.completedFrames=0;state('ready');
   project=report.project;owner='';chooseOwner();selected='';undo=[];redo=[];dirty=false;dirtyState='localProject';$('#dirty').textContent=t(dirtyState);
  renderEditor();renderPalette();await renderer.load(project);
  if(!$('#json-panel').hidden)$('#json-source').value=JSON.stringify(project,null,2);
   const counts=report.inspection.counts;log(t('loaded',{kind:kitten4()?'Kitten4 .bcm':`.bcmkn ${project.version||''}`,...counts}));
   if(!report.validation.ok)log(t('validation',{count:report.validation.issues.length}),true);
  if(report.fast_runtime_ready)compiled(report.stats);else{
     setCompile('partialVm',{kind:kitten4()?'Kitten4 ':''});$('#instruction-count').textContent=`${Object.keys(report.block_types).length} BLOCK TYPES`;
     for(const issue of report.script_diagnostics.slice(0,30))log(`[${issue.owner}] ${issue.message}${issue.affected_scripts>1?t('affected',{count:issue.affected_scripts}):''}`,true);
    if(!report.script_diagnostics.length)log(report.runtime_error,true);
  }
  window.nekoImportReport=report;
}
$('#run').onclick=()=>start().catch(handleError);
$('#pause').onclick=()=>{running=false;player?.pauseDevice();audio.pause();renderer.pauseMedia();input.release();state('paused');};
$('#stop').onclick=()=>stop().catch(handleError);
$('#step').onclick=async()=>{const button=$('#step');if(button.disabled)return;button.disabled=true;
   try{running=false;audio.pause();renderer.pauseMedia();await start(false);running=false;audio.pause();renderer.pauseMedia();await inFlight;inFlight=nextFrame(1/60);await inFlight;inFlight=null;state('stepped');}
  catch(e){inFlight=null;handleError(e);}
  finally{running=false;audio.pause();renderer.pauseMedia();button.disabled=false;}
};
$('#open').onclick=()=>$('#file').click();
async function openFile(file){if(!file)return;if(dirty&&!confirm(t('confirmImport')))return;
  const button=$('#open');button.disabled=true;button.textContent=t('importing');
  try{await loadProject(JSON.parse((await file.text()).replace(/^\uFEFF/,'')));notify(t('imported',{name:file.name}));}
  finally{button.disabled=false;button.textContent=t('importStudio');}
}
$('#file').onchange=async e=>{try{await openFile(e.target.files[0]);}catch(e){handleError(e);}finally{$('#file').value='';}};
window.addEventListener('dragover',e=>{if(e.dataTransfer.types.includes('Files')){e.preventDefault();document.body.classList.add('file-drag');}});
window.addEventListener('dragleave',e=>{if(!e.relatedTarget)document.body.classList.remove('file-drag');});
window.addEventListener('drop',e=>{e.preventDefault();document.body.classList.remove('file-drag');void openFile(e.dataTransfer.files[0]).catch(handleError);});
$('#save-packed').onclick=async()=>{const button=$('#save-packed'),value=JSON.parse(JSON.stringify(project));button.disabled=true;
  try{
    if(extension(value)!=='bcmkn')throw Error(t('packedOnlyKn'));
    const {project:packed,report}=await(await api('export-packed',value)).json();
    if(!report.lists.length){notify(t('noPacked'));log(t('packedSkipped',{items:report.skipped.map(([n,r])=>`${n} ${r}`).join(', ')}));return;}
    const url=URL.createObjectURL(new Blob([JSON.stringify(packed)],{type:'application/json'}));const a=make('a');a.href=url;a.download=`${value.projectName||'Untitled'}.bcmkn`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    const mb=n=>n>=1048576?`${(n/1048576).toFixed(1)} MB`:`${Math.max(1,Math.round(n/1024))} KB`;
    for(const list of report.lists)log(t('packedList',{name:list.name,count:list.items,before:mb(list.original_bytes),after:mb(list.packed_bytes)}));
    notify(t('packedDone',{before:mb(report.original_bytes),after:mb(report.packed_bytes)}));
  }catch(error){notify(error.message);log(error.message,true);}
  finally{button.disabled=false;}
};
$('#save').onclick=async()=>{const button=$('#save'),snapshot=JSON.stringify(project),value=JSON.parse(snapshot);button.disabled=true;
  try{const exported=await(await api('export',value)).json();const url=URL.createObjectURL(new Blob([JSON.stringify(exported,null,2)],{type:'application/json'}));const a=make('a');a.href=url;a.download=`${value.projectName||'Untitled'}.${extension(value)}`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);if(JSON.stringify(project)===snapshot){dirty=false;dirtyState='exported';$('#dirty').textContent=t(dirtyState);}notify(t('exportDone',{format:extension(value)}));}
  catch(e){handleError(e);}finally{button.disabled=false;}
};
$('#project-name').onchange=e=>transaction(()=>project.projectName=e.target.value);
$('#undo').onclick=()=>{if(!undo.length||started)return;redo.push(JSON.stringify(project));project=JSON.parse(undo.pop());markDirty();selected='';chooseOwner();renderEditor();if(!$('#json-panel').hidden)$('#json-source').value=JSON.stringify(project,null,2);void renderer.load(project).catch(handleError);};
$('#redo').onclick=()=>{if(!redo.length||started)return;undo.push(JSON.stringify(project));project=JSON.parse(redo.pop());markDirty();selected='';chooseOwner();renderEditor();if(!$('#json-panel').hidden)$('#json-source').value=JSON.stringify(project,null,2);void renderer.load(project).catch(handleError);};
$('#search').oninput=renderPalette;$('#deselect').onclick=()=>{selected='';syncBlockSelection();};$('#clear-console').onclick=()=>$('#logs').replaceChildren();
const tabs=[...document.querySelectorAll('[data-tab]')];
function activateTab(button){
  const enteringJson=button.dataset.tab==='json'&&$('#json-panel').hidden;
  for(const tab of tabs){const active=tab===button;tab.classList.toggle('active',active);tab.setAttribute('aria-selected',String(active));tab.tabIndex=active?0:-1;}
  const json=button.dataset.tab==='json';$('#blocks').hidden=json;$('#json-panel').hidden=!json;
  if(enteringJson)$('#json-source').value=JSON.stringify(project,null,2);
}
for(const [index,button]of tabs.entries()){
  button.onclick=()=>activateTab(button);
  button.onkeydown=event=>{
    const next=event.key==='Home'?0:event.key==='End'?tabs.length-1:event.key==='ArrowRight'?(index+1)%tabs.length:event.key==='ArrowLeft'?(index+tabs.length-1)%tabs.length:null;
    if(next===null)return;event.preventDefault();tabs[next].focus();activateTab(tabs[next]);
  };
}
$('#apply-json').onclick=async()=>{if(started||starting){notify(t('stopBeforeEdit'));return;}const button=$('#apply-json');button.disabled=true;
  try{const value=JSON.parse($('#json-source').value);await api('project',value);transaction(()=>{project=value;chooseOwner();});await renderer.load(project);notify(t('jsonApplied'));}
  catch(e){handleError(e);}finally{button.disabled=false;}
};
window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue='';}});
try{renderer=new StageRenderer($('#stage'));input=new StageInput($('#stage'),renderer,()=>running,message=>log(message,true));overlay=new StageOverlay($('#stage').parentElement,renderer,event=>input.push(event));renderer.onError=message=>log(message,true);await loadProject(await(await fetch('/api/project')).json());requestAnimationFrame(loop);}catch(e){handleError(e);if(renderer)requestAnimationFrame(loop);}
// Read-only diagnostics for local performance/renderer verification.
window.nekoDiagnostics=()=>({renderer:{...renderer?.stats},sprites:renderer?.sprites,frame:lastFrame,bytes:lastBytes,running,started,pipeline:{...pipeline},framebuffer:[renderer?.canvas.width,renderer?.canvas.height]});
