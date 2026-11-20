// Record the accepted VM input, not DOM coordinates or a second hit-test.
// Explicit field copies keep project data, answers, URLs and account data out.
export const REPRO_DT=1/60;
export const MAX_REPRO_FRAMES=36000;
const MAX_REPRO_BYTES=16*1024*1024;
const WARNINGS=['audio','real_time','cloud','external_inputs','asset_geometry'];
const key=value=>typeof value==='string'&&/^(13|32|3[7-9]|40|4[8-9]|5[0-7]|6[5-9]|[78][0-9]|90)$/.test(value);
const coordinate=value=>{if(typeof value!=='number'||!Number.isFinite(value))throw Error('录制输入坐标无效');return value;};
const target=value=>{if(typeof value!=='string'||value.length>4096)throw Error('录制输入目标无效');return value;};

export function reproInput(payload,onOmitted=()=>{}){
  const events=[];
  for(const event of payload.events||[]){
    switch(event.kind){
      case 'key':
        if(!key(event.key)||typeof event.down!=='boolean')throw Error('录制按键无效');
        events.push({kind:'key',key:event.key,down:event.down});break;
      case 'pointer':
        if(!['','mouse_down','mouse_up','mouse_click'].includes(event.state))throw Error('录制指针状态无效');
        events.push({kind:'pointer',target:target(event.target),state:event.state,x:coordinate(event.x),y:coordinate(event.y)});break;
      case 'drag':events.push({kind:'drag',target:target(event.target),x:coordinate(event.x),y:coordinate(event.y)});break;
      case 'swipe':
        if(!['up','down','left','right'].includes(event.direction))throw Error('录制滑动方向无效');
        events.push({kind:'swipe',direction:event.direction});break;
      default:onOmitted();
    }
  }
  const pressed=[...(payload.pressed||[])];
  if(events.length>256||pressed.length>256||pressed.some(value=>!key(value)))throw Error('录制输入超过限制或按键无效');
  return {pressed,mouse:{x:coordinate(payload.mouse?.x??0),y:coordinate(payload.mouse?.y??0)},events};
}

export class ReproRecorder {
  constructor(metadata,status,queue={}){
    if(metadata?.runner?.name!=='nekoc'||!metadata.runner.version||metadata.runner.protocol!==2||
      !/^[a-f0-9]{64}$/.test(metadata.work_sha256)||!/^\d+$/.test(metadata.seed)||metadata.dt!==REPRO_DT)
      throw Error('运行时不支持复现录制，请更新播放器后端');
    this.metadata={runner:{name:'nekoc',version:metadata.runner.version,protocol:metadata.runner.protocol},
      work_sha256:metadata.work_sha256,seed:metadata.seed,dt:REPRO_DT};
    this.timeline=[];this.bytes=0;this.warnings=new Set(WARNINGS);this.interrupted=false;
    this.queueStart={coalesced:queue.coalesced||0,rejected:queue.rejected||0};
    this.setStatus(status,0);
  }
  setStatus(status,frames){
    if(status?.frame_count!==frames||!/^[a-f0-9]{64}$/.test(status.state_sha256)||
      !Number.isSafeInteger(status.budget_yields)||status.budget_yields<0)throw Error('录制帧确认不一致');
    this.status={state_sha256:status.state_sha256,frame_count:frames,budget_yields:status.budget_yields};
  }
  get full(){return this.timeline.length>=MAX_REPRO_FRAMES||this.bytes>=MAX_REPRO_BYTES;}
  prepare(payload){
    if(this.full)throw Error('录制已达上限，请停止并导出');
    return reproInput(payload,()=>this.warnings.add('omitted_inputs'));
  }
  commit(input,status){
    const frame=this.timeline.length+1;this.setStatus(status,frame);
    const entry={frame,time_ms:(frame-1)*1000/60,input:reproInput(input)};
    this.timeline.push(entry);this.bytes+=new TextEncoder().encode(JSON.stringify(entry)).byteLength;
  }
  interrupt(){this.interrupted=true;this.warnings.add('interrupted');}
  package(queue={}){
    return {schema:'nekoc-repro-v1',...this.metadata,timeline:this.timeline.map(entry=>({...entry,input:reproInput(entry.input)})),
      diagnostics:{...this.status,warnings:[...this.warnings],input_queue:{
        coalesced:Math.max(0,(queue.coalesced||0)-this.queueStart.coalesced),
        rejected:Math.max(0,(queue.rejected||0)-this.queueStart.rejected)},interrupted:this.interrupted}};
  }
}
