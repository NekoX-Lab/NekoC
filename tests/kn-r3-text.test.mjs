import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const evidence = JSON.parse(fs.readFileSync(new URL("../docs/kn-r3-text-evidence.json", import.meta.url)));
const playback = JSON.parse(fs.readFileSync(new URL("../docs/kn-r3-text-playback.json", import.meta.url)));
const calls = evidence.observation.calls;
const call = label => {
  const matches = calls.filter(c => c.label === label);
  assert.equal(matches.length, 1);
  return matches[0];
};

test("r3 text evidence is complete, typed and bound to official bundles", () => {
  assert.equal(evidence.ok, true);
  assert.equal(evidence.observation.version, "0.27.4");
  assert.equal(calls.length, 718);
  assert.equal(new Set(calls.map(c => c.label)).size, calls.length);
  assert.deepEqual(evidence.pageErrors, []);
  assert.equal(calls.filter(c => c.type === "logic_compare").length, 492);
  for (const type of new Set(calls.map(c => c.type))) {
    const location = evidence.sourceLocations.find(s => s.type === type);
    assert.ok(location, type);
    assert.ok(evidence.bundles.some(b => b.name === location.bundle && /^[a-f0-9]{64}$/.test(b.sha256) && b.url.startsWith("https://creation.bcmcdn.com/")));
    assert.ok(location.byteOffset > 0);
    assert.match(location.excerptSha256, /^[a-f0-9]{64}$/);
  }
  for (const c of calls) {
    assert.ok(Object.hasOwn(c, "result"), c.label);
    assert.equal(Object.hasOwn(c, "error"), false, c.label);
  }
});

test("r3 numeric boundaries cover exponent thresholds, signed zero and nonfinite", () => {
  const conversions = calls.filter(c => c.type === "convert_type");
  assert.equal(conversions.length, 45);
  assert.ok(conversions.some(c => c.args.text?.$number === "-0" && c.result === "0"));
  for (const number of ["NaN", "Infinity", "-Infinity"]) {
    assert.ok(conversions.some(c => c.args.text?.$number === number && c.result === number));
  }
  for (const expected of ["1e+21", "100000000000000000000", "0.000001", "1e-7", "5e-324", "0.30000000000000004", "1000000000000000100"]) {
    assert.ok(conversions.some(c => c.result === expected), expected);
  }
});

test("r3 full playback verifies differences that raw domain calls cannot establish", () => {
  assert.equal(playback.ok, true);
  assert.deepEqual(playback.pageErrors, []);
  assert.equal(playback.editorCompat.ok, true);
  assert.ok(playback.editorCompat.projects.some(p => p.sha256 === playback.fixtureSha256 && p.ok));
  assert.deepEqual(playback.variables, {
    nanEq: true, nanNe: false, unicode: true, caseSensitive: false, numericText: "1e+21",
    joinStop: "a", joinNested: "abc", joinNull: "a", nullText: "undefined", undefinedContains: false, done: 1,
  });
  assert.equal(call("join-16").result, "anullb");
  assert.equal(call("contains-15").result, false);
  assert.equal(call("compare-37/forward/EQ").result, true);
});

test("r3 case conversion expands Unicode and uses context-sensitive final sigma", () => {
  assert.deepEqual(evidence.observation.caseConversionDomains, ["String.toLowerCase", "String.toUpperCase"]);
  assert.equal(call("case-2/String.toUpperCase").result, "STRASSE");
  assert.equal(call("case-4/String.toLowerCase").result, "i\u0307");
  assert.equal(call("case-7/String.toLowerCase").result, "ος");
  assert.equal(call("case-8/String.toLowerCase").result, "οσα");
  assert.equal(call("case-12/String.toUpperCase").result, "FFI");
});
