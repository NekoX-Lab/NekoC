import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createHash } from "node:crypto";
import { project, validateReport } from "../tools/compat/kn-r3-partial-probe.mjs";
import { inventory } from "../tools/compat/kn-catalog-status.mjs";
import { fileURLToPath } from "node:url";

test("r3 original fixture matches the official/editor checked bytes", () => {
  const template = JSON.parse(fs.readFileSync(new URL("../samples/kitten-n-0.27.4.bcmkn", import.meta.url)));
  const p = project(template);
  const source = JSON.stringify(p, null, 2) + "\n";
  assert.equal(createHash("sha256").update(source).digest("hex"), "1c8b66aa3c8f484dd45a211400ac919003be216b89b0354e04920d153300346a");
  assert.match(p.projectName, /^NekoC KN semantics/);
});

test("r3 official archive keeps complete native, local-call and editor evidence", () => {
  const r = JSON.parse(fs.readFileSync(new URL("../docs/kn-r3-partial-official.json", import.meta.url)));
  validateReport(r);
  assert.equal(r.ok, true);
  assert.equal(r.sha256, r.editorCompat.sha256);
  assert.equal(r.editorCompat.ok, true);
  assert.equal(r.editorCompat.blockCount, 54);
  assert.deepEqual(r.editorCompat.issues, []);
  assert.deepEqual(r.editorCompat.pageErrors, []);
  assert.equal(r.mainBundle.url, r.editorCompat.bundleUrl);
  for (const mutate of [
    r => { r.domain.search.pop(); },
    r => { r.domain.copied.nested = false; },
    r => { r.variables.detached = false; },
    r => { r.pageErrors.push("error"); },
  ]) {
    const invalid = structuredClone(r);
    mutate(invalid);
    assert.throws(() => validateReport(invalid));
  }
});

test("r3 does not pretend service/hardware partials were local parity upgrades", () => {
  const result = inventory(fileURLToPath(new URL("..", import.meta.url)));
  assert.equal(result.counts["部分语义"], 107);
  for (const type of ["list_copy", "list_index_of", "list_is_exist"]) {
    const row = result.rows.find(row => row.type === type);
    assert.equal(row.status, "有执行路径／未完整验证");
    assert.match(row.risk, /kn-r3-partial\.md/);
    assert.match(row.risk, /未验证/);
  }
});
