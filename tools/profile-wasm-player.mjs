// Local, opt-in measurements. Keep measured numbers outside the repository.
import {createServer} from 'node:http';
import {createServer as createPortServer} from 'node:net';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {cpus,platform} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {loadPlaywright} from './probe-kitten4.mjs';

export function summarize(values){
  if(!values.length||values.some(n=>!Number.isFinite(n)||n<0))throw Error('Expected finite nonnegative samples');
  const sorted=[...values].sort((a,b)=>a-b);
  return {count:values.length,mean:values.reduce((a,b)=>a+b,0)/values.length,p50:sorted[Math.floor(sorted.length*.5)],p95:sorted[Math.min(sorted.length-1,Math.floor(sorted.length*.95))],max:sorted.at(-1)};
}

async function browserMeasure({kind,frames,warmup,budget}){
  const {PlayerConnection}=await import('/player.js');
  const {wasmBackend,httpBackend}=await import('/backend.js');
  const {StageRenderer,decodeFrame,sensesColor}=await import('/renderer.js');
  const now=()=>performance.now(),start=now();
  const backend=kind==='wasm'?wasmBackend():httpBackend(location.origin);
  const connection=new PlayerConnection();
  try{
    const response=await fetch('/fixture',{cache:'no-store'}),text=await response.text(),download=now();
    const input=JSON.parse(text),parsed=now();
    const report=await backend.api('import-player',input),imported=now();
    if(!report.fast_runtime_ready)throw Error(report.runtime_error||'Project is not playable');
    const renderer=new StageRenderer(document.querySelector('canvas'));
    renderer.resolutionScale=1;const errors=[];renderer.onError=message=>errors.push(message);
    await renderer.load(report.project);renderer.render();const assets=now();
    await connection.open(report.project,backend);const opened=now();
    const payload={dt:1/60,budget_ms:budget,coalesce:false};
    // Match play.js: decoded video duration/geometry are runtime inputs, not
    // just renderer assets. Omitting them can leave play-until-end suspended.
    const first=decodeFrame(await connection.frame({...payload,costumes:renderer.costumeInfo(sensesColor(report.project)),videos:renderer.videoInfo()}));
    renderer.apply(first.frame,first.lines,false);renderer.render();renderer.gl.finish();const drawn=now();
    const samples=[];let instructions=0,bytes=0,yields=0,lastFrame=first.frame;
    for(let i=0;i<warmup+frames;i++){
      const begin=now(),buffer=await connection.frame({...payload,videos:renderer.videoInfo()}),received=now();
      const {frame,lines}=decodeFrame(buffer),decoded=now();
      renderer.apply(frame,lines,false);renderer.render();const submitted=now();
      lastFrame=frame;
      if(i>=warmup){
        samples.push({roundtrip:received-begin,decode:decoded-received,submit:submitted-decoded,total:submitted-begin,vm:frame.execute_us/1000});
        instructions+=frame.instructions;bytes+=buffer.byteLength;yields+=Number(frame.budget_yield);
      }
    }
    // Do not embed user projects/private variables in a performance report.
    // Aggregate progress lets probes distinguish completed work from a cheap
    // permanently suspended script without leaking logs or private variables.
    const videos=lastFrame.videos||[];
    const progress={activeTasks:lastFrame.active,playingVideos:videos.filter(v=>v.playing).length,endedVideos:videos.filter(v=>v.ended).length,visibleVideos:videos.filter(v=>v.visible).length};
    return {startup:{projectDownload:download-start,jsParse:parsed-download,workerImport:imported-parsed,assets:assets-imported,handshake:opened-assets,firstFrame:drawn-opened,total:drawn-start},samples,instructions,bytes,yields,errors,progress};
  }finally{connection.close();backend.terminate?.();}
}

async function isolatedMeasure(){
  const t=performance.now();
  const wasm=await import('/wasm/nekoc_wasm.js');const bindings=performance.now();
  const bytes=await(await fetch('/wasm/nekoc_wasm_bg.wasm',{cache:'no-store'})).arrayBuffer();const downloaded=performance.now();
  const module=await WebAssembly.compile(bytes);const compiled=performance.now();
  await wasm.default({module_or_path:module});const instantiated=performance.now();
  const text=JSON.stringify(await(await fetch('/fixture')).json());
  const begin=performance.now(),result=wasm.importProject(text),imported=performance.now();
  const parsed=JSON.parse(result),decoded=performance.now();
  const handshake=JSON.stringify(parsed.project),serialized=performance.now();
  const player=new wasm.Player(handshake),loaded=performance.now();
  try{player.handle('{"dt":0.016666666666666666,"budget_ms":16}');}
  finally{player.free();}
  return {bytes:bytes.byteLength,bindings:bindings-t,download:downloaded-bindings,compile:compiled-downloaded,instantiate:instantiated-compiled,import:imported-begin,decodeImport:decoded-imported,serializeHandshake:serialized-decoded,parseCompileStart:loaded-serialized};
}

async function startNative(binary){
  const reserve=createPortServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');
  const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
  const child=spawn(path.resolve(binary),['--port',String(port)],{stdio:['ignore','pipe','pipe']});
  let output='';child.stderr.on('data',data=>output+=data);
  try{
    await new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(Error(`Native startup timeout: ${output}`)),30000);
      const done=error=>{clearTimeout(timeout);error?reject(error):resolve();};
      child.once('error',done);child.once('exit',code=>done(Error(`Native exit ${code}: ${output}`)));
      child.stdout.on('data',data=>{output+=data;if(output.includes('http://'))done();});
    });
    return {child,origin:`http://127.0.0.1:${port}`};
  }catch(error){child.kill();throw error;}
}

async function main(){
  const {values,positionals}=parseArgs({allowPositionals:true,options:{wasm:{type:'string',default:'packages/nekoc/dist/web'},out:{type:'string',default:'dist/r2-wasm/profile.json'},runs:{type:'string',default:'3'},frames:{type:'string',default:'180'},warmup:{type:'string',default:'30'},budget:{type:'string',default:'16'},web:{type:'string',default:`target/release/web${process.platform==='win32'?'.exe':''}`}}});
  const options=Object.fromEntries(['runs','frames','warmup','budget'].map(key=>[key,Number(values[key])]));
  for(const key of ['runs','frames','warmup'])if(!Number.isSafeInteger(options[key])||options[key]<(key==='warmup'?0:1))throw Error(`Invalid ${key}`);
  if(!Number.isFinite(options.budget)||options.budget<1||options.budget>16)throw Error('budget must be 1..16 ms');
  const files=positionals.length?positionals:['samples/three_body.bcmkn','samples/pen_display_fast.bcmkn','samples/pen_display_columns.bcmkn'];
  const wasmRoot=path.resolve(values.wasm),root=path.resolve('web');
  let fixture;
  const server=createServer(async(req,res)=>{
    try{
      res.setHeader('Cache-Control','no-store');
      const url=new URL(req.url,'http://localhost');
      if(url.pathname==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><canvas width=900 height=562></canvas>');return;}
      if(url.pathname==='/fixture'){res.setHeader('Content-Type','application/json');res.end(fixture);return;}
      const file=path.join(url.pathname.startsWith('/wasm/')?wasmRoot:root,path.basename(url.pathname));
      res.setHeader('Content-Type',file.endsWith('.wasm')?'application/wasm':'text/javascript');res.end(await readFile(file));
    }catch(error){res.statusCode=404;res.end(String(error));}
  });
  let browser,native;
  try{
    server.listen(0,'127.0.0.1');await once(server,'listening');
    const origin=`http://127.0.0.1:${server.address().port}`;
    const report={environment:{platform:platform(),cpu:cpus()[0].model,browser:null,wasmSha256:createHash('sha256').update(await readFile(path.join(wasmRoot,'nekoc_wasm_bg.wasm'))).digest('hex'),network:'loopback, no-store; no WAN simulation',gpu:'SwiftShader',compilation:'Fresh browser for Worker and isolated phases; fresh native process per run',startupBoundary:'After player/backend/renderer JS modules load; not full page navigation',firstFrame:'GL finish, not physical display scanout; audio excluded',...options},projects:[]};
    for(const file of files){
      fixture=await readFile(file);const project={file,sha256:createHash('sha256').update(fixture).digest('hex'),bytes:fixture.length,runs:[]};
      for(let run=0;run<options.runs;run++){
        browser=await loadPlaywright().chromium.launch({headless:true,channel:process.env.NEKOC_BROWSER_CHANNEL||'msedge',args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
        report.environment.browser=await browser.version();
        native=await startNative(values.web);const nativeOrigin=native.origin;
        const result={};
        for(const kind of run%2?['rust','wasm']:['wasm','rust']){
          const tab=await browser.newPage();
          if(kind==='rust'){
            await tab.route(`${nativeOrigin}/play.js`,route=>route.fulfill({contentType:'text/javascript',body:''}));
            await tab.route(`${nativeOrigin}/fixture`,route=>route.fulfill({contentType:'application/json',body:fixture}));
            await tab.goto(`${nativeOrigin}/play`);
            await tab.setContent('<!doctype html><canvas width=900 height=562></canvas>');
          }else await tab.goto(origin);
          result[kind]=await tab.evaluate(browserMeasure,{kind,...options});
          result[kind].summary=Object.fromEntries(['roundtrip','decode','submit','total','vm'].map(key=>[key,summarize(result[kind].samples.map(s=>s[key]))]));
          await tab.close();
        }
        await browser.close();native.child.kill();native=null;
        browser=await loadPlaywright().chromium.launch({headless:true,channel:process.env.NEKOC_BROWSER_CHANNEL||'msedge'});
        const page=await browser.newPage();await page.goto(origin);
        result.isolated=await page.evaluate(isolatedMeasure);
        project.runs.push(result);await browser.close();browser=null;
        console.log(JSON.stringify({file,run,isolated:result.isolated,wasm:result.wasm.startup,rust:result.rust.startup,wasmFrame:result.wasm.summary.total,rustFrame:result.rust.summary.total}));
      }
      report.projects.push(project);
      await mkdir(path.dirname(values.out),{recursive:true});await writeFile(values.out,JSON.stringify(report,null,2)+'\n');
    }
  }finally{await browser?.close();native?.child.kill();await new Promise(resolve=>server.close(resolve));}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
