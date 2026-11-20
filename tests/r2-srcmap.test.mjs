import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import ts from "typescript";
import { compileFile } from "../ts/compile-ts.mjs";
import { runtimeSourceLocation } from "../ts/runtime-source-map.mjs";

function compile(source, imported) {
  const file = path.resolve("r2-srcmap.ts");
  const module = path.resolve("r2-srcmap-lib.ts");
  return compileFile(file, { readFile: name => name === file ? source : name === module ? imported : undefined });
}

function allBlocks(report) {
  return [report.workspaceData, ...report.resources.sprites.map(s => s.workspaceData),
    ...report.procedures.map(p => p.workspaceData)].flatMap(w => Object.values(w.blocks));
}

test("r2-srcmap uses filenames and one-based coordinates across sprites and recompiles", () => {
  const source = 'sprite("Cat", {}, () => {\n  onStart(() => {\n    setStyle(99);\n  });\n});';
  for (const prefix of ["", "// moved\n\n"]) {
    const report = compile(prefix + source);
    const block = allBlocks(report).find(b => b.type === "set_sprite_style");
    assert.deepEqual(report.sourceMap[block.id], {
      file: path.resolve("r2-srcmap.ts").replaceAll("\\", "/"),
      line: prefix ? 5 : 3, column: 5,
    });
    assert.ok(Object.values(report.sourceMap).every(l => l.file && l.line > 0 && l.column > 0));
  }
});

test("r2-srcmap retains the imported function's file and location", () => {
  const report = compile('import { bad } from "./r2-srcmap-lib";\nonStart(() => { bad(); });',
    'export function bad() {\n  setStyle(99);\n}');
  const block = allBlocks(report).find(b => b.type === "set_sprite_style");
  assert.deepEqual(report.sourceMap[block.id], {
    file: path.resolve("r2-srcmap-lib.ts").replaceAll("\\", "/"), line: 2, column: 3,
  });
});

test("r2-srcmap maps multi-line reporter inputs to their own span", () => {
  const report = compile('onStart(() => {\n  console.log(\n    listItem("items", "any", 10)\n  );\n});');
  const block = allBlocks(report).find(b => b.type === "list_item");
  assert.equal(report.sourceMap[block.id].line, 3);
  assert.equal(report.sourceMap[block.id].column, 5);
});

test("r2-srcmap does not mistake printed helper coordinates for original source", () => {
  const file = path.resolve("r2-srcmap.ts");
  const parse = text => ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const original = parse('\n\nsetStyle(99);\n');
  const generated = parse('const generated = 0;\nsetStyle(99);\nsetStyle(123);');
  const files = new Map([[file, original]]);
  assert.deepEqual(runtimeSourceLocation(generated.statements[1], files, new WeakMap(), path.resolve),
    { file: original.fileName, line: 3, column: 1 });
  assert.equal(runtimeSourceLocation(generated.statements[2], files, new WeakMap(), path.resolve), null);
  files.set(file, parse('setStyle(99);\nsetStyle(99);'));
  assert.equal(runtimeSourceLocation(generated.statements[1], files, new WeakMap(), path.resolve), null);
  for (const text of ['// setStyle(99);\nsetStyle( 99 );',
    'const text = "setStyle(99);";\nsetStyle( 99 );',
    'resetStyle(99);\nsetStyle( 99 );']) {
    files.set(file, parse(text));
    assert.equal(runtimeSourceLocation(generated.statements[1], files, new WeakMap(), path.resolve), null);
  }
});

test("r2-srcmap player connection and notice retain the complete runtime diagnostic", async () => {
  const { PlayerConnection } = await import("../web/player.js");
  const { PlayerFeedback } = await import("../web/player-feedback.js");
  const socket = { send() {}, close() { this.onclose?.(); } };
  const connection = new PlayerConnection(undefined, null);
  const opened = connection.open({}, { connect: () => socket });
  socket.onopen();
  socket.onmessage({ data: JSON.stringify({ ready: true }) });
  await opened;
  const message = 'invalid costume [actor 猫 (cat), C:/project/game.ts:7:3] at block b42';
  const frame = connection.frame({});
  socket.onmessage({ data: JSON.stringify({ error: message }) });
  await assert.rejects(frame, error => error.message === message);
  const elements = new Map();
  const feedback = new PlayerFeedback({ querySelector(selector) {
    if (!elements.has(selector)) elements.set(selector, {});
    return elements.get(selector);
  } });
  feedback.notice(message);
  assert.equal(elements.get("#notice-text").textContent, message);
  assert.equal(elements.get("#notice").hidden, false);
});
