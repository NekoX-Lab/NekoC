import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { compileFile, checkFile } from "../ts/compile-ts.mjs";
import { readManifest } from "../tools/compat/kn-share-player-check.mjs";
import { baseline, chainSource, distinctSource, warpSource, controlColorSource, prepare, repeated } from "./tsinlinebudget-cases.mjs";

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
  assert.ok(!boundary(51).procedures.some(p => p.name === "boundary"));
  assert.ok(boundary(52).procedures.some(p => p.name === "boundary"));
});

test("tsinlinebudget bounds actual nested arguments at entry/event call sites", () => {
  for (const [depth, count, procedures] of [[2, 9, 0], [4, 33, 0], [6, 84, 3], [8, 122, 9], [10, 160, 15], [12, 198, 21]]) {
    const source = distinctSource(depth);
    const report = compile(source);
    assert.equal(blocks(report).length, count, `depth=${depth}`);
    assert.equal(report.procedures.length, procedures);
    assert.ok(count < 1000);
    const root = compile(source.replace("onStart(() => {", "").replace(/\}\);$/, ""));
    assert.ok(blocks(root).length < 1000);
    const sprite = compile(source.replace("onStart(() => {", 'sprite("test", {}, self => { self.onStart(() => {').replace(/\}\);$/, "}); });"));
    assert.ok(sprite.procedures.some(p => /^f\d+$/.test(p.name)) || depth < 6);
  }
});

test("tsinlinebudget counts static calls expanded inside control DSL callbacks", () => {
  for (const [depth, count, procedures] of [[2, 44, 4], [4, 503, 33], [6, 518, 34], [8, 638, 44], [10, 785, 56], [12, 800, 57]]) {
    const report = compile(warpSource(depth));
    assert.equal(blocks(report).length, count, `warp depth=${depth}`);
    assert.equal(report.procedures.length, procedures);
    assert.ok(count < 1000);
    if (depth >= 4) assert.ok(report.procedures.some(p => /^f\d+$/.test(p.name)));
  }
  for (const wrapper of ["repeat(1, () =>", "repeatTimes(1, () =>", "ifThen(true, () =>"]) {
    const source = warpSource(8).replaceAll("warp(() =>", wrapper);
    const report = compile(source);
    assert.ok(blocks(report).length < 1000, wrapper);
    assert.ok(report.procedures.some(p => /^f\d+$/.test(p.name)), wrapper);
  }
});

test("tsinlinebudget preserves direct builtin RGB arguments and their transitive dependencies", () => {
  const functions = `function rgb(x: number): number { return ${repeated("x")}; }
    function indirect(x: number): number { return rgb(x); }`;
  for (const body of ["setPenColor(rgb(1));", "setPenColor(indirect(1));",
    "onStart(() => { setPenColor(rgb(1)); });",
    'sprite("test", {}, self => { self.onStart(() => { self.setPenColor(indirect(1)); }); });']) {
    const report = compile(functions + body);
    assert.ok(!report.procedures.some(p => ["rgb", "indirect"].includes(p.name)), body);
    const workspaces = [report.workspaceData, ...report.resources.sprites.map(s => s.workspaceData)];
    const colors = workspaces.flatMap(w => Object.values(w.blocks)).filter(b => b.type === "self_set_pen_color");
    assert.equal(colors.length, 1);
    assert.equal(colors[0].fields.color, "#00008c");
  }
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

test("tsinlinebudget preserves outer RGB bindings through inline control bodies", () => {
  for (const control of ["warp", "repeatTimes", "ifThen"]) {
    for (const indirect of [false, true]) for (const many of [false, true]) for (const sprite of [false, true]) {
      const source = controlColorSource(control, indirect, many, sprite);
      const report = compile(source);
      const label = JSON.stringify({ control, indirect, many, sprite });
      assert.ok(!report.procedures.some(p => /^(paint|color)( |$)/.test(p.name)), label);
      const colors = [report.workspaceData, ...report.procedures.map(p => p.workspaceData),
        ...report.resources.sprites.map(s => s.workspaceData)]
        .flatMap(w => Object.values(w.blocks)).filter(b => b.type === "self_set_pen_color");
      assert.equal(colors.length, many ? 100 : 1, label);
      assert.ok(colors.every(b => b.fields.color === "#00008c"), label);
      assert.equal(checkFile("tsinlinebudget.ts", { types: false, host: { readFile: () => source } }).ok, true, label);
    }
    const args = control === "repeatTimes" ? "1, " : control === "ifThen" ? "true, " : "";
    const receiver = control === "ifThen" ? "" : "self.";
    const source = `function rgb(x: number): number { return ${repeated("x")}; }
      sprite("test", {}, self => { self.onStart(() => {
        ${receiver}${control}(${args}() => { self.setPenColor(rgb(1)); });
      }); });`;
    const report = compile(source);
    assert.ok(!report.procedures.some(p => p.name === "rgb"), control);
    const colors = report.resources.sprites.flatMap(s => Object.values(s.workspaceData.blocks))
      .filter(b => b.type === "self_set_pen_color");
    assert.equal(colors.length, 1, control);
    assert.equal(colors[0].fields.color, "#00008c", control);
  }
  const nested = compile(controlColorSource("warp", true, false, false)
    .replace("color(x);", "repeatTimes(1, () => { ifThen(true, () => { color(x); }); });"));
  assert.ok(!nested.procedures.some(p => /^(paint|color)( |$)/.test(p.name)));
  assert.equal(blocks(nested).find(b => b.type === "self_set_pen_color").fields.color, "#00008c");
});

test("tsinlinebudget does not treat array callbacks as outer RGB control bodies", () => {
  const report = compile(`function wide(x: number): number {
    const values = [1, 2].map(value => { setPenColor(140); return value + 1; });
    return ${repeated("x")};
  } onStart(() => { console.log(wide(2)); });`);
  assert.ok(report.procedures.some(p => p.name === "wide"));
  assert.ok(report.procedures.some(p => /^__map/.test(p.name)));
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
