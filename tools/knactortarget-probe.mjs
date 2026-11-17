#!/usr/bin/env node
// Repository-owned TS fixtures; official bundles stay local/ignored. This is a
// semantic diagnostic, not a benchmark. Includes editor-compat checks.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { readOfficialBundles, exposeLoader } from "./bench/official-kn.mjs";
import { loadPlaywright } from "./probe-kitten4.mjs";

export const costume = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='40' height='40'%3E%3Crect width='40' height='40' fill='red'/%3E%3C/svg%3E";
export function semanticSource(target = "target") {
  return `sprite("target", { costume: "${costume}", x: 100, y: 0 }, () => {});
sprite("decoy", { costume: "${costume}", x: -200, y: 0 }, () => {});
sprite("source", { costume: "${costume}", x: 100, y: 100 }, self => {
  onStart(() => {
    self.rotateAround("${target}", 90);
    wait(0.5); self.moveTo(100, 0); wait(0.5); self.moveTo(300, 0);
    wait(0.5); setVar("done", 1);
  });
  onBumpActor("start", "${target}", "hit", () => {
    changeVar("hits", 1); setVar("hitX", bumpActorValue("hit", "x"));
  });
  onBumpActor("start", "decoy", "hit", () => { changeVar("decoyHits", 1); });
});`;
}

export const fixtures = {
  "target-self": `onStart(() => { rotateAround("--self", 45); });
onBumpActor("start", "--self", "actor", () => { setVar("hit", 1); });`,
  "target-name": semanticSource(),
  "target-id": semanticSource("nekoc-actor-target"),
  "target-self-semantic": semanticSource("--self"),
  "target-own-id": semanticSource("nekoc-actor-source"),
  "procedure": `defineProc("spin", [], () => { rotateAround("target", 90); });
sprite("target", {}, () => {});
sprite("source", {}, () => { onStart(() => { callProc("spin"); }); });`,
};

export function assertSemantic(result, self = false) {
  if (result.status !== "ok" || result.errors.length || result.page_errors.length) throw new Error(`Official run failed: ${JSON.stringify(result.errors)}`);
  const v = result.variables;
  // Official KN uses positive counterclockwise orbit angles: (100,100)
  // around (100,0) by +90 reaches (0,0). A wrong decoy (-200,0) would
  // reach (-300,300), so this checks the selected pivot, not just the field.
  const rotated = result.positions?.some(p => Math.abs(p.x - (self ? 100 : 0)) < 1e-8 && Math.abs(p.y - (self ? 100 : 0)) < 1e-8);
  if (!v || !rotated ||
      v["kn-var-hits"] !== (self ? 0 : 1) || v["kn-var-hitX"] !== (self ? 0 : 100) || (v["kn-var-decoyHits"] ?? 0) !== 0 || v["kn-var-done"] !== 1) {
    throw new Error(`Unexpected target behavior: ${JSON.stringify(v)}`);
  }
}

async function runSemantic(input, bundles) {
  const source = await readFile(input, "utf8"), project = JSON.parse(source);
  const result = { status: "unverified", errors: [], page_errors: [], sha256: createHash("sha256").update(source).digest("hex"),
    bundles: Object.fromEntries(Object.entries(bundles).map(([name, b]) => [name, b.sha256])) };
  const browser = await loadPlaywright().chromium.launch({ headless: true, channel: "msedge" });
  try {
    const page = await browser.newPage();
    page.on("pageerror", error => result.page_errors.push(error.message));
    const url = "https://kn.codemao.cn/__nekoc_actor_target__.bcmkn";
    await page.route(url, route => route.fulfill({ contentType: "application/json", body: source }));
    await page.route(/\/static\/js\/(main|crc_libs|main-vendors)\.[\w-]+\.js(?:\?.*)?$/, route => {
      const name = path.basename(new URL(route.request().url()).pathname), b = bundles[name];
      if (!b) throw new Error(`Unpinned bundle ${name}`);
      return route.fulfill({ contentType: "application/javascript", body: name.startsWith("main.") ? exposeLoader(b.body) : b.body });
    });
    await page.goto(`https://kn.codemao.cn/editor?previewUrl=${encodeURIComponent(url)}`, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForFunction(name => window.__nekocRequire && document.querySelector("canvas") &&
      window.__nekocRequire(91107).BcmInstance.getBcm().projectName === name &&
      (!document.querySelector("#init-loading") || getComputedStyle(document.querySelector("#init-loading")).display === "none"), project.projectName, { timeout: 120000 });
    await page.addStyleTag({ content: "#DialogContainer{display:none!important}" });
    const complete = page.getByText(/^完成$/).last();
    if (await complete.isVisible()) await complete.dispatchEvent("click");
    await page.evaluate(() => {
      const req = window.__nekocRequire, core = req(26921).cG.get_instance().getHeart().core;
      const manager = core.get_runtime_manager().run_mgr, store = req(54174).V.core.actors;
      const trace = window.__actorTarget = { positions: [], runtimeErrors: [] };
      trace.variables = () => Object.fromEntries(Object.keys(req(91107).BcmInstance.variablesDict).map(id => [id, manager.get_variable(id)]));
      core.get_event_bus().error.runtime.immediate.sub(e => trace.runtimeErrors.push(String(e?.error?.message || e?.error || e)));
      const update = manager.update;
      manager.update = function(...args) {
        const answer = update.apply(this, args);
        const found = store.get_actor("nekoc-actor-source"), actor = found?.value ?? found;
        if (actor?.get_position && trace.positions.length < 1000) trace.positions.push({ ...actor.get_position(), variables: trace.variables() });
        return answer;
      };
    });
    await page.getByText(/^开始$/).last().dispatchEvent("click");
    await page.waitForFunction(() => window.__actorTarget.variables()["kn-var-done"] === 1, null, { timeout: 30000 });
    Object.assign(result, await page.evaluate(() => ({ positions: window.__actorTarget.positions,
      variables: window.__actorTarget.variables(), runtimeErrors: window.__actorTarget.runtimeErrors })));
    result.errors.push(...result.runtimeErrors);
    result.status = result.errors.length || result.page_errors.length ? "runtime-error" : "ok";
  } finally { await browser.close(); }
  return result;
}

async function main() {
  const option = name => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined;
  const out = path.resolve("dist/knactortarget");
  const binary = path.resolve(option("--binary") ?? `target/debug/nekoc${process.platform === "win32" ? ".exe" : ""}`);
  await mkdir(out, { recursive: true });
  const sources = { ...fixtures,
    "sample-motion_actor": await readFile("samples/motion_actor.ts", "utf8"),
    "sample-event_bump_received": await readFile("samples/event_bump_received.ts", "utf8") };
  const files = [];
  for (const [name, source] of Object.entries(sources)) {
    const input = path.join(out, `${name}.ts`), output = path.join(out, `${name}.bcmkn`);
    await writeFile(input, source);
    execFileSync(binary, ["build", input, "-o", output], { stdio: "pipe" });
    execFileSync(binary, ["check", input, "--json"], { stdio: "pipe" });
    execFileSync(binary, ["check", output, "--json"], { stdio: "pipe" });
    files.push(output);
  }
  execFileSync(process.execPath, ["tools/editor-compat.mjs", ...files, "--channel", "msedge", "--bundle-dir", out,
    "--out", path.join(out, "editor.json")], { stdio: "pipe" });
  const bundles = await readOfficialBundles(out);
  const results = {};
  for (const name of ["target-name", "target-id", "target-self-semantic", "target-own-id"]) {
    const result = await runSemantic(path.join(out, `${name}.bcmkn`), bundles);
    results[name] = result;
    await writeFile(path.join(out, "official.json"), JSON.stringify(results, null, 2));
    assertSemantic(result, name === "target-self-semantic" || name === "target-own-id");
  }
  console.log("Official editor and controlled motion/collision checks passed");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
