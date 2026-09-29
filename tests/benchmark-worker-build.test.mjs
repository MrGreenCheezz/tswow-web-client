import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { buildBenchmarkBundle, BENCHMARK_SCRIPT_FILES } from '../bench/build.mjs';

test('benchmark builds and fingerprints the worker served at the production URL', async () => {
  const out = await mkdtemp(join(tmpdir(), 'webclient-worker-bench-'));
  try {
    const result = await buildBenchmarkBundle(out);
    const main = await readFile(join(out, 'harness.js'), 'utf8');
    for (const [entry, decoder, dependency] of [
      ['WvaAnimationDecode.worker.ts', /decodeWvaAnimations/, 'src/browser/Wvm.ts'],
      ['EnvironmentTileDecode.worker.ts', /decodeEnvironmentTile/, 'src/browser/EnvironmentTileDecode.ts'],
    ]) {
      assert.match(main, new RegExp(`new URL\\("\\./${entry.replaceAll('.', '\\.')}"\\, import\\.meta\\.url\\)`),
        `exercise the production URL for ${entry}`);
      const artifact = BENCHMARK_SCRIPT_FILES[`/${entry}`];
      assert.ok(artifact, 'the runner must serve the emitted URL');
      const worker = await readFile(join(out, artifact), 'utf8');
      assert.match(worker, /postMessage\(/);
      assert.match(worker, decoder);
      const output = Object.values(result.metafile.outputs).find(value => value.entryPoint === `src/browser/${entry}`);
      assert.ok(output);
      assert.ok(output.inputs[dependency], 'real decoder, not an empty worker stub');
      for (const input of Object.keys(output.inputs)) assert.ok(result.metafile.inputs[input]);
    }
  } finally {
    const target = resolve(out);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith('webclient-worker-bench-'));
    await rm(target, {recursive:true,force:true});
  }
});
