// Freeze attribution for a live recording (O → «Записать фризы (60 с)», capture version 2).
//
//   node bench/analyze-live-profile.mjs <capture.json> [--maps dist/sourcemaps] [--threshold 50]
//        [--out report.json] [--top 12]
//
// Every long interval between two animation frames (default > 50 ms) becomes a window. For each
// window it lists what the JS Self-Profiling samples caught — functions by self and inclusive time,
// resolved through the build's source maps (dist/sourcemaps, written by `vite build`) — next to
// what the capture recorded there: game-frame sections, FrameXML steps, slow packets, long animation
// frame scripts and the JS heap. The same aggregation over all windows and over the rest of the
// recording separates the freezes from the ordinary frame cost.
//
// The input stays a local artifact; the report keeps function names, source files and numbers only.
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { createRequire } from 'node:module';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};
const input = args.find((arg, index) => !arg.startsWith('--') && !args[index - 1]?.startsWith('--'));
if (!input) {
  console.error('Usage: node bench/analyze-live-profile.mjs <capture.json> [--maps dist/sourcemaps] [--threshold 50] [--out report.json] [--top 12]');
  process.exit(2);
}
const mapDirectory = resolve(option('maps', 'dist/sourcemaps'));
// The shipped bundle itself, to turn a Long Animation Frame script's character offset into a line
// and column for the source map. Must be the same build as the maps.
const webDirectory = resolve(option('web', 'dist/web'));
const threshold = Number(option('threshold', '50'));
const top = Number(option('top', '12'));
const output = option('out', undefined);
if (!Number.isFinite(threshold) || threshold <= 0 || !Number.isInteger(top) || top < 1) throw new Error('Invalid --threshold/--top');

const capture = JSON.parse(await readFile(input, 'utf8'));
const events = capture.events ?? {};
const profile = capture.jsProfile && Array.isArray(capture.jsProfile.frames) ? capture.jsProfile : undefined;

// ---------------------------------------------------------------------------------------------
// Source maps: a frame is [minifiedName, resourceId, line, column] at its function's start.
let SourceMapConsumer;
try {
  ({ SourceMapConsumer } = createRequire(import.meta.url)('source-map-js'));
} catch { SourceMapConsumer = undefined; }
const mapFiles = new Map();
try {
  for (const entry of await readdir(mapDirectory, { recursive: true })) {
    const name = String(entry);
    if (name.endsWith('.map')) mapFiles.set(basename(name).slice(0, -'.map'.length), resolve(mapDirectory, name));
  }
} catch { /* No maps: positions stay minified and the report says so. */ }
const consumers = new Map();
async function consumerFor(file) {
  if (!SourceMapConsumer || !mapFiles.has(file)) return undefined;
  if (!consumers.has(file)) consumers.set(file, new SourceMapConsumer(JSON.parse(await readFile(mapFiles.get(file), 'utf8'))));
  return consumers.get(file);
}
const cleanSource = (source) => source.replace(/^(\.\.\/)+/, '').replace(/^\/?@fs\//, '').replace(/^webpack:\/\//, '');

// Character offsets of line starts per bundle file, for LoAF sourceCharPosition.
const lineStarts = new Map();
const bundleFiles = new Map();
try {
  for (const entry of await readdir(webDirectory, { recursive: true })) {
    const name = String(entry);
    if (name.endsWith('.js')) bundleFiles.set(basename(name), resolve(webDirectory, name));
  }
} catch { /* No bundle: LoAF entries keep their raw offsets. */ }
async function sourceAtCharacter(file, position) {
  if (!Number.isInteger(position) || position < 0 || !bundleFiles.has(file)) return undefined;
  let starts = lineStarts.get(file);
  if (!starts) {
    const text = await readFile(bundleFiles.get(file), 'utf8');
    starts = [0];
    for (let index = text.indexOf('\n'); index >= 0; index = text.indexOf('\n', index + 1)) starts.push(index + 1);
    lineStarts.set(file, starts);
  }
  let line = 0;
  while (line + 1 < starts.length && starts[line + 1] <= position) line++;
  const consumer = await consumerFor(file);
  const original = consumer?.originalPositionFor({ line: line + 1, column: position - starts[line] });
  return original?.source ? `${original.name ?? '?'} (${cleanSource(original.source)}:${original.line})` : undefined;
}

const frameLabels = [];
const frameFiles = [];
let resolvedFrames = 0;
if (profile) {
  for (const [name, resourceId, line, column] of profile.frames) {
    const file = resourceId >= 0 ? profile.resources[resourceId] : undefined;
    let label = name || '(anonymous)';
    let where = file ? `${file}:${line}:${column}` : '(native)';
    let source = file ?? '(native)';
    const consumer = file && line > 0 ? await consumerFor(file) : undefined;
    if (consumer) {
      const original = consumer.originalPositionFor({ line, column: Math.max(0, column - 1) });
      if (original?.source) {
        source = cleanSource(original.source);
        where = `${source}:${original.line}`;
        if (original.name && (!name || name.length <= 2)) label = original.name;
        resolvedFrames++;
      }
    }
    frameLabels.push(`${label} (${where})`);
    frameFiles.push(source);
  }
}

// Every stack as a leaf-first list of frame ids, memoised.
const stackFrames = new Map();
function framesOf(stackId) {
  if (stackId < 0 || !profile) return [];
  let cached = stackFrames.get(stackId);
  if (cached) return cached;
  cached = [];
  for (let id = stackId; id >= 0; id = profile.stacks[id]?.[1] ?? -1) cached.push(profile.stacks[id][0]);
  stackFrames.set(stackId, cached);
  return cached;
}

// Time per sample: the gap to the next sample, capped so a pause in sampling is not billed.
const samples = [];
if (profile) {
  const { atMs, stackId, marker } = profile.samples;
  const period = profile.sampleIntervalMs ?? 10;
  for (let index = 0; index < atMs.length; index++) {
    const next = atMs[index + 1];
    const weight = next === undefined ? period : Math.min(Math.max(0, next - atMs[index]), period * 2);
    samples.push({ at: atMs[index], stack: stackId[index], marker: marker?.[index] ?? null, weight });
  }
}

function aggregate(selected) {
  const self = new Map(), inclusive = new Map(), files = new Map(), markers = new Map(), chains = new Map();
  let total = 0, idle = 0;
  for (const sample of selected) {
    total += sample.weight;
    if (sample.marker) markers.set(sample.marker, (markers.get(sample.marker) ?? 0) + sample.weight);
    const frames = framesOf(sample.stack);
    if (frames.length === 0) { idle += sample.weight; continue; }
    self.set(frames[0], (self.get(frames[0]) ?? 0) + sample.weight);
    const seen = new Set();
    const seenFiles = new Set();
    for (const frame of frames) {
      if (!seen.has(frame)) { seen.add(frame); inclusive.set(frame, (inclusive.get(frame) ?? 0) + sample.weight); }
      const file = frameFiles[frame];
      if (!seenFiles.has(file)) { seenFiles.add(file); files.set(file, (files.get(file) ?? 0) + sample.weight); }
    }
    // Root → leaf, without repeats of the same function, trimmed to the interesting ends.
    const path = [...frames].reverse().filter((frame, index, list) => index === 0 || list[index - 1] !== frame);
    const key = (path.length > 8 ? [...path.slice(0, 3), -1, ...path.slice(-4)] : path).join('>');
    chains.set(key, (chains.get(key) ?? 0) + sample.weight);
  }
  const ranked = (map, label) => [...map].sort((left, right) => right[1] - left[1]).slice(0, top)
    .map(([key, ms]) => ({ ms: round(ms), share: total > 0 ? round(ms / total) : 0, what: label(key) }));
  return {
    sampledMs: round(total), idleMs: round(idle),
    markers: Object.fromEntries([...markers].map(([name, ms]) => [name, round(ms)])),
    self: ranked(self, (frame) => frameLabels[frame]),
    inclusive: ranked(inclusive, (frame) => frameLabels[frame]),
    files: ranked(files, (file) => file),
    stacks: ranked(chains, (key) => key.split('>').map((id) => id === '-1' ? '…' : frameLabels[Number(id)]).join('  →  ')).slice(0, 4),
  };
}

function round(value) { return Math.round(value * 100) / 100; }

// ---------------------------------------------------------------------------------------------
// Windows: the gap before every long animation frame, merged when they touch.
const columns = capture.frameColumns ?? [];
const rafAt = columns.indexOf('rafAtMs'), intervalAt = columns.indexOf('intervalMs'), cpuAt = columns.indexOf('cpuMs');
const windows = [];
for (const row of capture.frames ?? []) {
  const interval = row[intervalAt];
  if (!(typeof interval === 'number' && interval > threshold)) continue;
  const to = row[rafAt], from = to - interval;
  const last = windows.at(-1);
  if (last && from <= last.to) { last.to = Math.max(last.to, to); last.intervals.push(round(interval)); }
  else windows.push({ from, to, intervals: [round(interval)] });
}
const inside = (at, window) => at > window.from && at <= window.to;
const around = (at, window, slack = 0) => at >= window.from - slack && at <= window.to + slack;

function eventsIn(kind, window, slack = 0) {
  return (events[kind] ?? []).filter((event) => around(event.atMs, window, slack));
}

function heapAround(window) {
  const checkpoints = (events.checkpoints ?? []).filter((checkpoint) => checkpoint.heap);
  const before = checkpoints.filter((checkpoint) => checkpoint.atMs <= window.from).at(-1);
  const after = checkpoints.find((checkpoint) => checkpoint.atMs >= window.to);
  if (!before || !after) return undefined;
  return { beforeMB: before.heap.usedMB, afterMB: after.heap.usedMB, deltaMB: round(after.heap.usedMB - before.heap.usedMB) };
}

const windowReports = await Promise.all(windows.map(async (window) => {
  const selected = samples.filter((sample) => inside(sample.at, window));
  const frameRows = (capture.frames ?? []).filter((row) => around(row[rafAt], window));
  return {
    fromMs: round(window.from), toMs: round(window.to), spanMs: round(window.to - window.from),
    intervalsMs: window.intervals,
    gameFrameCpuMs: frameRows.map((row) => round(row[cpuAt] ?? 0)),
    gameSections: eventsIn('cpuSections', window, 5).map((event) => ({ cpuMs: round(event.cpuMs), sections: roundAll(event.sections), detail: event.detail })),
    frameXmlSteps: eventsIn('frameXmlSteps', window, 5).map(roundAll),
    frameXmlSyncs: eventsIn('frameXmlSyncs', window, 5).map(roundAll),
    slowPackets: eventsIn('slowPackets', window, 5).map(roundAll),
    longAnimationFrames: await Promise.all(eventsIn('longAnimationFrames', window, 20).map(async (frame) => ({
      atMs: round(frame.atMs), durationMs: round(frame.durationMs), blockingMs: round(frame.blockingDurationMs ?? 0),
      scripts: await Promise.all((frame.scripts ?? []).slice(0, 6).map(async (script) => {
        const source = await sourceAtCharacter(script.file, script.charPosition);
        const where = source ?? `${script.file}${script.charPosition === undefined ? '' : `:${script.charPosition}`}`;
        return `${round(script.durationMs)} ms ${script.invokerType ?? ''} ${script.invoker ?? ''} ${script.function ?? ''} @${where}`
          .replace(/\s+/g, ' ').trim();
      })),
    }))),
    shaderPrograms: eventsIn('shaderPrograms', window, 5).length,
    resourcesCompleted: (events.resources ?? []).filter((resource) => around(resource.completedAtMs, window)).length,
    heap: heapAround(window),
    profile: profile ? aggregate(selected) : undefined,
  };
}));

function roundAll(value) {
  if (typeof value === 'number') return round(value);
  if (Array.isArray(value)) return value.map(roundAll);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, roundAll(item)]));
  return value;
}

const inAnyWindow = (sample) => windows.some((window) => inside(sample.at, window));
const report = {
  source: basename(input), recordedAt: capture.recordedAt, version: capture.version,
  browser: capture.browser, viewport: capture.viewport, frameXmlMounted: capture.frameXmlMounted,
  entrySupport: capture.entrySupport, thresholdMs: threshold,
  profile: profile ? {
    sampleIntervalMs: profile.sampleIntervalMs, bufferFull: profile.bufferFull, samples: samples.length,
    frames: profile.frames.length, framesResolvedBySourceMap: resolvedFrames,
    sourceMaps: mapFiles.size > 0 ? mapDirectory : 'none found — run vite build, keep dist/sourcemaps of the build that recorded',
    markersPresent: Boolean(profile.samples.marker),
  } : `no jsProfile (${capture.entrySupport?.jsProfiler ?? 'capture version ' + capture.version})`,
  summary: {
    frames: capture.summary, longWindows: windows.length,
    longWindowMs: round(windows.reduce((sum, window) => sum + window.to - window.from, 0)),
  },
  packets: capture.packets ? { byOpcode: capture.packets.byOpcode?.slice(0, top), busiestSeconds: [...(capture.packets.perSecond ?? [])].sort((l, r) => r.ms - l.ms).slice(0, 5) } : undefined,
  frameXml: capture.frameXml,
  freezes: profile ? aggregate(samples.filter(inAnyWindow)) : undefined,
  ordinary: profile ? aggregate(samples.filter((sample) => !inAnyWindow(sample))) : undefined,
  windows: windowReports,
};

if (output) await writeFile(output, JSON.stringify(report, null, 2));

// ---------------------------------------------------------------------------------------------
const print = (title, rows) => {
  console.log(title);
  for (const row of rows ?? []) console.log(`  ${String(row.ms).padStart(8)} ms ${String(Math.round(row.share * 100)).padStart(3)}%  ${row.what}`);
};
console.log(`${report.source}: ${capture.summary?.intervals?.count ?? '?'} frames, ${windows.length} windows over ${threshold} ms (${report.summary.longWindowMs} ms in total)`);
console.log(typeof report.profile === 'string' ? report.profile : `profile: ${report.profile.samples} samples at ${report.profile.sampleIntervalMs} ms, ${report.profile.framesResolvedBySourceMap}/${report.profile.frames} frames resolved (${report.profile.sourceMaps})${report.profile.bufferFull ? ', BUFFER FULL' : ''}`);
if (report.freezes) {
  print('\nFreeze windows, self time:', report.freezes.self);
  print('\nFreeze windows, inclusive:', report.freezes.inclusive);
  print('\nFreeze windows, by source file:', report.freezes.files);
  print('\nOrdinary frames, self time:', report.ordinary.self);
}
for (const window of windowReports.toSorted((left, right) => right.spanMs - left.spanMs).slice(0, 8)) {
  console.log(`\n— ${window.fromMs}…${window.toMs} ms (${window.spanMs} ms; intervals ${window.intervalsMs.join(', ')}; game cpu ${window.gameFrameCpuMs.join('/')})`);
  for (const section of window.gameSections.slice(0, 2)) console.log(`  game frame ${section.cpuMs} ms: ${Object.entries(section.sections).filter(([, ms]) => ms >= 2).map(([name, ms]) => `${name} ${ms}`).join(', ')}${section.detail ? ` · ${section.detail}` : ''}`);
  for (const step of window.frameXmlSteps.slice(0, 2)) console.log(`  FrameXML step ${step.stepMs} ms (seam ${step.seamTickMs}, OnUpdate ${step.onUpdateMs}, sync ${step.syncInStepMs})`);
  for (const packet of window.slowPackets.slice(0, 3)) console.log(`  packet 0x${Number(packet.opcode).toString(16)} ${packet.bytes} B ${packet.ms} ms`);
  if (window.heap) console.log(`  heap ${window.heap.beforeMB} → ${window.heap.afterMB} MB`);
  if (window.profile) for (const row of window.profile.self.slice(0, 5)) console.log(`  ${String(row.ms).padStart(7)} ms  ${row.what}`);
  if (window.profile?.markers && Object.keys(window.profile.markers).length) console.log(`  markers ${JSON.stringify(window.profile.markers)}`);
}
if (output) console.log(`\nreport: ${output}`);
