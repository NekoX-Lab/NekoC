import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { checkFile, compileFile, compileErrorDiagnostics, formatDiagnostic } from "../ts/compile-ts.mjs";
import { enrichDiagnostic } from "../ts/diagnostics.mjs";
import { frontendFiles, docs } from "../tools/package-release.mjs";

const frontend = path.resolve(import.meta.dirname, "../ts/compile-ts.mjs");
const keys = ["severity", "source", "code", "message", "file", "line", "column", "snippet", "suggestion"].sort();
const portable = file => file.replaceAll("\\", "/");
test("r3: release packages include diagnostics implementation and contract", () => {
  assert.ok(frontendFiles.includes("diagnostics.mjs"));
  assert.ok(docs.includes("ts-diagnostics.md"));
});

function withFiles(files, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nekoc-r3-errors-"));
  try {
    for (const [name, source] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), source);
    return run(path.join(dir, "main.ts"), dir);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
function assertLocated(d, file, source) {
  assert.deepEqual(Object.keys(d).sort(), keys);
  assert.equal(portable(d.file), portable(file));
  assert.ok(Number.isInteger(d.line) && d.line > 0);
  assert.ok(Number.isInteger(d.column) && d.column > 0);
  assert.equal(d.snippet, source.split(/\r\n|[\n\r\u2028\u2029]/)[d.line - 1]);
  assert.ok(d.suggestion.length > 10);
  const text = formatDiagnostic(d);
  assert.ok(text.startsWith(`${d.file}:${d.line}:${d.column}: error ${d.code}:`), text);
  assert.ok(text.includes(`[${d.source}]`), text);
  assert.ok(text.includes(`| ${d.snippet}`), text);
  assert.match(text, /\^\n  help: /);
  assert.doesNotMatch(d.message, /\n  help:|\n  \d+ \|/);
}

test("r3: type failures and unsupported constructs remain separate diagnostics", () => {
  const source = '// heading\nonStart(() => {\n  let x: number = "bad";\n  const map = new WeakMap();\n});\n';
  withFiles({ "main.ts": source }, file => {
    const { ok, diagnostics } = checkFile(file);
    assert.equal(ok, false);
    const typed = diagnostics.find(d => d.code === "TS2322");
    const compat = diagnostics.find(d => d.source === "compat");
    assert.equal(typed.source, "types");
    assert.equal(typed.line, 3);
    assert.equal(compat.line, 4);
    assert.match(typed.suggestion, /type|conversion/);
    for (const d of diagnostics) assertLocated(d, file, source);
    const untyped = checkFile(file, { types: false });
    assert.deepEqual(untyped.diagnostics, [compat]);
  });
});

test("r3: parser failures keep syntax category with and without type checking", () => {
  const source = "// heading\r\nlet a = ;\r\nlet b = ;\r\n";
  withFiles({ "main.ts": source }, file => {
    const untyped = checkFile(file, { types: false });
    const typed = checkFile(file);
    assert.deepEqual(typed.diagnostics, untyped.diagnostics);
    assert.equal(typed.diagnostics.length, 2);
    for (const d of typed.diagnostics) {
      assert.equal(d.source, "syntax");
      assertLocated(d, file, source);
    }
  });
});

test("r3: imported and lowered code uses original snippets in memory hosts", () => {
  const entry = path.resolve("virtual/r3-errors/main.ts");
  const library = path.resolve("virtual/r3-errors/lib.ts");
  const source = 'import { helper } from "./lib";\nonStart(() => { helper(); });\n';
  for (const imported of [
    '// lib\nexport function helper() {\n  [1].map(x => missingApi(x));\n}\n',
    '// lib\nexport async function helper() {}\n',
    '// lib\nexport function helper() { let x = ; }\n',
  ]) {
    const files = new Map([[entry, source], [library, imported]]);
    const host = { readFile: name => files.get(path.resolve(name)) };
    const { diagnostics } = checkFile(entry, { types: false, host });
    assert.equal(diagnostics.length, 1);
    assertLocated(diagnostics[0], library, imported);
    assert.throws(() => compileFile(entry, host), error => {
      assert.deepEqual(error.diagnostics, diagnostics);
      // Snippets survive after a memory host is no longer accessible.
      assert.deepEqual(compileErrorDiagnostics(error), diagnostics);
      assert.doesNotMatch(diagnostics[0].snippet, /__nekoc/);
      if (imported.includes("async")) assert.match(diagnostics[0].suggestion, /remove async\/await/);
      return true;
    });
  }
});

test("r3: class helpers retain precise original member locations", () => {
  const cases = [
    { body: "  x = 1;\n  bad() {\n    missingApi();\n  }", line: 4, column: 5, call: "a.bad();" },
    { body: "  x = 1;\n  constructor() {\n    missingApi();\n  }", line: 4, column: 5 },
    { body: "  x = missingApi();", line: 2, column: 7 },
    { body: "  x = (\n    missingApi()\n  );", line: 3, column: 5 },
    { body: "  x = 1;\n  bad() {\n    [1].map(x => {\n      return missingApi(x);\n    });\n  }", line: 5, column: 14, call: "a.bad();" },
    // Trigger both method-text edits and whole-file value reprinting.
    { body: '  x = 1;\n  bad() {\n    console.log("abc".slice(1));\n    const kind = typeof 1;\n    missingApi();\n  }', line: 6, column: 5, call: "a.bad();" },
  ];
  for (const item of cases) for (const imported of [false, true]) for (const inherited of [false, true]) {
    const prefix = inherited ? "class Base { base = 0; }\n" : "";
    const body = inherited ? item.body.replace("constructor() {", "constructor() { super();") : item.body;
    const declaration = `${prefix}class A${inherited ? " extends Base" : ""} {\n${body}\n}\n`;
    const call = item.call ?? "console.log(a.x);";
    const library = declaration + `export function helper() {\nlet a = new A();\n${call}\n}\n`;
    const source = imported ? 'import { helper } from "./lib";\nonStart(() => { helper(); });\n'
      : declaration + `let a = new A();\nonStart(() => { ${call} });\n`;
    withFiles({ "main.ts": source, ...(imported ? { "lib.ts": library } : {}) }, (file, dir) => {
      const expectedFile = imported ? path.join(dir, "lib.ts") : file;
      const result = checkFile(file, { types: false });
      assert.equal(result.ok, false);
      assert.equal(result.diagnostics.length, 1);
      const [d] = result.diagnostics;
      assert.match(d.message, /missingApi/);
      assertLocated(d, expectedFile, imported ? library : source);
      assert.equal(d.line, item.line + Number(inherited));
      assert.equal(d.column, item.column);
      assert.match(d.snippet, /missingApi/);
      assert.throws(() => compileFile(file), error => {
        assert.deepEqual(error.diagnostics, result.diagnostics);
        return true;
      });
    });
  }
});

test("r3: class default parameters retain precise original initializer locations", () => {
  for (const constructor of [false, true]) for (const multiline of [false, true])
    for (const imported of [false, true]) for (const inherited of [false, true]) {
      const initializer = multiline ? "(\n    missingApi()\n  )" : "missingApi()";
      const member = constructor ? "constructor" : "bad";
      const prefix = inherited ? "class Base { base = 0; }\n" : "";
      const declaration = `${prefix}class A${inherited ? " extends Base" : ""} {\n  x = 1;\n  ${member}(n = ${initializer}) {\n${constructor && inherited ? "    super();\n" : ""}${constructor ? "    this.x = n;" : "    return n;"}\n  }\n}\n`;
      const invoke = `const a = new A();\nconsole.log(${constructor ? "a.x" : "a.bad()"});`;
      const library = declaration + `export function helper() {\n${invoke}\n}\n`;
      const source = imported ? 'import { helper } from "./lib";\nonStart(() => { helper(); });\n'
        : declaration + `onStart(() => {\n${invoke}\n});\n`;
      withFiles({ "main.ts": source, ...(imported ? { "lib.ts": library } : {}) }, (file, dir) => {
        const expectedFile = imported ? path.join(dir, "lib.ts") : file;
        const original = imported ? library : source;
        const host = { readFile: name => name === file ? source : name === expectedFile ? original : undefined };
        for (const memory of [false, true]) {
          const result = checkFile(file, { types: false, ...(memory ? { host } : {}) });
          assert.equal(result.ok, false);
          assert.equal(result.diagnostics.length, 1);
          const [d] = result.diagnostics;
          assert.match(d.message, /Unsupported expression call: missingApi/);
          assertLocated(d, expectedFile, original);
          assert.equal(d.line, (multiline ? 4 : 3) + Number(inherited));
          assert.equal(d.column, multiline ? 5 : constructor ? 19 : 11);
          assert.match(d.snippet, /missingApi\(\)/);
          assert.throws(() => compileFile(file, memory ? host : undefined), error => {
            assert.deepEqual(error.diagnostics, result.diagnostics);
            return true;
          });
        }
        // The failure must originate in the default expression, not a class
        // construct that would be rejected even with a supported initializer.
        const validHost = { readFile: name => host.readFile(name)?.replace("missingApi()", "Math.abs(-2)") };
        assert.ok(compileFile(file, validHost));
      });
    }
});

test("r3: default origins survive parameter offsets and constructor forwarding", () => {
  const cases = [
    'class A { static bad(n = (\n    missingApi()\n  )) { return n; } }\nconsole.log(A.bad());',
    'class A { x = 1; constructor(n = (\n    missingApi()\n  )) { this.x = n; } }\nclass B extends A {}\nconsole.log(new B().x);',
    'class Base { base = 0; }\nclass A extends Base { x = 1; constructor(seed: number, n = 1, last = (\n    missingApi()\n  )) { super(); this.x = last; } }\nconsole.log(new A(3).x);',
    'class Base { x = 1; constructor(n = (\n    missingApi()\n  )) { this.x = n; } }\nclass A extends Base { constructor() { super(); } }\nconsole.log(new A().x);',
    'class Base { base = 0; }\nclass A extends Base { bad(first: number, n = (\n    missingApi()\n  )) { return n; } }\nconsole.log(new A().bad(1));',
    'class Base { bad(n = 1) { return n; } }\nclass A extends Base { bad(n = (\n    missingApi()\n  )) { return n; } }\nfunction invoke(a: Base) { return a.bad(); }\nconsole.log(invoke(new A()));',
    'class Base { base = 0; }\nclass A extends Base { bad(n = Math.abs(\n    missingApi()\n  )) { return n; } }\nconsole.log(new A().bad());',
  ];
  for (const source of cases) {
    withFiles({ "main.ts": source }, file => {
      const result = checkFile(file, { types: false });
      assert.equal(result.ok, false);
      assert.equal(result.diagnostics.length, 1);
      const [d] = result.diagnostics;
      assert.match(d.message, /missingApi/);
      assertLocated(d, file, source);
      // Calculate from the source call, independently of helper positions.
      const before = source.slice(0, source.indexOf("missingApi")).split("\n");
      assert.equal(d.line, before.length);
      assert.equal(d.column, before.at(-1).length + 1);
      assert.match(d.snippet, /missingApi\(\)/);
    });
  }
});

test("r3: imported type errors retain the dependency's source", () => {
  const imported = '// library\nexport const x: number = "bad";\n';
  withFiles({ "main.ts": 'import { x } from "./lib"; console.log(x);', "lib.ts": imported }, (file, dir) => {
    const d = checkFile(file).diagnostics.find(d => d.code === "TS2322");
    assert.equal(d.source, "types");
    assertLocated(d, path.join(dir, "lib.ts"), imported);
  });
});

test("r3: target rejections expose a source snippet and the supported rewrite", () => {
  const source = '// target\nonStart(() => {\n  forRange("i", 1, 3, 1, () => { console.log(1); });\n});';
  withFiles({ "main.ts": source }, file => {
    const result = checkFile(file, { types: false, target: "kitten4" });
    assert.equal(result.ok, false);
    const [d] = result.diagnostics;
    assert.equal(d.source, "compat");
    assertLocated(d, file, source);
    assert.match(d.message, /Kitten 4/);
    assert.match(d.suggestion, /ordinary for/);
    assert.doesNotMatch(d.message, /alternative:/i);
  });
});

test("r3: tabs, Unicode and EOF have source-accurate carets", () => {
  for (const source of [
    'onStart(() => {\r\n\tconsole.log("猫😀"); missingApi();\r\n});',
    'onStart(() => {\n',
    'console.log("猫");\u2028missingApi();',
  ]) {
    withFiles({ "main.ts": source }, file => {
      const result = checkFile(file, { types: false });
      assert.equal(result.ok, false);
      assert.ok(result.diagnostics.length > 0);
      for (const d of result.diagnostics) {
        assertLocated(d, file, source);
        const caret = formatDiagnostic(d).split("\n").find(line => line.endsWith("^"));
        assert.equal(caret.split("| ")[1], `${d.snippet.slice(0, d.column - 1).replace(/[^\t]/g, " ")}^`);
      }
    });
  }
});

test("r3: missing source and internal failures retain honest locations and suggestions", () => {
  withFiles({}, file => {
    const [d] = checkFile(file, { types: false }).diagnostics;
    assert.equal(d.file, file);
    assert.equal(d.line, undefined);
    assert.equal(d.column, undefined);
    assert.equal(d.snippet, null);
    assert.match(d.suggestion, /path|readable/);
    assert.doesNotMatch(formatDiagnostic(d), /:1:1|\|/);
  });
  const host = { readFile() { throw new Error("broken reader"); } };
  const [d] = checkFile("main.ts", { types: false, host }).diagnostics;
  assert.equal(d.code, "NEKOC_INTERNAL");
  assert.equal(d.snippet, null);
  assert.match(d.suggestion, /minimal reproduction/);
  assert.equal(enrichDiagnostic(d, host.readFile).message, d.message);
});

test("r3: frontend check and compile JSON have the same stable envelope and diagnostics", () => {
  const source = '// main\nonStart(() => {\n  missingApi();\n});';
  withFiles({ "main.ts": source }, (file, dir) => {
    const output = path.join(dir, "out.json");
    const invoke = args => spawnSync(process.execPath, [frontend, ...args], { encoding: "utf8" });
    const checked = invoke(["--check", "--no-types", "--json", file]);
    const compiled = invoke(["--json", file, output]);
    for (const result of [checked, compiled]) {
      assert.equal(result.status, 1, result.stderr);
      assert.equal(result.stderr, "");
      const json = JSON.parse(result.stdout);
      assert.deepEqual(Object.keys(json).sort(), ["diagnostics", "ok"]);
      assert.equal(json.ok, false);
      assertLocated(json.diagnostics[0], file, source);
      assert.equal(fs.existsSync(output), false);
    }
    assert.deepEqual(JSON.parse(compiled.stdout), JSON.parse(checked.stdout));
    const text = invoke([file, output]);
    assert.equal(text.stdout, "");
    assert.equal(text.stderr.trim(), JSON.parse(checked.stdout).diagnostics.map(formatDiagnostic).join("\n"));
    fs.writeFileSync(file, 'onStart(() => { console.log("ok"); });');
    for (const args of [["--check", "--json", file], ["--json", file, output]]) {
      const result = invoke(args);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      assert.deepEqual(JSON.parse(result.stdout), { ok: true, diagnostics: [] });
    }
  });
});
