import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {readFile,mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {loadPlaywright} from '../tools/probe-kitten4.mjs';
const exec=promisify(execFile);

// Real browser UI -> downloaded recording -> separate CLI process. Fixtures
// are repository-owned; no source, runtime or transport is replaced.
test('r2-repro: browser recording and CLI replay produce the same state', {
  skip:!process.env.NEKOC_REPRO_E2E,timeout:180000,
},async t=>{
  const binary=name=>path.resolve(process.env[name==='web'?'NEKOC_WEB_BIN':'NEKOC_BIN']||`target/debug/${name}${process.platform==='win32'?'.exe':''}`);
  const socket=createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');
  const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
  await mkdir('dist',{recursive:true});const dir=await mkdtemp(path.resolve('dist/r2-repro-'));
  const child=spawn(binary('web'),['tests/fixtures/input-kn.bcmkn','--port',String(port)],{stdio:['ignore','pipe','pipe']});
  let output='',spawnError,browser;child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>output+=data);child.on('error',error=>spawnError=error);
  const origin=`http://127.0.0.1:${port}`;
  try{
    for(let attempt=0;;attempt++){
      if(spawnError)throw spawnError;
      if(child.exitCode!==null||attempt>=200)throw Error(`Backend failed: ${output}`);
      try{if((await fetch(`${origin}/api/project`)).ok)break;}catch{}
      await delay(50);
    }
    browser=await loadPlaywright().chromium.launch({headless:true,
      ...(process.env.NEKOC_BROWSER_CHANNEL?{channel:process.env.NEKOC_BROWSER_CHANNEL}:process.platform==='win32'?{channel:'msedge'}:{}),
      args:['--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox']});
    // Keep literal JSON numbers in the original file: stringify would erase -0
    // and round the large integers before the browser ever imports them.
    const numericSource=JSON.parse(await readFile('tests/fixtures/input-kn.bcmkn','utf8'));
    numericSource.variables.variablesDict['a-down'].value='NEGATIVE_ZERO';
    numericSource.actors.actorsDict['nekoc-default-actor'].nekoBlockJsonList=[{
      type:'on_running_group_activated',next:{type:'variables_set',fields:{variable:'ready'},inputs:{value:{
        type:'text_join',mutation:'<mutation items="2"></mutation>',inputs:{
          ADD0:{type:'text',fields:{TEXT:'result='}},
          ADD1:{type:'math_arithmetic',fields:{type:'divide'},inputs:{A:{type:'math_number',fields:{NUM:1}},B:{type:'variables_get',fields:{variable:'a-down'}}}},
        },
      }}},
    }];
    numericSource.numeric_edges='NUMERIC_EDGES';
    for(const [name,value] of Object.entries({large:'LARGE_INTEGER',unsigned:'UNSIGNED_INTEGER',tiny:5e-324,max:Number.MAX_VALUE})){
      numericSource.variables.variablesDict[`edge-${name}`]={...numericSource.variables.variablesDict['a-down'],id:`edge-${name}`,name:`edge-${name}`,value};
    }
    const numericFixture=path.join(dir,'numeric-edges.bcmkn');
    await writeFile(numericFixture,JSON.stringify(numericSource).replace('"NEGATIVE_ZERO"','-0').replace('"LARGE_INTEGER"','9007199254740993').replace('"UNSIGNED_INTEGER"','18446744073709551615').replace('"NUMERIC_EDGES"','[-0,9007199254740993,18446744073709551615,5e-324,1.7976931348623157e308]'));
    for(const fixture of ['tests/fixtures/input-kn.bcmkn','tests/fixtures/kitten4/input.bcm',numericFixture]){
      await t.test(fixture,async()=>{
        const page=await browser.newPage({viewport:{width:1280,height:900},acceptDownloads:true}),errors=[];
        page.on('pageerror',error=>errors.push(error.message));
        try{
          await page.goto(`${origin}/play`);
          await page.waitForFunction(()=>window.nekoPlayDiagnostics&&!window.nekoPlayDiagnostics().busy);
          await page.locator('#file').setInputFiles(path.resolve(fixture));
          await page.waitForFunction(()=>!window.nekoPlayDiagnostics().busy&&window.nekoPlayDiagnostics().running);
          await page.locator('#record').click();
          await page.waitForFunction(()=>window.nekoPlayDiagnostics().recording&&!window.nekoPlayDiagnostics().busy&&window.nekoPlayDiagnostics().totalUpdates>=2);
          assert.equal(await page.locator('#restart').isDisabled(),true);
          assert.equal(await page.locator('#stop').isDisabled(),true);
          // Even a stale/programmatic stop must not discard the recording.
          await page.evaluate(()=>document.querySelector('#stop').onclick());
          assert.equal(await page.evaluate(()=>window.nekoPlayDiagnostics().recording),true);
          assert.equal(await page.locator('#coalesce').isDisabled(),true);
          await page.keyboard.press('a');
          const bounds=await page.locator('#stage').boundingBox();
          await page.mouse.move(bounds.x+bounds.width/2,bounds.y+bounds.height/2);
          await page.mouse.down();await page.mouse.move(bounds.x+bounds.width*.65,bounds.y+bounds.height*.4,{steps:4});await page.mouse.up();
          // Pausing drains the already-submitted frame. The release generated by
          // button focus is queued for resume, just like normal player input.
          await page.locator('#toggle').click();
          await page.waitForFunction(()=>!window.nekoPlayDiagnostics().running&&!window.nekoPlayDiagnostics().pending);
          const pausedCount=await page.evaluate(()=>window.nekoPlayDiagnostics().totalUpdates);
          assert.equal(await page.locator('#stop').isDisabled(),true);
          await page.locator('#toggle').click();
          await page.waitForFunction(count=>window.nekoPlayDiagnostics().totalUpdates>count,pausedCount);
          await page.locator('#toggle').click();
          await page.waitForFunction(()=>!window.nekoPlayDiagnostics().running&&!window.nekoPlayDiagnostics().pending);
          const before=await page.evaluate(()=>window.nekoPlaySnapshot());
          if(fixture===numericFixture){
            assert.equal(before.variables.ready,'result=Infinity');
            assert.equal(before.variables['edge-large'],9007199254740992);
            assert.equal(before.variables['edge-unsigned'],18446744073709552000);
            assert.equal(before.variables['edge-tiny'],5e-324);assert.equal(before.variables['edge-max'],Number.MAX_VALUE);
          }
          const downloadPromise=page.waitForEvent('download');await page.locator('#record').click();
          const download=await downloadPromise;assert.equal(download.suggestedFilename(),'neko-repro.json');
          const recording=path.join(dir,`${path.basename(fixture)}.json`);await download.saveAs(recording);
          const bundle=JSON.parse(await readFile(recording,'utf8'));
          assert.equal(bundle.schema,'nekoc-repro-v1');assert.ok(bundle.timeline.length>=2);
          const events=bundle.timeline.flatMap(frame=>frame.input.events);
          assert.ok(events.some(event=>event.kind==='key'&&event.down));
          assert.ok(events.some(event=>event.kind==='key'&&!event.down));
          assert.ok(events.some(event=>event.kind==='pointer'&&event.state==='mouse_down'));
          const result=JSON.parse((await exec(binary('nekoc'),['run',fixture,'--input-script',recording],{maxBuffer:16*1024*1024})).stdout);
          assert.equal(result.repro.matched,true);assert.deepEqual(result.snapshot,before);
          assert.equal(result.repro.state_sha256,bundle.diagnostics.state_sha256);
          assert.equal(result.repro.frame_count,bundle.timeline.length);
          assert.equal('project' in bundle,false);assert.equal('snapshot' in bundle.diagnostics,false);
          const changed=structuredClone(bundle);changed.diagnostics.state_sha256='0'.repeat(64);
          const invalid=path.join(dir,'tampered.json');await writeFile(invalid,JSON.stringify(changed));
          await assert.rejects(exec(binary('nekoc'),['run',fixture,'--input-script',invalid]),/state digest mismatch/);
          await page.waitForFunction(()=>!window.nekoPlayDiagnostics().busy);
          assert.equal(await page.locator('#record').getAttribute('aria-pressed'),'false');
          await page.locator('#toggle').click();
          await page.waitForFunction(()=>window.nekoPlayDiagnostics().running&&!window.nekoPlayDiagnostics().recording);
          await page.waitForFunction(()=>!window.nekoPlayDiagnostics().busy);
          assert.equal(await page.locator('#stop').isEnabled(),true);
          assert.deepEqual(errors,[]);
        }finally{await page.close();}
      });
    }
    await t.test('interruption exports a replayable acknowledged prefix',async()=>{
      const page=await browser.newPage({acceptDownloads:true});
      try{
        await page.goto(`${origin}/play`);
        await page.waitForFunction(()=>window.nekoPlayDiagnostics&&!window.nekoPlayDiagnostics().busy);
        await page.locator('#record').click();
        await page.waitForFunction(()=>window.nekoPlayDiagnostics().recording&&window.nekoPlayDiagnostics().totalUpdates>=3);
        // Fail one transport send; the recorder must not invent a confirmation.
        await page.evaluate(()=>{
          const send=WebSocket.prototype.send;
          WebSocket.prototype.send=function(){WebSocket.prototype.send=send;this.close();throw Error('recording disconnect probe');};
        });
        await page.waitForFunction(()=>!window.nekoPlayDiagnostics().running&&!window.nekoPlayDiagnostics().pending);
        assert.equal(await page.locator('#toggle').isDisabled(),true);
        assert.equal(await page.locator('#stop').isDisabled(),true);
        const pending=page.waitForEvent('download');await page.locator('#record').click();
        const recording=path.join(dir,'interrupted.json');await(await pending).saveAs(recording);
        const bundle=JSON.parse(await readFile(recording,'utf8'));
        assert.equal(bundle.diagnostics.interrupted,true);assert.ok(bundle.timeline.length>=3);
        const result=JSON.parse((await exec(binary('nekoc'),['run','tests/fixtures/input-kn.bcmkn','--input-script',recording])).stdout);
        assert.equal(result.repro.matched,true);assert.equal(result.repro.complete_recording,false);
      }finally{await page.close();}
    });
    for(const resume of [false,true])await t.test(`idle disconnect ${resume?'rejects resume':'exports directly'} without a new host session`,async()=>{
      const page=await browser.newPage({acceptDownloads:true});
      try{
        await instrumentTransport(page);
        await page.goto(`${origin}/play`);
        await page.waitForFunction(()=>window.nekoPlayDiagnostics&&!window.nekoPlayDiagnostics().busy);
        await page.locator('#record').click();
        await page.waitForFunction(()=>window.nekoPlayDiagnostics().totalUpdates>=3);
        await page.locator('#toggle').click();
        await page.waitForFunction(()=>!window.nekoPlayDiagnostics().pending&&!window.nekoPlayDiagnostics().busy);
        const before=await page.evaluate(()=>window.nekoPlaySnapshot());
        await page.evaluate(async()=>{
          const {K4DeviceHost}=await import('/k4-device.js');
          const {KnMicrophone}=await import('/kn-microphone.js');
          window.hostStarts=0;
          K4DeviceHost.prototype.requestPermission=()=>{window.hostStarts++;throw Error('unexpected device initialization');};
          KnMicrophone.prototype.start=()=>{window.hostStarts++;throw Error('unexpected microphone initialization');};
          window.testSockets.at(-1).close();
        });
        await page.waitForFunction(()=>document.querySelector('#toggle').disabled);
        // Even a stale/programmatic invocation must not take launch's normal path.
        if(resume)await page.evaluate(()=>document.querySelector('#toggle').onclick());
        assert.equal(await page.evaluate(()=>window.nekoPlayDiagnostics().running),false);
        assert.equal(await page.evaluate(()=>window.testSent.filter(v=>v.toolType||v.nekoc_extension_handshake).length),1);
        assert.equal(await page.evaluate(()=>window.hostStarts),0);
        const pending=page.waitForEvent('download');await page.locator('#record').click();
        const recording=path.join(dir,`idle-${resume}.json`);await(await pending).saveAs(recording);
        const bundle=JSON.parse(await readFile(recording,'utf8'));
        assert.equal(bundle.diagnostics.interrupted,true);
        const result=JSON.parse((await exec(binary('nekoc'),['run','tests/fixtures/input-kn.bcmkn','--input-script',recording])).stdout);
        assert.equal(result.repro.matched,true);assert.equal(result.repro.complete_recording,false);assert.deepEqual(result.snapshot,before);
      }finally{await page.close();}
    });
    await t.test('hidden during ready handshake keeps a zero-frame paused recording',async()=>{
      const page=await browser.newPage({acceptDownloads:true});
      try{
        await instrumentTransport(page);
        await page.goto(`${origin}/play`);
        await page.waitForFunction(()=>window.nekoPlayDiagnostics&&!window.nekoPlayDiagnostics().busy);
        await page.evaluate(()=>window.delayReady=true);
        await page.locator('#record').click();
        await page.waitForFunction(()=>!!window.releaseReady);
        await page.evaluate(()=>{
          Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});
          document.dispatchEvent(new Event('visibilitychange'));window.releaseReady();
        });
        await page.waitForFunction(()=>!window.nekoPlayDiagnostics().busy);
        const state=await page.evaluate(()=>window.nekoPlayDiagnostics());
        assert.equal(state.recording,true);assert.equal(state.running,false);assert.equal(state.totalUpdates,0);assert.equal(state.pending,false);
        assert.equal(await page.evaluate(()=>window.testSent.filter(v=>'dt' in v).length),0);
        const pending=page.waitForEvent('download');await page.locator('#record').click();
        const recording=path.join(dir,'hidden-zero.json');await(await pending).saveAs(recording);
        const bundle=JSON.parse(await readFile(recording,'utf8'));assert.equal(bundle.timeline.length,0);assert.equal(bundle.diagnostics.interrupted,false);
        const result=JSON.parse((await exec(binary('nekoc'),['run','tests/fixtures/input-kn.bcmkn','--input-script',recording])).stdout);
        assert.equal(result.repro.matched,true);
      }finally{await page.close();}
    });
  }finally{await browser?.close();child.kill();await rm(dir,{recursive:true,force:true});}
});

// Only inject at the real transport boundary; the page, protocol and Rust VM
// remain unmodified. The ready gate models visibility changing during await.
async function instrumentTransport(page){
  await page.addInitScript(()=>{
    const Native=window.WebSocket;window.testSockets=[];window.testSent=[];
    window.WebSocket=class extends Native{
      constructor(...args){
        super(...args);window.testSockets.push(this);
        this.addEventListener('message',event=>{
          if(window.delayReady&&typeof event.data==='string'&&JSON.parse(event.data).ready){
            event.stopImmediatePropagation();window.releaseReady=()=>{window.delayReady=false;this.onmessage(event);};
          }
        });
      }
      send(text){window.testSent.push(JSON.parse(text));return super.send(text);}
    };
  });
}
