// Runs only in the exporter's disposable worker, before any output is published.
import {parentPort,workerData} from 'node:worker_threads';
import {build} from 'esbuild';

try{
  const {binding,wasmBytes,projectText}=workerData;
  // Bundle rather than importing a .js path: user-provided web bindings may live
  // outside a package with type:module. Node builtins remain external.
  const bundled=await build({entryPoints:[binding],bundle:true,write:false,format:'esm',platform:'node',logLevel:'silent'});
  const runtime=await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
  await runtime.default({module_or_path:wasmBytes});
  const {project,report}=JSON.parse(runtime.importProject(projectText));
  if(!report?.fast_runtime_ready)throw Error(`配套 WASM 无法运行此作品：${report?.runtime_error||'含不支持的积木'}`);
  const handshake=JSON.stringify(project),handshakeBytes=Buffer.byteLength(handshake);
  if(handshakeBytes>64*1024*1024)throw Error(`规范作品握手超过播放器 64 MiB 上限（${handshakeBytes} bytes）；请先缩小素材`);
  const player=new runtime.Player(handshake);
  try{
    if(!JSON.parse(player.ready()).ready)throw Error('配套 WASM 未能建立播放器会话');
  }finally{player.free();}
  parentPort.postMessage({handshakeBytes});
}catch(error){parentPort.postMessage({error:`WASM 导出预检失败：${error?.message||String(error)}`});}
