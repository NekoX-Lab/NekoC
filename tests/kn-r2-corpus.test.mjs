import assert from "node:assert/strict";
import test from "node:test";
import { frequencies } from "../tools/compat/kn-r2-corpus.mjs";

test("KN r2 ranks unique works, preserves out-of-catalog types and scans only workspaces", () => {
  const project = blocks => ({ toolType: "KN", scenes: { scenesDict: {} },
    actors: { actorsDict: { actor: { nekoBlockJsonList: blocks } } },
    variables: { variablesDict: { fake: { type: "not-a-block" } } } });
  const rows = frequencies([
    { id: "1", project: project([{ type: "camera", next: { type: "camera" } }, { type: "kids_move_right" }]) },
    { id: "2", project: project([{ type: "camera" }]) },
  ], "| 166 | `camera` | 部分语义 | evidence |\n");
  assert.deepEqual(rows.map(row => [row.type, row.workCount, row.occurrences, row.status]),
    [["camera", 2, 3, "部分语义"], ["kids_move_right", 1, 1, "清单外／需核实"]]);
  assert.deepEqual(rows[0].works, ["1", "2"]);
  for (const toolType of [undefined, "TANYUE_KN"]) {
    assert.equal(frequencies([{ id: "legacy", project: { ...project([{ type: "camera" }]), toolType } }], "")[0].workCount, 1);
  }
  assert.throws(() => frequencies([{ id: "bad", project: { ...project([]), toolType: "K4" } }], ""), /Not a KN/);
});

test("KN r2 includes dormant, disabled, scene and procedure blocks but not field data", () => {
  const project = { toolType: "KN",
    scenes: { scenesDict: { scene: { nekoBlockJsonList: [{ type: "scene_block" }] } } },
    actors: { actorsDict: { actor: { nekoBlockJsonList: [{ type: "disabled_block", disabled: true,
      fields: { payload: { type: "not-a-block" } },
      mutation: { type: "not-a-block-either" },
      inputs: { value: { type: "reporter" } },
      shadows: { value: '<shadow type="fallback_shadow"><field name="TEXT">text</field></shadow>' },
    }] } } },
    procedures: { proceduresDict: { proc: { nekoBlockJsonList: [{ type: "procedure_block" }] } } },
  };
  const original = structuredClone(project);
  const rows = frequencies([{ id: "authored", project }], "");
  assert.deepEqual(rows.map(row => row.type),
    ["disabled_block", "fallback_shadow", "procedure_block", "reporter", "scene_block"]);
  assert.ok(rows.every(row => row.workCount === 1 && row.occurrences === 1));
  assert.deepEqual(project, original, "the scanner must not rewrite runtime inputs");
});
