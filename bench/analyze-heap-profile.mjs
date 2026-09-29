// Where a bench run's garbage comes from: `bench/run.mjs --heap-profile` writes
// `<scenario>.heapprofile` (CDP HeapProfiler sampling over the measured seconds); this sums the
// sampled bytes by allocating function, resolved through the bench bundle's source map.
//
//   node bench/analyze-heap-profile.mjs <file.heapprofile> [--map bench/build/harness.js.map] [--top 30]
//
// Sampled bytes include objects that died young: it is allocation volume, not retained size.
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const args = process.argv.slice(2);
const option = (name, fallback) => { const at = args.indexOf(`--${name}`); return at >= 0 ? args[at + 1] : fallback; };
const input = args.find((arg, index) => !arg.startsWith('--') && !args[index - 1]?.startsWith('--'));
if (!input) throw new Error('Usage: node bench/analyze-heap-profile.mjs <file.heapprofile> [--map bench/build/harness.js.map] [--top 30]');
const top = Number(option('top', '30'));
const profile = JSON.parse(await readFile(input, 'utf8'));
const { SourceMapConsumer } = createRequire(import.meta.url)('source-map-js');
const mapPath = option('map', 'bench/build/harness.js.map');
let consumer;
try { consumer = new SourceMapConsumer(JSON.parse(await readFile(mapPath, 'utf8'))); } catch { consumer = undefined; }

const label = (frame) => {
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
const mb = (bytes) => (bytes / 1048576).toFixed(1).padStart(8);
const share = (bytes) => `${(100 * bytes / total).toFixed(1).padStart(5)}%`;
console.log(`${mb(total)} MB sampled`);
console.log('\nSelf:');
for (const [name, bytes] of [...self].sort((a, b) => b[1] - a[1]).slice(0, top)) console.log(`${mb(bytes)} MB ${share(bytes)}  ${name}`);
console.log('\nInclusive (our code):');
for (const [name, bytes] of [...inclusive].filter(([name]) => / src\//.test(name)).sort((a, b) => b[1] - a[1]).slice(0, top)) {
  console.log(`${mb(bytes)} MB ${share(bytes)}  ${name}`);
}
