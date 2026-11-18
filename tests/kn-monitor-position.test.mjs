import test from 'node:test';
import assert from 'node:assert/strict';
import { knMonitorPosition } from '../web/overlay.js';

// Saved positions from published PICKCAT works (stage 900x562): the official
// KN player draws "FPS" at y=436 near the bottom-left, not in a stacked corner.
test('KN monitors read their saved stage-pixel position', () => {
  const project = { variables: { variablesDict: {
    fps: { position: { x: 0, y: 436.4941860465117 } },
    score: { position: { x: 9.375, y: 7.805555555555555 } },
    text: { position: { x: '12', y: '30' } },
    broken: { position: { x: 'left', y: 0 } },
    none: {},
  } } };
  assert.deepEqual(knMonitorPosition(project, 'fps'), { x: 0, y: 436.4941860465117 });
  assert.deepEqual(knMonitorPosition(project, 'score'), { x: 9.375, y: 7.805555555555555 });
  assert.deepEqual(knMonitorPosition(project, 'text'), { x: 12, y: 30 });
  for (const id of ['broken', 'none', 'missing']) assert.equal(knMonitorPosition(project, id), null, id);
  assert.equal(knMonitorPosition(null, 'fps'), null);
});
