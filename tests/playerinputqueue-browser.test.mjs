import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer as netServer} from 'node:net';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {loadPlaywright} from '../tools/probe-kitten4.mjs';

// Opt-in real browser -> shared input -> Rust SDK (native and WASM). No mocked
// Engine, input queue, transport or VM clock, and no wall-clock assertions.
test('browser overload releases Engine state and resumes waiters',{
  skip:!process.env.NEKOC_PLAYERINPUTQUEUE_E2E,timeout:120000,
},async t=>{
  const portSocket=netServer();portSocket.listen(0,'127.0.0.1');await once(portSocket,'listening');
  const port=portSocket.address().port;await new Promise(resolve=>portSocket.close(resolve));
  const child=spawn(process.env.NEKOC_WEB_BIN||'target/debug/web.exe',['tests/fixtures/kitten4/input.bcm','--port',String(port)],{stdio:['ignore','pipe','pipe']});
  let output='',spawnError;child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>output+=data);child.on('error',error=>spawnError=error);
  const origin=`http://127.0.0.1:${port}`;
  const root=path.resolve('web'),wasm=path.resolve(process.env.NEKOC_INPUT_WASM_DIR||'dist/playerinputqueue/wasm');
  const server=createServer(async(req,res)=>{
    try{
      const url=new URL(req.url,'http://localhost');
      if(url.pathname==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><canvas tabindex="0" width="480" height="360" style="width:480px;height:360px;touch-action:none"></canvas>');return;}
      const filename=url.pathname.startsWith('/wasm/')?path.join(wasm,path.basename(url.pathname)):path.join(root,path.basename(url.pathname));
      res.setHeader('Content-Type',filename.endsWith('.wasm')?'application/wasm':'text/javascript');res.end(await readFile(filename));
    }catch(error){res.statusCode=404;res.end(error.message);}
  });
  let browser;
  try{
    for(let i=0;;i++){
      if(spawnError)throw spawnError;
      if(child.exitCode!==null||i>=200)throw Error(`backend failed: ${output}`);
      try{if((await fetch(`${origin}/api/project`)).ok)break;}catch{}
      await delay(50);
    }
    server.listen(0,'127.0.0.1');await once(server,'listening');
    const staticOrigin=`http://127.0.0.1:${server.address().port}`;
    // Reuse owned fixture shapes, inject SDK-level probes only in memory.
    // Nothing is serialized as a new .bcmkn/editor artifact.
    const kn=JSON.parse(await readFile('tests/fixtures/input-kn.bcmkn','utf8'));
    const k4Import=await fetch(`${origin}/api/import-player`,{method:'POST',headers:{'Content-Type':'application/json'},body:await readFile('tests/fixtures/kitten4/input.bcm','utf8')});
    assert.equal(k4Import.ok,true);const k4=(await k4Import.json()).project;
    const chain=blocks=>blocks.reduceRight((next,b)=>next?{...b,next}:b,null);
    const mouse=()=>({type:'mouse_down',fields:{sprite:'--screen',type:'down'}});
    const log=value=>({type:'console_log',inputs:{console_log:value}});
    const text=value=>({type:'text',fields:{TEXT:value}});
    for(const project of [kn,k4]){
      for(const scene of Object.values(project.scenes.scenesDict))scene.nekoBlockJsonList=[];
      const actors=Object.values(project.actors.actorsDict);for(const actor of actors)actor.nekoBlockJsonList=[];
      const actor=actors[0];actor.draggable=true;actor.position={x:0,y:0};
      actor.nekoBlockJsonList=[{type:'on_running_group_activated',next:chain([
        {type:'wait_until',inputs:{condition:mouse()}},log(text('pressed')),
        {type:'wait_until',inputs:{condition:{type:'logic_negate',inputs:{logic:mouse()}}}},log(text('resumed')),
        {type:'repeat_forever',statements:{DO:log(mouse())}},
      ])}];
    }
    browser=await loadPlaywright().chromium.launch({headless:true,channel:process.env.NEKOC_BROWSER_CHANNEL||'msedge'});
    await t.test('overlay answers and controls remain retryable under backpressure',async()=>{
      const page=await browser.newPage();
      try{
        await page.goto(staticOrigin);
        const result=await page.evaluate(async()=>{
          const {StageInput}=await import('/input.js'),{StageOverlay}=await import('/overlay.js');
          const canvas=document.querySelector('canvas'),renderer={canvas,width:480,height:360,kitten4:true,sprites:[],hitTest:()=>null};
          const input=new StageInput(canvas,renderer,()=>true,()=>{});
          const overlay=new StageOverlay(document.body,renderer,event=>input.push(event));
          const fill=()=>{while(input.push({kind:'audio_done',id:1})){};};
          fill();overlay.showAsk({id:1,question:'test'});overlay.ask.querySelector('input').value='retained';overlay.ask.querySelector('button').click();
          const answerRetained=!!overlay.ask&&overlay.ask.querySelector('input').value==='retained';
          input.take();overlay.ask.querySelector('button').click();const answer=input.take().events;
          fill();overlay.showStageDialog({id:2,name:'test',text:'test'});overlay.stageDialog.click();const dialogRetained=!overlay.stageDialog.dataset.sent;
          input.take();overlay.stageDialog.click();const dialog=input.take().events;
          fill();overlay.showRanking({variable:'v',value:0});overlay.ranking.querySelector('button').click();const rankingRetained=!overlay.ranking.hidden;
          input.take();overlay.ranking.querySelector('button').click();const ranking=input.take().events;
          overlay.reset();return {answerRetained,answer,dialogRetained,dialog,rankingRetained,ranking};
        });
        assert.equal(result.answerRetained,true);assert.deepEqual(result.answer,[{kind:'answer',id:1,text:'retained'}]);
        assert.equal(result.dialogRetained,true);assert.deepEqual(result.dialog,[{kind:'stage_dialog_click',id:2}]);
        assert.equal(result.rankingRetained,true);assert.deepEqual(result.ranking,[{kind:'ranking_close'}]);
      }finally{await page.close();}
    });
    for(const backend of ['rust','wasm'])for(const [name,project] of [['KN',kn],['K4',k4]])for(const end of ['up','cancel','blur']){
      await t.test(`${backend} ${name} ${end}`,async()=>{
        const page=await browser.newPage();
        const diagnostics=[];page.on('console',message=>{if(message.type()==='error')diagnostics.push(message.text());});
        try{
          // Load a real loopback document (a route-fulfilled navigation loses
          // Chromium's local address-space classification). Disable only the
          // shell's automatic frame pump; the test drives production transport.
          if(backend==='rust'){
            await page.route(`${origin}/play.js`,route=>route.fulfill({contentType:'text/javascript',body:''}));
            await page.goto(`${origin}/play`);
            await page.setContent('<!doctype html><canvas tabindex="0" width="480" height="360" style="width:480px;height:360px;touch-action:none"></canvas>');
          }else await page.goto(staticOrigin);
          const result=await page.evaluate(async({backend,project,end,kitten4})=>{
            const {StageInput}=await import('/input.js'),{PlayerConnection}=await import('/player.js'),{decodeFrame}=await import('/renderer.js');
            const {wasmBackend}=await import('/backend.js');
            const connection=new PlayerConnection();const engine=backend==='wasm'?wasmBackend():location.origin;
            await connection.open(project,engine);
            const canvas=document.querySelector('canvas'),actor=Object.values(project.actors.actorsDict)[0],warnings=[];
            const renderer={width:480,height:360,kitten4,sprites:[{id:actor.id,x:0,y:0,draggable:true}],hitTest:()=>actor.id};
            const input=new StageInput(canvas,renderer,()=>true,message=>warnings.push(message));
            const logs=[];const frame=async()=>{const {frame}=decodeFrame(await connection.frame({dt:1/60,budget_ms:16,...input.take()}));logs.push(...frame.logs);return frame;};
            const box=canvas.getBoundingClientRect(),x=box.left+240,y=box.top+180;
            // Trusted browser down obtains real pointer capture; all queued
            // moves run synchronously without a frame consumer (slow frame).
            window.queueFixture={canvas,input,frame,logs,x,y,connection};
            await frame();return {x,y};
          },{backend,project,end,kitten4:name==='K4'});
          await page.mouse.move(result.x,result.y);await page.mouse.down();
          const state=await page.evaluate(async({end})=>{
            const {canvas,input,frame,logs,x,y,connection}=window.queueFixture;
            await frame();for(let i=0;i<20&&!logs.includes('pressed');i++)await frame();
            if(!logs.includes('pressed'))throw Error(`down not observed: ${logs}`);
            for(let i=0;i<4096;i++)canvas.dispatchEvent(new PointerEvent('pointermove',{pointerId:1,isPrimary:true,clientX:x+i%100,clientY:y-i%60}));
            // Other producers interrupt a long drag, but cannot steal release
            // capacity. The audio event remains in the real serialized frame.
            for(let i=0;i<300;i++){input.push({kind:'audio_done',id:i+1000});canvas.dispatchEvent(new PointerEvent('pointermove',{pointerId:1,isPrimary:true,clientX:x+100,clientY:y-60}));}
            if(end==='blur')window.dispatchEvent(new Event('blur'));
            else canvas.dispatchEvent(new PointerEvent(end==='cancel'?'pointercancel':'pointerup',{pointerId:1,isPrimary:true,button:0,clientX:x+100,clientY:y-60}));
            const queued=input.events.map(e=>({...e})),stats={...input.queueStats};await frame();
            for(let i=0;i<20&&!logs.includes('resumed');i++)await frame();
            await frame();
            const snapshot=await connection.snapshot();
            canvas.dispatchEvent(new PointerEvent('pointermove',{pointerId:1,isPrimary:true,clientX:x+120,clientY:y-80}));
            return {queued,stats,logs,pointer:input.pointer,pending:input.take().events,snapshot};
          },{end});
          assert.ok(state.queued.length<=256);assert.ok(state.stats.highWater<=256);assert.ok(state.stats.coalesced>=4095);
          assert.ok(state.stats.rejected>0);assert.equal(state.pointer,null);assert.deepEqual(state.pending,[]);
          assert.ok(state.logs.includes('resumed'));assert.ok(['false','0'].includes(state.logs.at(-1)),JSON.stringify(state.logs));
          const drags=state.queued.filter(e=>e.kind==='drag');assert.equal(drags.at(-1).x,100);assert.equal(drags.at(-1).y,60);
          const actor=Object.values(state.snapshot.actors)[0];assert.equal(actor.x,100);assert.equal(actor.y,60);
        }catch(error){throw new Error(`${error.message}\n${diagnostics.join('\n')}\n${output}`,{cause:error});}
        finally{await page.close();}
      });
    }
  }finally{
    await browser?.close();await new Promise(resolve=>server.close(resolve));
    if(child.exitCode===null&&!spawnError){child.kill();await once(child,'exit');}
  }
});
