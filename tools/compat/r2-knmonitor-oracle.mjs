#!/usr/bin/env node
// Anonymous public player DOM measurements. Downloaded source and screenshots
// stay in ignored dist/. No official artwork or third-party work is vendored.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { loadPlaywright } from '../probe-kitten4.mjs';

export function stylesheetEvidence(url, body) {
  const text = body.toString('utf8');
  const components = ['VariableContent', 'ListWidget', 'StageList'].filter(name => text.includes(name + '_'));
  return { url, sha256: createHash('sha256').update(body).digest('hex'), components };
}

export function measureWidgets() {
  const properties = ['fontFamily','fontSize','fontWeight','color','backgroundColor','border','borderRadius','boxShadow','padding','width','height','transform','transformOrigin','lineHeight'];
  return [...document.querySelectorAll('[class*=VariableContent],[class*=ListWidget],[class*=StageList]')]
    .filter(element => element.getBoundingClientRect().width > 0)
    .map(element => ({ className: element.className, text: element.textContent, rect: element.getBoundingClientRect().toJSON(),
      inline: element.getAttribute('style'), css: Object.fromEntries(properties.map(key => [key, getComputedStyle(element)[key]])) }));
}

export async function main(ids = process.argv.slice(2)) {
  if (ids.includes('--help')) { console.log('Usage: node tools/compat/r2-knmonitor-oracle.mjs [public-work-id ...]'); return; }
  if (!ids.length) ids = ['328708918','333289842','336319534'];
  if (!ids.every(id => /^\d+$/.test(id))) throw Error('Expected numeric public work IDs');
  process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY = '1';
  const out = path.resolve('dist/r2-knmonitor'); await mkdir(out, { recursive: true });
  const source = await readFile('web/overlay.js', 'utf8');
  const browser = await loadPlaywright().chromium.launch({ headless: true, channel: 'msedge' });
  try {
    for (const id of ids) {
      const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 });
      const report = { id, url: `https://kn.codemao.cn/player?type=2&workId=${id}`, errors: [], sources: [], stylesheets: [],
        comparison: 'Isolated monitor DOM on the same blank stage; live official display values fed to NekoC StageOverlay, not a whole-VM equivalence claim.' };
      page.on('pageerror', error => report.errors.push(error.message));
      await page.route(/\.css(?:\?.*)?$/, async route => {
        const response = await route.fetch(), body = await response.body();
        const evidence = stylesheetEvidence(route.request().url(), body);
        if (evidence.components.length) report.stylesheets.push(evidence);
        await route.fulfill({ response, body });
      });
      await page.route(/\/main\.[\w-]+\.js(?:\?.*)?$/, async route => {
        const response = await route.fetch(), body = await response.body(), original = body.toString('utf8');
        const marker = 'var __webpack_exports__=';
        if (!original.includes(marker)) throw Error('Official webpack loader changed');
        report.sources.push({ url: route.request().url(), sha256: createHash('sha256').update(body).digest('hex'),
          variableContentCharOffset: original.indexOf('VariableContent_wrapper'), listWidgetCharOffset: original.indexOf('ListWidget_slideWrapper'),
          variableContentUsesOffset: original.slice(original.indexOf('var bo='), original.indexOf('var bo=') + 8000).includes('.offset') });
        await writeFile(path.join(out, path.basename(new URL(route.request().url()).pathname)), body);
        await route.fulfill({ response, body: original.replace(marker, `window.__knMonitorRequire=__webpack_require__;${marker}`) });
      });
      try {
        await page.goto(report.url, { waitUntil: 'domcontentloaded', timeout: 120000 });
        await page.locator('[class*=CoverMask_start]').waitFor({ state: 'visible', timeout: 120000 });
        await page.locator('[class*=CoverMask_start]').click();
        await page.waitForFunction(() => [...document.querySelectorAll('[class*=VariableContent_wrapper]')].some(e => e.getBoundingClientRect().width > 0), null, { timeout: 90000 });
        await page.waitForTimeout(1000);
        await page.locator('#PLAYER_STAGE_CONTAINER').screenshot({ path: path.join(out, `work-${id}.png`), timeout: 90000 });
        report.widgets = await page.evaluate(measureWidgets);
        report.display = await page.evaluate(() => {
          const req = window.__knMonitorRequire;
          const bcmId = Object.entries(req.m).find(([, f]) => f.toString().includes('BcmInstance:function'))?.[0];
          const theatreId = Object.entries(req.m).find(([, f]) => f.toString().includes('setStageVariableProperty') && f.toString().includes('getStageVariableList') && f.toString().includes('variableBorder'))?.[0];
          const bcm = req(bcmId).BcmInstance;
          let store;
          if (theatreId) store = Object.values(req(theatreId)).find(e => typeof e?.getStageVariableList === 'function');
          if (!store) throw Error('TheatreStore export changed');
          window.__knMonitorStore = store;
          const variables = store.getStageVariableList().filter(v => v.visible);
          const named = dict => Object.fromEntries(Object.entries(dict || {}).map(([key, value]) => [key, { name: value.name, screenName: value.screenName }]));
          return { stage: bcm.stageSize, project: { variables: { variablesDict: Object.fromEntries(variables.map(v => [v.id, JSON.parse(JSON.stringify(v))])) },
            actors: { actorsDict: named(bcm.actorsDict) }, scenes: { scenesDict: named(bcm.scenesDict) } },
            frame: { monitors: variables.map(v => ({ id: v.id, name: v.name, list: Array.isArray(v.value), value: String(v.value) })),
              monitor_lists: Object.fromEntries(variables.filter(v => Array.isArray(v.value)).map(v => [v.id, v.value.map(String)])) } };
        });
        // Freeze monitor values for deterministic comparison without modifying a
        // project, publishing a work, or replacing any official component.
        await page.evaluate(() => {
          const store = window.__knMonitorStore;
          const update = store.setStageVariableProperty;
          window.__knMonitorUpdate = update;
          store.setStageVariableProperty = patch => { const { value, ...display } = patch; update.call(store, display); };
          const canvas = document.getElementById('STAGE_CANVAS'); canvas.style.visibility = 'hidden';
          document.getElementById('PLAYER_STAGE_CONTAINER').style.background = '#fff';
        });
        // Re-read after the final in-flight official frame and retain its exact values.
        report.display.frame = await page.evaluate(() => {
          const variables = window.__knMonitorStore.getStageVariableList().filter(v => v.visible);
          return { monitors: variables.map(v => ({ id: v.id, name: v.name, list: Array.isArray(v.value), value: String(v.value) })),
            monitor_lists: Object.fromEntries(variables.filter(v => Array.isArray(v.value)).map(v => [v.id, v.value.map(String)])) };
        });
        report.fieldProbe = await page.evaluate(async id => {
          const store = window.__knMonitorStore;
          const saved = store.getStageVariableList().find(v => v.id === id);
          const element = [...document.querySelectorAll('[class*=VariableContent_wrapper]')].find(e => e.getBoundingClientRect().width > 0);
          const snapshot = () => ({ rect: element.getBoundingClientRect().toJSON(), transform: getComputedStyle(element).transform });
          const change = async patch => { store.setStageVariableProperty({ id, ...patch }); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); return snapshot(); };
          const scale = saved.scale, offset = saved.offset;
          const before = snapshot(), offsetOnly = await change({ offset: { x: 87, y: 43 } }), scaled = await change({ scale: 1.5 });
          await change({ scale, offset }); return { before, offsetOnly, scaled };
        }, report.display.frame.monitors[0].id);
        report.widgets = await page.evaluate(measureWidgets);
        const stage = page.locator('#PLAYER_STAGE_CONTAINER');
        await stage.screenshot({ path: path.join(out, `official-${id}-closed.png`), timeout: 90000 });
        const listButton = page.locator('[class*=VariableContent_listComponent]').filter({ visible: true }).first();
        const hasList = await listButton.count();
        if (hasList) {
          await listButton.click(); await page.waitForTimeout(350);
          report.opened = await page.evaluate(measureWidgets);
          await stage.screenshot({ path: path.join(out, `official-${id}-open.png`), timeout: 90000 });
          report.rowFormatProbe = await page.evaluate(async () => {
            const format = window.__knMonitorRequire(45578).Qz;
            const values = [null, [], ['x','y'], [[1],2], ['',null], undefined, [null,undefined], true, { x: 1 }];
            const store = window.__knMonitorStore, list = store.getStageVariableList().find(v => v.visible && Array.isArray(v.value));
            const saved = list.value, update = window.__knMonitorUpdate;
            const wait = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            // Bypass only our value-freezing wrapper for this in-memory probe;
            // restore before the same-value NekoC comparison. Never save/publish.
            update.call(store, { id: list.id, value: values });
            try {
              await wait();
              return { formatted: values.map(value => format(value)),
                dom: [...document.querySelectorAll('[class*=ListWidget_listValue]')].map(e => e.textContent) };
            } finally { update.call(store, { id: list.id, value: saved }); await wait(); }
          });
        }
        await page.evaluate(async ({ source, display }) => {
          const { StageOverlay } = await import('data:text/javascript;base64,' + btoa(unescape(encodeURIComponent(source))));
          const widget = document.getElementById('STAGE_WIDGET');
          for (const child of widget.children) child.style.visibility = 'hidden';
          const box = document.createElement('div'); box.style.cssText = 'position:absolute;inset:0'; widget.append(box);
          const renderer = { width: display.stage.width, height: display.stage.height, kitten4: false, sprites: [], async load() {} };
          window.__localKnOverlay = new StageOverlay(box, renderer, () => {});
          await renderer.load(display.project); window.__localKnOverlay.apply(display.frame);
        }, { source, display: report.display });
        await stage.screenshot({ path: path.join(out, `nekoc-${id}-closed.png`), timeout: 90000 });
        report.local = await page.evaluate(() => [...document.querySelectorAll('.neko-kn-monitor')].map(e => ({ id: e.dataset.variable, rect: e.getBoundingClientRect().toJSON() })));
        const officialRects = report.widgets.filter(w => w.className.includes('VariableContent_wrapper')).map(w => w.rect);
        report.maxMonitorRectDifference = Math.max(0, ...report.local.flatMap((local, index) =>
          ['x','y','width','height'].map(key => Math.abs(local.rect[key] - (officialRects[index]?.[key] ?? Infinity)))));
        if (hasList) {
          await page.locator('.neko-kn-list-button').first().click();
          await stage.screenshot({ path: path.join(out, `nekoc-${id}-open.png`), timeout: 90000 });
        }
        const modes = hasList ? ['closed','open'] : ['closed'];
        const comparison = await browser.newPage({ viewport: { width: 1200, height: modes.length * 430 } });
        try {
          const images = await Promise.all(modes.flatMap(mode => ['official','nekoc'].map(async side => {
            const bytes = await readFile(path.join(out, `${side}-${id}-${mode}.png`));
            return `<section><h3>${side === 'official' ? 'Official KN' : 'NekoC'} — ${id} / ${mode}</h3><img src="data:image/png;base64,${bytes.toString('base64')}"></section>`;
          })));
          await comparison.setContent(`<style>body{margin:0;background:#e8e8e8;font:14px Arial;display:grid;grid-template-columns:1fr 1fr;gap:8px}section{min-width:0}h3{margin:8px}img{display:block;width:100%;height:auto}</style>${images.join('')}`);
          await comparison.screenshot({ path: path.join(out, `comparison-${id}.png`), fullPage: true });
        } finally { await comparison.close(); }
        console.log(JSON.stringify({ id, errors: report.errors, comparison: `dist/r2-knmonitor/comparison-${id}.png` }));
      } finally { await writeFile(path.join(out, `evidence-${id}.json`), JSON.stringify(report, null, 2) + '\n'); await page.close(); }
    }
  } finally { await browser.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  main().catch(error => { console.error(error); process.exitCode = 1; });
