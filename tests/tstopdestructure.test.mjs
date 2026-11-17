import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { compileFile, checkFile, CompileError } from "../ts/compile-ts.mjs";
import { checkProject, readManifest } from "../tools/compat/kn-share-player-check.mjs";

const bin = path.resolve("target/debug", process.platform === "win32" ? "nekoc.exe" : "nekoc");
const run = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
};
test("tstopdestructure: npm API and browser frontend preserve the same workspace", () => {
  run(process.execPath, ["--experimental-vm-modules", "tests/tstopdestructure-frontends.mjs"]);
});
for (const name of ["probe", "return", "order", "local", "alias", "import"]) {
  test(`tstopdestructure: ${name} matches Node and passes check/share with both optimizations`, async () => {
    const input = `tests/fixtures/tstopdestructure-${name}.ts`;
    const expected = JSON.parse(run(process.execPath, ["tests/tstopdestructure-oracle.mjs", input]));
    if (name === "probe") assert.deepEqual(expected, ["3 4"]);
    if (name === "return") assert.deepEqual(expected, ["3 4 1"]);
    const sourceCheck = checkFile(input);
    assert.equal(sourceCheck.ok, true, JSON.stringify(sourceCheck.diagnostics));
    assert.equal(JSON.parse(run(bin, ["check", input, "--json"])).ok, true);
    const manifest = await readManifest();
    mkdirSync("dist/tstopdestructure", { recursive: true });
    for (const optimize of [false, true]) {
      const output = `dist/tstopdestructure/${name}${optimize ? "-opt" : ""}.bcmkn`;
      run(bin, ["build", input, "-o", output, ...(optimize ? ["--optimize"] : [])]);
      assert.deepEqual(JSON.parse(run(bin, ["run", output, "--ticks", "120"])).logs, expected);
      assert.equal(JSON.parse(run(bin, ["check", output, "--json"])).ok, true);
      const share = checkProject(JSON.parse(readFileSync(output, "utf8")), manifest);
      assert.equal(share.ok, true, JSON.stringify(share));
    }
  });
}

for (const [source, message] of [
  ["const [a = 1] = [2];", /defaults.*explicit/],
  ["const [[a]] = [[2]];", /Nested.*explicitly/],
  ["const {a} = {a: 1};", /simple variable|Object destructuring/],
  ["const [a, a] = [1, 2];", /Duplicate variable/],
  ["const a = 1; const [a] = [2];", /Duplicate variable/],
]) test(`tstopdestructure: unsupported patterns remain located errors: ${source}`, () => {
  const entry = path.resolve("tstopdestructure.ts");
  const host = { readFile: name => name === entry ? `// original\n${source}` : undefined };
  assert.throws(() => compileFile(entry, host), error => error instanceof CompileError
    && error.location?.line === 2 && error.location.column > 0 && message.test(error.message));
  assert.equal(checkFile(entry, { host, types: false }).ok, false);
});
