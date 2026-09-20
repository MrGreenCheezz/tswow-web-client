import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize } from './metrics.mjs';

test('FPS uses elapsed frame intervals; 1% low uses the slowest percent, strict >30ms', () => {
  const columns = ['intervalMs', 'cpuMs', 'calls', 'triangles', 'programs', 'geometries', 'textures', 'heapBytes'];
  const frames = Array.from({ length: 200 }, () => [10, 2, 1, 2, 3, 4, 5, 100]);
  frames[198][0] = 30;
  frames[199][0] = 50;
  const result = summarize({ columns, frames, phaseNames: [], gpuSamplesMs: [] });
  assert.ok(Math.abs(result.averageFps - 200000 / 2060) < 1e-10);
  assert.equal(result.onePercentLowFps, 25);
  assert.equal(result.p99FrameMs, 10);
  assert.equal(result.framesOver30Ms, 1);
  assert.equal(result.gpuMs.mean, null);
});

test('invalid/missing intervals cannot silently produce passing metrics', () => {
  assert.throws(() => summarize({ columns: ['intervalMs'], frames: [[0]] }));
  assert.throws(() => summarize({ columns: ['intervalMs'], frames: [] }));
});
