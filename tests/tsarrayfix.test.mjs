import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { compileFile, checkFile, CompileError } from "../ts/compile-ts.mjs";
import { checkProject, readManifest } from "../tools/compat/kn-share-player-check.mjs";

const bin = path.resolve("target/debug", process.platform === "win32" ? "nekoc.exe" : "nekoc");
const run = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
};
for (const name of ["eval", "args", "snapshot", "identity", "named", "modules", "procedures"]) {
  test(`tsarrayfix: ${name} matches Node with and without optimization and uses share blocks`, async () => {
    const input = `tests/fixtures/tsarrayfix-${name}.ts`;
    const expected = JSON.parse(run(process.execPath, ["tests/tsarrayfix-oracle.mjs", input]));
    const manifest = await readManifest();
    mkdirSync("dist/tsarrayfix", { recursive: true });
    for (const optimize of [false, true]) {
      const output = `dist/tsarrayfix/${name}${optimize ? "-opt" : ""}.bcmkn`;
      run(bin, ["build", input, "-o", output, ...(optimize ? ["--optimize"] : [])]);
      assert.deepEqual(JSON.parse(run(bin, ["run", output, "--ticks", "120"])).logs, expected);
      const check = JSON.parse(run(bin, ["check", output, "--json"]));
      assert.equal(check.ok, true, JSON.stringify(check));
      const share = checkProject(JSON.parse(readFileSync(output, "utf8")), manifest);
      assert.equal(share.ok, true, JSON.stringify(share));
    }
  });
}

test("tsarrayfix: yielded reentry keeps invocation-local inputs and share-compatible blocks", async () => {
  const manifest = await readManifest();
  mkdirSync("dist/tsarrayfix", { recursive: true });
  for (const optimize of [false, true]) {
    const output = `dist/tsarrayfix/reentry${optimize ? "-opt" : ""}.bcmkn`;
    run(bin, ["build", "tests/fixtures/tsarrayfix-reentry.ts", "-o", output, ...(optimize ? ["--optimize"] : [])]);
    assert.deepEqual(JSON.parse(run(bin, ["run", output, "--ticks", "120"])).logs, ["1,3,0 2,3,9"]);
    assert.equal(JSON.parse(run(bin, ["check", output, "--json"])).ok, true);
    assert.equal(checkProject(JSON.parse(readFileSync(output, "utf8")), manifest).ok, true);
  }
});

for (const [name, expected] of [["map", ["3 2 1,2, 1"]], ["find", ["-1 3 0"]]]) {
  test(`tsarrayfix: DSL procedure ${name} review reproducer is rejected`, () => {
    const input = `tests/fixtures/tsarrayfix-proc-${name}-rejected.ts`;
    assert.deepEqual(JSON.parse(run(process.execPath, ["tests/tsarrayfix-oracle.mjs", input])), expected);
    assert.throws(() => compileFile(input), error => error instanceof CompileError
      && error.location?.line === 5 && /may not shrink.*move removals/.test(error.message));
    const check = checkFile(input);
    assert.equal(check.ok, false);
    assert.ok(check.diagnostics.some(d => d.line === 5 && /may not shrink/.test(d.message)));
  });
}

for (const method of ["map", "find", "findIndex"]) {
  for (const [label, definitions, invoke, diagnostic] of [
    ["direct", 'defineProc("bad", [], () => { deleteListItem("items", "last", 1); });', 'callProc("bad");', /may not shrink/],
    ["nested", 'defineProc("outer", [], () => { callProc("bad"); }); defineProc("bad", [], () => { copyList([], "items"); });', 'callProc("outer");', /may not shrink/],
    ["self", 'defineProc("bad", [], () => { self.list("items").remove("all", 1); });', 'self.callProc("bad");', /may not shrink/],
    ["function wrapper", 'defineProc("bad", [], () => { deleteListItem("items", "last", 1); }); function wrap() { callProc("bad"); }', 'wrap();', /may not shrink/],
    ["reporter", 'defineReporter("bad", [], () => { deleteListItem("items", "last", 1); returnValue(1); });', 'callReporter("bad");', /may not shrink/],
    ["self reporter", 'defineReporter("bad", [], () => { self.deleteListItem("items", "all", 1); returnValue(1); });', 'self.callReporter("bad");', /may not shrink/],
    ["recursive", 'defineProc("bad", [], () => { callProc("bad"); deleteListItem("items", "last", 1); });', 'callProc("bad");', /may not shrink/],
    ["mutual recursion", 'defineProc("outer", [], () => { callProc("bad"); }); defineProc("bad", [], () => { callProc("outer"); wait(0.1); });', 'callProc("outer");', /cannot yield/],
    ["reporter dispatch", 'defineReporter("bad", [], () => { broadcast("change"); returnValue(1); });', 'callReporter("bad");', /cannot yield/],
    ["unknown target", '', 'callProc("missing");', /statically known DSL procedure body/],
    ["nonliteral target", 'const target = "bad"; defineProc("bad", [], () => { deleteListItem("items", "last", 1); });', 'callProc(target);', /statically known DSL procedure body/],
  ]) test(`tsarrayfix: ${method} propagates DSL effects: ${label}`, () => {
    const source = `${definitions}\nconst a = [1, 2, 3];\na.${method}(x => { ${invoke} return x; });`;
    assert.throws(() => compileFile("tsarrayfix.ts", { readFile: () => source }), error =>
      error instanceof CompileError && error.location?.line === 3 && diagnostic.test(error.message)
      && /move|use/.test(error.message));
    const check = checkFile("tsarrayfix.ts", { types: false, host: { readFile: () => source } });
    assert.equal(check.ok, false);
    assert.ok(check.diagnostics.some(d => d.line === 3 && diagnostic.test(d.message)));
  });
}

const rejected = [
  'const a = [1]; a.includes(1, 0, 2);',
  'const a = [1]; a.indexOf(1, 0, 2);',
  'const a = [1]; a.lastIndexOf(1, 0, 2);',
  'const a = [1]; a.includes(1, undefined);',
  'const a = [1]; a.indexOf(1, undefined);',
  'const a = [1]; a.lastIndexOf(1, undefined);',
  'const a = [1]; a.pop(1);',
  'const a = [1]; a.shift(1);',
  'const a = [1]; a.reverse(1);',
  'const a = [1]; a.join(",", 1);',
  'const a = [1]; a.slice(0, 1, 2);',
  'const a = [1]; a.map(x => x, 1);',
  'const a = [1]; a.reduce((acc, x) => acc + x, 0, 1);',
  'const a = [1]; a.concat(...[[2], [3]]);',
  'const a = [1]; const value: any = 2; a.concat(value);',
  'const a = [1]; let value: number | number[] = 2; a.concat(value);',
  'const a = [1]; let value: number | number[] = [2]; a.concat(value);',
  'const a = [1]; a.unshift(...[2, 3]);',
  'const a = [1]; a.push(...[2, 3]);',
  'const a = [1]; a.splice(...[0, 1]);',
  'const a = [1, 2]; a.map(x => { a.pop(); return x; });',
  'const a = [1, 2]; const alias = a; a.map(x => { alias.length = 0; return x; });',
  'const a = [1, 2]; function shrink() { a.pop(); } a.map(x => { shrink(); return x; });',
  'const a = [1, 2]; const shrink = () => { const alias = a; alias.length = 0; }; a.find(x => { shrink(); return true; });',
  'const a = [1, 2]; a.findIndex((x, i, arr) => { arr.splice(0, 1); return false; });',
  'const a = [1, 2]; a.find(x => { wait(0.1); return false; });',
  'const a = [1, 2]; function change() { broadcast("shrink"); } a.map(x => { change(); return x; });',
];
for (const source of rejected) test(`tsarrayfix: located actionable diagnostic: ${source}`, () => {
  assert.throws(() => compileFile("tsarrayfix.ts", { readFile: () => source }), error =>
    error instanceof CompileError && error.location?.line > 0 && /omit|pass|remove|move|use|narrow/i.test(error.message));
  const result = checkFile("tsarrayfix.ts", { types: false, host: { readFile: () => source } });
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some(d => d.line > 0 && d.column > 0));
});

for (const [name, expected] of [["map", ["3 2 1,2, 1"]], ["find", ["-1 3 0"]]]) {
  test(`tsarrayfix: review named ${name} reproducer is rejected rather than miscompiled`, () => {
    const input = `tests/fixtures/tsarrayfix-named-${name}-rejected.ts`;
    assert.deepEqual(JSON.parse(run(process.execPath, ["tests/tsarrayfix-oracle.mjs", input])), expected);
    assert.throws(() => compileFile(input), error => error instanceof CompileError
      && error.location?.line === 4 && /may not shrink.*move removals/.test(error.message));
    const check = checkFile(input);
    assert.equal(check.ok, false);
    assert.ok(check.diagnostics.some(d => d.line === 4 && /may not shrink/.test(d.message)));
  });
}

test("tsarrayfix: imported legal array arguments pass full type and compatibility checking", () => {
  const check = checkFile("tests/fixtures/tsarrayfix-modules.ts");
  assert.equal(check.ok, true, JSON.stringify(check));
});

for (const method of ["map", "find", "findIndex"]) {
  for (const mutation of [
    'deleteListItem("items", "last", 1);',
    'self.deleteListItem("items", "all", 1);',
    'self.list("items").delete("last", 1);',
    'self.list("items").remove("all", 1);',
    'copyList([9], "items");',
    'self.copyList([9], "items");',
    'self.list("shorter").copyTo("items");',
  ]) {
    for (const indirect of [false, true]) test(`tsarrayfix: ${method} rejects named shrink ${mutation} indirect=${indirect}`, () => {
      const source = `appendList("items", 1); appendList("items", 2); appendList("items", 3);
const a = getList<number>("items");
${indirect ? `function shrink() { ${mutation} } const alias = shrink;` : ""}
a.${method}(x => { ${indirect ? "alias();" : mutation} return x; });`;
      assert.throws(() => compileFile("tsarrayfix.ts", { readFile: () => source }), error =>
        error instanceof CompileError && error.location?.line === 4
        && new RegExp(`Array\\.${method} callbacks may not shrink`).test(error.message)
        && /move removals after traversal/.test(error.message));
      const result = checkFile("tsarrayfix.ts", { types: false, host: { readFile: () => source } });
      assert.equal(result.ok, false);
      assert.ok(result.diagnostics.some(d => d.line === 4 && d.column > 0 && /may not shrink/.test(d.message)));
    });
  }
}

for (const body of [
  'const value: any = 3; return [1, 2].concat(value);',
  'let value: number | number[] = [3]; return [1, 2].concat(value);',
  'const value: any = 1; return [1, 2].indexOf(1, value);',
  'deleteListItem("items", "last", 1); return 0;',
]) test(`tsarrayfix: imported diagnostics retain type and shrink checks: ${body}`, () => {
  const entry = path.resolve("tsarrayfix-entry.ts"), module = path.resolve("tsarrayfix-methods.ts");
  const shrink = body.startsWith("deleteListItem");
  const files = new Map([
    [entry, shrink
      ? 'import { action } from "./tsarrayfix-methods"; const a = getList<number>("items"); a.map(x => { action(); return x; });'
      : 'import { action } from "./tsarrayfix-methods"; console.log(action());'],
    [module, `export function action() { ${body} }`],
  ]);
  assert.throws(() => compileFile(entry, { readFile: name => files.get(path.resolve(name)) }), error =>
    error instanceof CompileError && error.location?.line === 1
    && (shrink ? /may not shrink/.test(error.message) : /narrow|number/.test(error.message)));
});
