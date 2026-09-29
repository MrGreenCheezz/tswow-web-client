import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { analyzeCapture, compareGroups, nearestRank, summarizeGroup } from '../bench/live-periods.mjs';
import { FrameClock } from '../dist/code/browser/RenderStats.js';

const SCRIPT = 'bench/live-periods.mjs';
const COLUMNS = ['rafAtMs', 'callbackStartMs', 'cpuMs', 'intervalMs', 'failed'];
const BUDGET_MS = 2 * (1000 / 144);

// [interval ms, callback CPU ms, callback start delay ms (default 1)]. Intervals sit just below or above
// a multiple of the 144-Hz period (13.6 → 2 periods, 20.6 → 3, 27.5 → 4): rounding and truncation to
// periods disagree on most of them. A row's interval ends at that row; the callback of a row runs inside
// the NEXT row's interval (FrameCapture writes rafAt[i] − rafAt[i−1] on row i).
const SEGMENT_A = [[13.6, 9], [13.6, 10, 2], [20.6, 8, 2], [20.6, 12, 2], [27.5, 11, 3], [55.2, 40, 9], [13.6, 11, 3],
  [20.6, 13.5, 3], [34.5, 13], [14.2, 12.5]];
const SEGMENT_B = [[111, 13.2, 4], [20.6, 15], [27.5, 18], [6.9, 5], [13.6, 12, 4], [20.6, 20], [34.5, 30, 10],
  [14.2, 13, 6], [27.5, 26], [20.6, 25]];
// One drop of 25 MB at 1.5 s: of the long intervals only the 111-ms one ends inside (1.0 s, 1.5 s].
const HEAP = [[0, 400], [500, 412], [1000, 430], [1500, 405]];

function envelope(frames, { heap = HEAP, durationMs = 3000, extra = {} } = {}) {
  return {
    version: 2, recordedAt: '2026-09-29T00:00:00.000Z',
    browser: 'Mozilla/5.0 (Windows NT 10.0) Chrome/144.0.7559.236 Electron/40.9.3 Safari/537.36',
    viewport: { width: 1920, height: 1080, dpr: 1 },
    settings: { renderScale: 100, lightingQuality: 2, grassRadius: 130, grassDensity: 4, godRays: true,
      fullscreenGlow: true, originalFrameXml: true, volumeMaster: 70 },
    durationMs, frameColumns: COLUMNS, frames,
    events: { checkpoints: heap.map(([atMs, usedMB]) => ({ atMs, heap: { usedMB, totalMB: usedMB + 50 } })) },
    ...extra,
  };
}

/** Cadence runs; each starts with a frame that has no interval, as after a break. 22 rows, 20 intervals by default. */
function capture({ segments = [SEGMENT_A, SEGMENT_B], starts = [0, 1300], startCpu = 30, ...options } = {}) {
  const frames = [];
  segments.forEach((segment, index) => {
    let raf = starts[index];
    frames.push([raf, raf + 1, startCpu, null, 0]);
    for (const [interval, cpu, delay = 1] of segment) {
      raf += interval;
      frames.push([raf, raf + delay, cpu, interval, 0]);
    }
  });
  return envelope(frames, options);
}

/** `twos` intervals of 2 periods, then 3-period ones: K2 = twos / 20. */
function cadence(twos) {
  const segment = Array.from({ length: 20 }, (_, index) => [index < twos ? 13.6 : 20.6, 10]);
  return capture({ segments: [segment], starts: [0], heap: [] });
}

async function withDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), 'live-periods-'));
  try { return await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

function cli(args) {
  return execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

test('the period histogram and K2 count each interval as round(interval / period)', () => {
  const report = analyzeCapture(capture(), { name: 'synthetic.json' });
  assert.equal(report.intervals.count, 20, 'a frame after a cadence break has no interval');
  assert.deepEqual(report.histogram.map(({ periods, frames }) => [periods, frames]),
    [[1, 1], [2, 6], [3, 6], [4, 3], [5, 2], [8, 1], [16, 1]]);
  assert.equal(report.histogram.at(-1).cumulative, 1);
  assert.deepEqual(report.k2, { frames: 7, share: 0.35 });
  assert.equal(report.intervals.framesOver50, 2);
  assert.equal(report.intervals.framesOver100, 1);
  assert.equal(report.intervals.quantizedShare, 1, 'every interval is within 0.7 ms of a period multiple');
  assert.deepEqual(report.warnings, []);
  assert.deepEqual(report.goal, { k2: false, p99: false, over100: false, met: false });
});

test('interval percentiles are nearest-rank, the formula of FrameClock.snapshot', () => {
  assert.equal(nearestRank(Array.from({ length: 20 }, (_, index) => index + 1), 0.95), 19);
  assert.equal(nearestRank(Array.from({ length: 20 }, (_, index) => index + 1), 0.99), 20);
  assert.equal(nearestRank(Array.from({ length: 13 }, (_, index) => index + 1), 0.95), 13, 'rank ceil(12.35) = 13');
  assert.equal(nearestRank([], 0.5), null);
  const { intervals } = analyzeCapture(capture());
  assert.equal(intervals.p50Ms, 20.6);
  assert.equal(intervals.p90Ms, 34.5);
  assert.equal(intervals.p95Ms, 55.2);
  assert.equal(intervals.p99Ms, 111);
  assert.equal(intervals.maxMs, 111);
  assert.deepEqual(intervals.periods, { p50: 3, p90: 5, p95: 8, p99: 16, p999: 16, max: 16 });
  // The capture's own summary.intervals comes from FrameClock.snapshot over the same intervals.
  for (const length of [1, 2, 13, 20, 21, 37, 101]) {
    const values = Array.from({ length }, (_, index) => 6.9 + ((index * 7919) % 97) / 3);
    const clock = new FrameClock(length);
    for (const value of values) clock.add(value);
    const snapshot = clock.snapshot();
    const report = analyzeCapture(capture({ segments: [values.map((value) => [value, 10])], starts: [0], heap: [] }));
    assert.deepEqual([report.intervals.p50Ms, report.intervals.p95Ms, report.intervals.p99Ms],
      [snapshot.p50, snapshot.p95, snapshot.p99], `${length} intervals`);
  }
});

test('hidden cost H pairs each callback with the interval that contains it, the next row', () => {
  const report = analyzeCapture(capture());
  assert.equal(report.cpu.budgetMs, BUDGET_MS);
  // Callbacks 2, 3, 4, 5, 7, 8, 12, 16 and 19; the last callback of each run has no following interval.
  assert.deepEqual(report.hidden, { frames: 9, pairs: 20, share: 0.45 });
  // callbackStartMs − rafAtMs: 1 ms on most rows; the H callbacks wait 2–6 ms, two others 9 and 10 ms.
  const delay = report.callbackDelay;
  assert.deepEqual([delay.all.count, delay.hidden.count], [22, 9]);
  for (const [actual, expected] of [[delay.all.p50Ms, 1], [delay.all.p95Ms, 9], [delay.hidden.p50Ms, 3], [delay.hidden.p95Ms, 6]]) {
    assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≠ ${expected}`);
  }
  assert.equal(report.cpu.frames, 22, 'callback CPU counts every frame, with or without an interval');
  assert.equal(report.cpu.withinBudget, 13 / 22);
  assert.deepEqual(report.cpuBuckets.map((bucket) => bucket.frames), [1, 0, 2, 3, 6, 1, 2, 1, 4]);
  const buckets = Object.fromEntries(report.cpuBuckets.map((bucket) => [`${bucket.fromMs}`, bucket]));
  assert.deepEqual([buckets['12'].k2Share, buckets['12'].medianPeriods], [1 / 6, 3]);
  assert.deepEqual([buckets['8'].k2Share, buckets['8'].medianPeriods], [0.5, 2]);
  assert.deepEqual([buckets['17'].k2Share, buckets['17'].medianPeriods], [0.5, 1]);
  assert.deepEqual([buckets['28'].k2Share, buckets['28'].medianPeriods, buckets['28'].toMs], [0.75, 2, null]);
});

test('a capture that meets the goal exactly: K2 95 %, p99 3 periods, no interval over 100 ms', () => {
  // 19 two-period intervals and one of three periods, after a callback that uses the whole budget.
  const segment = Array.from({ length: 20 }, (_, index) => index === 10 ? [20.8, 10] : [13.9, index === 9 ? BUDGET_MS : 10]);
  const report = analyzeCapture(capture({ segments: [segment], starts: [0], startCpu: 10, heap: [] }));
  assert.equal(report.k2.share, 0.95);
  assert.equal(report.intervals.periods.p99, 3);
  assert.equal(report.intervals.framesOver100, 0);
  assert.deepEqual(report.goal, { k2: true, p99: true, over100: true, met: true });
  assert.deepEqual(report.hidden, { frames: 1, pairs: 20, share: 0.05 }, 'CPU exactly at the budget is within it');
  assert.equal(report.cpu.withinBudget, 1);
  const group = summarizeGroup([report]);
  assert.equal(group.goal.met, true);
});

test('10-second windows split by callback start: 9 999.9 ms is in the first, 10 000 ms in the second', () => {
  const frames = [
    [9950, 9951, 30, null, 0],
    [9963.9, 9999.9, 10, 13.9, 0],
    [9984.7, 10000, 12, 20.8, 0],
    [10084.7, 10085, 20, 100, 0],
    [10134.7, 10136, 20, 50, 0],
    [20000, 20001, 30, null, 0],
    [20013.9, 20015, 10, 13.9, 0],
    [20034.7, 20036, 11, 20.8, 0],
    [20145.8, 20147, 12, 111.1, 0],
  ];
  const report = analyzeCapture(envelope(frames, { heap: [], durationMs: 25000 }));
  assert.deepEqual(report.windows, [
    { fromMs: 0, toMs: 10000, frames: 1, periods: { p50: 2, p95: 2, p99: 2 }, k2: 1, cpuP50Ms: 10, cpuP95Ms: 30, framesOver100: 0 },
    { fromMs: 10000, toMs: 20000, frames: 3, periods: { p50: 7, p95: 14, p99: 14 }, k2: 0, cpuP50Ms: 20, cpuP95Ms: 20, framesOver100: 0 },
    { fromMs: 20000, toMs: 25000, frames: 3, periods: { p50: 3, p95: 16, p99: 16 }, k2: 1 / 3, cpuP50Ms: 11, cpuP95Ms: 30, framesOver100: 1 },
  ]);
  assert.equal(report.intervals.framesOver50, 2, 'exactly 50 ms is not over 50');
  assert.equal(report.intervals.framesOver100, 1, 'exactly 100 ms is not over 100');
});

test('a heap drop of at least 20 MB lists the long intervals that end after the previous checkpoint and by its own', () => {
  const { heap } = analyzeCapture(capture());
  assert.equal(heap.startMB, 400);
  assert.equal(heap.endMB, 405);
  assert.equal(heap.riseMB, 30, 'growth is the sum of the rises between checkpoints');
  assert.equal(heap.growthMBps, 20, 'over the 1.5 s the checkpoints span');
  assert.deepEqual(heap.drops, [{ atMs: 1500, fromAtMs: 1000, deltaMB: -25, longIntervalsMs: [111] }]);
  // Exactly −20 MB is a drop, −19.9 MB is not. An interval ending exactly at the previous checkpoint
  // belongs to the span before; one ending exactly at the drop's checkpoint (callback started 6 ms
  // later) belongs to it; one ending 0.1 ms after it does not.
  const frames = [
    [940, 941, 10, null, 0], [1000.1, 1001, 10, 60.1, 0],
    [1940, 1941, 10, null, 0], [2000, 2006, 10, 60, 0],
    [3940, 3941, 10, null, 0], [4000, 4001, 10, 60, 0],
    [4400, 4401, 10, null, 0], [4470, 4471, 10, 70, 0],
    [4940, 4941, 10, null, 0], [5000.1, 5001, 10, 60.1, 0],
  ];
  const checkpoints = [[0, 400], [1000, 430], [2000, 410], [3000, 390.1], [4000, 400], [5000, 380]];
  const edges = analyzeCapture(envelope(frames, { heap: checkpoints, durationMs: 6000 })).heap;
  assert.deepEqual(edges.drops, [
    { atMs: 2000, fromAtMs: 1000, deltaMB: -20, longIntervalsMs: [60.1, 60] },
    { atMs: 5000, fromAtMs: 4000, deltaMB: -20, longIntervalsMs: [70] },
  ]);
  const small = analyzeCapture(capture({ heap: [[250, 400], [750, 390], [1250, 401]] })).heap;
  assert.deepEqual(small.drops, [], 'a 10-MB step is garbage churn, not a drop');
  assert.equal(small.growthMBps, 11, 'rises over the span between the first and the last checkpoint');
});

test('a capture without jsProfile, packets, frameXml and P1-04 fields still reports', async () => {
  const report = analyzeCapture(capture());
  assert.equal(report.frameXml, null);
  assert.equal(report.packets, null);
  assert.equal(report.programs, null);
  assert.deepEqual(report.telemetry, { revision: null, drawPhases: null, poseWorker: null, shadow: null, stacking: null,
    frameExtra: null, doodadsPosed: null });
  await withDirectory(async (directory) => {
    const input = join(directory, 'bare.json'), output = join(directory, 'out', 'bare.periods.json');
    await writeFile(input, JSON.stringify(capture()));
    const stdout = cli([input, '--json', output]);
    assert.match(stdout, /K2 \(≤ 2 periods\) 35\.0 %/);
    assert.match(stdout, /frameXml: not recorded/);
    assert.match(stdout, /packets: not recorded/);
    assert.doesNotMatch(stdout, /WARNING/);
    const written = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(written.files[0].file, 'bare.json', 'no paths in the report');
    assert.equal(written.files[0].k2.share, 0.35);
    assert.equal(written.vs, null);
  });
});

test('a cadence that is not 144 Hz and a viewport that is not 1920×1080 are flagged', async () => {
  const sixty = capture({ segments: [Array.from({ length: 20 }, () => [16.67, 10])], starts: [0], heap: [] });
  const report = analyzeCapture(sixty);
  assert.equal(report.intervals.quantizedShare, 0);
  assert.equal(report.warnings.length, 1);
  assert.match(report.warnings[0], /not 144 Hz/);
  // 80 % of intervals on the period grid still warns; exactly 90 % does not.
  const mostly = (onGrid) => capture({ segments: [Array.from({ length: 20 }, (_, index) => [index < onGrid ? 13.9 : 17, 10])],
    starts: [0], heap: [] });
  assert.equal(analyzeCapture(mostly(16)).warnings.length, 1);
  assert.deepEqual(analyzeCapture(mostly(18)).warnings, []);
  const small = analyzeCapture({ ...capture(), viewport: { width: 1045, height: 900, dpr: 1 } });
  assert.equal(small.warnings.length, 1);
  assert.match(small.warnings[0], /1045×900.*1920×1080/);
  await withDirectory(async (directory) => {
    const input = join(directory, 'sixty.json');
    await writeFile(input, JSON.stringify(sixty));
    assert.match(cli([input]), /WARNING: .*within ±0\.7 ms/);
  });
});

test('several passes: medians (even count too), the worst pass per metric and the spread', () => {
  const group = summarizeGroup([2, 4, 6, 20].map((twos) => analyzeCapture(cadence(twos))));
  assert.equal(group.median.k2, 0.25, 'the mean of the middle two');
  assert.equal(group.worst.k2, 0.1);
  assert.ok(Math.abs(group.spread.k2 - 0.9) < 1e-12);
  assert.deepEqual([group.median.p99Periods, group.worst.p99Periods, group.spread.p99Periods], [3, 3, 1]);
  assert.equal(group.worst.intervals, null, 'a count is not ranked');
  assert.equal(group.goal.met, false);
});

test('--vs compares the medians of two groups of passes and marks what exceeds their spread', async () => {
  const current = [7, 8, 10].map((twos) => analyzeCapture(cadence(twos)));
  const reference = [2, 3, 4].map((twos) => analyzeCapture(cadence(twos)));
  const group = summarizeGroup(current), vs = summarizeGroup(reference);
  assert.equal(group.median.k2, 0.4);
  assert.equal(group.worst.k2, 0.35, 'the worst pass has the lowest K2');
  assert.equal(group.goal.met, false);
  assert.equal(vs.median.k2, 0.15);
  const delta = compareGroups(group, vs);
  assert.ok(Math.abs(delta.k2.delta - 0.25) < 1e-12);
  assert.equal(delta.k2.beyondSpread, true);
  assert.deepEqual(delta.p50Periods, { delta: 0, beyondSpread: false });
  await withDirectory(async (directory) => {
    const names = [];
    for (const [prefix, list] of [['a', [7, 8, 10]], ['b', [2, 3, 4]]]) {
      for (const twos of list) {
        const file = join(directory, `${prefix}${twos}.json`);
        await writeFile(file, JSON.stringify(cadence(twos)));
        names.push(file);
      }
    }
    const output = join(directory, 'vs.json');
    const stdout = cli([...names.slice(0, 3), '--vs', ...names.slice(3), '--json', output]);
    assert.match(stdout, /Δ medians/);
    const written = JSON.parse(await readFile(output, 'utf8'));
    assert.deepEqual(written.group.files, ['a7.json', 'a8.json', 'a10.json']);
    assert.deepEqual(written.vs.files, ['b2.json', 'b3.json', 'b4.json']);
    assert.ok(Math.abs(written.delta.k2.delta - 0.25) < 1e-9);
    assert.equal(written.delta.k2.beyondSpread, true);
  });
});

test('P1-04 telemetry fields are summarised when a capture has them', () => {
  const checkpoints = [
    { atMs: 0, heap: { usedMB: 400 }, renderer: { animationLod: { doodadsPosed: 10 } },
      poseWorker: { jobs: 100, worker: 90, stolen: 6, overridden: 4, waitMs: 1, mainMs: 2, frames: 10, workersReady: 1 },
      shadow: { cascades: [{ drawCalls: 100, cpuMs: 1, renders: 10 }, { drawCalls: 40, cpuMs: 0.5, renders: 2 }], frames: 10,
        shadowOnlyCasters: 3 } },
    { atMs: 500, heap: { usedMB: 410 }, renderer: { animationLod: { doodadsPosed: 30 } },
      poseWorker: { jobs: 300, worker: 250, stolen: 20, overridden: 10, waitMs: 5, mainMs: 12, frames: 30, workersReady: 1 },
      shadow: { cascades: [{ drawCalls: 120, cpuMs: 1.5, renders: 30 }, { drawCalls: 60, cpuMs: 0.7, renders: 7 }], frames: 30,
        shadowOnlyCasters: 5 } },
  ];
  const rows = capture().frames.length;
  const extra = {
    telemetryRevision: 2,
    drawPhases: { env: { sum: 44, max: 9, count: 22 }, 'visuals.particles': { sum: 11, max: 2, count: 22 } },
    stacking: { frames: 22, stacked: 3 },
    // Row j carries its own index: the sums tell which row was paired with which callback.
    frameExtra: { netMs: Array.from({ length: rows }, (_, index) => index), frameXmlMs: Array.from({ length: rows }, () => 2) },
  };
  const report = analyzeCapture({ ...capture({ extra }), events: { checkpoints } });
  const { telemetry } = report;
  assert.equal(telemetry.revision, 2);
  assert.deepEqual(telemetry.drawPhases.env, { meanMs: 2, maxMs: 9, count: 22, sumMs: 44 });
  assert.deepEqual(telemetry.poseWorker, { jobs: 200, worker: 160, stolen: 14, overridden: 6, waitMs: 4, mainMs: 10,
    frames: 20, workerShare: 0.8, stolenOverriddenShare: 0.1, mainMsPerFrame: 0.5, waitMsPerFrame: 0.2, workersReady: 1,
    cumulative: true });
  assert.deepEqual(telemetry.shadow.cascades.map((cascade) => cascade.rendersPerFrame), [1, 0.25]);
  assert.deepEqual(telemetry.shadow.cascades.map((cascade) => cascade.drawCalls), [110, 50]);
  assert.equal(telemetry.shadow.shadowOnlyCasters, 4);
  assert.deepEqual(telemetry.stacking, { frames: 22, stacked: 3 });
  assert.deepEqual(telemetry.doodadsPosed, { mean: 20, max: 30 });
  assert.deepEqual(telemetry.frameExtra.columns, ['netMs', 'frameXmlMs']);
  // H callbacks 2, 3, 4, 5, 7, 8, 12, 16, 19: their gaps are measured on rows 3, 4, 5, 6, 8, 9, 13, 17, 20.
  const hidden = telemetry.frameExtra.hidden;
  assert.equal(hidden.frames, 9);
  assert.ok(Math.abs(hidden.gapMs - 144) < 1e-9, `gap ${hidden.gapMs}`);
  assert.equal(hidden.netMs, 85);
  assert.equal(hidden.frameXmlMs, 18);
});
