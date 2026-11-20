import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { frontendFiles } from "../../../tools/package-release.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const packageDir = path.join(root, "packages/nekoc");

test("r2-entry: npm pack installs, checks and exports without Rust or checkout dependencies", async t => {
  const npmCli = process.env.npm_execpath;
  assert.ok(npmCli, "Run with npm --prefix packages/nekoc run test:pack");
  const temp = await fs.mkdtemp(path.join(process.env.NEKOC_SMOKE_TEMP ?? os.tmpdir(), "nekoc npm smoke-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  // Deliberately outside the checkout, including paths with spaces. Neither
  // Node's parent lookup nor NODE_PATH may supply a missing packaged module.
  for (let ancestor = temp; ; ancestor = path.dirname(ancestor)) {
    await assert.rejects(fs.access(path.join(ancestor, "node_modules")), { code: "ENOENT" },
      `Smoke directory has a node_modules ancestor: ${ancestor}; set NEKOC_SMOKE_TEMP to an isolated directory`);
    if (path.dirname(ancestor) === ancestor) break;
  }
  const env = { ...process.env, NODE_PATH: "", NODE_OPTIONS: "" };
  const run = (args, { cwd = temp, status = 0, ...options } = {}) => {
    const result = spawnSync(process.execPath, args, { cwd, env, encoding: "utf8", timeout: 120_000, ...options });
    assert.ifError(result.error);
    assert.equal(result.status, status, `${args.join(" ")}\n${result.stdout}${result.stderr}`);
    return result.stdout;
  };
  const releases = path.join(root, "dist/releases");
  await fs.mkdir(releases, { recursive: true });
  // A real tarball, not a file: directory link. Keep it for release CI.
  const [pack] = JSON.parse(run([npmCli, "pack", "--ignore-scripts", "--json", "--pack-destination", releases], { cwd: packageDir }));
  const names = new Set(pack.files.map(file => file.path));
  const required = [
    "package.json", "README.md", "index.mjs", "index.d.ts", "api.mjs", "browser.mjs", "frame.mjs", "bin/nekoc.mjs",
    "dist/resources.mjs", "dist/LICENSE",
    ...["nodejs", "web"].flatMap(target => ["package.json", "nekoc_wasm.js", "nekoc_wasm_bg.wasm"].map(name => `dist/${target}/${name}`)),
    ...frontendFiles.filter(name => name !== "test-ts.mjs").map(name => `dist/frontend/${name}`),
  ];
  for (const name of required) assert.ok(names.has(name), `missing package file: ${name}; build packages/nekoc first`);
  for (const name of names) {
    assert.ok(!/^(?:build\.mjs|test\/|node_modules\/|src\/|target\/|web\/|extension\/|projects\/|samples\/)/.test(name), `unexpected package file: ${name}`);
    assert.ok(!/\.(?:rs|exe|node|bcmkn|bcm)$/.test(name), `unexpected native/source/work file: ${name}`);
  }
  const tarball = path.join(releases, pack.filename);
  assert.equal((await fs.stat(tarball)).size, pack.size);
  await fs.writeFile(path.join(temp, "package.json"), JSON.stringify({ name: "nekoc-install-smoke", private: true, type: "module" }));
  run([npmCli, "install", "--ignore-scripts", "--no-audit", "--no-fund", tarball]);
  const installed = path.join(temp, "node_modules/@fttawa/nekoc");
  assert.equal((await fs.lstat(installed)).isSymbolicLink(), false);
  const manifest = JSON.parse(await fs.readFile(path.join(installed, "package.json"), "utf8"));
  assert.equal(manifest.bin.nekoc, "bin/nekoc.mjs");
  assert.deepEqual(Object.keys(manifest.dependencies), ["typescript"]);
  for (const hook of ["preinstall", "install", "postinstall", "prepare"]) assert.equal(manifest.scripts?.[hook], undefined, hook);
  const cli = path.join(installed, manifest.bin.nekoc);
  await fs.copyFile(path.join(root, "samples/stage_demo.nk.ts"), path.join(temp, "stage_demo.nk.ts"));
  // npm exec exercises the installed bin shim (the npx --no-install path),
  // with registry access disabled so it cannot silently fetch a different CLI.
  run([npmCli, "exec", "--offline", "--yes=false", "--", "nekoc", "check", "stage_demo.nk.ts"]);
  // The actual compile/check/run commands get an empty PATH. Even a developer
  // machine with Rust installed must not be able to fall back to it.
  const emptyPath = path.join(temp, "empty-path");
  await fs.mkdir(emptyPath);
  const isolatedEnv = Object.fromEntries(Object.entries(env).filter(([key]) => key.toLowerCase() !== "path"));
  isolatedEnv.PATH = emptyPath;
  for (const command of ["cargo", "rustc", "nekoc"]) {
    assert.equal(spawnSync(command, ["--version"], { cwd: temp, env: isolatedEnv }).error?.code, "ENOENT", `${command} must not be available`);
  }
  const invoke = (args, options = {}) => run([cli, ...args], { ...options, env: isolatedEnv });
  assert.equal(JSON.parse(invoke(["check", "stage_demo.nk.ts", "--json"])).ok, true);
  invoke(["build", "stage_demo.nk.ts", "-o", "stage_demo.bcmkn"]);
  const work = JSON.parse(await fs.readFile(path.join(temp, "stage_demo.bcmkn"), "utf8"));
  assert.ok(Object.keys(work).length > 0);
  assert.match(invoke(["run", "stage_demo.bcmkn", "--frames", "120"]), /cat done/);
  await fs.mkdir(path.join(temp, "lib"));
  await fs.writeFile(path.join(temp, "lib/index.ts"), "export function twice(n: number): number { return n * 2; }");
  await fs.writeFile(path.join(temp, "main.ts"), 'import { twice } from "./lib"; onStart(() => { console.log(twice(21)); });');
  assert.equal(JSON.parse(invoke(["check", "main.ts", "--json"])).ok, true);
  invoke(["build", "main.ts"]);
  assert.equal(invoke(["run", "main.bcmkn", "--frames", "3"]).trim(), "42");
  await fs.writeFile(path.join(temp, "invalid.ts"), 'const value: number = "wrong";');
  const invalid = JSON.parse(invoke(["check", "invalid.ts", "--json"], { status: 1 }));
  assert.equal(invalid.ok, false);
  assert.ok(invalid.diagnostics.some(d => d.code === "TS2322" && d.line > 0 && d.column > 0));
  const bytes = async directory => {
    let total = 0;
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      total += entry.isDirectory() ? await bytes(file) : (await fs.stat(file)).size;
    }
    return total;
  };
  const measurement = {
    name: pack.name, version: pack.version, tarball: pack.filename,
    compressedBytes: pack.size, unpackedBytes: pack.unpackedSize, fileCount: pack.entryCount,
    typescriptBytes: await bytes(path.join(temp, "node_modules/typescript")),
    installedNodeModulesBytes: await bytes(path.join(temp, "node_modules")),
    wasm: pack.files.filter(file => file.path.endsWith(".wasm")).map(({ path, size }) => ({ path, bytes: size })),
  };
  await fs.writeFile(path.join(releases, "npm-package-size.json"), `${JSON.stringify(measurement, null, 2)}\n`);
  // Retain our own generated sample for the separate official-editor check.
  await fs.copyFile(path.join(temp, "stage_demo.bcmkn"), path.join(releases, "npm-smoke-stage.bcmkn"));
  t.diagnostic(JSON.stringify(measurement));
});
