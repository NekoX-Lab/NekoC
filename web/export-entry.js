// Classic-script export bootstrap. All payloads are loaded through relative
// <script src> tags, so file:// needs neither fetch nor module/CORS exceptions.
import {wasmBackend} from './backend.js';

globalThis.nekoPlayerExport={
  createBackend(){
    const {worker,wasm}=globalThis.nekoExportRuntime;
    const prefix=`globalThis.nekoPlayerWasmBytes=Uint8Array.from(atob(${JSON.stringify(wasm)}),c=>c.charCodeAt(0));\n`;
    const url=URL.createObjectURL(new Blob([prefix,worker],{type:'text/javascript'}));
    const backend=wasmBackend(url,{type:'classic'});
    window.addEventListener('pagehide',()=>{backend.terminate();URL.revokeObjectURL(url);},{once:true});
    return backend;
  },
  async loadProject(){return globalThis.nekoExportProject;},
};
await import('./play.js');
