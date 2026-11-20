// wasm 后端 Worker：nekoc-wasm 的 web 绑定。消息格式见 backend.js。
// wasm/ 由 tools/build-pages.mjs 从 packages/nekoc/dist/web 复制。
import init,{importProject,checkExtensions,Player} from './wasm/nekoc_wasm.js';

const players=new Map();
const errorText=error=>typeof error==='string'?error:error?.message||String(error);
const progress=(label,completed=null,total=null)=>postMessage({progress:{label,completed,total}});
const ready=(async()=>{
  try{
    // Standalone exports embed bytes before this script; never fetch from file://.
    let bytes=globalThis.nekoPlayerWasmBytes;
    if(bytes){progress('正在读取内置 WASM（字节）…',bytes.byteLength,bytes.byteLength);}
    else{
      progress('正在下载 WASM…');
      const response=await fetch(new URL('./wasm/nekoc_wasm_bg.wasm',import.meta.url),{signal:AbortSignal.timeout(60000)});
      if(!response.ok)throw Error(`下载失败：HTTP ${response.status}`);
      let total=Number(response.headers.get('content-length'))||null;
      if(response.body){
        const reader=response.body.getReader(),chunks=[];let completed=0;
        for(;;){
          const {done,value}=await reader.read();if(done)break;
          chunks.push(value);completed+=value.byteLength;if(total!==null&&completed>total)total=null;
          progress(total===null?`正在下载 WASM… 已接收 ${completed} 字节`:'正在下载 WASM（字节）…',completed,total);
        }
        bytes=new Uint8Array(completed);let offset=0;
        for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
      }else bytes=new Uint8Array(await response.arrayBuffer());
      progress('WASM 下载完成（字节）',bytes.byteLength,bytes.byteLength);
    }
    progress('正在编译 / 初始化 WASM…');
    await init({module_or_path:bytes});postMessage({ready:true});return true;
  }catch(error){postMessage({error:`WASM 运行时载入失败：${errorText(error)}`});return false;}
})();

const calls={
  // Same shape as the backend's /api/import-player: report fields plus project.
  importProject:value=>{const {project,report}=JSON.parse(importProject(JSON.stringify(value)));return {...report,project};},
  checkExtensions:value=>JSON.parse(checkExtensions(JSON.stringify(value))),
};

function reply(socket,message){
  if(message instanceof Uint8Array){
    // 帧通过 transfer 交给页面；页面拿到的是 ArrayBuffer，和 WebSocket 一致。
    const buffer=message.byteOffset===0&&message.byteLength===message.buffer.byteLength?message.buffer:message.slice().buffer;
    postMessage({socket,message:buffer},[buffer]);
  }else postMessage({socket,message});
}

self.onmessage=async({data})=>{
  if(!await ready)return;
  if(data.call){
    try{postMessage({call:data.call,value:calls[data.name](data.value)});}
    catch(error){postMessage({call:data.call,error:errorText(error)});}
    return;
  }
  const id=data.socket;
  if(data.close){players.get(id)?.free();players.delete(id);return;}
  try{
    const player=players.get(id);
    if(!player){
      // 第一条消息是握手：作品，或带扩展积木的握手对象。
      const created=new Player(data.text);players.set(id,created);reply(id,created.ready());
    }else reply(id,player.handle(data.text));
  }catch(error){
    // 与 WebSocket 后端一致：先发 {error}，再关闭会话。
    reply(id,JSON.stringify({error:errorText(error)}));
    players.get(id)?.free();players.delete(id);postMessage({socket:id,closed:true});
  }
};
