// Where a bench run's garbage comes from: `bench/run.mjs --heap-profile` writes
// `<scenario>.heapprofile` (CDP HeapProfiler sampling over the measured seconds); this sums the
// sampled bytes by allocating function, resolved through the bench bundle's source map.
//
//   node bench/analyze-heap-profile.mjs <file.heapprofile> [--map bench/build/harness.js.map] [--top 30]
//     [--per-frame] [--vs <scenario.heapprofile>]
//
// `<scenario>.heapprofile` (mode `all`) holds every sampled allocation, including objects that died
// young: it is allocation volume, not retained size. `<scenario>.promoted.heapprofile`
// (`--heap-profile=promoted`, P1-03a) holds only what outlived minor GCs (promoted to the old
// generation, or still alive at stop): what feeds the old generation and full GCs.
//   --per-frame  divides by the run's measured frames and seconds, read from the neighbouring result
//                `bench/results/<label>.json` (`scenarios[].summary.frameCount`, `measuredSeconds`).
//   --vs <all>   adds the survivor share of each function: bytes here / bytes in the `all` profile.
//                Two runs sample independently, so a share above 1 is sampling noise, not an error.
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 'promoted' for `*.promoted.heapprofile`, 'all' for any other `*.heapprofile`. */
export function heapProfileModeOfFile(path) {
  return /\.promoted\.heapprofile$/i.test(basename(path)) ? 'promoted' : 'all';
}

/** The scenario a profile belongs to: its file name without `.promoted` and `.heapprofile`. */
export function scenarioOfHeapProfile(path) {
  return basename(path).replace(/\.heapprofile$/i, '').replace(/\.promoted$/i, '');
}

/** The result beside a profile: `<dir>/<label>/<scenario>.heapprofile` → `<dir>/<label>.json`. */
export function resultPathOfHeapProfile(path) {
  const folder = dirname(resolve(path));
  return join(dirname(folder), `${basename(folder)}.json`);
}

/** `{ frameCount, measuredSeconds }` of the profile's scenario in a bench result; throws when it is missing. */
export function measuredSpan(result, scenario) {
  const entry = result.scenarios?.find((candidate) => candidate.scenario === scenario);
  const summary = entry?.summary;
  if (!summary || !(summary.frameCount > 0) || !(summary.measuredSeconds > 0)) {
    throw new Error(`the result has no measured frames for scenario ${JSON.stringify(scenario)}`);
  }
  return { frameCount: summary.frameCount, measuredSeconds: summary.measuredSeconds };
}

/** Self and inclusive bytes by function label over a profile's call tree; `label(callFrame)` names a node. */
export function summarizeHeapProfile(profile, label) {
  const self = new Map();
  const inclusive = new Map();
  let total = 0;
  const walk = (node, path) => {
    const name = label(node.callFrame);
    const here = [...path, name];
    total += node.selfSize;
    if (node.selfSize > 0) {
      self.set(name, (self.get(name) ?? 0) + node.selfSize);
      for (const entry of new Set(here)) inclusive.set(entry, (inclusive.get(entry) ?? 0) + node.selfSize);
    }
    for (const child of node.children ?? []) walk(child, here);
  };
  walk(profile.head, []);
  return { total, self, inclusive };
}

/** Survivor share of each function in `promoted`: its bytes / its bytes in `all` (null when `all` has none). */
export function survivorShares(promoted, all) {
  return new Map([...promoted].map(([name, bytes]) => [name, all.get(name) ? bytes / all.get(name) : null]));
}

/** A call-frame labeller; with a source-map consumer the bench bundle's frames name their source line. */
export function frameLabeller(consumer) {
  return (frame) => {
    const file = frame.url.split('/').pop().split('?')[0];
    if (consumer && file === 'harness.js' && frame.lineNumber >= 0) {
      const original = consumer.originalPositionFor({ line: frame.lineNumber + 1, column: frame.columnNumber });
      if (original?.source) {
        const source = original.source.replace(/^(\.\.\/)+/, '').replace(/^node_modules\/three\/build\//, 'three/');
        return `${frame.functionName || original.name || '(anonymous)'} ${source}:${original.line}`;
      }
    }
    return `${frame.functionName || '(anonymous)'} ${file || '(native)'}${frame.lineNumber >= 0 ? `:${frame.lineNumber + 1}` : ''}`;
  };
}

/** The report as lines (the command prints them). */
export function heapProfileReport({ path, summary, top = 30, span = null, versus = null }) {
  const mode = heapProfileModeOfFile(path);
  const { total, self, inclusive } = summary;
  const word = mode === 'promoted' ? 'promoted' : 'sampled';
  const lines = [];
  const mb = (bytes) => (bytes / 1048576).toFixed(1).padStart(8);
  const share = (bytes) => `${(total ? 100 * bytes / total : 0).toFixed(1).padStart(5)}%`;
  const rate = (bytes) => span
    ? ` ${(bytes / 1024 / span.frameCount).toFixed(2).padStart(8)} KB/frame ${(bytes / 1048576 / span.measuredSeconds).toFixed(2).padStart(7)} MB/s`
    : '';
  const survived = (name) => {
    if (!versus) return '';
    const value = versus.shares.get(name);
    return value === null || value === undefined ? '     n/a' : ` ${(100 * value).toFixed(1).padStart(6)}%`;
  };
  lines.push(`${mb(total)} MB ${word}${rate(total)}`);
  if (span) lines.push(`${span.frameCount} frames, ${span.measuredSeconds.toFixed(2)} s measured`);
  if (versus) {
    lines.push(`${mb(versus.total)} MB sampled in ${basename(versus.path)}; survivor share ${(100 * total / versus.total).toFixed(1)}%`);
  }
  lines.push(`\nSelf:${versus ? '  (last column: survivor share vs all)' : ''}`);
  for (const [name, bytes] of [...self].sort((a, b) => b[1] - a[1]).slice(0, top)) {
    lines.push(`${mb(bytes)} MB ${share(bytes)}${rate(bytes)}${survived(name)}  ${name}`);
  }
  lines.push('\nInclusive (our code):');
  for (const [name, bytes] of [...inclusive].filter(([name]) => / src\//.test(name)).sort((a, b) => b[1] - a[1]).slice(0, top)) {
    lines.push(`${mb(bytes)} MB ${share(bytes)}${rate(bytes)}  ${name}`);
  }
  return lines;
}

async function main(args) {
  const option = (name, fallback) => { const at = args.indexOf(`--${name}`); return at >= 0 ? args[at + 1] : fallback; };
  const valued = new Set(['--map', '--top', '--vs']);
  const input = args.find((arg, index) => !arg.startsWith('--') && !valued.has(args[index - 1]));
  if (!input) {
    throw new Error('Usage: node bench/analyze-heap-profile.mjs <file.heapprofile> [--map bench/build/harness.js.map] [--top 30] [--per-frame] [--vs <all.heapprofile>]');
  }
  const top = Number(option('top', '30'));
  const { SourceMapConsumer } = createRequire(import.meta.url)('source-map-js');
  let consumer;
  try { consumer = new SourceMapConsumer(JSON.parse(await readFile(option('map', 'bench/build/harness.js.map'), 'utf8'))); } catch { consumer = undefined; }
  const label = frameLabeller(consumer);
  const summary = summarizeHeapProfile(JSON.parse(await readFile(input, 'utf8')), label);
  let span = null;
  if (args.includes('--per-frame')) {
    span = measuredSpan(JSON.parse(await readFile(resultPathOfHeapProfile(input), 'utf8')), scenarioOfHeapProfile(input));
  }
  let versus = null;
  const vsPath = option('vs');
  if (vsPath) {
    const all = summarizeHeapProfile(JSON.parse(await readFile(vsPath, 'utf8')), label);
    versus = { path: vsPath, total: all.total, shares: survivorShares(summary.self, all.self) };
  }
  for (const line of heapProfileReport({ path: input, summary, top, span, versus })) console.log(line);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
