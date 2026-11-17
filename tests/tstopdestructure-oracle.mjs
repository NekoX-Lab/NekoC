import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

// Run JavaScript, deferring the NekoC-only onStart registration until after
// the module body. This models the documented startup barrier, not JS syntax.
const logs = [], starts = [], modules = new Map();
const load = filename => {
  filename = path.resolve(filename);
  if (modules.has(filename)) return modules.get(filename).exports;
  const module = { exports: {} };
  modules.set(filename, module);
  const code = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
  vm.runInNewContext(`(function(module, exports, require) {\n${code}\n})(module, exports, require);`, {
    module, exports: module.exports,
    require: name => load(path.resolve(path.dirname(filename), `${name}.ts`)),
    onStart: callback => starts.push(callback),
    wait: () => {},
    console: { log: (...args) => logs.push(args.map(String).join(" ")) },
  }, { timeout: 5000 });
  return module.exports;
};
load(process.argv[2]);
for (const callback of starts) callback();
console.log(JSON.stringify(logs));
