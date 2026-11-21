import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// Round 11 captures pin their original renderer, not a later renderer's hash.
// KN's pen shader is not used by K4. Main's r3-render tests separately compare
// its approved batching/cache changes against the round-11 source, while the
// K4 effects tests cover intentional official-pixel fixes. Require this
// branch to match an explicitly approved renderer outside the KN-only shader;
// never relabel the historical capture as a rerun. The second fingerprint adds
// only r4-memory's reviewed cache budget and transient frame-view lifetime.
// Its pixels and resource disposal are exercised by r3-render and r4-memory.
export function assertApprovedK4Renderer(source) {
  const text = source.replaceAll('\r\n', '\n');
  assert.equal((text.match(/const PEN_FRAGMENT = `/g) || []).length, 1);
  const outsideKnPen = text.replace(/^\/\/ Incremental renderer[^\n]*\n/, '')
    .replace(/const PEN_FRAGMENT = `[\s\S]*?`;/, 'const PEN_FRAGMENT = <KN-only>;');
  const digest = createHash('sha256').update(outsideKnPen).digest('hex');
  assert.ok([
    'bfca14d04a8f9033940c9e10cc9d44481daca3621e43f3cfbc5bb79d996ae636',
    '3ab8ddf564412dc2177512cdf22d06153a564995bacecc7bf499a60f6f698b1c',
  ].includes(digest), 'Renderer changed outside the approved mainline/memory versions and KN pen shader');
}

export async function mainlineK4Renderer() {
  const root = new URL('../', import.meta.url);
  const current = (await readFile(new URL('web/renderer.js', root), 'utf8')).replaceAll('\r\n', '\n');
  const mainline = execFileSync('git', ['show', 'a7790374fc5cb544b9e3c60594943a4693b9db4d:web/renderer.js'], {
    cwd: root, encoding: 'utf8',
  }).replaceAll('\r\n', '\n');
  assertApprovedK4Renderer(current);
  return mainline;
}

export async function round11K4Renderer() {
  await mainlineK4Renderer();
  return execFileSync('git', ['show', '7b057f2:web/renderer.js'], {
    cwd: new URL('../', import.meta.url), encoding: 'utf8',
  }).replaceAll('\r\n', '\n');
}
