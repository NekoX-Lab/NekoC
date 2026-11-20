#!/usr/bin/env node
// Generate only original fixtures from NekoC's blank, repository-owned work.
import fs from "node:fs";
const directory = "dist/r2-knblocks/fixtures";
fs.mkdirSync(directory, { recursive: true });
const blank = JSON.parse(fs.readFileSync("samples/kitten-n-0.27.4.bcmkn", "utf8"));
let serial = 0;
const block = (type, fields = {}, inputs = {}) => ({ id: `r2-${++serial}`, type, fields, inputs });
const num = value => ({ ...block("math_number", { NUM: String(value) }), is_shadow: true, is_output: true });
const chain = blocks => blocks.reduceRight((next, item) => next ? { ...item, next } : item, null);
const p = structuredClone(blank);
p.projectName = "NekoC r2 kids movement";
p.actors.actorsDict["nekoc-default-actor"].nekoBlockJsonList = [chain([
  block("on_running_group_activated"),
  ...["kids_move_right", "kids_move_left", "kids_move_up", "kids_move_down"].map(type => block(type, {}, { steps: num(2) })),
  block("variables_set", { variable: "after" }, { value: num(1) }),
])];
p.variables.variablesDict.after = { id: "after", name: "after", type: "any", value: 0, isGlobal: true };
fs.writeFileSync(`${directory}/kids.bcmkn`, JSON.stringify(p, null, 2) + "\n");
const q = structuredClone(blank);
q.projectName = "NekoC r2 offline services";
q.actors.actorsDict["nekoc-default-actor"].nekoBlockJsonList = [chain([
  block("on_running_group_activated"),
  block("open_hide_camera", { camera_status: "turn_on" }),
  block("open_hide_camera", { camera_status: "turn_off" }),
  block("open_close_webcam", { camera_status: "turn_on" }),
  block("open_close_webcam", { camera_status: "turn_off" }),
  block("ai_chat_ask", {}, { text: { ...block("limit_length_text", { TEXT: "original offline fixture" }), is_shadow: true, is_output: true } }),
  block("translate", { language: "en" }, { text: { ...block("text", { TEXT: "原创翻译失败夹具" }), is_output: true } }),
  { ...block("bcm_translator_text_execution_block"), disabled: true, mutation: '<mutation items="0">authored unmatched call</mutation>' },
  block("variables_set", { variable: "after" }, { value: num(1) }),
])];
q.variables.variablesDict.after = structuredClone(p.variables.variablesDict.after);
fs.writeFileSync(`${directory}/services.bcmkn`, JSON.stringify(q, null, 2) + "\n");
console.log(directory);
