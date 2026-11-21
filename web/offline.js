import {t} from './i18n.js';

// Loaded only by the static WASM deployment, never local Rust, extensions or
// standalone exports. Project persistence always requires a user gesture.
export async function setupOffline({getProject,openProject,isBusy,onError}){
  const panel=document.querySelector('#offline-controls');
  if(!globalThis.isSecureContext||!navigator.serviceWorker)return null;
  const workerURL=new URL('./offline-sw.js',import.meta.url);
  const registration=await navigator.serviceWorker.register(workerURL,{scope:new URL('./',import.meta.url).href,updateViaCache:'none'});
  const controlled=()=>navigator.serviceWorker.controller?.scriptURL===workerURL.href;
  const activeWorker=()=>controlled()?navigator.serviceWorker.controller:registration.active?.state==='activated'?registration.active:null;
  const save=document.querySelector('#offline-save'),open=document.querySelector('#offline-open'),clear=document.querySelector('#offline-clear');
  const select=document.querySelector('#offline-projects'),status=document.querySelector('#offline-status');
  let works=[],pending=false,message='offlinePreparing';
  const render=()=>{
    panel.hidden=false;status.textContent=t(message);
    save.disabled=pending||!activeWorker()||!getProject();
    open.disabled=pending||isBusy()||!works.length;clear.disabled=pending||!works.length;select.disabled=pending||!works.length;
  };
  const request=(action,extra={})=>new Promise((resolve,reject)=>{
    const worker=activeWorker();if(!worker){reject(Error('offlinePreparing'));return;}
    const channel=new MessageChannel(),timer=setTimeout(()=>{channel.port1.close();reject(Error('offlineSaveFailed'));},180000);
    channel.port1.onmessage=({data})=>{clearTimeout(timer);channel.port1.close();data.error?reject(Error(data.error)):resolve(data.value);};
    try{worker.postMessage({type:'nekoc-offline',action,...extra},[channel.port2]);}
    catch(error){clearTimeout(timer);channel.port1.close();reject(error);}
  });
  const list=items=>{
    const previous=select.value;works=items;select.replaceChildren();
    for(const work of works){const option=document.createElement('option');option.value=work.id;option.textContent=work.name||t('untitled');select.append(option);}
    if(works.some(work=>work.id===previous))select.value=previous;
  };
  const action=async operation=>{
    if(pending)return;pending=true;render();
    try{await operation();}catch(error){message='offlineSaveFailed';onError(t(Object.hasOwn(messages,error.message)?error.message:'offlineSaveFailed'));}
    finally{pending=false;render();}
  };
  // Only these public, UI-owned error keys may be displayed by the worker.
  const messages={offlineUnsafeAsset:1,offlineTooLarge:1,offlineSaveFailed:1,offlinePreparing:1};
  save.onclick=()=>{
    const project=getProject();if(!project||!confirm(t('offlineConfirm')))return;
    void action(async()=>{message='offlineSaving';render();list(await request('save',{project}));message='offlineSaved';});
  };
  open.onclick=()=>{if(!isBusy())void action(async()=>{await openProject(await request('open',{id:select.value}));message='offlineReady';});};
  clear.onclick=()=>{if(confirm(t('offlineClearConfirm')))void action(async()=>{list(await request('clear'));message='offlineReady';});};
  const refresh=()=>{if(activeWorker())void action(async()=>{list(await request('list'));message=registration.waiting?'offlineUpdate':'offlineReady';});};
  navigator.serviceWorker.addEventListener('controllerchange',refresh);
  const observe=()=>{
    const worker=registration.installing||registration.active;if(!worker)return;
    worker.addEventListener('statechange',()=>{
      if(worker.state==='installed'&&controlled())message='offlineUpdate';
      if(worker.state==='redundant'&&!controlled())message='offlineSaveFailed';
      if(worker.state==='activated')refresh();
      render();
    });
  };
  registration.addEventListener('updatefound',observe);observe();
  render();refresh();
  // Check on each visit; browser failures/offline must not break normal playback.
  void registration.update().catch(()=>{});
  return {refresh:render};
}
