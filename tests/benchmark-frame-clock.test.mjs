import assert from 'node:assert/strict';
import test from 'node:test';
import { nextBenchmarkFrame } from '../dist/code/browser/bench/FrameClock.js';

test('benchmark waits through repeated RAF callbacks before rendering the next interval', async () => {
  const timestamps = [100, 100, 116.7, 150];
  const read = async () => timestamps.shift();
  assert.deepEqual(await nextBenchmarkFrame(100, read), { timestamp:116.7, repeatedCallbacks:2 });
  assert.deepEqual(await nextBenchmarkFrame(116.7, read), { timestamp:150, repeatedCallbacks:0 });
});

test('benchmark preserves long frame intervals without smoothing', async () => {
  assert.deepEqual(await nextBenchmarkFrame(100, async()=>1000), { timestamp:1000, repeatedCallbacks:0 });
});

test('invalid and backwards timestamps fail instead of being filtered', async () => {
  for (const timestamp of [99, NaN, Infinity, -Infinity]) {
    await assert.rejects(nextBenchmarkFrame(100, async()=>timestamp), /invalid or moved backwards/);
  }
});
