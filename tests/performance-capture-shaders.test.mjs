import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import { FrameCapture, captureScriptFile } from '../dist/code/browser/FrameCapture.js';
import { ShaderProgramTrace } from '../dist/code/browser/ShaderProgramTrace.js';
import { FrameExtraColumns, PhaseAccumulator, StackingProbe } from '../dist/code/browser/game/CaptureExtras.js';

// Execute the actual capture controller with browser/game dependencies replaced at the boundary.
const source = await readFile(new URL('../src/browser/game/PerformanceCapture.ts', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('PerformanceCapture.ts', source, ts.ScriptTarget.ES2022, true);
const body = parsed.statements.filter(s => !ts.isImportDeclaration(s)).map(s => s.getText(parsed))
  .join('\n').replace(/^export /gm, '');
const js = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function rendererFixture() {
  let trace;
  return {
    programs: [], enabled: [], resetGpuTimingEpoch() {},
    drawPhaseMs: { terrain: 0, env: 0 }, poseResets: 0,
    poseWorkerStats(reset = false) { const stats = { jobs: 3, worker: 2, stolen: 1, workersReady: 2 }; if (reset) this.poseResets++; return stats; },
    shadowCascadeStats: { cascades: [{ mapSize: 2048, extent: 40, texel: 0.04, rendered: true, drawCalls: 12, cpuMs: 0.123, renders: 5 }], frames: 5, shadowOnlyOwners: 2 },
    setShaderProgramCapture(enabled) {
      this.enabled.push(enabled);
      trace = enabled ? new ShaderProgramTrace(this.programs, performance.now()) : undefined;
    },
    drainShaderProgramCapture() { return trace?.drain(); },
    addProgram(id, phase) {
      this.programs.push({ id, type: 'MeshStandardMaterial', cacheKey: 'standard,highp,srgb,42' });
      trace?.mark(phase, this.programs, performance.now());
    },
  };
}

function controller(game, probes = { listener: undefined }, overrides = {}) {
  const deps = {
    game, FrameCapture, captureScriptFile, CAPTURE_DURATION_MS: 60000, CAPTURE_FRAME_LIMIT: 20000,
    FrameExtraColumns, PhaseAccumulator, StackingProbe, // P1-04: PerformanceCapture.ts imports them
    setCaptureProbe(listener) { probes.listener = listener; },
    world3dCanvas: { getContext: () => null }, worldPanel: { hidden: false },
    document: { hidden: false, addEventListener() {}, removeEventListener() {} },
    navigator: { userAgent: 'test' }, innerWidth: 320, innerHeight: 240, devicePixelRatio: 1,
    performance, settings: () => ({}), autoQualityStatus: () => ({}),
    formalRenderBenchmarkExclusiveActive: () => false, renderBenchmarkRuntime: { active: false },
    poseWorkerReport: () => ({ state: 'on', predicted: false }), // L10 (10.18): PerformanceCapture.ts imports it
    loadingScreenVisible: () => false, PerformanceObserver: undefined,
    setTimeout: () => 1, clearTimeout() {},
    ...overrides,
  };
  return Function(...Object.keys(deps), js + '\nreturn { startPerformanceCapture, stopPerformanceCapture, '
    + 'beginPerformanceCaptureFrame, endPerformanceCaptureFrame, performanceCaptureReport, performanceCaptureReady, '
    + 'addCheckpointSection };')(...Object.values(deps));
}

test('P1-20a: each checkpoint carries the per-frame average of the sections frames added since the last one', () => {
  const game = { world: { state: { objects: new Map() } }, renderer: rendererFixture() }, api = controller(game);
  api.addCheckpointSection('state.view', 5);
  assert.equal(api.startPerformanceCapture(), true);
  // The first frame takes the first checkpoint; nothing added before the capture leaks into it.
  api.beginPerformanceCaptureFrame();
  api.addCheckpointSection('state.view', 0.25);
  api.endPerformanceCaptureFrame(performance.now(), 4, false);
  api.stopPerformanceCapture();
  const checkpoints = api.performanceCaptureReport().events.checkpoints;
  assert.equal(checkpoints.length, 1);
  assert.deepEqual(checkpoints[0].sections, { 'state.view': 0.25 });
  // Outside a recording the call is a no-op.
  api.addCheckpointSection('state.view', 7);
  assert.equal(api.startPerformanceCapture(), true);
  api.beginPerformanceCaptureFrame();
  api.endPerformanceCaptureFrame(performance.now(), 4, false);
  api.stopPerformanceCapture();
  assert.equal(api.performanceCaptureReport().events.checkpoints[0].sections, undefined);
});

/**
 * P1-20 review: a frame that turns the loading screen on is not counted, so its sections must not
 * enter the window either; and a section seen in the recording reports 0, not nothing.
 */
test('P1-20a: an uncounted frame leaves no time in the checkpoint average, and a zero section reads 0', () => {
  let offset = 0;
  const flags = { loading: false };
  const clock = { now: () => performance.now() + offset };
  const game = { world: { state: { objects: new Map() } }, renderer: rendererFixture() };
  const api = controller(game, undefined, { performance: clock, loadingScreenVisible: () => flags.loading });
  assert.equal(api.startPerformanceCapture(), true);
  const frame = (ms, rare = 0, turnLoadingOn = false) => {
    api.beginPerformanceCaptureFrame();
    api.addCheckpointSection('state.view', ms);
    api.addCheckpointSection('state.rare', rare);
    if (turnLoadingOn) flags.loading = true; // Loop.ts: updateLoadingScreen runs after the state parts
    api.endPerformanceCaptureFrame(clock.now(), ms, false);
  };
  frame(0.1, 3); // takes the first checkpoint
  frame(40, 0, true); // begins active, ends behind the loading screen: not counted
  flags.loading = false;
  for (let index = 0; index < 9; index++) frame(0.1);
  offset += 600;
  frame(0.1); // second checkpoint: ten counted 0.1 ms frames since the first
  offset += 600;
  frame(0); // third: one frame of zeros
  api.stopPerformanceCapture();
  const sections = api.performanceCaptureReport().events.checkpoints.map((checkpoint) => checkpoint.sections);
  assert.equal(sections.length, 3);
  assert.deepEqual(sections[0], { 'state.view': 0.1, 'state.rare': 3 });
  assert.ok(Math.abs(sections[1]['state.view'] - 0.1) < 1e-9, `${sections[1]['state.view']} ms: the loading frame leaked in`);
  assert.equal(sections[1]['state.rare'], 0, 'a section seen in the recording reads 0 rather than missing');
  assert.deepEqual(sections[2], { 'state.view': 0, 'state.rare': 0 });
});

/** The JS Self-Profiling API as Chromium shapes it: a trace object from an asynchronous stop(). */
class FakeProfiler extends EventTarget {
  static created = [];
  constructor(options) {
    super();
    this.options = options;
    this.sampleInterval = 16;
    FakeProfiler.created.push(this);
  }
  stop() {
    const t = performance.now();
    return new Promise((resolve) => setTimeout(() => resolve({
      resources: ['http://user:secret@127.0.0.1:5173/assets/main-abc.js?token=x'],
      frames: [{ name: 'animate', resourceId: 0, line: 1, column: 10 }, { name: 'decode', resourceId: 0, line: 1, column: 99 },
        { name: '' }],
      stacks: [{ frameId: 0 }, { frameId: 1, parentId: 0 }, { frameId: 2 }],
      samples: [{ timestamp: t - 30, stackId: 1 }, { timestamp: t - 14 }, { timestamp: t - 2, stackId: 2 }],
    }), 5));
  }
}

test('explicit capture exports shader phases and disables its original renderer after replacement', () => {
  const first = rendererFixture(), replacement = rendererFixture();
  const game = { world: {}, renderer: first }, api = controller(game);
  assert.deepEqual(first.enabled, [], 'ordinary rendering has no trace');
  assert.equal(api.startPerformanceCapture(), true);
  assert.equal(api.startPerformanceCapture(), false, 'a duplicate start must not reset attribution');
  api.beginPerformanceCaptureFrame();
  first.addProgram(0, 'warm');
  first.addProgram(1, 'world');
  api.endPerformanceCaptureFrame(performance.now(), 4, false);
  first.addProgram(2, 'postprocess');
  first.addProgram(3, 'portraits');
  game.renderer = replacement;
  api.stopPerformanceCapture();
  const report = api.performanceCaptureReport();
  assert.deepEqual(report.events.shaderPrograms.map(e => e.phase), ['warm', 'world', 'postprocess', 'portraits']);
  assert.ok(report.events.shaderPrograms.every(e => e.atMs >= 0));
  assert.deepEqual(first.enabled, [true, false]);
  assert.deepEqual(replacement.enabled, [], 'cleanup follows the capture owner, not the new renderer');
  assert.equal(api.startPerformanceCapture(), true);
  api.stopPerformanceCapture();
  assert.deepEqual(replacement.enabled, [true, false]);
  assert.equal(api.performanceCaptureReport().events.shaderPrograms, undefined, 'captures do not share old events');
});

test('a capture records stack samples, packet totals and HUD steps, and is ready only after the profile settles', async () => {
  globalThis.Profiler = FakeProfiler;
  try {
    const probes = { listener: undefined };
    const game = { world: { state: { objects: new Map() } }, renderer: rendererFixture() }, api = controller(game, probes);
    assert.equal(api.startPerformanceCapture(), true);
    assert.equal(FakeProfiler.created.length, 1);
    assert.deepEqual(FakeProfiler.created[0].options, { sampleInterval: 5, maxBufferSize: 15000 });
    assert.equal(typeof probes.listener, 'function', 'the recording listens to probes');
    const now = performance.now();
    probes.listener('packets', now, { opcode: 0xa9, bytes: 4000, ms: 12.5 });
    probes.listener('packets', now + 1, { opcode: 0xa9, bytes: 100, ms: 0.5 });
    probes.listener('packets', now + 2, { opcode: 0xdd, bytes: 30, ms: 0.25 });
    probes.listener('frameXmlSteps', now + 3, { stepMs: 40, seamTickMs: 30, onUpdateMs: 5, handlers: 12, syncInStepMs: 4 });
    api.stopPerformanceCapture();
    assert.equal(probes.listener, undefined, 'stopping removes the probe listener');
    assert.equal(api.performanceCaptureReady(), false, 'not ready while the profiler builds its trace');
    assert.equal(api.performanceCaptureReport(), undefined);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(api.performanceCaptureReady(), true);
    const report = api.performanceCaptureReport();
    assert.equal(report.version, 2);
    assert.equal(report.entrySupport.jsProfiler, 'enabled');
    assert.deepEqual(report.jsProfile.resources, ['main-abc.js'], 'no host, credentials or query');
    assert.equal(report.jsProfile.sampleIntervalMs, 16);
    assert.deepEqual(report.jsProfile.frames[0], ['animate', 0, 1, 10]);
    assert.deepEqual(report.jsProfile.frames[2], ['', -1, -1, -1]);
    assert.deepEqual(report.jsProfile.stacks, [[0, -1], [1, 0], [2, -1]]);
    assert.deepEqual(report.jsProfile.samples.stackId, [1, -1, 2]);
    assert.equal(report.jsProfile.samples.atMs.length, 3);
    assert.equal(report.jsProfile.samples.marker, undefined);
    assert.deepEqual(report.packets.byOpcode.map((row) => [row.opcode, row.count, row.bytes, row.ms, row.maxMs]),
      [['0xa9', 2, 4100, 13, 12.5], ['0xdd', 1, 30, 0.25, 0.25]]);
    assert.equal(report.packets.perSecond[0].count, 3);
    assert.deepEqual(report.events.slowPackets.map((event) => event.opcode), [0xa9], 'only slow packets are kept one by one');
    assert.equal(report.events.frameXmlSteps[0].stepMs, 40);
  } finally {
    delete globalThis.Profiler;
    FakeProfiler.created.length = 0;
  }
});

test('without the document policy the capture still records and says why stacks are missing', () => {
  globalThis.Profiler = class {
    constructor() { throw new DOMException('JS profiling is disabled by Document Policy.', 'NotAllowedError'); }
  };
  try {
    const game = { world: { state: { objects: new Map() } }, renderer: rendererFixture() }, api = controller(game);
    assert.equal(api.startPerformanceCapture(), true);
    api.stopPerformanceCapture();
    assert.equal(api.performanceCaptureReady(), true);
    const report = api.performanceCaptureReport();
    assert.equal(report.entrySupport.jsProfiler, 'unavailable: NotAllowedError');
    assert.equal(report.jsProfile, undefined);
  } finally { delete globalThis.Profiler; }
});

test('P1-04: the report carries every-frame draw phases, frame extras, stacking and checkpoint worker/shadow numbers', () => {
  const probes = { listener: undefined };
  const renderer = rendererFixture();
  const game = { world: { state: { objects: new Map() } }, renderer }, api = controller(game, probes);
  assert.equal(api.startPerformanceCapture(), true);
  assert.equal(renderer.poseResets, 1, 'the worker counters start with the recording');
  const frame = (phases) => {
    api.beginPerformanceCaptureFrame();
    Object.assign(renderer.drawPhaseMs, phases);
    api.endPerformanceCaptureFrame(performance.now() + frame.count++, 4, false);
  };
  frame.count = 1;
  const now = performance.now();
  probes.listener('packets', now, { opcode: 0xa9, bytes: 10, ms: 2.5 });
  probes.listener('frameXmlStepTime', now, { ms: 1.25 });
  frame({ terrain: 0.5, env: 1.5 }); // env and net fire, 4 ms: not over the sum
  probes.listener('frameXmlStepTime', now + 1, { ms: 0.5 });
  frame({ terrain: 3, env: 1.5 }); // terrain and env fire, 4.5 ms: stacks
  api.stopPerformanceCapture();
  const report = api.performanceCaptureReport();
  assert.equal(report.telemetryRevision, 2);
  assert.equal(report.drawPhases.frames, 2);
  assert.deepEqual(report.drawPhases.phases.terrain, { sumMs: 3.5, meanMs: 1.75, maxMs: 3, frames: 2, nonZeroFrames: 2 });
  assert.deepEqual(report.frameExtra, { columns: ['netMs', 'frameXmlMs'], netMs: [2.5, 0], frameXmlMs: [1.25, 0.5] });
  assert.equal(report.frameExtra.netMs.length, report.frames.length, 'one value per frame row');
  assert.equal(report.stacking.frames, 2);
  assert.equal(report.stacking.stackedFrames, 1);
  assert.equal(report.events.frameXmlStepTime, undefined, 'step times never enter the event log');
  const checkpoint = report.events.checkpoints[0];
  assert.deepEqual(checkpoint.poseWorker, { jobs: 3, worker: 2, stolen: 1, workersReady: 2 });
  assert.deepEqual(checkpoint.shadow, {
    cascades: [{ rendered: true, drawCalls: 12, cpuMs: 0.12, renders: 5 }], frames: 5, shadowOnlyOwners: 2,
  });
  assert.ok(report.notes.some((note) => note.includes('visuals.particles is inside visuals.effects')));
  // A new recording starts its totals afresh.
  assert.equal(api.startPerformanceCapture(), true);
  frame({ terrain: 0.5, env: 0 });
  api.stopPerformanceCapture();
  const next = api.performanceCaptureReport();
  assert.equal(next.drawPhases.frames, 1);
  assert.equal(next.drawPhases.phases.terrain.sumMs, 0.5);
  assert.equal(next.stacking.frames, 1);
  assert.deepEqual(next.frameExtra.netMs, [0]);
});
