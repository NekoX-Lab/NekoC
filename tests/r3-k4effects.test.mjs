import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { StageRenderer } from '../web/renderer.js';
import { completeCapture } from '../tools/compat/r3-k4effects.mjs';
import { mainlineK4Renderer } from './renderer-evidence.mjs';

const read = async file => JSON.parse(await readFile(file, 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('r3-k4effects: neutral twist stays enabled with native padding until clear', async () => {
  const evidence = await read('docs/r3-k4effects-official.json');
  assert.equal(evidence.fixtureSha256, hash(await readFile('tests/fixtures/kitten4/partial-effects-11-self_set_effect_2-actor-chain.bcm')));
  assert.deepEqual(evidence.errors, []);
  assert.ok(evidence.externalRequests.every(r => r.action === 'blocked'));
  assert.equal(evidence.sha256, '0f7933d51266add6cbad0682b9531036dc1c8daf8c522cde4243744376ce4160');
  assert.equal(evidence.observations.length, 52);
  for (const frame of [27, 28, 29, 30, 31, 32]) {
    assert.deepEqual(evidence.observations[frame - 1], { frame, angle: 0, enabled: true, padding: 20 });
  }
  for (const frame of [17, 18, 33, 34, 49, 50, 51, 52]) {
    assert.equal(evidence.observations[frame - 1].enabled, false);
  }
});

test('r3-k4effects: dispatch retains zero-angle filters only for K4 and avoids recursion', () => {
  const r = { kitten4: true, drawK4SpatialTexture: (...args) => args };
  const draw = context => StageRenderer.prototype.drawTexture.call(context,
    'texture', 0, 0, 96, 64, 0, [1, 1, 1, 1], Array(8).fill(0), [96, 64], null, null, false, true);
  const args = draw(r);
  assert.equal(args.at(-1), true);
  assert.deepEqual(args[7], Array(8).fill(0));
  assert.throws(() => draw({ ...r, kitten4: false }), TypeError);
  assert.throws(() => draw({ ...r, k4Filtering: true }), TypeError);
});

test('r3-k4effects: pixel evidence rejects partial, masked or differently sized captures', () => {
  const frame = { frame: 1, width: 960, height: 720, pixels: 960 * 720, tolerance: 8, maskedPixels: 0, scope: 'canvas' };
  const result = { status: 'captured', frames: [frame] };
  assert.ok(completeCapture(result, 1));
  assert.equal(completeCapture(result, 2), false);
  assert.equal(completeCapture({ ...result, status: 'unverified' }, 1), false);
  for (const change of [{ frame: 2 }, { maskedPixels: 1 }, { width: 480 }, { tolerance: 9 }, { scope: 'crop' }]) {
    assert.equal(completeCapture({ ...result, frames: [{ ...frame, ...change }] }, 1), false);
  }
});

test('r3-k4effects: enabled-only deltas invalidate the renderer and clear removes the flag', () => {
  const actor = { id: 'actor', effects: Array(8).fill(0) };
  const r = { sprites: [actor], spriteIndices: new Map([['actor', 0]]),
    stats: {}, canvas: { width: 960, height: 720 }, dirty: false,
    gl: { bindFramebuffer() {}, viewport() {} },
    applyVideos() {}, collectGpuTimes() {}, drawLines() {}, flushTextureBatch() {},
  };
  const apply = sprite => StageRenderer.prototype.apply.call(r, { sprites: [sprite] }, new Float32Array(), false);
  apply({ ...actor });
  assert.equal(r.dirty, false);
  apply({ ...actor, k4_twist_enabled: true });
  assert.equal(r.dirty, true);
  r.dirty = false;
  apply({ ...actor });
  assert.equal(r.dirty, true);
  assert.equal(r.sprites[0].k4_twist_enabled, undefined);
});

test('r3-k4effects: paired real VM pixels remove the neutral-filter failure', async () => {
  const evidence = await read('docs/r3-k4effects-pixels.json');
  // Keep the capture's original hash. The helper first proves that current
  // matches an approved renderer outside the unused KN pen shader.
  const renderer = hash(await mainlineK4Renderer());
  for (const [name, pair] of Object.entries(evidence.cases)) {
    assert.equal(pair.baseline.rendererLfSha256, 'eb5f51230e59c5fc695cd489e173282803d568d3b0b3eb54b623692679e028a3');
    assert.equal(pair.fixed.rendererLfSha256, renderer);
    assert.equal(pair.baseline.fixtureSha256, pair.fixed.fixtureSha256);
    assert.equal(pair.fixed.fixtureSha256, hash(await readFile(`tests/fixtures/kitten4/partial-effects-11-${name}.bcm`)));
    assert.notEqual(pair.baseline.executableSha256, pair.fixed.executableSha256);
    for (const version of ['baseline', 'fixed']) {
      assert.ok(pair[version].identitiesStable);
      assert.ok(completeCapture(pair[version], name.includes('change_effect_3') ? 66 : 52));
      assert.ok(pair[version].kernelAssets.some(a => a.sha256 === '0f7933d51266add6cbad0682b9531036dc1c8daf8c522cde4243744376ce4160'));
    }
    assert.equal(pair.baseline.summary.maxChangedPixels, name.includes('scene') ? 1679 : 629);
    assert.equal(pair.fixed.summary.maxChangedPixels, 0);
    assert.ok(pair.fixed.frames.every(f => f.changedPixels === 0));
  }
});
