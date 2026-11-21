// Health categories are independent capabilities, never a project-wide verdict.
export const HEALTH_CATEGORIES=Object.freeze([
  ['preserve','能保留导出'],['executable','能执行'],['approximate','语义近似'],
  ['unverified','尚未验证'],['unsupported','不支持'],
]);
export const HEALTH_PAGE_SIZE=50;
const categoryLabels=new Map(HEALTH_CATEGORIES);
const text=value=>typeof value==='string'?value:'';
const named=(name,id)=>name&&id&&name!==id?`${name}（${id}）`:name||id||'未提供';

export function healthLocation(item={}){
  const kind={scene:'场景',actor:'角色',procedure:'自制积木'}[item.owner_kind]||'所属对象';
  return {scene:`场景：${named(text(item.scene_name),text(item.scene))}`,
    owner:`${kind}：${named(text(item.owner_name),text(item.owner))}`,
    block:`积木 ID：${text(item.block)||'未提供'}`,type:`类型：${text(item.block_type)||'未提供'}`};
}

// Resolve IDs literally (including punctuation), without mutating the project.
export function resolveHealthTarget(project,item={}){
  const scenes=project?.scenes?.scenesDict||{},actors=project?.actors?.actorsDict||{},procedures=project?.procedures?.proceduresDict||{};
  const dictionaries={scene:scenes,actor:actors,procedure:procedures};
  const requested=text(item.owner),dict=dictionaries[item.owner_kind];
  const owns=(values,id)=>id&&Object.hasOwn(values,id);
  let owner='',kind='';
  if(dict&&owns(dict,requested)){owner=requested;kind=item.owner_kind;}
  else if(!dict){for(const [key,values]of Object.entries(dictionaries))if(owns(values,requested)){owner=requested;kind=key;break;}}
  if(!owner&&owns(scenes,text(item.scene))){owner=item.scene;kind='scene';}
  const scene=text(item.scene)||(kind==='scene'?owner:Object.entries(scenes).find(([,s])=>s.actorIds?.includes(owner))?.[0]||'');
  return {owner,kind,scene,block:text(item.block),entity:owner?dictionaries[kind][owner]:null};
}

export function healthBlockPath(entity,id){
  if(!id)return [];
  const pending=(entity?.nekoBlockJsonList||[]).map(block=>({block,path:[]})),seen=new Set();
  while(pending.length){
    const {block,path}=pending.pop();if(!block||typeof block!=='object'||seen.has(block))continue;seen.add(block);
    const nested=[...path,block.id];if(block.id===id)return nested;
    if(block.next)pending.push({block:block.next,path});
    for(const map of [block.inputs,block.statements])for(const child of Object.values(map||{}))pending.push({block:child,path:nested});
  }
  return [];
}

export function healthPage(report,page=0,category=''){
  const items=Array.isArray(report?.items)?report.items:[];
  const filtered=category?items.filter(item=>item?.category===category):items;
  const pages=Math.max(1,Math.ceil(filtered.length/HEALTH_PAGE_SIZE));
  const index=Math.max(0,Math.min(pages-1,Number.isFinite(page)?Math.floor(page):0));
  return {items:filtered.slice(index*HEALTH_PAGE_SIZE,(index+1)*HEALTH_PAGE_SIZE),
    page:index,pages,total:filtered.length,start:filtered.length?index*HEALTH_PAGE_SIZE+1:0,
    end:Math.min((index+1)*HEALTH_PAGE_SIZE,filtered.length)};
}

export class HealthReportState {
  constructor({getProject,request,onChange=()=>{}}){
    this.getProject=getProject;this.request=request;this.onChange=onChange;
    this.report=null;this.stale=false;this.busy=false;this.loading=false;this.error='';this.revision=0;this.requestId=0;
  }
  replace(report){
    this.revision++;this.requestId++;this.report=report??null;this.stale=false;this.busy=false;this.loading=false;this.error='';this.onChange();
  }
  invalidate(){
    this.revision++;this.requestId++;this.stale=!!this.report;this.busy=false;this.error='';this.onChange();
  }
  setLoading(value){
    this.loading=value;this.requestId++;this.busy=false;this.onChange();
  }
  get valid(){return this.report?.schema_version===1&&['kitten-n','kitten4'].includes(this.report?.format)&&Array.isArray(this.report?.items);}
  get canDownload(){return this.valid&&!this.stale&&!this.loading&&typeof this.report.text==='string'&&this.report.text.length>0;}
  download(){return this.canDownload?{text:this.report.text,filename:`${text(this.report.project_name)||'Untitled'}-作品体检.txt`}:null;}
  async refresh(){
    if(this.busy||this.loading||!this.getProject())return false;
    const id=++this.requestId,revision=this.revision,snapshot=JSON.stringify(this.getProject());
    this.busy=true;this.error='';this.onChange();
    const current=()=>id===this.requestId&&revision===this.revision;
    try{
      const report=await this.request(JSON.parse(snapshot));
      if(!current())return false;
      if(JSON.stringify(this.getProject())!==snapshot){this.stale=!!this.report;this.error='作品在体检期间发生变化，请重新体检。';return false;}
      this.report=report??null;this.stale=false;return true;
    }catch(error){
      if(current())this.error=`重新体检失败：${error.message||String(error)}`;
      return false;
    }finally{if(current()){this.busy=false;this.onChange();}}
  }
}

// DOM creation uses textContent throughout: names, IDs and evidence are untrusted.
export class HealthReportView {
  constructor(root,{onRefresh,onDownload,onNavigate}){
    this.root=root;this.document=root.ownerDocument;this.page=0;this.category='';this.report=null;
    this.onRefresh=onRefresh;this.onDownload=onDownload;this.onNavigate=onNavigate;
  }
  node(tag,className,value){const node=this.document.createElement(tag);if(className)node.className=className;if(value!==undefined)node.textContent=value;return node;}
  button(label,action,disabled=false){const button=this.node('button','ghost small',label);button.type='button';button.disabled=disabled;button.onclick=action;return button;}
  render(state){
    if(this.report!==state.report){this.report=state.report;this.page=0;this.category='';}
    const root=this.root;root.replaceChildren();
    const head=this.node('div','section-head'),title=this.node('h2','','作品体检'),actions=this.node('div','health-actions');
    title.id='health-title';actions.append(this.button(state.busy?'体检中…':'重新体检',this.onRefresh,state.busy||state.loading),this.button('下载文本',this.onDownload,!state.canDownload));head.append(title,actions);root.append(head);
    const status=this.node('p',`health-status${state.stale||state.error?' health-warning':''}`);status.setAttribute('role','status');
    status.textContent=state.loading?'正在导入作品…':state.stale?'报告已过期：作品已编辑，请重新体检后下载。':
      !state.report?'尚无体检数据，请重新体检。':!state.valid?'体检报告格式不受支持，请重新体检。':
      !state.report.items.length?'暂无体检条目，不能据此判断作品兼容性。':'以下为该作品快照的体检结果。';
    root.append(status,this.node('p','health-note','五类能力可能重叠；条目数不代表通过率，能执行也不代表整个作品语义一致。未知与无数据不视为通过。'));
    if(state.error){const error=this.node('p','health-warning',state.error);error.setAttribute('role','alert');root.append(error);}
    if(!state.valid)return;
    const summary=this.node('div','health-summary');
    for(const [category,label]of HEALTH_CATEGORIES){
      const count=state.report.summary?.[category],button=this.button(`${label} · ${Number.isSafeInteger(count)&&count>=0?count:'—'}`,()=>{this.category=this.category===category?'':category;this.page=0;this.render(state);});
      button.className=`health-count health-${category}`;button.setAttribute('aria-pressed',String(this.category===category));summary.append(button);
    }
    root.append(summary);
    const page=healthPage(state.report,this.page,this.category);this.page=page.page;
    const pager=this.node('div','health-pagination'),range=this.node('span','',`${this.category?categoryLabels.get(this.category):'全部条目'} · ${page.start}–${page.end} / ${page.total} · 第 ${page.page+1}/${page.pages} 页`);
    pager.append(this.button('全部类别',()=>{this.category='';this.page=0;this.render(state);},!this.category),range,
      this.button('上一页',()=>{this.page--;this.render(state);},page.page===0),this.button('下一页',()=>{this.page++;this.render(state);},page.page+1===page.pages));root.append(pager);
    const list=this.node('ol','health-list');list.start=page.start||1;
    for(const raw of page.items){
      const item=raw&&typeof raw==='object'?raw:{},entry=this.node('li','health-item'),button=this.node('button','health-entry');button.type='button';
      const category=categoryLabels.has(item.category)?item.category:'unknown';
      button.append(this.node('span',`health-badge health-${category}`,categoryLabels.get(item.category)||'未知类别'),this.node('code','health-code',text(item.code)||'未提供代码'));
      const location=healthLocation(item);for(const [key,value]of Object.entries(location))button.append(this.node(key==='block'?'code':'span',`health-${key}`,value));
      button.append(this.node('span','health-impact',`影响：${text(item.impact)||'未提供'}`),this.node('span','health-evidence',`依据：${text(item.evidence)||'未提供'}`));
      const canNavigate=!!(item.owner||item.scene||item.block);button.disabled=!canNavigate||state.loading;
      if(canNavigate)button.append(this.node('span','health-jump',state.stale?'定位（报告已过期，目标可能已改变） →':'定位角色 / 积木 →'));
      button.onclick=()=>this.onNavigate(item);entry.append(button);list.append(entry);
    }
    if(!page.total)list.append(this.node('li','health-empty','此分类没有条目；这不表示作品通过体检。'));
    root.append(list);
  }
}
