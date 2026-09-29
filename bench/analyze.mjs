/** Read-only analysis of a completed benchmark, Chrome trace and sampled CPU profile. */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { distribution } from './metrics.mjs';

const file = process.argv[2];
if (!file) throw new Error('Usage: node bench/analyze.mjs bench/results/<timestamp>.json');
const result = JSON.parse(await readFile(file, 'utf8'));
const report = { input: file, trace: result.trace, sourceHash: result.sourceHash, scenarios: [] };
for (const scenario of result.scenarios) {
  const index = name => scenario.columns.indexOf(name);
  const rowInfo = (row, n) => ({ frame: n, atMs: row[index('rafAtMs')], intervalMs: row[index('intervalMs')],
    cpuMs: row[index('cpuMs')], phases: Object.fromEntries(scenario.phaseNames.map(name => [name, row[index(name)]])),
    allocations: n === 0 ? null : Object.fromEntries(['programs', 'geometries', 'textures'].map(name =>
      [name, row[index(name)] - scenario.frames[n - 1][index(name)]])) });
  const longFrames = scenario.frames.flatMap((row, n) => row[index('intervalMs')] > 30
    ? [{ interval: rowInfo(row, n), precedingWork: n ? rowInfo(scenario.frames[n - 1], n - 1) : null }] : []);
  const entry = { scenario: scenario.scenario, summary: scenario.summary, longFrames,
    slowestCpu: scenario.frames.map(rowInfo).sort((a, b) => b.cpuMs - a.cpuMs).slice(0, 20) };
  const profileFile = resolve(result.artifacts, `${scenario.scenario}.cpuprofile`);
  const profile = await readFile(profileFile, 'utf8').then(JSON.parse).catch(error => {
    if (error.code === 'ENOENT') return null; throw error;
  });
  if (profile) {
    const nodes = new Map(profile.nodes.map(node => [node.id, node]));
    const parents = new Map();
    for (const node of profile.nodes) for (const child of node.children ?? []) parents.set(child, node.id);
    const self = new Map(), inclusive = new Map();
    const keyOf = node => `${node.callFrame.functionName || '(anonymous)'} @ ${node.callFrame.url.split('/').at(-1)}:${node.callFrame.lineNumber + 1}`;
    let totalUs = 0;
    for (let i = 0; i < profile.samples.length; i++) {
      const weight = profile.timeDeltas[i] ?? 0;
      totalUs += weight;
      let id = profile.samples[i];
      const node = nodes.get(id);
      if (!node) continue;
      const key = keyOf(node);
      self.set(key, (self.get(key) ?? 0) + weight);
      const seen = new Set();
      while (id !== undefined) {
        const current = nodes.get(id);
        if (!current) break;
        const currentKey = keyOf(current);
        if (!seen.has(currentKey)) inclusive.set(currentKey, (inclusive.get(currentKey) ?? 0) + weight);
        seen.add(currentKey); id = parents.get(id);
      }
    }
    const ranked = map => [...map].sort((a, b) => b[1] - a[1]).slice(0, 35)
      .map(([functionName, us]) => ({ functionName, milliseconds: us / 1000, percentOfProfile: us * 100 / totalUs }));
    entry.profile = { totalMs: totalUs / 1000, topSelf: ranked(self), topInclusive: ranked(inclusive) };
  }
  const traceFile = resolve(result.artifacts, `${scenario.scenario}.trace.json`);
  const trace = await readFile(traceFile, 'utf8').then(JSON.parse).catch(error => {
    if (error.code === 'ENOENT') return null; throw error;
  });
  if (trace) {
    const events = trace.traceEvents;
    const start = events.find(e => e.name === 'bench-start');
    const end = events.find(e => e.name === 'bench-end');
    if (!start || !end) throw new Error('Trace measurement markers missing');
    const measured = events.filter(e => e.ts >= start.ts && e.ts <= end.ts);
    const durations = new Map();
    for (const e of measured) {
      if (e.pid !== start.pid || e.tid !== start.tid || e.ph !== 'X' || !e.dur) continue;
      if (!durations.has(e.name)) durations.set(e.name, []);
      durations.get(e.name).push(e.dur / 1000);
    }
    entry.timeline = {
      startUs: start.ts, endUs: end.ts, pid: start.pid, tid: start.tid,
      mainThreadEvents: [...durations].map(([name, times]) => ({ name, totalMs: times.reduce((a, b) => a + b, 0), ...distribution(times) }))
        .sort((a, b) => b.totalMs - a.totalMs),
      longestTasks: measured.filter(e => e.pid === start.pid && e.tid === start.tid && e.ph === 'X' && e.dur > 20000)
        .sort((a, b) => b.dur - a.dur).slice(0, 40).map(e => ({ name: e.name, atMs: (e.ts - start.ts) / 1000,
          durationMs: e.dur / 1000, args: e.args })),
    };
  }
  report.scenarios.push(entry);
}
const output = join(resolve(result.artifacts), 'analysis.json');
await writeFile(output, JSON.stringify(report, null, 2));
for (const s of report.scenarios) {
  console.log(JSON.stringify({ scenario: s.scenario, slowestCpu: s.slowestCpu.slice(0, 5),
    profile: s.profile?.topSelf.slice(0, 15), inclusive: s.profile?.topInclusive.slice(0, 14),
    events: s.timeline?.mainThreadEvents.filter(e => /GC|[Cc]ompile|[Ss]hader|[Pp]rogram|RunTask/.test(e.name)).slice(0, 15) }, null, 2));
}
console.log(`Analysis: ${output}`);
