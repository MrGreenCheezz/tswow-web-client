import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  alignWithCapture, analyzeGcEvents, formatReport, gcDecision, groupIsolates, majorReasonClass, parseArgs, parseGcLine, parseGcLog,
  parseGcTrace, readTraceEvents, summarizeIsolate,
} from '../bench/analyze-gc-log.mjs';

// P1-03b: V8's GC lines → per-isolate counts, pauses, reasons and the line-P decision. The fixtures are
// real lines: Node 22.23 (V8 12.4) `--trace-gc`, `--trace-gc --minor-ms`, `--trace-gc-nvp`.
const fixture = (name) => readFile(new URL(`./fixtures/gc-log/${name}`, import.meta.url), 'utf8');

test('real --trace-gc lines: three collectors, pauses, heap and the trailing reason', async () => {
  const events = parseGcLog(await fixture('node22-trace-gc.txt'));
  assert.deepEqual(events.map((event) => event.collector),
    ['Scavenge', 'Scavenge', 'Mark-Compact', 'Minor Mark-Sweep', 'Mark-Compact', 'Scavenge']);
  assert.deepEqual(events.map((event) => event.kind), ['minor', 'minor', 'major', 'minor', 'major', 'minor']);
  const [first, , major, minorMs, testing, interleaved] = events;
  assert.equal(first.pid, 25496);
  assert.equal(first.isolate, '0000027315335000');
  assert.equal(first.atMs, 26);
  assert.equal(first.heapBeforeMB, 4.4);
  assert.equal(first.heapAfterMB, 3.9);
  assert.equal(first.committedAfterMB, 6.1);
  assert.equal(first.pauseMs, 0.92);
  assert.equal(first.reason, 'allocation failure');
  assert.equal(first.collectorReason, null);
  assert.equal(major.pauseMs, 3.22, 'the pause, not the incremental-marking step time in the parentheses');
  assert.equal(major.reason, 'finalize incremental marking via stack guard');
  assert.equal(major.collectorReason, 'GC in old space requested');
  assert.equal(minorMs.pauseMs, 0.42);
  assert.equal(testing.reason, 'testing');
  assert.equal(interleaved.collector, 'Scavenge', '"Scavenge (interleaved)" is still a scavenge');
  assert.equal(interleaved.pauseMs, 0.05);
  assert.equal(parseGcLine('[1:00ab]  5 ms: Mark-Compact (reduce) 9.0 (10.0) -> 2.0 (4.0) MB, 3.00 / 0.00 ms  (average mu = 1, current mu = 1) idle task;').reduce, true);
  assert.equal(parseGcLine('[electron] [7:00ff]  9 ms: Scavenge 1.0 (2.0) -> 0.5 (2.0) MB, 0.10 / 0.00 ms  (average mu = 1, current mu = 1) task;\r')?.pid, 7,
    'the bench prefix and a CR are stripped');
  assert.equal(parseGcLine('random text'), null);
  assert.equal(parseGcLine('[1:00ab]  5 ms: Memory allocator,       used: 1 KB'), null);
});

test('real Electron 40 (Chromium 144) main-process lines: "Incremental Mark-Compact (reduce)"', async () => {
  const events = parseGcLog(await fixture('electron40-trace-gc.txt'));
  assert.deepEqual(events.map((event) => [event.collector, event.incremental, event.reduce]),
    [['Scavenge', false, false], ['Scavenge', false, false], ['Mark-Compact', true, true], ['Mark-Compact', true, true]]);
  const [scavenge, , major] = events;
  assert.equal(scavenge.pid, 8680);
  assert.equal(scavenge.pauseMs, 0.6);
  assert.equal(major.kind, 'major');
  assert.equal(major.pauseMs, 2.28);
  assert.equal(major.externalMs, 0.06);
  assert.equal(major.reason, 'finalize incremental marking via task');
  assert.equal(majorReasonClass(major), 'idle', 'a memory-reducing full GC is the reducer, not old-generation pressure');
});

test('real --trace-gc-nvp lines: collector letters, pause, promoted and sizes, no reason', async () => {
  const events = parseGcLog(await fixture('node22-trace-gc-nvp.txt'));
  assert.deepEqual(events.map((event) => [event.kind, event.collector]),
    [['minor', 'Scavenge'], ['major', 'Mark-Compact'], ['minor', 'Minor Mark-Sweep']]);
  const [scavenge, markCompact, minorMs] = events;
  assert.equal(scavenge.pauseMs, 0.6);
  assert.equal(scavenge.promotedBytes, 0);
  assert.equal(scavenge.newSpaceSurvivedBytes, 487216);
  assert.equal(scavenge.heapBeforeMB, 4653752 / 1048576);
  assert.equal(markCompact.pauseMs, 4.5);
  assert.equal(markCompact.promotedBytes, 7754176);
  assert.equal(markCompact.reason, null);
  assert.equal(minorMs.pauseMs, 0.3);
});

/** A synthetic Chrome trace: one renderer main thread, one worker, NVP events and the older MinorGC/MajorGC. */
function syntheticTrace({ withNvp = true } = {}) {
  const nvp = (tid, ts, value) => ({ name: 'V8.GCTraceGCNVP', ph: 'I', pid: 10, tid, ts, cat: 'disabled-by-default-v8.gc',
    args: { value: JSON.stringify(value) } });
  const scavenge = (ts, promoted) => ({ pause: 1.5, gc: 's', reduce_memory: false, reason: 'allocation failure', collector_reason: '',
    start_object_size: 40 * 1048576, end_object_size: 30 * 1048576, promoted, new_space_capacity: 16 * 1048576, new_space_survived: 1 });
  return { traceEvents: [
    { name: 'thread_name', ph: 'M', pid: 10, tid: 1, args: { name: 'CrRendererMain' } },
    { name: 'thread_name', ph: 'M', pid: 10, tid: 2, args: { name: 'DedicatedWorker thread' } },
    ...(withNvp ? [
      nvp(1, 1_000_000, scavenge(1_000_000, 8 * 1048576)),
      nvp(1, 5_000_000, scavenge(5_000_000, 4 * 1048576)),
      nvp(1, 12_000_000, { pause: 25, gc: 'mc', reduce_memory: false, reason: 'allocation failure', collector_reason: 'GC in old space requested',
        start_object_size: 300 * 1048576, end_object_size: 100 * 1048576, promoted: 0, new_space_capacity: 16 * 1048576 }),
      ...[0, 1, 2].map((index) => nvp(2, 2_000_000 + index, scavenge(0, 0))),
    ] : []),
    { name: 'MinorGC', ph: 'X', pid: 10, tid: 1, ts: 1_000_000, dur: 1500, args: { type: 'allocation failure', usedHeapSizeBefore: 2097152, usedHeapSizeAfter: 1048576 } },
    { name: 'MajorGC', ph: 'X', pid: 10, tid: 1, ts: 12_000_000, dur: 25000, args: { type: 'idle task', usedHeapSizeBefore: 2097152, usedHeapSizeAfter: 1048576 } },
  ] };
}

test('a trace: NVP events per thread, the renderer main thread first, windows and the decision', () => {
  const events = parseGcTrace(syntheticTrace());
  assert.equal(events.length, 6);
  const groups = groupIsolates(events);
  assert.equal(groups[0].events[0].threadName, 'CrRendererMain', 'main thread first although the worker has more scavenges');
  const report = analyzeGcEvents(events, { source: 'trace' });
  const main = report.isolates[0];
  assert.equal(main.byCollector.Scavenge.count, 2);
  assert.equal(main.byCollector.Scavenge.pauseSumMs, 3);
  assert.equal(main.byCollector['Mark-Compact'].pauseMaxMs, 25);
  assert.equal(main.byCollector['Mark-Compact'].freedMB, 200);
  assert.equal(main.minor.promotedShareOfNewSpace, 0.375, '(8 + 4) / 2 MB of a 16 MB new space');
  assert.deepEqual(main.windows.map((window) => [window.fromS, window.minor, window.major]), [[0, 2, 0], [10, 0, 1]]);
  assert.equal(report.decision.verdict, 'semi-space');
  assert.match(formatReport(report).join('\n'), /main isolate 10:1 \(CrRendererMain\)/);
});

test('a trace file is streamed line by line (Chrome layout) or parsed whole (one line)', async () => {
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'gc-trace-'));
  try {
    const trace = syntheticTrace();
    const filler = { name: 'RunTask', ph: 'X', pid: 10, tid: 1, ts: 1, dur: 1, args: {} };
    const layout = `{"traceEvents":[\n${[filler, ...trace.traceEvents, filler].map((event) => JSON.stringify(event)).join(',\n')}]}\n`;
    await writeFile(join(dir, 'lines.json'), layout);
    await writeFile(join(dir, 'whole.json'), JSON.stringify(trace));
    const streamed = await readTraceEvents(join(dir, 'lines.json'));
    assert.equal(streamed.traceEvents.length, trace.traceEvents.length, 'only GC and thread-name events are kept');
    assert.deepEqual(parseGcTrace(streamed), parseGcTrace(trace));
    assert.deepEqual(parseGcTrace(await readTraceEvents(join(dir, 'whole.json'))), parseGcTrace(trace));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a trace without NVP falls back to MinorGC/MajorGC with their type as the reason', () => {
  const events = parseGcTrace(syntheticTrace({ withNvp: false }));
  assert.deepEqual(events.map((event) => [event.kind, event.pauseMs, event.reason]), [['minor', 1.5, 'allocation failure'], ['major', 25, 'idle task']]);
  assert.equal(analyzeGcEvents(events).decision.verdict, 'leave', 'idle-time full GCs: leave the semi-space alone');
  assert.throws(() => parseGcTrace({}), /traceEvents/);
});

test('the log isolate with the most scavenges is the main one; the decision follows the line-P rules', async () => {
  const lines = [
    '[5:aa]  100 ms: Scavenge 10.0 (20.0) -> 5.0 (20.0) MB, 1.00 / 0.00 ms  (average mu = 1, current mu = 1) allocation failure;',
    '[5:aa]  200 ms: Scavenge 10.0 (20.0) -> 5.0 (20.0) MB, 2.00 / 0.00 ms  (average mu = 1, current mu = 1) allocation failure;',
    '[5:bb]  150 ms: Scavenge 1.0 (2.0) -> 0.5 (2.0) MB, 0.10 / 0.00 ms  (average mu = 1, current mu = 1) allocation failure;',
    '[5:aa]  300 ms: Mark-Compact 200.0 (260.0) -> 90.0 (250.0) MB, 30.00 / 0.00 ms  (average mu = 1, current mu = 1) external memory pressure;',
    '[5:aa]  400 ms: Mark-Compact 200.0 (260.0) -> 90.0 (250.0) MB, 40.00 / 0.00 ms  (average mu = 1, current mu = 1) external memory pressure;',
  ];
  const report = analyzeGcEvents(parseGcLog(lines.join('\n')));
  assert.equal(report.isolates[0].isolate, 'aa');
  assert.equal(report.isolates[0].byCollector['Mark-Compact'].count, 2);
  assert.equal(report.isolates[0].byCollector['Mark-Compact'].pauseSumMs, 70);
  assert.deepEqual(report.isolates[0].byCollector['Mark-Compact'].reasons, { 'external memory pressure': 2 });
  assert.equal(report.decision.verdict, 'external-memory');
  assert.equal(majorReasonClass({ reason: 'finalize incremental marking via task', reduce: true }), 'idle');
  assert.equal(majorReasonClass({ reason: 'allocation failure' }), 'old-generation');
  const oldGen = { minor: { promotedShareOfNewSpace: null } };
  assert.equal(gcDecision(oldGen, [{ reason: 'allocation failure' }]).verdict, 'undecided', 'promoted share unknown without nvp');
  assert.equal(gcDecision({ minor: { promotedShareOfNewSpace: 0.1 } }, [{ reason: 'allocation failure' }]).verdict, 'undecided');
  assert.equal(gcDecision(oldGen, []).why, 'no full collections');
});

test('capture alignment lists freezes with the pauses inside them', () => {
  const events = parseGcLog([
    '[5:aa]  1000 ms: Mark-Compact 200.0 (260.0) -> 90.0 (250.0) MB, 30.00 / 0.00 ms  (average mu = 1, current mu = 1) allocation failure;',
    '[5:aa]  4000 ms: Mark-Compact 200.0 (260.0) -> 90.0 (250.0) MB, 60.00 / 0.00 ms  (average mu = 1, current mu = 1) allocation failure;',
  ].join('\n'));
  const rows = [{ intervalMs: 90, rafAtMs: 5050 }, { intervalMs: 7, rafAtMs: 5100 }, { intervalMs: 80, rafAtMs: 6500 }];
  const { offsetMs, freezes } = alignWithCapture(events, rows, [{ atMs: 2000, fromAtMs: 1500, deltaMB: -110 }]);
  assert.equal(offsetMs, 1000);
  assert.deepEqual(freezes.map((freeze) => [freeze.intervalMs, freeze.pauses.length]), [[90, 1], [80, 0]]);
  assert.deepEqual(alignWithCapture([], rows, []), { offsetMs: null, freezes: [] });
});

test('arguments: exactly one input, --capture with either', () => {
  assert.deepEqual(parseArgs(['--log', 'a.txt']), { log: 'a.txt', trace: null, json: null, capture: null });
  assert.deepEqual(parseArgs(['--trace', 'b', '--capture', 'c']), { log: null, trace: 'b', json: null, capture: 'c' });
  assert.throws(() => parseArgs([]), /exactly one/);
  assert.throws(() => parseArgs(['--log', 'a', '--trace', 'b']), /exactly one/);
  assert.throws(() => parseArgs(['--log']), /needs a value/);
  assert.throws(() => parseArgs(['--bogus', 'x']), /unknown/);
});

test('summarizeIsolate counts windows from the first collection', () => {
  const summary = summarizeIsolate([{ atMs: 50_000, kind: 'minor', collector: 'Scavenge', pauseMs: 1 },
    { atMs: 71_000, kind: 'major', collector: 'Mark-Compact', pauseMs: 9 }]);
  assert.deepEqual(summary.windows.map((window) => [window.fromS, window.minor, window.major, window.majorPauseMs]),
    [[0, 1, 0, 0], [10, 0, 0, 0], [20, 0, 1, 9]]);
});
