import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

// Round 11 captures pin their original renderer, not a later renderer's hash.
// KN's pen shader is not used by K4. Main's r3-render tests separately compare
// its approved batching/cache changes against the round-11 source, while the
// K4 effects tests cover intentional official-pixel fixes. Require this
// branch to preserve every byte of that mainline renderer outside the KN-only
// shader; never relabel the historical capture as a rerun.
export async function mainlineK4Renderer() {
  const root = new URL('../', import.meta.url);
  const current = (await readFile(new URL('web/renderer.js', root), 'utf8')).replaceAll('\r\n', '\n');
  const mainline = execFileSync('git', ['show', 'a7790374fc5cb544b9e3c60594943a4693b9db4d:web/renderer.js'], {
    cwd: root, encoding: 'utf8',
  }).replaceAll('\r\n', '\n');
  const outsideKnPen = text => {
    assert.equal((text.match(/const PEN_FRAGMENT = `/g) || []).length, 1);
    return text.replace(/^\/\/ Incremental renderer[^\n]*\n/, '')
      .replace(/const PEN_FRAGMENT = `[\s\S]*?`;/, 'const PEN_FRAGMENT = <KN-only>;');
  };
  assert.deepEqual(outsideKnPen(current), outsideKnPen(mainline),
    'Renderer changed outside the approved mainline and KN pen shader');
  return mainline;
}

export async function round11K4Renderer() {
  await mainlineK4Renderer();
  return execFileSync('git', ['show', '7b057f2:web/renderer.js'], {
    cwd: new URL('../', import.meta.url), encoding: 'utf8',
  }).replaceAll('\r\n', '\n');
}
