import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {HEALTH_CATEGORIES,HEALTH_PAGE_SIZE,HealthReportState,HealthReportView,healthLocation,resolveHealthTarget,healthBlockPath,healthPage} from '../web/health-report.js';

const LF=String.fromCharCode(10),CRLF=String.fromCharCode(13,10);
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const item=(extra={})=>({category:'unverified',code:'unknown.block',scene:'s2',scene_name:'第二场景',owner:'a2',owner_name:'角色二',owner_kind:'actor',block:'literal[0].id',block_type:'math_number',impact:'尚无语义证据',evidence:'未进行官方对照',...extra});
const report=(extra={})=>({schema_version:1,format:'kitten-n',project_name:'中文作品',summary:{preserve:1,executable:0,approximate:0,unverified:1,unsupported:0},items:[item()],text:`作品体检：中文作品${CRLF}尚未验证：1${LF}`,...extra});
function projectFixture(){return {projectName:'原项目',version:'0.27.4',scenes:{currentSceneId:'s1',scenesDict:{s1:{name:'第一场景',actorIds:['a1'],nekoBlockJsonList:[]},s2:{name:'第二场景',actorIds:['a2'],nekoBlockJsonList:[]}}},actors:{actorsDict:{a1:{name:'角色一',nekoBlockJsonList:[]},a2:{name:'角色二',nekoBlockJsonList:[{id:'root',type:'console_log',inputs:{VALUE:{id:'expression',type:'operator',inputs:{A:{id:'literal[0].id',type:'math_number',fields:{NUM:1}}}}}}]}}},procedures:{proceduresDict:{p1:{name:'绘图过程',nekoBlockJsonList:[{id:'proc-block',type:'self_go_forward'}]}}}};}

test('health categories preserve their five independent labels and unknown data stays explicit',()=>{
  assert.deepEqual(HEALTH_CATEGORIES.map(([,label])=>label),['能保留导出','能执行','语义近似','尚未验证','不支持']);
  assert.match(healthLocation(item()).owner,/角色二/);
  assert.equal(healthLocation({owner_kind:'procedure',owner:'p1'}).owner,'自制积木：p1');
  for(const value of Object.values(healthLocation()))assert.match(value,/未提供/);
});

test('all large-report rows can be visited through bounded pages and category filters',()=>{
  const source=report({items:Array.from({length:123},(_,index)=>item({code:String(index),category:index%2?'unsupported':'unverified'}))});
  const seen=[];for(let p=0;p<3;p++){const page=healthPage(source,p);assert.ok(page.items.length<=HEALTH_PAGE_SIZE);seen.push(...page.items.map(i=>i.code));}
  assert.equal(new Set(seen).size,123);assert.equal(seen.at(-1),'122');
  assert.equal(healthPage(source,999).page,2);assert.equal(healthPage(source,-1).page,0);
  assert.equal(healthPage(source,0,'unsupported').total,61);assert.equal(healthPage(source,1,'unsupported').items.length,11);
  assert.equal(healthPage(null).total,0);assert.equal(healthPage(source,0,'absent').start,0);
});

test('target resolution selects actors, scenes and procedures without modifying the project',()=>{
  const project=projectFixture(),before=JSON.stringify(project);
  assert.equal(resolveHealthTarget(project,item()).owner,'a2');assert.equal(resolveHealthTarget(project,item()).scene,'s2');
  const proc=resolveHealthTarget(project,item({scene:null,owner:'p1',owner_kind:'procedure',block:'proc-block'}));
  assert.equal(proc.kind,'procedure');assert.equal(proc.entity.name,'绘图过程');assert.equal(proc.scene,'');
  assert.deepEqual(healthBlockPath(project.actors.actorsDict.a2,'literal[0].id'),['root','expression','literal[0].id']);
  assert.equal(resolveHealthTarget(project,item({owner:'deleted'})).owner,'s2');
  assert.equal(resolveHealthTarget(project,item({owner:'deleted',scene:null})).owner,'');
  assert.equal(resolveHealthTarget(project,item({owner:'toString',scene:null})).owner,'');assert.equal(JSON.stringify(project),before);
});

test('download is the exact Rust text and is unavailable for missing, invalid or stale reports',()=>{
  const state=new HealthReportState({getProject:()=>({}),request:async()=>report()});
  assert.equal(state.download(),null);state.replace(report());assert.equal(state.download().text,report().text);
  state.invalidate();assert.equal(state.stale,true);assert.equal(state.download(),null);
  state.replace(report({schema_version:2}));assert.equal(state.download(),null);state.replace(report({text:''}));assert.equal(state.download(),null);
  state.replace(report({format:'kitten4'}));assert.equal(state.download().text,report().text);
  state.replace(report());state.setLoading(true);assert.equal(state.download(),null);state.setLoading(false);assert.ok(state.download());
});

test('refresh sends an isolated snapshot and never replaces the editor project',async()=>{
  const project=projectFixture(),before=JSON.stringify(project),fresh=report({text:'新的 Rust 文本'});let payload;
  const state=new HealthReportState({getProject:()=>project,request:async value=>{payload=value;value.projectName='服务端修改';return fresh;}});
  state.replace(report());state.invalidate();assert.equal(await state.refresh(),true);
  assert.notEqual(payload,project);assert.equal(JSON.stringify(project),before);assert.equal(state.report,fresh);assert.equal(state.stale,false);
});

test('edit and undo revisions reject in-flight results even when content returns to its prior value',async()=>{
  const pending=deferred(),project={projectName:'A'},old=report();
  const state=new HealthReportState({getProject:()=>project,request:()=>pending.promise});state.replace(old);
  const refresh=state.refresh();project.projectName='B';state.invalidate();project.projectName='A';state.invalidate();
  pending.resolve(report({text:'不应应用'}));assert.equal(await refresh,false);assert.equal(state.report,old);assert.equal(state.stale,true);assert.equal(state.busy,false);
});

test('a late response or error cannot override a newer import or newer refresh',async()=>{
  const first=deferred(),second=deferred();let project={projectName:'old'},calls=0;
  const state=new HealthReportState({getProject:()=>project,request:()=>++calls===1?first.promise:second.promise});state.replace(report());
  const older=state.refresh();state.setLoading(true);project={projectName:'new'};const imported=report({project_name:'new'});state.replace(imported);
  const newer=state.refresh();first.reject(Error('旧请求错误'));await older;assert.equal(state.busy,true);assert.equal(state.error,'');assert.equal(state.report,imported);
  const fresh=report({text:'newest'});second.resolve(fresh);await newer;assert.equal(state.report,fresh);assert.equal(state.busy,false);
});

test('refresh failures remain visible and untracked project changes are not certified',async()=>{
  let project={projectName:'A'},pending=deferred();const old=report();
  const state=new HealthReportState({getProject:()=>project,request:()=>pending.promise});state.replace(old);state.invalidate();
  let result=state.refresh();pending.reject(Error('离线'));assert.equal(await result,false);assert.match(state.error,/离线/);assert.equal(state.download(),null);
  pending=deferred();result=state.refresh();project={projectName:'B'};pending.resolve(report());assert.equal(await result,false);assert.equal(state.report,old);assert.match(state.error,/发生变化/);
});

// Minimal DOM, matching the no-dependency stand-ins in other front-end tests.
class Element {
  constructor(tag,document){this.tagName=tag.toUpperCase();this.ownerDocument=document;this.children=[];this.dataset={};this.attributes={};this.style={setProperty(){}};this.className='';this.hidden=false;this._text='';
    this.classList={contains:name=>this.className.split(' ').includes(name),add:name=>{if(!this.classList.contains(name))this.className+=` ${name}`;},remove:name=>{this.className=this.className.split(' ').filter(v=>v!==name).join(' ');},toggle:(name,on)=>{on??=!this.classList.contains(name);this.classList[on?'add':'remove'](name);return on;}};}
  set textContent(value){this._text=String(value);this.children=[];}
  get textContent(){return this._text+this.children.map(c=>c.textContent).join('');}
  set innerHTML(_value){throw Error('Report content must not be parsed as HTML');}
  append(...nodes){for(const node of nodes){node.parentElement=this;this.children.push(node);}}
  replaceChildren(...nodes){this._text='';this.children=[];this.append(...nodes);}
  setAttribute(name,value){this.attributes[name]=String(value);}
  getAttribute(name){return this.attributes[name];}
  get firstChild(){return this.children[0];}
  remove(){this.parentElement.children=this.parentElement.children.filter(child=>child!==this);}
  matches(selector){return selector.startsWith('.')?this.classList.contains(selector.slice(1)):selector==='[data-block]'?this.dataset.block!==undefined:selector==='[data-tab]'?!!this.dataset.tab:selector===this.tagName.toLowerCase();}
  querySelectorAll(selector){return this.children.flatMap(child=>[...(child.matches(selector)?[child]:[]),...child.querySelectorAll(selector)]);}
  focus(){this.ownerDocument.focused=this;}
  scrollIntoView(){this.scrolled=true;}
  click(){if(!this.disabled)return this.onclick?.();}
}
function documentFixture(){
  const document={createElement:tag=>new Element(tag,document),createTextNode:value=>{const node=new Element('#text',document);node.textContent=value;return node;},ids:new Map()};
  document.body=document.createElement('body');
  const html=fs.readFileSync(new URL('../web/index.html',import.meta.url),'utf8');
  for(const [,tag,id]of html.matchAll(/<([a-z]+)[^>]* id="([^"]+)"/g)){const node=document.createElement(tag);node.id=id;document.ids.set(id,node);document.body.append(node);}
  document.querySelector=selector=>document.ids.get(selector.slice(1))||null;document.querySelectorAll=selector=>document.body.querySelectorAll(selector);
  for(const tab of ['blocks','json']){const button=document.createElement('button');button.dataset.tab=tab;document.body.append(button);}
  document.ids.get('json-panel').hidden=true;document.ids.get('search').value='';return document;
}
function viewFixture(state){
  const document=documentFixture(),root=document.ids.get('health-report'),navigated=[];
  const view=new HealthReportView(root,{onRefresh:()=>{},onDownload:()=>{},onNavigate:item=>navigated.push(item)});view.render(state);
  const button=label=>root.querySelectorAll('button').find(node=>node.textContent===label);return {root,view,button,navigated};
}
test('rendered list pages through every row, filters categories, and shows all location fields safely',()=>{
  const state=new HealthReportState({getProject:()=>({}),request:async()=>null});
  state.replace(report({items:Array.from({length:123},(_,n)=>item({code:String(n),impact:'<script>unsafe</script>'}))}));
  const {root,button,navigated}=viewFixture(state);
  assert.equal(root.querySelectorAll('.health-entry').length,50);assert.ok(root.textContent.includes('1–50 / 123'));
  const entry=root.querySelectorAll('.health-entry')[0];entry.click();assert.equal(navigated[0].code,'0');
  for(const value of ['第二场景','角色二','literal[0].id','math_number','<script>unsafe</script>','未进行官方对照'])assert.ok(entry.textContent.includes(value),value);
  button('下一页').click();assert.ok(root.textContent.includes('51–100 / 123'));button('下一页').click();assert.equal(root.querySelectorAll('.health-entry').length,23);assert.ok(button('下一页').disabled);
  button('能执行 · 0').click();assert.equal(root.querySelectorAll('.health-entry').length,0);assert.match(root.textContent,/这不表示作品通过体检/);
  button('全部类别').click();assert.equal(root.querySelectorAll('.health-entry').length,50);
});

test('missing and unknown reports show no invented pass result or count',()=>{
  const state=new HealthReportState({getProject:()=>({}),request:async()=>null});let f=viewFixture(state);
  assert.match(f.root.textContent,/尚无体检数据/);assert.ok(f.button('下载文本').disabled);
  state.replace(report({summary:{},items:[item({category:'future',owner:null,scene:null,block:null})]}));f=viewFixture(state);
  assert.match(f.root.textContent,/能保留导出 · —/);assert.match(f.root.textContent,/未知类别/);assert.match(f.root.textContent,/无数据不视为通过/);
  state.replace(report({items:[]}));f=viewFixture(state);assert.match(f.root.textContent,/暂无体检条目/);
  state.invalidate();f.view.render(state);assert.match(f.root.textContent,/报告已过期/);assert.ok(f.button('下载文本').disabled);
});

async function appFixture(){
  const document=documentFixture(),calls=[],downloads=[],refreshes=[];
  const importResult=value=>({project:value,health_report:report(),inspection:{counts:{scenes:2,actors:2,styles:0,variables:0}},validation:{ok:true},fast_runtime_ready:true,stats:{instructions:0,expression_ops:0}});
  class Renderer{constructor(){this.stats={};}async load(){}pauseMedia(){}}
  const noop=()=>{};
  const sandbox={document,console,HealthReportState,HealthReportView,healthLocation,resolveHealthTarget,healthBlockPath,
    StageRenderer:Renderer,ProjectAudio:class{stop(){}},StageInput:class{reset(){}},StageOverlay:class{},
    performance:{now:()=>0},window:{addEventListener:noop},requestAnimationFrame:noop,setTimeout:noop,clearTimeout:noop,
    Blob,URL:class extends URL{static createObjectURL(blob){downloads.push(blob);return 'blob:report';}static revokeObjectURL(){}},
    fetch:async(path,options)=>{const value=options?.body?JSON.parse(options.body):null;calls.push({path,value});
      if(path==='/api/health-report'){const pending=deferred();refreshes.push(pending);return {ok:true,json:()=>pending.promise};}
      return {ok:true,json:async()=>path==='/api/import'?importResult(value):projectFixture()};}};
  const source=fs.readFileSync(new URL('../web/app.js',import.meta.url),'utf8').split(LF).filter(line=>!line.startsWith('import ')).join(LF);
  const app=await vm.runInNewContext(`(async()=>{${source}${LF}return {navigateHealthItem,loadProject,downloadHealthReport,markRunning:()=>{started=true;running=true;},getState:()=>({project,owner,selected,dirty,undo,redo,health,started,running})};})()`,sandbox);
  return {app,document,calls,downloads,refreshes};
}

test('Studio clicks navigate literal and procedure blocks without dirtying or switching scenes',async()=>{
  const {app,document,calls}=await appFixture(),before=JSON.stringify(app.getState().project),requests=calls.length;
  document.ids.get('health-report').querySelectorAll('.health-entry')[0].click();
  let state=app.getState();assert.equal(state.owner,'a2');assert.equal(state.selected,'literal[0].id');assert.equal(state.dirty,false);assert.equal(state.undo.length,0);
  assert.equal(state.project.scenes.currentSceneId,'s1');assert.equal(JSON.stringify(state.project),before);assert.equal(calls.length,requests);
  assert.equal(document.focused.dataset.block,'literal[0].id');assert.ok(document.focused.classList.contains('health-block-target'));assert.match(document.ids.get('health-location').textContent,/第二场景/);
  app.navigateHealthItem(item({owner:'p1',owner_name:'绘图过程',owner_kind:'procedure',scene:null,scene_name:null,block:'proc-block'}));
  state=app.getState();assert.equal(state.owner,'p1');assert.equal(document.focused.dataset.block,'proc-block');assert.match(document.ids.get('owner-name').textContent,/绘图过程/);
  assert.equal(JSON.stringify(state.project),before);assert.equal(state.undo.length,0);assert.equal(calls.length,requests);
  app.navigateHealthItem(item({block:'missing-block'}));assert.equal(app.getState().owner,'a2');assert.equal(document.focused.id,'health-location');assert.match(document.focused.textContent,/missing-block/);
  assert.equal(document.ids.get('health-location').querySelectorAll('mark')[0].textContent,'积木 ID：missing-block');
  document.ids.get('deselect').click();assert.equal(document.ids.get('health-location').hidden,true);assert.equal(app.getState().selected,'');
});

test('Studio edits expire reports, download keeps Rust bytes, and recheck preserves editor history',async()=>{
  const {app,document,calls,downloads,refreshes}=await appFixture();
  app.downloadHealthReport();assert.equal(await downloads[0].text(),report().text);
  document.ids.get('project-name').onchange({target:{value:'改名'}});
  const edited=app.getState(),snapshot=JSON.stringify(edited.project);assert.equal(edited.dirty,true);assert.equal(edited.health.stale,true);
  app.downloadHealthReport();assert.equal(downloads.length,1);assert.match(document.ids.get('health-report').textContent,/报告已过期/);
  const task=edited.health.refresh();assert.equal(calls.at(-1).path,'/api/health-report');assert.equal(calls.at(-1).value.projectName,'改名');
  const fresh=report({project_name:'改名',text:`Rust 最新摘要${CRLF}`});refreshes[0].resolve(fresh);assert.equal(await task,true);
  const current=app.getState();assert.equal(JSON.stringify(current.project),snapshot);assert.equal(current.dirty,true);assert.equal(current.undo.length,1);assert.equal(current.started,false);
  app.downloadHealthReport();assert.equal(await downloads.at(-1).text(),fresh.text);
});

test('Studio new imports reject an older recheck result',async()=>{
  const {app,refreshes}=await appFixture(),pending=app.getState().health.refresh();
  const project=projectFixture();project.projectName='另一个作品';await app.loadProject(project);
  const imported=app.getState().health.report;refreshes[0].resolve(report({text:'旧作品报告'}));assert.equal(await pending,false);
  assert.equal(app.getState().project.projectName,'另一个作品');assert.equal(app.getState().health.report,imported);assert.equal(app.getState().dirty,false);
});

test('Studio undo and redo leave reports explicitly stale',async()=>{
  const {app,document,refreshes}=await appFixture();document.ids.get('project-name').onchange({target:{value:'改名'}});
  let pending=app.getState().health.refresh();refreshes[0].resolve(report());await pending;assert.equal(app.getState().health.stale,false);
  document.ids.get('undo').click();assert.equal(app.getState().project.projectName,'原项目');assert.equal(app.getState().health.stale,true);
  pending=app.getState().health.refresh();refreshes[1].resolve(report());await pending;
  document.ids.get('redo').click();assert.equal(app.getState().project.projectName,'改名');assert.equal(app.getState().health.stale,true);assert.equal(app.getState().health.download(),null);
});

test('Studio recheck while running does not stop, restart, replace or dirty the project',async()=>{
  const {app,calls,refreshes}=await appFixture();app.markRunning();
  const before=JSON.stringify(app.getState().project),count=calls.length,pending=app.getState().health.refresh();
  refreshes[0].resolve(report());await pending;
  assert.deepEqual(calls.slice(count).map(call=>call.path),['/api/health-report']);assert.equal(app.getState().running,true);assert.equal(app.getState().started,true);
  assert.equal(app.getState().dirty,false);assert.equal(app.getState().undo.length,0);assert.equal(JSON.stringify(app.getState().project),before);
});
