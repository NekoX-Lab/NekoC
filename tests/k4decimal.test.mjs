import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { decimalFixtures } from "../tools/compat/k4decimal-fixtures.mjs";
import { readJson, runOracle } from "../tools/compat/k4-oracle.mjs";

test("k4decimal original fixtures match pinned official evidence", async () => {
  const evidence = await readJson("docs/k4decimal-evidence.json");
  for (const [name, project] of Object.entries(await decimalFixtures())) {
    const source = await readFile(`tests/fixtures/kitten4/k4decimal-${name}.bcm`, "utf8");
    assert.equal(source, JSON.stringify(project, null, 2) + "\n");
    assert.equal(createHash("sha256").update(source).digest("hex"), evidence.cases[name].sha256);
    assert.deepEqual(evidence.cases[name].pageErrors, []);
    if (name === "error") assert.match(evidence.cases[name].errors.join(" "), /lists_get_value_bad_index/);
    else assert.deepEqual(evidence.cases[name].errors, []);
  }
  const hot = evidence.cases.hot.variables[0];
  assert.equal(hot.add, .3);
  assert.equal(hot.sub, .2);
  assert.equal(hot.mul, .02);
  assert.equal(hot.div, 3);
  assert.equal(hot.equal, true);
  assert.equal(hot.directEqual, true);
  assert.equal(hot.boundary, false);
  assert.equal(hot.text, "0.3");
  assert.equal(hot.count, 1200);
  assert.equal(hot.accumulate, 120);
  assert.equal(evidence.cases.values.variables[0].result[66], 1);
  assert.deepEqual(evidence.cases.nonfinite.variables[0].result.slice(-2), ["-Infinity", "Infinity"]);
  const privateValues = evidence.cases.private.variables[0];
  assert.equal(privateValues.add, .3);
  assert.equal(privateValues.sub, .2);
  assert.equal(privateValues.accumulate, 120);
  assert.equal(privateValues.count, 1200);
  assert.equal(privateValues.result[0], "x0.2");
  // Rows are Number +0/-0, exact "0", decimal zero strings, invalid string.
  const zero = evidence.cases.zero.variables[0].result;
  assert.deepEqual(zero.slice(0, 6), ["NaN", "NaN", "NaN", "Infinity", "-Infinity", "NaN"]);
  for (const start of [18, 24, 30]) {
    assert.deepEqual(zero.slice(start, start + 6), ["0", "0", "0",
      start === 24 ? "-Infinity" : "Infinity", start === 24 ? "Infinity" : "-Infinity", "NaN"]);
  }
});

test("k4decimal reproduces the offline official kernel", { skip: !process.env.K4_ORACLE_INTEGRATION }, async () => {
  const evidence = await readJson("docs/k4decimal-evidence.json");
  for (const [name, project] of Object.entries(await decimalFixtures())) {
    if (name === "error") {
      await assert.rejects(runOracle(project, { frames: 2, seed: 1 }), /lists_get_value_bad_index/);
    } else {
      const trace = await runOracle(project, { frames: 2, seed: 1 });
      assert.deepEqual(trace.frames.map(f => f.variables), evidence.cases[name].variables);
      assert.deepEqual(trace.errors, []);
      assert.deepEqual(trace.diagnostics.pageErrors, []);
    }
  }
});
