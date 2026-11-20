import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {loadPlaywright} from '../tools/probe-kitten4.mjs';

// Opt-in: real HTTP backend, WebGL and trusted keyboard input. Run one browser.
test('r3-a11y: Studio and player keyboard, locale and contrast',{
  skip:!process.env.NEKOC_A11Y_E2E,timeout:120000,
},async t=>{
  const socket=createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');
  const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
  const child=spawn(process.env.NEKOC_WEB_BIN||(process.platform==='win32'?'target/debug/web.exe':'target/debug/web'),['tests/fixtures/kitten4/visual-stamp.bcm','--port',String(port)],{stdio:['ignore','pipe','pipe']});
  let output='',spawnError,browser;child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>output+=data);child.on('error',error=>spawnError=error);
  const origin=`http://127.0.0.1:${port}`;
  const focused=locator=>locator.evaluate(el=>el===document.activeElement);
  const contrast=async(page,selectors)=>{
    const results=await page.evaluate(selectors=>{
      const rgb=text=>text.match(/[\d.]+/g).map(Number);
      const luminance=([r,g,b])=>[r,g,b].map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
      return selectors.map(selector=>{
        const el=document.querySelector(selector);if(!el)throw Error(`Missing contrast target: ${selector}`);const style=getComputedStyle(el);let bg=[255,255,255];
        const parents=[];for(let p=el;p;p=p.parentElement)parents.unshift(p);
        for(const parent of parents){const color=rgb(getComputedStyle(parent).backgroundColor),alpha=color[3]??1;bg=bg.map((v,i)=>color[i]*alpha+v*(1-alpha));}
        const a=luminance(rgb(style.color)),b=luminance(bg);return {selector,ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)};
      });
    },selectors);
    for(const {selector,ratio}of results)assert.ok(ratio>=4.5,`${selector}: ${ratio.toFixed(2)}:1`);
  };
  try{
    for(let i=0;;i++){
      if(spawnError)throw spawnError;if(child.exitCode!==null||i>=200)throw Error(`Backend failed: ${output}`);
      try{if((await fetch(`${origin}/api/project`)).ok)break;}catch{}
      await delay(50);
    }
    browser=await loadPlaywright().chromium.launch({headless:true,channel:process.env.NEKOC_BROWSER_CHANNEL||'msedge',args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
    const context=await browser.newContext({viewport:{width:1600,height:1000}}),page=await context.newPage(),errors=[];
    page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>dialog.accept());
    const studioReady=()=>page.waitForFunction(()=>window.nekoImportReport&&window.nekoDiagnostics);
    const playerReady=()=>page.waitForFunction(()=>window.nekoPlayDiagnostics&&!window.nekoPlayDiagnostics().busy);
    await t.test('Studio: native category buttons, selected blocks, fields, tabs and draft preservation',async()=>{
      await page.goto(`${origin}/?lang=en`,{waitUntil:'domcontentloaded'});await studioReady();
      assert.equal(await page.locator('html').getAttribute('lang'),'en');
      assert.equal(await page.getByRole('button',{name:'Pause',exact:true}).count(),1);
      assert.equal(await page.getByRole('button',{name:'Undo',exact:true}).count(),1);
      const motion=page.getByRole('button',{name:'Motion',exact:true});await motion.focus();await page.keyboard.press('Space');
      assert.equal(await motion.getAttribute('aria-pressed'),'true');assert.equal(await focused(motion),true);
      assert.equal(await page.locator('#palette button').count(),3);
      const all=page.getByRole('button',{name:'All',exact:true});await all.focus();await page.keyboard.press('Enter');
      const hat=page.locator('#palette').getByRole('button',{name:'When started',exact:true});await hat.focus();await page.keyboard.press('Enter');
      const selector=page.locator('#blocks .block-label').last();await selector.focus();await page.keyboard.press('Space');
      assert.equal(await focused(selector),true);assert.equal(await selector.getAttribute('aria-pressed'),'true');
      const move=page.locator('#palette').getByRole('button',{name:'Move steps',exact:true});await move.focus();await page.keyboard.press('Enter');
      const field=page.locator('#blocks').getByRole('spinbutton',{name:'Steps',exact:true}).last();
      await field.fill('42');await page.keyboard.press('Enter');assert.equal(await focused(field),true);
      await page.keyboard.press('Tab');assert.equal(await focused(field),false);
      await field.fill('43');await page.keyboard.press('Tab');assert.equal(await focused(field),false);
      await page.locator('#palette').getByRole('button',{name:'Repeat',exact:true}).focus();await page.keyboard.press('Enter');
      const blockTab=page.getByRole('tab',{name:'Blocks',exact:true});await blockTab.focus();await page.keyboard.press('ArrowRight');
      const source=page.getByRole('tab',{name:'Project source',exact:true});assert.equal(await focused(source),true);assert.equal(await source.getAttribute('aria-selected'),'true');
      assert.equal(await page.locator('#blocks').isVisible(),false);
      assert.equal(await page.getByRole('textbox',{name:'Normalized project JSON',exact:true}).count(),1);
      const json=page.locator('#json-source');
      assert.match(await json.inputValue(),/"NUM": 43/);
      await json.fill('{"draft":"保留 <script>"}');await page.locator('#language').selectOption('zh-CN');
      assert.equal(await json.inputValue(),'{"draft":"保留 <script>"}');assert.equal(await page.locator('html').getAttribute('lang'),'zh-CN');
      // Clicking the already active tab must not overwrite unsaved JSON.
      await page.locator('#json-tab').click();assert.equal(await json.inputValue(),'{"draft":"保留 <script>"}');
      await page.locator('#json-tab').focus();await page.keyboard.press('Home');assert.equal(await focused(page.locator('#blocks-tab')),true);
      await page.locator('#language').selectOption('en');
      await page.getByRole('textbox',{name:'Project name',exact:true}).fill('<b>用户名称</b>');await page.keyboard.press('Enter');
      await page.locator('#language').selectOption('zh-CN');await page.locator('#language').selectOption('en');
      assert.equal(await page.locator('#project-name').inputValue(),'<b>用户名称</b>');
      await contrast(page,['.context-note','.small-tag','.branch','.property-grid label','.palette-block','#dirty','.perf-note']);
      await page.locator('#stage').focus();await page.keyboard.press('Tab');
      assert.equal(await focused(page.locator('#run')),true);
      await page.locator('#stage').focus();assert.notEqual(await page.locator('#stage').evaluate(el=>getComputedStyle(el).outlineStyle),'none');
    });
    await t.test('player: persisted language, keyboard playback, settings, report focus and fullscreen labels',async()=>{
      await page.goto(`${origin}/play`,{waitUntil:'domcontentloaded'});await playerReady();
      assert.equal(await page.locator('html').getAttribute('lang'),'en');
      const projectName=await page.locator('#project-name').textContent();
      await page.getByRole('button',{name:'▶ Start playing',exact:true}).focus();await page.keyboard.press('Enter');
      await page.waitForFunction(()=>window.nekoPlayDiagnostics().running&&window.nekoPlayDiagnostics().totalUpdates>0);
      assert.equal(await focused(page.locator('#stage')),true);
      await page.keyboard.press('Tab');assert.equal(await focused(page.locator('#stage')),false);
      await page.locator('#toggle').focus();await page.keyboard.press('Space');
      assert.equal(await page.locator('#status').textContent(),'Paused');assert.equal(await page.locator('#toggle').getAttribute('aria-pressed'),'false');
      const settings=page.getByRole('button',{name:'Performance settings',exact:true});await settings.focus();await page.keyboard.press('Enter');
      assert.equal(await settings.getAttribute('aria-expanded'),'false');assert.equal(await page.locator('#frame-limit').isVisible(),false);
      await page.keyboard.press('Space');assert.equal(await settings.getAttribute('aria-expanded'),'true');
      await page.keyboard.press('Tab');assert.equal(await focused(page.getByRole('combobox',{name:'Update limit',exact:true})),true);
      const report=page.getByRole('button',{name:'Compatibility / coverage report',exact:true});await report.focus();await page.keyboard.press('Enter');
      assert.equal(await page.getByRole('dialog',{name:'Compatibility / coverage report'}).isVisible(),true);
      assert.equal(await focused(page.getByRole('button',{name:'Close report',exact:true})),true,await page.evaluate(()=>document.activeElement.outerHTML));
      await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.closest('dialog')!==null),true);
      await page.keyboard.press('Escape');assert.equal(await focused(report),true);
      await page.locator('#language').selectOption('zh-CN');
      assert.equal(await page.locator('#status').textContent(),'已暂停');assert.equal(await page.locator('#project-name').textContent(),projectName);
      assert.equal(await page.locator('#fullscreen').getAttribute('aria-label'),'全屏游玩');
      await page.locator('#language').selectOption('en');
      await page.locator('#fullscreen').focus();await page.keyboard.press('Enter');
      await page.waitForFunction(()=>document.querySelector('#fullscreen').getAttribute('aria-label')==='Exit fullscreen');
      await page.keyboard.press('Enter');await page.waitForFunction(()=>!document.fullscreenElement);
      await contrast(page,['.keyboard-hint','.setting small','.timings-tile span','#status','.eyebrow']);
      await page.evaluate(()=>{document.querySelector('#player-shell').requestFullscreen=()=>Promise.reject(Error('blocked'));});
      await page.locator('#fullscreen').click();assert.match(await page.locator('#notice-text').textContent(),/in-window fullscreen/);
      assert.equal(await page.locator('#player-shell').evaluate(el=>el.classList.contains('fullscreen-fallback')),true);
      assert.equal(await page.locator('#fullscreen').getAttribute('aria-pressed'),'true');
      await page.locator('#language').selectOption('zh-CN');
      assert.equal(await page.locator('#fullscreen').getAttribute('aria-label'),'退出全屏');
      await page.locator('#language').selectOption('en');
      assert.equal(await page.locator('#fullscreen').getAttribute('aria-label'),'Exit fullscreen');
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#player-shell').evaluate(el=>el.classList.contains('fullscreen-fallback')),false);
      assert.equal(await page.locator('#fullscreen').getAttribute('aria-pressed'),'false');
      await page.getByRole('button',{name:'Dismiss notice'}).focus();await page.keyboard.press('Enter');
      assert.equal(await focused(page.locator('#import')),true);
      await page.reload({waitUntil:'domcontentloaded'});await playerReady();assert.equal(await page.locator('html').getAttribute('lang'),'en');
    });
    await t.test('unsupported locale and denied storage fall back; English mobile controls fit',async()=>{
      const isolated=await browser.newContext({viewport:{width:390,height:844}});
      const phone=await isolated.newPage();phone.on('pageerror',error=>errors.push(error.message));
      await phone.addInitScript(()=>{Object.defineProperty(window,'localStorage',{get(){throw Error('blocked');}});});
      await phone.goto(`${origin}/play?lang=invalid`,{waitUntil:'domcontentloaded'});await phone.waitForFunction(()=>window.nekoPlayDiagnostics&&!window.nekoPlayDiagnostics().busy);
      assert.equal(await phone.locator('html').getAttribute('lang'),'zh-CN');
      await phone.locator('#language').selectOption('en');assert.equal(await phone.locator('html').getAttribute('lang'),'en');
      for(const size of [{width:390,height:844},{width:844,height:390}]){
        await phone.setViewportSize(size);
        for(const id of ['toggle','stop','restart','fullscreen','record','virtual-toggle']){const box=await phone.locator(`#${id}`).boundingBox();assert.ok(box&&box.x>=0&&box.x+box.width<=size.width,`${id} fits ${size.width}`);}
      }
      await phone.setViewportSize({width:390,height:844});
      assert.equal(await phone.locator('#runtime-mode').textContent(),'Runtime mode: local VM');
      const virtual=phone.getByRole('button',{name:'Show virtual controls',exact:true});
      await virtual.focus();await phone.keyboard.press('Enter');
      assert.equal(await virtual.getAttribute('aria-expanded'),'true');
      assert.equal(await virtual.textContent(),'Hide virtual controls');
      await phone.keyboard.press('Tab');
      const up=phone.getByRole('button',{name:'Up',exact:true});assert.equal(await focused(up),true);
      await phone.locator('#toggle').click();await phone.waitForFunction(()=>window.nekoPlayDiagnostics().running);
      await up.focus();await phone.keyboard.down('Space');
      assert.equal(await up.getAttribute('aria-pressed'),'true');
      await phone.keyboard.press('Tab');await phone.keyboard.up('Space');
      assert.equal(await up.getAttribute('aria-pressed'),'false');
      assert.equal(await focused(phone.getByRole('button',{name:'Left',exact:true})),true);
      await phone.locator('#language').selectOption('zh-CN');
      assert.equal(await virtual.textContent(),'隐藏虚拟按键');
      assert.equal(await phone.locator('[data-key="38"]').getAttribute('aria-label'),'向上');
      await phone.locator('#language').selectOption('en');
      assert.equal(await virtual.textContent(),'Hide virtual controls');
      await phone.locator('#stop').click();await phone.waitForFunction(()=>!window.nekoPlayDiagnostics().busy);
      assert.equal(await phone.locator('#status').textContent(),'Stopped · start again from the beginning');
      assert.equal(await phone.getByRole('button',{name:'Space key',exact:true}).count(),1);
      await isolated.close();
    });
    assert.deepEqual(errors,[]);await context.close();
  }finally{
    await browser?.close();if(child.exitCode===null&&!spawnError){child.kill();await once(child,'exit');}
  }
});
