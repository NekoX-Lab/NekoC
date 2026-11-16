import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { compileFile, checkFile } from "../ts/compile-ts.mjs";
import { readManifest } from "../tools/compat/kn-share-player-check.mjs";
import { baseline, chainSource, prepare, repeated } from "./tsinlinebudget-cases.mjs";

const compile = source => compileFile("tsinlinebudget.ts", { readFile: () => source });
const blocks = report => [report.workspaceData, ...report.procedures.map(p => p.workspaceData)]
  .flatMap(w => Object.values(w.blocks));

test("tsinlinebudget preserves the measured baseline inputs and bounds 2–12 layers", () => {
  for (const before of baseline) assert.equal(Buffer.byteLength(chainSource(before.depth)), before.bytes);
  const expected = [[2, 38, 1], [4, 178, 3], [6, 200, 4], [8, 292, 4], [10, 458, 7], [12, 498, 7]];
  for (const [depth, count, procedures] of expected) {
    const source = chainSource(depth);
    const report = compile(source);
    assert.equal(blocks(report).length, count, `depth=${depth}`);
    assert.equal(report.procedures.length, procedures, `depth=${depth}`);
    const lines = source.split("\n");
    const reordered = compile([...lines.slice(0, -1).reverse(), lines.at(-1)].join("\n"));
    assert.equal(blocks(reordered).length, count, `declaration order, depth=${depth}`);
    assert.equal(reordered.procedures.length, procedures, `declaration order, depth=${depth}`);
    assert.equal(checkFile("tsinlinebudget.ts", { types: false, host: { readFile: () => source } }).ok, true);
    assert.ok(count < 1000);
  }
});

test("tsinlinebudget retains small arithmetic and uses call multiplicity, not just function shape", () => {
  const source = count => `function modest(value: number): number { return ${repeated("value", 30)}; }
    let input = 2; onStart(() => { ${Array(count).fill("console.log(modest(input));").join("\n")} });`;
  assert.ok(!compile(source(1)).procedures.some(p => p.name === "modest"));
  assert.ok(compile(source(10)).procedures.some(p => p.name === "modest"));
  assert.ok(!compile("function twice(x: number) { return x * 2; } console.log(twice(3));")
    .procedures.some(p => p.name === "twice"));
  const boundary = count => compile(`function boundary(value: number): number { return ${repeated("value", count)}; }
    console.log(boundary(getVar<number>("input")));`);
  assert.ok(!boundary(85).procedures.some(p => p.name === "boundary"));
  assert.ok(boundary(86).procedures.some(p => p.name === "boundary"));
});

test("tsinlinebudget leaves compile-time string/name bindings and callback lowering alone", () => {
  const report = compile(`function named(name: string): number { return getVar<number>(name); }
    function text(value: string = "default"): string { return ${repeated("value")}; }
    onStart(() => { ${Array(100).fill('console.log(named("input"));').join("\n")}
      console.log(text()); console.log([1, 2].map(x => x * 2).join(",")); });`);
  assert.ok(!report.procedures.some(p => ["named", "text"].includes(p.name)));
  assert.ok(report.procedures.some(p => /^__map/.test(p.name)));
  const color = compile(`function color(rgb: number) { setPenColor(rgb); }
    function wrapper(rgb: number) { color(rgb); }
    function rgb(value: number): number { return ${repeated("value", 140)}; }
    onStart(() => { ${Array(100).fill("wrapper(rgb(1));").join("\n")} });`);
  assert.ok(!color.procedures.some(p => ["color", "wrapper"].includes(p.name)));
  assert.ok(!color.procedures.some(p => p.name === "rgb"));
  assert.ok(blocks(color).filter(b => b.type === "self_set_pen_color").every(b => b.fields.color === "#00008c"));
});

test("tsinlinebudget accounts for repeated parameters and substituted locals", () => {
  const report = compile(`function duplicate(x: number): number { return x+x; }
    function locals(x: number): number {
      const a = duplicate(x); const b = duplicate(a); const c = duplicate(b);
      const d = duplicate(c); const e = duplicate(d); const f = duplicate(e);
      const g = duplicate(f); return duplicate(g);
    }
    console.log(locals(getVar<number>("input")));`);
  assert.ok(report.procedures.some(p => p.name === "locals"));
  assert.ok(blocks(report).length < 200);
});

test("tsinlinebudget uses stable user names, parameter ids, source locations and share-compatible blocks", async () => {
  const { report } = prepare();
  const manifest = await readManifest();
  for (const block of blocks(report)) {
    assert.ok([...manifest.blocks, ...manifest.metadataBlocks].includes(block.type), block.type);
    if (block.type === "procedures_2_return_value") {
      assert.match(block.mutation, /items="1"/);
      assert.match(block.shadows.VALUE, /type="math_number"/);
    }
  }
  const wide = report.procedures.find(p => p.name === "wide");
  assert.deepEqual(wide.params.map(p => p.name), ["wide", "value", "unused"]);
  assert.equal(wide.id, "kn-proc-fn-wide");
  const implementation = report.procedures.find(p => p.name === "wide (implementation)");
  assert.ok(Object.keys(implementation.workspaceData.blocks).some(id => report.sourceMap[id]?.line === 4));
  for (const p of report.procedures) {
    const definitions = new Set(Object.values(p.workspaceData.blocks)
      .filter(b => b.type === "procedures_2_stable_parameter").map(b => b.id));
    for (const param of p.params.filter(p => p.type === "String")) assert.ok(definitions.has(param.id));
    for (const b of Object.values(p.workspaceData.blocks).filter(b => b.type === "procedures_2_parameter")) {
      assert.ok(definitions.has(/id="([^"]+)"/.exec(b.mutation)?.[1]));
    }
  }
});

test("tsinlinebudget applies to imported static functions and diagnoses user source, not implementation helpers", () => {
  const files = new Map([
    [path.resolve("main.ts"), 'import { wide } from "./lib"; console.log(wide(2));'],
    [path.resolve("lib.ts"), `export function wide(value: number): number { return ${repeated("value")}; }`],
  ]);
  assert.ok(compileFile("main.ts", { readFile: file => files.get(path.resolve(file)) })
    .procedures.some(p => p.name === "wide"));
  const bad = `\nfunction wide(value: number): number { return ${repeated("value")} + Number(JSON.parse("1")); }\nconsole.log(wide(2));`;
  assert.throws(() => compile(bad), error => {
    assert.equal(error.location.line, 2);
    assert.match(error.message, /JSON/);
    assert.doesNotMatch(error.message, /implementation/);
    return true;
  });
});
