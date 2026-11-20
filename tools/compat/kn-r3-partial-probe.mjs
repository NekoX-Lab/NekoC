#!/usr/bin/env node
// Repository-owned fixture/probe; official source is fetched only into dist/.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { loadPlaywright } from "../probe-kitten4.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export function validateReport(r) {
  if (r.error || r.pageErrors?.length !== 0 || !r.mainBundle?.sha256 || !r.runtimeBundle?.sha256 || r.domain?.version !== "0.27.4") throw new Error("Incomplete official observation");
  const v = r.variables, c = r.domain.copied;
  if (v?.same_copy !== true || v.detached !== true || v.copied_second_length !== 2 ||
      v.source_length !== 1 || v.same_self_copy !== true || v.done !== 1 ||
      c?.repeated !== true || c.nested !== true || c.detached !== true || c.self !== true ||
      JSON.stringify(c.mutation) !== "[2,2,1]") throw new Error("Incorrect copy graph evidence");
  const expected = [["number", 2, true], ["text", 1, true], ["nan", 0, false], ["zero", 1, true],
    ["same-list", 1, true], ["different-list", 0, false], ["same-object", 1, true],
    ["different-object", 0, false], ["null", 1, true], ["undefined", 1, true],
    ["invalid-list", { $number: "NaN" }, false]];
  if (JSON.stringify(r.domain.search?.map(({ label, index, contains }) => [label, index, contains])) !== JSON.stringify(expected)) throw new Error("Incomplete strict-search evidence");
}

export function project(template) {
  const p = structuredClone(template), actor = Object.keys(p.actors.actorsDict)[0];
  let serial = 0;
  const b = (type, fields = {}, inputs = {}) => ({ id: `r3-list-${++serial}`, type, fields, inputs });
  const n = value => b("math_number", { NUM: String(value) });
  const list = name => b("pure_list_get", { list: name });
  const get = name => b("variables_get", { variable: name });
  const set = (name, value) => b("variables_set", { variable: name }, { value });
  const item = (name, index) => b("list_item", { item: "any" }, { list: list(name), list_index: n(index) });
  const eq = (A, B) => b("logic_compare", { OP: "EQ" }, { A, B });
  const index = (name, value) => b("list_index_of", {}, { list: list(name), list_item_value: value });
  const blocks = [b("on_running_group_activated"),
    b("list_append", {}, { list: list("source"), list_item_value: list("shared") }),
    b("list_append", {}, { list: list("source"), list_item_value: list("shared") }),
    b("list_copy", {}, { list: list("source"), target_list: list("copy") }),
    set("same_copy", eq(index("copy", item("copy", 2)), n(1))),
    set("detached", eq(index("source", item("copy", 1)), n(0))),
    set("nested", item("copy", 1)),
    b("list_append", {}, { list: get("nested"), list_item_value: n(9) }),
    set("copied_second_length", b("list_length", {}, { list: item("copy", 2) })),
    set("source_length", b("list_length", {}, { list: list("shared") })),
    b("list_copy", {}, { list: list("source"), target_list: list("source") }),
    set("same_self_copy", eq(index("source", item("source", 2)), n(1))),
    set("done", n(1))];
  for (let i = 1; i < blocks.length; i++) blocks[i - 1].next = blocks[i];
  p.projectName = "NekoC KN semantics r3-partial-list-copy";
  p.actors.actorsDict = { [actor]: { ...p.actors.actorsDict[actor], nekoBlockJsonList: [blocks[0]] } };
  p.scenes.scenesDict[p.scenes.currentSceneId].actorIds = [actor];
  p.variables.variablesDict = Object.fromEntries(Object.entries({
    shared: [7], source: [], copy: [], nested: 0, same_copy: 0, detached: 0,
    copied_second_length: 0, source_length: 0, same_self_copy: 0, done: 0,
  }).map(([id, value]) => [id, { id, name: id, value, type: Array.isArray(value) ? "list" : "any",
    isGlobal: true, currentEntityId: actor, visible: false, position: { x: 0, y: 0 } }]));
  return p;
}

async function main() {
  const out = path.join(root, "dist/r3-knpartial");
  await fs.mkdir(out, { recursive: true });
  const p = project(JSON.parse(await fs.readFile(path.join(root, "samples/kitten-n-0.27.4.bcmkn"), "utf8")));
  const source = JSON.stringify(p, null, 2) + "\n";
  await fs.writeFile(path.join(out, "lists.bcmkn"), source);
  if (process.argv.includes("--generate")) return;
  const r = { checkedAt: new Date().toISOString(), sha256: createHash("sha256").update(source).digest("hex"), pageErrors: [] };
  const browser = await loadPlaywright().chromium.launch({ headless: true, channel: "msedge" });
  try {
    const page = await browser.newPage();
    page.on("pageerror", e => r.pageErrors.push(String(e)));
    await page.route(/\/(main|crc_libs)\.[\w-]+\.js(?:\?.*)?$/, async route => {
      const response = await route.fetch(), bytes = await response.body();
      const main = /\/main\./.test(route.request().url());
      r[main ? "mainBundle" : "runtimeBundle"] = { url: route.request().url(), sha256: createHash("sha256").update(bytes).digest("hex") };
      let body = bytes.toString();
      if (main) {
        const marker = "var __webpack_exports__=";
        if (!body.includes(marker)) throw new Error("Official webpack loader changed");
        body = body.replace(marker, `window.__nekocRequire=__webpack_require__;${marker}`);
      }
      await route.fulfill({ response, body });
    });
    const projectUrl = "https://kn.codemao.cn/__nekoc_r3_partial__.bcmkn";
    await page.route(projectUrl, route => route.fulfill({ contentType: "application/json", body: source }));
    await page.goto(`https://kn.codemao.cn/editor?previewUrl=${encodeURIComponent(projectUrl)}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__nekocRequire && document.querySelector("canvas") &&
      (!document.querySelector("#init-loading") || getComputedStyle(document.querySelector("#init-loading")).display === "none"), null, { timeout: 60000 });
    await page.evaluate(() => {
      const req = window.__nekocRequire;
      const find = (text, key) => {
        for (const [id, factory] of Object.entries(req.m)) if (factory.toString().includes(text)) {
          const value = req(id)[key];
          if (value) return value;
        }
        throw new Error(`Official export missing: ${key}`);
      };
      window.__r3bcm = find("BcmInstance:function", "BcmInstance");
      window.__r3runtime = find("cG:function", "cG");
    });
    await page.waitForFunction(() => window.__r3bcm.getBcm().projectName.startsWith("NekoC KN semantics"));
    await page.addStyleTag({ content: "#DialogContainer{display:none!important}" });
    const done = page.getByText(/^完成$/).last();
    if (await done.isVisible()) await done.dispatchEvent("click");
    await page.getByText(/^开始$/).last().dispatchEvent("click");
    await page.waitForFunction(() => window.__r3runtime.get_instance().getHeart().core.get_runtime_manager().get_variable("done") === 1);
    r.variables = await page.evaluate(() => {
      const manager = window.__r3runtime.get_instance().getHeart().core.get_runtime_manager();
      return Object.fromEntries(["same_copy", "detached", "copied_second_length", "source_length", "same_self_copy", "done"].map(id => [id, manager.get_variable(id)]));
    });
    r.domain = await page.evaluate(() => {
      const bcm = window.__r3bcm;
      const actor = Object.keys(bcm.getBcm().actors.actorsDict)[0];
      const registry = window.__r3runtime.get_instance().getHeart().core.get_registry();
      const call = (name, args) => registry.domain_function_list[registry.get_domain_function_index(name)](args, "r3-probe", actor, actor, "r3-probe", {});
      const encode = v => v === undefined ? { $undefined: true } : typeof v === "number" && !Number.isFinite(v) ? { $number: String(v) } : Array.isArray(v) ? v.map(encode) : v;
      const copy = (source, target) => call("list_copy", { list: source, target_list: target });
      const shared = [7], obj = { shared }, source = [shared, shared, obj], target = [];
      copy(source, target);
      const copied = { repeated: target[0] === target[1], nested: target[0] === target[2].shared, detached: target[0] !== shared };
      target[0].push(9);
      copied.mutation = [target[1].length, target[2].shared.length, shared.length];
      copy(source, source);
      copied.self = source[0] === source[1] && source[0] === source[2].shared && source[0] !== shared;
      const search = [];
      for (const [label, list, needle] of [["number", ["1", 1, 1], 1], ["text", ["1", 1], "1"],
        ["nan", [NaN], NaN], ["zero", [-0], 0], ["same-list", [shared], shared],
        ["different-list", [shared], [7]], ["same-object", [obj], obj],
        ["different-object", [obj], { shared }], ["null", [null], null],
        ["undefined", [undefined], undefined], ["invalid-list", 42, 1]]) {
        search.push({ label, index: encode(call("list_index_of", { list, list_item_value: needle })),
          contains: encode(call("list_is_exist", { list, list_item_value: needle })) });
      }
      return { version: bcm.getBcm().version, copied, search };
    });
    validateReport(r);
    r.ok = true;
  } catch (e) { r.error = String(e); r.ok = false; }
  finally { await browser.close(); }
  await fs.writeFile(path.join(out, "official.json"), JSON.stringify(r, null, 2) + "\n");
  console.log(JSON.stringify(r, null, 2));
  if (!r.ok) process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(e => { console.error(e); process.exitCode = 1; });
