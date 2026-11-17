import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { pathToFileURL, fileURLToPath } from "node:url";
import ts from "typescript";
import { compileFile } from "../ts/compile-ts.mjs";

const canonical = value => {
  // Imported files have native Windows paths in Node, POSIX paths in browser;
  // lexical-name hashes therefore differ. Keep a bijection, not erased IDs.
  const names = new Map();
  return JSON.parse(JSON.stringify(value).replace(/__nekoc_ts_\d+_/g, name => {
    if (!names.has(name)) names.set(name, `__nekoc_ts_${names.size}_`);
    return names.get(name);
  }));
};
// Run the package API in both a Node-like context and the actual browser
// branch (no process/node:fs). Capture the assembler boundary so this frontend
// test needs no downloaded wasm; CLI/Rust tests cover the real assembly/VM.
for (const browser of [false, true]) {
  const context = vm.createContext({ URL, ...(browser ? {} : { process }) });
  const cache = new Map();
  const synthetic = (name, value) => new vm.SyntheticModule(["default"], function () {
    this.setExport("default", value);
  }, { context, identifier: name });
  const typescript = synthetic("typescript", ts);
  const lib = path.resolve("node_modules/typescript/lib");
  const resources = Object.fromEntries(fs.readdirSync(lib).filter(name => /^lib\..*\.d\.ts$/.test(name))
    .map(name => [name, fs.readFileSync(path.join(lib, name), "utf8")]));
  resources["nekoc.d.ts"] = fs.readFileSync("ts/nekoc.d.ts", "utf8");
  const resourceModule = synthetic("resources", resources);
  const load = url => {
    if (cache.has(url)) return cache.get(url);
    const module = new vm.SourceTextModule(fs.readFileSync(fileURLToPath(url), "utf8"), {
      identifier: url, context, initializeImportMeta(meta) { meta.url = url; },
      importModuleDynamically: async specifier => {
        const imported = await import(specifier);
        const result = new vm.SyntheticModule(Object.keys(imported), function () {
          for (const key of Object.keys(imported)) this.setExport(key, imported[key]);
        }, { context });
        await result.link(() => {});
        await result.evaluate();
        return result;
      },
    });
    cache.set(url, module);
    return module;
  };
  const module = load(pathToFileURL(path.resolve("packages/nekoc/api.mjs")).href);
  await module.link((specifier, parent) => {
    if (specifier === "typescript") return typescript;
    if (specifier === "./dist/resources.mjs") return resourceModule;
    if (specifier.startsWith("./dist/frontend/")) return load(pathToFileURL(path.resolve("ts", path.basename(specifier))).href);
    return load(new URL(specifier, parent.identifier).href);
  });
  await module.evaluate();
  let assembled;
  const api = module.namespace.api({
    assembleBcmkn: report => { assembled = JSON.parse(report); return "{}"; },
    projectDiagnostics: () => "[]",
  });
  for (const name of ["probe", "return", "order", "local", "alias", "import"]) {
    const entry = `/tstopdestructure-${name}.ts`;
    const files = { [entry]: fs.readFileSync(`tests/fixtures/tstopdestructure-${name}.ts`, "utf8"),
      "/tstopdestructure-module.ts": fs.readFileSync("tests/fixtures/tstopdestructure-module.ts", "utf8") };
    // Use identical filenames so generated lexical names/IDs are comparable.
    const expected = compileFile(entry, { readFile: filename => files[filename.replaceAll("\\", "/").replace(/^[A-Za-z]:/, "")] });
    const result = api.compile(entry, { files });
    for (const report of [result.report, assembled]) {
      assert.deepEqual(canonical(report.workspaceData), canonical(expected.workspaceData), `${name}, browser=${browser}`);
      assert.deepEqual(canonical(report.procedures), canonical(expected.procedures), `${name} procedures, browser=${browser}`);
      assert.deepEqual(JSON.parse(JSON.stringify(report.initialValues)), expected.initialValues);
    }
    for (const types of [false, true]) {
      const checked = api.check(entry, { files, types });
      assert.equal(checked.ok, true, JSON.stringify(checked.diagnostics));
    }
  }
}
