import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,mkdtemp,rm,cp} from 'node:fs/promises';
import {createHash,webcrypto} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {runInNewContext} from 'node:vm';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {writeOfflineWorker} from '../tools/player-offline.mjs';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {loadPlaywright} from '../tools/probe-kitten4.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const template=await readFile(new URL('../web/offline-sw.js',import.meta.url),'utf8');
const scope='https://fixture.test/NekoC/play/';
const project=()=>({projectName:'离线 <b>测试</b>',scenes:{scenesDict:{}},actors:{actorsDict:{}}});
const sha=body=>createHash('sha256').update(body).digest('hex');

function storage(){
  const buckets=new Map();
  return {buckets,async keys(){return [...buckets.keys()];},async delete(name){return buckets.delete(name);},async open(name){
    if(!buckets.has(name))buckets.set(name,new Map());
    const entries=buckets.get(name),key=value=>typeof value==='string'?value:value.url;
    return {async put(url,response){entries.set(key(url),response.clone());},
      async match(url){return entries.get(key(url))?.clone();},
      async keys(){return [...entries.keys()].map(url=>new Request(url));}};
  }};
}
function worker({version='v1',cache=storage(),network=async()=>new Response('runtime'),clientURL=scope+'play.html',files=['play.html','wasm/nekoc_wasm_bg.wasm'],smallLimits=false}={}){
  const listeners={},requests=[];let claims=0;
  const build={version,files,digests:Object.fromEntries(files.map(file=>[file,sha('runtime')]))};
  const context={URL,Request,Response,Headers,TextEncoder,TextDecoder,Uint8Array,AbortSignal,crypto:webcrypto,btoa,atob,caches:cache,
    fetch:async(...args)=>{requests.push(args);return network(...args);},
    self:{registration:{scope},clients:{claim:async()=>{claims++;},get:async()=>({url:clientURL})},addEventListener:(type,callback)=>listeners[type]=callback}};
  const source=smallLimits?template.replace('maxProject=64*1024*1024,maxAsset=16*1024*1024,maxLibrary=128*1024*1024','maxProject=1024,maxAsset=32,maxLibrary=1500'):template;
  runInNewContext(source.replace('__NEKOC_OFFLINE_BUILD__',JSON.stringify(build)),context);
  const lifecycle=async type=>{let done;listeners[type]({waitUntil:promise=>done=promise});await done;};
  const message=async(action,extra={})=>{
    let reply,done;listeners.message({source:{id:'client'},data:{type:'nekoc-offline',action,...extra},ports:[{postMessage:value=>reply=value}],waitUntil:promise=>done=promise});
    await done;return reply===undefined?undefined:JSON.parse(JSON.stringify(reply));
  };
  const fetch=async(url,options={})=>{
    let result;listeners.fetch({request:{url,method:'GET',headers:new Headers(),...options},respondWith:promise=>result=promise});
    return result;
  };
  return {cache,requests,lifecycle,message,fetch,get claims(){return claims;}};
}

test('r4-pwa: content versions are deterministic and include every runtime byte',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'nekoc-r4-pwa-version-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  await mkdir(path.join(dir,'wasm'));
  await writeFile(path.join(dir,'play.html'),'shell');await writeFile(path.join(dir,'wasm/runtime.wasm'),'one');
  const files=['play.html','wasm/runtime.wasm'],first=await writeOfflineWorker(dir,files);
  assert.deepEqual(await writeOfflineWorker(dir,[...files].reverse()),first);
  assert.equal(first.digests['play.html'],sha('shell'));
  const code=await readFile(path.join(dir,'offline-sw.js'),'utf8');assert.ok(!code.includes('__NEKOC_OFFLINE_BUILD__'));
  await writeFile(path.join(dir,'wasm/runtime.wasm'),'two');
  assert.notEqual((await writeOfflineWorker(dir,files)).version,first.version);
});

test('r4-pwa: installation is integrity checked and failed updates preserve old cache',async()=>{
  const current=worker();await current.lifecycle('install');await current.lifecycle('activate');assert.equal(current.claims,0);
  for(const [request]of current.requests){assert.equal(request.credentials,'omit');assert.equal(request.cache,'reload');assert.equal(request.referrerPolicy,'no-referrer');}
  const cache=current.cache,old=(await cache.keys())[0];
  for(const network of [async()=>{throw Error('offline');},async()=>new Response('partial deploy'),async()=>new Response('runtime',{headers:{'Cache-Control':'private'}})]){
    const next=worker({version:'v2',cache,network});await assert.rejects(next.lifecycle('install'));
    assert.deepEqual(await cache.keys(),[old]);
  }
  await cache.open(`nekoc-player:${scope}:projects:v1`);await cache.open('another-app');
  await cache.open('nekoc-player:https://fixture.test/other/:runtime:v0');
  const next=worker({version:'v2',cache});await next.lifecycle('install');await next.lifecycle('activate');
  assert.ok(!(await cache.keys()).includes(old));
  for(const name of [`nekoc-player:${scope}:projects:v1`,'another-app','nekoc-player:https://fixture.test/other/:runtime:v0'])assert.ok((await cache.keys()).includes(name));
  assert.ok(!/self\.skipWaiting\s*\(/.test(template));
});

test('r4-pwa: fetch serves only the exact shell, never caches URLs or private endpoints',async()=>{
  const sw=worker();await sw.lifecycle('install');const count=sw.requests.length;
  assert.equal(await(await sw.fetch(scope+'play.html?src=private-token',{mode:'navigate'})).text(),'runtime');
  assert.equal(await(await sw.fetch(scope+'wasm/nekoc_wasm_bg.wasm')).text(),'runtime');
  for(const url of [scope+'api/project',scope+'play.html?token=secret',scope+'asset.png','https://cdn.test/file.png',scope+'offline-projects/123',scope+'../index.html'])assert.equal(await sw.fetch(url),undefined,url);
  assert.equal(await sw.fetch(scope+'play.html',{method:'POST'}),undefined);
  assert.equal(await sw.fetch(scope+'play.html',{headers:new Headers({Authorization:'Bearer secret'})}),undefined);
  assert.equal(await sw.fetch(scope+'play.html',{headers:new Headers({Range:'bytes=0-10'})}),undefined);
  assert.equal(sw.requests.length,count);
  for(const name of await sw.cache.keys())for(const request of await(await sw.cache.open(name)).keys())assert.equal(new URL(request.url).search,'');
});

test('r4-pwa: evicted runtime entries recover only from identical manifest bytes',async()=>{
  const cache=storage(),sw=worker({cache});
  assert.equal(await(await sw.fetch(scope+'play.html')).text(),'runtime');
  assert.equal(sw.requests.length,1);
  assert.equal(await(await sw.fetch(scope+'play.html')).text(),'runtime');assert.equal(sw.requests.length,1);
  const mismatch=worker({network:async()=>new Response('new version')});
  assert.equal((await mismatch.fetch(scope+'play.html')).type,'error');
  assert.equal((await(await mismatch.cache.open(`nekoc-player:${scope}:runtime:v1`)).keys()).length,0);
});

test('r4-pwa: projects are explicit, self-contained, escaped, atomic and clearable',async()=>{
  const sw=worker({network:async()=>new Response('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>',{headers:{'Content-Type':'image/svg+xml'}})});
  assert.deepEqual((await sw.message('list')).value,[]);
  const input=project();input.styles={stylesDict:{a:{url:'https://cdn.test/a.svg'},b:{url:'https://cdn.test/a.svg'}}};
  input.codeURL='https://private.test/api/key?token=never-fetch';
  const saved=await sw.message('save',{project:structuredClone(input)});assert.equal(saved.value.length,1);
  assert.equal(saved.value[0].name,input.projectName);assert.equal(sw.requests.length,1);
  const [url,options]=sw.requests[0];assert.equal(url,'https://cdn.test/a.svg');
  for(const [key,value]of Object.entries({credentials:'omit',mode:'cors',cache:'no-store',referrerPolicy:'no-referrer',redirect:'error'}))assert.equal(options[key],value);
  const reopened=(await sw.message('open',{id:saved.value[0].id})).value;
  assert.ok(reopened.assets.image.a.startsWith('data:image/svg+xml;base64,'));
  assert.equal(reopened.assets.image.a,reopened.assets.image.b);
  assert.deepEqual(reopened.project,input,'canonical work and K4 provenance must remain unchanged');
  assert.deepEqual((await sw.message('clear')).value,[]);assert.deepEqual((await sw.message('list')).value,[]);
  assert.equal((await sw.message('open',{id:'../../private'})).error,'offlineSaveFailed');
  assert.equal(await worker({clientURL:'https://fixture.test/studio/'}).message('list'),undefined);
});

test('r4-pwa: credentials, private responses, external SVGs and incomplete assets fail closed',async()=>{
  const unsafe=['https://name:pass@cdn.test/x.png','https://cdn.test/x.png?token=secret','https://cdn.test/private/x.png','https://cdn.test/%61pi/x.png','file:///private.png','blob:https://fixture.test/id',
    'data:image/svg+xml,'+encodeURIComponent('<svg><image href="https://example.test/x"/></svg>'),
    'data:image/svg+xml,'+encodeURIComponent('<svg><style>@import "external.css";</style></svg>'),
    'data:image/svg+xml ;charset=utf-8,'+encodeURIComponent('<svg><image href="https://example.test/a"/></svg>'),
    'data:image/svg+xml,'+encodeURIComponent('<svg><image><set attributeName="href" to="https://example.test/a"/></image></svg>')];
  for(const url of unsafe){
    const sw=worker(),input=project();input.styles={stylesDict:{x:{url}}};
    assert.equal((await sw.message('save',{project:input})).error,'offlineUnsafeAsset',url);
    assert.deepEqual((await sw.message('list')).value,[]);assert.equal(sw.requests.length,0);
  }
  for(const network of [async()=>new Response('secret',{headers:{'Content-Type':'image/png','Cache-Control':'no-store'}}),async()=>new Response('private',{headers:{'Content-Type':'image/png','Cache-Control':'private'}}),
    async()=>new Response('<html>login</html>',{headers:{'Content-Type':'text/html'}}),async()=>new Response('missing',{status:404}),
    async()=>new Response('huge',{headers:{'Content-Type':'image/png','Content-Length':String(17*1024*1024)}}),
    async()=>({ok:true,type:'cors',headers:new Headers({'Content-Type':'image/png'}),body:{getReader:()=>({read:async()=>{throw Error('truncated body');},cancel:async()=>{}})}}),
    async()=>{throw Error('network failure');}]){
    const sw=worker({network}),input=project();input.styles={stylesDict:{embedded:{url:'data:image/png;base64,AA=='},remote:{url:'https://cdn.test/a.png'}}};
    assert.ok((await sw.message('save',{project:input})).error);assert.deepEqual((await sw.message('list')).value,[]);
  }
});

test('r4-pwa: library limit and serialized writes do not silently evict works',async()=>{
  const sw=worker();
  const replies=await Promise.all(Array.from({length:6},()=>sw.message('save',{project:project()})));
  assert.equal(replies.filter(reply=>reply.value).length,5);
  assert.equal(replies.at(-1).error,'offlineTooLarge');assert.equal((await sw.message('list')).value.length,5);
});

test('r4-pwa: Unicode names remain valid at the truncation boundary',async()=>{
  const sw=worker(),input=project();input.projectName='a'.repeat(159)+'😀';
  const saved=await sw.message('save',{project:input});assert.equal(saved.value[0].name,input.projectName);
  input.projectName='broken\ud800';
  assert.equal((await sw.message('save',{project:input})).value.at(-1).name,'broken�');
});

test('r4-pwa: audio/video sidecars deduplicate downloads and quota errors are recoverable',async()=>{
  const sw=worker({network:async url=>new Response('media',{headers:{'Content-Type':url.endsWith('.mp4')?'video/mp4':'audio/ogg'}})});
  const input=project();
  input.audios={audiosDict:{a:{cdn_url:'https://cdn.test/a.ogg'},b:{url:'https://cdn.test/a.ogg'}}};
  input.videos={videosDict:{v:{url:'https://cdn.test/v.mp4'}}};
  const saved=await sw.message('save',{project:input});assert.equal(saved.value.length,1);
  const reopened=(await sw.message('open',{id:saved.value[0].id})).value;
  assert.ok(reopened.assets.audio.a.startsWith('data:audio/ogg;base64,'));
  assert.equal(reopened.assets.audio.a,reopened.assets.audio.b);
  assert.ok(reopened.assets.video.v.startsWith('data:video/mp4;base64,'));assert.equal(sw.requests.length,2);
  const open=sw.cache.open.bind(sw.cache);let fail=true;
  sw.cache.open=async name=>{const cache=await open(name);return {...cache,put:async(...args)=>{if(fail){fail=false;throw Error('QuotaExceededError');}return cache.put(...args);}};};
  assert.ok((await sw.message('save',{project:project()})).error);
  assert.equal((await sw.message('list')).value.length,1);
  assert.equal((await sw.message('save',{project:project()})).value.length,2);
});

test('r4-pwa: streaming, per-project and total byte limits preserve saved works',async()=>{
  const sw=worker({smallLimits:true,network:async()=>new Response('x'.repeat(33),{headers:{'Content-Type':'image/png'}})});
  const input=project();input.styles={stylesDict:{a:{url:'https://cdn.test/a.png'}}};
  assert.equal((await sw.message('save',{project:input})).error,'offlineTooLarge');
  assert.deepEqual((await sw.message('list')).value,[]);
  const large=project();large.padding='x'.repeat(1100);
  assert.equal((await sw.message('save',{project:large})).error,'offlineTooLarge');
  const medium=project();medium.padding='x'.repeat(600);
  const first=await sw.message('save',{project:medium});assert.equal(first.value.length,1);
  assert.equal((await sw.message('save',{project:medium})).error,'offlineTooLarge');
  assert.equal((await sw.message('list')).value[0].id,first.value[0].id);
});

test('r4-pwa: Pages build includes the complete module graph without enabling other hosts',async t=>{
  const fixture=await mkdtemp(path.join(os.tmpdir(),'nekoc-r4-pwa-pages-'));t.after(()=>rm(fixture,{recursive:true,force:true}));
  for(const folder of ['web','site','samples','packages/nekoc'])await cp(path.join(root,folder),path.join(fixture,folder),{recursive:true,filter:source=>!source.includes(path.sep+'dist')});
  await mkdir(path.join(fixture,'tools'));
  for(const file of ['build-pages.mjs','player-offline.mjs'])await cp(path.join(root,'tools',file),path.join(fixture,'tools',file));
  // Resolve the existing compiler without installing or starting any compiler.
  await mkdir(path.join(fixture,'node_modules/typescript'),{recursive:true});
  await writeFile(path.join(fixture,'node_modules/typescript/package.json'),'{"main":"lib/typescript.js"}');
  await mkdir(path.join(fixture,'node_modules/typescript/lib'));
  await writeFile(path.join(fixture,'node_modules/typescript/lib/typescript.js'),'var ts={};');
  await writeFile(path.join(fixture,'node_modules/typescript/LICENSE.txt'),'fixture');
  const dist=path.join(fixture,'packages/nekoc/dist');
  for(const dir of ['web','frontend'])await mkdir(path.join(dist,dir),{recursive:true});
  for(const file of ['web/nekoc_wasm.js','web/nekoc_wasm_bg.wasm','resources.mjs'])await writeFile(path.join(dist,file),'fixture');
  const output=path.join(fixture,'output'),result=spawnSync(process.execPath,['tools/build-pages.mjs',output],{cwd:fixture,encoding:'utf8'});
  assert.ifError(result.error);assert.equal(result.status,0,result.stdout+result.stderr);
  const html=await readFile(path.join(output,'play/play.html'),'utf8');assert.match(html,/name="nekoc-offline" content="enabled"/);
  assert.ok(!html.includes('src="/'));
  const generated=await readFile(path.join(output,'play/offline-sw.js'),'utf8');
  const build=JSON.parse(generated.match(/const BUILD=(.*);/)[1]),seen=new Set(),pending=['play.js','wasm-worker.js'];
  while(pending.length){
    const file=pending.pop();if(seen.has(file))continue;seen.add(file);assert.ok(build.files.includes(file),file);
    const source=await readFile(path.join(output,'play',file),'utf8');
    for(const match of source.matchAll(/(?:from\s*|import\s*\()\s*['"]\.[/]([^'"]+\.js)['"]/g))if(match[1]!=='extension.js')pending.push(match[1]);
  }
  for(const file of build.files)assert.equal(sha(await readFile(path.join(output,'play',file))),build.digests[file],file);
  assert.ok(build.files.includes('wasm/nekoc_wasm_bg.wasm'));
  for(const file of ['web/play.html','extension/manifest.json'])assert.ok(!(await readFile(path.join(root,file),'utf8')).includes('name="nekoc-offline"'));
});

test('r4-pwa: UI requires consent, stays safe when busy and handles worker denial',async()=>{
  const source=(await readFile(new URL('../web/offline.js',import.meta.url),'utf8'))
    .replace(/^import .*;$/m,'').replace('export async function','async function')
    .replaceAll('import.meta.url',JSON.stringify(scope+'offline.js'));
  const elements=new Map(),events={},registrationEvents={},errors=[],requests=[];
  let consent=false,busy=false,opened=null;
  const element=()=>({hidden:true,disabled:false,textContent:'',value:'',options:[],replaceChildren(){this.options=[];},append(option){this.options.push(option);this.value=this.value||option.value;}});
  const registration={waiting:null,update:async()=>{},addEventListener:(name,fn)=>registrationEvents[name]=fn};
  const controller={scriptURL:scope+'offline-sw.js',postMessage(message,ports){requests.push(message);
    const value=message.action==='list'?[]:message.action==='save'?[{id:'saved',name:'<img src=x>'}]:message.action==='open'?{project:project(),assets:{}}:[];
    ports[0].postMessage({value});
  }};
  const api=runInNewContext(source+';setupOffline',{URL,MessageChannel,setTimeout,clearTimeout,
    isSecureContext:true,navigator:{serviceWorker:{controller,register:async()=>registration,addEventListener:(name,fn)=>events[name]=fn}},
    document:{querySelector(selector){if(!elements.has(selector))elements.set(selector,element());return elements.get(selector);},createElement:element},
    confirm:()=>consent,t:key=>key});
  const ui=await api({getProject:()=>busy?null:project(),isBusy:()=>busy,openProject:async value=>opened=value,onError:error=>errors.push(error)});
  // Flush the initial asynchronous MessageChannel reply through its owning task.
  await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
  const save=elements.get('#offline-save'),open=elements.get('#offline-open'),select=elements.get('#offline-projects');
  save.onclick();assert.equal(requests.filter(request=>request.action==='save').length,0);
  consent=true;save.onclick();
  await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
  assert.equal(requests.filter(request=>request.action==='save').length,1);
  assert.equal(select.options[0].textContent,'<img src=x>');assert.equal(open.disabled,false);
  busy=true;ui.refresh();assert.equal(open.disabled,true);open.onclick();assert.equal(opened,null);
  busy=false;ui.refresh();open.onclick();
  await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
  assert.ok(opened.project);
  controller.postMessage=()=>{throw Error('DataCloneError');};save.onclick();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(errors.at(-1),'offlineSaveFailed');assert.equal(save.disabled,false);
  registration.waiting={};registration.installing={state:'installing',addEventListener:(name,fn)=>events[name]=fn};registrationEvents.updatefound();
  registration.installing.state='installed';events.statechange();
  assert.equal(elements.get('#offline-status').textContent,'offlineUpdate');
  // An activated worker can accept opt-in library messages from the first
  // uncontrolled page without switching its module fetches halfway through.
  const previous=controller.postMessage;
  controller.postMessage=(message,ports)=>ports[0].postMessage({value:[]});
  registration.active={...controller,state:'activated'};
  const firstVisit=runInNewContext(source+';setupOffline',{URL,MessageChannel,setTimeout,clearTimeout,isSecureContext:true,
    navigator:{serviceWorker:{controller:null,register:async()=>registration,addEventListener(){}}},
    document:{querySelector:selector=>elements.get(selector),createElement:element},confirm:()=>false,t:key=>key});
  await firstVisit({getProject:project,isBusy:()=>false,openProject:async()=>{},onError:error=>errors.push(error)});
  await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
  assert.equal(save.disabled,false);controller.postMessage=previous;
});

// Real browser and SW/Worker/WASM loading, deterministic VM fixture. This is
// a transport/offline regression, not evidence about official VM semantics.
test('r4-pwa: browser reopens saved work offline, keeps updates atomic and clears private data',
  {skip:!process.env.NEKOC_PWA_E2E,timeout:120000},async t=>{
    const dir=await mkdtemp(path.join(os.tmpdir(),'nekoc-r4-pwa-browser-'));t.after(()=>rm(dir,{recursive:true,force:true}));
    const files=(await readFile(path.join(root,'tools/build-pages.mjs'),'utf8')).match(/const playerFiles=(\[[^;]+\]);/)[1];
    const names=JSON.parse(files.replaceAll("'",'"'));
    for(const file of names)await cp(path.join(root,'web',file),path.join(dir,file));
    await mkdir(path.join(dir,'wasm'));
    await writeFile(path.join(dir,'play.html'),(await readFile(path.join(root,'web/play.html'),'utf8'))
      .replaceAll('href="/','href="./').replaceAll('src="/','src="./')
      .replace('<head>','<head><meta name="nekoc-engine" content="wasm"><meta name="nekoc-offline" content="enabled">'));
    // Actually instantiate a valid WASM module in the real runtime Worker.
    await writeFile(path.join(dir,'wasm/nekoc_wasm_bg.wasm'),new Uint8Array([0,97,115,109,1,0,0,0]));
    await writeFile(path.join(dir,'wasm/nekoc_wasm.js'),`
      export default async function init({module_or_path}){await WebAssembly.instantiate(module_or_path);}
      export const importProject=text=>{
        const project=JSON.parse(text);
        if(project.requiresUntouchedImport&&project.styles.stylesDict.image.url.startsWith('data:'))throw Error('offline media must not change the work before revalidation');
        return JSON.stringify({project,report:{fast_runtime_ready:true}});
      };
      export const checkExtensions=()=>JSON.stringify({ok:true});
      export class Player{
        constructor(){this.frames=0;}free(){}ready(){return JSON.stringify({ready:true});}
        handle(text){
          if(JSON.parse(text).debug_snapshot)return JSON.stringify({snapshot:{frames:this.frames}});
          this.frames++;
          const metadata=new TextEncoder().encode(JSON.stringify({sprites:[],execute_us:100,timer:0,timer_visible:false}));
          const length=Math.ceil(metadata.length/4)*4,frame=new Uint8Array(4+length);
          new DataView(frame.buffer).setUint32(0,length,true);frame.fill(32,4);frame.set(metadata,4);return frame;
        }
      }
    `);
    const all=['play.html',...names,'wasm/nekoc_wasm.js','wasm/nekoc_wasm_bg.wasm'];
    await writeOfflineWorker(dir,all);
    const received=[];let browser;
    const server=createServer(async(req,res)=>{
      received.push({url:req.url,cookie:req.headers.cookie});
      const pathname=new URL(req.url,'http://localhost').pathname;
      try{
        if(pathname==='/a.svg'){res.setHeader('Content-Type','image/svg+xml');res.end('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>');return;}
        if(!pathname.startsWith('/NekoC/play/')){res.setHeader('Content-Type','application/json');res.end('{"private":"do-not-cache"}');return;}
        const name=pathname.slice('/NekoC/play/'.length);
        if(!all.includes(name)&&name!=='offline-sw.js'){res.writeHead(404).end();return;}
        res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.wasm')?'application/wasm':'text/html');
        res.setHeader('Cache-Control','no-cache');res.end(await readFile(path.join(dir,name)));
      }catch{res.writeHead(404).end();}
    });
    server.listen(0,'127.0.0.1');await once(server,'listening');
    t.after(()=>new Promise(resolve=>server.close(resolve)));
    browser=await loadPlaywright().chromium.launch({headless:true,...(process.env.NEKOC_BROWSER_CHANNEL?{channel:process.env.NEKOC_BROWSER_CHANNEL}:process.platform==='win32'?{channel:'msedge'}:{}),args:['--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox']});
    t.after(()=>browser.close());
    const context=await browser.newContext(),page=await context.newPage(),errors=[];
    page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>dialog.accept());
    const origin=`http://127.0.0.1:${server.address().port}`,entry=origin+'/NekoC/play/play.html';
    const ready=()=>page.waitForFunction(()=>window.nekoPlayDiagnostics&&!window.nekoPlayDiagnostics().busy);
    await page.goto(entry);await ready();
    await page.waitForFunction(async()=>(await navigator.serviceWorker.getRegistration())?.active?.state==='activated');
    assert.equal(await page.evaluate(()=>navigator.serviceWorker.controller),null,'first visit must not be forcibly claimed');
    await page.waitForFunction(()=>document.querySelector('#offline-status').textContent.includes('运行时可离线'));
    await page.locator('#offline-controls summary').click();
    assert.equal(await page.locator('#offline-projects option').count(),0);
    await context.addCookies([{name:'session',value:'secret',url:origin}]);
    await page.evaluate(async()=>{await fetch('/api/project');await fetch('/api/private',{method:'POST',body:'secret'});});
    const input=project();input.stageSize={width:480,height:360};input.requiresUntouchedImport=true;
    input.scenes={currentSceneId:'scene',scenesDict:{scene:{actorIds:[],currentStyleId:'image',styles:['image']}}};
    input.styles={stylesDict:{image:{url:origin+'/a.svg'}}};
    await page.locator('#file').setInputFiles({name:'fixture.bcmkn',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(input))});
    await page.waitForFunction(()=>window.nekoPlayDiagnostics().totalUpdates>0);await ready();
    assert.equal(await page.locator('#offline-projects option').count(),0,'opening must not persist the project');
    const beforeSave=received.length;
    await page.locator('#offline-save').click();
    await page.waitForFunction(()=>document.querySelector('#offline-status').textContent.includes('作品已保存'));
    const assetRequest=received.slice(beforeSave).find(request=>request.url==='/a.svg');
    assert.ok(assetRequest);assert.equal(assetRequest.cookie,undefined);
    assert.equal(await page.locator('#offline-projects option').textContent(),input.projectName);
    assert.equal(await page.locator('#offline-controls b').count(),0,'project names are inert text');
    await context.setOffline(true);await page.reload();await ready();
    await page.locator('#offline-controls summary').click();
    await page.waitForFunction(()=>document.querySelector('#offline-projects').options.length===1);
    await page.locator('#offline-open').click();
    await page.waitForFunction(name=>window.nekoPlayDiagnostics().projectName===name&&!window.nekoPlayDiagnostics().busy,input.projectName);
    assert.equal(await page.evaluate(()=>window.nekoPlayDiagnostics().projectName),input.projectName);
    assert.equal(await page.evaluate(()=>window.nekoPlayDiagnostics().running),false);
    await page.locator('#toggle').click();
    await page.waitForFunction(()=>window.nekoPlayDiagnostics().totalUpdates>0);
    assert.equal(await page.locator('#notice').isVisible(),false);
    await page.locator('#stop').click();await ready();
    const cacheNames=await page.evaluate(()=>caches.keys()),old=cacheNames.find(name=>name.includes(':runtime:'));
    assert.ok(old);
    await context.setOffline(false);
    await writeFile(path.join(dir,'play.css'),(await readFile(path.join(dir,'play.css'),'utf8'))+'\n/* v2 */\n');
    await writeOfflineWorker(dir,all);
    await page.evaluate(async()=>{await(await navigator.serviceWorker.getRegistration()).update();});
    await page.waitForFunction(async()=>!!(await navigator.serviceWorker.getRegistration()).waiting);
    assert.ok((await page.evaluate(()=>caches.keys())).includes(old),'active tab keeps the old runtime');
    await page.waitForFunction(()=>document.querySelector('#offline-status').textContent.includes('新版已下载'));
    await page.close();
    const next=await context.newPage();next.on('pageerror',error=>errors.push(error.message));next.on('dialog',dialog=>dialog.accept());
    await next.goto(entry);await next.waitForFunction(()=>window.nekoPlayDiagnostics&&!window.nekoPlayDiagnostics().busy);
    await next.waitForFunction(async old=>!(await caches.keys()).includes(old),old);
    const keys=await next.evaluate(()=>caches.keys());assert.ok(!keys.includes(old));
    assert.equal(keys.filter(name=>name.includes(':runtime:')).length,1);
    await next.locator('#offline-controls summary').click();
    await next.waitForFunction(()=>document.querySelector('#offline-projects').options.length===1);
    await next.locator('#offline-clear').click();
    await next.waitForFunction(()=>!document.querySelector('#offline-projects').options.length);
    const cachedRequests=await next.evaluate(async()=>{const urls=[];for(const name of await caches.keys())for(const request of await(await caches.open(name)).keys())urls.push(request.url);return urls;});
    assert.ok(cachedRequests.every(url=>url.startsWith(entry.replace('play.html',''))&&!url.includes('/api/')&&!url.includes('/offline-projects/')&&!new URL(url).search));
    assert.deepEqual(errors,[]);
    await context.close();
  });
