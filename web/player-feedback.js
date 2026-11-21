import {t} from './i18n.js';
// Player-only feedback. Untrusted text never enters HTML; omit the full project from reports.
export class PlayerFeedback {
  constructor(root=document){
    this.root=root;this.messages=[];this.report=null;this.resourceErrors=[];
    this.$=selector=>root.querySelector(selector);
    this.$('#dismiss').onclick=()=>{
      const focused=this.$('#dismiss')===this.root.activeElement;this.$('#notice').hidden=true;
      if(focused)this.$('#import').focus();
    };
    this.$('#coverage').onclick=()=>this.openReport();
    this.$('#report-close').onclick=()=>this.$('#coverage-dialog').close();
    this.$('#coverage-dialog').onkeydown=event=>{
      if(event.key!=='Tab')return;
      const first=this.$('#report-content'),last=this.$('#report-close');
      if(event.shiftKey&&this.root.activeElement===first){event.preventDefault();last.focus();}
      else if(!event.shiftKey&&this.root.activeElement===last){event.preventDefault();first.focus();}
    };
    this.$('#report-download').onclick=()=>{
      const url=URL.createObjectURL(new Blob([this.reportText()],{type:'application/json'}));
      const link=document.createElement('a');link.href=url;link.download='neko-player-diagnostics.json';link.click();
      setTimeout(()=>URL.revokeObjectURL(url),1000);
    };
  }
  notice(message){
    message=typeof message==='string'?message:message?.message||String(message);
    if(!this.messages.includes(message)){this.messages.push(message);if(this.messages.length>100)this.messages.shift();}
    this.$('#notice-text').textContent=this.messages.join('\n');this.$('#notice').hidden=false;
  }
  reset(report){
    const {project,...diagnostics}=report;
    this.report={...diagnostics,projectName:project?.projectName};this.resourceErrors=[];this.messages=[];this.$('#notice').hidden=true;
    this.$('#coverage').disabled=false;
  }
  resourceError(message){if(!this.resourceErrors.includes(message))this.resourceErrors.push(message);this.notice(message);}
  runtimeError(error){this.notice(t('runtimeError',{error:typeof error==='string'?error:error?.message||String(error)}));}
  mode(kind){this.$('#runtime-mode').textContent=t(kind==='wasm'?'runtimeWasm':kind==='rust'?'runtimeRust':'runtimeConnecting');}
  progress(label,completed=null,total=null){
    this.$('#loading').hidden=false;this.$('#viewport').setAttribute('aria-busy','true');
    const meter=this.$('#load-progress');
    if(total===null)meter.removeAttribute('value');else{meter.max=Math.max(1,total);meter.value=total?completed:1;}
    this.$('#load-label').textContent=total===null?label:`${label} ${completed} / ${total}`;
  }
  finish(){this.$('#loading').hidden=true;this.$('#viewport').setAttribute('aria-busy','false');}
  reportText(){
    return JSON.stringify({kind:'nekoc-player-import-diagnostics-v1',scope:t('reportScope'),...this.report,resource_errors:this.resourceErrors},null,2);
  }
  openReport(){
    this.$('#report-content').textContent=this.reportText();this.$('#coverage-dialog').showModal();
  }
}
