import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { pathToFileURL, fileURLToPath } from "node:url";
import ts from "typescript";
import { rejectedCases, expectedLocation, supportedCases } from "./r4-tsspread-cases.mjs";

// Exercise the real npm API in a context without process/fs globals, with the
// browser's portable paths and the same virtual declaration resources.
const context = vm.createContext({ URL });
const cache = new Map();
const typescript = new vm.SyntheticModule(["default"], function () { this.setExport("default", ts); }, { context });
const lib = path.resolve("node_modules/typescript/lib");
const resources = Object.fromEntries(fs.readdirSync(lib).filter(name => /^lib\..*\.d\.ts$/.test(name))
  .map(name => [name, fs.readFileSync(path.join(lib, name), "utf8")]));
resources["nekoc.d.ts"] = fs.readFileSync("ts/nekoc.d.ts", "utf8");
const declarations = new vm.SyntheticModule(["default"], function () { this.setExport("default", resources); }, { context });
function load(url) {
  if (cache.has(url)) return cache.get(url);
  const module = new vm.SourceTextModule(fs.readFileSync(fileURLToPath(url), "utf8"), {
    identifier: url, context, initializeImportMeta(meta) { meta.url = url; },
  });
  cache.set(url, module);
  return module;
}
const module = load(pathToFileURL(path.resolve("packages/nekoc/api.mjs")).href);
await module.link((specifier, parent) => {
  if (specifier === "typescript") return typescript;
  if (specifier === "./dist/resources.mjs") return declarations;
  if (specifier.startsWith("./dist/frontend/")) {
    return load(pathToFileURL(path.resolve("ts", specifier.slice("./dist/frontend/".length))).href);
  }
  return load(new URL(specifier, parent.identifier).href);
});
await module.evaluate();
// No wasm methods: every rejection must occur before assembly.
const api = module.namespace.api({});
for (const [, body, message] of rejectedCases) {
  const source = `// original browser source
  ${body}`;
  for (const imported of [false, true]) {
    const file = imported ? "/lib.ts" : "/main.ts";
    const files = { "/main.ts": imported ? 'import { value } from "./lib"; console.log(value());' : source };
    if (imported) files[file] = `${source}
export function value() { return 1; }`;
    for (const types of [true, false]) {
      const checked = api.check("/main.ts", { files, types });
      assert.equal(checked.ok, false);
      const diagnostic = checked.diagnostics.find(item => item.source === "compat");
      assert.ok(diagnostic.message.startsWith(message), JSON.stringify(diagnostic));
      assert.equal(diagnostic.code, message.startsWith("Array destructuring assignment") ? "NEKOC_TS_DESTRUCTURE" : "NEKOC");
      assert.deepEqual({ file: diagnostic.file, line: diagnostic.line, column: diagnostic.column }, expectedLocation(source, file));
    }
    assert.throws(() => api.compile("/main.ts", { files }), error => {
      assert.equal(error.name, "CompileError");
      assert.deepEqual(JSON.parse(JSON.stringify(error.location)), expectedLocation(source, file));
      return true;
    });
  }
}
// Supported syntax still reaches wasm assembly instead of the syntax guard.
for (const [, source] of supportedCases) {
  assert.throws(() => api.compile("/main.ts", { files: { "/main.ts": source } }), /assembleBcmkn/);
}
