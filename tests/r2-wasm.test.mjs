import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {readFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {promisify} from 'node:util';
import {summarize} from '../tools/profile-wasm-player.mjs';

test('r2-wasm profile summaries preserve inputs and have deterministic quantiles',()=>{
  const input=[4,0,3,1,2];
  assert.deepEqual(summarize(input),{count:5,mean:2,p50:2,p95:4,max:4});
  assert.deepEqual(input,[4,0,3,1,2]);
  assert.deepEqual(summarize([0]),{count:1,mean:0,p50:0,p95:0,max:0});
  for(const bad of [[],[NaN],[Infinity],[-1]])assert.throws(()=>summarize(bad));
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
