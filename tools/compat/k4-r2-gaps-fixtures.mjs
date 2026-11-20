#!/usr/bin/env node
// Repository-owned probes. No published work or official implementation copied.
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, saveJson, runOracle } from "./k4-oracle.mjs";
import { workspace } from "./k4-scheduling-fixtures.mjs";

const b = (id, type, fields = {}, inputs = {}, statements = {}) => ({ id, type, fields, inputs, statements });
const num = value => b("", "math_number", { NUM: String(value) });
const text = value => b("", "text", { TEXT: value });
const chain = (...nodes) => { nodes.slice(1).forEach((node, i) => nodes[i].next = node); return nodes[0]; };
const append = value => b("", "lists_append", {}, { VAR: b("", "lists_get", { VAR: "result" }), VALUE: value });
const cloud = () => b("", "cloud_variables_get", { VAR: "shared" });
const split = () => b("", "text_split", {}, { TEXT_TO_SPLIT: cloud(), SPLIT_TEXT: text("/") });
const item = index => b("", "lists_get_value", { TYPE: "first" }, { VAR: split(), INDEX: num(index) });
const changeScene = (id, target) => b(id, "switch_to_screen", {}, { screen: text(target) });
const wait = id => b(id, "wait", {}, { time: num(0) });

export async function r2GapsFixtures() {
  const base = await readJson("tests/fixtures/kitten4/runerr-addition.bcm");
  const schema = (await readJson("docs/kitten4-block-schema.json")).blocks;
  const joined = b("record", "text_join", {}, { ADD0: b("", "username_get"), ADD1: text("/0/15/5") });
  joined.mutation = '<mutation xmlns="http://www.w3.org/1999/xhtml" items="2"></mutation>';
  const cases = {
    identity: chain(b("start", "start_on_click"), append(b("name", "username_get")),
      append(b("user-id", "user_id_get")), append(b("online-count", "connected_users_get"))),
    "cloud-record": chain(b("start", "start_on_click"),
      b("write-record", "cloud_variables_set", { VAR: "shared" }, { VALUE: joined }),
      append(cloud()), append(item(1)), append(item(2)), append(item(3)), append(item(4))),
    "face-pointer": chain(b("start", "start_on_click"), b("forever", "repeat_forever", {}, {}, { DO: chain(
      b("face-pointer", "self_face_to", { sprite: "__mouse" }),
      b("continued", "change_variable", { valname: "log", method: "increase" }, { n: num(1) })) })),
    "move-pointer": chain(b("start", "start_on_click"), b("forever", "repeat_forever", {}, {}, { DO: chain(
      b("move-pointer", "self_move_specify", { target: "__pointer" }),
      b("continued", "change_variable", { valname: "log", method: "increase" }, { n: num(1) })) })),
    "relative-scenes": chain(b("start", "start_on_click"),
      changeScene("before-first", "__previous_scene"), append(text("first-boundary")), wait("wait-first"),
      changeScene("next", "__next_scene"), append(text("next")), wait("wait-next"),
      changeScene("after-last", "__next_scene"), append(text("last-boundary")), wait("wait-last"),
      changeScene("previous", "__previous_scene"), append(text("previous"))),
    "unlisted-scene": chain(b("start", "start_on_click"),
      changeScene("next", "__next_scene"), append(text("continued"))),
    "unlisted-previous": chain(b("start", "start_on_click"),
      changeScene("enter-unlisted", base.theatre.scenes_order[1]), wait("yield"),
      changeScene("previous", "__previous_scene"), append(text("continued"))),
    "unlisted-next": chain(b("start", "start_on_click"),
      changeScene("enter-unlisted", base.theatre.scenes_order[1]), wait("yield"),
      changeScene("next", "__next_scene"), append(text("continued"))),
  };
  return Object.fromEntries(Object.entries(cases).map(([name, root]) => {
    const project = structuredClone(base);
    delete project.compile_result;
    project.project_name = `NekoC r2 gaps ${name}`;
    project.application_version = "4.11.20";
    if (name.startsWith("unlisted-")) project.theatre.scenes_order = project.theatre.scenes_order.slice(0, 1);
    project.cloud_variables = name === "cloud-record" ? { shared: {
      id: "shared", cvid: "r2-local-shared", name: "shared", type: "public",
      value: "ignored/saved/value", visible: false, position: { x: 0, y: 0 }, scale: 1, offset: { x: 0, y: 0 },
    } } : {};
    for (const scene of Object.values(project.theatre.scenes)) scene.block_data_json = workspace([], schema);
    const actor = Object.values(project.theatre.actors)[0];
    Object.assign(actor, { x: 12, y: -7, rotation: Math.PI / 6 });
    actor.block_data_json = workspace([root], schema);
    return [name, project];
  }));
}

async function main() {
  const evidence = { schema: "nekoc-k4-r2-gaps-evidence-v1", cases: {} };
  if (process.argv.includes("--record")) {
    try { Object.assign(evidence, await readJson("docs/kitten4-r2-gaps-evidence.json")); } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const only = process.argv.find(arg => arg.startsWith("--case="))?.slice(7);
  for (const [name, project] of Object.entries(await r2GapsFixtures())) {
    if (only && name !== only) continue;
    await saveJson(`tests/fixtures/kitten4/r2-gaps-${name}.bcm`, project);
    if (!process.argv.includes("--record")) continue;
    const frames = name === "relative-scenes" ? 10 : 4;
    const trace = await runOracle(project, { frames, seed: 1, blocks: true, virtualTime: true, channel: "msedge", wallTimeoutMs: 45000 });
    evidence.assets = trace.diagnostics.assets;
    evidence.cases[name] = {
      sha256: createHash("sha256").update(JSON.stringify(project, null, 2) + "\n").digest("hex"),
      frames: trace.frames, errors: trace.errors, pageErrors: trace.diagnostics.pageErrors,
      externalRequests: trace.diagnostics.externalRequests,
      executedBlocks: [...new Set(trace.events.filter(event => event.event === "block").map(event => event.block))],
    };
    console.log(name, JSON.stringify({ variables: trace.frames[0].variables, errors: trace.errors }));
  }
  if (process.argv.includes("--record")) await saveJson("docs/kitten4-r2-gaps-evidence.json", evidence);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => {
  console.error(error); process.exitCode = 1;
});
