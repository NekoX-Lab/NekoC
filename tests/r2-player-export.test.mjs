import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,mkdir,access,readdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {once} from 'node:events';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {unzipSync} from 'fflate';
import {embedAssets,exportPlayer} from '../tools/build-player-export.mjs';
import {loadPlaywright} from '../tools/probe-kitten4.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const fixture=path.join(root,'tests/fixtures/kitten4/visual-stamp.bcm');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==','base64');
async function scratch(t){const base=process.env.NEKOC_TEST_TMP||path.join(root,'dist');await mkdir(base,{recursive:true});const dir=await mkdtemp(path.join(base,'nekoc-r2-player-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
async function server(t,handle){const value=createServer(handle);value.listen(0,'127.0.0.1');await once(value,'listening');t.after(()=>new Promise(resolve=>{value.close(resolve);value.closeAllConnections();}));return `http://127.0.0.1:${value.address().port}`;}

test('export embeds relative, remote, inline, audio and video resources without rewriting program strings',async t=>{
  const dir=await scratch(t);await writeFile(path.join(dir,'my image.png'),png);let requests=0;
  const origin=await server(t,(req,res)=>{requests++;res.writeHead(200,{'content-type':'image/png'});res.end(png);});
  const project={styles:{stylesDict:{local:{url:'my%20image.png'},remote:{url:`${origin}/a.png`},same:{url:`${origin}/a.png`},inline:{url:`data:image/png;base64,${png.toString('base64')}`}}},audios:{audiosDict:{audio:{cdn_url:'data:audio/wav;base64,AQID'}}},videos:{videosDict:{video:{url:'data:video/mp4;base64,BAUG'}}},variables:{text:`${origin}/keep-program-data`}};
  const report=await embedAssets(project,dir);
  assert.equal(requests,1);assert.equal(report.assets.length,6);
  assert.equal(report.totalBytes,png.length*3+6);
  for(const style of Object.values(project.styles.stylesDict))assert.equal(style.url,`data:image/png;base64,${png.toString('base64')}`);
  assert.equal(project.audios.audiosDict.audio.url,'data:audio/wav;base64,AQID');
  assert.equal(project.variables.text,`${origin}/keep-program-data`);
});
test('missing media and external SVG dependencies produce named actionable failures',async t=>{
  const dir=await scratch(t);
  await assert.rejects(embedAssets({styles:{stylesDict:{a:{name:'坏图',url:'missing.png'}}}},dir),/坏图.*打包失败/);
  await assert.rejects(embedAssets({videos:{videosDict:{a:{name:'坏视频'}}}},dir),/坏视频.*缺少素材/);
  const svg='<svg xmlns="http://www.w3.org/2000/svg"><image href="https://invalid.test/a.png"/></svg>';
  await assert.rejects(embedAssets({styles:{stylesDict:{a:{url:`data:image/svg+xml,${encodeURIComponent(svg)}`}}}},dir),/SVG 含外部引用/);
  const localSvg='<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="paint"/></defs><rect fill="url(\'#paint\')"/><use href=" #paint"/></svg>';
  const local={styles:{stylesDict:{a:{url:`data:image/svg+xml,${encodeURIComponent(localSvg)}`}}}};
  assert.equal((await embedAssets(local,dir)).assets.length,1);
  await writeFile(path.join(dir,'absolute.png'),png);
  assert.equal((await embedAssets({styles:{stylesDict:{a:{url:path.join(dir,'absolute.png')}}}},dir)).assets.length,1);
  const origin=await server(t,(req,res)=>{res.writeHead(404);res.end();});
  await assert.rejects(embedAssets({audios:{audiosDict:{a:{url:`${origin}/missing.wav`}}}},dir),/音频.*HTTP 404/);
});
test('exports stage output atomically, preserve existing files and bundle relocatable ZIP entries',async t=>{
  const dir=await scratch(t),wasmDir=path.join(dir,'wasm');await mkdir(wasmDir);
  // A valid empty module exercises packaging; browser E2E below uses the real VM.
  await writeFile(path.join(wasmDir,'nekoc_wasm_bg.wasm'),new Uint8Array([0,97,115,109,1,0,0,0]));
  await writeFile(path.join(wasmDir,'nekoc_wasm.js'),'export default async function init(){};export const importProject=()=>{};export const checkExtensions=()=>{};export class Player{};');
  const out=path.join(dir,'directory'),zip=path.join(dir,'player.zip');
  await exportPlayer({input:fixture,out,wasmDir});await exportPlayer({input:fixture,out:zip,wasmDir});
  const entries=unzipSync(await readFile(zip));
  assert.deepEqual(Object.keys(entries).sort(),(await readdir(out)).sort());
  const html=Buffer.from(entries['index.html']).toString();
  assert.ok(html.includes('src="./runtime.js"'));assert.ok(!html.includes('type="module"'));assert.ok(!html.includes('src="/'));
  const js=Buffer.from(entries['player.js']).toString();new vm.Script(js);
  assert.ok(!js.includes('import.meta'));
  const manifest=JSON.parse(Buffer.from(entries['manifest.json']).toString());assert.equal(manifest.engine,'wasm');assert.equal(manifest.assets.length,2);
  const payload=vm.createContext({});vm.runInContext(Buffer.from(entries['project.js']).toString(),payload);
  assert.equal(payload.nekoExportProject.project_name,manifest.projectName);
  const before=await readFile(zip);await assert.rejects(exportPlayer({input:fixture,out:zip,wasmDir}),/输出已存在/);assert.deepEqual(await readFile(zip),before);
  const broken=path.join(dir,'broken.bcm'),failed=path.join(dir,'failed');
  const work=JSON.parse(await readFile(fixture,'utf8'));work.theatre.styles.background.url='does-not-exist.png';
  await writeFile(broken,JSON.stringify(work));await assert.rejects(exportPlayer({input:broken,out:failed,wasmDir}),/打包失败/);await assert.rejects(access(failed));
  assert.ok(!(await readdir(dir)).some(file=>file.startsWith('.nekoc-player-')));
});

test('export rejects missing or invalid WASM before creating the destination',async t=>{
  const dir=await scratch(t),wasmDir=path.join(dir,'wasm'),out=path.join(dir,'player');
  await mkdir(wasmDir);
  await assert.rejects(exportPlayer({input:fixture,out,wasmDir}),/缺少 WASM web 运行器/);
  await writeFile(path.join(wasmDir,'nekoc_wasm.js'),'export default async function init(){}');
  await writeFile(path.join(wasmDir,'nekoc_wasm_bg.wasm'),Buffer.from('not wasm'));
  await assert.rejects(exportPlayer({input:fixture,out,wasmDir}),/不是有效的 WebAssembly/);
  await assert.rejects(access(out));
});

test('real CLI export runs WASM frames over file:// and nested static hosting, including extracted ZIP', {skip:!process.env.NEKOC_PLAYER_EXPORT_E2E,timeout:300000},async t=>{
  const dir=await scratch(t),out=path.join(dir,'导出 包'),zip=path.join(dir,'player.zip'),extracted=path.join(dir,'解压'),kn=path.join(dir,'kn-player');
  const binary=process.env.NEKOC_BIN||path.join(root,`target/debug/nekoc${process.platform==='win32'?'.exe':''}`);
  for(const destination of [out,zip]){
    const result=spawnSync(binary,['export-player',fixture,'--out',destination],{cwd:root,encoding:'utf8'});
    assert.equal(result.status,0,`${result.error||''}${result.stdout}${result.stderr}`);
  }
  const knResult=spawnSync(binary,['export-player',path.join(root,'tests/fixtures/input-kn.bcmkn'),'--out',kn],{cwd:root,encoding:'utf8'});
  assert.equal(knResult.status,0,`${knResult.error||''}${knResult.stdout}${knResult.stderr}`);
  await mkdir(extracted);
  for(const [name,bytes]of Object.entries(unzipSync(await readFile(zip))))await writeFile(path.join(extracted,name),bytes);
  const origin=await server(t,async(req,res)=>{
    try{const name=decodeURIComponent(new URL(req.url,'http://local').pathname).replace('/nested/game/','');
      if(!/^[a-zA-Z.-]+$/.test(name))throw Error('invalid path');
      const data=await readFile(path.join(out,name));res.writeHead(200,{'content-type':name.endsWith('.html')?'text/html':name.endsWith('.css')?'text/css':'text/javascript'});res.end(data);
    }catch{res.writeHead(404);res.end();}
  });
  const browser=await loadPlaywright().chromium.launch({headless:true,channel:process.env.NEKOC_BROWSER_CHANNEL||'msedge',args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  t.after(()=>browser.close());
  for(const url of [pathToFileURL(path.join(out,'index.html')).href,pathToFileURL(path.join(extracted,'index.html')).href,`${origin}/nested/game/index.html`,pathToFileURL(path.join(kn,'index.html')).href]){
    const context=await browser.newContext({viewport:{width:1280,height:800}});const page=await context.newPage(),errors=[],requests=[];
    page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>requests.push(request.url()));
    // Network is disabled for local files; no browser security bypass flags.
    if(url.startsWith('file:'))await context.setOffline(true);
    await page.goto(url);await page.waitForFunction(()=>globalThis.nekoPlayDiagnostics&&!globalThis.nekoPlayDiagnostics().busy);
    const initial=await page.evaluate(()=>nekoPlayDiagnostics());
    assert.equal(initial.playable,true,await page.locator('#notice-text').textContent());assert.equal(initial.running,false);assert.equal(initial.totalUpdates,0);
    assert.match(await page.locator('#runtime-mode').textContent(),/WASM/);
    await page.locator('#toggle').click();await page.waitForFunction(()=>nekoPlayDiagnostics().totalUpdates>=8);
    const active=await page.evaluate(()=>nekoPlayDiagnostics());assert.ok(active.frame);assert.ok(active.renderer);assert.equal(active.running,true);
    // The renderer intentionally discards its WebGL backbuffer after compositing.
    // Read the actual compositor screenshot rather than that discarded buffer.
    const screenshot=await page.locator('#stage').screenshot();
    const pixels=await page.evaluate(async data=>{const image=new Image();image.src=`data:image/png;base64,${data}`;await image.decode();const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const context=canvas.getContext('2d');context.drawImage(image,0,0);return [...context.getImageData(canvas.width>>1,canvas.height>>1,1,1).data];},screenshot.toString('base64'));
    assert.ok(pixels.slice(0,3).some(v=>v>0),'stage must actually draw a non-black frame');
    await page.locator('#stop').click();await page.waitForFunction(()=>!nekoPlayDiagnostics().busy&&!nekoPlayDiagnostics().pending);
    const stopped=await page.evaluate(()=>nekoPlayDiagnostics());assert.equal(stopped.running,false);assert.equal(stopped.totalUpdates,0);
    await page.locator('#toggle').click();await page.waitForFunction(()=>nekoPlayDiagnostics().totalUpdates>=4);
    await page.locator('#stop').click();assert.equal(await page.locator('#notice').isVisible(),false);
    assert.deepEqual(errors,[]);assert.ok(!requests.some(request=>/^https?:/.test(request)&&!request.startsWith(origin)),requests.join('\n'));
    await context.close();
  }
});
