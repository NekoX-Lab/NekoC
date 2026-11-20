#!/usr/bin/env node
// Reuse owned round-11 inputs, but never overwrite their historical evidence.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { partialEffects11Fixtures, selectEffects11Cases } from './k4-effects-11-fixtures.mjs';
import { visualWork } from './k4-visual.mjs';
import { saveJson, runOracle } from './k4-oracle.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function completeCapture(result, frames) {
  return result.status === 'captured' && result.frames.length === frames
    && result.frames.every((f, i) => f.frame === i + 1 && f.tolerance === 8
      && f.maskedPixels === 0 && f.scope === 'canvas'
      && f.width === 960 && f.height === 720 && f.pixels === 960 * 720);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--record')) {
    const cases = {};
    for (const target of ['actor', 'scene']) for (const type of ['self_set_effect_2', 'self_change_effect_3']) {
      const name = `${type}-${target}-chain`;
      const pair = {};
      for (const label of ['baseline', 'fixed']) {
        const result = JSON.parse(await readFile(`dist/r3-k4effects/${label}/${name}.json`, 'utf8'));
        const { rendererLfSha256, executableSha256, fixtureSha256, status, identitiesStable,
          fullCanvasCaptureComplete, frames, kernelAssets, summary } = result;
        if (!fullCanvasCaptureComplete || !identitiesStable) throw Error(`Incomplete evidence: ${label}/${name}`);
        pair[label] = { rendererLfSha256, executableSha256, fixtureSha256, status, identitiesStable,
          fullCanvasCaptureComplete,
          frames: frames.map(({ frame, width, height, pixels, maskedPixels, tolerance, scope, changedPixels, mae }) =>
            ({ frame, width, height, pixels, maskedPixels, tolerance, scope, changedPixels, mae })),
          kernelAssets, summary };
      }
      cases[name] = pair;
    }
    await saveJson('docs/r3-k4effects-pixels.json', {
      schema: 'nekoc-r3-k4effects-paired-v1', baselineCommit: 'd6de981',
      scope: 'Real NekoC VM and official VM; consecutive full 960x720 canvas; RGB tolerance 8; no masks', cases,
    });
    return;
  }
  if (args.includes('--probe')) {
    const spec = (await partialEffects11Fixtures())['self_set_effect_2-actor-chain'];
    const observations = [];
    const trace = await runOracle(spec.project, { virtualTime: true, frames: spec.frames, seed: 1,
      onFrame: async (page, frame) => {
        observations.push(await page.evaluate(({ aid, frame }) => {
          const fx = window.__k4OracleRequire('a1xw').a().get_actor_by_id(aid).get_effects().value;
          const twist = fx.effect_filter_list[4];
          return { frame, angle: fx.get_twist(), enabled: !!twist?.enabled, padding: twist?.padding ?? null };
        }, { aid: spec.aid, frame }));
      },
    });
    const file = 'src/player/build/player_v2.2d180c468559fbd29528.js.orig';
    const bytes = await readFile(path.join(process.env.K4_PLAYER_DIR, file));
    const source = bytes.toString('utf8');
    const anchors = ['get_effect_filter(t){', 'set_twist(t){', 'disable_effects(){'];
    const locations = Object.fromEntries(anchors.map(anchor => {
      const offset = source.indexOf(anchor);
      if (offset < 0) throw Error(`Missing official anchor: ${anchor}`);
      return [anchor, { offset, windowLength: 256, windowSha256: hash(source.slice(offset, offset + 256)) }];
    }));
    if (trace.errors.length || observations.length !== spec.frames) throw Error('Incomplete official probe');
    await saveJson('docs/r3-k4effects-official.json', {
      schema: 'nekoc-r3-k4effects-official-v1',
      scope: 'Official VM and native filter state only, not NekoC pixels',
      file, sha256: hash(bytes), offsetUnit: '0-based UTF-16 code units after UTF-8 decoding', locations,
      fixtureSha256: hash(JSON.stringify(spec.project, null, 2) + '\n'),
      observations, errors: trace.errors, assets: trace.diagnostics.assets,
      externalRequests: trace.diagnostics.externalRequests,
    });
    console.log(`Official filter observations: ${observations.length}`);
    return;
  }
  if (args.includes('--help')) {
    console.log('node tools/compat/r3-k4effects.mjs [--probe | --record | --label=baseline|fixed] [--nekoc=path] [case ...]');
    return;
  }
  const label = args.find(a => a.startsWith('--label='))?.slice(8) || 'fixed';
  if (!/^[a-z0-9-]+$/.test(label)) throw Error('Invalid evidence label');
  const executable = path.resolve(args.find(a => a.startsWith('--nekoc='))?.slice(8)
    || `target/debug/k4-trace${process.platform === 'win32' ? '.exe' : ''}`);
  const selection = args.filter(a => !a.startsWith('--label=') && !a.startsWith('--nekoc='));
  const defaults = ['self_set_effect_2-actor-chain', 'self_set_effect_2-scene-chain',
    'self_change_effect_3-actor-chain', 'self_change_effect_3-scene-chain'];
  const cases = selectEffects11Cases(await partialEffects11Fixtures(), selection.length ? selection : defaults);
  const renderer = path.resolve('web/renderer.js');
  const identities = async input => ({
    rendererLfSha256: hash((await readFile(renderer, 'utf8')).replaceAll('\r\n', '\n')),
    executableSha256: hash(await readFile(executable)),
    fixtureSha256: hash(await readFile(input)),
  });
  for (const [name, spec] of cases) {
    const input = `tests/fixtures/kitten4/partial-effects-11-${name}.bcm`;
    const before = await identities(input);
    const result = await visualWork(input, {
      nekoc: executable, rendererSource: renderer, audioMetadata: true,
      captureFrames: Array.from({ length: spec.frames }, (_, i) => i + 1),
      seed: 1, pixelTolerance: 8, additionalPixelTolerances: [0, 1],
      wallTimeoutMs: 180000, artifactsDir: `dist/r3-k4effects/${label}`,
    });
    const stable = JSON.stringify(before) === JSON.stringify(await identities(input));
    const complete = completeCapture(result, spec.frames) && stable;
    const evidence = {
      schema: 'nekoc-r3-k4effects-v1', name, label, ...before,
      scope: 'Real NekoC VM and official VM; consecutive full 960x720 canvas; RGB tolerance 8; no masks',
      operations: spec.operations, ...result, identitiesStable: stable,
      fullCanvasCaptureComplete: complete,
      summary: { comparedFrames: result.frames.length,
        differentFrames: result.frames.filter(f => f.changedPixels > 0).length,
        maxChangedPixels: result.frames.length ? Math.max(...result.frames.map(f => f.changedPixels)) : null },
    };
    await saveJson(`dist/r3-k4effects/${label}/${name}.json`, evidence);
    console.log(name, JSON.stringify({ ...evidence.summary, complete, error: result.error }));
    if (!complete || (label !== 'baseline' && evidence.summary.differentFrames)) process.exitCode = 1;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
