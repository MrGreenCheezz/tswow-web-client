import { build } from 'esbuild';
import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

// esbuild preserves the production new URL(...worker.ts, import.meta.url). Serve that URL as
// compiled JavaScript; both entries belong to one metafile so worker code is fingerprinted too.
export const BENCHMARK_SCRIPT_FILES = Object.freeze({
  '/harness.js': 'harness.js',
  '/harness.js.map': 'harness.js.map',
  '/WvaAnimationDecode.worker.ts': 'WvaAnimationDecode.worker.js',
  '/WvaAnimationDecode.worker.js.map': 'WvaAnimationDecode.worker.js.map',
  '/EnvironmentTileDecode.worker.ts': 'EnvironmentTileDecode.worker.js',
  '/EnvironmentTileDecode.worker.js.map': 'EnvironmentTileDecode.worker.js.map',
  '/PoseEngine.worker.ts': 'PoseEngine.worker.js',
  '/PoseEngine.worker.js.map': 'PoseEngine.worker.js.map',
});

/**
 * A/B development builds: a file under `variantDir` with the same path relative to `src/`
 * replaces the working-tree source in the bundle. Nothing is copied into the working tree.
 */
function variantPlugin(variantDir) {
  const source = resolve('src');
  const used = new Set();
  return {
    used,
    plugin: {
      name: 'benchmark-variant',
      setup(buildApi) {
        // A variant may also add a module the working tree does not have (e.g. a rejected step's
        // new file): a relative import that finds nothing under src/ resolves to its src/ path and
        // is loaded from the variant below.
        buildApi.onResolve({ filter: /^\.\.?\// }, (args) => {
          if (!args.resolveDir) return undefined;
          const target = resolve(args.resolveDir, args.path).replace(/\.js$/, '.ts');
          const path = relative(source, target);
          if (path.startsWith('..') || existsSync(target) || !target.endsWith('.ts')) return undefined;
          return existsSync(resolve(variantDir, path)) ? { path: target } : undefined;
        });
        buildApi.onLoad({ filter: /\.ts$/ }, (args) => {
          const path = relative(source, args.path);
          if (path.startsWith('..')) return undefined;
          const replacement = resolve(variantDir, path);
          if (!existsSync(replacement)) return undefined;
          used.add(replacement);
          return { contents: readFileSync(replacement, 'utf8'), loader: 'ts', resolveDir: resolve(source, path, '..') };
        });
      },
    },
  };
}

/**
 * `options.target`: the esbuild target, 'es2022' by default — the level of the production build since
 * MEM-1 (vite.config.mjs BUILD_TARGET), so the benchmark runs code of the same form as the game. Another
 * target (bench/run.mjs `--target modules`: the pre-MEM-1 production form) is an A/B side, never a baseline.
 * The resolved options are returned as `result.bundleOptions`.
 */
export async function buildBenchmarkBundle(outdir = 'bench/build', variantDir = undefined, options = {}) {
  const variant = variantDir ? variantPlugin(variantDir) : undefined;
  const bundleOptions = { target: options.target ?? 'es2022' };
  const result = await build({
    plugins: variant ? [variant.plugin] : [],
    entryPoints: {
      harness: 'src/browser/bench/Harness.ts',
      'WvaAnimationDecode.worker': 'src/browser/WvaAnimationDecode.worker.ts',
      'EnvironmentTileDecode.worker': 'src/browser/EnvironmentTileDecode.worker.ts',
      'PoseEngine.worker': 'src/browser/PoseEngine.worker.ts',
    },
    outdir, bundle: true, format: 'esm', platform: 'browser', target: bundleOptions.target,
    // The harness entry (bench-only) awaits at top level, which esbuild refuses below es2022 although
    // the benchmark's Chrome runs it; game code has none (the pre-MEM-1 production build had this
    // target), so allowing it changes nothing in how the game's classes are lowered.
    ...(bundleOptions.target === 'es2022' ? {} : { supported: { 'top-level-await': true } }),
    minify: false, sourcemap: true, metafile: true, keepNames: true,
  });
  result.variantFiles = variant ? [...variant.used].sort() : [];
  result.bundleOptions = bundleOptions;
  return result;
}
