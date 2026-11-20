import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { StageRenderer } from '../web/renderer.js';
import { loadPlaywright } from '../tools/probe-kitten4.mjs';
import { transition10Fixtures } from '../tools/compat/k4-partial-transition-10.mjs';

const revision='7b057f26955ca47fb2a13c0a0cb17d94fd66fb14';
const baseline=execFileSync('git',['show',`${revision}:web/renderer.js`],{encoding:'utf8'}).replaceAll('\r\n','\n');
test('r3-render comparison source is the renderer used by round-11 pixel evidence',()=>{
  assert.equal(createHash('sha256').update(baseline).digest('hex'),'eb5f51230e59c5fc695cd489e173282803d568d3b0b3eb54b623692679e028a3');
});

// Exercise actual queue/flush/resource lifetime without timings or a GPU in CI.
function mockRenderer(){
  let id=0;const events=[];
  const gl=new Proxy({getShaderParameter:()=>true,getProgramParameter:()=>true,
    createTexture:()=>{events.push(['create']);return ++id;},createProgram:()=>++id,createBuffer:()=>++id,createVertexArray:()=>++id,
    drawArraysInstanced:(_mode,_start,_vertices,count)=>events.push(['draw',count]),
    deleteTexture:texture=>events.push(['delete',texture]),
    texImage2D:()=>events.push(['upload']),
  },{get:(target,key)=>key in target?target[key]:(()=>{})});
  const r=Object.assign(Object.create(StageRenderer.prototype),{gl,uniform:{},width:320,height:240,
    stats:{drawCalls:0,stampTextureBytes:0,stampUploads:0},stampCache:new Map(),stampCandidates:new Set(),textureBatchActive:true});
  return {r,events};
}
test('r3-render batches consecutive textures, flushes at capacity and before pen/effects',()=>{
  const {r,events}=mockRenderer();
  for(let i=0;i<1025;i++)r.drawTexture('a',i,0,10,10);
  assert.deepEqual(events,[['draw',1024]]);
  r.drawTexture('b',0,0,10,10);assert.deepEqual(events.at(-1),['draw',1]);
  r.drawLines(0,1);assert.deepEqual(events.slice(-2),[['draw',1],['draw',1]]);
  r.drawTexture('b',0,0,10,10);
  r.drawTexture('b',0,0,10,10,0,[1,1,1,1],[30,0,0,0,0,0,0]);
  assert.equal(r.textureBatch.count,0);assert.equal(r.stats.drawCalls,6);
  // Even malformed/non-finite effects must stay on the legacy shader path,
  // not be silently treated as neutral by JavaScript truthiness.
  r.drawTexture('b',0,0,10,10,0,[1,1,1,1],[NaN,0,0,0,0,0,0]);
  assert.equal(r.textureBatch.count,0);assert.equal(r.stats.drawCalls,7);
  r.sceneTransform={x:3,y:7,alpha:.25};const tint=[.2,.4,.6,.8];
  r.drawTexture('c',10,20,30,40,0,tint);
  assert.deepEqual([...r.textureBatch.data.slice(0,5)],[13,13,30,40,0]);
  assert.ok(Math.abs(r.textureBatch.data[8]-.2)<1e-7);assert.deepEqual(tint,[.2,.4,.6,.8]);
});
test('r3-render stamp LRU is bounded by entries and bytes and submits before eviction',()=>{
  const {r,events}=mockRenderer();
  const upload=(key,size=10)=>{for(let i=0;i<2;i++)r.uploadStamp(key,{width:size,height:size},0,size,0,size,1,1);};
  upload('hot');const hot=r.stampCache.get('hot').texture;
  for(let i=0;i<127;i++)upload(String(i));
  assert.equal(r.stats.stampTextureBytes,128*400);assert.equal(r.drawCachedStamp('hot'),true);
  upload('new');assert.ok(r.stampCache.has('hot'));assert.equal(r.stampCache.has('0'),false);
  // Put the least recently used entry into the pending batch, then force eviction.
  const oldest=r.stampCache.values().next().value;
  r.drawTexture(oldest.texture,0,0,10,10);events.length=0;
  upload('evict');const deletion=events.findIndex(e=>e[0]==='delete');
  assert.ok(deletion>0);assert.deepEqual(events[0],['draw',1]);assert.deepEqual(events[deletion],['delete',oldest.texture]);
  upload('large',1024);upload('large2',1024);
  assert.equal(r.stampCache.size,2);assert.equal(r.stats.stampTextureBytes,8*1024*1024);
  upload('oversized',2048);assert.equal(r.stampCache.size,2);assert.equal(r.stats.stampTextureBytes,8*1024*1024);
  assert.equal(r.drawCachedStamp('oversized'),false);assert.ok(events.some(e=>e[0]==='delete'&&e[1]===hot));
});

test('r3-render cold moving stamps reuse scratch with one upload each and bounded admission',()=>{
  const {r,events}=mockRenderer(),canvas={width:20,height:20};
  for(let round=0;round<7;round++)for(let i=0;i<1000;i++){
    const key=`image-${i}`;assert.equal(r.drawCachedStamp(key),false);
    r.uploadStamp(key,canvas,0,20,0,20,1,1);
  }
  r.flushTextureBatch();
  assert.equal(events.filter(e=>e[0]==='create').length,1);
  assert.equal(events.filter(e=>e[0]==='delete').length,0);
  assert.equal(events.filter(e=>e[0]==='upload').length,7000);
  assert.equal(events.filter(e=>e[0]==='draw').length,7000);
  assert.equal(r.stampCache.size,0);assert.equal(r.stampCandidates.size,128);
  events.length=0;
  r.uploadStamp('reused',canvas,0,20,0,20,1,1);
  assert.equal(r.stampCache.has('reused'),false);
  r.uploadStamp('reused',canvas,0,20,0,20,1,1);
  assert.equal(r.stampCache.has('reused'),true);
  const uploads=r.stats.stampUploads;
  for(let i=0;i<1000;i++)assert.equal(r.drawCachedStamp('reused'),true);
  assert.equal(r.stats.stampUploads,uploads);
  assert.equal(events.filter(e=>e[0]==='create').length,1);
  assert.equal(events.filter(e=>e[0]==='upload').length,2);
});

test('r3-render K4 image raster keys include subpixels and actual resolution',()=>{
  const {r}=mockRenderer();const keys=[];
  Object.assign(r,{canvas:{width:320,height:240},drawCachedStamp:key=>{keys.push(key);return true;}});
  const image={width:16,height:16,centerPoint:{x:0,y:0}},stamp={style:'c',x:1.25,y:2.5,scale:100,direction:17,rotation_type:0};
  r.drawK4ImageStamp(stamp,image);
  for(const patch of [{style:'d'},{x:1.5},{direction:18},{scale:99}])r.drawK4ImageStamp({...stamp,...patch},image);
  r.canvas.height=360;r.drawK4ImageStamp(stamp,image);
  assert.equal(new Set(keys).size,6);
});

test('r3-render pixels match frozen renderer for clones, stamps, eviction, resolution and transitions',{
  skip:!process.env.NEKOC_R3_RENDER_BROWSER,timeout:240000,
},async()=>{
  const sources={'/baseline.js':baseline,'/renderer.js':await readFile('web/renderer.js','utf8'),'/pen-k4.js':await readFile('web/pen-k4.js','utf8')};
  const server=createServer((req,res)=>{res.setHeader('Content-Type',sources[req.url]?'application/javascript':'text/html');res.end(sources[req.url]??'<!doctype html>');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
  try{
    browser=await loadPlaywright().chromium.launch({headless:true,channel:'msedge',args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
    const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}`);
    const result=await page.evaluate(async fixtures=>{
      const old=await import('/baseline.js'),current=await import('/renderer.js');
      const rs=[old,current].map(({StageRenderer})=>{const r=new StageRenderer(document.createElement('canvas'));r.resolutionScale=1;return r;});
      const snapshot=r=>{const gl=r.gl,p=new Uint8Array(r.canvas.width*r.canvas.height*4);gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.readPixels(0,0,r.canvas.width,r.canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,p);return p;};
      const checks=[];
      const compare=(name,draw)=>{
        const pixels=rs.map(r=>{draw(r);const p=snapshot(r);if(r.gl.getError())throw Error(name+': GL error');return p;});
        let changed=0;for(let i=0;i<pixels[0].length;i++)if(pixels[0][i]!==pixels[1][i])changed++;
        if(changed)throw Error(`${name}: ${changed} changed RGBA bytes`);
        checks.push(name);
      };
      const url='data:image/svg+xml;base64,'+btoa('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="16"><rect width="20" height="16" fill="#e84030" opacity=".6"/><path d="M0 0L20 16L5 13Z" fill="#20b060"/></svg>');
      const project={stageSize:{width:320,height:240},scenes:{currentSceneId:'s',scenesDict:{s:{actorIds:[],styles:['c','d']},t:{actorIds:[]}}},actors:{actorsDict:{}},styles:{stylesDict:{c:{url},d:{url}}}};
      const empty=new Float32Array();const reductions=[];
      for(const kitten4 of [false,true]){
        await Promise.all(rs.map(r=>r.load({...project,...(kitten4?{_nekocKitten4:{}}:{})})));
        const sprites=Array.from({length:1100},(_,i)=>({id:`clone${i}`,style:'c',x:i%40*8-155.25,y:Math.floor(i/40)*8-108.5,scale:83.5,direction:i%9*17,rotation_type:0,visible:true,opacity:.65}));
        const stamp={style:'c',x:3.25,y:-5.5,scale:95,direction:37,rotation_type:0,opacity:.3,before_line:0};
        const text={text:'Cache中',x:-20.5,y:30.25,size:13,direction:17,align:'center',color:[.1,.3,.8,.4],before_line:0};
        const frame={clear:true,reset:true,sprites,order:sprites.map(a=>a.id),text_stamps:Array(300).fill(text),image_stamps:Array(300).fill(stamp)};
        compare(`${kitten4}/cold`,r=>r.apply(frame,empty));
        compare(`${kitten4}/warm`,r=>r.apply(frame,empty));
        reductions.push({kitten4,old:rs[0].stats.drawCalls,current:rs[1].stats.drawCalls,stampUploads:rs[1].stats.stampUploads,textUploads:rs[1].stats.textUploads});
        const lines=new Float32Array([-80,0,80,0,7,.3,.7,.2,.6,0,-60,0,60,4,.1,.2,.9,.4]);
        const mixed={...frame,pen_layer:400,sprites:sprites.map((a,i)=>({...a,style:i%3?'c':'d',effects:i%71===0?[25,0,10,0,0,0,0]:null})),
          text_stamps:[text,{...text,text:'After',before_line:1}],image_stamps:[stamp,{...stamp,before_line:2}],
          pen_fills:[{before_line:1,before_text:1,before_image:1,points:[[-50,-40],[60,-40],[0,40]],color:[.8,.1,.4,.6]}]};
        compare(`${kitten4}/interleaved`,r=>r.apply(mixed,lines));
        compare(`${kitten4}/eviction`,r=>r.apply({...frame,sprites:[],order:[],text_stamps:Array.from({length:140},(_,i)=>({...text,text:`${i}`,x:i%20*14-140.25})),image_stamps:Array.from({length:140},(_,i)=>({...stamp,x:i%20*13-135.25,y:Math.floor(i/20)*24-80.5}))},empty));
        compare(`${kitten4}/resolution`,r=>{r.setResolution(1.5);r.apply(mixed,lines);});
        compare(`${kitten4}/scene`,r=>r.apply({scene:'t',sprites:[]},empty));
        compare(`${kitten4}/restore`,r=>r.apply({scene:'s',sprites:[]},empty));
        compare(`${kitten4}/text-clones`,r=>r.apply({clear:true,reset:true,order:sprites.map(a=>a.id),sprites:sprites.map(a=>({...a,text:{text:'Text',size:14,color:'#23a5dc'}}))},empty));
      }
      await Promise.all(rs.map(r=>{r.resolutionScale=1;return r.load({...project,_nekocKitten4:{}});}));
      // Synchronous FontFaceSet registration/deletion need not emit loadingdone.
      // Exercise both already-loaded and asynchronously loaded faces without
      // notifying the renderer, then compare each clear-and-restamp to baseline.
      const text={text:'iiiiiiiiMMMMWWW',size:24,direction:0,align:'left',x:-100,y:0,color:[0,0,0,1],before_line:0};
      const textFrame={clear:true,sprites:[],text_stamps:[text]};
      compare('font/before',r=>r.apply(textFrame,empty));const original=snapshot(rs[0]);
      const face=await new FontFace('Arial','local("Courier New")',{weight:'bold'}).load();document.fonts.add(face);
      try{
        compare('font/synchronous-add',r=>r.apply(textFrame,empty));
        if(snapshot(rs[0]).every((v,i)=>v===original[i]))throw Error('Font probe did not change glyphs');
      }finally{document.fonts.delete(face);}
      compare('font/delete',r=>r.apply(textFrame,empty));
      const asyncFace=new FontFace('Arial','local("Courier New")',{weight:'bold'});document.fonts.add(asyncFace);
      try{await asyncFace.load();compare('font/async-loaded',r=>r.apply(textFrame,empty));}
      finally{document.fonts.delete(asyncFace);}
      compare('font/restored',r=>r.apply(textFrame,empty));
      // Instrument real GL calls after scratch allocation. No wall-clock
      // assertion: a >128-position cycle must never allocate or evict textures.
      const counts=rs.map(r=>{
        const count={create:0,delete:0,upload:0};
        for(const [method,key]of [['createTexture','create'],['deleteTexture','delete'],['texImage2D','upload']]){
          const original=r.gl[method].bind(r.gl);r.gl[method]=(...args)=>{count[key]++;return original(...args);};
        }return count;
      });
      const moving={clear:true,sprites:[],image_stamps:Array.from({length:1000},(_,i)=>({style:'c',x:-100+i/5,y:0,scale:100,direction:0,rotation_type:0,before_line:0}))};
      for(let i=0;i<7;i++)compare(`moving/${i}`,r=>r.apply(moving,empty));
      if(JSON.stringify(counts[0])!==JSON.stringify(counts[1]))throw Error('Cold GL counts differ: '+JSON.stringify(counts));
      if(counts[1].create!==0||counts[1].delete!==0||counts[1].upload!==7000)throw Error('Cold GL churn: '+JSON.stringify(counts));
      const movingCounts=counts.map(c=>({...c}));
      // Reuse existing visual baseline scene inputs and all 65 fixed timestamps,
      // including screen-space filters, inherited opacity and screenshot paths.
      for(const [name,spec]of Object.entries(fixtures)){
        const p=spec.project,t=p.theatre;
        const ids=t.scenes_order;
        const scenes={[ids[0]]:{currentStyleId:'background',actorIds:[]},[ids[1]]:{currentStyleId:'background-b',actorIds:[]}};
        const styles=Object.fromEntries(Object.entries(t.styles).map(([id,s])=>[id,{...s,centerPoint:s.rotate_center}]));
        await Promise.all(rs.map(r=>{r.resolutionScale=1;return r.load({_nekocKitten4:{},stageSize:p.size,scenes:{currentSceneId:ids[0],scenesDict:scenes},actors:{actorsDict:{}},styles:{stylesDict:styles}});}));
        compare(`${name}/initial`,r=>{r.transitionClock=()=>0;r.apply(spec.initialFrame??{sprites:[],order:[]},empty);});
        compare(`${name}/switch`,r=>r.apply({sprites:[],order:[],...spec.targetFrame,scene:ids[1],transition:{kind:name.split('-')[0],direction:'left'}},empty));
        for(let frame=0;frame<65;frame++)compare(`${name}/${frame}`,r=>{r.transitionClock=()=>frame*1000/60;r.dirty=true;r.render();});
      }
      for(const r of rs)r.gl.getExtension('WEBGL_lose_context').loseContext();
      return {comparisons:checks.length,reductions,movingCounts};
    },await transition10Fixtures());
    assert.ok(result.comparisons>200);
    for(const r of result.reductions){assert.ok(r.current<(r.kitten4?310:r.old/100),JSON.stringify(r));assert.equal(r.stampUploads,r.kitten4?300:0);assert.equal(r.textUploads,0);}
    console.log('r3-render exact RGBA comparison:',JSON.stringify(result));
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
});
