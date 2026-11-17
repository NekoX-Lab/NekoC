import assert from "node:assert/strict";
import { test } from "node:test";
import { checkFile } from "../ts/compile-ts.mjs";
import { readManifest } from "../tools/compat/kn-share-player-check.mjs";
import { prepare, source } from "./tsmathnan-cases.mjs";

test("tsmathnan preserves numeric calls and uses share blocks with valid parameter ids", async () => {
  assert.equal(checkFile("tsmathnan.ts", { types: false, host: { readFile: () => source } }).ok, true);
  const { report, expected } = prepare();
  assert.deepEqual(expected.slice(0, 6), Array(6).fill("NaN"));
  const manifest = await readManifest();
  for (const workspace of [report.workspaceData, ...report.procedures.map(p => p.workspaceData)]) {
    for (const block of Object.values(workspace.blocks)) {
      assert.ok([...manifest.blocks, ...manifest.metadataBlocks].includes(block.type), block.type);
      if (block.type === "procedures_2_return_value") {
        assert.match(block.mutation, /items="1"/);
        assert.match(block.shadows.VALUE, /type="math_number"/);
      }
    }
  }
  for (const procedure of report.procedures) {
    const blocks = Object.values(procedure.workspaceData.blocks);
    const defined = new Set(blocks.filter(b => b.type === "procedures_2_stable_parameter").map(b => b.id));
    const params = new Set(procedure.params.filter(p => p.type === "String").map(p => p.id));
    assert.deepEqual(defined, params, procedure.name);
    for (const block of blocks.filter(b => b.type === "procedures_2_parameter")) {
      assert.ok(params.has(/id="([^"]+)"/.exec(block.mutation)?.[1]), procedure.name);
    }
  }
});
