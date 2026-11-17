#!/usr/bin/env node
// Original probes, built only from the repository's original minimal project.
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readJson, saveJson, runOracle } from "./k4-oracle.mjs";
import { workspace } from "./k4-scheduling-fixtures.mjs";

const b = (type, fields = {}, inputs = {}, statements = {}) => ({ type, fields, inputs, statements });
// Numeric editor fields/conversion reporters have their own normalization.
// Actual Number extremes enter through typed initial variables, not field quirks.
const numberInputs = new Map();
const num = n => {
  if (/e/i.test(String(n))) {
    const id = `number:${n}`;
    numberInputs.set(id, n);
    return b("variables_get", { VAR: id });
  }
  return Object.is(n, -0)
    ? b("convert_type", { type: "number" }, { original_value: b("text", { TEXT: "-0" }) })
    : b("math_number", { NUM: String(n) });
};
const text = s => b("text", { TEXT: s });
const get = id => b("variables_get", { VAR: id });
const set = (id, value) => b("variables_set", { VAR: id }, { VALUE: value });
const math = (OP, a, c) => b("math_arithmetic", { OP }, { A: a, B: c });
const calc = (op, a, c) => math(op, num(a), num(c));
const convert = (type, value) => b("convert_type", { type }, { original_value: value });
const compare = (OP, A, B) => b("logic_compare", { OP }, { A, B });
const change = (id, n, method = "increase") => b("change_variable", { valname: id, method }, { n: num(n) });
const list = () => b("lists_get", { VAR: "result" });
const append = value => b("lists_append", {}, { VAR: list(), VALUE: value });
const chain = (...nodes) => { nodes.slice(1).forEach((node, i) => nodes[i].next = node); return nodes[0]; };

export async function decimalFixtures() {
  numberInputs.clear();
  const base = await readJson("tests/fixtures/kitten4/runerr-addition.bcm");
  const schema = (await readJson("docs/kitten4-block-schema.json")).blocks;
  const basics = [["add", "ADD", .1, .2], ["sub", "MINUS", .3, .1],
    ["mul", "MULTIPLY", .1, .2], ["div", "DIVIDE", .3, .1]];
  const hot = () => chain(...basics.map(([id, op, a, c]) => set(id, math(op, get(String(a)), get(String(c))))),
    set("equal", compare("EQ", get("add"), num(.3))),
    set("boundary", compare("LT", get("div"), num(3))),
    set("directEqual", compare("EQ", math("ADD", get("0.1"), get("0.2")), num(.3))),
    set("text", convert("string", get("add"))), change("count", 1), change("accumulate", .1));
  const loop = () => b("warp", {}, {}, { DO: b("repeat_n_times", {}, { times: num(1200) }, { DO: hot() }) });
  const pairs = [[-.1, -.2], [-.3, .1], [1e-7, 2e-7], [1e20, 3],
    [1.0000000000000002, 1], [.9999999999999999, 1], [1e16, 1],
    [1.2345678901234567, 9.876543210987654], [1, 3], [2, 7],
    [1e308, 1e308], [5e-324, 2], [-5e-324, 2], [1e-300, 1e300]];
  const zeroDivisions = [0, -0, "0", "0.00", "-0", "0e1", "invalid"].flatMap(denominator =>
    [0, "0", "-0", 1, -1, "invalid"].map(numerator => append(convert("string", math("DIVIDE",
      typeof numerator === "string" ? text(numerator) : num(numerator),
      typeof denominator === "string" ? text(denominator) : num(denominator))))));
  const cases = {
    hot: chain(b("start_on_click"), loop()),
    values: chain(b("start_on_click"),
      ...pairs.flatMap(([a, c]) => ["ADD", "MINUS", "MULTIPLY", "DIVIDE"].map(op => append(convert("string", calc(op, a, c))))),
      append(math("MINUS", calc("ADD", .1, .2), num(.3))),
      append(math("MULTIPLY", calc("DIVIDE", 1, 3), num(3))),
      append(math("ADD", text("0.1"), num(.2))),
      set("change", num(.1)), change("change", .2), append(get("change")),
      change("change", .1, "decrease"), append(get("change")),
      append(calc("ADD", .1, .2)),
      append(math("MULTIPLY", b("lists_get_value", {}, { VAR: list(), INDEX: num(62) }), num(10))),
      append(math("MINUS", b("logic_boolean", { BOOL: "TRUE" }), num(.9))),
      append(math("MULTIPLY", b("logic_boolean", { BOOL: "TRUE" }), num(.1))),
      append(math("MINUS", text("1.00000000000000001"), num(1))),
      // A 20-digit truncation vs round-half-up crosses a binary64 midpoint.
      append(math("MULTIPLY", text("1.000000000000000111025"), num(1))),
      // These are independently probed; modulo is JS %, not Decimal.mod.
      append(b("math_modulo", {}, { DIVIDEND: num(.3), DIVISOR: num(.1) }))),
    nonfinite: chain(b("start_on_click"),
      ...[[1, 0], [-1, 0], [0, 0], [1, -0]].map(([a, c]) => append(convert("string", calc("DIVIDE", a, c)))),
      ...["Infinity", "-Infinity", "NaN"].flatMap(value =>
        ["ADD", "MINUS", "MULTIPLY", "DIVIDE"].map(op => append(convert("string",
          math(op, convert("number", text(value)), num(.1)))))),
      append(convert("string", calc("MULTIPLY", -0, 2))),
      append(convert("string", calc("DIVIDE", 0, -2))),
      set("change", math("DIVIDE", num(-1), calc("DIVIDE", 1, 0))),
      append(convert("string", math("DIVIDE", num(1), get("change")))),
      change("change", 0, "decrease"),
      append(convert("string", math("DIVIDE", num(1), get("change"))))),
    error: chain(b("start_on_click"), loop(),
      set("unwritten", math("ADD", b("lists_get_value", {}, { VAR: list(), INDEX: num(2) }), num(.1)))),
    private: chain(b("start_on_click"), b("warp", {}, {}, { DO:
      b("repeat_n_times", {}, { times: num(1200) }, { DO: chain(
        set("private", num(.1)), change("private", .2), set("add", get("private")),
        change("private", .1, "decrease"), set("sub", get("private")),
        change("privateAccumulate", .1), change("count", 1)) }) }),
      set("accumulate", get("privateAccumulate")),
      set("private", text("x")), change("private", .2), append(get("private")),
      set("private", list()), change("private", .2), append(convert("string", get("private")))),
    zero: chain(b("start_on_click"), ...Array.from({ length: Math.ceil(zeroDivisions.length / 14) },
      (_, i) => b("warp", {}, {}, { DO: chain(...zeroDivisions.slice(i * 14, (i + 1) * 14)) }))),
  };
  return Object.fromEntries(Object.entries(cases).map(([name, root]) => {
    const project = structuredClone(base);
    delete project.compile_result;
    project.project_name = `NekoC k4decimal ${name}`;
    project.variables = Object.fromEntries(["add", "sub", "mul", "div", "equal", "directEqual", "boundary", "text", "count", "accumulate", "change", "unwritten"]
      .map(id => [id, { id, name: id, value: 0, type: "any", is_global: true, visible: false }]));
    for (const n of [.1, .2, .3]) project.variables[String(n)] = { id: String(n), name: String(n), value: n, type: "any", is_global: true, visible: false };
    for (const [id, n] of numberInputs) project.variables[id] = { id, name: id, value: n, type: "any", is_global: true, visible: false };
    if (name === "private") {
      for (const id of ["private", "privateAccumulate"]) project.variables[id] = {
        id, name: id, value: 0, type: "any", is_global: false,
        current_entity: Object.keys(project.theatre.actors)[0], visible: false,
      };
    }
    project.variables.result = { ...base.variables.result, value: [] };
    project.variable_order = Object.keys(project.variables);
    for (const scene of Object.values(project.theatre.scenes)) scene.block_data_json = workspace([], schema);
    Object.values(project.theatre.actors)[0].block_data_json = workspace([root], schema);
    return [name, project];
  }));
}

async function main() {
  const evidence = { schema: "nekoc-k4decimal-evidence-v1", cases: {} };
  for (const [name, project] of Object.entries(await decimalFixtures())) {
    const file = `tests/fixtures/kitten4/k4decimal-${name}.bcm`;
    await saveJson(file, project);
    if (process.argv.includes("--record")) {
      let trace;
      try {
        trace = await runOracle(project, { frames: 2, seed: 1 });
      } catch (error) {
        if (name !== "error") throw error;
        trace = { ...error.diagnostics.partialTrace, diagnostics: error.diagnostics };
      }
      evidence.assets = trace.diagnostics.assets;
      evidence.cases[name] = { sha256: createHash("sha256").update(JSON.stringify(project, null, 2) + "\n").digest("hex"),
        variables: trace.frames.map(f => f.variables), errors: trace.errors,
        pageErrors: trace.diagnostics.pageErrors };
      console.log(name, JSON.stringify(evidence.cases[name]));
    }
  }
  if (process.argv.includes("--record")) await saveJson("docs/k4decimal-evidence.json", evidence);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => {
  console.error(error); process.exitCode = 1;
});
