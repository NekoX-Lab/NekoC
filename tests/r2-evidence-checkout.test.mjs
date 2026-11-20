import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const pinned = [
  "docs/kncompat-hateneko-evidence.json",
  "docs/kn-value-types-official.json",
  "docs/kn-semantics-official.json",
  "docs/kn-objects-official.json",
  "docs/actor-variables-official.json",
  "docs/kn-async-services-evidence.json",
  "docs/input-kn-evidence.json",
  "docs/audio-evidence.json",
  "docs/audio-runtime-evidence.json",
  "docs/nonfinite-verification.json",
  "samples/kitten-n-0.27.4.bcmkn",
  "samples/native-studio.bcmkn",
  "samples/web-pen-stress.bcmkn",
];
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const readJson = async file => JSON.parse(await fs.readFile(path.join(root, file), "utf8"));

for (const autocrlf of ["false", "true"]) {
  test(`r2-entry: exact evidence bytes survive Git checkout with core.autocrlf=${autocrlf}`, async t => {
    const official = await readJson("docs/compatibility/hncompat2-official.json");
    const frequency = await readJson("docs/kn-partial-frequency.json");
    const references = new Map([official.baseline, ...official.existingEvidence, ...frequency.files]
      .map(reference => [reference.file, reference.sha256]));
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "nekoc-evidence-checkout-"));
    t.after(() => fs.rm(fixture, { recursive: true, force: true }));
    const git = (...args) => execFileSync("git", [
      "-c", `core.autocrlf=${autocrlf}`, "-c", "core.eol=lf",
      "-c", "core.safecrlf=false", "-c", "core.attributesFile=", ...args,
    ], { cwd: fixture, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    git("init", "--quiet");
    for (const file of pinned) {
      // Start with committed blobs, not the platform's working-tree bytes.
      const blob = execFileSync("git", ["show", `HEAD:${file}`], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
      const expected = references.get(file);
      assert.ok(expected, `missing recorded evidence hash: ${file}`);
      assert.notEqual(hash(blob), expected, `LF blob must reproduce the original mismatch: ${file}`);
      const target = path.join(fixture, file);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, blob);
    }
    await fs.copyFile(path.join(root, ".gitattributes"), path.join(fixture, ".gitattributes"));
    git("add", "--", ".gitattributes", ...pinned);
    for (const file of pinned) await fs.rm(path.join(fixture, file));
    git("checkout-index", "--all");
    for (const file of pinned) {
      assert.equal(hash(await fs.readFile(path.join(fixture, file))), references.get(file), file);
    }
  });
}
