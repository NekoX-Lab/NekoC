import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import nodeWasm from '../dist/nodejs/nekoc_wasm.js';
import init,* as webWasm from '../dist/web/nekoc_wasm.js';
import {decodeFrame} from '../frame.mjs';

test('r2-wasm borrowed import serialization preserves both shipped bindings',async()=>{
  await init({module_or_path:await readFile(new URL('../dist/web/nekoc_wasm_bg.wasm',import.meta.url))});
  for(const file of ['three_body.bcmkn','kitten4-demo.bcm']){
    const source=JSON.parse(await readFile(new URL(`../../../samples/${file}`,import.meta.url),'utf8'));
    source.r2_wasm_unknown={text:'中文 🐈',nullable:null,list:[true,1.25,''],url:'data:image/svg+xml;base64,PHN2Zy8+'};
    const imported=[nodeWasm,webWasm].map(wasm=>JSON.parse(wasm.importProject(JSON.stringify(source))));
    assert.deepEqual(imported[0],imported[1]);
    const {project,report}=imported[0];
    assert.equal(report.fast_runtime_ready,true);
    if(file.endsWith('bcmkn'))assert.deepEqual(project,source);
    else assert.deepEqual(project._nekocKitten4.source.r2_wasm_unknown,source.r2_wasm_unknown);
    for(const wasm of [nodeWasm,webWasm]){
      const player=new wasm.Player(JSON.stringify(project));
      try{
        assert.equal(JSON.parse(player.ready()).ready,true);
        const frame=decodeFrame(player.handle('{"dt":0.016666666666666666,"budget_ms":16}'));
        assert.ok(Array.isArray(frame.logs));
        assert.ok(JSON.parse(player.handle('{"debug_snapshot":true}')).snapshot);
      }finally{player.free();}
    }
    assert.throws(()=>webWasm.importProject('{"toolType":"invalid"}'));
  }
});
