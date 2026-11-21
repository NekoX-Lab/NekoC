import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { compileFile, checkFile } from "../ts/compile-ts.mjs";
import { docs, frontendFiles } from "../tools/package-release.mjs";

test("r2-tsdiag release retains main frontend modules and the support contract", () => {
  for (const file of ["diagnostics.mjs", "js-support.mjs", "ts-r2-destructure.mjs", "tsfeat-classes.mjs", "tsfeat-class-inherit.mjs", "share-objects.mjs"]) {
    assert.ok(frontendFiles.includes(file), file);
    assert.equal(frontendFiles.filter(name => name === file).length, 1, file);
  }
  for (const file of ["compiler-only.md", "js-support.md", "ts-diagnostics.md"]) assert.ok(docs.includes(file), file);
});

const document = fs.readFileSync(new URL("../docs/js-support.md", import.meta.url), "utf8");
const groups = new Map();
const fences = [...document.matchAll(/^```([^\r\n]*)\r?\n([\s\S]*?)^```\s*$/gm)];
for (const [, header, source] of fences) {
  const match = /^ts example=([\w-]+) file=([\w.-]+\.ts)$/.exec(header);
  assert.ok(match, `Every code fence must be an executable documented example: ${header}`);
  const [, id, file] = match;
  const files = groups.get(id) ?? new Map();
  const name = path.resolve("virtual/r2-tsdiag-docs", id, file);
  assert.ok(!files.has(name), `Duplicate ${id}/${file}`);
  files.set(name, source);
  groups.set(id, files);
}
assert.ok(groups.size >= 20, "The complete support contract must contain examples");
for (const [id, files] of groups) {
  test(`r2-tsdiag documentation compiles: ${id}`, () => {
    const entry = path.resolve("virtual/r2-tsdiag-docs", id, "main.ts");
    assert.ok(files.has(entry), `${id} needs main.ts`);
    const host = { readFile: name => files.get(name) };
    const checked = checkFile(entry, { types: false, host });
    assert.equal(checked.ok, true, JSON.stringify(checked.diagnostics));
    assert.ok(checked.report.summary.blocks > 0);
    assert.doesNotThrow(() => compileFile(entry, host));
    // Also run the user-facing default type check with real standard-library
    // resources; the in-memory compile alone cannot catch API name collisions.
    const parent = path.resolve("dist/r2-tsdiag-docs-test");
    fs.mkdirSync(parent, { recursive: true });
    const dir = fs.mkdtempSync(path.join(parent, `${id}-`));
    try {
      for (const [name, source] of files) fs.writeFileSync(path.join(dir, path.basename(name)), source);
      const typed = checkFile(path.join(dir, "main.ts"));
      assert.equal(typed.ok, true, JSON.stringify(typed.diagnostics));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}
