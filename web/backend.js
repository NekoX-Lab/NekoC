// 播放器后端：本机 Rust（HTTP + WebSocket）或浏览器内 wasm（Web Worker）。
// 两者对 play.js / player.js 暴露同样的接口：api(path,data) 和 connect(url)。
// connect 返回的对象具有 WebSocket 的 send/close/onopen/onmessage/onerror/onclose。

export function httpBackend(origin){
  return {
    kind:'rust',origin,
    async api(path,data){
      const response=await fetch(`${origin}/api/${path}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data),signal:AbortSignal.timeout(60000)});
      let value;
      try{value=await response.json();}catch{throw Error(response.ok?'服务返回了无效的作品数据':`请求失败：HTTP ${response.status}`);}
      if(!response.ok)throw Error(value.error||`HTTP ${response.status}`);return value;
    },
    connect(project){
      const url=new URL(project?'/api/player-private':'/api/player',origin);
      url.protocol=url.protocol==='https:'?'wss:':'ws:';
      const socket=new WebSocket(url);socket.binaryType='arraybuffer';return socket;
    },
  };
}

// 每个 wasm 后端一个 Worker：导入、检查和运行都在 Worker 里，不阻塞画面。
export function wasmBackend(workerURL=new URL('./wasm-worker.js',import.meta.url),workerOptions={type:'module'}){
  const worker=new Worker(workerURL,workerOptions);
  const calls=new Map(),sockets=new Map();let nextId=1;
  let failure=null,resolveReady,rejectReady,progress={label:'正在加载 WASM 运行时…',completed:null,total:null};
  const listeners=new Set(),ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
  // Other consumers may use api/connect without awaiting the optional readiness UI.
  void ready.catch(()=>{});
  const fail=error=>{
    failure=error;rejectReady(error);
    for(const call of calls.values())call.reject(error);calls.clear();
    for(const socket of sockets.values())socket.onerror?.({error});sockets.clear();
  };
  worker.onmessage=({data})=>{
    if(data.progress){progress=data.progress;for(const listener of listeners)listener(progress);return;}
    if(data.ready){progress={label:'WASM 运行时已就绪',completed:1,total:1};for(const listener of listeners)listener(progress);resolveReady();return;}
    if(data.error&&!data.call&&!data.socket){fail(Error(data.error));return;}
    if(data.call){const call=calls.get(data.call);calls.delete(data.call);if(data.error)call?.reject(Error(data.error));else call?.resolve(data.value);return;}
    const socket=sockets.get(data.socket);if(!socket)return;
    if(data.message!==undefined)socket.onmessage?.({data:data.message});
    if(data.closed){sockets.delete(data.socket);socket.onclose?.({});}
  };
  worker.onerror=event=>{
    event.preventDefault();fail(Error(`WASM 运行时载入失败：${event.message||'未知错误'}`));
  };
  const call=(name,value)=>new Promise((resolve,reject)=>{
    if(failure){reject(failure);return;}
    const id=nextId++;calls.set(id,{resolve,reject});
    try{worker.postMessage({call:id,name,value});}catch(error){calls.delete(id);reject(error);}
  });
  return {
    kind:'wasm',origin:null,ready,
    subscribeProgress(listener){listeners.add(listener);listener(progress);return ()=>listeners.delete(listener);},
    async api(path,data){
      if(path==='import-player')return call('importProject',data);
      if(path==='extension-check')return call('checkExtensions',data);
      throw Error(`wasm 后端不支持 ${path}`);
    },
    connect(project){
      if(failure)throw failure;
      if(!project)throw Error('wasm 后端需要作品数据');
      const id=nextId++;
      const socket={
        binaryType:'arraybuffer',onopen:null,onmessage:null,onerror:null,onclose:null,
        send(text){if(sockets.has(id))worker.postMessage({socket:id,text});},
        close(){if(sockets.delete(id))worker.postMessage({socket:id,close:true});},
      };
      sockets.set(id,socket);
      queueMicrotask(()=>{if(sockets.has(id))socket.onopen?.({});});
      return socket;
    },
    terminate(){worker.terminate();fail(Error('WASM 运行时已关闭'));listeners.clear();},
  };
}
