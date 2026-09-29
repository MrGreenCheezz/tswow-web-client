import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { buildBenchmarkBundle } from '../bench/build.mjs';
import { parseBundleOptions, resolveBenchmarkTarget, VITE_MODULES_TARGET } from '../bench/run-options.mjs';

// What `vite build` used before MEM-1 (Vite 6.4.3 `modules`): `--target modules` rebuilds that form.
const PREVIOUS_PRODUCTION_TARGET = ['es2020', 'edge88', 'firefox78', 'chrome87', 'safari14'];

test('--target resolves to es2022 by default, the old production list, or a checked list', () => {
  assert.equal(resolveBenchmarkTarget(undefined), 'es2022');
  assert.equal(resolveBenchmarkTarget('es2022'), 'es2022');
  assert.deepEqual(resolveBenchmarkTarget('modules'), PREVIOUS_PRODUCTION_TARGET);
  assert.deepEqual(VITE_MODULES_TARGET, PREVIOUS_PRODUCTION_TARGET);
  assert.equal(Object.isFrozen(VITE_MODULES_TARGET), true);
  assert.notEqual(resolveBenchmarkTarget('modules'), VITE_MODULES_TARGET, 'a copy, not the frozen constant');
  assert.deepEqual(resolveBenchmarkTarget('es2020'), ['es2020']);
  assert.deepEqual(resolveBenchmarkTarget('es2020, chrome87,safari14.1'), ['es2020', 'chrome87', 'safari14.1']);
  assert.deepEqual(resolveBenchmarkTarget('esnext'), ['esnext']);
  for (const bad of ['', 'es20', 'ie11', 'chrome', 'es2020,,chrome87', 'modules,es2020', 'es2022;rm']) {
    assert.throws(() => resolveBenchmarkTarget(bad), /--target/, bad);
  }
});

test('bundle options come from the command line and never pass silently', () => {
  assert.deepEqual(parseBundleOptions(['--scenario', 'city', '--label', 'x']), { target: 'es2022' });
  assert.deepEqual(parseBundleOptions(['--target', 'modules']), { target: PREVIOUS_PRODUCTION_TARGET });
  assert.deepEqual(parseBundleOptions(['--target=es2020,chrome87']), { target: ['es2020', 'chrome87'] });
  assert.throws(() => parseBundleOptions(['--target']), /--target/);
  assert.throws(() => parseBundleOptions(['--target', '--smoke']), /--target/);
  assert.throws(() => parseBundleOptions(['--target', 'es2022', '--target', 'modules']), /--target/);
});

async function jsOutputs(directory) {
  const texts = {};
  for (const name of await readdir(directory)) if (name.endsWith('.js')) texts[name] = await readFile(join(directory, name), 'utf8');
  return texts;
}

test('the benchmark bundle keeps native class members by default and lowers them for --target modules', async () => {
  const native = await mkdtemp(join(tmpdir(), 'webclient-bench-target-'));
  const lowered = await mkdtemp(join(tmpdir(), 'webclient-bench-target-'));
  try {
    const defaults = await buildBenchmarkBundle(native);
    assert.deepEqual(defaults.bundleOptions, { target: 'es2022' });
    for (const [name, text] of Object.entries(await jsOutputs(native))) {
      for (const helper of ['__privateGet', '__privateAdd', '__publicField']) assert.equal(text.includes(helper), false, `${name}: ${helper}`);
    }
    const modules = await buildBenchmarkBundle(lowered, undefined, { target: resolveBenchmarkTarget('modules') });
    assert.deepEqual(modules.bundleOptions, { target: PREVIOUS_PRODUCTION_TARGET });
    const outputs = await jsOutputs(lowered);
    assert.match(outputs['harness.js'], /__privateGet\(/);
    assert.match(outputs['harness.js'], /__publicField\(/);
    assert.match(outputs['PoseEngine.worker.js'], /__publicField\(/, 'workers take the same target');
  } finally {
    for (const directory of [native, lowered]) {
      const target = resolve(directory);
      assert.equal(dirname(target), resolve(tmpdir()));
      assert.ok(basename(target).startsWith('webclient-bench-target-'));
      await rm(target, { recursive: true, force: true });
    }
  }
});
