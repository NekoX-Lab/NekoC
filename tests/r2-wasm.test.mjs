import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {readFile,writeFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {promisify} from 'node:util';
import {summarize} from '../tools/profile-wasm-player.mjs';

test('r2-wasm profile summaries preserve inputs and have deterministic quantiles',()=>{
  const input=[4,0,3,1,2];
  assert.deepEqual(summarize(input),{count:5,mean:2,p50:2,p95:4,max:4});
  assert.deepEqual(input,[4,0,3,1,2]);
  assert.deepEqual(summarize([0]),{count:1,mean:0,p50:0,p95:0,max:0});
  for(const bad of [[],[NaN],[Infinity],[-1]])assert.throws(()=>summarize(bad));
});

// Owned 16x16 black VP8 WebM (0.3 s), generated locally with ffmpeg lavfi.
// Embedded bytes keep this regression independent of ffmpeg or network media.
const videoURL='data:video/webm;base64,GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAIUEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHWTbuMU6uEElTDZ1OsggEjTbuMU6uEHFO7a1OsggH+7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsCrXsYMPQkBNgIxMYXZmNjIuMy4xMDBXQYxMYXZmNjIuMy4xMDBEiYhAcsAAAAAAABZUrmvIrgEAAAAAAAA/14EBc8WIiWfbnnjiR5KcgQAitZyDdW5kiIEAhoVWX1ZQOIOBASPjg4QF9eEA4JCwgRC6gRCagQJVsIRVuYEBElTDZ/tzc59jwIBnyJlFo4dFTkNPREVSRIeMTGF2ZjYyLjMuMTAwc3PWY8CLY8WIiWfbnnjiR5JnyKFFo4dFTkNPREVSRIeUTGF2YzYyLjExLjEwMCBsaWJ2cHhnyKFFo4hEVVJBVElPTkSHkzAwOjAwOjAwLjMwMDAwMDAwMAAfQ7Z11ueBAKOjgQAAgBACAJ0BKhAAEAAARwiFhYiFhIgCAgAMDWAA/v+rUICjlYEAZACxAQABEBAAGAAYWC/0AAgAAKOVgQDIALEBAAEQEAAYABhYL/QACAAAHFO7a5G7j7OBALeK94EB8YIBo/CBAw==';

test('r2-wasm profiler forwards decoded video metadata and completes wait continuations',{
  skip:!process.env.NEKOC_WASM_PROFILE_E2E,timeout:120000,
},async()=>{
  await mkdir('dist',{recursive:true});
  const dir=await mkdtemp('dist/r2-wasm-video-');
  try{
    const kn=JSON.parse(await readFile('samples/three_body.bcmkn','utf8'));
    for(const owners of [kn.scenes.scenesDict,kn.actors.actorsDict])for(const owner of Object.values(owners))owner.nekoBlockJsonList=[];
    kn.videos={videosDict:{v:{id:'v',url:videoURL,width:16,height:16,visible:true}}};
    kn.scenes.scenesDict[kn.scenes.currentSceneId].nekoBlockJsonList=[{
      id:'video-start',type:'on_running_group_activated',next:{id:'video-wait',type:'kitten4_play_video_until_end',fields:{video:'v'},
        next:{id:'video-after-wait',type:'kitten4_show_hide_video',fields:{video:'v',display:'hide'}}},
    }];
    const k4=JSON.parse(await readFile('samples/kitten4-demo.bcm','utf8'));
    for(const owner of [...Object.values(k4.theatre.actors),...Object.values(k4.theatre.scenes)])if(owner.block_data_json)owner.block_data_json={blocks:{},connections:{}};
    const block=(id,type,fields={})=>({id,type,fields,shadows:{},mutation:''});
    Object.values(k4.theatre.actors)[0].block_data_json={
      blocks:{s:block('s','start_on_click'),p:block('p','play_video_until_end',{video:'v'}),h:block('h','show_hide_video',{video:'v',display:'hide'})},
      connections:{s:{p:{type:'next'}},p:{h:{type:'next'}}},
    };
    k4.theatre.videos=kn.videos.videosDict;
    assert.equal(Object.hasOwn(kn.videos.videosDict.v,'duration'),false);
    const files=[`${dir}/kn.json`,`${dir}/k4.json`],out=`${dir}/profile.json`;
    await Promise.all([kn,k4].map((project,i)=>writeFile(files[i],JSON.stringify(project))));
    await promisify(execFile)(process.execPath,['tools/profile-wasm-player.mjs',
      '--runs','1','--warmup','1','--frames','30','--out',out,
      ...(process.env.NEKOC_WEB_BIN?['--web',process.env.NEKOC_WEB_BIN]:[]),
      ...(process.env.NEKOC_PROFILE_WASM_DIR?['--wasm',process.env.NEKOC_PROFILE_WASM_DIR]:[]),...files,
    ]);
    const report=JSON.parse(await readFile(out,'utf8'));
    assert.equal(report.projects.length,2);
    for(const project of report.projects)for(const kind of ['wasm','rust']){
      const run=project.runs[0][kind],label=`${project.file} ${kind}`;
      assert.deepEqual(run.errors,[],label);
      assert.equal(run.samples.length,30,label);
      assert.ok(run.instructions>0,`${label}: continuation must execute after warmup`);
      assert.deepEqual(run.progress,{activeTasks:0,playingVideos:0,endedVideos:1,visibleVideos:0},label);
    }
  }finally{await rm(dir,{recursive:true,force:true});}
});

// Opt-in production transport smoke test. It checks counts and valid data,
// never a wall-clock threshold. Needs the built release web binary/WASM and
// Playwright (the same prerequisites as the profiling command).
test('r2-wasm profiler runs both transports and records the requested samples',{
  skip:!process.env.NEKOC_WASM_PROFILE_E2E,timeout:120000,
},async()=>{
  await mkdir('dist',{recursive:true});
  const dir=await mkdtemp('dist/r2-wasm-smoke-');
  try{
    const out=`${dir}/profile.json`;
    await promisify(execFile)(process.execPath,['tools/profile-wasm-player.mjs',
      '--runs','1','--warmup','1','--frames','3','--out',out,
      ...(process.env.NEKOC_WEB_BIN?['--web',process.env.NEKOC_WEB_BIN]:[]),
      ...(process.env.NEKOC_PROFILE_WASM_DIR?['--wasm',process.env.NEKOC_PROFILE_WASM_DIR]:[]),
      'samples/three_body.bcmkn',
    ]);
    const report=JSON.parse(await readFile(out,'utf8'));
    assert.match(report.environment.wasmSha256,/^[a-f0-9]{64}$/);
    assert.equal(report.projects.length,1);
    assert.equal(report.projects[0].runs.length,1);
    for(const kind of ['wasm','rust']){
      const run=report.projects[0].runs[0][kind];
      assert.equal(run.samples.length,3);
      assert.ok(Object.values(run.startup).every(n=>Number.isFinite(n)&&n>=0));
      for(const key of ['roundtrip','decode','submit','total','vm']){
        assert.deepEqual(run.summary[key],summarize(run.samples.map(s=>s[key])));
      }
    }
  }finally{await rm(dir,{recursive:true,force:true});}
});
