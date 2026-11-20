// Original oracle; official bundles and generated works remain in ignored dist/.
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { loadPlaywright } from "../probe-kitten4.mjs";

const out = "dist/kn-r3-camera";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
await fs.mkdir(out, { recursive: true });
const project = JSON.parse(await fs.readFile("tests/fixtures/kn-async-services/timers.bcmkn", "utf8"));
project.projectName = "NekoC camera unavailable probe";
project.variables.variablesDict = {};
let serial = 0;
const block = (type, data = {}) => ({ id: `r3-camera-${++serial}`, type, ...data });
const number = value => block("math_number", { fields: { NUM: String(value) } });
const variable = id => { project.variables.variablesDict[id] = { id, name: id, value: 0, type: "any", isGlobal: true, currentEntityId: "nekoc-default-actor", visible: false, position: { x: 0, y: 0 } }; };
const set = (id, next) => block("variables_set", { fields: { variable: id }, inputs: { value: number(1) }, ...(next ? { next } : {}) });
const names = ["open_hide_camera", "open_close_webcam"];
const scripts = names.map(name => {
  variable(`${name}:before`); variable(`${name}:after`);
  return block("on_running_group_activated", { next: set(`${name}:before`, block(name, { fields: { camera_status: "turn_on" }, next: set(`${name}:after`) })) });
});
variable("independent");
scripts.push(block("on_running_group_activated", { next: set("independent") }));
project.actors.actorsDict["nekoc-default-actor"].nekoBlockJsonList = scripts;
const projectText = JSON.stringify(project, null, 2) + "\n";
await fs.writeFile(`${out}/camera.bcmkn`, projectText);
const report = { schema: "nekoc-kn-r3-camera-v1", checkedAt: new Date().toISOString(), officialUrl: "https://kn.codemao.cn/editor", fixtureSha256: hash(projectText), bundles: [], profiles: [], limitations: [
  "Browser-denied uses actual Chromium camera policy; device-absent injects only getUserMedia NotFoundError, not a physical unplug test.",
  "No camera success path, real video rendering, mobile/desktop-app branch or exact VM frame parity verified.",
] };
const browser = await loadPlaywright().chromium.launch({ channel: "msedge", headless: true });
try {
  for (const profile of ["browser-denied", "device-absent"]) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const result = { profile, pageErrors: [] };
    report.profiles.push(result);
    page.on("pageerror", error => result.pageErrors.push(error.message));
    await page.addInitScript(profile => {
      window.__cameraGum = [];
      const media = navigator.mediaDevices, original = media.getUserMedia;
      media.getUserMedia = function(constraints) {
        const entry = { constraints }; window.__cameraGum.push(entry);
        const value = profile === "device-absent"
          ? Promise.reject(new DOMException("Controlled missing camera", "NotFoundError"))
          : original.call(this, constraints);
        value.then(() => entry.fulfilled = true, error => entry.errorName = error.name);
        return value;
      };
    }, profile);
    const cdp = await context.newCDPSession(page);
    await cdp.send("Browser.setPermission", { permission: { name: "camera" }, setting: "denied", origin: "https://kn.codemao.cn" });
    await page.route(/\/static\/js\/main\.[^/?]+\.js(?:\?.*)?$/, async route => {
      const response = await route.fetch(), bytes = await response.body();
      const url = route.request().url(), name = path.basename(new URL(url).pathname);
      await fs.writeFile(`${out}/${name}`, bytes);
      if (!report.bundles.some(b => b.name === name)) report.bundles.push({ name, url, sha256: hash(bytes), bytes: bytes.length });
      const marker = "var __webpack_exports__=";
      if (!bytes.toString().includes(marker)) throw new Error("Official loader changed");
      await route.fulfill({ response, body: bytes.toString().replace(marker, `window.__nekocRequire=__webpack_require__;${marker}`) });
    });
    await page.goto(report.officialUrl, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForFunction(() => window.__nekocRequire && document.querySelector("canvas") && (!document.querySelector("#init-loading") || getComputedStyle(document.querySelector("#init-loading")).display === "none"), null, { timeout: 120000 });
    result.version = await page.evaluate(() => {
      const req = window.__nekocRequire;
      const find = (anchor, name) => {
        for (const [id, factory] of Object.entries(req.m)) {
          if (String(factory).includes(anchor) && req(id)[name]) return req(id)[name];
        }
        throw new Error(`Official export not found: ${name}`);
      };
      window.__cameraModules = {
        bcm: find('BcmInstance:function', 'BcmInstance'),
        blink: find('BlinkInstance:function', 'BlinkInstance'),
        camera: find('key:"turnOn"', 'HS').getInstance(),
        runtime: find('key:"getHeart"', 'cG').get_instance(),
      };
      return window.__cameraModules.bcm.getBcm().version;
    });
    result.calls = [];
    for (const name of names) {
      await page.evaluate(name => {
        const { camera, runtime } = window.__cameraModules;
        camera.turnOff();
        camera.setCameraAlpha(0.375);
        const writes = [], raw = camera.camera, setter = raw.set_alpha;
        raw.set_alpha = function(value) { writes.push(value); return setter.call(this, value); };
        const registry = runtime.getHeart().core.get_registry();
        const call = status => registry.domain_function_list[registry.get_domain_function_index(name)]({ camera_status: status }, "r3-camera", "nekoc-default-actor", "nekoc-default-actor", "r3-camera", {});
        const obs = { before: camera.cameraStatus, writes, order: [] };
        window.__cameraCall = obs;
        const value = call("turn_on");
        obs.promise = !!value?.then; obs.order.push("returned");
        obs.result = Promise.resolve(value).then(async value => {
          obs.order.push("fulfilled"); obs.valueType = typeof value;
          obs.afterOpen = camera.cameraStatus; obs.openWrites = writes.slice();
          await call("turn_off"); obs.afterClose = camera.cameraStatus;
          raw.set_alpha = setter; obs.done = true;
        }, error => { obs.error = String(error); raw.set_alpha = setter; obs.done = true; });
        obs.order.push("after-register");
      }, name);
      const consent = page.getByText(/^同意授权$/).last();
      // The site's consent modal is distinct from Chromium's denied policy.
      try { await consent.waitFor({ state: "visible", timeout: 3000 }); await consent.dispatchEvent("click"); } catch (error) {
        if (!await page.evaluate(() => window.__cameraCall.done)) throw error;
      }
      await page.waitForFunction(() => window.__cameraCall.done, null, { timeout: 15000 });
      result.calls.push({ name, ...await page.evaluate(() => { const { result, ...obs } = window.__cameraCall; return obs; }) });
    }
    await page.evaluate(project => {
      const { bcm, blink } = window.__cameraModules;
      bcm.setBcm(project);
      blink.workspaceManager.loadWorkspacesFromBcm();
      blink.workspaceManager.selectWorkspace("nekoc-default-actor", true);
    }, project);
    await page.addStyleTag({ content: "#DialogContainer{display:none!important}" });
    const done = page.getByText(/^完成$/).last();
    if (await done.isVisible()) await done.dispatchEvent("click");
    await page.getByText(/^开始$/).last().dispatchEvent("click");
    await page.waitForFunction(() => {
      const manager = window.__cameraModules.runtime.getHeart().core.get_runtime_manager();
      return ["open_hide_camera:after", "open_close_webcam:after", "independent"].every(id => manager.get_variable(id) === 1);
    }, null, { timeout: 15000 });
    result.native = await page.evaluate(() => {
      const { bcm, runtime } = window.__cameraModules, core = runtime.getHeart().core;
      return { running: core.get_runtime_data().is_running(), variables: Object.fromEntries(Object.keys(bcm.getBcm().variables.variablesDict).map(id => [id, core.get_runtime_manager().get_variable(id)])), gum: window.__cameraGum };
    });
    await context.close();
  }
} catch (error) { report.failure = error.stack; } finally { await browser.close(); }
report.sourceLocations = [];
for (const bundle of report.bundles) {
  const source = await fs.readFile(`${out}/${bundle.name}`, "utf8");
  for (const [symbol, anchor, length] of [["turnOn", '{key:"turnOn",value:', 8000], ["turnOff", '{key:"turnOff",value:', 900], ["open_hide_camera", '(0,c.Z)(t,u.V1.openCloseCamera,', 1638], ["open_close_webcam", '(0,c.Z)(t,u.Jw.openCloseWebcam,', 1396]]) {
    const start = source.indexOf(anchor);
    report.sourceLocations.push({ symbol, bundle: bundle.name, byteOffset: start < 0 ? null : Buffer.byteLength(source.slice(0, start)), characters: length, excerptSha256: start < 0 ? null : hash(source.slice(start, start + length)) });
  }
}
report.ok = !report.failure && report.profiles.length === 2 && report.profiles.every(p => {
  const denied = p.profile === "browser-denied";
  return p.native?.running && Object.values(p.native.variables).every(v => v === 1)
    && p.native.gum.length >= 2 && p.native.gum.every(g => g.errorName === (denied ? "NotAllowedError" : "NotFoundError"))
    && p.calls.length === 2 && !p.pageErrors.length && p.calls.every(c => c.promise && c.done && !c.error
      && c.valueType === "undefined" && c.afterOpen === (denied ? "no_permission" : "no_support")
      && c.afterClose === "turn_off" && c.openWrites.length === 0 && c.writes.includes(0.6));
}) && report.sourceLocations.every(s => s.byteOffset !== null);
await fs.writeFile(`${out}/official-report.json`, JSON.stringify(report, null, 2) + "\n");
if (process.argv.includes("--record") && report.ok) await fs.writeFile("docs/kn-r3-camera-evidence.json", JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;
