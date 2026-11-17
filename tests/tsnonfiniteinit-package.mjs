// Explicit post-package check: node tests/tsnonfiniteinit-package.mjs.
// Both WASM bindings use the same JSON boundary in packages/nekoc/api.mjs.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { api } from "../packages/nekoc/api.mjs";
import nodeWasm from "../packages/nekoc/dist/nodejs/nekoc_wasm.js";
import init, * as webWasm from "../packages/nekoc/dist/web/nekoc_wasm.js";
import { decodeFrame } from "../packages/nekoc/frame.mjs";
import { source, importedSource, barrierSource, concurrentSource, moduleSource, expectedFor } from "./tsnonfiniteinit-cases.mjs";

await init({ module_or_path: fs.readFileSync(new URL("../packages/nekoc/dist/web/nekoc_wasm_bg.wasm", import.meta.url)) });
for (const [binding, wasm] of [["node", nodeWasm], ["web", webWasm]]) {
  test(`tsnonfiniteinit ${binding} package preserves numbers through JSON assembly and playback`, () => {
    const { compile, check, createPlayer, validate } = api(wasm);
    for (const body of [source, importedSource, barrierSource, concurrentSource]) {
      const files = { "/main.ts": body, "/values.ts": moduleSource };
      assert.deepEqual(check("/main.ts", { files }), { ok: true, diagnostics: [] });
      const { bcmkn, report } = compile("/main.ts", { files });
      assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
      assert.equal(validate(bcmkn).ok, true);
      const player = createPlayer(bcmkn);
      try {
        const logs = [];
        for (let n = 0; n < 2000; n++) {
          logs.push(...decodeFrame(player.handle({ dt: 1 / 60, budget_ms: 100 })).logs);
        }
        assert.deepEqual(logs, body === concurrentSource ? ["ready NaN 3 -Infinity", "resumed 3"] : expectedFor(body));
      } finally { player.free(); }
    }
  });
}
