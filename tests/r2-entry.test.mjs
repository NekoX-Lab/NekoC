import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));

test("r2-entry: README browser entry resolves to the built Pages player", async t => {
  const readme = await fs.readFile(path.join(root, "README.md"), "utf8");
  const link = readme.match(/\[浏览器播放器\]\(([^)]+)\)/)?.[1];
  assert.ok(link, "README must expose the browser player entry");
  const base = new URL("https://nekox-lab.github.io/NekoC/");
  const url = new URL(link);
  assert.equal(url.origin, base.origin);
  assert.ok(url.pathname.startsWith(base.pathname));
  assert.equal(url.searchParams.get("engine"), "wasm");

  // Exercise the real site builder without a Rust/WASM build or network.
  // Dummy WASM/compiler files only satisfy copying: this test checks public
  // URL/layout correspondence, not the already separately tested WASM runtime.
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "nekoc-pages-entry-"));
  t.after(() => fs.rm(fixture, { recursive: true, force: true }));
  await fs.mkdir(path.join(fixture, "tools"));
  await fs.copyFile(path.join(root, "tools/build-pages.mjs"), path.join(fixture, "tools/build-pages.mjs"));
  await fs.copyFile(path.join(root, "tools/player-offline.mjs"), path.join(fixture, "tools/player-offline.mjs"));
  for (const directory of ["site", "web"]) {
    await fs.cp(path.join(root, directory), path.join(fixture, directory), { recursive: true });
  }
  const pkg = path.join(fixture, "packages/nekoc");
  for (const directory of ["dist/web", "dist/frontend"]) await fs.mkdir(path.join(pkg, directory), { recursive: true });
  for (const file of ["browser.mjs", "api.mjs", "dist/resources.mjs", "dist/web/nekoc_wasm.js", "dist/web/nekoc_wasm_bg.wasm"]) {
    await fs.writeFile(path.join(pkg, file), "test-only placeholder");
  }
  const ts = path.dirname(createRequire(import.meta.url).resolve("typescript/package.json"));
  for (const file of ["package.json", "LICENSE.txt", "lib/typescript.js"]) {
    const destination = path.join(fixture, "node_modules/typescript", file);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(path.join(ts, file), destination);
  }
  const samples = path.join(fixture, "samples");
  await fs.mkdir(samples);
  for (const file of ["stage_demo.nk.ts", "basic.ts", "js_compat.ts", "control_flow.ts", "lists.ts", "custom_procedures.ts"]) {
    await fs.copyFile(path.join(root, "samples", file), path.join(samples, file));
  }
  const output = path.join(fixture, "dist/pages");
  const result = spawnSync(process.execPath, [path.join(fixture, "tools/build-pages.mjs"), output], { encoding: "utf8" });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const site = await fs.readFile(path.join(output, "index.html"), "utf8");
  const iframe = site.match(/<iframe\b[^>]*\bsrc="([^"]+)"/)?.[1];
  assert.ok(iframe, "built online compiler must embed the player");
  assert.equal(new URL(iframe, base).pathname, url.pathname);
  const relative = decodeURIComponent(url.pathname.slice(base.pathname.length));
  const player = await fs.readFile(path.join(output, relative), "utf8");
  assert.match(player, /<title data-i18n="playerTitle">Neko · 纯播放器<\/title>/);
  assert.match(player, /<meta name="nekoc-engine" content="wasm">/);
  for (const file of ["i18n.js", "repro.js", "input.js", "player-feedback.js"]) {
    assert.equal(await fs.readFile(path.join(output, "play", file), "utf8"),
      await fs.readFile(path.join(root, "web", file), "utf8"), `player dependency: ${file}`);
  }
});
