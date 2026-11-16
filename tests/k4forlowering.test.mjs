import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { compileFile, checkFile } from "../ts/compile-ts.mjs";
import { readManifest } from "../tools/compat/kn-share-player-check.mjs";
import { frontendFiles } from "../tools/package-release.mjs";

const entry = path.resolve("virtual/k4forlowering.ts");
const source = "onStart(() => { for (let i=0; i<10; i++) moveSteps(i); });";
const host = text => ({ readFile: name => name === entry ? text : undefined });
const compile = (text, target) => compileFile(entry, host(text), { target });

test("k4forlowering: K4 skips traversal, default KN graph is unchanged and share-supported", async () => {
  const kn = compile(source);
  assert.deepEqual(kn, compile(source, "kitten-n"));
  const types = report => Object.values(report.workspaceData.blocks).map(b => b.type);
  for (const name of ["traverse_number", "traverse_number_param", "traverse_number_value"]) assert.ok(types(kn).includes(name));
  const k4 = compile(source, "kitten4");
  assert.ok(types(k4).includes("repeat_forever_until"));
  assert.ok(types(k4).every(type => !type.startsWith("traverse_number")));
  const manifest = await readManifest();
  for (const type of types(k4)) assert.ok(manifest.blocks.includes(type), type);
  assert.deepEqual(checkFile(entry, { types: false, host: host(source), target: "kitten4" }).report, k4);
});

test("k4forlowering: unsupported K4 forms are source-located with actionable hints", () => {
  for (const [text, hint] of [
    ['onStart(() => {\n forRange("i", 0, 3, 1, () => { moveSteps(1); });\n});', /Replace forRange/],
    ['onStart(() => {\n scriptVars("local");\n});', /basic variables/],
    ['function f(n: number): number { if (n < 1) return 1; return f(n-1); }\nsetVar("x", f(3));', /custom procedures/],
    ['onMessage("go", () => {\n for(let i=0;i<3;i++) moveSteps(i);\n});', /per-invocation/],
    ['onKey("a", () => {\n for(let i=0;i<3;i++) moveSteps(i);\n});', /per-invocation/],
    ['when(true, () => {\n for(let i=0;i<3;i++) moveSteps(i);\n});', /per-invocation/],
    ['function f() { for(let i=0;i<3;i++) moveSteps(i); }\nonMessage("go", () => { f(); });', /per-invocation/],
  ]) {
    const result = checkFile(entry, { types: false, host: host(text), target: "kitten4" });
    assert.equal(result.ok, false);
    const diagnostic = result.diagnostics[0];
    assert.equal(diagnostic.source, "compat");
    assert.match(diagnostic.message, hint);
    assert.equal(path.resolve(diagnostic.file), entry);
    assert.ok(diagnostic.line >= 1 && diagnostic.column >= 1, JSON.stringify(diagnostic));
  }
});

test("k4forlowering: imported functions retain K4 preflight locations", () => {
  const dependency = path.resolve("virtual/loops.ts");
  const files = new Map([
    [entry, 'import { run } from "./loops"; onStart(() => { run(); });'],
    [dependency, 'export function run() {\n forRange("i",0,3,1,()=>{ moveSteps(1); });\n}'],
  ]);
  const result = checkFile(entry, { types: false, host: { readFile: name => files.get(name) }, target: "kitten4" });
  assert.equal(result.ok, false);
  assert.equal(path.resolve(result.diagnostics[0].file), dependency);
  assert.equal(result.diagnostics[0].line, 2);
  assert.match(result.diagnostics[0].message, /Replace forRange/);
});

test("k4forlowering: source errors take precedence over unsupported generated helpers", () => {
  const text = '// heading\nonStart(() => {\n const a=[1];\n a.map(x => missingApi(x));\n});';
  const check = target => checkFile(entry, { types: false, host: host(text), target });
  const kn = check("kitten-n"), k4 = check("kitten4");
  assert.equal(kn.ok, false);
  assert.deepEqual(k4.diagnostics, kn.diagnostics);
  assert.equal(k4.diagnostics[0].line, 4);
  assert.match(k4.diagnostics[0].message, /missingApi/);
});

test("k4forlowering: Node CLI forwards the same target for check and compile and preserves output on errors", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "k4forlowering-"));
  try {
    const input = path.join(dir, "main.ts"), output = path.join(dir, "report.json");
    writeFileSync(input, source);
    const run = args => spawnSync(process.execPath, ["ts/compile-ts.mjs", ...args], { encoding: "utf8" });
    assert.equal(run([input, output, "--target=kitten4"]).status, 0);
    const report = JSON.parse(readFileSync(output, "utf8"));
    assert.ok(!Object.values(report.workspaceData.blocks).some(b => b.type.startsWith("traverse_number")));
    assert.equal(run(["--check", "--json", input, "--target=kitten4"]).status, 0);
    writeFileSync(input, 'onStart(() => {\n forRange("i",0,3,1,()=>{ moveSteps(1); });\n});');
    writeFileSync(output, "keep");
    const failed = run([input, output, "--target=kitten4"]);
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /main\.ts:2:\d+.*Replace forRange/);
    assert.equal(readFileSync(output, "utf8"), "keep");
    const checked = JSON.parse(run(["--check", "--json", input, "--target=kitten4"]).stdout);
    assert.equal(checked.ok, false);
    assert.equal(checked.diagnostics[0].line, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("k4forlowering: shared Node/browser package API forwards target in compile and check", async () => {
  assert.ok(frontendFiles.includes("compile-target.mjs"));
  // Exercise the actual wrapper without requiring rebuilt wasm: assembly is
  // unrelated to lowering and is stubbed to expose the report passed to it.
  const wrapper = readFileSync("packages/nekoc/api.mjs", "utf8")
    .replace('"./dist/frontend/compile-ts.mjs"', JSON.stringify(new URL("../ts/compile-ts.mjs", import.meta.url).href))
    .replace('import resources from "./dist/resources.mjs";', 'const resources = {};')
    .replace('"./dist/frontend/portable-path.mjs"', JSON.stringify(new URL("../ts/portable-path.mjs", import.meta.url).href));
  const { api } = await import(`data:text/javascript;base64,${Buffer.from(wrapper).toString("base64")}`);
  const sdk = api({ assembleBcmkn: report => report, projectDiagnostics: () => "[]" });
  const options = { files: { "/main.ts": source }, target: "kitten4", types: false };
  const result = sdk.compile("/main.ts", options);
  assert.ok(!Object.values(result.report.workspaceData.blocks).some(b => b.type.startsWith("traverse_number")));
  assert.equal(sdk.check("/main.ts", options).ok, true);
  options.files["/main.ts"] = 'onStart(()=>{\nforRange("i",0,3,1,()=>{ moveSteps(1); });});';
  assert.throws(() => sdk.compile("/main.ts", options), /Replace forRange/);
  const checked = sdk.check("/main.ts", options);
  assert.equal(checked.ok, false);
  assert.equal(checked.diagnostics[0].line, 2);
});

test("k4forlowering: npm CLI carries --target through discovery, check and build", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "k4forlowering-cli-"));
  try {
    const frontend = JSON.stringify(new URL("../ts/compile-ts.mjs", import.meta.url).href);
    // Replace only wasm assembly/type resources; run the actual CLI's argument
    // handling, filesystem discovery and frontend with the selected target.
    const cli = readFileSync("packages/nekoc/bin/nekoc.mjs", "utf8")
      .replace('"../dist/frontend/compile-ts.mjs"', frontend)
      .replace('import { compile, check, createPlayer, importProject } from "../index.mjs";', `
        import { compileFile as lower, checkFile as preflight } from ${frontend};
        const host = files => ({readFile: name => files[name.replace(/^[A-Za-z]:/, "").replaceAll("\\\\", "/")]});
        const compile = (entry, {files, target}) => ({bcmkn: lower(entry, host(files), {target})});
        const check = (entry, {files, target}) => preflight(entry, {host: host(files), target, types: false});`)
      .replace('"../frame.mjs"', JSON.stringify(new URL("../packages/nekoc/frame.mjs", import.meta.url).href));
    const script = path.join(dir, "cli.mjs"), input = path.join(dir, "main.ts"), output = path.join(dir, "report.json");
    writeFileSync(script, cli);
    writeFileSync(input, source);
    const run = args => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
    const built = run(["build", input, "--target=kitten4", "-o", output]);
    assert.equal(built.status, 0, built.stderr);
    assert.ok(!Object.values(JSON.parse(readFileSync(output, "utf8")).workspaceData.blocks).some(b => b.type.startsWith("traverse_number")));
    assert.equal(run(["check", input, "--target=kitten4", "--json"]).status, 0);
    writeFileSync(input, 'onStart(()=>{\nforRange("i",0,3,1,()=>{ moveSteps(1); });});');
    assert.equal(run(["build", input, "-o", output, "--target=kitten4"]).status, 1);
    const checked = run(["check", input, "--json", "--target=kitten4"]);
    assert.equal(checked.status, 1);
    assert.match(JSON.parse(checked.stdout).diagnostics[0].message, /Replace forRange/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
