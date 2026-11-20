#!/usr/bin/env node
// Authored boundary inputs only; downloaded official code stays in ignored dist/.
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const out = "dist/r3-kntext-official";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const require = createRequire(path.resolve(process.env.NEKOC_NODE_MODULES, "package.json"));
const { chromium } = require("playwright");
await fs.mkdir(out, { recursive: true });
const report = {
  schema: "nekoc-kn-r3-text-v1",
  editorUrl: "https://kn.codemao.cn/editor",
  checkedAt: new Date().toISOString(),
  method: "Anonymous official editor; expose webpack loader and call unchanged registered domain functions. Inputs and results preserve type, negative zero and nonfinite values. No domain functions replaced.",
  limitations: ["Direct domain calls, not project scheduling or input normalization.", "Case conversion tests registered String code APIs, not a visible text-change-case block.", "UI number display, lone surrogates and custom prototypes are outside this probe."],
  bundles: [], pageErrors: [],
};
const browser = await chromium.launch({ channel: "msedge", headless: true });
report.browserVersion = browser.version();
try {
  const page = await browser.newPage();
  page.on("pageerror", error => report.pageErrors.push(error.message));
  await page.route(/\/static\/js\/[^/?]+\.js(?:\?.*)?$/, async route => {
    const response = await route.fetch(), bytes = await response.body();
    const url = route.request().url(), name = path.basename(new URL(url).pathname);
    await fs.writeFile(`${out}/${name}`, bytes);
    report.bundles.push({ name, url, bytes: bytes.length, sha256: hash(bytes) });
    let body = bytes;
    if (name.startsWith("main.")) {
      const source = bytes.toString("utf8"), marker = "var __webpack_exports__=";
      if (!source.includes(marker)) throw new Error("Official webpack loader changed");
      body = source.replace(marker, `window.__nekocRequire=__webpack_require__;${marker}`);
    }
    await route.fulfill({ response, body });
  });
  await page.goto(report.editorUrl, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForFunction(() => window.__nekocRequire && document.querySelector("canvas") &&
    (!document.querySelector("#init-loading") || getComputedStyle(document.querySelector("#init-loading")).display === "none"), null, { timeout: 120000 });
  report.observation = await page.evaluate(() => {
    const req = window.__nekocRequire;
    const factories = Object.entries(req.m);
    const runtime = factories.find(([, f]) => f.toString().includes('key:"getHeart"'));
    if (!runtime) throw new Error("Official runtime export missing");
    const Runtime = Object.values(req(runtime[0])).find(v => typeof v?.get_instance === "function");
    const registry = Runtime.get_instance().getHeart().core.get_registry();
    const bcmModule = factories.find(([, f]) => f.toString().includes("BcmInstance:function"));
    const bcm = req(bcmModule[0]).BcmInstance;
    const encode = value => value === undefined ? { $undefined: true } :
      typeof value === "number" && (!Number.isFinite(value) || Object.is(value, -0)) ? { $number: Object.is(value, -0) ? "-0" : String(value) } :
      Array.isArray(value) ? value.map(encode) : value;
    const calls = [], sources = {};
    const call = (label, type, args) => {
      const fn = registry.domain_function_list[registry.get_domain_function_index(type)];
      if (typeof fn !== "function") throw new Error(`Missing official domain: ${type}`);
      sources[type] = String(fn);
      const entry = { label, type, args: Object.fromEntries(Object.entries(args).map(([k, v]) => [k, encode(v)])) };
      try { entry.result = encode(fn(args, "r3-text", "r3-text-actor", "r3-text-actor", "r3-text", {})); }
      catch (error) { entry.error = String(error); }
      calls.push(entry);
    };
    const adjacent = (n, delta) => {
      const data = new DataView(new ArrayBuffer(8));
      data.setFloat64(0, n);
      data.setBigUint64(0, data.getBigUint64(0) + BigInt(delta));
      return data.getFloat64(0);
    };
    const numbers = [0, -0, 1, -1, 1.23, 1.005, 2.675, 0.1 + 0.2,
      1.2345678901234567, 1.0000000000000002, 1000000000000000100,
      Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, Number.MIN_VALUE, -Number.MIN_VALUE,
      Number.MAX_VALUE, -Number.MAX_VALUE, 2.2250738585072014e-308,
      NaN, Infinity, -Infinity,
      ...[1e-7, 1e-6, 1e20, 1e21].flatMap(n => [-1, 0, 1].flatMap(d => [adjacent(n, d), -adjacent(n, d)]))];
    for (const [i, text] of numbers.entries()) {
      call(`number-${i}/convert`, "convert_type", { type: "string", text });
      call(`number-${i}/join`, "text_join", { ADD0: "[", ADD1: text, ADD2: "]" });
      call(`number-${i}/length`, "text_length", { text });
    }
    const pairs = [
      ["", ""], ["", "a"], ["a", "aa"], ["A", "a"], ["Z", "a"],
      ["ABC", "abc"], ["Straße", "STRASSE"], ["İ", "i"], ["I", "ı"],
      ["Σ", "σ"], ["σ", "ς"], ["é", "e\u0301"], ["猫", "狗"],
      ["\u{10000}", "\ue000"], ["😀", "\uffff"], ["a😀", "a\ue000"],
      ["😀", "😁"], ["\u{10ffff}", "\uffff"], ["a\0b", "a\0c"],
      ["10", "2"], ["02", "2"], ["1e2", "99"], [" 2", "2"],
      ["Infinity", "NaN"], ["10", 2], ["2", 2], ["02", 2], ["", 0],
      [" ", 0], ["0x10", 16], ["0b11", 3], ["bad", 1], ["NaN", NaN],
      ["Infinity", Infinity], ["-Infinity", -Infinity], ["1", true], [0, false],
      [NaN, NaN], [-0, 0], [Infinity, Infinity], [-Infinity, Infinity],
    ];
    for (const [i, [a, b]] of pairs.entries()) for (const reverse of [false, true])
      for (const OP of ["EQ", "NEQ", "LT", "LTE", "GT", "GTE"])
        call(`compare-${i}/${reverse ? "reverse" : "forward"}/${OP}`, "logic_compare", { OP, A: reverse ? b : a, B: reverse ? a : b });
    const joins = [[], [""], [1], [true, false], ["A", "b", "猫", "😀"],
      ["1.2300", "|", 1.23], ["1E+21", "|", 1e21], ["-0", "|", -0],
      [NaN, "|", Infinity, "|", -Infinity], ["a", undefined, "b"],
      [undefined, "b"], ["a", "b", undefined], [[1, "猫", [2, 3]]],
      [[null, undefined, NaN, -0]], [[], "x", [[], []]], [null], ["a", null, "b"]];
    for (const [i, values] of joins.entries())
      call(`join-${i}`, "text_join", Object.fromEntries(values.map((v, j) => [`ADD${j}`, v])));
    for (const [i, [A, B]] of [
      ["ABC", "a"], ["ABC", "A"], ["Straße", "SS"], ["İ", "i"],
      ["Σ", "σ"], ["猫😀犬", "😀"], ["é", "e\u0301"], ["", ""],
      [1e21, "e+21"], [NaN, "NaN"], ["NaN", NaN], ["NaN", "NaN"],
      [Infinity, "Infinity"], [-0, "-0"], [true, "true"],
      [undefined, ""], ["undefined", undefined], [null, ""],
    ].entries()) call(`contains-${i}`, "text_contain", { A, B });
    for (const [i, CONSTRUCTOR] of ["", "AbC猫😀", "Straße", "ẞ", "İ", "Iıi", "Σ", "ΟΣ", "ΟΣΑ", "ΣΣ", "Ο\u0301Σ", "ΟΣ\u0301", "ﬃ", "ǰ", "éÉ", "\u{10400}\u{10428}",
      "123", 1.23, -0, 1e21, NaN, Infinity, true, false, null, undefined,
      ["AbC", "ß", ["Σ"]], []].entries())
      for (const type of ["String.toLowerCase", "String.toUpperCase"])
        call(`case-${i}/${type}`, type, { CONSTRUCTOR });
    return { version: bcm.getBcm().version, calls, sources,
      caseConversionDomains: Object.keys(registry.domain_function_index).filter(n => /upper.?case|lower.?case|change.?case/i.test(n)) };
  });
} catch (error) { report.failure = error.stack; }
finally { await browser.close(); }
report.sourceLocations = [];
const anchors = { convert_type: "convertType,(function", text_join: "text_join:function",
  text_length: "textLength,(function", logic_compare: "EQ:function", text_contain: "textContain,(function",
  "String.toLowerCase": '"String.toLowerCase":function', "String.toUpperCase": '"String.toUpperCase":function' };
for (const type of Object.keys(report.observation?.sources ?? {})) {
  for (const bundle of report.bundles) {
    const source = await fs.readFile(`${out}/${bundle.name}`, "utf8"), anchor = anchors[type], index = source.indexOf(anchor);
    if (index >= 0) report.sourceLocations.push({ type, bundle: bundle.name,
      utf16Offset: index, byteOffset: Buffer.byteLength(source.slice(0, index)),
      anchor, excerptLength: 1000, excerptSha256: hash(source.slice(index, index + 1000)) });
  }
}
report.ok = !report.failure && report.pageErrors.length === 0 &&
  report.observation?.calls.length > 600 && report.observation.calls.every(c => Object.hasOwn(c, "result")) &&
  Object.keys(report.observation.sources).every(type => report.sourceLocations.some(s => s.type === type));
await fs.writeFile(`${out}/report.json`, JSON.stringify(report, null, 2) + "\n");
if (process.argv.includes("--record") && report.ok) {
  const { sources, ...observation } = report.observation;
  await fs.writeFile("docs/kn-r3-text-evidence.json", JSON.stringify({ ...report, observation }, null, 2) + "\n");
}
console.log(JSON.stringify({ ok: report.ok, calls: report.observation?.calls.length,
  failure: report.failure, pageErrors: report.pageErrors, sourceLocations: report.sourceLocations }, null, 2));
if (!report.ok) process.exitCode = 1;
