import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { r2GapsFixtures } from "../tools/compat/k4-r2-gaps-fixtures.mjs";
import { readJson } from "../tools/compat/k4-oracle.mjs";

test("r2 K4 probes reproduce the original fixtures and bind official observations", async () => {
  const evidence = await readJson("docs/kitten4-r2-gaps-evidence.json");
  for (const [name, project] of Object.entries(await r2GapsFixtures())) {
    const bytes = await readFile(`tests/fixtures/kitten4/r2-gaps-${name}.bcm`);
    assert.deepEqual(JSON.parse(bytes), project, name);
    const observed = evidence.cases[name];
    assert.equal(createHash("sha256").update(bytes).digest("hex"), observed.sha256);
    assert.equal(observed.frames.length, name === "relative-scenes" ? 10 : 4);
    assert.deepEqual(observed.errors, []);
    assert.deepEqual(observed.pageErrors, []);
    assert.ok(observed.externalRequests.every(request => request.action === "blocked"));
    assert.ok(observed.executedBlocks.includes("start"));
  }
  assert.deepEqual(evidence.cases.identity.frames[0].variables.result, ["未登录用户", 0, 1]);
  assert.deepEqual(evidence.cases["cloud-record"].frames[0].variables.result,
    ["未登录用户/0/15/5", "未登录用户", 0, 15, 5]);
  assert.deepEqual(evidence.cases["relative-scenes"].frames.at(-1).variables.result,
    ["first-boundary", "next", "last-boundary", "previous"]);
  for (const name of ["unlisted-scene", "unlisted-previous", "unlisted-next"]) {
    const observed = evidence.cases[name];
    const scene = name === "unlisted-scene" ? "10000000-0000-4000-8000-000000000001" : "10000000-0000-4000-8000-000000000002";
    assert.ok(observed.frames.every(frame => frame.current_scene_id === scene));
    assert.deepEqual(observed.frames.at(-1).variables.result, ["continued"]);
  }
});

test("r2 cloud evidence distinguishes anonymous 401 from connected-without-reply injection", async () => {
  const evidence = await readJson("docs/kitten4-r2-cloud-evidence.json");
  assert.equal(evidence.kernelSha256, "0f7933d51266add6cbad0682b9531036dc1c8daf8c522cde4243744376ce4160");
  assert.equal(evidence.allVerified, true);
  assert.equal(evidence.totalOfficialUpdates, 120);
  assert.equal(evidence.browserLaunches, 1);
  assert.equal(evidence.cases.length, 4);
  for (const observed of evidence.cases) {
    const bytes = await readFile(`tests/fixtures/kitten4/${observed.fixture}`);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), observed.fixtureSha256);
    assert.equal(observed.account401Observed, true);
    assert.equal(observed.anonymousThroughout, true);
    assert.equal(observed.globalModeAtFrameCallbacks, true);
    for (const field of ["runtimeErrors", "pageErrors", "allowedExternalRequests", "webSocketAttempts", "localWriteRequests"]) {
      assert.equal(observed[field], 0, `${observed.id}: ${field}`);
    }
    assert.equal(observed.verified, true);
  }
  const disconnected = evidence.cases.find(c => c.id === "anonymous-401-list");
  const connected = evidence.cases.find(c => c.id === "controlled-connected-flag-no-reply");
  assert.ok(connected.injections.some(i => i.type === "socket-is-connected-flag-only" && i.value === true));
  assert.notDeepEqual(disconnected.replacements[0].after, disconnected.replacements[0].before);
  assert.deepEqual(connected.replacements[0].after, connected.replacements[0].before);
  assert.equal(connected.replacements[0].socketConnectedAfterFrame, true);
  assert.equal(connected.replacements.at(-1).socketConnectedAfterFrame, false);
  assert.notDeepEqual(connected.replacements.at(-1).after, connected.replacements.at(-1).before);
});
