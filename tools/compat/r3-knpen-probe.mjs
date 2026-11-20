// Original KN brush probe. Downloaded source / third-party works stay in dist.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadPlaywright } from '../probe-kitten4.mjs';
import { cases, command } from './r3-knpen-fixtures.mjs';
import { execFileSync } from 'node:child_process';

const out = 'dist/r3-knpen';
await fs.mkdir(out, { recursive: true });
const projectFile = process.argv[2] || 'E:/nekoc/dist/pickcat-corpus/kn/336156254.json';
const source = await fs.readFile(projectFile, 'utf8'), project = JSON.parse(source);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const player = process.argv.includes('--player');
const report = { checkedAt: new Date().toISOString(), mode: player ? 'player' : 'editor', project: { file: projectFile, name: project.projectName, sha256: sha256(source) }, bundles: [], errors: [] };
const prefix = player ? 'player' : 'editor';
const browser = await loadPlaywright().chromium.launch({ channel: 'msedge', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  page.on('pageerror', e => report.errors.push(e.message));
  await page.route(/\/static\/js\/[^/?]+\.js(?:\?.*)?$/, async route => {
    const response = await route.fetch(), bytes = await response.body();
    const url = route.request().url(), name = path.basename(new URL(url).pathname);
    report.bundles.push({ url, sha256: sha256(bytes), bytes: bytes.length });
    await fs.writeFile(`${out}/${name}`, bytes);
    const body = name.startsWith('main.') ? bytes.toString().replace('var __webpack_exports__=', 'window.__nekocRequire=__webpack_require__;var __webpack_exports__=') : bytes;
    await route.fulfill({ response, body });
  });
  const projectUrl = 'https://kn.codemao.cn/__r3_knpen__.bcmkn';
  await page.route(projectUrl, route => route.fulfill({ contentType: 'application/json', body: source }));
  report.url = player ? `https://kn.codemao.cn/player?type=2&workId=${path.basename(projectFile, '.json')}` : `https://kn.codemao.cn/editor?previewUrl=${encodeURIComponent(projectUrl)}`;
  await page.goto(report.url, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => window.__nekocRequire?.m && document.querySelector('canvas'), null, { timeout: 120000 });
  await page.evaluate(() => {
    const req = window.__nekocRequire;
    for (const [id, factory] of Object.entries(req.m)) {
      const text = String(factory);
      if (text.includes('BcmInstance:function')) window.__penBcm = req(id).BcmInstance;
      if (text.includes('getStageTarget:function')) window.__penStage = req(id);
      if (text.includes('key:"getHeart"') && text.includes('key:"initRuntime"')) {
        window.__penRuntime = Object.values(req(id)).find(v => typeof v?.get_instance === 'function' && typeof v?.initRuntime === 'function');
      }
    }
  });
  await page.waitForFunction(name => window.__penBcm?.getBcm().projectName === name &&
    (!document.querySelector('#init-loading') || getComputedStyle(document.querySelector('#init-loading')).display === 'none'), project.projectName, { timeout: 120000 });
  if (player) {
    await page.screenshot({ path: `${out}/player-before-start.png` });
    // The public player creates the actual stage/actors on its central play button.
    const button = page.locator('[class*="playButton"], [class*="play-button"], [class*="startButton"]');
    if (await button.count()) await button.first().click();
    else await page.mouse.click(720, 500);
    await page.waitForFunction(() => window.__penStage.getStageTarget(Object.keys(window.__penBcm.getBcm().actors.actorsDict)[0]), null, { timeout: 30000 });
  }
  report.inspect = await page.evaluate(() => {
    const bcm = window.__penBcm.getBcm();
    const actors = Object.keys(bcm.actors.actorsDict).map(id => {
      const actor = window.__penStage.getStageTarget(id);
      if (!actor) return { id, error: 'actor unavailable' };
      const brush = actor.get_brush();
      return { id, name: bcm.actors.actorsDict[id].name, position: actor.get_position(), brushKeys: Object.keys(brush),
        brushMethods: Object.getOwnPropertyNames(Object.getPrototypeOf(brush)), canvas: brush.ctx && { width: brush.ctx.canvas.width, height: brush.ctx.canvas.height },
        functions: Object.fromEntries(['set_pen_down', 'draw_line', 'canvas_draw_line', 'canvas_draw_circle', 'draw_text_stamp', 'clear'].map(n => [n, String(brush[n])])) };
    });
    return { actors, stageSize: bcm.stageSize, version: bcm.version };
  });
  await page.screenshot({ path: `${out}/corpus-editor.png` });
  report.cases = await page.evaluate(cases => {
    const actor = window.__penStage.getStageTarget(Object.keys(window.__penBcm.getBcm().actors.actorsDict)[0]);
    const brush = actor.get_brush(), ctx = brush.ctx, registry = window.__penRuntime.get_instance().getHeart().core.get_registry();
    const call = (name, args) => registry.domain_function_list[registry.get_domain_function_index(name)](args, 'r3-knpen', actor.get_id(), actor.get_id(), 'probe', {});
    const original = brush.draw_line, results = [];
    let lines = [];
    brush.draw_line = function(x, y) {
      if (this.origin_x !== undefined && this.origin_y !== undefined) {
        const rgb = this.get_color().match(/../g).map(v => parseInt(v, 16) / 255);
        lines.push(this.origin_x, -this.origin_y, x, -y, this.size, ...rgb, this.alpha);
      }
      return original.call(this, x, y);
    };
    try {
      for (const c of cases) {
        call('self_pen_up', {}); call('clear_drawing', {});
        call('self_set_pen_color', { color: '#000000' }); call('self_set_pen_color_property', { scope: 'alpha', val: 0 });
        call('self_set_pen_size', { size: 1 }); lines = [];
        for (const [name, args] of c.commands) { call(name, args); if (name === 'clear_drawing') lines = []; }
        const samples = [[-120,30],[-70,30],[-20,30],[-11,30],[-120,0],[0,30],[0,0],[-20,65]].map(([x,y]) =>
          ({ x, y, rgba: [...ctx.getImageData(ctx.canvas.width / 2 + x, ctx.canvas.height / 2 - y, 1, 1).data] }));
        results.push({ name: c.name, lines, samples, png: ctx.canvas.toDataURL() });
      }
    } finally { brush.draw_line = original; call('self_pen_up', {}); }
    return results;
  }, cases.map(c => ({ ...c, commands: c.actions.map(command) })));
  const current = await fs.readFile('web/renderer.js', 'utf8');
  const baseline = execFileSync('git', ['show', 'd6de981:web/renderer.js'], { encoding: 'utf8' });
  await page.route('**/__r3_renderer__/**', async route => {
    const name = path.basename(new URL(route.request().url()).pathname);
    const body = name === 'baseline.js' ? baseline : name === 'renderer.js' ? current : await fs.readFile('web/pen-k4.js', 'utf8');
    await route.fulfill({ contentType: 'application/javascript', body });
  });
  // The renderer gets actual VM deltas when available; first discovery runs
  // replay recorded brush deltas and explicitly label that distinction.
  const frames = await fs.readFile(`${out}/frames.json`, 'utf8').then(JSON.parse).catch(() => null);
  if (frames) for (const c of report.cases) {
    const frame = frames.find(f => f.name === c.name);
    if (!frame || frame.lines.length !== c.lines.length || frame.lines.some((n, i) => Math.abs(n - c.lines[i]) > 1e-6)) throw Error(`VM brush deltas differ: ${c.name}`);
  }
  report.comparisonInput = frames ? 'actual NekoC VM deltas' : 'official brush deltas (renderer-only isolation)';
  report.visual = await page.evaluate(async ({ cases, frames, stageSize }) => {
    const { StageRenderer: Current } = await import('/__r3_renderer__/renderer.js');
    const { StageRenderer: Baseline } = await import('/__r3_renderer__/baseline.js');
    const { width, height } = stageSize;
    const make = async Type => { const r = new Type(document.createElement('canvas')); r.resolutionScale = 1;
      await r.load({ stageSize, scenes: { currentSceneId: 's', scenesDict: { s: { actorIds: [] } } }, actors: { actorsDict: {} } }); return r; };
    const baseline = await make(Baseline), current = await make(Current), results = [];
    const pixels = r => {
      const gl=r.gl, p=new Uint8Array(width*height*4); gl.bindFramebuffer(gl.FRAMEBUFFER,r.framebuffer);
      gl.readPixels(0,0,width,height,gl.RGBA,gl.UNSIGNED_BYTE,p);gl.bindFramebuffer(gl.FRAMEBUFFER,null);
      const c=document.createElement('canvas');c.width=width;c.height=height;const ctx=c.getContext('2d'), data=ctx.createImageData(width,height);
      for(let y=0;y<height;y++)for(let x=0;x<width;x++){const a=((height-1-y)*width+x)*4,b=(y*width+x)*4,alpha=p[a+3];
        for(let k=0;k<3;k++)data.data[b+k]=alpha?Math.round(p[a+k]*255/alpha):0;data.data[b+3]=alpha;}
      ctx.putImageData(data,0,0);return c;
    };
    for(const c of cases){
      const image = new Image();image.src=c.png;await image.decode();
      const official=document.createElement('canvas');official.width=width;official.height=height;official.getContext('2d').drawImage(image,0,0);
      const expected=official.getContext('2d').getImageData(0,0,width,height).data;
      const vm=frames?.find(f=>f.name===c.name);
      const row={name:c.name,samples:{official:c.samples},differences:{}};
      const strip=document.createElement('canvas');strip.width=width*3;strip.height=height+32;const sc=strip.getContext('2d');sc.fillStyle='white';sc.fillRect(0,0,strip.width,strip.height);
      for(const [i,[name,r]] of [['official',null],['before',baseline],['after',current]].entries()){
        if(r)r.apply({sprites:[],clear:true},new Float32Array(vm?.lines??c.lines),false);
        const canvas=r?pixels(r):official;sc.drawImage(canvas,i*width,32);sc.fillStyle='black';sc.font='18px Arial';sc.fillText(name,i*width+12,24);
        if(r){const actual=canvas.getContext('2d').getImageData(0,0,width,height).data;let changed=0,max=0,alphaError=0;
          for(let at=0;at<actual.length;at+=4){const d=Math.abs(actual[at+3]-expected[at+3]);if(d>8)changed++;alphaError+=d;max=Math.max(max,d);}
          row.differences[name]={alphaPixelsOver8:changed,maxAlphaDifference:max,absoluteAlphaError:alphaError};
          row.samples[name]=c.samples.map(({x,y})=>({x,y,rgba:[...canvas.getContext('2d').getImageData(width/2+x,height/2-y,1,1).data]}));
          if(r.gl.getError())throw Error('WebGL rendering failed');
        }
      }
      row.png=strip.toDataURL();results.push(row);
    }
    for(const r of [baseline,current])r.gl.getExtension('WEBGL_lose_context').loseContext();
    return results;
  }, { cases: report.cases, frames, stageSize: report.inspect.stageSize });
  for (const c of report.cases) { await fs.writeFile(`${out}/${prefix}-${c.name}-official.png`, Buffer.from(c.png.split(',')[1], 'base64')); delete c.png; }
  for (const c of report.visual) { await fs.writeFile(`${out}/${prefix}-${c.name}-comparison.png`, Buffer.from(c.png.split(',')[1], 'base64')); delete c.png; }
  if (process.argv.includes('--record')) {
    if (report.errors.length || !frames || !player) throw Error('Record requires error-free player observations with real VM deltas');
    const evidence = { ...report, inspect: { stageSize: report.inspect.stageSize, version: report.inspect.version },
      visual: report.visual.map(({ name, differences }) => ({ name, differences })),
      baseline: { commit: 'd6de981', rendererSha256: sha256(baseline) },
      rendererSha256: sha256(current),
      method: 'Anonymous public player; original corpus loaded, central play button clicked. Unchanged official registry functions then called in one synchronous page.evaluate diagnostic (no project scripts can interleave within that JavaScript turn). Passive draw_line wrapper forwards to original; per-case brush pixels compared with actual NekoC VM deltas. Not an unmodified interactive playthrough.',
      limitations: ['GPU analytic AA is not Canvas pixel-exact at edges.', 'Direct registry calls, not project scheduling evidence.', 'Stamp/fill/layer paths are not covered by this pen regression.'] };
    const main = report.bundles.find(b => /\/main\./.test(b.url));
    const text = await fs.readFile(`${out}/${path.basename(new URL(main.url).pathname)}`, 'utf8');
    evidence.sourceLocations = ['.set_pen_down=function', '.canvas_draw_line=function', '.canvas_draw_circle=function'].map(anchor => {
      const index = text.indexOf(anchor);
      if (index < 0) throw Error(`Official brush source changed: ${anchor}`);
      return { anchor, byteOffset: Buffer.byteLength(text.slice(0, index)), bundleSha256: main.sha256 };
    });
    await fs.writeFile('docs/r3-knpen-evidence.json', JSON.stringify(evidence, null, 2) + '\n');
  }
} finally { await browser.close(); await fs.writeFile(`${out}/${prefix}-probe.json`, JSON.stringify(report, null, 2) + '\n'); }
console.log(JSON.stringify({ project: report.project, comparisonInput: report.comparisonInput, visual: report.visual, errors: report.errors }, null, 2));
