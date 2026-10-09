// Frame cadence of live recordings in display periods (capture version 2: `webclientRecordFreezes()`
// in DevTools, or O → «Записать фризы (60 с)»). Read-only: reads capture files, loads nothing from src/.
//
//   node bench/live-periods.mjs <capture.json>... [--period 6.944] [--json out.json] [--vs <capture.json>...]
//
// At 144 Hz a frame lasts a whole number of periods P = 1000/144 = 6.944 ms, so an interval counts as
// k = round(interval / P) periods and K2 is the share of frames with k ≤ 2 — the frame goal of
// docs/implementation/line-P.ru.md §3 (13.9 ms = 2 periods). Per file: intervals in ms and periods and
// how many sit within ±0.7 ms of a period multiple; the period histogram; callback CPU against the
// two-period budget, the hidden cost H and CPU buckets; the delay from the frame's rAF time to the
// callback start; 10-s windows; the JS heap (growth, drops ≥ 20 MB with the long intervals that ended
// since the checkpoint before); FrameXML, packet, shader-program and LoAF summaries; the P1-04 telemetry
// fields when present; the goal check. Several files are passes of one scene: a row per file, the medians
// and the worst pass (the goal is judged on the worst of N). `--vs` adds a second group and the difference
// of the medians, marked when it is larger than the spread of the passes. `--json` writes everything,
// file names only.
//
// A callback and the interval that contains it are on different rows: FrameCapture writes
// rafAt[i] − rafAt[i−1] on row i, and the callback of row i starts after rafAt[i], so it runs inside the
// NEXT row's interval. Everything that relates callback CPU to an interval (H, the CPU buckets, the
// frameExtra gap) pairs row i's callback with row i + 1's interval.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_PERIOD_MS = 1000 / 144;
/** Share of intervals within this distance of a period multiple; below 90 % the display is not at the period. */
export const QUANTIZATION_TOLERANCE_MS = 0.7;
export const QUANTIZATION_WARNING_SHARE = 0.9;
export const LONG_INTERVAL_MS = 50;
export const FREEZE_INTERVAL_MS = 100;
/** A fall of the used JS heap between two checkpoints this large is a full collection, not churn. */
export const HEAP_DROP_MB = 20;
export const WINDOW_MS = 10_000;
/** The window the frame goal is set for (line-P.ru.md §3); other sizes are not comparable with it. */
export const GOAL_VIEWPORT = Object.freeze({ width: 1920, height: 1080 });
/** Callback CPU buckets, ms: the table of line-P.ru.md §3, with two more below 8 ms. */
export const CPU_BUCKET_EDGES_MS = Object.freeze([0, 6, 8, 10, 12, 14, 17, 21, 28, Infinity]);
/** The frame goal (line-P.ru.md §3): K2 ≥ 95 %, p99 ≤ 3 periods (20.8 ms), no interval over 100 ms. */
export const GOAL = Object.freeze({ k2: 0.95, p99Periods: 3, framesOver100: 0 });
const GRAPHICS_KEYS = ['renderScale', 'lightingQuality', 'grassRadius', 'grassDensity', 'godRays', 'fullscreenGlow',
  'originalFrameXml'];
const PERCENTILES = [['p50', 0.5], ['p90', 0.9], ['p95', 0.95], ['p99', 0.99], ['p999', 0.999]];
const USAGE = 'Usage: node bench/live-periods.mjs <capture.json>... [--period 6.944] [--json out.json] [--vs <capture.json>...]';

const finite = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null;
const ascending = (values) => values.filter((value) => finite(value) !== null).sort((left, right) => left - right);
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const share = (count, total) => total > 0 ? count / total : null;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Nearest rank, as FrameClock.snapshot: the value at one-based rank ceil(p·n) of the ascending list. */
export function nearestRank(sorted, fraction) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length, Math.max(1, Math.ceil(fraction * sorted.length))) - 1];
}

/** The true median (mean of the middle two for an even count), for summaries across passes. */
function median(sorted) {
  if (sorted.length === 0) return null;
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export const periodsOf = (ms, periodMs) => Math.round(ms / periodMs);

/** Frame rows by column name; the interval is null on the first frame after a cadence break. */
export function frameRows(capture) {
  const columns = capture?.frameColumns;
  if (!Array.isArray(columns) || !Array.isArray(capture.frames)) {
    throw new Error('not a live capture (version 2): frameColumns/frames are missing');
  }
  const column = (name) => {
    const index = columns.indexOf(name);
    if (index < 0) throw new Error(`missing frame column: ${name}`);
    return index;
  };
  const cpu = column('cpuMs'), interval = column('intervalMs'), start = column('callbackStartMs');
  const raf = columns.indexOf('rafAtMs');
  return capture.frames.map((row, index) => {
    const atMs = finite(row[start]);
    const intervalMs = finite(row[interval]);
    return {
      index, atMs, rafAtMs: raf >= 0 ? finite(row[raf]) : null, cpuMs: finite(row[cpu]),
      intervalMs: intervalMs !== null && intervalMs > 0 ? intervalMs : null,
    };
  });
}

/** Where a row's interval ends: its rAF time (the callback start when a capture lacks the column). */
const intervalEnd = (row) => row.rafAtMs ?? row.atMs;

/**
 * Every callback with the interval that contains it: row i's CPU and row i + 1's interval. The last
 * callback before a cadence break (or the end) has no such interval and is left out.
 */
export function callbackPairs(rows) {
  const pairs = [];
  for (let index = 0; index + 1 < rows.length; index++) {
    const row = rows[index], next = rows[index + 1];
    if (row.cpuMs === null || next.intervalMs === null) continue;
    pairs.push({ index, cpuMs: row.cpuMs, intervalMs: next.intervalMs, intervalRow: index + 1 });
  }
  return pairs;
}

/** callbackStartMs − rafAtMs of a row: the part of the frame that passes before the game callback starts. */
const callbackDelay = (row) => row.atMs !== null && row.rafAtMs !== null ? row.atMs - row.rafAtMs : null;

function delaySummary(rows) {
  const sorted = ascending(rows.map(callbackDelay));
  return { count: sorted.length, p50Ms: nearestRank(sorted, 0.5), p95Ms: nearestRank(sorted, 0.95) };
}

function browserName(userAgent) {
  const names = typeof userAgent === 'string' ? userAgent.match(/\b(Chrome|Electron|Firefox|Edg)\/[\d.]+/g) : null;
  return names ? names.join(' ') : null;
}

function heapSummary(checkpoints, timed) {
  const samples = checkpoints.filter((checkpoint) => finite(checkpoint?.heap?.usedMB) !== null && finite(checkpoint.atMs) !== null)
    .sort((left, right) => left.atMs - right.atMs);
  if (samples.length === 0) return null;
  let riseMB = 0;
  const drops = [];
  for (let index = 1; index < samples.length; index++) {
    const previous = samples[index - 1], current = samples[index];
    const deltaMB = current.heap.usedMB - previous.heap.usedMB;
    if (deltaMB > 0) riseMB += deltaMB;
    if (deltaMB <= -HEAP_DROP_MB) {
      drops.push({
        atMs: current.atMs, fromAtMs: previous.atMs, deltaMB,
        // The collection happened after the previous checkpoint and before this one: the long intervals
        // that ended in (previous, current], each placed at the animation frame that ends it.
        longIntervalsMs: timed.filter((row) => row.intervalMs > LONG_INTERVAL_MS
          && intervalEnd(row) > previous.atMs && intervalEnd(row) <= current.atMs).map((row) => row.intervalMs),
      });
    }
  }
  const first = samples[0], last = samples.at(-1);
  const spanS = (last.atMs - first.atMs) / 1000;
  return {
    checkpoints: samples.length, startMB: first.heap.usedMB, endMB: last.heap.usedMB, riseMB, spanS,
    growthMBps: spanS > 0 ? riseMB / spanS : null, drops,
  };
}

function packetRow(row) {
  return row ? { opcode: String(row.opcode), count: finite(row.count), ms: finite(row.ms), maxMs: finite(row.maxMs) } : null;
}

// ---------------------------------------------------------------------------------------------
// P1-04 telemetry. The field shapes follow line-P-P1.ru.md P1-04; readers accept what they
// recognise and report null otherwise, so older captures and partial fields never fail.

function drawPhaseSummary(drawPhases) {
  if (!isObject(drawPhases)) return null;
  const source = isObject(drawPhases.phases) ? drawPhases.phases : drawPhases;
  const phases = {};
  for (const [key, value] of Object.entries(source)) {
    if (!isObject(value)) continue;
    const sumMs = finite(value.sum) ?? finite(value.sumMs) ?? finite(value.totalMs);
    const count = finite(value.count) ?? finite(value.frames);
    if (sumMs === null) continue;
    phases[key] = { meanMs: count ? sumMs / count : null, maxMs: finite(value.max) ?? finite(value.maxMs), count, sumMs };
  }
  return Object.keys(phases).length ? phases : null;
}

const POSE_COUNTERS = ['jobs', 'worker', 'stolen', 'overridden', 'waitMs', 'mainMs', 'frames'];

/** `poseWorkerStats()` counts since its last reset: cumulative checkpoints take last − first, others add up. */
function poseWorkerSummary(checkpoints) {
  const samples = checkpoints.map((checkpoint) => checkpoint?.poseWorker).filter((stats) => finite(stats?.jobs) !== null);
  if (samples.length === 0) return null;
  const cumulative = samples.every((stats, index) => index === 0 || stats.jobs >= samples[index - 1].jobs);
  const total = Object.fromEntries(POSE_COUNTERS.map((key) => {
    const values = samples.map((stats) => finite(stats[key]) ?? 0);
    const value = cumulative
      ? (samples.length > 1 ? values.at(-1) - values[0] : values[0])
      : values.reduce((sum, item) => sum + item, 0);
    return [key, value];
  }));
  return {
    ...total,
    workerShare: share(total.worker, total.jobs),
    stolenOverriddenShare: share(total.stolen + total.overridden, total.jobs),
    mainMsPerFrame: share(total.mainMs, total.frames),
    waitMsPerFrame: share(total.waitMs, total.frames),
    workersReady: finite(samples.at(-1).workersReady),
    cumulative,
  };
}

/** Cascade draw calls and CPU are last-render values (averaged over checkpoints); renders/frames are counters. */
function shadowSummary(checkpoints) {
  const samples = checkpoints.map((checkpoint) => checkpoint?.shadow).filter((stats) => Array.isArray(stats?.cascades));
  if (samples.length === 0) return null;
  const first = samples[0], last = samples.at(-1);
  const frames = (finite(last.frames) ?? 0) - (finite(first.frames) ?? 0);
  const count = Math.max(...samples.map((stats) => stats.cascades.length));
  return {
    cascades: Array.from({ length: count }, (_, index) => {
      const values = samples.map((stats) => stats.cascades[index]).filter(isObject);
      const renders = (finite(last.cascades[index]?.renders) ?? 0) - (finite(first.cascades[index]?.renders) ?? 0);
      const cpu = ascending(values.map((cascade) => cascade.cpuMs));
      // P2-02b: cumulative CPU per render between the first and last checkpoint (recordings from 09.10 on).
      const cpuTotal = (finite(last.cascades[index]?.cpuMsTotal) ?? NaN) - (finite(first.cascades[index]?.cpuMsTotal) ?? NaN);
      return {
        drawCalls: mean(ascending(values.map((cascade) => cascade.drawCalls))),
        cpuMs: mean(cpu), cpuMaxMs: cpu.at(-1) ?? null,
        rendersPerFrame: samples.length > 1 && frames > 0 ? renders / frames : null,
        cpuMsPerRender: Number.isFinite(cpuTotal) && renders > 0 ? cpuTotal / renders : null,
        cpuMsMaxSinceConfigure: finite(last.cascades[index]?.cpuMsMax),
      };
    }),
    frames,
    // Both ends must carry the counters, or the absolute counts would read as differences.
    farReasons: isObject(last.farReasons) && isObject(first.farReasons) ? Object.fromEntries(Object.entries(last.farReasons)
      .map(([key, value]) => [key, (finite(value) ?? 0) - (finite(first.farReasons?.[key]) ?? 0)])) : null,
    // P2-01a renamed the field: owners with an active gate-2 caster. Recordings made before it carry
    // `shadowOnlyCasters` (every node the old toggle showed), reported apart and never mixed in.
    shadowOnlyOwners: mean(ascending(samples.map((stats) => stats.shadowOnlyOwners))),
    ...(samples.some((stats) => stats.shadowOnlyCasters !== undefined)
      ? { shadowOnlyCastersLegacy: mean(ascending(samples.map((stats) => stats.shadowOnlyCasters))) } : {}),
  };
}

function numbersOnly(value) {
  if (!isObject(value)) return null;
  const kept = Object.fromEntries(Object.entries(value).filter(([, item]) => finite(item) !== null
    || (Array.isArray(item) && item.every((entry) => finite(entry) !== null))));
  return Object.keys(kept).length ? kept : null;
}

/** Per-frame columns parallel to `frames`: `{ netMs: [...], frameXmlMs: [...] }` or `{ columns, rows }`. */
function frameExtraColumns(extra) {
  if (!isObject(extra)) return null;
  const columns = {};
  if (Array.isArray(extra.columns) && Array.isArray(extra.rows)) {
    extra.columns.forEach((name, index) => { columns[name] = extra.rows.map((row) => row?.[index]); });
  } else {
    for (const [name, values] of Object.entries(extra)) if (Array.isArray(values)) columns[name] = values;
  }
  return Object.keys(columns).length ? columns : null;
}

/**
 * What fills the gap between a callback and the interval that contains it: packets and FrameXML steps.
 * The columns are indexed like `frames` (P1-04 writes a row's values once its callback has ended, so row
 * j holds what ran since the end of callback j − 1); the gap of callback i — row i + 1's interval minus
 * row i's CPU — is set against row i + 1, the row that ends that interval.
 */
function frameExtraSummary(extra, pairs, hidden) {
  const columns = frameExtraColumns(extra);
  if (!columns) return null;
  const value = (name, index) => finite(columns[name]?.[index]) ?? 0;
  const total = (selected) => {
    let gapMs = 0, netMs = 0, frameXmlMs = 0;
    for (const pair of selected) {
      gapMs += Math.max(0, pair.intervalMs - pair.cpuMs);
      netMs += value('netMs', pair.intervalRow);
      frameXmlMs += value('frameXmlMs', pair.intervalRow);
    }
    return { frames: selected.length, gapMs, netMs, frameXmlMs, explainedShare: gapMs > 0 ? (netMs + frameXmlMs) / gapMs : null };
  };
  return { columns: Object.keys(columns), all: total(pairs), hidden: total(hidden) };
}

function doodadSummary(checkpoints) {
  const values = ascending(checkpoints.map((checkpoint) => checkpoint?.renderer?.animationLod?.doodadsPosed));
  return values.length ? { mean: mean(values), max: values.at(-1) } : null;
}

// ---------------------------------------------------------------------------------------------

export function goalCheck({ k2, p99Periods, framesOver100 }) {
  const checks = {
    k2: k2 !== null && k2 >= GOAL.k2,
    p99: p99Periods !== null && p99Periods <= GOAL.p99Periods,
    over100: framesOver100 !== null && framesOver100 <= GOAL.framesOver100,
  };
  return { ...checks, met: checks.k2 && checks.p99 && checks.over100 };
}

/** One capture. `name` is what the report calls it (a file name, never a path). */
export function analyzeCapture(capture, { periodMs = DEFAULT_PERIOD_MS, name = 'capture' } = {}) {
  if (!(periodMs > 0) || !Number.isFinite(periodMs)) throw new Error(`invalid period: ${periodMs}`);
  const rows = frameRows(capture);
  const events = isObject(capture.events) ? capture.events : {};
  const checkpoints = Array.isArray(events.checkpoints) ? events.checkpoints : [];
  const budgetMs = 2 * periodMs;
  const periods = (row) => periodsOf(row.intervalMs, periodMs);
  const timed = rows.filter((row) => row.intervalMs !== null);
  const pairs = callbackPairs(rows);
  const warnings = [];

  // Intervals, in milliseconds and in periods.
  const sortedIntervals = ascending(timed.map((row) => row.intervalMs));
  const quantized = timed.filter((row) => Math.abs(row.intervalMs - periods(row) * periodMs) <= QUANTIZATION_TOLERANCE_MS).length;
  const intervals = {
    count: timed.length, meanMs: mean(sortedIntervals),
    ...Object.fromEntries(PERCENTILES.map(([key, fraction]) => [`${key}Ms`, nearestRank(sortedIntervals, fraction)])),
    maxMs: sortedIntervals.at(-1) ?? null,
    framesOver50: timed.filter((row) => row.intervalMs > LONG_INTERVAL_MS).length,
    framesOver100: timed.filter((row) => row.intervalMs > FREEZE_INTERVAL_MS).length,
    quantizedShare: share(quantized, timed.length),
  };
  intervals.periods = Object.fromEntries([...PERCENTILES.map(([key]) => [key, intervals[`${key}Ms`]]), ['max', intervals.maxMs]]
    .map(([key, value]) => [key, value === null ? null : periodsOf(value, periodMs)]));
  if (intervals.quantizedShare !== null && intervals.quantizedShare < QUANTIZATION_WARNING_SHARE) {
    warnings.push(`only ${percent(intervals.quantizedShare)} of intervals are within ±${QUANTIZATION_TOLERANCE_MS} ms of a `
      + `multiple of ${periodMs.toFixed(3)} ms: the display is probably not ${Math.round(1000 / periodMs)} Hz (or --period is wrong)`);
  }
  const viewport = capture.viewport;
  if (finite(viewport?.width) !== null && finite(viewport?.height) !== null
    && (viewport.width !== GOAL_VIEWPORT.width || viewport.height !== GOAL_VIEWPORT.height)) {
    warnings.push(`viewport ${viewport.width}×${viewport.height}: the goal is set for ${GOAL_VIEWPORT.width}×${GOAL_VIEWPORT.height}`
      + ' (line-P.ru.md §3), so these frames are not comparable with it');
  }
  if (finite(viewport?.dpr) !== null && viewport.dpr !== 1) {
    warnings.push(`devicePixelRatio ${viewport.dpr}: not comparable with the goal (DPR 1)`);
  }
  if (capture.frameLimitReached) warnings.push('the frame limit was reached: the recording ended early');

  // The period histogram: frames, share, cumulative share and share of wall time per k.
  const byPeriods = new Map();
  let wallMs = 0;
  for (const row of timed) {
    const k = periods(row);
    const entry = byPeriods.get(k) ?? { periods: k, frames: 0, ms: 0 };
    entry.frames++;
    entry.ms += row.intervalMs;
    wallMs += row.intervalMs;
    byPeriods.set(k, entry);
  }
  let cumulative = 0;
  const histogram = [...byPeriods.values()].sort((left, right) => left.periods - right.periods).map((entry) => {
    cumulative += entry.frames;
    return { periods: entry.periods, frames: entry.frames, share: entry.frames / timed.length,
      cumulative: cumulative / timed.length, timeShare: entry.ms / wallMs };
  });
  const k2Frames = timed.filter((row) => periods(row) <= 2).length;

  // Callback CPU against the two-period budget. H: callbacks within the budget whose interval (the next
  // row's) still took three periods or more — frame time spent outside the game callback.
  const sortedCpu = ascending(rows.map((row) => row.cpuMs));
  const hiddenPairs = pairs.filter((pair) => pair.cpuMs <= budgetMs && periods(pair) >= 3);
  const cpuBuckets = [];
  for (let index = 0; index + 1 < CPU_BUCKET_EDGES_MS.length; index++) {
    const fromMs = CPU_BUCKET_EDGES_MS[index], toMs = CPU_BUCKET_EDGES_MS[index + 1];
    const inside = pairs.filter((pair) => pair.cpuMs >= fromMs && pair.cpuMs < toMs);
    cpuBuckets.push({
      fromMs, toMs: Number.isFinite(toMs) ? toMs : null, frames: inside.length,
      k2Share: share(inside.filter((pair) => periods(pair) <= 2).length, inside.length),
      medianPeriods: nearestRank(ascending(inside.map(periods)), 0.5),
    });
  }

  // 10-second windows by callback start, as bench/analyze-live.mjs.
  const endMs = rows.reduce((end, row) => Math.max(end, row.atMs ?? 0), finite(capture.durationMs) ?? 0);
  const windows = [];
  for (let fromMs = 0; fromMs <= endMs; fromMs += WINDOW_MS) {
    const inside = rows.filter((row) => row.atMs !== null && row.atMs >= fromMs && row.atMs < fromMs + WINDOW_MS);
    const insideTimed = inside.filter((row) => row.intervalMs !== null);
    if (insideTimed.length === 0) continue;
    const windowPeriods = ascending(insideTimed.map(periods));
    const windowCpu = ascending(inside.map((row) => row.cpuMs));
    windows.push({
      fromMs, toMs: Math.min(fromMs + WINDOW_MS, endMs), frames: insideTimed.length,
      periods: { p50: nearestRank(windowPeriods, 0.5), p95: nearestRank(windowPeriods, 0.95), p99: nearestRank(windowPeriods, 0.99) },
      k2: share(insideTimed.filter((row) => periods(row) <= 2).length, insideTimed.length),
      cpuP50Ms: nearestRank(windowCpu, 0.5), cpuP95Ms: nearestRank(windowCpu, 0.95),
      framesOver100: insideTimed.filter((row) => row.intervalMs > FREEZE_INTERVAL_MS).length,
    });
  }

  // FrameXML, packets, programs, long animation frames and long tasks.
  const frameXml = isObject(capture.frameXml) ? {
    stepEwmaMs: finite(capture.frameXml.stepMs?.ewma), stepMaxMs: finite(capture.frameXml.stepMs?.max),
    syncsOutsideStep: finite(capture.frameXml.syncsOutsideStep?.count), layoutSyncs: finite(capture.frameXml.syncs?.layout?.count),
  } : null;
  const byOpcode = Array.isArray(capture.packets?.byOpcode) ? capture.packets.byOpcode.filter(isObject) : null;
  const packets = byOpcode ? {
    top: [...byOpcode].sort((left, right) => (finite(right.ms) ?? 0) - (finite(left.ms) ?? 0)).slice(0, 5).map(packetRow),
    watched: Object.fromEntries(['0x1f6', '0x23d'].map((opcode) =>
      [opcode, packetRow(byOpcode.find((row) => String(row.opcode).toLowerCase() === opcode))])),
  } : null;
  let programs = null;
  if (Array.isArray(events.shaderPrograms)) {
    const byPhase = {};
    for (const event of events.shaderPrograms) {
      if (!isObject(event) || event.phase === 'existing') continue;
      const phase = String(event.phase);
      byPhase[phase] ??= { events: 0, programs: 0 };
      byPhase[phase].events++;
      byPhase[phase].programs += finite(event.added) ?? 0;
    }
    programs = { byPhase, outsidePrepareWarm: Object.entries(byPhase)
      .filter(([phase]) => phase !== 'prepare' && phase !== 'warm').reduce((sum, [, entry]) => sum + entry.programs, 0) };
  }
  const dropped = isObject(capture.droppedEvents) ? capture.droppedEvents : {};
  const listed = (kind) => Array.isArray(events[kind]) ? events[kind].length + (finite(dropped[kind]) ?? 0) : null;
  const loafs = Array.isArray(events.longAnimationFrames) ? events.longAnimationFrames.filter(isObject) : null;
  const forced = loafs ? ascending(loafs.map((frame) => (Array.isArray(frame.scripts) ? frame.scripts : [])
    .reduce((sum, script) => sum + (finite(script?.forcedStyleAndLayoutMs) ?? 0), 0))) : [];
  const longTasks = Array.isArray(events.longTasks) ? ascending(events.longTasks.map((task) => task?.durationMs)) : null;
  const otherEvents = {
    slowPackets: listed('slowPackets'),
    longTasks: longTasks ? { count: listed('longTasks'), maxMs: longTasks.at(-1) ?? null } : null,
    longAnimationFrames: loafs ? { count: listed('longAnimationFrames'), forcedLayoutMeanMs: mean(forced),
      forcedLayoutMaxMs: forced.at(-1) ?? null } : null,
  };

  const report = {
    file: name,
    header: {
      recordedAt: capture.recordedAt ?? null, version: capture.version ?? null, durationMs: finite(capture.durationMs),
      viewport: isObject(capture.viewport) ? capture.viewport : null, browser: browserName(capture.browser),
      graphics: Object.fromEntries(GRAPHICS_KEYS.map((key) => [key, capture.settings?.[key] ?? null])),
      telemetryRevision: capture.telemetryRevision ?? null, frameXmlMounted: capture.frameXmlMounted ?? null,
    },
    periodMs, frames: rows.length, intervals, histogram,
    k2: { frames: k2Frames, share: share(k2Frames, timed.length) },
    cpu: {
      frames: sortedCpu.length, meanMs: mean(sortedCpu), p50Ms: nearestRank(sortedCpu, 0.5), p95Ms: nearestRank(sortedCpu, 0.95),
      p99Ms: nearestRank(sortedCpu, 0.99), maxMs: sortedCpu.at(-1) ?? null, budgetMs,
      withinBudget: share(sortedCpu.filter((value) => value <= budgetMs).length, sortedCpu.length),
    },
    hidden: { frames: hiddenPairs.length, pairs: pairs.length, share: share(hiddenPairs.length, pairs.length) },
    callbackDelay: { all: delaySummary(rows), hidden: delaySummary(hiddenPairs.map((pair) => rows[pair.index])) },
    cpuBuckets, windows,
    heap: heapSummary(checkpoints, timed),
    frameXml, packets, programs, events: otherEvents,
    telemetry: {
      revision: capture.telemetryRevision ?? null,
      drawPhases: drawPhaseSummary(capture.drawPhases),
      poseWorker: poseWorkerSummary(checkpoints),
      shadow: shadowSummary(checkpoints),
      stacking: numbersOnly(capture.stacking),
      frameExtra: frameExtraSummary(capture.frameExtra, pairs, hiddenPairs),
      doodadsPosed: doodadSummary(checkpoints),
    },
    warnings,
  };
  report.row = rowOf(report);
  report.goal = goalCheck(report.row);
  return report;
}

// ---------------------------------------------------------------------------------------------
// Several passes: one row per file, medians, the worst pass and the spread.

/** [metric, direction]: +1 larger is worse, −1 smaller is worse, 0 not ranked. */
export const ROW_METRICS = Object.freeze([
  ['intervals', 0], ['k2', -1], ['p50Periods', 1], ['p95Periods', 1], ['p99Periods', 1], ['p99Ms', 1],
  ['framesOver50', 1], ['framesOver100', 1], ['cpuP50Ms', 1], ['cpuP95Ms', 1], ['cpuWithinBudget', -1],
  ['hiddenShare', 1], ['heapGrowthMBps', 1], ['heapDrops', 1], ['quantizedShare', -1],
]);

function rowOf(report) {
  return {
    file: report.file, intervals: report.intervals.count, k2: report.k2.share,
    p50Periods: report.intervals.periods.p50, p95Periods: report.intervals.periods.p95, p99Periods: report.intervals.periods.p99,
    p99Ms: report.intervals.p99Ms, framesOver50: report.intervals.framesOver50, framesOver100: report.intervals.framesOver100,
    cpuP50Ms: report.cpu.p50Ms, cpuP95Ms: report.cpu.p95Ms, cpuWithinBudget: report.cpu.withinBudget,
    hiddenShare: report.hidden.share, heapGrowthMBps: report.heap?.growthMBps ?? null,
    heapDrops: report.heap ? report.heap.drops.length : null, quantizedShare: report.intervals.quantizedShare,
  };
}

export function summarizeGroup(reports) {
  const rows = reports.map((report) => report.row);
  const medianRow = {}, worst = {}, spread = {};
  for (const [key, direction] of ROW_METRICS) {
    const values = ascending(rows.map((row) => row[key]));
    medianRow[key] = median(values);
    worst[key] = values.length === 0 || direction === 0 ? null : direction < 0 ? values[0] : values.at(-1);
    spread[key] = values.length ? values.at(-1) - values[0] : null;
  }
  const settings = reports.map((report) => JSON.stringify(report.header.graphics));
  return {
    files: rows.map((row) => row.file), rows, median: medianRow, worst, spread, goal: goalCheck(worst),
    sameGraphics: settings.every((value) => value === settings[0]),
  };
}

/** Group minus reference, per metric; `beyondSpread` when both have several passes and |Δ| exceeds either spread. */
export function compareGroups(group, reference) {
  const passes = group.rows.length > 1 && reference.rows.length > 1;
  return Object.fromEntries(ROW_METRICS.map(([key]) => {
    const current = group.median[key], previous = reference.median[key];
    if (current === null || previous === null) return [key, null];
    const delta = current - previous;
    const spread = Math.max(group.spread[key] ?? 0, reference.spread[key] ?? 0);
    return [key, { delta, beyondSpread: passes ? Math.abs(delta) > spread : null }];
  }));
}

// ---------------------------------------------------------------------------------------------
// Text.

function fixed(value, digits = 2) { return value === null || value === undefined ? '—' : Number(value).toFixed(digits); }
function percent(value, digits = 1) { return value === null || value === undefined ? '—' : `${(value * 100).toFixed(digits)} %`; }
const yesNo = (value) => value ? 'yes' : 'no';

export function formatCapture(report) {
  const { header, intervals } = report;
  const lines = [`== ${report.file}`];
  const viewport = header.viewport ? `${header.viewport.width}×${header.viewport.height} @${header.viewport.dpr}` : '—';
  lines.push(`recorded ${header.recordedAt ?? '—'} · ${fixed((header.durationMs ?? 0) / 1000, 1)} s · viewport ${viewport}`
    + ` · ${header.browser ?? 'browser —'} · telemetryRevision ${header.telemetryRevision ?? '—'}`);
  lines.push(`graphics: ${Object.entries(header.graphics).map(([key, value]) => `${key} ${value ?? '—'}`).join(' · ')}`);
  for (const warning of report.warnings) lines.push(`WARNING: ${warning}`);
  lines.push(`period ${fixed(report.periodMs, 3)} ms; 2 periods = ${fixed(report.cpu.budgetMs)} ms`);
  const at = (key) => `${fixed(intervals[`${key}Ms`])} (${intervals.periods[key] ?? '—'}P)`;
  lines.push(`intervals ${intervals.count}: p50 ${at('p50')} · p90 ${at('p90')} · p95 ${at('p95')} · p99 ${at('p99')}`
    + ` · p99.9 ${at('p999')} · max ${at('max')} ms; within ±${QUANTIZATION_TOLERANCE_MS} ms of a multiple: ${percent(intervals.quantizedShare)}`);
  lines.push('  periods   frames    share  cumulative  wall time');
  for (const bin of report.histogram) {
    lines.push(`  ${String(bin.periods).padStart(7)} ${String(bin.frames).padStart(8)} ${percent(bin.share).padStart(8)}`
      + ` ${percent(bin.cumulative).padStart(11)} ${percent(bin.timeShare).padStart(10)}`);
  }
  lines.push(`K2 (≤ 2 periods) ${percent(report.k2.share)} · > 50 ms: ${intervals.framesOver50} · > 100 ms: ${intervals.framesOver100}`);
  const { cpu, hidden } = report;
  lines.push(`callback CPU (${cpu.frames} frames): p50 ${fixed(cpu.p50Ms)} · p95 ${fixed(cpu.p95Ms)} · p99 ${fixed(cpu.p99Ms)}`
    + ` · max ${fixed(cpu.maxMs)} ms · ≤ ${fixed(cpu.budgetMs)} ms: ${percent(cpu.withinBudget)}`);
  lines.push(`hidden cost H (callback CPU ≤ ${fixed(cpu.budgetMs)} ms, the interval containing it ≥ 3 periods):`
    + ` ${hidden.frames} of ${hidden.pairs} callbacks (${percent(hidden.share)})`);
  const delay = report.callbackDelay;
  lines.push(`callback start after the frame's rAF time (callbackStart − rafAt), p50/p95: all ${fixed(delay.all.p50Ms)}/${fixed(delay.all.p95Ms)} ms`
    + ` (${delay.all.count}) · H ${fixed(delay.hidden.p50Ms)}/${fixed(delay.hidden.p95Ms)} ms (${delay.hidden.count})`);
  lines.push('  CPU, ms   frames  ≤ 2 periods  median periods   (callback CPU against the interval that contains it)');
  for (const bucket of report.cpuBuckets.filter((entry) => entry.frames > 0)) {
    const label = bucket.toMs === null ? `≥ ${bucket.fromMs}` : `${bucket.fromMs}–${bucket.toMs}`;
    lines.push(`  ${label.padEnd(7)} ${String(bucket.frames).padStart(8)} ${percent(bucket.k2Share, 0).padStart(12)}`
      + ` ${String(bucket.medianPeriods).padStart(15)}`);
  }
  lines.push('  window   frames  periods p50/p95/p99      K2  CPU p50/p95 ms  > 100 ms');
  for (const window of report.windows) {
    lines.push(`  ${`${fixed(window.fromMs / 1000, 0)} s`.padEnd(6)} ${String(window.frames).padStart(8)}`
      + ` ${`${window.periods.p50}/${window.periods.p95}/${window.periods.p99}`.padStart(19)} ${percent(window.k2).padStart(7)}`
      + ` ${`${fixed(window.cpuP50Ms, 1)}/${fixed(window.cpuP95Ms, 1)}`.padStart(15)} ${String(window.framesOver100).padStart(9)}`);
  }
  const { heap } = report;
  if (heap) {
    lines.push(`heap: ${fixed(heap.startMB, 0)} → ${fixed(heap.endMB, 0)} MB · growth ${fixed(heap.growthMBps, 1)} MB/s`
      + ` (rises ${fixed(heap.riseMB, 0)} MB over ${fixed(heap.spanS, 1)} s) · drops ≥ ${HEAP_DROP_MB} MB: ${heap.drops.length}`);
    for (const drop of heap.drops) {
      lines.push(`  ${fixed(drop.deltaMB, 0)} MB between ${fixed(drop.fromAtMs / 1000, 2)} and ${fixed(drop.atMs / 1000, 2)} s;`
        + ` intervals > ${LONG_INTERVAL_MS} ms ending there: ${drop.longIntervalsMs.map((value) => fixed(value, 0)).join(', ') || 'none'}`);
    }
  } else lines.push('heap: not recorded');
  const { frameXml } = report;
  lines.push(frameXml ? `frameXml: step ewma ${fixed(frameXml.stepEwmaMs)} / max ${fixed(frameXml.stepMaxMs)} ms`
    + ` · syncs outside step ${frameXml.syncsOutsideStep ?? '—'} · layout syncs ${frameXml.layoutSyncs ?? '—'}` : 'frameXml: not recorded');
  const packet = (row) => row ? `${row.opcode} ${fixed(row.ms, 1)} ms (${row.count}, max ${fixed(row.maxMs, 1)})` : '—';
  if (report.packets) {
    lines.push(`packets by ms: ${report.packets.top.map(packet).join(' · ')}`);
    lines.push(`  watched: ${Object.entries(report.packets.watched).map(([opcode, row]) => row ? packet(row) : `${opcode} —`).join(' · ')}`);
  } else lines.push('packets: not recorded');
  const events = report.events;
  lines.push(`slow packets ${events.slowPackets ?? '—'} · long tasks ${events.longTasks?.count ?? '—'}`
    + ` (max ${fixed(events.longTasks?.maxMs, 0)} ms) · long animation frames ${events.longAnimationFrames?.count ?? '—'},`
    + ` forced style+layout per frame mean ${fixed(events.longAnimationFrames?.forcedLayoutMeanMs)} / max ${fixed(events.longAnimationFrames?.forcedLayoutMaxMs)} ms`);
  lines.push(report.programs ? `new programs: ${Object.entries(report.programs.byPhase)
    .map(([phase, entry]) => `${phase} ${entry.programs} (${entry.events} events)`).join(' · ') || 'none'}`
    + ` · outside prepare/warm: ${report.programs.outsidePrepareWarm}` : 'new programs: not recorded');
  lines.push(...formatTelemetry(report.telemetry));
  const { goal } = report;
  lines.push(`goal (K2 ≥ ${GOAL.k2 * 100} %, p99 ≤ ${GOAL.p99Periods} periods, 0 intervals > ${FREEZE_INTERVAL_MS} ms): ${goal.met ? 'MET' : 'NOT MET'}`
    + ` (K2 ${percent(report.k2.share)} ${yesNo(goal.k2)} · p99 ${intervals.periods.p99 ?? '—'} periods ${yesNo(goal.p99)}`
    + ` · > 100 ms ${intervals.framesOver100} ${yesNo(goal.over100)})`);
  return lines;
}

function formatTelemetry(telemetry) {
  const present = Object.entries(telemetry).filter(([key, value]) => key !== 'revision' && value !== null);
  if (present.length === 0) return ['P1-04 telemetry: none in this capture'];
  const lines = ['P1-04 telemetry:'];
  if (telemetry.drawPhases) {
    lines.push(`  drawPhases mean/max ms: ${Object.entries(telemetry.drawPhases)
      .map(([key, phase]) => `${key} ${fixed(phase.meanMs)}/${fixed(phase.maxMs, 1)}`).join(' · ')}`);
  }
  const pose = telemetry.poseWorker;
  if (pose) {
    lines.push(`  poseWorker: jobs ${pose.jobs} · worker ${percent(pose.workerShare)} · stolen+overridden ${percent(pose.stolenOverriddenShare)}`
      + ` · main ${fixed(pose.mainMsPerFrame, 3)} ms/frame · wait ${fixed(pose.waitMsPerFrame, 3)} ms/frame · workers ${pose.workersReady ?? '—'}`);
  }
  if (telemetry.shadow) {
    lines.push(`  shadow cascades: ${telemetry.shadow.cascades.map((cascade, index) => `#${index} ${fixed(cascade.drawCalls, 0)} draws`
      + ` ${fixed(cascade.cpuMs)} ms (max ${fixed(cascade.cpuMaxMs)}) ${percent(cascade.rendersPerFrame, 0)} of frames`
      + (cascade.cpuMsPerRender !== null && cascade.cpuMsPerRender !== undefined ? `, ${fixed(cascade.cpuMsPerRender)} ms/render` : '')).join(' · ')}`
      + (telemetry.shadow.farReasons ? ` · far reasons ${JSON.stringify(telemetry.shadow.farReasons)}` : '')
      + (telemetry.shadow.shadowOnlyCastersLegacy !== undefined
        ? ` · shadow-only casters (pre-P2-01 toggle count) ${fixed(telemetry.shadow.shadowOnlyCastersLegacy, 1)}`
        : ` · shadow-only owners ${fixed(telemetry.shadow.shadowOnlyOwners, 1)}`));
  }
  if (telemetry.stacking) lines.push(`  stacking: ${JSON.stringify(telemetry.stacking)}`);
  const extra = telemetry.frameExtra;
  if (extra) {
    const part = (entry) => `${entry.frames} frames, gap ${fixed(entry.gapMs, 0)} ms: packets ${fixed(entry.netMs, 0)}`
      + ` + FrameXML ${fixed(entry.frameXmlMs, 0)} ms (${percent(entry.explainedShare)})`;
    lines.push(`  frameExtra, gap of each callback (the interval containing it − its CPU): all ${part(extra.all)}; H ${part(extra.hidden)}`);
  }
  if (telemetry.doodadsPosed) lines.push(`  doodadsPosed: mean ${fixed(telemetry.doodadsPosed.mean, 1)} · max ${telemetry.doodadsPosed.max}`);
  return lines;
}

function formatRow(label, row) {
  // Capture names differ at the end (webclient-performance-<time>.json), so a long one keeps its tail.
  const name = label.length > 28 ? `…${label.slice(-27)}` : label.padEnd(28);
  return `  ${name} ${String(row.intervals ?? '—').padStart(5)} ${percent(row.k2).padStart(7)}`
    + ` ${`${fixed(row.p50Periods, 0)}/${fixed(row.p95Periods, 0)}/${fixed(row.p99Periods, 0)}`.padStart(9)}`
    + ` ${fixed(row.p99Ms, 1).padStart(7)} ${fixed(row.framesOver50, 0).padStart(4)} ${fixed(row.framesOver100, 0).padStart(4)}`
    + ` ${`${fixed(row.cpuP50Ms, 1)}/${fixed(row.cpuP95Ms, 1)}`.padStart(11)} ${percent(row.cpuWithinBudget).padStart(7)}`
    + ` ${percent(row.hiddenShare).padStart(7)} ${fixed(row.heapGrowthMBps, 1).padStart(6)} ${fixed(row.heapDrops, 0).padStart(5)}`;
}

export function formatGroup(title, group) {
  const lines = [`== ${title} (${group.rows.length} file${group.rows.length === 1 ? '' : 's'})`,
    `  ${'file'.padEnd(28)} ${'n'.padStart(5)} ${'K2'.padStart(7)} ${'p50/95/99'.padStart(9)} ${'p99 ms'.padStart(7)}`
    + ` ${'>50'.padStart(4)} ${'>100'.padStart(4)} ${'CPU 50/95'.padStart(11)} ${'CPU≤2P'.padStart(7)} ${'H'.padStart(7)}`
    + ` ${'MB/s'.padStart(6)} ${'drops'.padStart(5)}`];
  for (const row of group.rows) lines.push(formatRow(row.file, row));
  lines.push(formatRow('median', group.median), formatRow('worst', group.worst), formatRow('spread (max − min)', group.spread));
  if (!group.sameGraphics) lines.push('  WARNING: graphics settings differ between these files');
  lines.push(`  goal on the worst of ${group.rows.length}: ${group.goal.met ? 'MET' : 'NOT MET'} (K2 ${yesNo(group.goal.k2)}`
    + ` · p99 ${yesNo(group.goal.p99)} · > 100 ms ${yesNo(group.goal.over100)})`);
  return lines;
}

export function formatDelta(delta) {
  const lines = ['== Δ medians (files − vs); * = larger than the spread of either group'];
  for (const [key] of ROW_METRICS) {
    const entry = delta[key];
    if (!entry) continue;
    const shareMetric = ['k2', 'cpuWithinBudget', 'hiddenShare', 'quantizedShare'].includes(key);
    const value = shareMetric ? `${entry.delta >= 0 ? '+' : ''}${(entry.delta * 100).toFixed(1)} pp`
      : `${entry.delta >= 0 ? '+' : ''}${fixed(entry.delta, 2)}`;
    lines.push(`  ${key.padEnd(16)} ${value.padStart(10)}${entry.beyondSpread ? ' *' : ''}`);
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------
// Command line.

export function parseArgs(argv) {
  const options = { files: [], vs: [], periodMs: DEFAULT_PERIOD_MS, json: undefined, compare: false };
  let target = options.files;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const [name, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    if (name === '--vs') { options.compare = true; target = options.vs; continue; }
    if (name === '--period' || name === '--json') {
      const value = inline ?? argv[++index];
      if (value === undefined) throw new Error(`${name} needs a value\n${USAGE}`);
      if (name === '--json') options.json = value;
      else {
        options.periodMs = Number(value);
        if (!(options.periodMs > 0) || !Number.isFinite(options.periodMs)) throw new Error(`invalid --period ${value}`);
      }
      continue;
    }
    if (arg.startsWith('--')) throw new Error(`unknown option ${arg}\n${USAGE}`);
    target.push(arg);
  }
  if (options.files.length === 0) throw new Error(USAGE);
  if (options.compare && options.vs.length === 0) throw new Error(`--vs needs capture files\n${USAGE}`);
  return options;
}

async function load(files, periodMs) {
  return Promise.all(files.map(async (file) => {
    const bytes = await readFile(file);
    const report = analyzeCapture(JSON.parse(bytes), { periodMs, name: basename(file) });
    report.sha256 = createHash('sha256').update(bytes).digest('hex');
    return report;
  }));
}

export async function main(argv) {
  const options = parseArgs(argv);
  const reports = await load(options.files, options.periodMs);
  const vsReports = options.compare ? await load(options.vs, options.periodMs) : [];
  const group = summarizeGroup(reports);
  const vs = options.compare ? summarizeGroup(vsReports) : null;
  const delta = vs ? compareGroups(group, vs) : null;
  const lines = [];
  if (reports.length === 1 && !vs) lines.push(...formatCapture(reports[0]));
  else {
    for (const report of [...reports, ...vsReports]) {
      lines.push(`${report.file}: recorded ${report.header.recordedAt ?? '—'} · ${report.header.browser ?? '—'}`
        + ` · viewport ${report.header.viewport ? `${report.header.viewport.width}×${report.header.viewport.height} @${report.header.viewport.dpr}` : '—'}`);
      for (const warning of report.warnings) lines.push(`  WARNING: ${warning}`);
    }
    lines.push(...formatGroup('files', group));
    if (vs) lines.push(...formatGroup('vs', vs), ...formatDelta(delta));
  }
  console.log(lines.join('\n'));
  if (options.json) {
    const output = resolve(options.json);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify({
      tool: 'bench/live-periods.mjs', periodMs: options.periodMs, budgetMs: 2 * options.periodMs, goal: GOAL,
      files: reports, vsFiles: vsReports.length ? vsReports : null, group, vs, delta,
    }, null, 2)}\n`);
    console.log(`\nreport: ${options.json}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  });
}
