import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { pathToFileURL, fileURLToPath } from "node:url";
import ts from "typescript";
import { diagnosticCases } from "./tsstrreplace-diagnostics.mjs";

const context = vm.createContext({ URL });
const cache = new Map();
const typescript = new vm.SyntheticModule(["default"], function () { this.setExport("default", ts); }, { context });
function load(url) {
  if (cache.has(url)) return cache.get(url);
  const module = new vm.SourceTextModule(fs.readFileSync(fileURLToPath(url), "utf8"), {
    identifier: url, context, initializeImportMeta(meta) { meta.url = url; },
  });
  cache.set(url, module);
  return module;
}
const module = load(pathToFileURL(path.resolve(process.argv[2], "api.mjs")).href);
await module.link((specifier, parent) => specifier === "typescript" ? typescript : load(new URL(specifier, parent.identifier).href));
await module.evaluate();
let assemblies = 0;
const api = module.namespace.api({ assembleBcmkn: report => { assemblies++; return report; }, projectDiagnostics: () => "[]" });
const source = fs.readFileSync(new URL("fixtures/tsstrreplace.ts", import.meta.url), "utf8");
const files = { "/main.ts": source };
const checked = api.check("/main.ts", { files });
assert.equal(checked.ok, true, JSON.stringify(checked.diagnostics));
assert.ok(api.compile("/main.ts", { files }).report.procedures.length > 0);
assert.equal(assemblies, 2);
for (const expression of ['"abc".replace(/b/, "X")', '"abc".replaceAll("b", () => "X")', '"😀".replaceAll("", "X")']) {
  const files = { "/main.ts": `// original\nconsole.log(${expression});` };
  const checked = api.check("/main.ts", { files });
  assert.equal(checked.ok, false);
  assert.equal(checked.diagnostics.find(d => d.source === "compat").line, 2);
  assert.throws(() => api.compile("/main.ts", { files }), /String.replace/);
}
for (const item of diagnosticCases) {
  for (const imported of [false, true]) {
    const file = imported ? "/lib.ts" : "/main.ts";
    const files = imported ? { "/main.ts": 'import { value } from "./lib"; console.log(value());', [file]: item.source + '\nexport function value() { return 1; }' } : { [file]: item.source };
    for (const types of [false, true]) {
      const checked = api.check("/main.ts", { files, types });
      assert.equal(checked.ok, false);
      const diagnostic = checked.diagnostics.find(d => d.source === "compat");
      assert.match(diagnostic.message, item.message);
      assert.equal(diagnostic.file, file);
      assert.equal(diagnostic.line, item.line);
      assert.equal(diagnostic.column, item.column);
    }
    assert.throws(() => api.compile("/main.ts", { files }), error => {
      assert.equal(error.location.file, file);
      assert.equal(error.location.line, item.line);
      assert.equal(error.location.column, item.column);
      return true;
    });
  }
}
const nullableFiles = { "/main.ts": fs.readFileSync(new URL("fixtures/tsstrreplace-nullable.ts", import.meta.url), "utf8") };
assert.equal(api.check("/main.ts", { files: nullableFiles }).ok, true);
assert.doesNotThrow(() => api.compile("/main.ts", { files: nullableFiles }));
