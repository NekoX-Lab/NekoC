import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { compileFile, checkFile, CompileError } from "../ts/compile-ts.mjs";
import { readManifest } from "../tools/compat/kn-share-player-check.mjs";

const compile = source => compileFile("knterminalshape.ts", { readFile: () => source });
const workspaces = report => [report.workspaceData, ...report.procedures.map(p => p.workspaceData),
  ...report.resources.sprites.map(s => s.workspaceData)];

for (const [api, type] of [["deleteClone", "dispose_clone"], ["restart", "restart"]]) {
  test(`knterminalshape diagnoses ${api} next in direct, nested, inline and procedure stacks`, () => {
    const bodies = [
      `${api}(); console.log("after");`,
      `if (true) { ${api}(); console.log("after"); }`,
      `while (true) { ${api}(); console.log("after"); }`,
      `repeatTimes(2, () => { ${api}(); console.log("after"); });`,
      `warp(() => { ${api}(); console.log("after"); });`,
    ];
    const sources = bodies.map(body => `onStart(() => {\n${body}\n});`);
    sources.push(`function end() {\n${api}();\n} onStart(() => { end(); console.log("after"); });`,
      `defineProc("end", ["n"], () => {\n${api}(); console.log("after");\n});`,
      `sprite("cat", {}, self => { self.onStart(() => {\nself.${api}(); console.log("after");\n}); });`);
    for (const source of sources) {
      assert.throws(() => compile(source), error => error instanceof CompileError
        && error.code === "NEKOC_TERMINAL_NEXT" && error.message.includes(type)
        && error.message.includes("explicit if/loop/procedure")
        && error.location.line === 2 && error.location.column > 0, source);
      const checked = checkFile("knterminalshape.ts", { types: false, host: { readFile: () => source } });
      assert.equal(checked.ok, false, source);
      assert.equal(checked.report, null);
      assert.equal(checked.diagnostics[0].code, "NEKOC_TERMINAL_NEXT");
      assert.equal(checked.diagnostics[0].line, 2);
    }
  });

  test(`knterminalshape preserves enclosing continuations around ${api}`, async () => {
    const source = `
      function inlineEnd() { ${api}(); }
      defineProc("end", ["n"], () => { console.log(param("n")); ${api}(); });
      onStart(() => {
        if (getVar("condition")) { inlineEnd(); } else { console.log("else"); }
        console.log("after-if");
        repeatTimes(1, () => { ${api}(); }); console.log("after-loop");
        while (getVar("condition")) { ${api}(); } console.log("after-while");
        callProc("end", 1); console.log("after-proc");
      });`;
    const report = compile(source);
    const manifest = await readManifest();
    for (const workspace of workspaces(report)) {
      for (const block of Object.values(workspace.blocks)) {
        assert.ok(manifest.blocks.includes(block.type) || block.type === "procedures_2_stable_parameter", block.type);
        if (block.type === type) {
          assert.ok(!Object.values(workspace.connections[block.id] ?? {}).some(c => c.type === "next"));
        }
      }
    }
    const workspace = report.workspaceData;
    for (const type of ["controls_if", "repeat_n_times", "repeat_forever_until", "procedures_2_callnoreturn"]) {
      const block = Object.values(workspace.blocks).find(b => b.type === type);
      assert.ok(block, type);
      assert.ok(Object.values(workspace.connections[block.id]).some(c => c.type === "next"), type);
    }
  });

  test(`knterminalshape locates ${api} inside an imported inline helper`, () => {
    const files = {
      "main.ts": 'import { end } from "./helper"; onStart(() => { end(); console.log("after"); });',
      "helper.ts": `export function end() {\n  ${api}();\n}`,
    };
    const result = checkFile("main.ts", { types: false, host: { readFile: file => files[path.basename(file)] } });
    assert.equal(result.ok, false);
    assert.equal(result.diagnostics[0].code, "NEKOC_TERMINAL_NEXT");
    assert.equal(path.basename(result.diagnostics[0].file), "helper.ts");
    assert.equal(result.diagnostics[0].line, 2);
    assert.equal(result.diagnostics[0].column, 3);
  });
}

test("knterminalshape allows generated guard containers to carry the continuation", () => {
  for (const api of ["deleteClone", "restart"]) {
    for (const body of [
      `try { ${api}(); console.log("after"); } catch (e) { console.log(e); }`,
      `while (true) { if (getVar("done")) break; ${api}(); console.log("after"); }`,
    ]) {
      const report = compile(`onStart(() => { ${body} });`);
      for (const workspace of workspaces(report)) {
        for (const block of Object.values(workspace.blocks).filter(b => ["dispose_clone", "restart"].includes(b.type))) {
          assert.ok(!Object.values(workspace.connections[block.id] ?? {}).some(c => c.type === "next"));
        }
      }
    }
  }
});

test("knterminalshape catches a generated for-loop epilogue and the original sensing sample", () => {
  for (const source of [
    'onStart(() => { for (let i = 0; i < getVar<number>("limit"); i++) { deleteClone(); } });',
    fs.readFileSync(new URL("../samples/sensing_input_time.ts", import.meta.url), "utf8")
      .replace("if (true) { deleteClone(); }", "deleteClone();"),
  ]) assert.throws(() => compile(source), error => error.code === "NEKOC_TERMINAL_NEXT" && error.location.line > 0);
  assert.ok(compileFile("samples/sensing_input_time.ts"));
});

test("knterminalshape keeps stop's legal physical next for every dynamic scope", () => {
  for (const argument of ["", '"0"', '"1"', '"2"']) {
    const report = compile(`onStart(() => { stop(${argument}); console.log("after-stop"); });`);
    const stop = Object.values(report.workspaceData.blocks).find(b => b.type === "stop");
    assert.ok(Object.values(report.workspaceData.connections[stop.id]).some(c => c.type === "next"));
  }
});
