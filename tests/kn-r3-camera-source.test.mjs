import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";

const evidence = JSON.parse(await fs.readFile(new URL("../docs/kn-r3-camera-evidence.json", import.meta.url)));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

test("official camera errors resolve both commands and native scripts continue", () => {
  assert.equal(evidence.ok, true);
  assert.deepEqual(evidence.profiles.map(p => p.profile), ["browser-denied", "device-absent"]);
  for (const profile of evidence.profiles) {
    const denied = profile.profile === "browser-denied";
    assert.equal(profile.version, "0.27.4");
    assert.deepEqual(profile.pageErrors, []);
    assert.deepEqual(profile.calls.map(c => c.name), ["open_hide_camera", "open_close_webcam"]);
    for (const call of profile.calls) {
      assert.equal(call.promise, true);
      assert.equal(call.valueType, "undefined");
      assert.equal(call.error, undefined);
      assert.deepEqual(call.order, ["returned", "after-register", "fulfilled"]);
      assert.equal(call.before, "turn_off");
      assert.equal(call.afterOpen, denied ? "no_permission" : "no_support");
      assert.deepEqual(call.openWrites, []);
      assert.equal(call.afterClose, "turn_off");
      assert.deepEqual(call.writes, [0.6]);
    }
    assert.equal(profile.native.running, true);
    assert.deepEqual(profile.native.variables, {
      "open_hide_camera:before": 1, "open_hide_camera:after": 1,
      "open_close_webcam:before": 1, "open_close_webcam:after": 1, independent: 1,
    });
    assert.ok(profile.native.gum.length >= 2);
    assert.ok(profile.native.gum.every(g => g.errorName === (denied ? "NotAllowedError" : "NotFoundError")));
  }
  assert.ok(evidence.limitations.some(s => s.includes("not a physical unplug test")));
});

test("optional official camera bundle hashes and source locations", async t => {
  for (const bundle of evidence.bundles) {
    let bytes;
    try { bytes = await fs.readFile(new URL(`../dist/kn-r3-camera/${bundle.name}`, import.meta.url)); }
    catch (error) { if (error.code === "ENOENT") return t.skip("Official bundles are not committed"); throw error; }
    assert.equal(hash(bytes), bundle.sha256);
    for (const location of evidence.sourceLocations.filter(s => s.bundle === bundle.name)) {
      assert.ok(Number.isInteger(location.byteOffset) && location.byteOffset >= 0);
      assert.equal(hash(bytes.subarray(location.byteOffset).toString("utf8").slice(0, location.characters)), location.excerptSha256, location.symbol);
    }
  }
});
