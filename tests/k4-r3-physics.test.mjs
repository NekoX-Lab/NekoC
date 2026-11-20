import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { physicsProbes, collisionProbes, combinedProject, combinedCollisions, fixturePath, collisionFixturePath } from '../tools/compat/k4-r3-physics.mjs';

test('r3 physics probes are original, reproducible and bound to official observations', () => {
  for (const [file, generated, evidence] of [
    [fixturePath, physicsProbes(), 'docs/kitten4-r3-physics-evidence.json'],
    [collisionFixturePath, collisionProbes(), 'docs/kitten4-r3-collision-evidence.json'],
  ]) {
    const text = readFileSync(file, 'utf8').replaceAll('\r\n', '\n');
    assert.equal(text, JSON.stringify(generated, null, 2) + '\n');
    const report = JSON.parse(readFileSync(evidence));
    assert.equal(report.sha256, createHash('sha256').update(text).digest('hex'));
    assert.deepEqual(Object.keys(report.cases), Object.keys(generated.cases));
    assert.ok(report.assets.some(asset => asset.sha256 === '0f7933d51266add6cbad0682b9531036dc1c8daf8c522cde4243744376ce4160'));
    const { project } = file === fixturePath ? combinedProject(generated) : combinedCollisions(generated);
    assert.equal(report.projectSha256, createHash('sha256').update(JSON.stringify(project, null, 2) + '\n').digest('hex'));
  }
  const probes = physicsProbes();
  const { project } = combinedProject(probes);
  const ids = Object.values(project.theatre.actors).flatMap(actor => Object.keys(actor.block_data_json.blocks));
  assert.equal(new Set(ids).size, ids.length, 'official block IDs are globally unique');
  const report = JSON.parse(readFileSync('docs/kitten4-r3-physics-evidence.json'));
  assert.equal(report.projectSha256, createHash('sha256').update(JSON.stringify(project, null, 2) + '\n').digest('hex'));
  assert.ok(report.assets.some(asset => asset.sha256 === '6ed56cf80a197b1dad00403ef2d55f9f4c357cb000cc52b5b0ba32c3989730d6'), 'real physics module loaded');
  for (const value of Object.values(report.cases)) {
    assert.equal(value.frames.length, 4);
    assert.deepEqual(value.errors, []);
    assert.deepEqual(value.pageErrors, []);
  }
  assert.equal(report.cases['physical-speed'].frames[0].variables.speed, 2);
  const collision = JSON.parse(readFileSync('docs/kitten4-r3-collision-evidence.json'));
  assert.equal(collision.frames, 4);
  assert.deepEqual(collision.errors, []);
  assert.deepEqual(collision.pageErrors, []);
  assert.equal(collision.cases['review-grid-20-20-16-15'].before, false);
  assert.equal(collision.cases['review-flip-0-0-0'].before, true);
  const turn = report.cases['review-turn-710-pivot-0-0'].frames[0].actor;
  assert.equal(turn.x, 627);
  assert.equal(turn.rotation, -170);
});
