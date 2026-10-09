import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { transform } from 'esbuild';
import { benchmarkEnvDefine, buildBenchmarkBundle } from '../bench/build.mjs';
import {
  DEFAULT_BENCHMARK_ENV, DEFAULT_BENCHMARK_NAMES, parseBundleOptions, resolveBenchmarkEnv, resolveBenchmarkNames,
  resolveBenchmarkTarget, VITE_MODULES_TARGET,
} from '../bench/run-options.mjs';

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
  assert.deepEqual(parseBundleOptions(['--scenario', 'city', '--label', 'x']), { target: 'es2022', env: 'prod', names: 'plain' });
  assert.deepEqual(parseBundleOptions(['--target', 'modules']), { target: PREVIOUS_PRODUCTION_TARGET, env: 'prod', names: 'plain' });
  assert.deepEqual(parseBundleOptions(['--target=es2020,chrome87']), { target: ['es2020', 'chrome87'], env: 'prod', names: 'plain' });
  assert.throws(() => parseBundleOptions(['--target']), /--target/);
  assert.throws(() => parseBundleOptions(['--target', '--smoke']), /--target/);
  assert.throws(() => parseBundleOptions(['--target', 'es2022', '--target', 'modules']), /--target/);
});

test('--bench-env is prod by default, dev on request, and nothing else (P1-02a)', () => {
  assert.equal(DEFAULT_BENCHMARK_ENV, 'prod');
  assert.equal(resolveBenchmarkEnv(undefined), 'prod');
  assert.equal(resolveBenchmarkEnv('prod'), 'prod');
  assert.equal(resolveBenchmarkEnv('dev'), 'dev');
  for (const bad of ['', 'production', 'DEV', 'development']) assert.throws(() => resolveBenchmarkEnv(bad), /--bench-env/, bad);
  assert.deepEqual(parseBundleOptions(['--bench-env', 'dev']), { target: 'es2022', env: 'dev', names: 'plain' });
  assert.deepEqual(parseBundleOptions(['--bench-env=prod', '--target', 'modules']), { target: PREVIOUS_PRODUCTION_TARGET, env: 'prod', names: 'plain' });
  assert.throws(() => parseBundleOptions(['--bench-env']), /--bench-env/);
  assert.throws(() => parseBundleOptions(['--bench-env', 'dev', '--bench-env', 'prod']), /--bench-env/);
  assert.throws(() => benchmarkEnvDefine('test'), /prod or dev/);
});

/**
 * The game's own `rendererDebugShaderErrors` (cut from WorldRenderer3D.ts), compiled by esbuild with the
 * bench env's `define` and run: what `renderer.debug.checkShaderErrors` becomes in the benchmark.
 */
async function shaderChecksUnder(env) {
  const source = await readFile(new URL('../src/browser/WorldRenderer3D.ts', import.meta.url), 'utf8');
  const body = /export function rendererDebugShaderErrors\(\): boolean \{[\s\S]*?\n\}/.exec(source);
  assert.ok(body, 'rendererDebugShaderErrors is in WorldRenderer3D.ts');
  const { code } = await transform(body[0], { loader: 'ts', format: 'esm', target: 'es2022', define: benchmarkEnvDefine(env) });
  const module = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
  return module.rendererDebugShaderErrors();
}

test('the production env turns three shader checks off in the bench bundle; dev keeps them (P1-02a)', async () => {
  assert.deepEqual(benchmarkEnvDefine('dev'), {});
  assert.deepEqual(JSON.parse(benchmarkEnvDefine('prod')['import.meta.env']),
    { BASE_URL: '/', MODE: 'production', DEV: false, PROD: true, SSR: false });
  assert.equal(await shaderChecksUnder('prod'), false);
  assert.equal(await shaderChecksUnder('dev'), true);
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
    assert.deepEqual(defaults.bundleOptions, { target: 'es2022', env: 'prod', names: 'plain' });
    const nativeOutputs = await jsOutputs(native);
    for (const [name, text] of Object.entries(nativeOutputs)) {
      for (const helper of ['__privateGet', '__privateAdd', '__publicField']) assert.equal(text.includes(helper), false, `${name}: ${helper}`);
    }
    // P1-02a: the default bundle carries the production env in place of import.meta.env.
    assert.match(nativeOutputs['harness.js'], /define_import_meta_env_default = \{[^}]*DEV: false/);
    // (esbuild leaves only its own `// <define:import.meta.env>` comment.)
    assert.doesNotMatch(nativeOutputs['harness.js'], /(?<!define:)import\.meta\.env/);
    const modules = await buildBenchmarkBundle(lowered, undefined, { target: resolveBenchmarkTarget('modules'), env: 'dev' });
    assert.deepEqual(modules.bundleOptions, { target: PREVIOUS_PRODUCTION_TARGET, env: 'dev', names: 'plain' });
    const outputs = await jsOutputs(lowered);
    assert.match(outputs['harness.js'], /__privateGet\(/);
    assert.match(outputs['harness.js'], /__publicField\(/);
    assert.match(outputs['PoseEngine.worker.js'], /__publicField\(/, 'workers take the same target');
    // --bench-env dev is the bundle before P1-02a: the env is left to the browser (undefined there).
    assert.doesNotMatch(outputs['harness.js'], /define_import_meta_env_default/);
    assert.match(outputs['harness.js'], /import\.meta\.env/);
  } finally {
    for (const directory of [native, lowered]) {
      const target = resolve(directory);
      assert.equal(dirname(target), resolve(tmpdir()));
      assert.ok(basename(target).startsWith('webclient-bench-target-'));
      await rm(target, { recursive: true, force: true });
    }
  }
});

test('--bench-names is plain by default (no __name wrappers, as production), keep on request', () => {
  assert.equal(DEFAULT_BENCHMARK_NAMES, 'plain');
  assert.equal(resolveBenchmarkNames(undefined), 'plain');
  assert.equal(resolveBenchmarkNames('keep'), 'keep');
  for (const bad of ['', 'KEEP', 'names', 'true']) assert.throws(() => resolveBenchmarkNames(bad), /--bench-names/, bad);
  assert.deepEqual(parseBundleOptions(['--bench-names', 'keep']), { target: 'es2022', env: 'prod', names: 'keep' });
  assert.throws(() => parseBundleOptions(['--bench-names', 'keep', '--bench-names', 'plain']), /--bench-names/);
});
