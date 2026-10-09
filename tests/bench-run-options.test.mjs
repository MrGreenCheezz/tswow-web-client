import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HEAP_PROFILE_MODES, heapProfileFileName, heapProfileSamplingOptions, parseHeapProfileMode,
} from '../bench/run-options.mjs';

// P1-03a: `--heap-profile=promoted` samples only what outlived the young generation.

test('--heap-profile parses to all, promoted or nothing, and never passes silently', () => {
  assert.deepEqual(HEAP_PROFILE_MODES, ['all', 'promoted']);
  assert.equal(parseHeapProfileMode(['--scenario', 'city']), null);
  assert.equal(parseHeapProfileMode([]), null);
  assert.equal(parseHeapProfileMode(['--heap-profile']), 'all');
  assert.equal(parseHeapProfileMode(['--scenario', 'city', '--heap-profile', '--label', 'x']), 'all');
  assert.equal(parseHeapProfileMode(['--heap-profile=all']), 'all');
  assert.equal(parseHeapProfileMode(['--heap-profile=promoted', '--scenario', 'movement']), 'promoted');
  assert.throws(() => parseHeapProfileMode(['--heap-profile=bogus']), /all or promoted/);
  assert.throws(() => parseHeapProfileMode(['--heap-profile=']), /all or promoted/);
  assert.throws(() => parseHeapProfileMode(['--heap-profile', 'promoted']), /--heap-profile=promoted/);
  assert.throws(() => parseHeapProfileMode(['--heap-profile', '--heap-profile=promoted']), /twice/);
});

test('the sampler keeps minor-GC garbage only in mode all', () => {
  assert.deepEqual(heapProfileSamplingOptions('all'),
    { samplingInterval: 16384, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  assert.deepEqual(heapProfileSamplingOptions('promoted'),
    { samplingInterval: 16384, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: false });
  assert.throws(() => heapProfileSamplingOptions('bogus'), /heap-profile mode/);
  assert.throws(() => heapProfileSamplingOptions(null), /heap-profile mode/);
});

test('profile files keep the old name for all and add .promoted otherwise', () => {
  assert.equal(heapProfileFileName('city', 'all'), 'city.heapprofile');
  assert.equal(heapProfileFileName('world-crowd-64', 'promoted'), 'world-crowd-64.promoted.heapprofile');
  assert.throws(() => heapProfileFileName('city', 'bogus'), /heap-profile mode/);
});

test('bench/run.mjs takes the mode, the sampler options and the file name from run-options', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../bench/run.mjs', import.meta.url), 'utf8');
  assert.match(source, /const heapProfileMode = parseHeapProfileMode\(args\)/);
  assert.match(source, /HeapProfiler\.startSampling', heapProfileSamplingOptions\(heapProfileMode\)\)/);
  assert.match(source, /heapProfileFileName\(scenario, heapProfileMode\)/);
  assert.doesNotMatch(source, /args\.includes\('--heap-profile'\)/, '--heap-profile=promoted would be missed');
  assert.match(source, /captureAbba, heapProfileMode, config/, 'the result records the mode');
});
