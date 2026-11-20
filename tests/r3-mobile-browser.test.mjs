import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {mkdir,readFile} from 'node:fs/promises';
import {loadPlaywright} from '../tools/probe-kitten4.mjs';

// Opt in: actual player bootstrap + renderer + Rust transport, not a replaced
// play.js or synthetic layout. CDP supplies trusted multi-touch input.
test('r3-mobile phone/tablet production player', {skip:!process.env.NEKOC_R3_MOBILE_E2E,timeout:180000},async t=>{
  const socket=createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');
  const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
  const child=spawn(process.env.NEKOC_WEB_BIN||`target/debug/web${process.platform==='win32'?'.exe':''}`,
    ['tests/fixtures/kitten4/input.bcm','--port',String(port)],{stdio:['ignore','pipe','pipe']});
  let output='',spawnError,browser;
  child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>output+=data);child.on('error',error=>spawnError=error);
  const origin=`http://127.0.0.1:${port}`;
  try{
    for(let i=0;;i++){
      if(spawnError)throw spawnError;
      if(child.exitCode!==null||i>=200)throw Error(`backend failed: ${output}`);
      try{if((await fetch(`${origin}/api/project`)).ok)break;}catch{}
      await delay(50);
    }
    browser=await loadPlaywright().chromium.launch({headless:true,
      ...(process.env.NEKOC_BROWSER_CHANNEL?{channel:process.env.NEKOC_BROWSER_CHANNEL}:process.platform==='win32'?{channel:'msedge'}:{}),
      args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
    for(const [name,portrait,landscape] of [
      ['phone',{width:390,height:844},{width:844,height:390}],
      ['tablet',{width:768,height:1024},{width:1024,height:768}],
    ])await t.test(name,async()=>{
      const context=await browser.newContext({viewport:portrait,isMobile:true,hasTouch:true});
      try{
        const page=await context.newPage(),errors=[];page.setDefaultTimeout(15000);
        // An already-built unchanged Rust backend can serve current production
        // web sources when remote-only builds cannot produce a Windows binary.
        if(process.env.NEKOC_R3_MOBILE_SOURCE_ASSETS)await page.route(/\/[\w-]+\.(js|css)$/,async route=>{
          const name=new URL(route.request().url()).pathname.slice(1);
          if(/^[\w-]+\.(js|css)$/.test(name)){
            await route.fulfill({contentType:name.endsWith('.css')?'text/css':'text/javascript',
              body:await readFile(new URL(`../web/${name}`,import.meta.url))});
          }else await route.continue();
        });
        page.on('pageerror',error=>errors.push(error.message));
        await page.addInitScript(()=>{
          document.addEventListener('pointerdown',event=>{window.mobilePointer=event.pointerId;},true);
          window.mobileFrames=[];const send=WebSocket.prototype.send;
          WebSocket.prototype.send=function(data){
            if(typeof data==='string'){const frame=JSON.parse(data);if(frame.events?.length||frame.pressed?.length)window.mobileFrames.push(frame);}
            return send.call(this,data);
          };
        });
        const ready=()=>page.waitForFunction(()=>window.nekoPlayDiagnostics&&!window.nekoPlayDiagnostics().busy);
        const running=()=>page.waitForFunction(()=>window.nekoPlayDiagnostics().running&&window.nekoPlayDiagnostics().totalUpdates>0);
        const fit=()=>page.waitForFunction(()=>{
          const stage=document.querySelector('#stage').getBoundingClientRect(),area=document.querySelector('#viewport').getBoundingClientRect();
          return stage.width>0&&stage.width<=area.width+1&&stage.height<=area.height+1&&
            Math.abs(stage.width/stage.height-16/9)<.01&&document.documentElement.scrollWidth<=innerWidth;
        });
        const clear=()=>page.evaluate(()=>{window.mobileFrames=[];});
        const keySeen=(key,down)=>page.waitForFunction(({key,down})=>window.mobileFrames.some(f=>f.events?.some(e=>e.kind==='key'&&e.key===key&&e.down===down)),{key,down});
        const center=async selector=>{const b=await page.locator(selector).boundingBox();assert.ok(b);return {x:b.x+b.width/2,y:b.y+b.height/2};};
        const cdp=await context.newCDPSession(page);
        const touch=(type,points)=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:points});
        const screenshot=async label=>{
          if(!process.env.NEKOC_R3_MOBILE_SCREENSHOTS)return;
          await mkdir(process.env.NEKOC_R3_MOBILE_SCREENSHOTS,{recursive:true});
          await page.screenshot({path:`${process.env.NEKOC_R3_MOBILE_SCREENSHOTS}/${name}-${label}.png`,fullPage:true});
        };
        await page.goto(`${origin}/play`);await ready();await fit();
        assert.equal(await page.locator('#virtual-controls').isVisible(),false);
        await page.locator('#toggle').tap();await running().catch(async error=>{throw Error(`${error.message}; ${await page.locator('#notice-text').textContent()}; ${errors.join('\n')}`);});
        for(const size of [portrait,landscape]){
          await page.setViewportSize(size);await fit();
          await page.locator('#stage').scrollIntoViewIfNeeded();await clear();
          const point=await center('#stage'),scroll=await page.evaluate(()=>scrollY);
          await page.touchscreen.tap(point.x,point.y);
          await page.waitForFunction(()=>window.mobileFrames.some(f=>f.events?.some(e=>e.state==='mouse_click'&&Math.abs(e.x)<3&&Math.abs(e.y)<3)));
          assert.equal(await page.evaluate(()=>scrollY),scroll);
          assert.equal(await page.locator('#stage').evaluate(el=>getComputedStyle(el).touchAction),'none');
        }
        await page.locator('#virtual-toggle').tap();await fit();
        assert.equal(await page.locator('#virtual-toggle').getAttribute('aria-expanded'),'true');
        await screenshot('landscape');
        for(const code of [38,37,40,39,32,13,90,88]){
          const selector=`[data-key="${code}"]`;await clear();await page.locator(selector).tap();
          await keySeen(String(code),false);
          const pairs=await page.evaluate(code=>window.mobileFrames.flatMap(f=>f.events||[]).filter(e=>e.kind==='key'&&e.key===String(code)).map(e=>e.down),code);
          assert.deepEqual(pairs,[true,false]);
        }
        // Two fingers hold direction + action, no default scrolling, no
        // compatibility mouse duplicate. Release outside still ends the hold.
        await clear();const left={...await center('[data-key="37"]'),id:1},space={...await center('[data-key="32"]'),id:2};
        const scroll=await page.evaluate(()=>scrollY);
        await touch('touchStart',[left]);await touch('touchStart',[left,space]);
        await page.waitForFunction(()=>window.mobileFrames.some(f=>f.pressed?.includes('37')&&f.pressed.includes('32')));
        await touch('touchMove',[{...left,x:2,y:2},space]);
        await touch('touchEnd',[{...left,x:2,y:2}]);await keySeen('37',false);
        assert.equal(await page.locator('[data-key="32"]').getAttribute('aria-pressed'),'true');
        await touch('touchCancel',[]);await keySeen('32',false);
        assert.equal(await page.evaluate(()=>scrollY),scroll);
        assert.equal(await page.locator('#virtual-controls [aria-pressed="true"]').count(),0);
        // Physical and virtual sources of the same key cannot lift each other.
        await page.locator('#stage').focus();await clear();await page.keyboard.down('ArrowLeft');
        await keySeen('37',true);await touch('touchStart',[left]);await touch('touchEnd',[]);
        assert.equal(await page.locator('[data-key="37"]').getAttribute('aria-pressed'),'false');
        assert.equal(await page.evaluate(()=>window.mobileFrames.some(f=>f.events?.some(e=>e.kind==='key'&&e.key==='37'&&!e.down))),false);
        await page.keyboard.up('ArrowLeft');await keySeen('37',false);
        // A held virtual finger is primary; the stage finger must still map to
        // mouse coordinates. Keep the actual canvas hit-testing/queue path.
        await clear();const stage={...await center('#stage'),id:2};
        await touch('touchStart',[space]);await keySeen('32',true);
        await touch('touchStart',[space,{...stage,id:3}]);
        await page.waitForFunction(()=>window.mobileFrames.some(f=>f.events?.some(e=>e.state==='mouse_down')));
        await touch('touchEnd',[{...stage,id:3}]);await touch('touchEnd',[]);await keySeen('32',false);
        // Lifecycle paths release admitted holds; no late touchEnd duplicates.
        for(const end of ['hide','blur','orientation','pause','restart','background','capture']){
          t.diagnostic(`${name}: release on ${end}`);
          await clear();const held={...await center('[data-key="90"]'),id:1};
          await touch('touchStart',[held]);await keySeen('90',true);
          if(end==='capture')await touch('touchMove',[{...held,y:held.y+2}]);
          await page.evaluate(end=>{
            if(end==='hide')document.querySelector('#virtual-toggle').click();
            if(end==='blur')window.dispatchEvent(new Event('blur'));
            if(end==='orientation')window.dispatchEvent(new Event('orientationchange'));
            if(end==='pause')document.querySelector('#toggle').click();
            if(end==='restart')document.querySelector('#restart').click();
            if(end==='background'){Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));delete document.hidden;}
            if(end==='capture')document.querySelector('[data-key="90"]').releasePointerCapture(window.mobilePointer);
          },end);
          // Capture IDs come from real events, not assumed CDP touch IDs.
          if(end==='capture')await touch('touchMove',[{...held,y:held.y+4}]);
          await page.waitForFunction(()=>!document.querySelector('#virtual-controls [aria-pressed="true"]')).catch(async error=>{
            throw Error(`${name}/${end}: ${error.message}; ${await page.locator('#virtual-controls').innerHTML()}`);
          });
          await touch('touchEnd',[]);await ready();
          if(end==='hide')await page.locator('#virtual-toggle').tap();
          if(['pause','background'].includes(end)){await page.locator('#toggle').tap();await running();}
          if(end!=='restart')await keySeen('90',false);
        }
        // Real native fullscreen keeps the controls and stage contained on
        // portrait/landscape, including a narrow 320px phone.
        for(const size of [portrait,landscape,...(name==='phone'?[{width:320,height:568}]:[])]){
          await page.setViewportSize(size);await fit();
          await page.locator('#fullscreen').tap();await page.waitForFunction(()=>!!document.fullscreenElement);await fit();
          const stageBox=await page.locator('#stage').boundingBox();
          assert.ok(stageBox.height>=100&&stageBox.x>=0&&stageBox.y>=0&&stageBox.x+stageBox.width<=size.width+1&&stageBox.y+stageBox.height<=size.height+1,JSON.stringify({size,stageBox}));
          await screenshot(`fullscreen-${size.width}x${size.height}`);
          const boxes=await page.locator('#fullscreen,#virtual-controls button').evaluateAll(nodes=>nodes.map(el=>{const b=el.getBoundingClientRect();return {x:b.x,y:b.y,right:b.right,bottom:b.bottom,width:b.width,height:b.height};}));
          assert.ok(boxes.every(b=>b.width>=40&&b.height>=40&&b.x>=0&&b.y>=0&&b.right<=size.width+1&&b.bottom<=size.height+1),JSON.stringify({size,boxes}));
          await page.locator('#fullscreen').tap();await page.waitForFunction(()=>!document.fullscreenElement);
        }
        await page.setViewportSize(portrait);
        // API missing/rejected (e.g. restricted embed or browser without
        // element fullscreen): reversible CSS fallback, not a dead button.
        await page.evaluate(()=>{document.querySelector('#player-shell').requestFullscreen=()=>Promise.reject(Error('blocked'));});
        await page.locator('#fullscreen').tap();await fit();
        assert.equal(await page.locator('#player-shell').evaluate(el=>el.classList.contains('fullscreen-fallback')),true);
        assert.equal(await page.locator('#fullscreen').getAttribute('aria-label'),'退出全屏');
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('#player-shell').evaluate(el=>el.classList.contains('fullscreen-fallback')),false);
        // A portrait work (not merely a portrait browser) must fit too. Import
        // an existing owned fixture in memory, changing only its K4 stage size.
        const work=await(await page.request.get(`${origin}/api/project`)).json();work.stageSize={width:620,height:900};
        await page.locator('#file').setInputFiles({name:'r3-mobile-portrait.bcm',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(work))});
        await ready();await running().catch(async error=>{throw Error(`${error.message}; import ${await page.locator('#status').textContent()}; ${await page.locator('#notice-text').textContent()}`);});
        await page.waitForFunction(()=>{
          const stage=document.querySelector('#stage').getBoundingClientRect(),area=document.querySelector('#viewport').getBoundingClientRect();
          return Math.abs(stage.width/stage.height-620/900)<.01&&stage.width<=area.width+1&&stage.height<=area.height+1;
        }).catch(async error=>{
          const layout=await page.evaluate(()=>({diagnostics:window.nekoPlayDiagnostics(),
            stage:document.querySelector('#stage').getBoundingClientRect().toJSON(),
            area:document.querySelector('#viewport').getBoundingClientRect().toJSON(),
            aspect:document.querySelector('#viewport').style.cssText}));
          throw Error(`${error.message}; portrait ${JSON.stringify(layout)}`);
        });
        await page.locator('#stage').scrollIntoViewIfNeeded();await clear();
        const portraitPoint=await center('#stage');await page.touchscreen.tap(portraitPoint.x,portraitPoint.y);
        await page.waitForFunction(()=>window.mobileFrames.some(f=>f.events?.some(e=>e.state==='mouse_click'&&Math.abs(e.x)<3&&Math.abs(e.y)<3)));
        await screenshot('portrait-work');
        // Exported pure-stage mode must not inherit the phone shell's height
        // cap or show controls intended for the normal player.
        await page.goto(`${origin}/play?app`);await ready();await running();await fit();
        assert.equal(await page.locator('#virtual-toggle').isVisible(),false);
        assert.equal(await page.locator('#viewport').evaluate(el=>Math.abs(el.getBoundingClientRect().height-innerHeight)<1),true);
        assert.deepEqual(errors,[]);
      }finally{await context.close();}
    });
  }finally{
    await browser?.close();
    if(child.exitCode===null&&!spawnError){child.kill();await once(child,'exit');}
  }
});
