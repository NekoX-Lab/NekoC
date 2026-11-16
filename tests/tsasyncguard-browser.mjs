import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { pathToFileURL, fileURLToPath } from "node:url";
import ts from "typescript";
import { asyncCases, expectedLocation, syncSource } from "./tsasyncguard-cases.mjs";

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
const api = module.namespace.api({});
for (const [, body] of asyncCases) {
  const source = `// original browser source\n  ${body}`;
  for (const imported of [false, true]) {
    const file = imported ? "/lib.ts" : "/main.ts";
    const files = { "/main.ts": imported ? 'import { value } from "./lib"; console.log(value());' : source };
    if (imported) files[file] = `${source}\nexport function value() { return 1; }`;
    for (const types of [true, false]) {
      const result = api.check("/main.ts", { files, types });
      assert.equal(result.ok, false);
      const diagnostic = result.diagnostics.find(d => d.source === "compat");
      assert.equal(diagnostic.code, "NEKOC", JSON.stringify({ body, imported, types, diagnostic }));
      assert.match(diagnostic.message, /not supported.*alternative:.*remove async\/await.*wait\(seconds\).*event state machine/);
      assert.deepEqual({ file: diagnostic.file, line: diagnostic.line, column: diagnostic.column }, expectedLocation(source, file));
    }
    assert.throws(() => api.compile("/main.ts", { files }), error => {
      assert.equal(error.name, "CompileError");
      assert.deepEqual(JSON.parse(JSON.stringify(error.location)), expectedLocation(source, file));
      return true;
    });
  }
}
// The synchronous program still reaches wasm assembly in browser mode.
assert.throws(() => api.compile("/main.ts", { files: { "/main.ts": syncSource } }), /assembleBcmkn/);
assert.throws(() => api.compile("main.ts", { files: { "/main.ts": syncSource } }), /assembleBcmkn/);
