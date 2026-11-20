#!/usr/bin/env node
// Original probes only. Third-party works and downloaded bundles stay in dist/.
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadPlaywright } from "../probe-kitten4.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const fixtures = path.join(root, "tests/fixtures/kn-r3-sched");
const out = path.join(root, "dist/r3-knsched");
const hash = source => createHash("sha256").update(source).digest("hex");
let serial = 0;
const b = (type, fields = {}, inputs = {}, statements = {}) => ({ id: `r3sched-${++serial}`, type, fields, inputs, statements });
const n = value => b("math_number", { NUM: String(value) });
const text = value => b("text", { TEXT: value });
const get = variable => b("variables_get", { variable });
const set = (variable, value) => b("variables_set", { variable }, { value });
const chain = (...nodes) => { nodes.slice(1).forEach((node, i) => { nodes[i].next = node; }); return nodes[0]; };
const start = (...nodes) => chain(b("on_running_group_activated"), ...nodes);
const log = value => set("trace", { ...b("text_join", {}, { ADD0: get("trace"), ADD1: text(value) }), mutation: '<mutation items="2"></mutation>' });
const wait = time => b("wait", {}, { time: n(time) });
const send = (sync = false) => b(sync ? "self_broadcast_and_wait" : "self_broadcast", {}, { message: text("probe") });
const listen = (...nodes) => b("self_listen", {}, { message: text("probe") }, { DO: chain(...nodes) });
const repeat = (count, ...nodes) => b("repeat_n_times", {}, { times: n(count) }, { DO: chain(...nodes) });

export async function projects() {
  serial = 0;
  const template = JSON.parse(await fs.readFile(path.join(root, "samples/kitten-n-0.27.4.bcmkn"), "utf8"));
  const cases = {
    "wait-zero": [start(log("A"), wait(0), log("a")), start(log("B"), wait(0), log("b"))],
    "wait-negative": [start(log("A"), wait(-1), log("a")), start(log("B"))],
    "wait-positive": [start(log("A"), wait(0.032), log("a"))],
    "wait-until": [start(log("A"), b("wait_until", {}, { condition: b("logic_compare", { OP: "EQ" }, { A: get("ready"), B: n(1) }) }), log("a")), start(log("B"), set("ready", n(1)))],
    "repeat": [start(repeat(3, log("A")), log("a")), start(repeat(3, log("B")), log("b"))],
    "broadcast": [start(log("A"), send(), log("B")), listen(log("R"), wait(0), log("r"))],
    "broadcast-wait": [start(log("A"), send(true), log("B")), listen(log("R"), wait(0), log("r"))],
    "broadcast-empty": [start(log("A"), send(true), log("B"))],
    "broadcast-overlap": [start(send(), send(), log("A")), listen(log("R"), wait(0), log("r"))],
    "clone": [start(log("A"), b("mirror", { sprite: "--self" }), log("B"), wait(0), log("b")), b("start_as_a_mirror", {}, {}, { DO: chain(log("K"), wait(0), log("k")) })],
  };
  return Object.fromEntries(Object.entries(cases).map(([name, scripts]) => {
    const p = structuredClone(template), scene = p.scenes.currentSceneId;
    const actor = Object.keys(p.actors.actorsDict)[0];
    p.projectName = `NekoC r3-knsched ${name}`;
    p.actors.actorsDict = { [actor]: { ...p.actors.actorsDict[actor], nekoBlockJsonList: scripts } };
    p.scenes.scenesDict[scene].actorIds = [actor];
    p.scenes.scenesDict[scene].nekoBlockJsonList = [];
    p.variables.variablesDict = Object.fromEntries(Object.entries({ trace: "", ready: 0 }).map(([id, value]) => [id, {
      id, name: id, value, type: "any", isGlobal: true, currentEntityId: actor, visible: false, position: { x: 0, y: 0 },
    }]));
    return [name, p];
  }));
}

export async function precisionProjects() {
  const base = (await projects())["wait-positive"];
  const cases = {};
  for (const [name, seconds] of Object.entries({ long: 0.032, below: 0.031999999999, above: 0.032000000001, tiny: 1e-12, variable: 0.032, hz60: 0.05, fraction: 0.0002 })) {
    const p = structuredClone(base);
    p.projectName = `NekoC r3-knsched precision ${name}`;
    const actor = Object.values(p.actors.actorsDict)[0];
    actor.nekoBlockJsonList = [start(repeat(400, b("change_variables", { variable: "ready", method: "increase" }, { value: n(1) }), wait(seconds)))];
    cases[name] = p;
  }
  return cases;
}

export async function observe(browser, source, frames = 8, frameMs = 16, nativeClock = false) {
  if (nativeClock && Array.isArray(frameMs)) throw new Error("Native deterministic clock needs a constant frame step");
  const page = await browser.newPage(), result = { sha256: hash(source), pageErrors: [], bundles: [], clockMode: nativeClock ? "native-deterministic" : "controlled" };
  page.on("pageerror", e => result.pageErrors.push(String(e)));
  try {
    await page.route(/\/(main|crc_libs)\.[\w-]+\.js(?:\?.*)?$/, async route => {
      const response = await route.fetch(), body = await response.text();
      result.bundles.push({ url: route.request().url(), sha256: hash(body) });
      await fs.writeFile(path.join(out, path.basename(new URL(route.request().url()).pathname)), body);
      await route.fulfill({ response, body: body.replace("var __webpack_exports__=", "window.__nekocRequire=__webpack_require__;var __webpack_exports__=") });
    });
    const url = "https://kn.codemao.cn/__r3_knsched__.bcmkn";
    await page.route(url, route => route.fulfill({ contentType: "application/json", body: source }));
    await page.goto(`https://kn.codemao.cn/editor?previewUrl=${encodeURIComponent(url)}`, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForFunction(() => window.__nekocRequire && document.querySelector("canvas") &&
      (!document.querySelector("#init-loading") || getComputedStyle(document.querySelector("#init-loading")).display === "none"), null, { timeout: 120000 });
    await page.evaluate(() => {
      const req = window.__nekocRequire;
      let bcm, runtime;
      for (const [id, factory] of Object.entries(req.m)) {
        const source = factory.toString();
        if (source.includes("BcmInstance:function")) bcm = req(id).BcmInstance;
        if (source.includes('key:"getHeart"') && source.includes('key:"initRuntime"'))
          runtime = Object.values(req(id)).find(v => typeof v?.get_instance === "function" && typeof v?.initRuntime === "function");
      }
      if (!bcm || !runtime) throw new Error("Official BCM/runtime exports unavailable");
      window.__r3Handles = { bcm, runtime };
    });
    await page.waitForFunction(name => window.__r3Handles.bcm.getBcm().projectName === name, JSON.parse(source).projectName);
    await page.addStyleTag({ content: "#DialogContainer{display:none!important}" });
    const complete = page.getByText(/^完成$/).last();
    if (await complete.isVisible()) await complete.dispatchEvent("click");
    await page.evaluate(({ limit, frameMs, nativeClock }) => {
      const { bcm, runtime } = window.__r3Handles, core = runtime.get_instance().getHeart().core;
      const manager = core.get_runtime_manager().run_mgr, update = manager.update;
      const trace = window.__r3Sched = { frames: [], runtimeErrors: [] };
      core.get_event_bus().error.runtime.immediate.sub(e => trace.runtimeErrors.push(String(e?.error?.message || e?.error || e)));
      // Supply logical time, not a scheduler or wait implementation. Native mode
      // retains ClockImpl.now/update and its ordinary += ms_per_update path.
      const NativeDate = Date;
      let now = 0;
      if (nativeClock) {
        manager.clock.ms_per_update = frameMs;
        manager.clock.wall_clock_now = () => performance.now();
      } else {
        manager.clock.now = () => now;
        manager.clock.update = () => {};
      }
      manager.update = function(...args) {
        if (trace.frames.length >= limit) return;
        if (trace.frames.length) now += Array.isArray(frameMs) ? frameMs[(trace.frames.length - 1) % frameMs.length] : frameMs;
        if (!trace.frames.length) manager.timer_block_date = 946684800000;
        window.Date = class extends NativeDate {
          constructor(...a) { super(...(a.length ? a : [946684800000 + now])); }
          static now() { return 946684800000 + now; }
        };
        try {
          if (nativeClock && !trace.frames.length) manager.clock.current_time = -frameMs;
          const result = update.apply(this, args);
          if (core.get_runtime_data().is_running()) trace.frames.push({
            variables: Object.fromEntries(Object.entries(bcm.variablesDict).map(([id, v]) => [id, manager.get_variable(id, undefined, v.currentEntityId)])),
            elapsedFrames: manager.get_elapsed_frames(),
          });
          return result;
        } finally { window.Date = NativeDate; }
      };
    }, { limit: frames, frameMs, nativeClock });
    await page.getByText(/^开始$/).last().dispatchEvent("click");
    await page.waitForFunction(limit => window.__r3Sched.frames.length >= limit || window.__r3Sched.runtimeErrors.length, frames, { timeout: 30000 });
    Object.assign(result, await page.evaluate(() => window.__r3Sched));
    result.ok = result.frames.length === frames && !result.pageErrors.length && !result.runtimeErrors.length;
  } catch (error) { result.error = String(error); result.ok = false; }
  finally { await page.close(); }
  return result;
}

async function main() {
  await fs.mkdir(out, { recursive: true });
  if (process.argv.includes("--precision")) {
    const dir = path.join(fixtures, "precision");
    await fs.mkdir(dir, { recursive: true });
    const cases = await precisionProjects();
    if (process.argv.includes("--archive")) {
      const report = JSON.parse(await fs.readFile(path.join(out, "precision-official.json"), "utf8"));
      const editor = JSON.parse(await fs.readFile(path.join(out, "precision-editor.json"), "utf8"));
      if (!report.ok || !editor.ok || Object.keys(report.cases).length !== Object.keys(cases).length || editor.projects.length !== Object.keys(cases).length)
        throw new Error("Incomplete precision evidence");
      for (const name of Object.keys(cases)) {
        const bytes = await fs.readFile(path.join(dir, `${name}.bcmkn`));
        const c = report.cases[name];
        const checked = editor.projects.find(p => path.basename(p.input) === `${name}.bcmkn`);
        if (!c?.ok || c.sha256 !== hash(bytes) || c.frames.length !== 1200 || c.pageErrors.length || c.runtimeErrors.length ||
            !checked?.ok || checked.sha256 !== c.sha256 || checked.issues.length || checked.pageErrors.length ||
            c.frames.some((f, i) => f.elapsedFrames !== i + 1 || f.variables.trace !== "")) throw new Error(`Unpaired precision evidence: ${name}`);
        c.ready = c.frames.map(f => f.variables.ready);
        delete c.frames;
        if (name === "hz60" || name === "fraction") {
          const native = c.nativeClockVerification;
          if (!native?.ok || native.clockMode !== "native-deterministic" || native.sha256 !== c.sha256 ||
              native.frames.length !== c.ready.length || native.pageErrors.length || native.runtimeErrors.length ||
              native.frames.some((f, i) => f.elapsedFrames !== i + 1 || f.variables.trace !== "" || f.variables.ready !== c.ready[i]))
            throw new Error(`Native clock observation differs: ${name}`);
          native.frameCount = native.frames.length;
          native.ready = native.frames.map(f => f.variables.ready);
          delete native.frames;
        }
        checked.input = `tests/fixtures/kn-r3-sched/precision/${name}.bcmkn`;
      }
      await fs.writeFile(path.join(root, "docs/kn-r3-wait-precision.json"), JSON.stringify({ ...report, editorCompat: editor }, null, 2) + "\n");
      return;
    }
    if (process.argv.includes("--generate")) {
      for (const [name, p] of Object.entries(cases)) await fs.writeFile(path.join(dir, `${name}.bcmkn`), JSON.stringify(p, null, 2) + "\n");
      return;
    }
    const browser = await loadPlaywright().chromium.launch({ headless: true, channel: "msedge" });
    const report = { verifiedAt: new Date().toISOString(), browserVersion: browser.version(), cases: {} };
    try {
      for (const name of Object.keys(cases)) {
        const frameMs = name === "variable" ? [7, 9, 0, 16, 5, 11] : name === "tiny" ? [0, 0, 1e-8] : name === "hz60" ? 1000 / 60 : name === "fraction" ? 0.1 : 16;
        const source = await fs.readFile(path.join(dir, `${name}.bcmkn`), "utf8");
        const observation = await observe(browser, source, 1200, frameMs);
        if (name === "hz60" || name === "fraction") {
          observation.nativeClockVerification = await observe(browser, source, 1200, frameMs, true);
          if (JSON.stringify(observation.frames) !== JSON.stringify(observation.nativeClockVerification.frames) || !observation.nativeClockVerification.ok)
            observation.ok = false;
        }
        report.cases[name] = { ...observation, frameMs };
        console.log(name, observation.ok, observation.frames.length);
      }
    } finally { await browser.close(); }
    report.ok = Object.values(report.cases).every(c => c.ok);
    await fs.writeFile(path.join(out, "precision-official.json"), JSON.stringify(report, null, 2) + "\n");
    if (!report.ok) process.exitCode = 1;
    return;
  }
  if (process.argv.includes("--generate")) {
    await fs.mkdir(fixtures, { recursive: true });
    for (const [name, project] of Object.entries(await projects())) await fs.writeFile(path.join(fixtures, `${name}.bcmkn`), JSON.stringify(project, null, 2) + "\n");
    return;
  }
  if (process.argv.includes("--archive")) {
    const report = JSON.parse(await fs.readFile(path.join(out, "official.json"), "utf8"));
    const editor = JSON.parse(await fs.readFile(path.join(out, "editor-compat.json"), "utf8"));
    const cases = await projects();
    if (!report.ok || !editor.ok || Object.keys(report.cases).length !== Object.keys(cases).length || editor.projects.length !== Object.keys(cases).length)
      throw new Error("Incomplete observations/editor checks");
    for (const name of Object.keys(cases)) {
      const bytes = await fs.readFile(path.join(fixtures, `${name}.bcmkn`));
      const observation = report.cases[name];
      if (!observation?.ok || observation.sha256 !== hash(bytes) || observation.pageErrors.length || observation.runtimeErrors.length || observation.frames.length !== 8 ||
          !editor.projects.some(p => path.basename(p.input) === `${name}.bcmkn` && p.sha256 === hash(bytes) && p.ok && !p.issues.length && !p.pageErrors.length))
        throw new Error(`Unpaired observation/editor check: ${name}`);
    }
    for (const p of editor.projects) p.input = `tests/fixtures/kn-r3-sched/${path.basename(p.input)}`;
    await fs.writeFile(path.join(root, "docs/kn-r3-scheduling-official.json"), JSON.stringify({ ...report, editorCompat: editor }, null, 2) + "\n");
    return;
  }
  const browser = await loadPlaywright().chromium.launch({ headless: true, channel: "msedge" });
  const report = { officialUrl: "https://kn.codemao.cn/editor", verifiedAt: new Date().toISOString(), browserVersion: browser.version(), frameMs: 16, cases: {} };
  try {
    const corpus = process.argv.includes("--corpus") ? process.argv[process.argv.indexOf("--corpus") + 1] : null;
    const selected = corpus ? [path.basename(corpus, ".bcmkn")] : process.argv.includes("--case") ? [process.argv[process.argv.indexOf("--case") + 1]] : Object.keys(await projects());
    for (const name of selected) {
      report.cases[name] = await observe(browser, await fs.readFile(corpus || path.join(fixtures, `${name}.bcmkn`), "utf8"), corpus ? 35 : 8);
      console.log(name, JSON.stringify(report.cases[name]));
      await fs.writeFile(path.join(out, corpus ? "corpus-official.json" : "official.json"), JSON.stringify(report, null, 2) + "\n");
    }
  } finally { await browser.close(); }
  report.ok = Object.values(report.cases).every(r => r.ok);
  await fs.writeFile(path.join(out, process.argv.includes("--corpus") ? "corpus-official.json" : "official.json"), JSON.stringify(report, null, 2) + "\n");
  if (!report.ok) process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
