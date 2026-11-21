import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { StageRenderer } from '../web/renderer.js';
import { loadPlaywright } from '../tools/probe-kitten4.mjs';
import { assertApprovedK4Renderer, mainlineK4Renderer } from './renderer-evidence.mjs';

const TEXT_BYTES = 16 * 1024 * 1024;

test('r4-memory historical renderer guard admits reviewed lifetimes but rejects unrelated K4 edits', async () => {
  const current = await readFile('web/renderer.js', 'utf8');
  assertApprovedK4Renderer(current);
  assertApprovedK4Renderer(await mainlineK4Renderer());
  // Keep main's KN-only shader exception, without ignoring other K4 changes.
  assertApprovedK4Renderer(current.replace('const PEN_FRAGMENT = `', 'const PEN_FRAGMENT = `\n// KN shader probe'));
  assert.throws(() => assertApprovedK4Renderer(current + '\n// unrelated K4 edit'), /Renderer changed/);
  assert.throws(() => assertApprovedK4Renderer(current.replace('16 * 1024 * 1024', '32 * 1024 * 1024')), /Renderer changed/);
  assert.throws(() => assertApprovedK4Renderer(current.replace('const PEN_FRAGMENT = `', 'const OTHER_FRAGMENT = `')));
});

// Count live owned GPU objects, not allocations ever made or host GC/RSS. The
// Canvas stub models dimensions and masks; the opt-in test below uses real GL.
function harness() {
  let serial = 0;
  const textures = new Set(), framebuffers = new Set(), events = [];
  const gl = new Proxy({
    MAX_TEXTURE_SIZE: 1, FRAMEBUFFER_COMPLETE: 2,
    getShaderParameter: () => true, getProgramParameter: () => true,
    getExtension: () => null, getParameter: () => 8192,
    checkFramebufferStatus: () => 2,
    createTexture() { const id = ++serial; textures.add(id); return id; },
    deleteTexture(id) { assert.ok(textures.delete(id), `texture ${id} double deleted`); events.push('delete'); },
    createFramebuffer() { const id = ++serial; framebuffers.add(id); return id; },
    deleteFramebuffer(id) { assert.ok(framebuffers.delete(id)); },
    drawArraysInstanced() { events.push('draw'); },
    createShader: () => ++serial, createProgram: () => ++serial,
    createBuffer: () => ++serial, createVertexArray: () => ++serial,
  }, { get: (target, key) => key in target ? target[key] : () => {} });
  const canvas = () => {
    const c = { width: 1, height: 1, style: {}, addEventListener() {} };
    const ctx = new Proxy({
      measureText: text => ({ width: String(text).length * 10 }),
      getImageData: () => ({ data: new Uint8Array(c.width * c.height * 4) }),
    }, { get: (target, key) => key in target ? target[key] : () => {} });
    c.getContext = type => type === 'webgl2' ? gl : ctx;
    return c;
  };
  const previous = globalThis.document;
  globalThis.document = { createElement: canvas };
  const r = new StageRenderer(canvas());
  r.resolutionScale = 1;
  return { r, textures, framebuffers, events, restore() {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  } };
}
function project() {
  return { stageSize: { width: 160, height: 100 },
    scenes: { currentSceneId: 's', scenesDict: { s: { actorIds: [] } } },
    actors: { actorsDict: {} } };
}
const look = (text, size = 500) => ({ text, size, color: '#123456' });

test('r4-memory text looks obey a byte budget, LRU order and flush before disposal', async () => {
  const h = harness(), { r, textures, events } = h;
  try {
    await r.load(project());
    r.textureBatchActive = true;
    const a = look('a'.repeat(50)), b = look('b'.repeat(50));
    const first = r.spriteTextImage(a), second = r.spriteTextImage(b);
    assert.equal(r.spriteTextImage(a), first, 'cache hit refreshes recency');
    // Enqueue the LRU texture, then force byte eviction with a large look.
    r.drawTexture(second.texture, 0, 0, 10, 10);
    events.length = 0;
    r.spriteTextImage(look('c'.repeat(50), 2000));
    assert.equal(events[0], 'draw');
    assert.ok(events.includes('delete'));
    assert.ok(!textures.has(second.texture));
    assert.ok(textures.has(first.texture));
    for (let i = 0; i < 400; i++) {
      r.spriteTextImage(look(String(i).padStart(50, 'x')));
      assert.ok(r.stats.spriteTextBytes <= TEXT_BYTES);
      assert.equal(r.stats.spriteTextBytes, [...r.spriteTexts.values()].reduce((n, item) => n + item.bytes, 0));
      assert.equal(textures.size, r.spriteTexts.size + 1, 'only cache textures and persistent pen FBO');
    }
    // An oversize look retains its original size/mask but evicts everything
    // else. Following it with a small look releases the exceptional allocation.
    const huge = look('z'.repeat(100), 2000), item = r.spriteTextImage(huge);
    assert.deepEqual([item.width, item.height, item.alpha.length], [1000, 2500, 1000 * 2500]);
    assert.equal(r.spriteTexts.size, 1);
    assert.ok(r.stats.spriteTextBytes > TEXT_BYTES);
    assert.equal(r.spriteTextImage(huge), item);
    r.spriteTextImage(look('small', 20));
    assert.ok(!textures.has(item.texture));
    await r.load(project());
    assert.equal(r.spriteTexts.size, 0);
    assert.equal(r.stats.spriteTextBytes, 0);
    assert.equal(textures.size, 1);
    // A high-cardinality run of tiny looks still honors the entry cap, even
    // when the byte budget would admit more. Hits must not change accounting.
    for (let i = 0; i < 1000; i++) r.spriteTextImage(look(String(i), 1));
    assert.equal(r.spriteTexts.size, 256);
    const bytes = r.stats.spriteTextBytes, tiny = r.spriteTextImage(look('999', 1));
    assert.equal(r.spriteTextImage(look('999', 1)), tiny);
    assert.equal(r.stats.spriteTextBytes, bytes);
  } finally { h.restore(); }
});

test('r4-memory 10000 clone/pen frames retain no deleted sprites or drawing history', async () => {
  const h = harness(), { r, textures, framebuffers } = h;
  try {
    await r.load(project());
    const lines = new Float32Array(9 * 128);
    for (let i = 0; i < 128; i++) lines.set([-5, -5, 5, 5, 2, 1, 0, 0, 1], i * 9);
    for (let i = 0; i < 10_000; i++) {
      const id = `clone#${i}`;
      const image = r.spriteTextImage(look(String(i), 20));
      assert.ok(image.alpha.length > 0);
      r.apply({ sprites: [{ id, visible: false }], order: [id] }, lines, false);
      r.apply({ sprites: [], order: [], removed: [id] }, new Float32Array(), false);
      assert.equal(r.sprites.length, 0);
      assert.equal(r.spriteIndices.size, 0);
      assert.equal(r.actorOrder.length, 0);
      assert.equal(r.surfaces.size, 1);
      assert.equal(framebuffers.size, 1);
      assert.ok(r.spriteTexts.size <= 256);
      assert.equal(textures.size, r.spriteTexts.size + 1);
      assert.ok(r.stats.spriteTextBytes <= TEXT_BYTES);
      assert.equal(r.bufferCapacity, 8192);
      assert.equal(r.k4PenLines, null, 'packed frame buffer is not retained');
      assert.equal(r.stats.framebufferBytes, 160 * 100 * 4);
    }
  } finally { h.restore(); }
});

test('r4-memory packed pen views are released on apply failure and never retained on early exits', async () => {
  const h = harness(), { r } = h;
  try {
    await r.load(project());
    const backing = new ArrayBuffer(1024 * 1024), lines = new Float32Array(backing, 0, 9);
    const drawLines = r.drawLines;
    r.drawLines = () => { assert.equal(r.k4PenLines, lines); throw Error('draw failed'); };
    assert.throws(() => r.apply({ sprites: [] }, lines), /draw failed/);
    assert.equal(r.k4PenLines, null);
    r.drawLines = drawLines;
    assert.throws(() => r.apply({ sprites: [] }, new Float32Array(1)), /画笔/);
    assert.equal(r.k4PenLines, null);
    r.lost = true;
    r.apply({ sprites: [] }, lines);
    assert.equal(r.k4PenLines, null);
  } finally { h.restore(); }
});

// Real browser allocation accounting plus pixels. Keep this opt-in, since
// default CI does not install Playwright/Chromium. Never assert heap or time.
test('r4-memory browser churn preserves pen pixels and releases cached text textures on reload', {
  skip: !process.env.NEKOC_R4_MEMORY_BROWSER,
}, async () => {
  const sources = Object.fromEntries(await Promise.all(['renderer.js', 'pen-k4.js'].map(async name =>
    ['/' + name, await readFile('web/' + name, 'utf8')])));
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', sources[req.url] ? 'application/javascript' : 'text/html');
    res.end(sources[req.url] ?? '<!doctype html><canvas></canvas>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await loadPlaywright().chromium.launch({ headless: true,
      ...(process.env.NEKOC_BROWSER_CHANNEL ? { channel: process.env.NEKOC_BROWSER_CHANNEL } : {}),
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const result = await page.evaluate(async () => {
      const { StageRenderer } = await import('/renderer.js');
      const r = new StageRenderer(document.querySelector('canvas'));
      r.resolutionScale = 1;
      const textures = new Set(), fbos = new Set(), gl = r.gl;
      for (const [type, live] of [['Texture', textures], ['Framebuffer', fbos]]) {
        const create = gl['create' + type].bind(gl), dispose = gl['delete' + type].bind(gl);
        gl['create' + type] = () => { const resource = create(); live.add(resource); return resource; };
        gl['delete' + type] = resource => { if (!live.delete(resource)) throw Error('double disposal'); dispose(resource); };
      }
      const p = { stageSize: { width: 160, height: 100 },
        scenes: { currentSceneId: 's', scenesDict: { s: { actorIds: [] } } }, actors: { actorsDict: {} } };
      const empty = new Float32Array(), lines = new Float32Array(9 * 64);
      for (let i = 0; i < 64; i++) lines.set([-20, 0, 20, 0, 6, 1, 0, 0, 1], i * 9);
      let peakBytes = 0, peakTextures = 0;
      for (const k4 of [false, true]) {
        await r.load(k4 ? { ...p, _nekocKitten4: {} } : p);
        for (let i = 0; i < 2000; i++) {
          const id = `clone#${i}`;
          r.apply({ sprites: [{ id, x: 50, y: 35, scale: 100, direction: 0, visible: true, opacity: 1,
            text: { text: String(i).padStart(40, 'x'), size: 80, color: '#123456' } }], order: [id] }, lines);
          r.apply({ sprites: [], order: [], removed: [id] }, empty);
          if (r.sprites.length || r.spriteIndices.size || r.actorOrder.length || r.surfaces.size !== 1 || fbos.size !== 1) throw Error('retained clone or surface');
          if (r.stats.spriteTextBytes > 16 * 1024 * 1024 || textures.size > r.spriteTexts.size + 2) throw Error('unbounded textures');
          peakBytes = Math.max(peakBytes, r.stats.spriteTextBytes);
          peakTextures = Math.max(peakTextures, textures.size);
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, r.framebuffer);
        const pixel = new Uint8Array(4);
        gl.readPixels(80, 50, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        if (String(pixel) !== '255,0,0,255') throw Error(`pen pixels changed: ${pixel}`);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      }
      await r.load(p);
      const result = { peakBytes, peakTextures, textures: textures.size, fbos: fbos.size,
        textBytes: r.stats.spriteTextBytes, error: gl.getError() };
      gl.getExtension('WEBGL_lose_context').loseContext();
      return result;
    });
    assert.ok(result.peakBytes > 0 && result.peakBytes <= TEXT_BYTES);
    assert.ok(result.peakTextures > 1);
    // K4 brush owns one reusable scratch texture as well as the pen surface.
    assert.equal(result.textures, 2);
    assert.equal(result.fbos, 1);
    assert.equal(result.textBytes, 0);
    assert.equal(result.error, 0);
    console.log('r4-memory browser', JSON.stringify(result));
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
});
