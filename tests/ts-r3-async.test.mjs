import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import vm from "node:vm";
import ts from "typescript";
import { CompileError, compileFile, checkFile } from "../ts/compile-ts.mjs";

const entry = path.resolve("virtual/r3-tsasync/main.ts");
const hostFor = source => ({ readFile: name => name === entry ? source : undefined });
const bin = path.resolve("target/debug", process.platform === "win32" ? "nekoc.exe" : "nekoc");
const artifacts = process.env.NEKOC_R3_ASYNC_ARTIFACT_DIR;
const newline = String.fromCharCode(10);

function reject(source, pattern, marker) {
  const host = hostFor(source);
  assert.throws(() => compileFile(entry, host), error => {
    assert.ok(error instanceof CompileError);
    assert.match(error.message, pattern);
    assert.doesNotMatch(error.message, /Internal compiler error|TypeError/);
    assert.equal(path.resolve(error.location.file), entry);
    if (marker) {
      const prefix = source.slice(0, source.indexOf(marker)).split(newline);
      assert.equal(error.location.line, prefix.length);
      assert.equal(error.location.column, prefix.at(-1).length + 1);
    }
    return true;
  });
  const checked = checkFile(entry, { host, types: false });
  assert.equal(checked.ok, false);
  assert.equal(checked.report, null);
  assert.match(checked.diagnostics[0].message, pattern);
}

test("r3-tsasync rejects async/await before callback or unused-function lowering", () => {
  for (const source of [
    "async function unused() { return 5; }",
    "onStart(async () => { console.log(1); });",
    "onMessage('go', async () => { console.log(1); });",
    "setTimeout(async () => { console.log(1); }, 0);",
    "setInterval(async function () { console.log(1); }, 0);",
    "const value = await 1;",
    "for await (const value of [1]) { console.log(value); }",
  ]) reject(source, /async.*await.*not supported.*Promise.*microtask/, source.includes("async") ? "async" : "await");
});

test("r3-tsasync rejects Promise/microtask references, including discarded code", () => {
  for (const source of [
    "new Promise(() => {});",
    "Promise.resolve(1).then(value => console.log(value));",
    "Promise.all([1]);",
    "function unused() { Promise.resolve(1); }",
    "function unused() { if (false) { let Promise = 1; } Promise.resolve(1); }",
    "function unused(ms = Promise.resolve(1)) { var Promise = 2; }",
    "function unused(ms = queueMicrotask(() => {})) { var queueMicrotask = 2; }",
    "function unused(ms = globalThis.Promise.resolve(1)) { var globalThis = 2; }",
    "if (false) { queueMicrotask(() => {}); }",
    "const alias = Promise;",
    "const alias = queueMicrotask;",
    "const alias = globalThis.Promise;",
    "globalThis['queueMicrotask'](() => {});",
  ]) reject(source, /(?:Promise|queueMicrotask) is not supported: Promise and microtask.*event state machine/);
});

test("r3-tsasync generator callbacks never become eager ordinary callbacks", () => {
  for (const source of [
    "setTimeout(function* () { console.log(1); }, 0);",
    "setInterval(function* () { console.log(1); }, 0);",
    "[1].forEach(function* (value) { console.log(value); });",
    "function* unused() { console.log(1); }",
  ]) reject("// original location" + newline + "  " + source, /Generator.*not supported.*iterator.*ordinary callback/, "*");
});

test("r3-tsasync raw guards retain imported source coordinates", () => {
  const dependency = path.resolve(path.dirname(entry), "dependency.ts");
  for (const [body, marker] of [
    ["function unused() { Promise.resolve(1); }", "Promise"],
    ["setTimeout(function* () {}, 0);", "*"],
  ]) {
    const source = ["// dependency", body, "export function value() { return 1; }"].join(newline);
    const files = new Map([[entry, 'import {value} from "./dependency"; console.log(value());'], [dependency, source]]);
    const result = checkFile(entry, { types: false, host: { readFile: name => files.get(name) } });
    assert.equal(result.ok, false);
    assert.equal(result.report, null);
    const diagnostic = result.diagnostics[0];
    assert.equal(path.resolve(diagnostic.file), dependency);
    assert.equal(diagnostic.line, 2);
    assert.equal(diagnostic.column, body.indexOf(marker) + 1);
  }
});

test("r3-tsasync guards distinguish annotations, property names and lexical bindings", () => {
  for (const source of [
    "type Promise = number; console.log(1);",
    "function identity<Promise extends number>(value: Promise) { return value; } console.log(identity(1));",
    "enum Names { Promise = 1, queueMicrotask = 2 } console.log(Names.Promise);",
    "Promise: { console.log(1); break Promise; }",
    "type Result = Promise<number>; const box = {Promise: 7, queueMicrotask: 8}; console.log(box.Promise);",
    "function Promise(value: number) { return value + 1; } console.log(Promise(2));",
    "function queueMicrotask(value: number) { return value + 1; } console.log(queueMicrotask(2));",
    "function f(Promise: number) { return Promise + 1; } console.log(f(2));",
    "function read() { const globalThis = {Promise: 1}; return globalThis.Promise; } console.log(read());",
  ]) assert.ok(compileFile(entry, hostFor(source)).workspaceData);
});

test("r3-tsasync type-only imports neither execute nor shadow runtime globals", () => {
  const dependency = path.resolve(path.dirname(entry), "dependency.ts");
  for (const declaration of ['import type { Promise }', 'import { type Promise }']) {
    const files = new Map([
      [entry, `${declaration} from "./dependency"; function unused() { Promise.resolve(1); } console.log(1);`],
      [dependency, "export type Promise = number;"],
    ]);
    const result = checkFile(entry, { types: false, host: { readFile: name => files.get(name) } });
    assert.equal(result.ok, false);
    assert.match(result.diagnostics[0].message, /Promise is not supported.*microtask/);
  }
  for (const source of [
    'import type { Promise as Result } from "./dependency"; console.log(1);',
    'import { Promise } from "./dependency"; console.log(Promise(1));',
  ]) {
    const files = new Map([[entry, source], [dependency, "export function Promise(n: number) { return n + 1; }"]]);
    assert.ok(compileFile(entry, { readFile: name => files.get(name) }).workspaceData);
  }
});

test("r3-tsasync unsupported timer arguments and captures have explicit diagnostics", () => {
  for (const [source, message] of [
    ['setTimeout(() => {}, "10");', /Timer delay must be a number/],
    ["setTimeout(() => {}, true);", /Timer delay must be a number/],
    ["setTimeout(() => {}, undefined);", /Timer delay must be a number|undefined/],
    ["let delay: any = 10; setTimeout(() => {}, delay);", /Timer delay must be a number/],
    ["setTimeout((value) => {}, 0);", /Timer callbacks cannot have parameters/],
    ["setTimeout(() => {}, 0, 1);", /Timers expect an inline callback/],
    ["function callback() {} setTimeout(callback, 0);", /inline (?:arrow )?callback/],
    ["function f(n: number) { setTimeout(() => console.log(n), 0); } f(1);", /cannot capture.*across scheduling/],
    ["onStart(() => { const local = 1; setTimeout(() => console.log(local), 0); });", /cannot capture.*across scheduling/],
  ]) reject(source, message);
});

// Actual Node timers: finish when callbacks/cancellations finish, with no elapsed
// time assertions or ordering assertion across independent interval/timeout queues.
// onStart only bootstraps handlers; this does not model KN cooperative event yields.
async function nodeLogs(source) {
  const logs = [], starts = [], pending = new Set();
  let booted = false, resolve, reject;
  const done = new Promise((yes, no) => { resolve = yes; reject = no; });
  const finish = () => { if (booted && pending.size === 0) resolve(logs); };
  const cancel = handle => { clearTimeout(handle); clearInterval(handle); pending.delete(handle); finish(); };
  const schedule = (repeat, callback, ms) => {
    const handle = (repeat ? setInterval : setTimeout)(() => {
      if (!repeat) pending.delete(handle);
      try { callback(); finish(); } catch (error) { reject(error); }
    }, ms);
    pending.add(handle);
    return handle;
  };
  const watchdog = setTimeout(() => reject(new Error("Node timer oracle did not finish")), 5000);
  try {
    vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
      console: { log: (...args) => logs.push(args.map(String).join(" ")) },
      onStart: callback => starts.push(callback), queueMicrotask,
      setTimeout: (callback, ms) => schedule(false, callback, ms),
      setInterval: (callback, ms) => schedule(true, callback, ms),
      clearTimeout: cancel, clearInterval: cancel,
    }, { timeout: 5000 });
    for (const callback of starts) callback();
    booted = true;
    finish();
    return await done;
  } finally {
    clearTimeout(watchdog);
    for (const handle of pending) { clearTimeout(handle); clearInterval(handle); }
  }
}

function vmLogs(source, label, files = {}, checkTypes = false) {
  const root = path.resolve(artifacts ?? "target");
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(path.join(root, `r3-tsasync-${label}-`));
  try {
    const input = path.join(dir, "main.ts");
    writeFileSync(input, source);
    for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text);
    if (checkTypes) for (const types of [false, true]) {
      const checked = checkFile(input, { types });
      assert.equal(checked.ok, true, JSON.stringify(checked.diagnostics));
    }
    const results = [];
    const env = { ...process.env, NEKOC_FRONTEND: path.resolve("ts") };
    const run = args => {
      const result = spawnSync(bin, args, { encoding: "utf8", env, timeout: 120000 });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      return result.stdout;
    };
    for (const optimize of [false, true]) {
      const output = path.join(dir, `main-${optimize}.bcmkn`);
      run(["build", input, "-o", output, ...(optimize ? ["--optimize"] : [])]);
      assert.equal(JSON.parse(run(["check", output, "--json"])).ok, true);
      const work = JSON.parse(readFileSync(output, "utf8"));
      const walk = node => {
        if (!node || typeof node !== "object") return;
        if (typeof node.type === "string") {
          assert.ok(!["setTimeout", "setInterval"].includes(node.type));
          assert.ok(!node.type.startsWith("_object_"));
        }
        Object.values(node).forEach(walk);
      };
      walk(work);
      results.push(JSON.parse(run(["run", output, "--ticks", "180"])).logs);
    }
    return results;
  } finally { if (!artifacts) rmSync(dir, { recursive: true, force: true }); }
}

const timerLoopDiagnostic = /Timers cannot be combined with native TypeScript loops.*implicitly yield.*alternative:/;
const timerForEachDiagnostic = /Timers cannot be combined with forEach calls.*implicitly yield.*alternative:/;

function rejectTimerLoopBuild(source, label, diagnostic = timerLoopDiagnostic) {
  const root = path.resolve(artifacts ?? "target");
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(path.join(root, `r3-tsasync-${label}-`));
  try {
    const input = path.join(dir, "main.ts");
    writeFileSync(input, source);
    const checked = checkFile(input);
    assert.equal(checked.ok, false);
    assert.equal(checked.report, null);
    assert.equal(checked.diagnostics.filter(diagnostic => diagnostic.source === "types").length, 0, JSON.stringify(checked.diagnostics));
    assert.match(checked.diagnostics[0].message, diagnostic);
    for (const optimize of [false, true]) {
      const output = path.join(dir, `main-${optimize}.bcmkn`);
      const result = spawnSync(bin, ["build", input, "-o", output, ...(optimize ? ["--optimize"] : [])], {
        encoding: "utf8", env: { ...process.env, NEKOC_FRONTEND: path.resolve("ts") }, timeout: 120000,
      });
      assert.equal(result.error, undefined);
      assert.notEqual(result.status, null);
      assert.notEqual(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout + result.stderr, diagnostic);
      assert.equal(existsSync(output), false, "rejected source must not emit a work");
    }
  } finally { if (!artifacts) rmSync(dir, { recursive: true, force: true }); }
}

for (const [name, source, expected] of [
  ["timeout-cancel-after-loop", `const h = setTimeout(() => console.log(99), 0);
    let n = 0; for (let i = 0; i < 5; i++) { n += 1; }
    clearTimeout(h); console.log(n);`, ["5"]],
  ["timeout-before-loop", `let n = 0; setTimeout(() => console.log(n), 0);
    for (let i = 0; i < 5; i++) { n += 1; } console.log(n);`, ["5", "5"]],
  ["timeout-callback-loop", `let n = 0;
    setTimeout(() => { for (let i = 0; i < 5; i++) { n += 1; } console.log(n); }, 0);
    setTimeout(() => console.log(n), 0);`, ["5", "5"]],
  ["interval-before-loop", `let n = 0;
    const h = setInterval(() => { console.log(n); clearInterval(h); }, 0);
    for (let i = 0; i < 5; i++) { n += 1; } console.log(n);`, ["5", "5"]],
]) test(`r3-tsasync rejects implicit loop yields instead of interleaving timers: ${name}`, async () => {
  assert.deepEqual(await nodeLogs(source), expected);
  reject(source, timerLoopDiagnostic, "for (");
  rejectTimerLoopBuild(source, name);
});

test("r3-tsasync timer-loop guard covers loop forms and conservative dormant code", () => {
  for (const loop of [
    "for (let i = 0; i < 2; i++) {}",
    "for (const value of [1]) { console.log(value); }",
    "while (false) {}", "do {} while (false);",
  ]) {
    reject(`setTimeout(() => {}, 0); ${loop}`, timerLoopDiagnostic, loop);
    reject(`${loop} setTimeout(() => {}, 0);`, timerLoopDiagnostic, loop);
    reject(`function unused() { ${loop} } setInterval(() => {}, 1);`, timerLoopDiagnostic, loop);
  }
  assert.ok(compileFile(entry, hostFor("let n = 0; for (let i = 0; i < 5; i++) { n++; } console.log(n);")).workspaceData);
  // The JS support contract rejects for...in on the original AST, before
  // timer graph analysis, even without timers or in an unused function.
  const forIn = "for (const key in {value: 1}) { console.log(key); }";
  const forInDiagnostic = /^for\.\.\.in enumerates property keys, not list elements; use for\.\.\.of or an explicit index loop$/;
  for (const source of [forIn, `setTimeout(() => {}, 0); ${forIn}`,
    `${forIn} setTimeout(() => {}, 0);`,
    `function unused() { ${forIn} } setInterval(() => {}, 1);`]) {
    reject(source, forInDiagnostic, forIn);
  }
  assert.ok(compileFile(entry, hostFor("onStart(() => { wait(0.05); console.log(1); }); setTimeout(() => {}, 1);")).workspaceData);
});

test("r3-tsasync timer-loop guard spans imports and preserves original loop coordinates", () => {
  const dependency = path.resolve(path.dirname(entry), "dependency.ts");
  for (const [main, imported, locationFile, locationLine] of [
    ['import { loop } from "./dependency"; setTimeout(() => {}, 0); loop();',
      "export function loop() {\n  for (let i = 0; i < 5; i++) {}\n}", dependency, 2],
    ['import { schedule } from "./dependency";\nfor (let i = 0; i < 5; i++) {} schedule();',
      "export function schedule() { setTimeout(() => {}, 0); }", entry, 2],
  ]) {
    const files = new Map([[entry, main], [dependency, imported]]);
    for (const types of [false, true]) {
      const checked = checkFile(entry, { types, host: { readFile: name => files.get(name) ?? ts.sys.readFile(name) } });
      assert.equal(checked.ok, false);
      assert.equal(checked.report, null);
      const diagnostic = checked.diagnostics.find(diagnostic => diagnostic.source === "compat");
      assert.ok(diagnostic, JSON.stringify(checked.diagnostics));
      assert.match(diagnostic.message, timerLoopDiagnostic);
      assert.equal(path.resolve(diagnostic.file), locationFile);
      assert.equal(diagnostic.line, locationLine);
    }
  }
});

for (const [name, source, expected] of [
  ["array-foreach-cancel", `const h = setTimeout(() => console.log(99), 0);
    let n = 0; [1,2,3,4,5].forEach(v => { n += v; });
    clearTimeout(h); console.log(n);`, ["15"]],
  ["map-foreach-cancel", `const h = setTimeout(() => console.log(99), 0);
    let n = 0; new Map<number,number>([[1,1],[2,2],[3,3]]).forEach(v => { n += v; });
    clearTimeout(h); console.log(n);`, ["6"]],
  ["set-foreach-cancel", `const h = setTimeout(() => console.log(99), 0);
    let n = 0; new Set<number>([1,2,3]).forEach(v => { n += v; });
    clearTimeout(h); console.log(n);`, ["6"]],
  ["foreach-callback", `let n = 0;
    setTimeout(() => { [1,2,3,4,5].forEach(v => { n += v; }); console.log(n); }, 0);
    setTimeout(() => console.log(n), 0);`, ["15", "15"]],
  ["foreach-interval-cancel", `const h = setInterval(() => console.log(99), 0);
    let n = 0; [1,2,3,4,5].forEach(v => { n += v; });
    clearInterval(h); console.log(n);`, ["15"]],
  ["foreach-nested-function", `let n = 0;
    function inner() { [1,2,3].forEach(v => { n += v; }); }
    function outer() { inner(); }
    const h = setTimeout(() => console.log(99), 0); outer(); clearTimeout(h); console.log(n);`, ["6"]],
]) test(`r3-tsasync preserves synchronous forEach/timer boundaries or rejects them: ${name}`, async () => {
  assert.deepEqual(await nodeLogs(source), expected);
  if (name.startsWith("map-") || name.startsWith("set-")) {
    reject(source, timerForEachDiagnostic);
    rejectTimerLoopBuild(source, name, timerForEachDiagnostic);
  } else {
    assert.ok(compileFile(entry, hostFor(source)).workspaceData);
    for (const actual of vmLogs(source, name, {}, true)) assert.deepEqual(actual, expected);
  }
});

for (const name of ["say", "think", "wait"]) {
  for (const mode of ["cancel-timeout", "cancel-interval", "callback"]) {
    test(`r3-tsasync synchronous user ${name} shadows the ambient API: ${mode}`, async () => {
      const prefix = `let n = 0; function ${name}(value: number) { n += value; }`;
      const iterate = `[1,2,3,4,5].forEach(v => { ${name}(v); });`;
      const source = mode === "callback"
        ? `${prefix} setTimeout(() => { ${iterate} console.log(n); }, 0); setTimeout(() => console.log(n), 0);`
        : `${prefix} const h = ${mode === "cancel-interval" ? "setInterval" : "setTimeout"}(() => console.log(99), 0); ${iterate} clearTimeout(h); console.log(n);`;
      const expected = mode === "callback" ? ["15", "15"] : ["15"];
      assert.deepEqual(await nodeLogs(source), expected);
      const report = compileFile(entry, hostFor(source));
      const helpers = report.procedures.filter(p => /^__forEach\d+ \(implementation\)$/.test(p.name));
      assert.ok(helpers.length);
      assert.ok(helpers.every(p => Object.values(p.workspaceData.blocks).some(b => b.type === "warp")));
      for (const actual of vmLogs(source, `shadow-${name}-${mode}`, {}, true)) assert.deepEqual(actual, expected);
    });
  }
}

test("r3-tsasync imported say keeps synchronous forEach atomic", async () => {
  const dependency = "export function say(value: number) { console.log(value); }";
  const source = 'import { say } from "./dependency"; const h = setTimeout(() => console.log(99), 0); [1,2,3].forEach(v => { say(v); }); clearTimeout(h);';
  const expected = ["1", "2", "3"];
  assert.deepEqual(await nodeLogs(dependency.replace("export ", "") + source.replace('import { say } from "./dependency";', "")), expected);
  for (const actual of vmLogs(source, "imported-shadow-say", { "dependency.ts": dependency }, true)) assert.deepEqual(actual, expected);
});

test("r3-tsasync shadowed API names still propagate genuine cooperative waits", () => {
  for (const name of ["say", "think"]) {
    const report = compileFile(entry, hostFor(`function ${name}(value: number) { wait(0.01); console.log(value); }
      setTimeout(() => {}, 0); [1,2].forEach(value => { ${name}(value); });`));
    const helper = report.procedures.find(p => /^__forEach\d+ \(implementation\)$/.test(p.name));
    assert.ok(helper);
    assert.equal(Object.values(helper.workspaceData.blocks).some(b => b.type === "warp"), false);
  }
});

test("r3-tsasync forEach guard covers unused, nested, waiting and imported callbacks", () => {
  for (const call of [
    "new Map<number,number>([[1,1]]).forEach(v => { console.log(v); });",
    "new Set<number>([1]).forEach(v => { console.log(v); });",
  ]) {
    reject(`function unused() { ${call} } setTimeout(() => {}, 0);`, timerForEachDiagnostic);
    reject(`${call} setInterval(() => {}, 1);`, timerForEachDiagnostic, call.slice(0, -1));
    assert.ok(compileFile(entry, hostFor(call)).workspaceData, "forEach without timers remains supported");
  }
  const dependency = path.resolve(path.dirname(entry), "dependency.ts");
  for (const [main, imported, file, marker] of [
    ['import { work } from "./dependency"; setTimeout(() => {}, 0); work();',
      "export function work() {\n  new Set<number>([1,2]).forEach(v => { console.log(v); });\n}", dependency, "new Set"],
    ['import { schedule } from "./dependency";\nnew Map<number,number>([[1,1]]).forEach(v => { console.log(v); }); schedule();',
      "export function schedule() { setTimeout(() => {}, 0); }", entry, "new Map"],
  ]) {
    const root = path.resolve(artifacts ?? "target");
    mkdirSync(root, { recursive: true });
    const dir = mkdtempSync(path.join(root, "r3-tsasync-foreach-import-"));
    try {
      const input = path.join(dir, "main.ts");
      writeFileSync(input, main);
      writeFileSync(path.join(dir, "dependency.ts"), imported);
      for (const types of [false, true]) {
        const result = checkFile(input, { types });
        const diagnostic = result.diagnostics.find(item => item.source === "compat");
        assert.equal(result.ok, false);
        assert.equal(result.report, null);
        assert.ok(diagnostic, JSON.stringify(result));
        assert.match(diagnostic.message, timerForEachDiagnostic);
        assert.equal(path.resolve(diagnostic.file), path.join(dir, path.basename(file)));
        const source = file === entry ? main : imported;
        const prefix = source.slice(0, source.indexOf(marker)).split(newline);
        assert.equal(diagnostic.line, prefix.length);
        assert.equal(diagnostic.column, prefix.at(-1).length + 1);
      }
      for (const optimize of [false, true]) {
        const output = path.join(dir, `out-${optimize}.bcmkn`);
        const result = spawnSync(bin, ["build", input, "-o", output, ...(optimize ? ["--optimize"] : [])], {
          encoding: "utf8", env: { ...process.env, NEKOC_FRONTEND: path.resolve("ts") }, timeout: 120000,
        });
        assert.equal(result.error, undefined);
        assert.notEqual(result.status, null);
        assert.notEqual(result.status, 0);
        assert.match(result.stdout + result.stderr, timerForEachDiagnostic);
        assert.equal(existsSync(output), false);
      }
    } finally { if (!artifacts) rmSync(dir, { recursive: true, force: true }); }
  }
});

test("r3-tsasync synchronous array forEach helpers are atomic, explicitly waiting callbacks remain cooperative", () => {
  for (const [body, atomic] of [
    ["console.log(value);", true], ["wait(0.01); console.log(value);", false],
    ["pause(); console.log(value);", false],
  ]) {
    const source = `function pause() { wait(0.01); } setTimeout(() => {}, 0);
      [1,2].forEach(value => { ${body} });`;
    const report = compileFile(entry, hostFor(source));
    const helper = report.procedures.find(p => /^__forEach\d+ \(implementation\)$/.test(p.name));
    assert.ok(helper);
    assert.equal(Object.values(helper.workspaceData.blocks).some(b => b.type === "warp"), atomic);
  }
  const source = `let n = 0; const h = setTimeout(() => console.log(99), 0);
    [1,2].forEach(v => { [3,4].forEach(w => { n += w; }); }); clearTimeout(h); console.log(n);`;
  for (const actual of vmLogs(source, "nested-foreach", {}, true)) assert.deepEqual(actual, ["14"]);
  reject('setTimeout(() => {}, 0); [1].forEach(v => { callProc("opaque"); });', timerForEachDiagnostic);
});

test("r3-tsasync imported synchronous array callbacks preserve run-to-return", () => {
  const source = 'import { total } from "./dependency"; const h = setTimeout(() => console.log(99), 0); total(); clearTimeout(h);';
  const files = { "dependency.ts": "export function total() { let result = 0; [1,2,3].forEach(v => { console.log(v); }); }" };
  for (const actual of vmLogs(source, "imported-foreach", files, true)) assert.deepEqual(actual, ["1", "2", "3"]);
});

test("r3-tsasync rejects destructured global asynchronous APIs before unused lowering", () => {
  for (const [source, marker] of [
    ["function unused() { const {Promise} = globalThis; Promise.resolve(1); } console.log(1);", "Promise"],
    ["function unused() { const {Promise: P} = (globalThis); P.resolve(1); }", "Promise"],
    ['function unused() { const {["Promise"]: P} = globalThis; }', '["Promise"]'],
    ["function unused() { const {queueMicrotask: enqueue} = globalThis; }", "queueMicrotask"],
    ["function unused({Promise: P} = globalThis) { P.resolve(1); }", "Promise"],
    ["function unused() { const {Promise: P} = globalThis; var globalThis = 1; }", null],
  ]) {
    if (!marker) {
      assert.ok(compileFile(entry, hostFor(source)).workspaceData);
      continue;
    }
    reject(source, /(?:Promise|queueMicrotask) is not supported.*destructure.*globalThis/, marker);
    const root = path.resolve(artifacts ?? "target");
    mkdirSync(root, { recursive: true });
    const dir = mkdtempSync(path.join(root, "r3-tsasync-destructure-"));
    try {
      const input = path.join(dir, "main.ts");
      writeFileSync(input, source);
      for (const types of [false, true]) {
        const result = checkFile(input, { types });
        assert.equal(result.ok, false);
        const diagnostic = result.diagnostics.find(item => item.source === "compat");
        assert.ok(diagnostic, JSON.stringify(result));
        assert.match(diagnostic.message, /not supported.*destructure.*globalThis/);
      }
    } finally { if (!artifacts) rmSync(dir, { recursive: true, force: true }); }
  }
  assert.ok(compileFile(entry, hostFor("function unused() { const globalThis = {Promise: 1}; const {Promise} = globalThis; } console.log(1);")).workspaceData);
});

test("r3-tsasync wrapped timer names produce actionable errors, not internal exceptions", () => {
  for (const source of [
    "(setTimeout)(() => {}, 0);", "((setInterval))(() => {}, 0);",
    "(setTimeout as typeof setTimeout)(() => {}, 0);", "setTimeout!(() => {}, 0);",
  ]) reject(source, /Timer calls require a direct.*alternative: remove parentheses/);
});

for (const [name, source] of [
  ["deferred-once", `let value = 0;
    console.log("before");
    setTimeout(() => { console.log("timeout", value); return; console.log("unreachable"); }, 0);
    value = 7; console.log("after");`],
  ["cancel-cross-kind", `const a = setTimeout(() => { console.log("bad timeout"); }, 0);
    const b = setInterval(() => { console.log("bad interval"); }, 0);
    clearInterval(a); clearTimeout(b); clearTimeout(a);
    setTimeout(() => { console.log("survivor"); }, 0); console.log("scheduled");`],
  ["interval-self-cancel", `let count = 0;
    const handle = setInterval(() => { count++; console.log(count); if (count === 3) clearTimeout(handle); }, 1);
    console.log("start");`],
  ["nested", `setTimeout(() => {
    console.log("outer"); setTimeout(() => { console.log("inner"); }, 1); console.log("outer end");
    }, 1); console.log("start");`],
  ["single-evaluation", `let reads = 0; function delay() { reads++; return 1; }
    setTimeout(() => { console.log("fired", reads); }, delay()); console.log("reads", reads);`],
  ["start-handler", `let value = 0;
    onStart(() => { value = 2; setTimeout(() => { console.log("timer", value); }, 0); console.log("start", value); });
    value = 1; console.log("root", value);`],
  ["numeric-extremes", `let fired = 0;
    function arm(ms: number) { setTimeout(() => { fired++; if (fired === 6) console.log("all fired", fired); }, ms); }
    arm(NaN); arm(Infinity); arm(-Infinity); arm(2147483648); arm(-3); arm(0.5);`],
]) test(`r3-tsasync Node and compiled timers agree: ${name}`, async () => {
  const expected = await nodeLogs(source);
  for (const actual of vmLogs(source, name)) assert.deepEqual(actual, expected);
});

test("r3-tsasync delay normalization matches Node admission without timing assertions", () => {
  const inputs = [0, -3, 0.5, 1, 19.9, NaN, Infinity, -Infinity, 2147483648, 2147483647];
  // _idleTimeout retains fractions internally; Node truncates for scheduling.
  // Reading admission data avoids wall-clock assertions.
  const expected = inputs.map(ms => {
    const handle = setTimeout(() => {}, ms);
    try { return String(Math.trunc(handle._idleTimeout) / 1000); } finally { clearTimeout(handle); }
  });
  const source = `function inspect(ms: number) {
    const h = setTimeout(() => {}, ms); console.log(h.delay); clearTimeout(h);
  }
  ${inputs.map(ms => `inspect(${String(ms)});`).join(newline)}
  const defaulted = setTimeout(() => {}); console.log(defaulted.delay); clearTimeout(defaulted);`;
  for (const actual of vmLogs(source, "delay-normalization")) assert.deepEqual(actual, [...expected, "0.001"]);
});

test("r3-tsasync Promise continuations defer, so synchronous lowering must reject them", async () => {
  const source = `console.log("sync");
    Promise.resolve(1).then(value => console.log("promise", value));
    queueMicrotask(() => console.log("microtask")); console.log("end");`;
  assert.deepEqual(await nodeLogs(source), ["sync", "end", "promise 1", "microtask"]);
  reject(source, /Promise.*not supported.*microtask/);
});

test("r3-tsasync Node does not execute generator timer bodies", async () => {
  const source = "setTimeout(function* () { console.log('must not run'); }, 0); console.log('sync');";
  assert.deepEqual(await nodeLogs(source), ["sync"]);
  reject(source, /Generator.*not supported/);
});

test("r3-tsasync cooperative event callbacks keep invocation locals and do not return Promises", () => {
  // Expected values are ordinary JS lexical bindings. The wait/broadcast
  // choreography below is KN-specific, not an assertion about Node EventEmitter.
  const source = `let serial = 0;
    onMessage("go", () => {
      serial++; const local = serial; wait(0.05); console.log(local); return;
      console.log("unreachable");
    });
    broadcast("go"); broadcast("go");`;
  for (const actual of vmLogs(source, "event-frames")) assert.deepEqual(actual, ["1", "2"]);
});
