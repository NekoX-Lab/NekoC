// Self-contained player exports. Source checkouts need Node 22+, npm ci, and
// wasm-bindgen web output built from this checkout (see docs/player-export.md).
import {access,link,mkdir,mkdtemp,readFile,rename,rm,stat,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {build} from 'esbuild';
import {zipSync} from 'fflate';
import {Worker} from 'node:worker_threads';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const maxAssetBytes=64*1024*1024,maxTotalBytes=256*1024*1024;
const mimeTypes={'.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.avif':'image/avif','.mp3':'audio/mpeg','.wav':'audio/wav','.ogg':'audio/ogg','.m4a':'audio/mp4','.mp4':'video/mp4','.webm':'video/webm'};
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
async function exists(file){try{await access(file);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}

// Match the browser import and handshake with the exact runtime being bundled.
// A short-lived worker releases the WASM heap and large canonical K4 copies.
async function validateHandshake(binding,wasmBytes,projectText){
  return new Promise((resolve,reject)=>{
    const worker=new Worker(new URL('./player-export-preflight.mjs',import.meta.url),{workerData:{binding,wasmBytes,projectText},execArgv:[]});
    worker.once('message',result=>result.error?reject(Error(result.error)):resolve(result.handshakeBytes));
    worker.once('error',reject);
    worker.once('exit',code=>reject(Error(`WASM 导出预检未完成（退出 ${code}）`)));
  });
}

async function readAsset(source,base){
  if(source.startsWith('data:')){
    const comma=source.indexOf(',');
    if(comma<0)throw Error('无效的 data 素材地址');
    const header=source.slice(5,comma),payload=source.slice(comma+1);
    const bytes=/;base64$/i.test(header)?Buffer.from(payload,'base64'):Buffer.from(decodeURIComponent(payload));
    return {bytes,mime:header.split(';')[0]||'application/octet-stream'};
  }
  const url=path.isAbsolute(source)?pathToFileURL(source):new URL(source,pathToFileURL(`${base}${path.sep}`));
  if(url.protocol==='file:'){
    const file=fileURLToPath(url);
    if((await stat(file)).size>maxAssetBytes)throw Error('素材超过 64 MiB');
    return {bytes:await readFile(file),mime:mimeTypes[path.extname(file).toLowerCase()]||'application/octet-stream'};
  }
  if(!['https:','http:'].includes(url.protocol))throw Error(`不支持的素材协议 ${url.protocol}`);
  const response=await fetch(url,{signal:AbortSignal.timeout(60000)});
  if(!response.ok){await response.body?.cancel();throw Error(`HTTP ${response.status}`);}
  if(Number(response.headers.get('content-length'))>maxAssetBytes){await response.body?.cancel();throw Error('素材超过 64 MiB');}
  const chunks=[];let size=0;
  for await(const chunk of response.body){size+=chunk.length;if(size>maxAssetBytes)throw Error('素材超过 64 MiB');chunks.push(chunk);}
  return {bytes:Buffer.concat(chunks),mime:response.headers.get('content-type')?.split(';')[0]||mimeTypes[path.extname(url.pathname).toLowerCase()]||'application/octet-stream'};
}

// Only resource dictionaries are rewritten: URLs in scripts, strings and cloud
// variables are program data, not a license to download arbitrary properties.
export async function embedAssets(project,base){
  const k4=project.theatre;
  const tables=k4?[['图片',k4.styles],['音频',project.audio],['视频',k4.videos]]
    :[['图片',project.styles?.stylesDict],['音频',project.audios?.audiosDict],['视频',project.videos?.videosDict]];
  const cache=new Map(),assets=[];let total=0;
  for(const [kind,table]of tables)for(const [id,resource]of Object.entries(table||{})){
    const source=resource.url||resource.cdn_url;
    if(typeof source!=='string'||!source)throw Error(`${kind}「${resource.name||id}」缺少素材地址`);
    try{
      let result=cache.get(source);
      if(!result){
        const {bytes,mime}=await readAsset(source,base);
        if(bytes.length>maxAssetBytes)throw Error('素材超过 64 MiB');
        total+=bytes.length;if(total>maxTotalBytes)throw Error('素材总量超过 256 MiB');
        // External SVG subresources would silently defeat the offline contract.
        if(mime==='image/svg+xml'){
          const svg=bytes.toString('utf8');
          const references=[...[...svg.matchAll(/\bhref\s*=\s*(["'])(.*?)\1/gi)].map(match=>match[2]),
            ...[...svg.matchAll(/\burl\(\s*(["']?)(.*?)\1\s*\)/gi)].map(match=>match[2])];
          if(references.some(value=>!/^(?:#|data:)/i.test(value.trim()))||/@import\b|<!ENTITY\b/i.test(svg))
            throw Error('SVG 含外部引用，请先将其转换为自包含 SVG 或 PNG');
        }
        result={url:`data:${mime};base64,${bytes.toString('base64')}`,bytes:bytes.length,sha256:digest(bytes),mime};
        cache.set(source,result);
      }
      resource.url=result.url;if(resource.cdn_url)resource.cdn_url=result.url;
      assets.push({kind,id,name:resource.name||id,bytes:result.bytes,mime:result.mime,sha256:result.sha256});
      console.error(`[素材 ${assets.length}] ${kind} ${resource.name||id}: ${result.bytes} bytes`);
    }catch(error){throw Error(`${kind}「${resource.name||id}」打包失败：${error.message}`,{cause:error});}
  }
  return {assets,totalBytes:total};
}

export async function exportPlayer({input,out,assetBase,wasmDir=path.join(root,'packages/nekoc/dist/web')}){
  input=path.resolve(input);out=path.resolve(out);wasmDir=path.resolve(wasmDir);
  if(await exists(out))throw Error(`输出已存在，不会覆盖：${out}`);
  const binding=path.join(wasmDir,'nekoc_wasm.js'),binary=path.join(wasmDir,'nekoc_wasm_bg.wasm');
  if(!await exists(binding)||!await exists(binary))throw Error('缺少 WASM web 运行器；先运行 node packages/nekoc/build.mjs，或指定 --wasm-dir');
  const wasmBytes=await readFile(binary);
  if(!WebAssembly.validate(wasmBytes))throw Error('WASM 运行器不是有效的 WebAssembly 模块');
  const project=JSON.parse((await readFile(input,'utf8')).replace(/^\uFEFF/,''));
  // The native command materializes canonical K4 edits as a source work first.
  // Never take its stale provenance snapshot and silently lose user changes.
  if(project._nekocKitten4)throw Error('规范 K4 数据需先还原为源作品；请通过 nekoc export-player 导出');
  if(!project.theatre&&(!project.scenes?.scenesDict||!project.actors?.actorsDict))throw Error('需要规范 KN / K4 作品；请通过 nekoc export-player 导出');
  const {assets,totalBytes}=await embedAssets(project,path.resolve(assetBase||path.dirname(input)));
  const projectText=JSON.stringify(project);
  if(Buffer.byteLength(projectText)>64*1024*1024)throw Error('内嵌素材后的作品超过播放器 64 MiB 握手上限；请先缩小素材');
  await validateHandshake(binding,wasmBytes,projectText);
  const plugin={name:'standalone-player',setup(build){
    build.onResolve({filter:/\/wasm\/nekoc_wasm\.js$/},()=>({path:binding}));
    // The standalone export always selects WASM, never the extension backend.
    build.onResolve({filter:/^\.\/extension\.js$/},()=>({path:'extension',namespace:'export-stub'}));
    build.onLoad({filter:/.*/,namespace:'export-stub'},()=>({contents:'export {};',loader:'js'}));
  }};
  const options={bundle:true,write:false,format:'esm',target:'es2022',minify:true,define:{'import.meta.url':'globalThis.location.href'},plugins:[plugin],logLevel:'silent'};
  const worker=await build({...options,entryPoints:[path.join(root,'web/wasm-worker.js')]});
  const player=await build({...options,entryPoints:[path.join(root,'web/export-entry.js')]});
  // ES modules cannot load from file:// in ordinary browsers. esbuild resolves
  // all imports, then an async IIFE retains play.js's top-level await semantics.
  const wrapped=`(async()=>{${player.outputFiles[0].text}\n})().catch(error=>{const n=document.querySelector('#notice'),t=document.querySelector('#notice-text');n.hidden=false;t.textContent='播放器启动失败：'+(error.message||String(error));document.querySelector('#loading').hidden=true;document.querySelector('#status').textContent='启动失败，请检查导出包文件是否完整';});\n`;
  const html=(await readFile(path.join(root,'web/play.html'),'utf8'))
    .replaceAll('href="/','href="./').replaceAll('src="/','src="./')
    .replace('<script type="module" src="./play.js"></script>','<script src="./project.js"></script>\n<script src="./runtime.js"></script>\n<script src="./player.js"></script>');
  if(html.includes('type="module"'))throw Error('播放器入口模板发生变化，无法生成经典脚本入口');
  const files={
    'index.html':Buffer.from(html),
    'play.css':await readFile(path.join(root,'web/play.css')),
    'project.js':Buffer.from(`globalThis.nekoExportProject=JSON.parse(${JSON.stringify(projectText)});\n`),
    'runtime.js':Buffer.from(`globalThis.nekoExportRuntime=${JSON.stringify({worker:worker.outputFiles[0].text,wasm:wasmBytes.toString('base64')})};\n`),
    'player.js':Buffer.from(wrapped),
    'LICENSE.txt':await readFile(path.join(root,'LICENSE')),
    'README.txt':Buffer.from('NekoC 离线播放器\n\n解压整个目录后双击 index.html，或将整个目录上传到静态托管。\n无需 Node、Rust、本机服务或联网。点击“开始游玩”启动。\n需要支持 WebAssembly、WebGL2 和 Web Worker 的现代浏览器。\nproject.js 内含作品和素材；runtime.js 内含 WASM 与 Worker。\n播放器启动阶段会进行素材解码，重作品可能占用较多内存。\n音视频及麦克风等功能仍受浏览器权限和自动播放策略限制。\n使用 NekoC 运行时，不代表官方播放器行为完全一致。\n'),
  };
  const manifest={format:'nekoc-player-export-v1',entry:'index.html',engine:'wasm',projectName:project.projectName||project.project_name||'',assetBytes:totalBytes,wasmBytes:wasmBytes.length,assets,files:Object.fromEntries(Object.entries(files).map(([name,bytes])=>[name,{bytes:bytes.length,sha256:digest(bytes)}]))};
  files['manifest.json']=Buffer.from(`${JSON.stringify(manifest,null,2)}\n`);
  await mkdir(path.dirname(out),{recursive:true});
  const staging=await mkdtemp(path.join(path.dirname(out),'.nekoc-player-'));
  try{
    if(path.extname(out).toLowerCase()==='.zip'){
      const archive=path.join(staging,'player.zip');
      await writeFile(archive,zipSync(files,{level:6}));
      // Publish the complete same-filesystem archive atomically without replacing
      // an existing output (including a concurrent exporter).
      await link(archive,out);
    }else{
      for(const [name,bytes]of Object.entries(files))await writeFile(path.join(staging,name),bytes);
      if(await exists(out))throw Error(`输出已存在，不会覆盖：${out}`);
      await rename(staging,out);
    }
  }finally{await rm(staging,{recursive:true,force:true});}
  console.log(`播放器已导出：${out} (${assets.length} 个素材，WASM ${wasmBytes.length} bytes)`);
  return manifest;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{
    const {values}=parseArgs({options:{input:{type:'string'},out:{type:'string'},'asset-base':{type:'string'},'wasm-dir':{type:'string'}}});
    if(!values.input||!values.out)throw Error('用法：nekoc export-player <作品.bcmkn|作品.bcm> --out <目录|包.zip> [--wasm-dir <web 绑定目录>]');
    await exportPlayer({input:values.input,out:values.out,assetBase:values['asset-base'],wasmDir:values['wasm-dir']});
  }catch(error){console.error(`导出失败：${error.message}`);process.exitCode=1;}
}
