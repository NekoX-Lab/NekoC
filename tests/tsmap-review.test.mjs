import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import vm from "node:vm";
import ts from "typescript";
import { compileFile, CompileError } from "../ts/compile-ts.mjs";
import { lowerTsNullable } from "../ts/tsfeat-nullable.mjs";

const entry = path.resolve("virtual/tsmap-review/main.ts");
function rejects(source, message, at) {
  assert.throws(() => compileFile(entry, { readFile: name => name === entry ? source : undefined }), error => {
    assert.ok(error instanceof CompileError);
    assert.match(error.message, message);
    assert.match(error.message, /use|save|store/i);
    assert.equal(path.resolve(error.location.file), entry);
    const offset = source.indexOf(at);
    assert.equal(error.location.line, source.slice(0, offset).split("\n").length);
    assert.equal(error.location.column, offset - source.lastIndexOf("\n", offset));
    return true;
  });
}

for (const [type, value] of [["string", '"ok"'], ["boolean", "true"], ["{n:number}", "{n:2}"]]) {
  for (const read of ["c.x", 'c["x"]']) test(`tsmap rejects getter-invalidated ${type} get after ${read}`, () => {
    const source = `const m=new Map<string,${type}>([["a",${value}]]);
class C {get x():number{m.delete("a");return 1;}}
const c=new C();
if(m.has("a")) console.log(${read},m.get("a")!);`;
    rejects(source, /property reads may invalidate.*store get's result.*!== undefined/, 'm.get("a")!');
  });
}

for (const collection of ['new Map<number,number>([[1,2],[3,4]])', "new Set([2,4])"]) {
  for (const body of ["var total=v;console.log(total);", "if(v===2){var total=v;}console.log(total);", "console.log(total);var total=v;"]) {
    test(`tsmap rejects function-scoped callback binding: ${collection} ${body}`, () => {
      rejects(`let total=100;const m=${collection};\nm.forEach(v=>{${body}});\nconsole.log(total);`, /callback var declarations.*let\/const.*initialize/, "var total");
    });
  }
}

for (const [type, method, argument] of [["Map<string,number>", "get", "key()"], ["Map<string,number>", "has", "key()"], ["Set<number>", "has", "value()"], ["Map<string,number>", "set", "key(),value()"], ["Set<number>", "add", "value()"]]) {
  for (const present of [false, true]) test(`tsmap diagnoses optional ${type}.${method} (present=${present})`, () => {
    const init = present ? `m:new ${type}()` : "";
    rejects(`interface B{m?:${type}}const b:B={${init}};\nlet calls=0;function key():string{calls++;return "a";}function value():number{calls++;return 2;}\nconsole.log(b.m?.${method}(${argument})??0);`, /collection method calls.*save the receiver.*!== undefined.*!== null/, `b.m?.${method}`);
  });
}

test("nullable unknown optional method fallback terminates with a diagnostic", () => {
  const file = ts.createSourceFile("missing-method.ts", 'interface B{m?:{n:number}}const b:B={};console.log(b.m?.missing()??0);', ts.ScriptTarget.Latest, true);
  assert.throws(() => lowerTsNullable(file), error => {
    assert.doesNotMatch(error.message, /stack size|recursion/i);
    assert.ok(error.location?.column > 1);
    return true;
  });
});

for (const kind of ["Map<string,number>", "Set<number>"]) test(`tsmap diagnoses definitely-null optional ${kind}`, () => {
  const argument = kind.startsWith("Map") ? '"a"' : "1";
  rejects(`let m:${kind}|null=null;\nconsole.log(m?.has(${argument})??false);`, /collection method calls.*save the receiver/, "m?.has");
});

// Real files and a relative CLI entry catch a module identity mismatch that
// a virtual host with absolute filenames alone cannot reproduce.
for (const [type, make, fill, result] of [
  ["Map<string,number>", 'new Map<string,number>([["a",7]])', 'm.set("b",8)', 'console.log(m.get("a")??0,m.get("b")??0,m.size);'],
  ["Set<number>", "new Set<number>([7])", "m.add(8)", "console.log(m.has(7),m.has(8),m.size);"],
  ["{m:Map<string,number>}", '{m:new Map<string,number>([["a",7]])}', 'm.m.set("b",8)', 'console.log(m.m.get("a")??0,m.m.get("b")??0,m.m.size);'],
]) test(`tsmap cross-file return, parameter and identity: ${type}`, () => {
  const root = path.resolve(process.env.NEKOC_SEMANTIC_ARTIFACT_DIR ?? "target");
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(path.join(root, "tsmap-modules-"));
  try {
    const lib = `export function make():${type}{return ${make};}export function fill(m:${type}):${type}{${fill};return m;}`;
    const main = `import {make,fill} from "./lib";const m:${type}=make();console.log(fill(m)===m);${result}`;
    writeFileSync(path.join(dir, "lib.ts"), lib);
    writeFileSync(path.join(dir, "main.ts"), main);
    const expected = [], exports = {};
    const console = { log: (...args) => expected.push(args.map(String).join(" ")) };
    const transpile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
    vm.runInNewContext(transpile(lib), { exports, console });
    vm.runInNewContext(transpile(main), { exports: {}, require: () => exports, console });
    const relative = path.relative(process.cwd(), path.join(dir, "main.ts"));
    assert.ok(compileFile(relative).workspaceData);
    assert.ok(compileFile(path.resolve(relative)).workspaceData);
    const binary = path.resolve("target/debug", process.platform === "win32" ? "nekoc.exe" : "nekoc");
    const output = path.join(dir, "main.bcmkn");
    const env = { ...process.env, NEKOC_FRONTEND: path.resolve("ts") };
    for (const args of [["check", relative, "--json"], ["build", relative, "-o", output], ["run", output, "--ticks", "120"]]) {
      const run = spawnSync(binary, args, { encoding: "utf8", env });
      assert.equal(run.status, 0, run.stderr || run.stdout);
      if (args[0] === "check") assert.equal(JSON.parse(run.stdout).ok, true);
      if (args[0] === "run") assert.deepEqual(JSON.parse(run.stdout).logs, expected);
    }
  } finally {
    if (!process.env.NEKOC_SEMANTIC_ARTIFACT_DIR) rmSync(dir, { recursive: true, force: true });
  }
});
