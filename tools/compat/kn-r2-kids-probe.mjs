#!/usr/bin/env node
// Local diagnostic execution of pinned official helper text, never vendored.
import fs from "node:fs";
import { createHash } from "node:crypto";
import vm from "node:vm";

const directory = "dist/r2-knblocks";
const source = fs.readFileSync(`${directory}/main.0f3db563.js`, "utf8");
const chunk = fs.readFileSync(`${directory}/42.3dd2ca05.chunk.js`, "utf8");
const hash = text => createHash("sha256").update(text).digest("hex");
if (hash(source) !== "42841119872219828a193880c7261774643e05e14848be58e6679d78b9add827" ||
    hash(chunk) !== "0be9bcf1696995dc1b7cc9f6d86c5abe9bbd0263641db17c5c24c388c0730885") throw Error("Official source hash changed");
const anchor = "changeTargetPosition:function";
const start = source.indexOf(anchor);
const end = source.indexOf(",getStylesCurrentIdAndOrder:", start);
if (start < 0 || end < start) throw Error("Official helper not found");
const helper = source.slice(start + "changeTargetPosition:".length, end);
const report = { schema: "nekoc-kn-r2-kids-evidence-v1",
  method: "Unchanged official changeTargetPosition evaluated in Node vm with authored actor and task-manager adapters. Explicit ticks call its native on_tick/on_end. This is not a full browser scheduler test.",
  sources: [{ file: "main.0f3db563.js", sha256: hash(source), url: "https://creation.bcmcdn.com/neko/web/release/static/js/main.0f3db563.js" },
    { file: "42.3dd2ca05.chunk.js", sha256: hash(chunk), url: "https://creation.bcmcdn.com/neko/web/release/static/js/42.3dd2ca05.chunk.js" }],
  anchors: [{ name: "changeTargetPosition", charOffset: start, byteOffset: Buffer.byteLength(source.slice(0, start)) },
    ...["z=25,U=200", "n.e(42).then(n.bind(n,29042))"].map(key => ({ name: key, charOffset: source.indexOf(key), byteOffset: Buffer.byteLength(source.slice(0,source.indexOf(key))) })),
    ...["function u(e)", "(0,Y.Z)(t,L.OA.moveRight"].map(key => ({ name: key, file: "42.3dd2ca05.chunk.js", charOffset: chunk.indexOf(key), byteOffset: Buffer.byteLength(chunk.slice(0,chunk.indexOf(key))) }))],
  cases: [] };
for (const axis of ["x", "y"]) for (const increase of ["increase", "decrease"]) {
  for (const steps of [2, -2, 0, "2", "bad", true, null, [2], Infinity, NaN]) {
    const state = { x: 10, y: 20 }, tasks = [];
    const actor = { type: "Actor", get_position: () => ({ ...state }),
      set_position_x: x => { state.x = x; }, set_position_y: y => { state.y = y; } };
    const context = vm.createContext({ p: { getStageTarget: () => actor }, h: { LP: { Actor: "Actor", Scene: "Scene" } },
      v: { Z: value => value === undefined }, m: { qh: value => typeof value === "number" } });
    const fn = vm.runInContext(`(${helper})`,context);
    // The unmodified chunk's u helper warns, then multiplies even invalid types.
    const distance = steps * 25, duration = distance / 200;
    fn(axis,increase,distance,"thread","actor",{ runtime_manager: { add_task: task => tasks.push(task) } },duration);
    const initial = { ...state };
    const task = tasks[0];
    if(task) { task.on_tick(125); task.on_tick(125); task.on_end(); }
    report.cases.push({axis,increase,input: String(steps),inputType: Array.isArray(steps)?"array":typeof steps,
      initial, final: { ...state }, lifetime: task?.lifetime ?? null, blocking: task?.blocking ?? false});
  }
}
fs.writeFileSync(`${directory}/kids-evidence.json`,JSON.stringify(report,null,2)+"\n");
console.log(JSON.stringify({cases:report.cases.length,anchors:report.anchors},null,2));
