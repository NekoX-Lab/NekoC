import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {once} from 'node:events';
import vm from 'node:vm';
import {wasmBackend} from '../web/backend.js';
import {loadPlaywright} from '../tools/probe-kitten4.mjs';

function mockWorker(t,Worker){
  const previous=Object.getOwnPropertyDescriptor(globalThis,'Worker');
  Object.defineProperty(globalThis,'Worker',{configurable:true,value:Worker});
  t.after(()=>{if(previous)Object.defineProperty(globalThis,'Worker',previous);else delete globalThis.Worker;});
}
test('WASM backend replays progress, resolves readiness and unsubscribes cleanly',async t=>{
  class Worker {constructor(){this.posts=[];Worker.last=this;}postMessage(value){this.posts.push(value);}terminate(){}}
  mockWorker(t,Worker);
  const backend=wasmBackend('blob:fixture'),worker=Worker.last,updates=[];
  const unsubscribe=backend.subscribeProgress(value=>updates.push(value));
  assert.match(updates[0].label,/WASM/);
  worker.onmessage({data:{progress:{label:'下载 WASM',completed:4,total:8}}});
  assert.equal(updates.at(-1).completed,4);
  worker.onmessage({data:{ready:true}});await backend.ready;
  assert.match(updates.at(-1).label,/就绪/);unsubscribe();
  const count=updates.length;worker.onmessage({data:{progress:{label:'ignored'}}});
  assert.equal(updates.length,count);backend.terminate();
});

test('WASM initialization errors reject waiting and future calls without timeout',async t=>{
  class Worker {constructor(){Worker.last=this;}postMessage(){}terminate(){}}
  mockWorker(t,Worker);
  for(const type of ['message','event']){
    const backend=wasmBackend('blob:fixture'),worker=Worker.last;
    const ready=assert.rejects(backend.ready,/WASM.*加载失败/);
    const request=assert.rejects(backend.api('import-player',{}),/WASM.*加载失败/);
    const socket=backend.connect({});let socketError;socket.onerror=event=>{socketError=event.error;};
    if(type==='message')worker.onmessage({data:{error:'WASM 运行时加载失败：fixture'}});
    else worker.onerror({message:'加载失败',preventDefault(){}});
    await Promise.all([ready,request]);assert.match(socketError.message,/WASM.*加载失败/);
    await assert.rejects(backend.api('import-player',{}),/WASM.*加载失败/);
    assert.throws(()=>backend.connect({}),/WASM.*加载失败/);
  }
});

async function workerFixture({bytes,fetch,init=async()=>{}}){
  const messages=[];let initialized;
  const source=(await readFile(new URL('../web/wasm-worker.js',import.meta.url),'utf8'))
    .replace(/^import .*;$/m,'').replaceAll('import.meta.url',JSON.stringify('https://fixture.test/wasm-worker.js'));
  const context=vm.createContext({Uint8Array,URL,AbortSignal,fetch,globalThis:{nekoPlayerWasmBytes:bytes},
    init:async options=>{initialized=options.module_or_path;await init(options);},
    importProject(){},checkExtensions(){},Player:class{},self:{},postMessage:value=>messages.push(value)});
  vm.runInContext(source,context);await vm.runInContext('ready',context);
  return {messages,initialized};
}
test('embedded WASM bytes skip fetch and announce compile plus ready stages',async()=>{
  const bytes=new Uint8Array([0,97,115,109]);
  const {messages,initialized}=await workerFixture({bytes,fetch:()=>{throw Error('must not fetch embedded WASM');}});
  assert.equal(initialized,bytes);
  assert.equal(messages[0].progress.completed,4);assert.equal(messages[0].progress.total,4);
  assert.ok(messages.some(message=>/初始化/.test(message.progress?.label)));
  assert.equal(messages.at(-1).ready,true);
});
test('network WASM reports streamed byte counts and handles missing content length',async()=>{
  for(const length of ['5',null]){
    let requested;
    const {messages,initialized}=await workerFixture({fetch:async url=>{
      requested=String(url);const chunks=[new Uint8Array([1,2]),new Uint8Array([3,4,5])];
      return {ok:true,headers:{get:()=>length},body:{getReader:()=>({read:async()=>chunks.length?{value:chunks.shift(),done:false}:{done:true}})}};
    }});
    assert.equal(requested,'https://fixture.test/wasm/nekoc_wasm_bg.wasm');
    assert.deepEqual([...initialized],[1,2,3,4,5]);
    const partial=messages.find(message=>message.progress?.completed===2).progress;
    assert.equal(partial.total,length?5:null);
    assert.equal(messages.at(-1).ready,true);
  }
});
test('WASM fetch and compile failures emit readable errors instead of an unhandled rejection',async()=>{
  const unavailable=await workerFixture({fetch:async()=>({ok:false,status:503})});
  assert.match(unavailable.messages.at(-1).error,/WASM.*HTTP 503/);
  const broken=await workerFixture({bytes:new Uint8Array([1]),init:async()=>{throw Error('bad module');}});
  assert.match(broken.messages.at(-1).error,/WASM.*bad module/);
  assert.equal(broken.messages.some(message=>message.ready),false);
});

// Local WebGL/DOM integration with a deterministic backend, not a VM or official-compatibility test.
test('player feedback browser: progress, modes, stop/restart and off-stage errors',
  {skip:!process.env.NEKOC_PLAYER_FEEDBACK_E2E,timeout:120000},async()=>{
    const project={projectName:'Feedback fixture',stageSize:{width:480,height:360},scenes:{currentSceneId:'scene',scenesDict:{scene:{actorIds:[]}}}};
    const server=createServer(async(req,res)=>{
      try{
        const path=new URL(req.url,'http://localhost').pathname;
        if(path==='/api/project'||path==='/api/import-player'){
          res.setHeader('Content-Type','application/json');res.end(JSON.stringify(path==='/api/project'?project:{project,fast_runtime_ready:true}));return;
        }
        const file=path==='/'?'play.html':path.slice(1);
        if(!/^[\w.-]+\.(?:js|css|html)$/.test(file)){res.writeHead(404).end();return;}
        res.setHeader('Content-Type',file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'text/html');
        res.end(await readFile(new URL(`../web/${file}`,import.meta.url)));
      }catch{res.writeHead(404).end();}
    });
    server.listen(0,'127.0.0.1');await once(server,'listening');
    const origin=`http://127.0.0.1:${server.address().port}`;let browser;
    try{
      browser=await loadPlaywright().chromium.launch({headless:true,channel:process.env.NEKOC_BROWSER_CHANNEL||'msedge',args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
      const page=await browser.newPage({viewport:{width:1280,height:800}}),errors=[];
      page.on('pageerror',error=>errors.push(error.message));
      const ready=()=>page.waitForFunction(()=>window.nekoPlayDiagnostics&&!window.nekoPlayDiagnostics().busy);
      await page.goto(origin);await ready();
      assert.match(await page.locator('#runtime-mode').textContent(),/本机 VM/);
      assert.equal(await page.locator('#stop').isEnabled(),false);
      const withAsset=structuredClone(project);withAsset.scenes.scenesDict.scene.currentStyleId='asset';
      withAsset.styles={stylesDict:{asset:{name:'fixture missing image',url:`${origin}/asset.png`}}};
      let releaseAsset;const assetGate=new Promise(resolve=>{releaseAsset=resolve;});
      await page.route('**/api/import-player',route=>route.fulfill({json:{project:withAsset,fast_runtime_ready:true}}));
      await page.route('**/asset.png',async route=>{await assetGate;await route.fulfill({status:404,body:'missing'});});
      await page.goto(origin,{waitUntil:'domcontentloaded'});
      await page.waitForFunction(()=>document.querySelector('#load-label').textContent.includes('加载图片'));
      assert.equal(await page.locator('#load-progress').getAttribute('value'),'0');
      assert.equal(await page.locator('#load-progress').getAttribute('max'),'1');
      releaseAsset();await ready();assert.match(await page.locator('#notice-text').textContent(),/fixture missing image/);
      assert.equal(await page.locator('#loading').isVisible(),false);
      assert.equal(await page.locator('#viewport').getAttribute('aria-busy'),'false');
      await page.unroute('**/api/import-player');await page.unroute('**/asset.png');
      await page.addInitScript(project=>{
        localStorage.setItem('neko-play-settings-v2',JSON.stringify({resolution:1}));
        let notify,release,reject;
        const ready=new Promise((resolve,fail)=>{release=resolve;reject=fail;});
        window.fixture={opens:0,closes:0,frames:0,fail:false,hold:false,releaseFrame:null,
          progress:()=>notify({label:'正在下载 WASM（字节）…',completed:12,total:48}),ready:release,
          failReady:()=>reject(Error('WASM 初始化失败：fixture bad module'))};
        const backend={kind:'wasm',ready,subscribeProgress(callback){notify=callback;callback({label:'正在加载 WASM…'});return ()=>{notify=()=>{};};},
          async api(path,value){if(path!=='import-player')throw Error('unexpected API');return {project:value,fast_runtime_ready:true};},
          connect(){
            window.fixture.opens++;let closed=false,first=true;
            const socket={close(){closed=true;window.fixture.closes++;},send(){
              if(first){first=false;queueMicrotask(()=>socket.onmessage?.({data:JSON.stringify({ready:true})}));return;}
              window.fixture.frames++;
              const reply=()=>{
                if(window.fixture.fail){socket.onmessage?.({data:JSON.stringify({error:'fixture runtime failure <img src=x onerror=alert(1)>'})});return;}
                const metadata=new TextEncoder().encode(JSON.stringify({sprites:[],timer:3,timer_visible:true,execute_us:100,ask:{id:'q',question:'fixture question'}}));
                const length=Math.ceil(metadata.length/4)*4,buffer=new ArrayBuffer(4+length),bytes=new Uint8Array(buffer);
                new DataView(buffer).setUint32(0,length,true);bytes.fill(32,4);bytes.set(metadata,4);socket.onmessage?.({data:buffer});
              };
              // A deliberately late response verifies stop invalidates in-flight frames.
              if(window.fixture.hold)window.fixture.releaseFrame=reply;else queueMicrotask(()=>{if(!closed)reply();});
            }};queueMicrotask(()=>socket.onopen?.({}));return socket;
          }};
        window.nekoPlayerExport={createBackend:()=>backend,loadProject:async()=>project};
      },project);
      await page.goto(`${origin}/?app`,{waitUntil:'domcontentloaded'});
      await page.locator('#loading').waitFor({state:'visible'});
      assert.equal(await page.locator('#load-progress').getAttribute('value'),null);
      await page.evaluate(()=>window.fixture.progress());
      assert.equal(await page.locator('#load-progress').getAttribute('value'),'12');
      assert.equal(await page.locator('#load-progress').getAttribute('max'),'48');
      await page.evaluate(()=>window.fixture.ready());await ready();
      assert.match(await page.locator('#runtime-mode').textContent(),/WASM/);
      assert.equal(await page.evaluate(()=>window.fixture.opens),0);
      assert.equal(await page.evaluate(()=>window.nekoPlayDiagnostics().running),false);
      await page.locator('#toggle').click();
      await page.waitForFunction(()=>window.nekoPlayDiagnostics().totalUpdates>0);
      await page.locator('#toggle').click();await ready();
      assert.match(await page.locator('#toggle').textContent(),/继续/);
      assert.equal(await page.locator('#stop').isEnabled(),true);
      await page.locator('#stop').click();await ready();
      assert.match(await page.locator('#status').textContent(),/已停止/);
      assert.match(await page.locator('#toggle').textContent(),/开始/);
      assert.equal(await page.locator('#stop').isEnabled(),false);
      assert.equal(await page.locator('#timer').isVisible(),false);
      assert.equal(await page.locator('.neko-ask').count(),0);
      await page.evaluate(()=>{window.fixture.hold=true;});await page.locator('#toggle').click();
      await page.waitForFunction(()=>window.nekoPlayDiagnostics().pending);
      await page.locator('#stop').click();await ready();
      await page.evaluate(()=>{window.fixture.releaseFrame();window.fixture.hold=false;});
      assert.equal(await page.evaluate(()=>window.nekoPlayDiagnostics().frame),null);
      assert.equal(await page.evaluate(()=>window.nekoPlayDiagnostics().totalUpdates),0);
      assert.equal(await page.evaluate(()=>window.fixture.opens),2);
      assert.equal(await page.evaluate(()=>window.fixture.closes),2);
      await page.evaluate(()=>{window.fixture.fail=true;});await page.locator('#toggle').click();
      await page.waitForFunction(()=>document.querySelector('#notice-text').textContent.includes('fixture runtime failure'));
      assert.match(await page.locator('#notice-text').textContent(),/运行错误.*fixture runtime failure.*开始游玩/s);
      assert.equal(await page.locator('#notice img').count(),0);
      assert.equal(await page.evaluate(()=>window.nekoPlayDiagnostics().running),false);
      for(const app of [true,false])for(const size of [{width:1280,height:800},{width:390,height:844},{width:844,height:390}]){
        await page.evaluate(app=>document.body.classList.toggle('app',app),app);await page.setViewportSize(size);
        await page.waitForFunction(()=>{
          const a=document.querySelector('#stage').getBoundingClientRect(),b=document.querySelector('#notice').getBoundingClientRect();
          return a.width>0&&a.height>0&&(a.bottom<=b.top||b.bottom<=a.top||a.right<=b.left||b.right<=a.left);
        });
        assert.equal(await page.locator('#notice-text').isVisible(),true);
      }
      await page.locator('#fullscreen').click();
      await page.waitForFunction(()=>!!document.fullscreenElement);
      await page.waitForFunction(()=>{
        const a=document.querySelector('#stage').getBoundingClientRect(),b=document.querySelector('#notice').getBoundingClientRect();
        return a.width>0&&a.height>0&&a.bottom<=b.top&&b.bottom<=innerHeight;
      });
      assert.equal(await page.locator('#notice-text').isVisible(),true);
      await page.locator('#fullscreen').click();await page.waitForFunction(()=>!document.fullscreenElement);
      await page.locator('#dismiss').click();assert.equal(await page.locator('#notice').isVisible(),false);
      await page.evaluate(()=>{window.fixture.fail=false;});await page.locator('#toggle').click();
      await page.waitForFunction(()=>window.nekoPlayDiagnostics().running&&window.nekoPlayDiagnostics().totalUpdates>0);
      await page.goto(`${origin}/?app`,{waitUntil:'domcontentloaded'});
      await page.locator('#loading').waitFor({state:'visible'});await page.evaluate(()=>window.fixture.failReady());await ready();
      assert.match(await page.locator('#notice-text').textContent(),/WASM 初始化失败：fixture bad module/);
      assert.equal(await page.locator('#loading').isVisible(),false);
      assert.equal(await page.locator('#toggle').isEnabled(),false);
      assert.deepEqual(errors,[]);
    }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
  });
