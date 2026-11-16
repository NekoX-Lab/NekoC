import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const logs = [];
vm.runInNewContext(ts.transpileModule(readFileSync(process.argv[2], "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2020 },
}).outputText, { console: { log: (...args) => logs.push(args.map(String).join(" ")) } }, { timeout: 5000 });
console.log(JSON.stringify(logs));
