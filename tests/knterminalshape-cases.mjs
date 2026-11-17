import fs from "node:fs";
import vm from "node:vm";
import { compileFile } from "../ts/compile-ts.mjs";

// Node is the reference for ordinary continuation on an original actor. The
// physical terminal calls are no-ops there; restart/cancellation are tested
// separately against the engine's lifecycle rather than modeled as return.
const continuation = `
  function inlineEnd() { deleteClone(); }
  defineProc("end", ["n"], () => { console.log(param("n")); deleteClone(); });
  onStart(() => {
    if (true) { inlineEnd(); } else { console.log("wrong-else"); }
    console.log("after-if");
    if (false) { deleteClone(); } else { console.log("else"); }
    repeatTimes(2, () => { deleteClone(); }); console.log("after-loop");
    let n = 0; while (n < 2) { n++; deleteClone(); } console.log(n);
    callProc("end", 7); console.log("after-proc");
    warp(() => { repeatTimes(800, () => { if (true) { deleteClone(); } n++; }); }); console.log(n);
  });`;
const expected = [], procedures = new Map();
let argument;
vm.runInNewContext(continuation, {
  console: { log: value => expected.push(String(value)) },
  deleteClone() {}, onStart: body => body(), warp: body => body(),
  repeatTimes: (n, body) => { for (let i = 0; i < n; i++) body(); },
  defineProc: (name, params, body) => procedures.set(name, body),
  callProc: (name, value) => { argument = value; procedures.get(name)(); },
  param: () => argument,
});

const sources = {
  continuation,
  cancellation: `
    sprite("source", {}, self => {
      onStart(() => { clone(); });
      onKey("a", () => { if (true) { deleteClone(); } console.log("alive:" + currentCloneIndex()); });
      onKey("b", () => { wait(0.05); console.log("pending:" + currentCloneIndex()); });
    });
    sprite("observer", {}, self => { onKey("b", () => { wait(0.05); console.log("observer"); }); });`,
  restart: `
    defineProc("reset", ["n"], () => { console.log(param("n")); restart(); });
    onStart(() => { console.log("start"); });
    onKey("a", () => { if (true) { restart(); } console.log("old-if"); });
    onKey("c", () => { repeatTimes(1, () => { restart(); }); console.log("old-loop"); });
    onKey("d", () => { callProc("reset", 7); console.log("old-proc"); });
    onKey("b", () => { wait(0.1); console.log("old-pending"); });`,
  stop: 'onStart(() => { stop(); console.log("after-stop"); });',
  minimal: 'onStart(() => { deleteClone(); }); onKey("r", () => { restart(); });',
};
fs.writeFileSync(process.argv[2], JSON.stringify(Object.entries(sources).map(([name, source]) => ({
  name, expected: name === "continuation" ? expected : [],
  report: compileFile("knterminalshape.ts", { readFile: () => source }),
}))));
