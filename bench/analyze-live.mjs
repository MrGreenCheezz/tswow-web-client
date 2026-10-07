import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { createHash } from 'node:crypto';

// Read a capture as data. Keep player state, settings unrelated to graphics, URLs and
// free-form strings out of the saved report; the input JSON remains a local artifact.
const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('Usage: node bench/analyze-live.mjs <capture.json> <report.json>');
const bytes = await readFile(input);
const capture = JSON.parse(bytes);
const { frames, frameColumns, events } = capture;
const index = name => {
  const value = frameColumns.indexOf(name);
  if (value < 0) throw new Error(`Missing frame column: ${name}`);
  return value;
};
const cpu = index('cpuMs'), interval = index('intervalMs'), at = index('callbackStartMs');
const distribution = values => {
  const sorted = values.filter(value => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b);
  const percentile = p => sorted[Math.ceil(sorted.length * p) - 1] ?? null;
  return { count: sorted.length, mean: sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null,
    p50: percentile(.5), p95: percentile(.95), p99: percentile(.99), max: sorted.at(-1) ?? null };
};
const timing = rows => {
  const intervals = rows.map(row => row[interval]).filter(value => Number.isFinite(value) && value > 0);
  const slowest = intervals.toSorted((a, b) => b - a).slice(0, Math.max(1, Math.ceil(intervals.length * .01)));
  return { frameCount: rows.length, fps: 1000 / distribution(intervals).mean,
    onePercentLowFps: 1000 / distribution(slowest).mean,
    framesOver30Ms: intervals.filter(value => value > 30).length,
    cpuMs: distribution(rows.map(row => row[cpu])), intervalMs: distribution(intervals) };
};
const checkpoints = events.checkpoints;
const submissions = checkpoints.map(checkpoint => checkpoint.renderer.worldSubmission).filter(Boolean);
const parts = ['matrices', 'mainSkeletons', 'mainDraws', 'shadowSkeletons', 'shadowDraws', 'shadowOther', 'other'];
const drawKinds = ['mainSkinned', 'mainNonSkinned', 'shadowSkinned', 'shadowNonSkinned'];
const counters = ['mainDraws', 'shadowDraws', 'mainSkinnedDraws', 'shadowSkinnedDraws', 'skeletonUpdates', 'bonesUpdated',
  'mainMaterialSwitches', 'mainProgramSwitches'];
const rendererCounts = ['drawCalls', 'triangles', 'unitsDrawn', 'unitsDropped', 'gameObjectsDrawn',
  'effectsDrawn', 'groundCoverDrawn', 'textureCount', 'geometryCount'];
const animationLodCounts = ['near', 'medium', 'far', 'critical', 'full', 'flat', 'skipped'];
const windows = Array.from({ length: Math.ceil(capture.durationMs / 10000) }, (_, i) =>
  ({ fromMs: i * 10000, toMs: Math.min((i + 1) * 10000, capture.durationMs) }));
const inWindow = (atMs, window) => atMs >= window.fromMs && atMs < window.toMs;
const sections = events.cpuSections;
const sectionNames = ['render', 'render.submit.world', 'render.units.pose', 'render.env', 'render.visuals',
  'render.units.appearance', 'render.warm', 'render.submit.sky', 'render.submit.postprocess', 'portraits', 'ui', 'state', 'state.flush', 'state.motions', 'state.visuals', 'state.view', 'scene'];
const sum = values => values.reduce((a, b) => a + b, 0);
const report = {
  sourceCapture: basename(input), sha256: createHash('sha256').update(bytes).digest('hex'),
  recordedAt: capture.recordedAt, durationMs: capture.durationMs, viewport: capture.viewport,
  graphics: Object.fromEntries(['renderScale', 'autoQuality', 'lightingQuality', 'grassRadius', 'grassDensity',
    'godRays', 'fullscreenGlow', 'fantasyGlow'].map(key => [key, capture.settings[key]])),
  comparableToPreviousCapture: false,
  caveats: [
    'Different viewport and scene draw counts from the prior capture: no causal before/after FPS claim.',
    'CPU sections retain the slowest 240 callbacks; their phase means are not all-frame averages.',
    'World submission samples approximately every 500 ms include instrumentation and synchronous driver waits.',
    'GPU values summarize delayed rolling checkpoint medians, not paired GPU timings for the sampled CPU frames.',
    'A skinned draw may belong to a unit, a world model or a spell; the capture does not identify its owner.',
  ],
  allFrames: timing(frames),
  timeline: windows.map(window => ({ ...window,
    ...timing(frames.filter(row => inWindow(row[at], window))) })).filter(slice => slice.frameCount > 0),
  // Match the frame windows, but keep sampled world submission separate from all-frame CPU.
  // This makes a moving-camera slowdown distinguishable from a growing resource population.
  checkpointTimeline: windows.map(window => {
    const samples = checkpoints.filter(checkpoint => inWindow(checkpoint.atMs, window));
    const world = samples.map(checkpoint => checkpoint.renderer.worldSubmission).filter(Boolean);
    return { ...window, samples: samples.length,
      renderer: Object.fromEntries(rendererCounts.map(key =>
        [key, distribution(samples.map(checkpoint => checkpoint.renderer[key]))])),
      animationLod: Object.fromEntries(animationLodCounts.map(key =>
        [key, distribution(samples.map(checkpoint => checkpoint.renderer.animationLod?.[key]))])),
      worldSubmission: { samples: world.length,
        totalMs: distribution(world.map(sample => sample.totalMs)),
        partsMs: Object.fromEntries(parts.map(key =>
          [key, distribution(world.map(sample => sample.partsMs[key]))])),
        drawKindsMs: Object.fromEntries(drawKinds.map(key =>
          [key, distribution(world.map(sample => sample.drawKindsMs?.[key]))])),
        calls: Object.fromEntries(counters.map(key =>
          [key, distribution(world.map(sample => sample.calls[key]))])) },
      gpuRollingMedianMs: distribution(samples.map(checkpoint => checkpoint.renderer.gpu.p50)),
      terrainResident: distribution(samples.map(checkpoint => checkpoint.terrain?.resident)),
      warmupQueued: distribution(samples.map(checkpoint => checkpoint.warmup?.queued)),
      resourcesCompleted: events.resources.filter(resource => inWindow(resource.completedAtMs, window)).length,
      newShaderEvents: events.shaderPrograms.filter(event => event.phase !== 'existing' && inWindow(event.atMs, window)).length,
    };
  }).filter(slice => slice.samples > 0),
  checkpointCounts: Object.fromEntries(rendererCounts
    .map(key => [key, distribution(checkpoints.map(checkpoint => checkpoint.renderer[key]))])),
  checkpointAnimationLod: Object.fromEntries(animationLodCounts
    .map(key => [key, distribution(checkpoints.map(checkpoint => checkpoint.renderer.animationLod?.[key]))])),
  gpuRollingMedianMs: distribution(checkpoints.map(checkpoint => checkpoint.renderer.gpu.p50)),
  // P1-20a: every frame's state pieces, averaged per half-second checkpoint (older captures: absent).
  checkpointSectionsMs: Object.fromEntries(['state.flush', 'state.motions', 'state.visuals', 'state.view']
    .map(key => [key, distribution(checkpoints.map(checkpoint => checkpoint.sections?.[key]))])),
  worldSubmission: {
    samples: submissions.length, totalMs: distribution(submissions.map(sample => sample.totalMs)),
    partsMs: Object.fromEntries(parts.map(key => [key, distribution(submissions.map(sample => sample.partsMs[key]))])),
    drawKindsMs: Object.fromEntries(drawKinds.map(key =>
      [key, distribution(submissions.map(sample => sample.drawKindsMs?.[key]))])),
    calls: Object.fromEntries(counters.map(key => [key, distribution(submissions.map(sample => sample.calls[key]))])),
    hookSetupRestoreMs: distribution(submissions.map(sample => sample.hookSetupRestoreMs)),
    failed: submissions.filter(sample => sample.failed).length,
    maxSumErrorMs: Math.max(0, ...submissions.map(sample => Math.abs(sample.totalMs - sum(Object.values(sample.partsMs))))),
  },
  selectedSlowCallbacks: { count: sections.length,
    partsMs: Object.fromEntries(sectionNames.map(key => [key, distribution(sections.map(section => section.sections[key] ?? 0))])) },
  newShaderEvents: events.shaderPrograms.filter(event => event.phase !== 'existing')
    .map(event => ({ atMs: event.atMs, phase: event.phase, added: event.added, omitted: event.omitted })),
  longAnimationFrames: { count: events.longAnimationFrames.length,
    durationMs: distribution(events.longAnimationFrames.map(event => event.durationMs)),
    forcedLayoutMs: distribution(events.longAnimationFrames.map(event => sum(event.scripts.map(script => script.forcedStyleAndLayoutMs ?? 0)))) },
  resources: { count: events.resources.length },
  droppedEvents: capture.droppedEvents,
};
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ output, fps: report.allFrames.fps, onePercentLowFps: report.allFrames.onePercentLowFps,
  p99Ms: report.allFrames.intervalMs.p99, framesOver30Ms: report.allFrames.framesOver30Ms,
  worldMs: report.worldSubmission.totalMs.mean,
  partsMs: Object.fromEntries(Object.entries(report.worldSubmission.partsMs).map(([key, value]) => [key, value.mean])),
  drawKindsMs: Object.fromEntries(Object.entries(report.worldSubmission.drawKindsMs).map(([key, value]) => [key, value.mean])),
  timeline: report.timeline.map(({ fromMs, fps, cpuMs }) => ({ fromMs, fps, cpuMs: cpuMs.mean })),
  checkpointTimeline: report.checkpointTimeline.map(({ fromMs, renderer, animationLod, worldSubmission, gpuRollingMedianMs,
    terrainResident, resourcesCompleted, newShaderEvents }) => ({
    fromMs, units: renderer.unitsDrawn.mean, droppedUnits: renderer.unitsDropped.mean,
    animationLod: Object.fromEntries(animationLodCounts.map(key => [key, animationLod[key].mean])),
    effects: renderer.effectsDrawn.mean, draws: renderer.drawCalls.mean,
    textures: renderer.textureCount.mean, geometries: renderer.geometryCount.mean,
    worldMs: worldSubmission.totalMs.mean, matricesMs: worldSubmission.partsMs.matrices.mean,
    mainDrawsMs: worldSubmission.partsMs.mainDraws.mean,
    drawKindsMs: Object.fromEntries(drawKinds.map(key => [key, worldSubmission.drawKindsMs[key].mean])),
    skeletonUpdates: worldSubmission.calls.skeletonUpdates.mean,
    bonesUpdated: worldSubmission.calls.bonesUpdated.mean,
    gpuRollingMedianMs: gpuRollingMedianMs.mean, terrainResident: terrainResident.mean,
    resourcesCompleted, newShaderEvents,
  })) }, null, 2));
