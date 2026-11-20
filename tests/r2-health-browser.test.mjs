import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {loadPlaywright} from '../tools/probe-kitten4.mjs';

// Explicit opt-in after building web. Shared Playwright uses NEKOC_NODE_MODULES.
// NEKOC_HEALTH_BROWSER=1 node --test tests/r2-health-browser.test.mjs
// All test works are original in-memory JSON sent directly to the import API.
function ownedProject(){
  const block=(id,type,extra={})=>({id,type,fields:{},inputs:{},...extra});
  let next=null;
  for(let i=60;i>=0;i--){const current=block(`legacy[${i}].block`,'bcm_translator_text_execution_block');if(next){current.next=next;next.parent_id=current.id;}next=current;}
  const root=block('start-second','on_running_group_activated',{next});next.parent_id=root.id;
  const scene=(id,name,actorIds)=>({id,name,screenName:name,actorIds,styles:[],visible:true,nekoBlockJsonList:[],comments:{}});
  const actor=(id,name,blocks)=>({id,name,styles:[],position:{x:0,y:0},scale:100,rotation:0,visible:true,nekoBlockJsonList:blocks,comments:{}});
  return {projectName:'原创体检浏览器回归',version:'0.27.4',toolType:'KN',stageSize:{width:900,height:562},
    scenes:{currentSceneId:'first-scene',sortList:['first-scene','second-scene'],scenesDict:{
      'first-scene':scene('first-scene','第一场景',['first-actor']),
      'second-scene':scene('second-scene','第二场景',['second-actor']),
    }},actors:{actorsDict:{'first-actor':actor('first-actor','角色一',[]),'second-actor':actor('second-actor','角色二',[root])}},
    procedures:{proceduresDict:{'health-procedure':{id:'health-procedure',name:'体检过程',params:[],nekoBlockJsonList:[block('procedure-risk','bcm_translator_text_execution_block')]}}},
    styles:{stylesDict:{}},audios:{audiosDict:{},sortList:[]},variables:{variablesDict:{}},lists:{listsDict:{}},broadcasts:{broadcastsDict:{}}};
}

test('real Studio import health: pagination, read-only navigation, exact download and recheck', {
  skip:process.env.NEKOC_HEALTH_BROWSER!=='1',timeout:120000,
},async t=>{
  const root=fileURLToPath(new URL('../',import.meta.url));
  const socket=createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');
  const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
  const binary=process.env.NEKOC_WEB_BIN||path.join(root,'target','debug',process.platform==='win32'?'web.exe':'web');
  const child=spawn(binary,['--port',String(port)],{cwd:root,stdio:['ignore','pipe','pipe']});
  let output='',spawnError,browser;child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>output+=data);child.on('error',error=>spawnError=error);
  const origin=`http://127.0.0.1:${port}`;
  const api=async(pathname,value)=>{
    const response=await fetch(`${origin}/api/${pathname}`,value===undefined?undefined:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});
    assert.equal(response.ok,true,`${pathname}: HTTP ${response.status}`);return response.json();
  };
  try{
    for(let i=0;;i++){
      if(spawnError)throw spawnError;if(child.exitCode!==null||i>=200)throw Error(`Backend failed: ${output}`);
      try{if((await fetch(`${origin}/api/project`)).ok)break;}catch{}await delay(50);
    }
    const imported=await api('import',ownedProject());assert.equal(imported.health_report.schema_version,1);
    browser=await loadPlaywright().chromium.launch({headless:true,channel:process.env.NEKOC_BROWSER_CHANNEL||'msedge',args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
    const context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true}),page=await context.newPage(),errors=[],posts=[];
    page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(request.method()==='POST')posts.push(new URL(request.url()).pathname);});
    await page.goto(origin);await page.waitForFunction(()=>window.nekoImportReport?.project?.projectName==='原创体检浏览器回归'&&window.nekoDiagnostics);
    const report=await page.evaluate(()=>window.nekoImportReport.health_report),panel=page.locator('#health-report');
    const refresh=()=>panel.getByRole('button',{name:'重新体检',exact:true});
    const download=()=>panel.getByRole('button',{name:'下载文本',exact:true});
    const editorProject=async()=>{await page.locator('[data-tab=json]').click();const value=JSON.parse(await page.locator('#json-source').inputValue());await page.locator('[data-tab=blocks]').click();return value;};
    const baseline=await editorProject(),serverBaseline=await api('project');
    const readDownload=async()=>{
      const pending=page.waitForEvent('download');await download().click();const file=await pending,stream=await file.createReadStream(),chunks=[];
      assert.ok(stream);for await(const chunk of stream)chunks.push(chunk);return {name:file.suggestedFilename(),text:Buffer.concat(chunks).toString('utf8')};
    };

    await t.test('all report items are reachable in bounded pages with five independent labels',async()=>{
      for(const label of ['能保留导出','能执行','语义近似','尚未验证','不支持'])assert.ok((await panel.textContent()).includes(label));
      assert.match(await panel.textContent(),/未知与无数据不视为通过/);assert.ok(report.items.length>50);
      let visited=0;for(let p=0;p<Math.ceil(report.items.length/50);p++){
        const count=await panel.locator('.health-entry').count();assert.ok(count>0&&count<=50);visited+=count;
        if(p+1<Math.ceil(report.items.length/50))await panel.getByRole('button',{name:'下一页',exact:true}).click();
      }
      assert.equal(visited,report.items.length);assert.equal(await panel.getByRole('button',{name:'下一页',exact:true}).isDisabled(),true);
    });

    await t.test('actor and procedure locations highlight literal IDs without editing scenes or history',async()=>{
      await panel.locator('.health-count').filter({hasText:'不支持'}).click();
      const risk=panel.locator('.health-entry').filter({hasText:'积木 ID：legacy[0].block'}).first();await risk.click();
      assert.match(await page.locator('#owner-name').textContent(),/角色二/);assert.match(await page.locator('#health-location').textContent(),/第二场景/);
      assert.equal(await page.locator('#blocks .health-block-target').getAttribute('data-block'),'legacy[0].block');
      assert.equal(await page.locator('#health-location mark').textContent(),'积木 ID：legacy[0].block');
      assert.deepEqual(await editorProject(),baseline);assert.deepEqual(await api('project'),serverBaseline);
      assert.equal(await page.locator('#dirty').textContent(),'本地项目');assert.equal(await page.locator('#undo').isDisabled(),true);
      let procedure=panel.locator('.health-entry').filter({hasText:'积木 ID：procedure-risk'});
      while(await procedure.count()===0){assert.equal(await panel.getByRole('button',{name:'下一页',exact:true}).isEnabled(),true);await panel.getByRole('button',{name:'下一页',exact:true}).click();}
      await procedure.first().click();assert.match(await page.locator('#owner-name').textContent(),/体检过程/);
      assert.equal(await page.locator('#blocks .health-block-target').getAttribute('data-block'),'procedure-risk');
      assert.deepEqual(await editorProject(),baseline);assert.equal(await page.locator('#undo').isDisabled(),true);
    });

    await t.test('download contains the exact Rust-generated Chinese text',async()=>{
      const file=await readDownload();assert.equal(file.text,report.text);assert.match(file.name,/作品体检[.]txt$/);
    });

    await t.test('editing expires download; refresh preserves project, scene, dirty state and undo history',async()=>{
      await page.locator('#project-name').fill('已编辑原创作品');await page.locator('#project-name').press('Tab');
      await page.waitForFunction(()=>document.querySelector('#health-report').textContent.includes('报告已过期'));
      assert.equal(await download().isDisabled(),true);const edited=await editorProject(),before=await api('project');
      const postCount=posts.length,responsePromise=page.waitForResponse(response=>response.url()===`${origin}/api/health-report`&&response.request().method()==='POST');
      await refresh().click();const response=await responsePromise;assert.equal(response.ok(),true);const fresh=await response.json();
      await page.waitForFunction(()=>!document.querySelector('#health-report').textContent.includes('体检中…'));
      assert.equal(await download().isEnabled(),true);assert.deepEqual(await editorProject(),edited);assert.equal(edited.scenes.currentSceneId,'first-scene');
      assert.deepEqual(await api('project'),before);assert.equal(await page.locator('#dirty').textContent(),'未保存更改');assert.equal(await page.locator('#undo').isEnabled(),true);
      assert.deepEqual(posts.slice(postCount),['/api/health-report']);assert.equal((await readDownload()).text,fresh.text);
      await page.locator('#undo').click();assert.equal((await editorProject()).projectName,baseline.projectName);assert.equal(await download().isDisabled(),true);
    });

    assert.deepEqual(errors,[]);await context.close();
  }finally{
    await browser?.close();if(child.exitCode===null&&!spawnError){child.kill();await once(child,'exit');}
  }
});
