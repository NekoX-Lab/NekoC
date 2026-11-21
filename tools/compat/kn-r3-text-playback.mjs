import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
const base = 'dist/r3-kntext-official';
const hash = s => createHash('sha256').update(s).digest('hex');
let id = 0;
const b = (type, fields = {}, inputs = {}) => ({ id: `r3-text-${++id}`, type, fields, inputs });
const text = s => b('text', { TEXT: s });
const num = s => b('math_number', { NUM: String(s) });
const undef = () => b('_object_get', {}, { obj: b('_object_literal'), key: text('missing') });
const nil = () => b('JSON.parse', {}, { text: text('null') });
const join = (...values) => ({ ...b('text_join', {}, Object.fromEntries(values.map((v, i) => [`ADD${i}`, v]))), mutation: `<mutation items="${values.length}"></mutation>` });
const compare = (OP, A, B) => b('logic_compare', { OP }, { A, B });
const nan = () => b('math_arithmetic', { type: 'divide' }, { A: num(0), B: num(0) });
const cases = {
  nanEq: compare('EQ', nan(), nan()),
  nanNe: compare('NEQ', nan(), nan()),
  unicode: compare('LT', text('😀'), text('\ue000')),
  caseSensitive: compare('EQ', text('A'), text('a')),
  numericText: b('convert_type', { type: 'string' }, { text: num(1e21) }),
  joinStop: join(text('a'), undef(), text('b')),
  joinNested: join(text('a'), join(text('b'), undef()), text('c')),
  joinNull: join(text('a'), nil(), text('b')),
  nullText: b('convert_type', { type: 'string' }, { text: nil() }),
  undefinedContains: b('text_contain', {}, { A: undef(), B: text('') }),
};
const p = JSON.parse(await fs.readFile('samples/kitten-n-0.27.4.bcmkn', 'utf8'));
const actor = Object.values(p.actors.actorsDict)[0], scene = p.scenes.currentSceneId;
p.projectName = 'NekoC KN r3 text boundaries';
p.actors.actorsDict = { [actor.id]: actor };
p.scenes.scenesDict[scene].actorIds = [actor.id];
const blocks = [b('on_running_group_activated'), ...Object.entries(cases).map(([name, value]) => b('variables_set', { variable: name }, { value })), b('variables_set', { variable: 'done' }, { value: num(1) })];
for (let i = 1; i < blocks.length; i++) blocks[i - 1].next = blocks[i];
actor.nekoBlockJsonList = [blocks[0]];
p.variables.variablesDict = Object.fromEntries([...Object.keys(cases), 'done'].map(name => [name, { id: name, name, value: 0, type: 'any', isGlobal: true, currentEntityId: actor.id, visible: false, position: { x: 0, y: 0 } }]));
const source = JSON.stringify(p, null, 2) + '\n';
await fs.writeFile(`${base}/playback.bcmkn`, source);
const require = createRequire(`${process.env.NEKOC_NODE_MODULES}/package.json`);
const { chromium } = require('playwright');
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const report = { checkedAt: new Date().toISOString(), fixtureSha256: hash(source), browserVersion: browser.version(), bundles: [], pageErrors: [] };
try {
  const page = await browser.newPage();
  page.on('pageerror', e => report.pageErrors.push(e.message));
  await page.route(/\/static\/js\/(main|crc_libs)\.[\w-]+\.js(?:\?.*)?$/, async route => {
    const response = await route.fetch(), bytes = await response.body();
    report.bundles.push({ url: route.request().url(), sha256: hash(bytes) });
    const body = route.request().url().includes('/main.') ? bytes.toString().replace('var __webpack_exports__=', 'window.__nekocRequire=__webpack_require__;var __webpack_exports__=') : bytes;
    await route.fulfill({ response, body });
  });
  const url = 'https://kn.codemao.cn/__nekoc_r3_text__.bcmkn';
  await page.route(url, route => route.fulfill({ contentType: 'application/json', body: source }));
  await page.goto(`https://kn.codemao.cn/editor?previewUrl=${encodeURIComponent(url)}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => window.__nekocRequire && document.querySelector('canvas') && (!document.querySelector('#init-loading') || getComputedStyle(document.querySelector('#init-loading')).display === 'none'), null, { timeout: 120000 });
  await page.evaluate(() => {
    const req = window.__nekocRequire, modules = Object.entries(req.m);
    const runtime = modules.find(([, f]) => f.toString().includes('key:"getHeart"'));
    window.__r3Runtime = Object.values(req(runtime[0])).find(v => typeof v?.get_instance === 'function').get_instance();
    window.__r3Bcm = req(modules.find(([, f]) => f.toString().includes('BcmInstance:function'))[0]).BcmInstance;
  });
  await page.waitForFunction(() => window.__r3Bcm.getBcm().projectName === 'NekoC KN r3 text boundaries');
  await page.addStyleTag({ content: '#DialogContainer{display:none!important}' });
  const done = page.getByText(/^完成$/).last();
  if (await done.isVisible()) await done.dispatchEvent('click');
  await page.getByText(/^开始$/).last().dispatchEvent('click');
  await page.waitForFunction(() => window.__r3Runtime.getHeart().core.get_runtime_manager().get_variable('done') === 1, null, { timeout: 15000 });
  report.variables = await page.evaluate(() => {
    const manager = window.__r3Runtime.getHeart().core.get_runtime_manager();
    return Object.fromEntries(Object.entries(window.__r3Bcm.variablesDict).map(([id, v]) => [id, manager.get_variable(id, undefined, v.currentEntityId)]));
  });
} catch (error) { report.error = error.stack; }
finally { await browser.close(); }
report.ok = !report.error && !report.pageErrors.length && report.variables?.done === 1;
await fs.writeFile(`${base}/playback-report.json`, JSON.stringify(report, null, 2) + '\n');
if (process.argv.includes('--record') && report.ok) {
  const editorCompat = JSON.parse(await fs.readFile(`${base}/editor-compat.json`, 'utf8'));
  if (!editorCompat.ok || !editorCompat.projects.some(p => p.ok && p.sha256 === report.fixtureSha256 && !p.issues.length && !p.pageErrors.length))
    throw new Error('Missing or stale editor compatibility check');
  editorCompat.projects = editorCompat.projects.map(p => ({ ...p, input: `${base}/playback.bcmkn` }));
  await fs.writeFile('docs/kn-r3-text-playback.json', JSON.stringify({ ...report, editorCompat }, null, 2) + '\n');
}
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;
