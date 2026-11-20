import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { inflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { compileFile } from "../ts/compile-ts.mjs";

// Check the embedded assets as well as the frontend: truncated PNGs can load
// partially (as a black rectangle) without making editor-compat fail.
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

for (const name of ["movement-collision", "menu-scenes", "list-inventory"]) {
  test(`r2 template ${name}: standalone compilation and intact embedded PNGs`, () => {
    const input = new URL(`../samples/templates/${name}.nk.ts`, import.meta.url);
    const source = fs.readFileSync(input, "utf8");
    const report = compileFile(fileURLToPath(input));
    assert.ok(report.resources);
    const assets = [...source.matchAll(/const (\w+) = "data:image\/png;base64,([^"]+)";/g)];
    assert.ok(assets.length >= 2);
    for (const [, label, base64] of assets) {
      const bytes = Buffer.from(base64, "base64");
      assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", label);
      const compressed = [];
      let ended = false;
      for (let offset = 8; offset < bytes.length;) {
        const length = bytes.readUInt32BE(offset);
        const end = offset + 8 + length;
        assert.ok(end + 4 <= bytes.length, label);
        assert.equal(crc32(bytes.subarray(offset + 4, end)), bytes.readUInt32BE(end), label);
        const type = bytes.toString("ascii", offset + 4, offset + 8);
        if (type === "IDAT") compressed.push(bytes.subarray(offset + 8, end));
        if (type === "IEND") ended = true;
        offset = end + 4;
      }
      assert.ok(ended, label);
      // Original assets: RGB8 or a one-colour indexed bitmap (one bit/pixel).
      const bitsPerPixel = bytes[25] === 2 ? 24 : 1;
      assert.ok((bytes[24] === 8 && bytes[25] === 2) || (bytes[24] === 1 && bytes[25] === 3), label);
      const pixels = inflateSync(Buffer.concat(compressed));
      assert.equal(pixels.length, (Math.ceil(bytes.readUInt32BE(16) * bitsPerPixel / 8) + 1) * bytes.readUInt32BE(20), label);
    }
  });
}
