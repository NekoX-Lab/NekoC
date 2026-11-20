// Original probes only. The external player is read through the existing oracle.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { fixtures, actorId, floorId } from "../physics-fixtures.mjs";
import { workspace } from "./k4-scheduling-fixtures.mjs";
import { runOracle, saveJson } from "./k4-oracle.mjs";

export const fixturePath = "tests/fixtures/kitten4/r3-physics.json";
export const collisionFixturePath = "tests/fixtures/kitten4/r3-collision.json";
const evidencePath = "docs/kitten4-r3-physics-evidence.json";
const b = (type, fields = {}, inputs = {}) => ({ id: "", type, fields, inputs, statements: {} });
const n = value => b("math_number", { NUM: String(value) });
const chain = nodes => { nodes.slice(1).forEach((node, i) => { nodes[i].next = node; }); return nodes[0]; };
const store = (name, value) => b("variables_set", { VAR: name }, { VALUE: value });
const bump = edge => b("bump", { sprite1: "__self", sprite2: edge });
const physics = (type, fields = {}, values = {}) => b(`physics2_${type}`, fields,
  Object.fromEntries(Object.entries(values).map(([key, value]) => [key, n(value)])));
const sha256 = value => createHash("sha256").update(value).digest("hex");

export function physicsProbes() {
  const template = fixtures().speed;
  const schema = JSON.parse(readFileSync("docs/kitten4-block-schema.json")).blocks;
  const commands = [b("start_on_click"), store("before", bump("__edge")), b("self_bounce_off_edge"),
    store("after", bump("__edge"))];
  template.project_name = "NekoC original r3 K4 edge reflection";
  template.toolbox.physics2 = true;
  template.theatre.actors[actorId].block_data_json = workspace([chain(commands)], schema);
  template.variables = Object.fromEntries(["before", "after", "speed", "speed_dir"].map(id => [id, {
    id, name: id, value: 0, type: "any", is_global: true, current_entity: actorId, visible: false,
  }]));
  template.variable_order = Object.keys(template.variables);
  const cases = {};
  function add(name, actor, texture = [48, 36, 0, 0, 48, 36], pivot = [0, 0], physical = false) {
    const [width, height, x, y, w, h] = texture;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#3388aa"/></svg>`;
    const style = { ...template.theatre.styles["probe-style"], width, height,
      pivot: { x: pivot[0], y: pivot[1] }, rotate_center: { x: pivot[0], y: pivot[1] },
      url: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}` };
    const spec = { actor: { ...actor, rotation: actor.rotation * Math.PI / 180 }, style, texture, physical };
    if (physical) {
      spec.workspace = workspace([chain([b("start_on_click"),
        physics("set_gravity", {}, { value: 0, dir: 0 }),
        physics("set_speed", {}, { value: 2, dir: 0 }),
        store("before", bump("__edge")), b("self_bounce_off_edge"),
        store("after", bump("__edge")),
        ...["speed", "speed_dir"].map(property => store(property, physics("get_property", { sprite: "__self", property }))),
      ])], schema);
    }
    cases[name] = spec;
  }
  add("right", { x: 645, rotation: 0 });
  add("left", { x: -645, rotation: 180 });
  add("top", { y: 365, rotation: 90 });
  add("bottom", { y: -365, rotation: -90 });
  for (const [name, x, y, rotation] of [
    ["top-right", 645, 365, 45], ["top-left", -645, 365, 135],
    ["bottom-right", 645, -365, -45], ["bottom-left", -645, -365, -135],
  ]) add(name, { x, y, rotation });
  add("already-inward", { x: 645, rotation: 180 });
  add("inside", { x: 0, rotation: 45 });
  add("bbox-only", { x: 620, rotation: 0 });
  add("internal-exact-edge", { x: 630, rotation: 0 });
  add("hidden", { x: 645, visible: false, rotation: 0 });
  add("tiny", { x: 645, rotation: 0 }, [8, 8, 0, 0, 8, 8]);
  add("empty", { x: 645, rotation: 0 }, [48, 36, 0, 0, 0, 0]);
  add("transparent-padding", { x: 630, rotation: 0 }, [96, 72, 30, 20, 36, 24]);
  add("padded-over-edge", { x: 655, rotation: 0 }, [96, 72, 30, 20, 36, 24]);
  add("scaled", { x: 645, scale: 175, rotation: 30 });
  add("no-rotation", { x: 645, rotation: 45, rotation_type: 2 });
  add("left-right", { x: 645, rotation: 45, rotation_type: 1 });
  add("pivot-both", { x: 650, y: 10, rotation: 30 }, undefined, [5, -7]);
  add("pivot-x", { x: 650, y: 10, rotation: 30 }, undefined, [5, 0]);
  add("pivot-y", { x: 650, y: 10, rotation: 30 }, undefined, [0, -7]);
  add("physical-speed", { x: 645, rotation: 0 }, undefined, undefined, true);
  return { actorId, template, cases };
}

export function probeProject(probes, spec) {
  const project = structuredClone(probes.template);
  Object.assign(project.theatre.actors[actorId], spec.actor);
  project.theatre.styles["probe-style"] = spec.style;
  if (spec.workspace) project.theatre.actors[actorId].block_data_json = spec.workspace;
  return project;
}

export function combinedProject(probes) {
  const project = structuredClone(probes.template);
  project.theatre.actors = {};
  project.variables = {};
  const ids = {};
  for (const [index, [name, spec]] of Object.entries(probes.cases).entries()) {
    const id = `20000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
    ids[name] = id;
    const actor = structuredClone(probeProject(probes, spec).theatre.actors[actorId]);
    actor.id = id;
    actor.name = name;
    actor.styles = [name];
    actor.current_style_id = name;
    for (const block of Object.values(actor.block_data_json.blocks)) {
      if (block.fields.VAR) block.fields.VAR = `${name}/${block.fields.VAR}`;
    }
    // Block IDs are global in the official compiler, not scoped to an actor.
    const graph = actor.block_data_json;
    const blockId = key => key ? `${name}/${key}` : key;
    graph.blocks = Object.fromEntries(Object.entries(graph.blocks).map(([key, block]) =>
      [blockId(key), { ...block, id: blockId(key), parent_id: blockId(block.parent_id) }]));
    graph.connections = Object.fromEntries(Object.entries(graph.connections).map(([key, edges]) =>
      [blockId(key), Object.fromEntries(Object.entries(edges).map(([child, edge]) => [blockId(child), edge]))]));
    project.theatre.actors[id] = actor;
    project.theatre.styles[name] = { ...spec.style, id: name };
    for (const [key, variable] of Object.entries(probes.template.variables)) {
      project.variables[`${name}/${key}`] = { ...variable, id: `${name}/${key}`, current_entity: id };
    }
  }
  project.variable_order = Object.keys(project.variables);
  for (const scene of Object.values(project.theatre.scenes)) scene.actors = Object.values(ids);
  project.theatre.groups.group.actors = Object.values(ids);
  return { project, ids };
}

export function collisionProbes() {
  const template = structuredClone(physicsProbes().template);
  const schema = JSON.parse(readFileSync("docs/kitten4-block-schema.json")).blocks;
  template.project_name = 'NekoC original r3 K4 actor collision';
  template.theatre.actors[actorId].block_data_json = workspace([chain([b('start_on_click'),
    store('before', b('bump', { sprite1: '__self', sprite2: floorId })),
    store('after', b('bump', { sprite1: floorId, sprite2: actorId })),
  ])], schema);
  const cases = {};
  const add = (name, a = {}, other = {}, texture = [20, 20]) => {
    cases[name] = { a, other, texture };
  };
  add('overlapping', {}, { x: 5 });
  add('separate', {}, { x: 25 });
  add('touching', {}, { x: 20 });
  add('one-hit-is-not-five', {}, { x: 18, y: 18 });
  add('four-hits-is-not-five', {}, { x: 16, y: 16 });
  add('eight-hits', {}, { x: 14, y: 12 });
  add('subpixel', {}, { x: 18.6, y: 17.6 });
  add('tiny-one-hit', {}, { x: 0.5 }, [3, 3]);
  add('both-offstage', { x: 700 }, { x: 705 });
  add('partly-onstage', { x: 639 }, { x: 640 });
  add('target-hidden', {}, { visible: false });
  add('subject-hidden', { visible: false });
  add('cross-scene', {}, { scene: '10000000-0000-4000-8000-000000000002' });
  return { actorId, floorId, template, cases };
}

export function collisionProject(probes, spec) {
  const project = structuredClone(probes.template);
  const actor = project.theatre.actors[actorId];
  const other = structuredClone(actor);
  Object.assign(actor, spec.a);
  Object.assign(other, { id: floorId, name: 'Other', block_data_json: { blocks: {}, connections: {}, comments: {} } }, spec.other);
  project.theatre.actors[floorId] = other;
  project.theatre.styles['probe-style'].width = spec.texture[0];
  project.theatre.styles['probe-style'].height = spec.texture[1];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${spec.texture[0]}" height="${spec.texture[1]}"><rect width="100%" height="100%" fill="#3388aa"/></svg>`;
  project.theatre.styles['probe-style'].url = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  const scene = actor.scene;
  project.theatre.scenes[scene].actors.push(floorId);
  project.theatre.groups.group.actors.push(floorId);
  if (other.scene !== scene) {
    project.theatre.scenes[other.scene] = { ...structuredClone(project.theatre.scenes[scene]), id: other.scene, actors: [floorId], group_order: ['other-group'] };
    project.theatre.scenes[scene].actors = [actorId];
    project.theatre.scenes_order.push(other.scene);
    project.theatre.groups['other-group'] = { ...project.theatre.groups.group, id: 'other-group', actors: [floorId], scene: other.scene };
    project.theatre.groups.group.actors = [actorId];
  }
  return project;
}

export function combinedCollisions(probes) {
  const project = structuredClone(probes.template);
  project.theatre.actors = {};
  project.variables = {};
  const ids = {};
  for (const [index, [name, spec]] of Object.entries(probes.cases).entries()) {
    const pair = collisionProject(probes, spec);
    const remap = Object.fromEntries([actorId, floorId].map((key, i) => [key,
      `20000000-0000-4000-8000-${String(index * 2 + i + 1).padStart(12, '0')}`]));
    ids[name] = remap[actorId];
    for (const [key, actor] of Object.entries(pair.theatre.actors)) {
      const id = remap[key];
      actor.id = id;
      actor.styles = [name]; actor.current_style_id = name;
      const graph = actor.block_data_json;
      const blockId = key => key ? `${id}/${key}` : key;
      for (const block of Object.values(graph.blocks)) {
        if (block.fields.VAR) block.fields.VAR = `${name}/${block.fields.VAR}`;
        for (const field of ['sprite1', 'sprite2']) if (remap[block.fields[field]]) block.fields[field] = remap[block.fields[field]];
      }
      graph.blocks = Object.fromEntries(Object.entries(graph.blocks).map(([key, block]) =>
        [blockId(key), { ...block, id: blockId(key), parent_id: blockId(block.parent_id) }]));
      graph.connections = Object.fromEntries(Object.entries(graph.connections).map(([key, edges]) =>
        [blockId(key), Object.fromEntries(Object.entries(edges).map(([child, edge]) => [blockId(child), edge]))]));
      project.theatre.actors[id] = actor;
    }
    project.theatre.styles[name] = { ...pair.theatre.styles['probe-style'], id: name };
    for (const [id, variable] of Object.entries(pair.variables)) {
      project.variables[`${name}/${id}`] = { ...variable, id: `${name}/${id}`, current_entity: remap[actorId] };
    }
    for (const [id, scene] of Object.entries(pair.theatre.scenes)) project.theatre.scenes[id] = { ...scene, actors: [] };
  }
  project.variable_order = Object.keys(project.variables);
  project.theatre.scenes_order = Object.keys(project.theatre.scenes);
  project.theatre.groups = {};
  for (const [id, scene] of Object.entries(project.theatre.scenes)) {
    scene.actors = Object.values(project.theatre.actors).filter(actor => actor.scene === id).map(actor => actor.id);
    scene.group_order = [`group-${id}`];
    project.theatre.groups[`group-${id}`] = { id: `group-${id}`, name: '', is_group: false, is_fold: false, actors: scene.actors, scene: id, visible: true };
  }
  return { project, ids };
}

async function main() {
  const probes = physicsProbes();
  await saveJson(fixturePath, probes);
  const collisions = collisionProbes();
  await saveJson(collisionFixturePath, collisions);
  if (!process.argv.includes("--record")) return;
  const report = { schema: "nekoc-k4-r3-physics-v1",
    fixture: fixturePath, sha256: sha256(JSON.stringify(probes, null, 2) + "\n"), cases: {} };
  const { project, ids } = combinedProject(probes);
  const trace = await runOracle(project, { frames: 4, seed: 1, virtualTime: true });
  if (!trace.diagnostics.assets.some(asset => asset.sha256 === '6ed56cf80a197b1dad00403ef2d55f9f4c357cb000cc52b5b0ba32c3989730d6')) {
    throw new Error('The official physics module was not loaded');
  }
  await saveJson('dist/k4-r3-physics/combined.official.json', trace);
  report.assets = trace.diagnostics.assets;
  report.projectSha256 = sha256(JSON.stringify(project, null, 2) + '\n');
  for (const [name, id] of Object.entries(ids)) {
    report.cases[name] = { frames: trace.frames.map(frame => ({ frame: frame.frame,
      actor: { ...frame.actors[id], id: actorId, prototype_id: actorId, name: 'Probe', current_style_id: 'probe-style' },
      variables: Object.fromEntries(Object.keys(probes.template.variables).map(key => [key, frame.variables[`${name}/${key}`]])) })),
    errors: trace.errors, pageErrors: trace.diagnostics.pageErrors };
    console.log(name, JSON.stringify(report.cases[name].frames[0]));
  }
  await saveJson(evidencePath, report);
  const combined = combinedCollisions(collisions);
  const collisionTrace = await runOracle(combined.project, { frames: 1, seed: 1, virtualTime: true });
  await saveJson('dist/k4-r3-physics/collisions.official.json', collisionTrace);
  const collisionReport = { schema: 'nekoc-k4-r3-collision-v1', fixture: collisionFixturePath,
    sha256: sha256(JSON.stringify(collisions, null, 2) + '\n'),
    projectSha256: sha256(JSON.stringify(combined.project, null, 2) + '\n'), assets: collisionTrace.diagnostics.assets,
    errors: collisionTrace.errors, pageErrors: collisionTrace.diagnostics.pageErrors,
    cases: Object.fromEntries(Object.keys(combined.ids).map(name => [name,
      Object.fromEntries(['before', 'after'].map(key => [key, collisionTrace.frames[0].variables[`${name}/${key}`]]))])) };
  await saveJson('docs/kitten4-r3-collision-evidence.json', collisionReport);
  console.log('collisions', JSON.stringify(collisionReport.cases));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
