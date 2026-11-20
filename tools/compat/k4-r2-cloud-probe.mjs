#!/usr/bin/env node
// Original fixtures only; never load corpus works or copy vendor implementations.
// Reuse one browser serially. Only --record updates the tracked evidence file.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openKernel, readJson, runOracle } from './k4-oracle.mjs';

const filename = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(filename), '../..');
const defaultOutput = path.join(root, 'dist/r2-k4gaps/cloud-evidence');
const evidenceFile = path.join(root, 'docs/kitten4-r2-cloud-evidence.json');
const expectedKernel = '0f7933d51266add6cbad0682b9531036dc1c8daf8c522cde4243744376ce4160';
const hash = value => createHash('sha256').update(value).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const specs = [
  { id: 'anonymous-401-list', fixture: 'k4cloud-list.bcm', frames: 39, replaceCount: 3 },
  { id: 'anonymous-401-list-numeric-work-id', fixture: 'k4cloud-list.bcm', frames: 39, replaceCount: 3, numericWorkId: 314915568 },
  { id: 'controlled-connected-flag-no-reply', fixture: 'k4cloud-list.bcm', frames: 39, replaceCount: 3, numericWorkId: 314915568, connectedFlag: true },
  { id: 'anonymous-401-scalar-and-list-writes', fixture: 'cloud-writes.bcm', frames: 3, replaceCount: 1 },
];

function parseArgs(argv) {
  const options = { output: defaultOutput, playerDir: process.env.K4_PLAYER_DIR, record: false };
  const values = { '--out-dir': 'output', '--player-dir': 'playerDir', '--channel': 'channel' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--record') options.record = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (values[arg] && argv[i + 1] && !argv[i + 1].startsWith('--')) options[values[arg]] = argv[++i];
    else throw new Error(`Unknown option or missing value: ${arg}`);
  }
  options.output = path.resolve(options.output);
  if (options.playerDir) options.playerDir = path.resolve(options.playerDir);
  return options;
}

async function observe(page, includeFrame = false) {
  return page.evaluate(includeFrame => {
    const state = window.__k4OracleRequire('ALsR').a.get_state();
    const result = {
      workId: state.project_states.work_id ?? null,
      isLogin: state.userinfo_state.is_login,
      authType: state.userinfo_state.auth_type ?? null,
      runState: state.run_states.run_state,
      runError: state.run_states.is_error,
      loadState: state.cloud_states.loading_state,
      socketConnected: window.CmCloud.socket.is_connected,
      cloudMetadataIds: Object.keys(window.CmCloud.db.get_variables()),
    };
    if (includeFrame) {
      // Read the oracle's detached snapshot, not lazy variable/list getters.
      const frame = window.__k4Oracle.frames.at(-1);
      result.frame = frame.frame;
      result.variables = structuredClone(frame.variables);
    }
    return result;
  }, includeFrame);
}

function publicSummary(report, detailedBytes) {
  return {
    schema: 'r2-k4gaps-public-cloud-evidence-v1',
    kernelSha256: report.kernelSha256,
    runnerSha256: report.runnerSha256,
    oracleSha256: report.oracleSha256,
    detailedResultsSha256: hash(detailedBytes),
    scope: '固定官方 .orig + 原创夹具；账户401由本地oracle返回；所有外部网络阻断；不代表官方在线云服务。',
    startedAt: report.startedAt,
    completedAt: report.completedAt,
    browserVersion: report.browserVersion,
    browserLaunches: report.browserLaunches,
    maxConcurrentBrowsers: report.maxConcurrentBrowsers,
    totalOfficialUpdates: report.cases.reduce((n, c) => n + (c.frames || 0), 0),
    allVerified: report.allVerified,
    ...(report.error ? { error: report.error } : {}),
    ...(report.cleanupError ? { cleanupError: report.cleanupError } : {}),
    cases: report.cases.map(c => ({
      id: c.id, status: c.status, fixture: path.basename(c.fixture),
      fixtureSha256: c.fixtureSha256, frames: c.frames ?? 0,
      account401Observed: c.checks?.account401Observed ?? false,
      anonymousThroughout: c.checks?.anonymousThroughout ?? false,
      globalModeAtFrameCallbacks: c.checks?.globalModeAtEveryFrameCallback ?? false,
      initialWorkId: c.beforeStart?.workId ?? null,
      injectedWorkId: c.afterWorkIdInjection?.workId ?? null,
      beforeStart: c.beforeStart,
      ...(c.afterWorkIdInjection ? { afterWorkIdInjection: c.afterWorkIdInjection } : {}),
      injections: c.injections,
      accountResponses: c.accountResponses ?? [],
      assets: c.assets ?? [],
      replacements: (c.replacements ?? []).flatMap(r => r.calls.map(call => ({
        blockId: r.id, frame: call.frame, indexType: call.indexType, params: call.params,
        observedRunStateAfterFrame: call.observedRunStateAfterFrame,
        socketConnectedAfterFrame: call.socketConnectedAfterFrame,
        before: call.listBeforeFrame, after: call.listAfterFrame,
      }))),
      ...(c.fixture.endsWith('cloud-writes.bcm') && c.finalState ? {
        finalScalars: { public: c.finalState.variables.shared, private: c.finalState.variables.personal },
      } : {}),
      runtimeErrors: c.errors?.length ?? null,
      pageErrors: c.pageErrors?.length ?? null,
      allowedExternalRequests: c.network?.externalAllowed ?? null,
      webSocketAttempts: c.network?.externalWebSocketAttempts ?? null,
      localWriteRequests: c.network?.localNonReadRequests.length ?? null,
      checks: c.checks, verified: c.verified,
      ...(c.error ? { error: c.error, phase: c.phase, partialErrors: c.partialErrors } : {}),
    })),
    recommendation: report.recommendation,
    limitations: report.limitations,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: node tools/compat/k4-r2-cloud-probe.mjs [--record] [--out-dir directory] [--player-dir app] [--channel msedge]');
    console.log('K4_PLAYER_DIR supplies the fixed external .orig; NEKOC_NODE_MODULES can supply Playwright.');
    console.log('Default output: dist/r2-k4gaps/cloud-evidence/{results,public-summary}.json');
    console.log('--record writes docs/kitten4-r2-cloud-evidence.json only after all cases and resource cleanup succeed.');
    return;
  }
  if (!options.playerDir) throw new Error('Set K4_PLAYER_DIR or --player-dir');
  const kernelFile = path.join(options.playerDir, 'src/player/build/player_v2.2d180c468559fbd29528.js.orig');
  if (hash(await readFile(kernelFile)) !== expectedKernel) throw new Error('Unexpected official kernel identity');
  await mkdir(options.output, { recursive: true });
  const report = {
    schema: 'r2-k4gaps-original-cloud-guard-probe-v1',
    scope: 'Official fixed .orig kernel, original fixtures, anonymous isolated local harness; not online cloud-service verification.',
    startedAt: new Date().toISOString(),
    kernelSha256: expectedKernel,
    runnerSha256: hash(await readFile(filename)),
    oracleSha256: hash(await readFile(path.join(root, 'tools/compat/k4-oracle.mjs'))),
    browserLaunches: 0, maxConcurrentBrowsers: 1,
    limitations: [
      'Account 401 is served by the existing local oracle, not a request to the production account service.',
      'Normal Start uses vxpV.n with the existing deterministic oracle instrumentation.',
      'Numeric work_id changes Redux state only; the original fixture and token URL remain.',
      'Connected-without-reply sets only the branch flag after Start; no handshake, transport, server acknowledgement, or reconnect is simulated.',
      'BeforeStart observations and frame snapshots do not invoke lazy variable/list getters.',
      'No NekoC VM or local cloud backend is executed.',
      'This fixture-only runner does not load or refresh historical corpus observations.',
    ],
    cases: [],
  };
  let sharedKernel;
  async function acquireKernel(oracleOptions, input) {
    if (!sharedKernel) {
      sharedKernel = await openKernel(oracleOptions, input);
      report.browserLaunches++;
      report.browserVersion = sharedKernel.browserVersion;
    } else {
      for (const key of Object.keys(sharedKernel.diagnostics)) {
        if (Array.isArray(sharedKernel.diagnostics[key])) sharedKernel.diagnostics[key].length = 0;
        else delete sharedKernel.diagnostics[key];
      }
      await sharedKernel.load(input);
    }
    // runOracle's per-case finally must not close the shared browser/server.
    // The outer finally owns both resources, including all failure paths.
    return { ...sharedKernel, close: async () => {} };
  }
  try {
    for (const spec of specs) {
      const fixture = 'tests/fixtures/kitten4/' + spec.fixture;
      const fixturePath = path.join(root, fixture);
      const project = await readJson(fixturePath);
      const replacements = Object.values(project.theatre.actors).flatMap(actor =>
        Object.values(actor.block_data_json?.blocks || {}).filter(block => block.type === 'cloud_lists_replace').map(block => block.id));
      const current = { id: spec.id, fixture, fixtureSha256: hash(await readFile(fixturePath)), injections: [], beforeStart: null };
      const observedFrames = [];
      try {
        if (replacements.length !== spec.replaceCount) throw new Error('Unexpected fixture replace-block count');
        const trace = await runOracle(project, {
          playerDir: options.playerDir, channel: options.channel,
          frames: spec.frames, blocks: true, blockFilter: replacements.join(','),
          allowAssets: false, seed: 1, timeoutMs: 45000, wallTimeoutMs: 90000,
          openKernel: acquireKernel,
          beforeStart: async page => {
            current.beforeStart = await observe(page);
            if (spec.numericWorkId) {
              await page.evaluate(id => {
                window.__k4OracleRequire('ALsR').a.dispatch({ type: 'kitten/project/set_work_id', payload: id });
              }, spec.numericWorkId);
              current.injections.push({ phase: 'before-start', type: 'numeric-work-id-state-only', value: spec.numericWorkId, scope: 'original fixture, not this corpus work' });
              current.afterWorkIdInjection = await observe(page);
              if (current.afterWorkIdInjection.workId !== spec.numericWorkId) throw new Error('work_id injection did not apply');
            }
          },
          onFrame: async (page, frame) => {
            observedFrames.push(await observe(page, true));
            if (spec.connectedFlag && (frame === 13 || frame === 19)) {
              const value = frame === 13;
              await page.evaluate(value => { window.CmCloud.socket.is_connected = value; }, value);
              current.injections.push({ afterFrame: frame, type: 'socket-is-connected-flag-only', value, scope: 'controlled branch test; no real socket or service reply' });
            }
          },
        });
        current.status = 'ran';
        current.frames = trace.frames.length;
        current.errors = trace.errors;
        current.pageErrors = trace.diagnostics.pageErrors;
        current.finalState = observedFrames.at(-1);
        current.runStatesObserved = [...new Set(observedFrames.map(x => x.runState))];
        current.loginStatesObserved = [...new Set(observedFrames.map(x => x.isLogin))];
        current.socketStatesObserved = [...new Set(observedFrames.map(x => x.socketConnected))];
        current.accountResponses = trace.diagnostics.localRequests.filter(r => r.url.split('?')[0] === '/web/users/details')
          .map(r => ({ path: '/web/users/details', method: r.method, status: r.status }));
        current.network = {
          externalAttempted: trace.diagnostics.externalRequests.length,
          externalAllowed: trace.diagnostics.externalRequests.filter(r => r.action !== 'blocked').length,
          externalWebSocketAttempts: trace.diagnostics.externalRequests.filter(r => r.resourceType === 'websocket').length,
          localNonReadRequests: trace.diagnostics.localRequests.filter(r => !['GET', 'HEAD'].includes(r.method)).map(r => ({ method: r.method, status: r.status })),
        };
        current.assets = trace.diagnostics.assets.filter(a => a.name.endsWith('.js')).map(a => ({ name: a.name, sha256: a.sha256 }));
        current.replacements = replacements.map(id => ({
          id,
          calls: trace.events.filter(e => e.event === 'input' && e.block === id).map(event => {
            const after = observedFrames.find(f => f.frame === event.frame);
            const before = observedFrames.find(f => f.frame === event.frame - 1);
            return { frame: event.frame, params: event.params, indexType: typeof event.params.INDEX,
              observedRunStateAfterFrame: after?.runState, socketConnectedAfterFrame: after?.socketConnected,
              listBeforeFrame: before?.variables.items ?? null, listAfterFrame: after?.variables.items ?? null };
          }),
        }));
        current.checkpoints = observedFrames.filter((f, i) => i === 0 || i === observedFrames.length - 1 ||
          f.variables.step !== observedFrames[i - 1].variables.step || f.socketConnected !== observedFrames[i - 1].socketConnected)
          .map(f => ({ frame: f.frame, step: f.variables.step ?? null, socketConnected: f.socketConnected, items: f.variables.items }));
        const find = n => observedFrames.find(x => x.frame === n);
        current.checks = {
          account401Observed: current.accountResponses.some(r => r.status === 401),
          anonymousThroughout: current.beforeStart.isLogin === false && current.loginStatesObserved.every(x => x === false),
          globalModeAtEveryFrameCallback: current.runStatesObserved.every(x => x === 1),
          allReplaceBlocksCalled: current.replacements.every(r => r.calls.length > 0),
          noExternalTrafficAllowed: current.network.externalAllowed === 0,
          noLocalWriteRequests: current.network.localNonReadRequests.length === 0,
          noErrors: current.errors.length === 0 && current.pageErrors.length === 0,
        };
        if (spec.fixture === 'k4cloud-list.bcm') {
          current.checks.nthReplaceExpected = same(find(16).variables.items, spec.connectedFlag ? ['head', 7, 'tail'] : ['head', 'middle', 'tail']);
          current.checks.lastReplaceExpected = same(find(19).variables.items, spec.connectedFlag ? ['head', 7, 'tail'] : ['head', 'middle', 'end']);
          current.checks.overflowReplaceAfterDisconnected = same(find(31).variables.items, ['head', 'overflow', 'appended']);
        } else {
          current.checks.scalarAndListWrites = current.finalState.variables.shared === 'room/message' &&
            current.finalState.variables.personal === 7 && same(current.finalState.variables.items, ['head', 'tail', 'inserted', 'replacement']);
        }
        current.verified = Object.values(current.checks).every(Boolean);
      } catch (error) {
        current.status = 'failed';
        current.error = error.message;
        current.phase = error.diagnostics?.phase;
        current.partialErrors = error.diagnostics?.partialTrace?.errors || [];
        current.verified = false;
      }
      report.cases.push(current);
      await writeFile(path.join(options.output, 'results.json'), JSON.stringify(report, null, 2));
      console.log(JSON.stringify({ id: current.id, status: current.status, verified: current.verified, checks: current.checks, error: current.error }));
      if (!current.verified) break;
    }
  } catch (error) {
    report.error = error.message;
  } finally {
    try { if (sharedKernel) await sharedKernel.close(); }
    catch (error) { report.cleanupError = error.message; }
    report.completedAt = new Date().toISOString();
    report.allVerified = !report.error && !report.cleanupError && report.browserLaunches === 1 &&
      report.cases.length === specs.length && report.cases.every(c => c.verified);
    report.recommendation = report.allVerified
      ? '保留默认匿名未连接时的会话内本地云写；不要按account401整体改为no-op。连接标志为true的路径须单独处理，不将故障注入当在线服务认证。'
      : '存在失败检查；不得将本次结果用于默认模式变更结论。';
    const detailedBytes = JSON.stringify(report, null, 2);
    await writeFile(path.join(options.output, 'results.json'), detailedBytes);
    const summaryBytes = JSON.stringify(publicSummary(report, detailedBytes), null, 2);
    await writeFile(path.join(options.output, 'public-summary.json'), summaryBytes);
    if (options.record && report.allVerified) await writeFile(evidenceFile, summaryBytes);
  }
  if (!report.allVerified) throw new Error('Cloud probe failed; inspect results.json. Tracked evidence was not updated.');
  console.log(JSON.stringify({ allVerified: true, browserLaunches: report.browserLaunches, totalOfficialUpdates: 120, output: options.output, recorded: options.record }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === filename) {
  main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
}
