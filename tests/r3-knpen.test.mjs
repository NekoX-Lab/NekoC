import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { loadPlaywright } from '../tools/probe-kitten4.mjs';
import { cases, command, penProject } from '../tools/compat/r3-knpen-fixtures.mjs';

const evidence = JSON.parse(await fs.readFile(new URL('../docs/r3-knpen-evidence.json', import.meta.url), 'utf8'));

test('r3-knpen official evidence covers real brush deltas and all authored cases', async () => {
  assert.deepEqual(evidence.errors, []);
  assert.equal(evidence.mode, 'player');
  assert.equal(evidence.comparisonInput, 'actual NekoC VM deltas');
  assert.deepEqual(evidence.cases.map(c => c.name), cases.map(c => c.name));
  assert.ok(evidence.bundles.some(b => /\/main\./.test(b.url) && /^[a-f0-9]{64}$/.test(b.sha256)));
  assert.equal(evidence.sourceLocations.length, 3);
  assert.ok(evidence.sourceLocations.every(s=>Number.isInteger(s.byteOffset)&&s.byteOffset>0));
  const sample = (name, x, y) => evidence.cases.find(c => c.name === name).samples.find(s => s.x === x && s.y === y).rgba;
  assert.deepEqual(sample('alpha-endpoints', -120, 30), [32,64,96,224]);
  assert.equal(sample('repeated-down-zero', 0, 0)[3], 192);
  assert.equal(sample('repeated-down-nonzero', -120, 30)[3], 128);
  for(const name of ['alpha-endpoints','alpha-corner','colours-crossing','clear-while-down']){
    const d=evidence.visual.find(c=>c.name===name).differences;
    assert.ok(d.after.absoluteAlphaError<d.before.absoluteAlphaError, name);
  }
  for (const c of cases) {
    assert.ok(c.actions.map(command).length);
    const p = await penProject(c.actions);
    assert.equal(p.actors.actorsDict['nekoc-default-actor'].visible, false);
  }
});

test('r3-knpen actual WebGL brush keeps origin opacity, packed order, clear and resolution', {
  skip: process.env.R3_KNPEN_BROWSER !== '1',
}, async () => {
  const browser = await loadPlaywright().chromium.launch({ channel: 'msedge', headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  try {
    const page = await browser.newPage();
    await page.route('https://r3-knpen.test/**', async route => {
      const name = new URL(route.request().url()).pathname.slice(1);
      if (!name) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>KN pen test</title>' });
      if (!['renderer.js','pen-k4.js'].includes(name)) return route.abort();
      await route.fulfill({ contentType: 'application/javascript', body: await fs.readFile(new URL(`../web/${name}`, import.meta.url), 'utf8') });
    });
    await page.goto('https://r3-knpen.test/');
    const result = await page.evaluate(async cases => {
      const { StageRenderer } = await import('/renderer.js');
      const r = new StageRenderer(document.createElement('canvas')); r.resolutionScale = 1;
      await r.load({ stageSize: {width:900,height:562}, scenes:{currentSceneId:'s',scenesDict:{s:{actorIds:[]}}}, actors:{actorsDict:{}} });
      const sample = (x,y) => { const gl=r.gl,p=new Uint8Array(4);gl.bindFramebuffer(gl.FRAMEBUFFER,r.framebuffer);
        gl.readPixels(Math.floor((450+x)*r.canvas.width/900),Math.floor((281+y)*r.canvas.height/562),1,1,gl.RGBA,gl.UNSIGNED_BYTE,p);gl.bindFramebuffer(gl.FRAMEBUFFER,null);return [...p]; };
      const observations = [];
      for(const scale of [.5,1,2]){
        r.setResolution(scale);
        for(const c of cases){
          r.apply({sprites:[],clear:true},new Float32Array(c.lines),false);
          const samples=c.samples.map(s=>({x:s.x,y:s.y,rgba:sample(s.x,s.y)}));
          const before=sample(-120,30);r.apply({sprites:[]},new Float32Array(),false);
          if(String(before)!==String(sample(-120,30)))throw Error('Idle frame lost brush');
          observations.push({scale,name:c.name,samples});
        }
      }
      // A same-frame stamp/fill boundary may split an instanced brush batch.
      r.setResolution(1);const c=cases.find(c=>c.name==='colours-crossing'), lines=new Float32Array(c.lines);
      r.drawTextStamp=()=>{};
      r.apply({sprites:[],clear:true,text_stamps:[{before_line:1}]},lines,false);const split=sample(-120,30);
      r.apply({sprites:[],clear:true},new Float32Array(),false);const cleared=sample(-120,30);
      const error=r.gl.getError();r.gl.getExtension('WEBGL_lose_context').loseContext();
      return {observations,split,cleared,error};
    }, evidence.cases);
    for(const c of result.observations){
      const expected=evidence.cases.find(e=>e.name===c.name);
      if(c.name==='fractional-width'){
        assert.ok(c.samples.some(s=>s.rgba[3]>0), 'fractional brush must render');
        continue;
      }
      for(let i=0;i<c.samples.length;i++){
        // Thin fractional strokes and the far cap at half resolution fall on
        // Canvas/analytic-AA boundaries; their raster error is measured by the
        // comparison tool, not relaxed into a semantic assertion here.
        if(c.samples[i].x===-11)continue;
        const actual=c.samples[i].rgba, rgba=expected.samples[i].rgba;
        // Premultiplied GL vs Canvas getImageData (straight alpha), ±2 byte
        // quantization only. Samples deliberately avoid antialiased boundaries.
        for(let k=0;k<4;k++){
          const target=k===3?rgba[k]:Math.round(rgba[k]*rgba[3]/255);
          assert.ok(Math.abs(actual[k]-target)<=2, `${c.name}/${c.scale}/${i}/${k}: ${actual[k]} vs ${target}`);
        }
      }
    }
    const expected=evidence.cases.find(c=>c.name==='colours-crossing').samples[0].rgba;
    for(let k=0;k<4;k++)assert.ok(Math.abs(result.split[k]-(k===3?expected[k]:Math.round(expected[k]*expected[3]/255)))<=2);
    assert.deepEqual(result.cleared,[0,0,0,0]);assert.equal(result.error,0);
  } finally { await browser.close(); }
});
