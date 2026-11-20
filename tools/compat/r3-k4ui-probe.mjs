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
  const source = await readFile('web/overlay.js', 'utf8');
  const evidence = { source: 'offline player .orig; original editable fixtures; controlled updates; no network assets', cases: [] };
  for (const { name, project, choices, question } of await choiceFixtures()) {
    const dir = path.join(output, name); await mkdir(dir, { recursive: true });
    const frames = []; let localPage, interaction;
    const trace = await runOracle(project, {
      frames: 40, seed: 1, virtualTime: true, wallTimeoutMs: 120000,
      beforeStart: async page => {
        localPage = await page.context().newPage();
        await localPage.route('**/r3-k4ui.js', route => route.fulfill({ contentType: 'text/javascript', body: source }));
        await localPage.route('**/r3-k4ui', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><style>html,body{margin:0}#box{position:relative;overflow:hidden}#base{display:block;width:100%;height:100%}</style><div id="box"><img id="base"></div>' }));
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
          await localPage.evaluate(async ({ width, height, sourceAsk, visible }) => {
            const { StageOverlay } = await import('/r3-k4ui.js');
            const box = document.getElementById('box'); box.style.width = `${width}px`; box.style.height = `${height}px`;
            document.getElementById('base').draggable = false;
            window.answers = []; window.leaks = [];
            for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'keydown', 'keyup', 'click']) box.addEventListener(type, () => window.leaks.push(type));
            window.overlay = new StageOverlay(box, { width, height, kitten4: true, sprites: [{ id: 'actor', visible }] }, event => window.answers.push(event));
            // Compare pointer-mode widgets, not the browser's keyboard focus ring.
            window.overlay.focusControl = () => {};
            window.ask = sourceAsk;
          }, { width: sample.width, height: sample.height, visible: name === 'visible', sourceAsk: { id: 1, sprite: 'actor', question, choices } });
        }
        await localPage.evaluate(() => window.overlay.apply({ ask: window.ask }));
        if (!captureFrames.includes(frame)) return;
        const local = await localPage.evaluate(async base => {
          const image = document.getElementById('base'); image.src = 'data:image/png;base64,' + base; await image.decode(); await document.fonts.ready;
          const buttons = [...window.overlay.ask.querySelectorAll('button')];
          return { buttons: buttons.map(button => { const r = button.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }),
            labels: buttons.map(button => button.textContent), header: getComputedStyle(window.overlay.ask.querySelector('p')).display !== 'none' };
        }, sample.base);
        const png = await localPage.locator('#box').screenshot({ animations: 'disabled', caret: 'hide', scale: 'css' });
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
        await localPage.evaluate(() => { window.leaks = []; });
        await localPage.mouse.move(target.x + target.width / 2, target.y + target.height / 2);
        const hover = await localPage.locator('.choices button').last().evaluate(button => ({ background: getComputedStyle(button).backgroundColor, color: getComputedStyle(button).color }));
        await localPage.mouse.up();
        const localInput = await localPage.evaluate(() => ({ answers: window.answers, leaks: window.leaks.filter(type => type !== 'click') }));
        // A press that starts on the background can legitimately finish with a
        // background click; release events on the choices themselves must not leak.
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  recordChoices().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error); process.exitCode = 1; });
}
