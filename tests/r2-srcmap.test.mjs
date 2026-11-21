import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import ts from "typescript";
import { checkFile, compileFile } from "../ts/compile-ts.mjs";
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
      file: "r2-srcmap.ts",
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
    file: "r2-srcmap-lib.ts", line: 2, column: 3,
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
  assert.deepEqual(runtimeSourceLocation(original.statements[0], files, new WeakMap(), path.resolve,
    name => path.relative(path.dirname(file), name).replaceAll("\\", "/")),
    { file: "r2-srcmap.ts", line: 3, column: 1 });
  assert.equal(runtimeSourceLocation(generated.statements[1], files, new WeakMap(), path.resolve), null);
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

test("r2-srcmap never attributes reparsed execution to an unused same-text function", () => {
  const report = compile('function unused() {\n  setStyle(99);\n}\nonStart(() => {\n  setStyle( 99 );\n  console.log(typeof 0);\n});');
  const block = allBlocks(report).find(b => b.type === "set_sprite_style");
  assert.ok(block);
  assert.equal(report.sourceMap[block.id], undefined);
});

test("r2-srcmap inline return reporters retain definition origins across nested calls", () => {
  for (const body of ['return listItem("items", "any", 10);', 'return selectText("😀", 1, 1);']) {
    for (const nested of [false, true]) {
      const report = compile('import { bad } from "./r2-srcmap-lib";\nonStart(() => {\n  console.log(\n    bad()\n  );\n});',
        `export function bad() {\n  ${nested ? 'return inner();' : body}\n}\n${nested ? `function inner() {\n  ${body}\n}` : ''}`);
      const block = allBlocks(report).find(b => b.type === (body.includes('listItem') ? 'list_item' : 'text_select'));
      assert.deepEqual(report.sourceMap[block.id], {
        file: "r2-srcmap-lib.ts", line: nested ? 5 : 2, column: 10,
      });
    }
  }
  const local = compile('function bad() {\n  return selectText("😀", 1, 1);\n}\nonStart(() => { console.log(bad()); });');
  const block = allBlocks(local).find(b => b.type === 'text_select');
  assert.equal(local.sourceMap[block.id].line, 2);
  assert.equal(local.sourceMap[block.id].column, 10);
});

test("r2-srcmap recursive else-if reporters never inherit earlier branch statements", () => {
  for (const condition of ['listItem("items", "any", 10)', 'selectText("😀", 1, 1)']) {
    for (const prior of ['console.log("skip");', 'console.log("a");\n    console.log("b");']) {
      const source = `onStart(() => {\n  if (false) {\n    ${prior}\n  } else if (false) {\n    console.log("skip again");\n  } else if (\n    ${condition}\n  ) { console.log("yes"); }\n});`;
      const report = compile(source);
      const block = allBlocks(report).find(b => b.type === (condition.startsWith('listItem') ? 'list_item' : 'text_select'));
      assert.equal(report.sourceMap[block.id].line, source.split('\n').findIndex(l => l.includes(condition)) + 1);
      assert.equal(report.sourceMap[block.id].column, 5);
    }
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

test("r2-srcmap and r3 diagnostics share precise class origins without sharing path policy", () => {
  for (const imported of [false, true]) for (const inherited of [false, true]) {
    for (const item of [
      { member: 'bad() {\n    setStyle(99);\n  }', invoke: 'a.bad();', type: 'set_sprite_style', call: 'setStyle(99)' },
      { member: `constructor() {${inherited ? ' super();' : ''}\n    setStyle(99);\n  }`, invoke: 'console.log(a.x);', type: 'set_sprite_style', call: 'setStyle(99)' },
      { member: 'bad(n = (\n    selectText("😀", 1, 1)\n  )) { return n; }', invoke: 'console.log(a.bad());', type: 'text_select', call: 'selectText("😀", 1, 1)' },
    ]) {
      const declaration = `${inherited ? 'class Base { base = 0; }\n' : ''}class A${inherited ? ' extends Base' : ''} {\n  x = 1;\n  ${item.member}\n}\n`;
      const body = `${declaration}export function helper() {\n  const a = new A();\n  ${item.invoke}\n}\n`;
      const entry = path.resolve('r2-srcmap.ts');
      const library = path.resolve('r2-srcmap-lib.ts');
      const main = imported ? 'import { helper } from "./r2-srcmap-lib";\nonStart(() => { helper(); });' : `${body}onStart(() => { helper(); });`;
      const files = new Map([[entry, main], ...(imported ? [[library, body]] : [])]);
      const host = { readFile: name => files.get(name) };
      const source = imported ? body : main;
      const before = source.slice(0, source.indexOf(item.call)).split('\n');
      const expected = { file: imported ? 'r2-srcmap-lib.ts' : 'r2-srcmap.ts', line: before.length, column: before.at(-1).length + 1 };
      const report = compileFile(entry, host);
      const blocks = allBlocks(report).filter(b => b.type === item.type);
      assert.ok(blocks.length);
      for (const block of blocks) assert.deepEqual(report.sourceMap[block.id], expected, JSON.stringify({ imported, inherited, member: item.member }));

      const broken = { readFile: name => files.get(name)?.replace(item.call, 'missingApi()') };
      const result = checkFile(entry, { types: false, host: broken });
      assert.equal(result.ok, false);
      assert.equal(result.diagnostics.length, 1);
      const [diagnostic] = result.diagnostics;
      assert.equal(diagnostic.file.replaceAll('\\', '/'), (imported ? library : entry).replaceAll('\\', '/'));
      assert.equal(diagnostic.line, expected.line);
      assert.equal(diagnostic.column, expected.column);
      assert.equal(diagnostic.snippet, source.replace(item.call, 'missingApi()').split('\n')[expected.line - 1]);
      assert.ok(diagnostic.suggestion.length > 10);
      assert.throws(() => compileFile(entry, broken), error => {
        assert.deepEqual(error.diagnostics, result.diagnostics);
        return true;
      });
    }
  }
});

test("r2-srcmap persists entry-relative module identities across relocated native and virtual roots", () => {
  const reports = [];
  for (const root of [path.resolve("dist/alice/project"), path.resolve("dist/机器 B/deeper/project"), "/virtual"]) {
    const entry = path.resolve(root, "src/main.ts");
    const files = new Map([
      [entry, 'import { left } from "../left/util";\nimport { right } from "../right/util";\nonStart(() => { left(); right(); setStyle(99); });'],
      [path.resolve(root, "left/util.ts"), 'export function left() {\n  setStyle(97);\n}'],
      [path.resolve(root, "right/util.ts"), 'export function right() {\n\n  setStyle(98);\n}'],
    ]);
    const report = compileFile(entry, { readFile: name => files.get(name) });
    const locations = Object.values(report.sourceMap);
    assert.deepEqual([...new Set(locations.map(l => l.file))].sort(), ["../left/util.ts", "../right/util.ts", "main.ts"]);
    const styles = allBlocks(report).filter(b => b.type === "set_sprite_style");
    assert.deepEqual(styles.map(b => report.sourceMap[b.id]), [
      { file: "../left/util.ts", line: 2, column: 3 },
      { file: "../right/util.ts", line: 3, column: 3 },
      { file: "main.ts", line: 3, column: 34 },
    ]);
    for (const location of locations) {
      assert.equal(path.isAbsolute(location.file), false);
      assert.equal(location.file.includes("\\"), false);
    }
    // The diagnostic report's `source` is a host path, not persisted in .bcmkn.
    const { source: hostSource, ...artifact } = report;
    assert.equal(hostSource, entry);
    reports.push(artifact);
  }
  assert.deepEqual(reports[0], reports[1]);
  assert.deepEqual(reports[0], reports[2]);
});
