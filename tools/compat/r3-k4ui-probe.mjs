#!/usr/bin/env node
// Original probes only. Official code/screenshots stay outside tracked files.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { overlayFixtures } from './k4-visual-overlay-fixtures.mjs';
import { workspace } from './k4-scheduling-fixtures.mjs';
import { runOracle, readJson, saveJson } from './k4-oracle.mjs';
import { pixelDifference } from './k4-visual.mjs';

const output = 'dist/r3-k4ui';
const captureFrames = [1, 40];
const b = (id, type, fields = {}, inputs = {}) => ({ id, type, fields, inputs, statements: {} });
const text = value => b('', 'text', { TEXT: value });

async function prepareLocal(page) {
  for (const [url, file, contentType] of [
    ['overlay.js', 'web/overlay.js', 'text/javascript'],
    ['input.js', 'web/input.js', 'text/javascript'],
    ['play.css', 'web/play.css', 'text/css'],
  ]) {
    const body = await readFile(file, 'utf8');
    await page.route(`**/r3-k4ui/${url}`, route => route.fulfill({ contentType, body }));
  }
  await page.route('**/r3-k4ui', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><link rel="stylesheet" href="/r3-k4ui/play.css"><style>html,body{margin:0}</style><div id="stage-box" class="loaded"><canvas id="stage" tabindex="0"></canvas></div>' }));
}

async function mountLocal(page, options) {
  await page.evaluate(async ({ width, height, sourceAsk, visible = false, scale = 1 }) => {
    const { StageOverlay } = await import('/r3-k4ui/overlay.js');
    const { StageInput } = await import('/r3-k4ui/input.js');
    const box = document.getElementById('stage-box'), canvas = document.getElementById('stage');
    box.style.width = `${width * scale}px`; box.style.height = `${height * scale}px`;
    canvas.width = width; canvas.height = height;
    window.answers = []; window.leaks = [];
    const renderer = { canvas, width, height, kitten4: true, sprites: [{ id: 'actor', visible }], hitTest: () => null };
    window.input = new StageInput(canvas, renderer, () => true);
    canvas.addEventListener('gotpointercapture', event => { window.capturedPointerId = event.pointerId; });
    window.overlay = new StageOverlay(box, renderer, event => {
      const accepted = window.input.push(event);
      if (accepted) window.answers.push(event);
      return accepted;
    });
    for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'keydown', 'keyup', 'click']) box.addEventListener(type, () => window.leaks.push(type));
    // Compare pointer-mode widgets, not the browser's keyboard focus ring.
    window.overlay.focusControl = () => {};
    window.ask = sourceAsk;
  }, options);
}

export async function choiceFixtures() {
  const base = (await overlayFixtures()).choice;
  const schema = (await readJson('docs/kitten4-block-schema.json')).blocks;
  return ['landscape', 'portrait', 'visible', 'no-question'].map(name => {
    const project = structuredClone(base), actor = Object.values(project.theatre.actors)[0];
    project.project_name = `NekoC r3-k4ui ${name}`;
    project.size = name === 'portrait' ? { width: 620, height: 900 } : { width: 1280, height: 720 };
    actor.visible = name === 'visible';
    const question = name === 'no-question' ? '' : 'NekoC 原创问题';
    const choices = ['12345678901234567890!', '', '  third  '];
    const start = b('start', 'start_on_click');
    start.next = b('choice', 'ask_and_choose', {}, { question: text(question), ...Object.fromEntries(choices.map((value, i) => [`CHOICE${i}`, text(value)])) });
    actor.block_data_json = workspace([start], schema);
    return { name, project, question, choices };
  });
}

export async function recordChoices() {
  await mkdir(output, { recursive: true });
  const evidence = { source: 'offline player .orig; original editable fixtures; controlled updates; no network assets', cases: [] };
  for (const { name, project, choices, question } of await choiceFixtures()) {
    const dir = path.join(output, name); await mkdir(dir, { recursive: true });
    const frames = []; let localPage, interaction;
    const trace = await runOracle(project, {
      frames: 40, seed: 1, virtualTime: true, wallTimeoutMs: 120000,
      beforeStart: async page => {
        localPage = await page.context().newPage();
        await prepareLocal(localPage);
        await localPage.goto(new URL('/r3-k4ui', page.url()).href);
      },
      onFrame: async (page, frame) => {
        const sample = await page.evaluate(capture => {
          const stage = window.__k4OracleRequire('a1xw').a(), app = stage.core.app.get_app();
          const d = stage.core.components.get_selection_dialog();
          const buttons = d.selection_container.children.filter(child => child.visible).map(child => {
            const at = child.toGlobal({ x: 0, y: 0 });
            return { x: at.x, y: at.y, width: d.selection_width, height: d.selection_height };
          });
          const state = { width: app.view.width, height: app.view.height, buttons,
            labels: d.selection_container.children.filter(child => child.visible).map(child => child.children[2].text),
            header: d.selection_header.visible, distance: d.distance };
          if (capture) {
            const canvas = document.createElement('canvas'); canvas.width = app.view.width; canvas.height = app.view.height;
            const ctx = canvas.getContext('2d');
            const snap = () => { app.renderer.render(app.stage); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(app.view, 0, 0); return canvas.toDataURL().split(',')[1]; };
            state.png = snap(); d.visible = false; state.base = snap(); d.visible = true;
          }
          return state;
        }, captureFrames.includes(frame));
        if (frame === 1) {
          await localPage.setViewportSize({ width: sample.width, height: sample.height });
          await mountLocal(localPage, { width: sample.width, height: sample.height, visible: name === 'visible', sourceAsk: { id: 1, sprite: 'actor', question, choices } });
        }
        await localPage.evaluate(() => window.overlay.apply({ ask: window.ask }));
        if (!captureFrames.includes(frame)) return;
        const local = await localPage.evaluate(async base => {
          const image = new Image(); image.src = 'data:image/png;base64,' + base; await image.decode();
          document.getElementById('stage').getContext('2d').drawImage(image, 0, 0); await document.fonts.ready;
          const buttons = [...window.overlay.ask.querySelectorAll('button')];
          return { buttons: buttons.map(button => { const r = button.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }),
            labels: buttons.map(button => button.textContent), header: getComputedStyle(window.overlay.ask.querySelector('p')).display !== 'none' };
        }, sample.base);
        const png = await localPage.locator('#stage-box').screenshot({ animations: 'disabled', caret: 'hide', scale: 'css' });
        await writeFile(path.join(dir, `${frame}-official.png`), Buffer.from(sample.png, 'base64'));
        await writeFile(path.join(dir, `${frame}-nekoc.png`), png);
        const rgba = await localPage.evaluate(async images => Promise.all(images.map(async png => {
          const image = new Image(); image.src = 'data:image/png;base64,' + png; await image.decode();
          const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
          const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0); const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
          let bytes = ''; for (let i = 0; i < data.length; i += 8192) bytes += String.fromCharCode(...data.subarray(i, i + 8192)); return btoa(bytes);
        })), [sample.png, png.toString('base64')]);
        delete sample.png; delete sample.base;
        frames.push({ frame, official: sample, local, pixels: pixelDifference(...rgba.map(value => Buffer.from(value, 'base64')), 8) });
        if (frame !== 40) return;
        const at = await page.evaluate(() => {
          const stage = window.__k4OracleRequire('a1xw').a(), app = stage.core.app.get_app(), d = stage.core.components.get_selection_dialog();
          const callback = d.on_complete_cb;
          d.on_complete_cb = index => { window.selected = index; callback(index); };
          const child = d.selection_container.children.filter(child => child.visible).at(-1), rect = app.view.getBoundingClientRect();
          const center = child.toGlobal({ x: d.selection_width / 2, y: d.selection_height / 2 });
          return { x: rect.x + center.x * rect.width / app.view.width, y: rect.y + center.y * rect.height / app.view.height };
        });
        // Official PIXI selects on release even if the press began elsewhere.
        await page.mouse.move(20, 20); await page.mouse.down(); await page.mouse.move(at.x, at.y);
        const fill = await page.evaluate(() => window.__k4OracleRequire('a1xw').a().core.components.get_selection_dialog().selection_container.children.filter(child => child.visible).at(-1).children[2].style.fill);
        await page.mouse.up();
        const index = await page.evaluate(() => window.selected);
        await localPage.bringToFront();
        const target = await localPage.locator('.choices button').last().boundingBox();
        await localPage.mouse.move(20, 20); await localPage.mouse.down();
        await localPage.evaluate(() => { window.leaks = []; document.getElementById('stage').blur(); });
        await localPage.mouse.move(target.x + target.width / 2, target.y + target.height / 2);
        await localPage.locator('.choices button').last().evaluate(button => Promise.all(button.getAnimations().map(animation => animation.finished)));
        const hover = await localPage.locator('.choices button').last().evaluate(button => ({ background: getComputedStyle(button).backgroundColor, color: getComputedStyle(button).color }));
        await localPage.mouse.up();
        const localInput = await localPage.evaluate(() => ({ answers: window.answers, leaks: window.leaks, queued: window.input.events, captured: window.input.pointer !== null || (window.capturedPointerId !== undefined && document.getElementById('stage').hasPointerCapture(window.capturedPointerId)) }));
        interaction = { official: { index, fill }, local: { ...hover, ...localInput } };
      },
    });
    evidence.cases.push({ name, choices, frames, interaction, errors: trace.errors, assets: trace.diagnostics.assets,
      externalRequests: trace.diagnostics.externalRequests });
    await saveJson(path.join(dir, 'evidence.json'), evidence.cases.at(-1));
  }
  await saveJson(path.join(output, 'evidence.json'), evidence);
  return evidence;
}

async function gesture(page, name, points, beforeRelease = async () => {}) {
  const first = points[0], third = points[2], background = { x: 20, y: 20 };
  const target = name.endsWith('outside') ? background : third;
  if (name === 'keyboard') {
    await page.locator('.choices button').last().focus(); await page.keyboard.press('Enter');
    return false;
  }
  if (name.startsWith('touch')) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    const start = name === 'touch-tap' ? third : name === 'touch-canvas' ? background : first;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...start, id: 1 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...target, id: 1 }] });
    await beforeRelease();
    const captured = await page.evaluate(() => window.input?.pointer !== null && !!window.input?.pointer);
    await cdp.send('Input.dispatchTouchEvent', { type: name === 'touch-cancel' ? 'touchCancel' : 'touchEnd', touchPoints: [] });
    await cdp.detach();
    return captured;
  }
  const start = name === 'canvas' ? background : name === 'mouse-cross' ? first : third;
  await page.mouse.move(start.x, start.y); await page.mouse.down();
  await page.mouse.move(target.x, target.y); await beforeRelease();
  const captured = await page.evaluate(() => !!window.input?.pointer);
  await page.mouse.up();
  return captured;
}

export async function recordChoiceGestures() {
  await mkdir(output, { recursive: true });
  const fixture = (await choiceFixtures())[0], local = [], official = [];
  const comparisons = ['canvas', 'mouse-cross', 'touch-cross', 'touch-cross-outside', 'touch-canvas'];
  for (const name of comparisons) {
    let selected;
    const trace = await runOracle(fixture.project, {
      frames: 40, seed: 1, virtualTime: true, wallTimeoutMs: 120000,
      onFrame: async (page, frame) => {
        if (frame !== 40) return;
        if (!local.length) {
          for (const config of [
            ...['click', 'keyboard', 'touch-tap', ...comparisons, 'touch-cancel'].map(gesture => ({ name: gesture, gesture })),
            { name: 'scaled-canvas', gesture: 'canvas', scale: .5 },
            { name: 'portrait-touch-cross', gesture: 'touch-cross', width: 620, height: 900 },
            { name: 'rejected-touch', gesture: 'touch-cross', reject: true },
            { name: 'stale-touch', gesture: 'touch-cross', stale: true },
            { name: 'reset-touch', gesture: 'touch-cross', reset: true },
          ]) {
            const testPage = await page.context().newPage();
            try {
              await prepareLocal(testPage); await testPage.goto(new URL('/r3-k4ui', page.url()).href);
              await testPage.setViewportSize({ width: 1280, height: 960 });
              await mountLocal(testPage, { width: config.width || 1280, height: config.height || 720, scale: config.scale || 1, sourceAsk: { id: 1, question: 'release', choices: ['one', 'two', 'three'] } });
              await testPage.evaluate(reject => {
                for (let i = 0; i < 40; i++) window.overlay.apply({ ask: window.ask });
                if (reject) for (let i = 0; i < 256; i++) window.input.push({ kind: 'audio_done', id: i });
              }, !!config.reject);
              const points = await testPage.locator('.choices button').evaluateAll(buttons => buttons.map(b => { const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }));
              const capturedBeforeRelease = await gesture(testPage, config.gesture, points, async () => {
                if (config.stale || config.reset) await testPage.evaluate(reset => {
                  if (reset) window.overlay.reset();
                  else { window.ask = { ...window.ask, id: 2 }; for (let i = 0; i < 40; i++) window.overlay.apply({ ask: window.ask }); }
                }, !!config.reset);
              });
              const result = await testPage.evaluate(() => ({ answers: window.answers.slice(), queued: window.input.events.slice(), open: !!window.overlay.ask, pointer: window.input.pointer, captures: window.capturedPointerId !== undefined && document.getElementById('stage').hasPointerCapture(window.capturedPointerId) }));
              if (config.reject) {
                await testPage.evaluate(() => window.input.take());
                await testPage.locator('.choices button').last().click();
                result.retry = await testPage.evaluate(() => ({ answers: window.answers, open: !!window.overlay.ask }));
              }
              if (config.gesture === 'canvas') {
                await testPage.evaluate(() => window.input.take());
                await testPage.mouse.click(20, 20);
                result.nextStage = await testPage.evaluate(() => window.input.take().events);
              }
              local.push({ ...config, capturedBeforeRelease, ...result });
            } finally { await testPage.close(); }
          }
        }
        const points = await page.evaluate(() => {
          const stage = window.__k4OracleRequire('a1xw').a(), app = stage.core.app.get_app(), d = stage.core.components.get_selection_dialog();
          const callback = d.on_complete_cb; window.selected = [];
          d.on_complete_cb = index => { window.selected.push(index); callback(index); };
          const rect = app.view.getBoundingClientRect();
          return d.selection_container.children.filter(c => c.visible).map(c => { const p = c.toGlobal({ x: d.selection_width / 2, y: d.selection_height / 2 }); return { x: rect.x + p.x * rect.width / app.view.width, y: rect.y + p.y * rect.height / app.view.height }; });
        });
        await gesture(page, name, points);
        selected = await page.evaluate(() => window.selected);
      },
    });
    // The callback is observed within onFrame so no detached/closed page reads.
    official.push({ name, selected, errors: trace.errors, assets: trace.diagnostics.assets, externalRequests: trace.diagnostics.externalRequests });
  }
  const evidence = { local, official };
  await saveJson(path.join(output, 'gestures.json'), evidence);
  return evidence;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  recordChoices().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error); process.exitCode = 1; });
}
