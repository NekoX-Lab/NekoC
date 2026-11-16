import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { compileFile, checkFile } from "../ts/compile-ts.mjs";
import { readManifest } from "../tools/compat/kn-share-player-check.mjs";
import { prepare } from "./tsbitwise-cases.mjs";

const compile = source => compileFile("bitwise.ts", { readFile: () => source });
const blocks = report => [report.workspaceData, ...report.procedures.map(p => p.workspaceData)].flatMap(w => Object.values(w.blocks));

test("tsbitwise dynamic paths use only share-player blocks and valid custom procedure shapes", async () => {
  const { expected, report } = prepare();
  assert.ok(expected.length > 8000);
  const manifest = await readManifest();
  for (const block of blocks(report)) {
    assert.ok([...manifest.blocks, ...manifest.metadataBlocks].includes(block.type), block.type);
    if (block.type === "procedures_2_return_value") {
      assert.match(block.mutation, /items="1"/);
      assert.match(block.shadows.VALUE, /type="math_number"/);
    }
  }
  for (const p of report.procedures) {
    const definitions = new Set(blocks({ workspaceData: p.workspaceData, procedures: [] })
      .filter(b => b.type === "procedures_2_stable_parameter").map(b => b.id));
    for (const param of p.params.filter(p => p.type === "String")) assert.ok(definitions.has(param.id));
    for (const b of Object.values(p.workspaceData.blocks).filter(b => b.type === "procedures_2_parameter")) {
      assert.ok(definitions.has(/id="([^"]+)"/.exec(b.mutation)?.[1]));
    }
  }
});

test("tsbitwise constant folding creates no helpers; common patterns avoid bit loops", () => {
  const r = compile("console.log(5 & 3, 5 | 3, 5 ^ 3, ~1, 1 << 33, -16 >> 2, -1 >>> 0);");
  assert.equal(r.procedures.length, 0);
  assert.ok(!blocks(r).some(b => b.type === "math_arithmetic"));
  for (const expression of ["x | 0", "x >>> 0", "x & 255", "x << 13", "x >> 17", "x >>> 5"]) {
    const r = compile(`let x = -1.9; console.log(${expression});`);
    assert.ok(!blocks(r).some(b => /^(?:controls_whileUntil|repeat_|while)/.test(b.type)), expression);
    assert.ok(!r.procedures.some(p => /__nekocBit_(and|or|xor)/.test(p.name)), expression);
  }
});

test("tsbitwise nonnumeric operands and assignment values fail with location and guidance", () => {
  for (const body of ['let x: any = 3; console.log(x & 1);', 'let x = "3"; console.log(~x);',
    'let x = 1; console.log(x &= 3);']) {
    const result = checkFile("bitwise.ts", { types: false, host: { readFile: () => body } });
    assert.equal(result.ok, false, body);
    assert.ok(result.diagnostics[0].line >= 1);
    assert.match(result.diagnostics[0].message, /numeric|convert|split|Assignment/i);
  }
});

test("tsbitwise helpers are available in imports, callbacks, classes and sprite workspaces", () => {
  const files = new Map([
    [path.resolve("main.ts"), `import { mix } from "./mix";
      class Bits { value = 42; run(x: number) { this.value ^= x; return this.value >>> 0; } }
      let bits = new Bits(); console.log(bits.run(mix(17)));
      console.log([1, 2].map(x => x << 1).join(","));
      sprite("bits", {}, self => { self.onStart(() => { let n = 7; n &= 3; console.log(~n); }); });`],
    [path.resolve("mix.ts"), "export function mix(n: number): number { return (n ^ 123) >>> n; }"],
  ]);
  const report = compileFile("main.ts", { readFile: name => files.get(path.resolve(name)) });
  assert.ok(report.procedures.some(p => /__nekocBit_xor/.test(p.name)));
  assert.ok(report.resources.sprites.length > 0);
});
