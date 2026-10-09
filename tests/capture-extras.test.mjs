import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CAPTURE_PHASE_KEYS, FrameExtraColumns, PhaseAccumulator, STACKING_BUDGETS_MS, StackingProbe,
} from '../dist/code/browser/game/CaptureExtras.js';

test('P1-04: phase totals sum, maximise and count every key over every frame', () => {
  const totals = new PhaseAccumulator();
  totals.add({ terrain: 1, env: 0, 'visuals.rigs': 0.5, unknown: 9 });
  totals.add({ terrain: 3, env: 2, submit: Number.NaN });
  totals.add(undefined); // a frame without a renderer still counts
  const report = totals.report();
  assert.equal(report.frames, 3);
  assert.deepEqual(report.phases.terrain, { sumMs: 4, meanMs: 1.333, maxMs: 3, frames: 2, nonZeroFrames: 2 });
  assert.deepEqual(report.phases.env, { sumMs: 2, meanMs: 0.667, maxMs: 2, frames: 2, nonZeroFrames: 1 });
  assert.deepEqual(report.phases['visuals.rigs'], { sumMs: 0.5, meanMs: 0.167, maxMs: 0.5, frames: 1, nonZeroFrames: 1 });
  assert.equal(report.phases.submit, undefined, 'a non-finite value is not a sample');
  assert.equal(report.phases.unknown, undefined, 'only the fixed key list is read');
  for (const key of ['visuals.rigs', 'visuals.effects', 'visuals.particles', 'units.pose', 'submit.world']) {
    assert.ok(CAPTURE_PHASE_KEYS.includes(key), key);
  }
  totals.reset();
  assert.deepEqual(totals.report(), { frames: 0, phases: {} }, 'reset forgets the last recording');
});

test('P1-04: a phase fires at half its budget, a frame stacks on two fired phases over 4 ms', () => {
  assert.equal(STACKING_BUDGETS_MS.terrain, 1.5);
  assert.equal(STACKING_BUDGETS_MS.warm, 3);
  const probe = new StackingProbe();
  probe.add({ terrain: 0.75, env: 0.99 }, 0); // terrain fires exactly at 50 %, env just below
  probe.add({ terrain: 1.1, warm: 3 }, 0); // two fired, 4.1 ms: stacks
  probe.add({ terrain: 0.9, warm: 3 }, 0); // two fired, 3.9 ms: does not
  probe.add({ env: 1 }, 2.5); // env and packets fire, 3.5 ms
  probe.add({ objects: 2, 'units.pose': 0.5 }, 2); // three fired, 4.5 ms: stacks
  probe.add(undefined, 0);
  const report = probe.report();
  assert.equal(report.frames, 6);
  assert.equal(report.stackedFrames, 2);
  assert.deepEqual(report.firedHistogram, [1, 1, 3, 1, 0, 0, 0, 0]);
  assert.equal(report.firedByPhase.terrain, 3);
  assert.equal(report.firedByPhase.env, 1);
  assert.equal(report.firedByPhase.net, 2);
  assert.deepEqual(report.stackedByPhase, {
    terrain: 1, env: 0, objects: 1, 'units.appearance': 0, 'units.pose': 1, warm: 1, net: 1,
  });
  assert.equal(report.stackedMaxMs, 4.5);
  assert.equal(report.stackedMeanMs, 4.3);
  assert.equal(report.budgetsMs.terrain, 1.5);
  probe.reset();
  assert.equal(probe.report().frames, 0);
  assert.equal(probe.report().stackedFrames, 0);
});

test('P1-04: frame extras land on the row they fall into, also after a rejected frame', () => {
  const columns = new FrameExtraColumns(8);
  columns.addNet(1.5);
  columns.addFrameXml(0.25);
  assert.equal(columns.commit(1), true); // row 0
  columns.addNet(2);
  assert.equal(columns.commit(1), false, 'a frame FrameCapture rejected adds no row');
  columns.addNet(0.5);
  columns.addFrameXml(1);
  assert.equal(columns.commit(2), true); // row 1 spans the rejected callback
  columns.addNet(7);
  columns.discard(); // a callback outside the world: no row, no interval
  assert.equal(columns.commit(3), true); // row 2
  columns.addNet(-1);
  columns.addNet(Number.NaN);
  assert.equal(columns.pendingNetMs, 0);
  assert.deepEqual(columns.report(), {
    columns: ['netMs', 'frameXmlMs'], netMs: [1.5, 2.5, 0], frameXmlMs: [0.25, 1, 0],
  });
  columns.addNet(4);
  columns.reset();
  assert.deepEqual(columns.report().netMs, []);
  assert.equal(columns.pendingNetMs, 0);
  assert.equal(columns.commit(1), true);
  assert.deepEqual(columns.report().netMs, [0], 'a new recording starts from clean rows');
  assert.equal(new FrameExtraColumns(1).commit(2), false, 'no write past the limit');
});
