export function distribution(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return { count: 0, mean: null, p50: null, p99: null, max: null };
  const sum = sorted.reduce((a, b) => a + b, 0);
  return { count: sorted.length, mean: sum / sorted.length,
    p50: sorted[Math.ceil(sorted.length * .5) - 1],
    p99: sorted[Math.ceil(sorted.length * .99) - 1], max: sorted.at(-1) };
}

/**
 * P1-12: the rest-radius tables over the measured frames — the renderer's cumulative
 * `telemetry.wmoRange` at the end minus the harness's `wmoRangeAtStart`, distance (`groups`) and
 * open-air tables together. `recomputesPerFrame` is per measured frame (all placements summed).
 * Null when the harness had no world renderer or predates the counters.
 */
export function wmoRangeSummary(result) {
  const end = result.telemetry?.wmoRange;
  const start = result.wmoRangeAtStart;
  const frames = result.frames?.length ?? 0;
  if (!end || !start || !frames) return null;
  const delta = key => (end.groups[key] - start.groups[key]) + (end.openAir[key] - start.openAir[key]);
  const selects = delta('selects');
  const recomputes = delta('recomputes');
  return { selects, recomputes, recomputesPerFrame: recomputes / frames,
    groups: { selects: end.groups.selects - start.groups.selects, recomputes: end.groups.recomputes - start.groups.recomputes },
    openAir: { selects: end.openAir.selects - start.openAir.selects, recomputes: end.openAir.recomputes - start.openAir.recomputes } };
}

export function summarize(result) {
  const column = name => result.frames.map(row => row[result.columns.indexOf(name)]);
  const intervals = column('intervalMs');
  if (!intervals.length || intervals.some(x => !Number.isFinite(x) || x <= 0)) {
    throw new Error('Benchmark contains invalid frame intervals');
  }
  const slow = [...intervals].sort((a, b) => b - a).slice(0, Math.max(1, Math.ceil(intervals.length * .01)));
  const timing = distribution(intervals);
  return {
    averageFps: 1000 / timing.mean,
    onePercentLowFps: 1000 / distribution(slow).mean,
    p99FrameMs: timing.p99,
    framesOver30Ms: intervals.filter(x => x > 30).length,
    frameCount: intervals.length,
    measuredSeconds: intervals.reduce((a, b) => a + b, 0) / 1000,
    frameMs: timing,
    cpuMs: distribution(column('cpuMs')),
    gpuMs: distribution(result.gpuSamplesMs),
    rendererInfo: Object.fromEntries(['calls', 'triangles', 'programs', 'geometries', 'textures']
      .map(name => [name, distribution(column(name))])),
    peakJsHeapBytes: Math.max(...column('heapBytes')) || null,
    phasesMs: Object.fromEntries(result.phaseNames.map(name => [name, distribution(column(name))])),
  };
}
