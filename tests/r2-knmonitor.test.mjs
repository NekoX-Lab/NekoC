import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { knMonitorAppearance, knListGeometry } from '../web/overlay.js';
import { loadPlaywright } from '../tools/probe-kitten4.mjs';
import { measureWidgets } from '../tools/compat/r2-knmonitor-oracle.mjs';

test('KN oracle exports a self-contained browser measurement without live network at import', () => {
  assert.equal(typeof measureWidgets, 'function');
  assert.ok(measureWidgets.toString().includes('getComputedStyle'));
});

test('KN saved scale, text style and actor label follow the official DOM contract', () => {
  const project = { variables: { variablesDict: {
    fps: { position: { x: 0, y: 436.494 }, scale: 1.5, offset: { x: 87, y: 43 }, currentEntityId: 'actor' },
    text: { scale: 2, style: 'text' }, bad: { scale: 'NaN' }, zero: { scale: 0 }, negative: { scale: -3 },
    scene: { currentEntityId: 'scene' },
  } }, actors: { actorsDict: { actor: { name: '角色' } } }, scenes: { scenesDict: { scene: { screenName: '场景' } } } };
  const fps = knMonitorAppearance(project, 'fps');
  assert.deepEqual(fps.position, { x: 0, y: 436.494 });
  assert.ok(Math.abs(fps.scale - 1.2) < 1e-12);
  assert.equal(fps.entity, '角色');
  assert.equal(knMonitorAppearance(project, 'scene').entity, '场景');
  assert.equal(knMonitorAppearance(project, 'text').scale, 1.6);
  assert.equal(knMonitorAppearance(project, 'text').style, 'text');
  for (const id of ['bad', 'zero', 'negative', 'absent']) assert.equal(knMonitorAppearance(project, id).scale, .8);
  assert.equal(knMonitorAppearance(null, 'none').scale, .8);
});

test('KN expanded list fits horizontal and portrait stages independently of monitor scale', () => {
  const horizontal = knListGeometry(900, 562), portrait = knListGeometry(562, 900);
  assert.ok(Math.abs(horizontal.scale - 445.8 / 431) < 1e-12);
  assert.equal(horizontal.top, 58.1);
  assert.equal(horizontal.closeTop, 48.1);
  assert.ok(Math.abs(portrait.scale - 405.8 / 308) < 1e-12);
  assert.equal(portrait.top, 105);
  assert.equal(portrait.closeTop, 95);
});

test('KN real DOM geometry, exact rows, virtual scrolling, updates, input isolation and K4 separation', {
  skip: !process.env.KN_MONITOR_INTEGRATION, timeout: 120000,
}, async () => {
  const source = await readFile('web/overlay.js', 'utf8');
  const playerCss = await readFile('web/play.css', 'utf8');
  const browser = await loadPlaywright().chromium.launch({ headless: true, channel: 'msedge' });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    await page.setContent(`<style>${playerCss}\nbody{margin:0}#box{position:relative;width:900px;height:562px}</style><div id="box"></div>`);
    await page.evaluate(async source => {
      const { StageOverlay } = await import('data:text/javascript;base64,' + btoa(unescape(encodeURIComponent(source))));
      const renderer = { width: 900, height: 562, kitten4: false, sprites: [], images: new Map(), async load() {} };
      const box = document.getElementById('box');
      window.leaks = [];
      for (const event of ['pointerdown','pointerup','mousedown','mouseup','keydown','keyup','click','wheel']) box.addEventListener(event, e => window.leaks.push(e.type));
      window.overlay = new StageOverlay(box, renderer, () => {});
      window.project = { variables: { variablesDict: {
        fps: { position: { x: 0, y: 436 }, scale: 1 },
        list: { position: { x: 20, y: 20 }, scale: 1.5, createTime: 1 },
        empty: { position: { x: 20, y: 90 }, scale: 1, createTime: 2 },
        text: { position: { x: 400, y: 200 }, scale: 2, style: 'text' },
      } } };
      await renderer.load(window.project);
      window.frame = { monitors: [
        { id: 'fps', name: 'FPS', value: '192', list: false },
        { id: 'list', name: '物品栏', value: 'legacy', list: true },
        { id: 'empty', name: '空', value: '', list: true },
        { id: 'text', name: '隐藏名字', value: '<img onerror=alert(1)>', list: false },
      ], monitor_lists: { list: ['', 'one\ntwo', ...Array.from({ length: 150 }, (_, i) => `row ${i}`)], empty: [] } };
      overlay.apply(frame);
    }, source);
    const geometry = await page.evaluate(() => {
      const rect = id => { const r = document.querySelector(`[data-variable=${id}]`).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
      return { fps: rect('fps'), list: rect('list'), text: rect('text'), color: getComputedStyle(document.querySelector('.neko-kn-variable')).backgroundColor,
        safe: !document.querySelector('.neko-kn-text img'), text: document.querySelector('.neko-kn-text').textContent };
    });
    assert.equal(geometry.fps.x, 0); assert.equal(geometry.fps.y, 436);
    assert.ok(Math.abs(geometry.fps.height - 51.2) < .05);
    assert.ok(Math.abs(geometry.list.height - 76.8) < .05);
    assert.ok(Math.abs(geometry.list.width - 170.4) < .05, 'player button gap must not leak into the KN capsule');
    assert.equal(geometry.list.x, 20); assert.equal(geometry.list.y, 20);
    assert.equal(geometry.color, 'rgb(255, 161, 97)');
    assert.ok(geometry.safe); assert.equal(geometry.text, '<img onerror=alert(1)>');
    await page.locator('[data-variable=list] button').hover();
    assert.equal(await page.locator('[data-variable=list] button').evaluate(e => getComputedStyle(e).backgroundColor), 'rgba(0, 0, 0, 0.2)');
    await page.locator('[data-variable=list] button').click();
    const first = await page.locator('.neko-kn-list-value').allTextContents();
    assert.deepEqual(first.slice(0, 2), ['', 'one\ntwo']);
    assert.ok(first.length < 30, 'only visible rows plus overscan are mounted');
    await page.evaluate(() => { const s = document.querySelector('.neko-kn-list-scroll'); s.scrollTop = 110 * 44; s.dispatchEvent(new Event('scroll')); });
    const updated = await page.evaluate(() => {
      const panel = overlay.knListPanel, scroll = panel.querySelector('.neko-kn-list-scroll'), top = scroll.scrollTop;
      frame.monitors[0].value = '193'; frame.monitor_lists.list[112] = '<b>updated\nitem</b>';
      overlay.apply(frame);
      return { samePanel: panel === overlay.knListPanel, sameScroll: scroll === overlay.knListPanel.querySelector('.neko-kn-list-scroll'), top, nextTop: scroll.scrollTop,
        values: [...panel.querySelectorAll('.neko-kn-list-value')].map(e => e.textContent), html: !!panel.querySelector('.neko-kn-list-value b'), count: panel.querySelector('[aria-setsize]').getAttribute('aria-setsize') };
    });
    assert.ok(updated.samePanel && updated.sameScroll); assert.equal(updated.top, updated.nextTop);
    assert.ok(updated.values.includes('<b>updated\nitem</b>')); assert.equal(updated.html, false); assert.equal(updated.count, '152');
    await page.locator('.neko-kn-list-next').click();
    assert.equal(await page.locator('.neko-kn-list-row').count(), 0);
    await page.evaluate(() => { frame.monitor_lists.empty = ['']; overlay.apply(frame); });
    assert.equal(await page.locator('.neko-kn-list-row').count(), 1);
    assert.equal(await page.locator('.neko-kn-list-value').textContent(), '');
    await page.locator('.neko-kn-list-close').click();
    assert.deepEqual(await page.evaluate(() => window.leaks), []);
    await page.locator('[data-variable=list] button').click();
    await page.evaluate(() => { frame.monitors = frame.monitors.filter(m => m.id !== 'list'); overlay.apply(frame); });
    assert.equal(await page.locator('.neko-kn-list-panel').count(), 0);
    await page.evaluate(() => { document.getElementById('box').style.width = '450px'; document.getElementById('box').style.height = '281px'; });
    const small = await page.locator('[data-variable=fps]').boundingBox();
    assert.ok(Math.abs(small.height - 25.6) < .05); assert.equal(small.y, 218);
    await page.evaluate(async () => {
      overlay.renderer.kitten4 = true; await overlay.renderer.load({}); overlay.apply({ monitors: [{ id: 'k4', name: 'K4', value: '7', list: false }] });
    });
    assert.equal(await page.locator('.neko-kn-monitor').count(), 0);
    assert.equal(await page.locator('.neko-monitor span').textContent(), '7');
    await page.evaluate(async () => { overlay.renderer.kitten4 = false; await overlay.renderer.load(project); overlay.apply(frame); overlay.reset(); });
    assert.equal(await page.locator('.neko-kn-monitor,.neko-kn-list-panel').count(), 0);
  } finally { await browser.close(); }
});
