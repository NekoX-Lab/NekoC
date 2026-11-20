import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {readFile} from 'node:fs/promises';
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
  const child=process.env.NEKOC_HEALTH_ORIGIN?null:spawn(binary,['--port',String(port)],{cwd:root,stdio:['ignore','pipe','pipe']});
  let output='',spawnError,browser;child?.stdout.on('data',data=>output+=data);child?.stderr.on('data',data=>output+=data);child?.on('error',error=>spawnError=error);
  const origin=process.env.NEKOC_HEALTH_ORIGIN||`http://127.0.0.1:${port}`;
  const api=async(pathname,value)=>{
    const response=await fetch(`${origin}/api/${pathname}`,value===undefined?undefined:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});
    assert.equal(response.ok,true,`${pathname}: HTTP ${response.status}`);return response.json();
  };
  try{
    for(let i=0;;i++){
      if(spawnError)throw spawnError;if((child&&child.exitCode!==null)||i>=200)throw Error(`Backend failed: ${output}`);
      try{if((await fetch(`${origin}/api/project`)).ok)break;}catch{}await delay(50);
    }
    const imported=await api('import',ownedProject());assert.equal(imported.health_report.schema_version,1);
    browser=await loadPlaywright().chromium.launch({headless:true,channel:process.env.NEKOC_BROWSER_CHANNEL||'msedge',args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
    const context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true}),page=await context.newPage(),errors=[],posts=[];
    // Optional local source against a freshly built remote backend over SSH.
    if(process.env.NEKOC_HEALTH_LOCAL_APP==='1')await page.route('**/app.js',async route=>route.fulfill({contentType:'text/javascript',body:await readFile(path.join(root,'web','app.js'),'utf8')}));
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

    await t.test('numeric and text report focus rejects hidden insertion; enclosing statements append and execute',async()=>{
      for(const type of ['math_number','text']){
        const p=ownedProject(),actor=p.actors.actorsDict['first-actor'];
        p.projectName=`输入插入回归-${type}`;p.actors.actorsDict['second-actor'].nekoBlockJsonList=[];p.procedures.proceduresDict={};
        actor.rotation=0;
        const text=type==='text',literal={id:'literal[0].id',type,fields:text?{TEXT:'hello'}:{NUM:1},parent_id:'statement'};
        actor.nekoBlockJsonList=[{id:'hat',type:'on_running_group_activated',next:{id:'statement',type:text?'console_log':'self_go_forward',parent_id:'hat',inputs:{[text?'console_log':'steps']:literal}}}];
        await api('import',p);await page.reload();await page.waitForFunction(name=>window.nekoImportReport?.project?.projectName===name,p.projectName);
        const row=panel.locator('.health-entry').filter({hasText:'积木 ID：literal[0].id'}).first();await row.click();
        const move=page.locator('#palette button').filter({hasText:'移动步数'}).first();assert.equal(await move.isDisabled(),true);
        const before=await editorProject();await move.evaluate(button=>button.onclick());assert.deepEqual(await editorProject(),before);
        assert.equal(await page.locator('#undo').isDisabled(),true);assert.equal(await page.locator('#blocks .health-block-target').getAttribute('data-block'),'literal[0].id');
        await page.locator('#blocks [data-block="statement"] > .block-label').click();assert.equal(await move.isEnabled(),true);await move.click();
        const edited=await editorProject(),statement=edited.actors.actorsDict['first-actor'].nekoBlockJsonList[0].next;
        assert.equal(statement.next.type,'self_go_forward');assert.equal(Object.values(statement.inputs)[0].next,undefined);
        assert.equal(await page.locator('#blocks [data-block]').evaluateAll((nodes,id)=>nodes.filter(node=>node.dataset.block===id).length,statement.next.id),1);
        await page.locator('#run').click();await page.waitForFunction(()=>window.nekoDiagnostics()?.pipeline.completedFrames>0);
        await page.locator('#pause').click();
        const sprite=await page.evaluate(()=>window.nekoDiagnostics().sprites.find(sprite=>sprite.id==='first-actor'));
        assert.ok(Math.abs(Math.hypot(sprite.x,sprite.y)-(text?10:11))<1e-8,JSON.stringify(sprite));
        if(text)assert.ok((await page.locator('#logs').textContent()).includes('hello'));
        await page.locator('#stop').click();await page.waitForFunction(()=>!window.nekoDiagnostics().started);
      }
    });

    await t.test('a dangling screen error row from the backend locates its nested input',async()=>{
      const p=ownedProject(),id='actor.[0]/~',actor=p.actors.actorsDict['first-actor'];
      p.projectName='结构错误定位回归';p.actors.actorsDict={[id]:actor};p.scenes.scenesDict['first-scene'].actorIds=[id];p.scenes.scenesDict['second-scene'].actorIds=[];p.procedures.proceduresDict={};
      actor.id=id;actor.nekoBlockJsonList=[{id:'statement',type:'self_move_to',inputs:{'socket.with[0]/~':{id:'screen-reference',type:'get_screens',is_output:true,fields:{screen_id:'deleted-scene'}}}}];
      const imported=await api('import',p),issue=imported.health_report.items.find(item=>item.code==='invalid_structure'&&item.impact.includes('dangling_screen_reference'));
      assert.equal(issue.owner,id);assert.equal(issue.block,'screen-reference');assert.equal(issue.block_type,'get_screens');
      await page.reload();await page.waitForFunction(()=>window.nekoImportReport?.project?.projectName==='结构错误定位回归');
      const before=await editorProject(),row=panel.locator('.health-entry').filter({hasText:'dangling_screen_reference'}).first();
      assert.equal(await row.isEnabled(),true);await row.click();assert.equal(await page.locator('#blocks .health-block-target').getAttribute('data-block'),'screen-reference');
      assert.deepEqual(await editorProject(),before);assert.equal(await page.locator('#undo').isDisabled(),true);
    });

    assert.deepEqual(errors,[]);await context.close();
  }finally{
    await browser?.close();if(child&&child.exitCode===null&&!spawnError){child.kill();await once(child,'exit');}
  }
});
