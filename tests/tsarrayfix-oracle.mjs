import { readFileSync } from "node:fs";
import vm from "node:vm";
import path from "node:path";
import ts from "typescript";

const logs = [];
const procedures = new Map();
const returned = Symbol("DSL return");
const invoke = (name, args) => {
  try { return procedures.get(name)(...args); }
  catch (error) { if (error?.kind === returned) return error.value; throw error; }
};
const lists = new Map();
const list = name => {
  if (!lists.has(name)) lists.set(name, []);
  return lists.get(name);
};
const api = {
  onStart: body => body(),
  defineProc: (name, params, body) => procedures.set(name, body),
  defineReporter: (name, params, body) => procedures.set(name, body),
  callProc: (name, ...args) => invoke(name, args),
  callReporter: (name, ...args) => invoke(name, args),
  returnValue: value => { throw { kind: returned, value }; },
  appendList: (name, value) => list(name).push(value),
  getList: list,
  deleteListItem: (name, mode, index) => {
    const a = list(name);
    if (mode === "all") a.length = 0;
    else a.splice(mode === "last" ? a.length - 1 : index - 1, 1);
  },
  copyList: (source, target) => {
    const values = [...(typeof source === "string" ? list(source) : source)];
    list(target).splice(0, list(target).length, ...values);
  },
};
const modules = new Map();
const load = filename => {
  filename = path.resolve(filename);
  if (modules.has(filename)) return modules.get(filename).exports;
  const module = { exports: {} };
  modules.set(filename, module);
  vm.runInNewContext(ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText, { ...api, module, exports: module.exports,
    require: name => load(path.resolve(path.dirname(filename), `${name}.ts`)),
    console: { log: (...args) => logs.push(args.map(String).join(" ")) } }, { timeout: 5000 });
  return module.exports;
};
load(process.argv[2]);
console.log(JSON.stringify(logs));
