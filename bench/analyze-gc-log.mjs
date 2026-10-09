// What triggers the garbage collections (P1-03b, MEM-4): reads V8's own GC lines and summarises them
// per isolate — count, pauses, heap, reasons, promoted bytes — in 10-s windows, and says which way the
// line-P rules point.
//
//   node bench/analyze-gc-log.mjs --log <trace-gc.txt> [--json out.json] [--capture <freeze capture.json>]
//   node bench/analyze-gc-log.mjs --trace <trace.json> [--json out.json] [--capture <freeze capture.json>]
//
// Inputs:
//   --log    stdout of a Chromium/Electron/Node process started with `--js-flags=--trace-gc` (one human
//            line per collection, with its reason) or `--js-flags=--trace-gc-nvp` (name=value lines with
//            `promoted`, no reason). V8 prints ONE of the two forms: with both flags only the nvp line comes.
//   --trace  a bench `--trace` file (`bench/results/<label>/<scenario>.trace.json`) or a DevTools
//            Performance profile, or a startup trace of the packaged app (below): the `V8.GCTraceGCNVP`
//            instant events of `disabled-by-default-v8.gc` carry pause, reason, promoted bytes and the new-space capacity of every collection; the
//            `MinorGC`/`MajorGC` events are used when those are absent. Streamed line by line (a trace
//            of bench movement passes 1 GB).
//   --capture a freeze recording (`webclientRecordFreezes()`, capture v2): the log's first full GC is
//            put at the recording's first heap drop ≥ 20 MB, then intervals ≥ 50 ms are listed with the
//            pauses ≥ 20 ms inside them. The alignment is approximate (one anchor).
//
// A live session without stdout and without --no-sandbox (checked 08.10 on dist/electron, Electron 40):
//   WoWWebClient.exe --trace-startup=v8,disabled-by-default-v8.gc --trace-startup-format=json
//     --trace-startup-duration=120 --trace-startup-file=<path>.json
// writes every process's GC events, the sandboxed renderer's included, when the duration ends. With
// --js-flags=--trace-gc a sandboxed renderer prints nothing, and redirected stdout is block-buffered.
//
// The main isolate is the trace's `CrRendererMain` thread, or in a log the isolate with the most
// scavenges (workers have their own isolates and lines in the same renderer process).
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const WINDOW_MS = 10_000;
/** Pauses at least this long are listed next to the freezes of a capture. */
export const LONG_PAUSE_MS = 20;
export const FREEZE_MS = 50;
/** line-P rule: promoted ≥ 30 % of the semi-space per scavenge points at a larger semi-space (P1-03c). */
export const PROMOTED_SHARE_GATE = 0.3;

// `[pid:isolate]  1234 ms: Scavenge 4.4 (5.1) -> 3.9 (6.1) MB, pooled: 0 MB, 0.55 / 0.00 ms  (average mu = …) reason`
const HUMAN = /^\[(\d+):([0-9A-Fa-fx]+)\]\s+(\d+(?:\.\d+)?) ms: ((?:Incremental )?(?:Scavenge|Minor Mark-Sweep|Mark-Compact|Mark-Sweep))((?: \([a-z ]+\))*)\s+([\d.]+) \(([\d.]+)\) -> ([\d.]+) \(([\d.]+)\) MB.*?, ([\d.]+) \/ ([\d.]+) ms(.*)$/;
// `[pid:isolate]  1234 ms: pause=0.6 mutator=11.2 gc=s reduce_memory=0 …` (older V8 starts with gc=)
const NVP = /^\[(\d+):([0-9A-Fa-fx]+)\]\s+(\d+(?:\.\d+)?) ms: ((?:\S+=\S*\s*)+)$/;

/** V8's collector letters (`gc=`) and trace names → { kind, collector }. */
const COLLECTORS = {
  s: { kind: 'minor', collector: 'Scavenge' },
  mms: { kind: 'minor', collector: 'Minor Mark-Sweep' },
  ms: { kind: 'minor', collector: 'Minor Mark-Sweep' },
  mmc: { kind: 'minor', collector: 'Minor Mark-Sweep' },
  mc: { kind: 'major', collector: 'Mark-Compact' },
};

function collectorOfName(name) {
  if (name === 'Scavenge') return COLLECTORS.s;
  if (name === 'Minor Mark-Sweep') return COLLECTORS.mms;
  return COLLECTORS.mc;
}

/** The trailing reason of a human line: after `(average mu = …, current mu = …)`, without the final `;`. */
function reasonOf(tail) {
  const at = tail.lastIndexOf('current mu = ');
  const rest = at >= 0 ? tail.slice(tail.indexOf(')', at) + 1) : tail;
  const parts = rest.split(';').map((part) => part.trim()).filter(Boolean);
  return { reason: parts[0] ?? null, collectorReason: parts[1] ?? null };
}

const number = (value) => {
  const parsed = Number(value);
  return value !== undefined && value !== '' && Number.isFinite(parsed) ? parsed : null;
};

/** One collection from a `--trace-gc` or `--trace-gc-nvp` line, or null for any other line. */
export function parseGcLine(rawLine) {
  const line = rawLine.replace(/\r$/, '').replace(/^\[electron\]\s*/, '').trim();
  const human = HUMAN.exec(line);
  if (human) {
    const [, pid, isolate, atMs, name, qualifiers, before, beforeCommitted, after, afterCommitted, pause, external, tail] = human;
    // V8 14 (Chromium 144) prints a full GC finished by incremental marking as "Incremental Mark-Compact".
    const { kind, collector } = collectorOfName(name.replace(/^Incremental /, ''));
    return {
      source: 'trace-gc', pid: Number(pid), isolate, atMs: Number(atMs), kind, collector,
      incremental: name.startsWith('Incremental '), reduce: /\(reduce\)/.test(qualifiers), pauseMs: Number(pause), externalMs: Number(external),
      heapBeforeMB: Number(before), heapAfterMB: Number(after),
      committedBeforeMB: Number(beforeCommitted), committedAfterMB: Number(afterCommitted),
      ...reasonOf(tail), promotedBytes: null, newSpaceSurvivedBytes: null, newSpaceCapacityBytes: null,
    };
  }
  const nvp = NVP.exec(line);
  if (!nvp) return null;
  const fields = Object.fromEntries(nvp[4].trim().split(/\s+/).map((pair) => {
    const at = pair.indexOf('=');
    return [pair.slice(0, at), pair.slice(at + 1)];
  }));
  const kind = COLLECTORS[fields.gc];
  if (!kind) return null;
  const mb = (bytes) => bytes === null ? null : bytes / 1048576;
  return {
    source: 'trace-gc-nvp', pid: Number(nvp[1]), isolate: nvp[2], atMs: Number(nvp[3]), ...kind,
    reduce: fields.reduce_memory === '1' || fields.reduce_memory === 'true', pauseMs: number(fields.pause),
    externalMs: null, heapBeforeMB: mb(number(fields.total_size_before)), heapAfterMB: mb(number(fields.total_size_after)),
    committedBeforeMB: null, committedAfterMB: null, reason: null, collectorReason: null,
    promotedBytes: number(fields.promoted),
    newSpaceSurvivedBytes: number(fields.semi_space_copied ?? fields.new_space_survived),
    newSpaceCapacityBytes: number(fields.new_space_capacity),
  };
}

/** Every collection in a log, in file order. */
export function parseGcLog(text) {
  return text.split('\n').map(parseGcLine).filter(Boolean);
}

/**
 * Collections of a Chrome trace. `V8.GCTraceGCNVP` (category disabled-by-default-v8.gc) first; when a
 * trace has none, `MinorGC`/`MajorGC` (pause = duration, reason = args.type). Threads are named from the
 * trace's thread_name metadata; `atMs` is the trace clock in ms.
 */
export function parseGcTrace(trace) {
  const events = Array.isArray(trace) ? trace : trace?.traceEvents;
  if (!Array.isArray(events)) throw new Error('not a Chrome trace: traceEvents are missing');
  const threadNames = new Map();
  for (const event of events) {
    if (event.ph === 'M' && event.name === 'thread_name') threadNames.set(`${event.pid}:${event.tid}`, event.args?.name ?? null);
  }
  const base = (event) => ({ pid: event.pid, isolate: String(event.tid), threadName: threadNames.get(`${event.pid}:${event.tid}`) ?? null,
    atMs: event.ts / 1000 });
  const nvp = [];
  for (const event of events) {
    if (event.name !== 'V8.GCTraceGCNVP' || typeof event.args?.value !== 'string') continue;
    let value;
    try { value = JSON.parse(event.args.value); } catch { continue; }
    const kind = COLLECTORS[value.gc];
    if (!kind) continue;
    const mb = (bytes) => typeof bytes === 'number' ? bytes / 1048576 : null;
    nvp.push({
      source: 'trace-nvp', ...base(event), ...kind, reduce: value.reduce_memory === true, pauseMs: number(value.pause),
      externalMs: null, heapBeforeMB: mb(value.start_object_size), heapAfterMB: mb(value.end_object_size),
      committedBeforeMB: mb(value.start_memory_size), committedAfterMB: mb(value.end_memory_size),
      reason: value.reason || null, collectorReason: value.collector_reason || null,
      promotedBytes: number(value.promoted), newSpaceSurvivedBytes: number(value.new_space_survived),
      newSpaceCapacityBytes: number(value.new_space_capacity),
    });
  }
  if (nvp.length) return nvp.sort((left, right) => left.atMs - right.atMs);
  return events.filter((event) => (event.name === 'MinorGC' || event.name === 'MajorGC') && event.ph === 'X').map((event) => ({
    source: 'trace-event', ...base(event), ...(event.name === 'MinorGC' ? COLLECTORS.s : COLLECTORS.mc),
    collector: event.name === 'MinorGC' ? 'MinorGC' : 'MajorGC', reduce: false, pauseMs: event.dur / 1000, externalMs: null,
    heapBeforeMB: number(event.args?.usedHeapSizeBefore) === null ? null : event.args.usedHeapSizeBefore / 1048576,
    heapAfterMB: number(event.args?.usedHeapSizeAfter) === null ? null : event.args.usedHeapSizeAfter / 1048576,
    committedBeforeMB: null, committedAfterMB: null, reason: event.args?.type || null, collectorReason: null,
    promotedBytes: null, newSpaceSurvivedBytes: null, newSpaceCapacityBytes: null,
  })).sort((left, right) => left.atMs - right.atMs);
}

const sum = (values) => values.reduce((total, value) => total + value, 0);
const mean = (values) => values.length ? sum(values) / values.length : null;
const histogram = (values) => Object.fromEntries([...values.reduce((counts, value) => counts.set(value, (counts.get(value) ?? 0) + 1), new Map())]
  .sort((left, right) => right[1] - left[1]));

function collectorSummary(events) {
  const pauses = events.map((event) => event.pauseMs).filter((value) => value !== null);
  const promoted = events.map((event) => event.promotedBytes).filter((value) => value !== null);
  // Only a young-generation collection promotes out of new space; a full GC's `promoted` is not that share.
  const shares = events.filter((event) => event.kind === 'minor' && event.promotedBytes !== null && event.newSpaceCapacityBytes > 0)
    .map((event) => event.promotedBytes / event.newSpaceCapacityBytes);
  const freed = events.filter((event) => event.heapBeforeMB !== null && event.heapAfterMB !== null)
    .map((event) => event.heapBeforeMB - event.heapAfterMB);
  return {
    count: events.length, pauseSumMs: sum(pauses), pauseMaxMs: pauses.length ? Math.max(...pauses) : null,
    pauseMeanMs: mean(pauses), freedMB: freed.length ? sum(freed) : null,
    reasons: histogram(events.map((event) => [event.reason ?? '(no reason)', event.collectorReason].filter(Boolean).join('; '))),
    reduceCount: events.filter((event) => event.reduce).length,
    promotedMB: promoted.length ? sum(promoted) / 1048576 : null,
    promotedMeanMB: promoted.length ? mean(promoted) / 1048576 : null,
    promotedShareOfNewSpace: shares.length ? mean(shares) : null,
    newSpaceCapacityMaxMB: Math.max(0, ...events.map((event) => event.newSpaceCapacityBytes ?? 0)) / 1048576 || null,
  };
}

/**
 * Summary of one isolate: per collector, the heap at the first and last collection, and 10-s windows
 * counted from the isolate's first collection.
 */
export function summarizeIsolate(events, { windowMs = WINDOW_MS } = {}) {
  const sorted = [...events].sort((left, right) => left.atMs - right.atMs);
  const byCollector = {};
  for (const collector of [...new Set(sorted.map((event) => event.collector))]) {
    byCollector[collector] = collectorSummary(sorted.filter((event) => event.collector === collector));
  }
  const start = sorted[0]?.atMs ?? 0;
  const windows = [];
  for (const event of sorted) {
    const index = Math.floor((event.atMs - start) / windowMs);
    while (windows.length <= index) windows.push({ fromS: windows.length * windowMs / 1000, minor: 0, major: 0, minorPauseMs: 0, majorPauseMs: 0 });
    windows[index][event.kind] += 1;
    windows[index][`${event.kind}PauseMs`] += event.pauseMs ?? 0;
  }
  return {
    pid: sorted[0]?.pid ?? null, isolate: sorted[0]?.isolate ?? null, threadName: sorted[0]?.threadName ?? null,
    events: sorted.length, spanS: sorted.length ? (sorted.at(-1).atMs - start) / 1000 : 0,
    heapFirstMB: sorted[0]?.heapBeforeMB ?? null, heapLastMB: sorted.at(-1)?.heapAfterMB ?? null,
    minor: collectorSummary(sorted.filter((event) => event.kind === 'minor')),
    major: collectorSummary(sorted.filter((event) => event.kind === 'major')),
    byCollector, windows,
  };
}

/** Major-GC reason classes for the line-P rules. */
export function majorReasonClass(event) {
  const text = `${event.reason ?? ''} ${event.collectorReason ?? ''}`.toLowerCase();
  if (/external memory/.test(text)) return 'external';
  if (event.reduce || /idle|memory reducer|low memory|memory pressure/.test(text)) return 'idle';
  if (!event.reason && !event.collectorReason) return 'unknown';
  return 'old-generation';
}

/**
 * The line-P P1-03b decision: mostly old-generation reasons and promoted ≥ 30 % of the semi-space →
 * 'semi-space' (P1-03c); mostly external memory pressure → 'external-memory'; mostly idle/reducer →
 * 'leave'; otherwise 'undecided' with what is missing. `majorEvents` are the main isolate's major GCs.
 */
export function gcDecision(summary, majorEvents) {
  const classes = histogram(majorEvents.map(majorReasonClass));
  const total = majorEvents.length;
  const top = Object.entries(classes)[0];
  const share = summary.minor.promotedShareOfNewSpace;
  if (!total) return { verdict: 'undecided', why: 'no full collections', classes, promotedShare: share };
  if (top[1] / total <= 0.5) return { verdict: 'undecided', why: 'no reason class holds a majority', classes, promotedShare: share };
  if (top[0] === 'external') return { verdict: 'external-memory', why: 'external memory pressure dominates', classes, promotedShare: share };
  if (top[0] === 'idle') return { verdict: 'leave', why: 'idle-time / memory-reducer collections dominate', classes, promotedShare: share };
  if (top[0] === 'unknown') return { verdict: 'undecided', why: 'the input carries no reasons (nvp log)', classes, promotedShare: share };
  if (share === null) return { verdict: 'undecided', why: 'old-generation reasons dominate; promoted share unknown (needs nvp)', classes, promotedShare: share };
  return share >= PROMOTED_SHARE_GATE
    ? { verdict: 'semi-space', why: `old-generation reasons dominate, promoted ${(100 * share).toFixed(1)} % of new space`, classes, promotedShare: share }
    : { verdict: 'undecided', why: `old-generation reasons dominate, but promoted only ${(100 * share).toFixed(1)} % of new space`, classes, promotedShare: share };
}

/** Events grouped by isolate (`pid:isolate`, a thread in a trace); the main one first. */
export function groupIsolates(events) {
  const groups = new Map();
  for (const event of events) {
    const key = `${event.pid}:${event.isolate}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(event);
  }
  const score = (list) => [list.some((event) => event.threadName === 'CrRendererMain') ? 1 : 0,
    list.filter((event) => event.kind === 'minor').length];
  return [...groups].sort(([, left], [, right]) => {
    const [a0, a1] = score(left), [b0, b1] = score(right);
    return b0 - a0 || b1 - a1;
  }).map(([key, list]) => ({ key, events: list }));
}

/**
 * Freezes of a capture with the pauses inside them. `rows` are live-periods `frameRows`, `drops` its heap
 * drops; the offset puts the first major GC of `events` at the first drop's checkpoint.
 */
export function alignWithCapture(events, rows, drops, { freezeMs = FREEZE_MS, longPauseMs = LONG_PAUSE_MS } = {}) {
  const firstMajor = events.find((event) => event.kind === 'major');
  if (!firstMajor || !drops.length) return { offsetMs: null, freezes: [] };
  // The drop shows at the checkpoint after the collection; the collection lies in (fromAtMs, atMs].
  const offsetMs = drops[0].atMs - firstMajor.atMs;
  const long = events.filter((event) => (event.pauseMs ?? 0) >= longPauseMs);
  const freezes = rows.filter((row) => row.intervalMs !== null && row.intervalMs >= freezeMs).map((row) => {
    const end = row.rafAtMs ?? row.atMs;
    const begin = end - row.intervalMs;
    const pauses = long.filter((event) => event.atMs + offsetMs >= begin && event.atMs + offsetMs <= end)
      .map((event) => ({ collector: event.collector, pauseMs: event.pauseMs, reason: event.reason }));
    return { endMs: end, intervalMs: row.intervalMs, pauses };
  });
  return { offsetMs, freezes };
}

const fixed = (value, digits = 1) => value === null || value === undefined ? '—' : value.toFixed(digits);

/** The text report. */
export function formatReport(report) {
  const lines = [`input: ${report.input} (${report.source}), ${report.totalEvents} collections in ${report.isolates.length} isolates`];
  for (const [index, isolate] of report.isolates.entries()) {
    lines.push('', `${index === 0 ? 'main' : 'other'} isolate ${isolate.pid}:${isolate.isolate}${isolate.threadName ? ` (${isolate.threadName})` : ''}`
      + ` — ${isolate.events} collections over ${fixed(isolate.spanS)} s, heap ${fixed(isolate.heapFirstMB)} → ${fixed(isolate.heapLastMB)} MB`);
    lines.push('  type               count   pause sum   max     mean   freed MB  promoted MB  promoted/new space');
    for (const [name, row] of Object.entries(isolate.byCollector)) {
      lines.push(`  ${name.padEnd(17)} ${String(row.count).padStart(6)} ${fixed(row.pauseSumMs).padStart(10)} ${fixed(row.pauseMaxMs).padStart(6)}`
        + ` ${fixed(row.pauseMeanMs, 2).padStart(7)} ${fixed(row.freedMB).padStart(9)} ${fixed(row.promotedMB).padStart(11)}`
        + ` ${row.promotedShareOfNewSpace === null ? '—' : `${(100 * row.promotedShareOfNewSpace).toFixed(1)} %`}`.padStart(19));
      for (const [reason, count] of Object.entries(row.reasons).slice(0, 6)) lines.push(`      ${String(count).padStart(5)}  ${reason}`);
    }
    if (isolate.minor.newSpaceCapacityMaxMB !== null) lines.push(`  new space capacity, max: ${fixed(isolate.minor.newSpaceCapacityMaxMB)} MB`);
    if (index === 0) {
      lines.push('  10-s windows: from s  minor (pause ms)  major (pause ms)');
      for (const window of isolate.windows) {
        lines.push(`    ${String(window.fromS).padStart(6)}  ${String(window.minor).padStart(5)} (${fixed(window.minorPauseMs).padStart(6)})`
          + `  ${String(window.major).padStart(5)} (${fixed(window.majorPauseMs).padStart(6)})`);
      }
    }
    if (index >= 5) { lines.push(`  … ${report.isolates.length - index - 1} more isolates in --json`); break; }
  }
  const decision = report.decision;
  lines.push('', `decision (line-P P1-03b rules): ${decision.verdict} — ${decision.why}`,
    `  major reason classes: ${JSON.stringify(decision.classes)}`);
  if (report.alignment) {
    lines.push('', `capture alignment: offset ${fixed(report.alignment.offsetMs, 0)} ms; intervals ≥ ${FREEZE_MS} ms: ${report.alignment.freezes.length}`);
    for (const freeze of report.alignment.freezes) {
      lines.push(`  ${fixed(freeze.endMs, 0).padStart(8)} ms  ${fixed(freeze.intervalMs).padStart(6)} ms  `
        + (freeze.pauses.length ? freeze.pauses.map((pause) => `${pause.collector} ${fixed(pause.pauseMs)} ms`).join(', ') : 'no pause ≥ 20 ms'));
    }
  }
  return lines;
}

/** Report of parsed events: isolates (main first), the decision on the main isolate. */
export function analyzeGcEvents(events, { input = '(events)', source = 'log', windowMs = WINDOW_MS } = {}) {
  const groups = groupIsolates(events);
  const isolates = groups.map((group) => summarizeIsolate(group.events, { windowMs }));
  const mainMajors = groups[0]?.events.filter((event) => event.kind === 'major') ?? [];
  const decision = isolates.length ? gcDecision(isolates[0], mainMajors)
    : { verdict: 'undecided', why: 'no collections in the input', classes: {}, promotedShare: null };
  return { input, source, totalEvents: events.length, isolates, decision };
}

export function parseArgs(argv) {
  const options = { log: null, trace: null, json: null, capture: null };
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index].replace(/^--/, '');
    if (!(name in options) || !argv[index].startsWith('--')) throw new Error(`unknown argument ${argv[index]}`);
    const value = argv[++index];
    if (value === undefined || value.startsWith('--')) throw new Error(`--${name} needs a value`);
    options[name] = value;
  }
  if (Boolean(options.log) === Boolean(options.trace)) throw new Error('give exactly one of --log <file> or --trace <file>');
  return options;
}

const TRACE_LINE = /"name":"(?:V8\.GCTraceGCNVP|thread_name|MinorGC|MajorGC)"/;

/**
 * The GC-related events of a trace file without parsing the whole file: a bench trace of movement passes
 * 1 GB, above V8's string limit. Chrome writes one event per line; a file in another layout (a DevTools
 * export on one line) is parsed whole.
 */
export async function readTraceEvents(path) {
  const { createReadStream } = await import('node:fs');
  const { createInterface } = await import('node:readline');
  const events = [];
  let lines = 0;
  for await (const raw of createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity })) {
    lines++;
    if (!TRACE_LINE.test(raw)) continue;
    const line = raw.trim().replace(/,$/, '');
    if (!line.startsWith('{"') || line.startsWith('{"traceEvents"')) continue;
    try { events.push(JSON.parse(line)); } catch { /* not a whole event on this line */ }
  }
  if (lines < 3) return JSON.parse(await readFile(path, 'utf8'));
  return { traceEvents: events };
}

export async function main(argv) {
  const options = parseArgs(argv);
  const input = options.log ?? options.trace;
  const events = options.log ? parseGcLog(await readFile(input, 'utf8')) : parseGcTrace(await readTraceEvents(input));
  const report = analyzeGcEvents(events, { input, source: options.log ? 'log' : 'trace' });
  if (options.capture && events.length) {
    const { analyzeCapture, frameRows } = await import('./live-periods.mjs');
    const capture = JSON.parse(await readFile(options.capture, 'utf8'));
    const main = groupIsolates(events)[0].events;
    report.alignment = alignWithCapture(main, frameRows(capture), analyzeCapture(capture).heap?.drops ?? []);
  }
  for (const line of formatReport(report)) console.log(line);
  if (options.json) await writeFile(options.json, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
