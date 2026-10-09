// Command-line options of bench/run.mjs that decide how the benchmark bundle is built. Pure functions
// in their own module: bench/run.mjs runs its benchmark when imported, so tests cannot import it.

/** Vite 6.4.3's `modules` target — what the production build used before MEM-1 (vite.config.mjs CSS_TARGET). */
export const VITE_MODULES_TARGET = Object.freeze(['es2020', 'edge88', 'firefox78', 'chrome87', 'safari14']);

/** The level the benchmark always built and production builds since MEM-1 (vite.config.mjs BUILD_TARGET). */
export const DEFAULT_BENCHMARK_TARGET = 'es2022';

const TARGET_ENTRY = /^(es\d{4}|esnext|(chrome|edge|firefox|safari|ios|node)\d+(\.\d+)?)$/;

/**
 * `--target` value → esbuild target: none or `es2022` → 'es2022'; `modules` → the old production list
 * (a copy); otherwise a comma-separated list of esbuild targets, each checked, as an array.
 */
export function resolveBenchmarkTarget(value) {
  if (value === undefined || value === DEFAULT_BENCHMARK_TARGET) return DEFAULT_BENCHMARK_TARGET;
  if (value === 'modules') return [...VITE_MODULES_TARGET];
  const entries = String(value).split(',').map((entry) => entry.trim());
  const invalid = entries.filter((entry) => !TARGET_ENTRY.test(entry));
  if (invalid.length) {
    throw new Error(`--target expects es2022, modules or a list like es2020,chrome87; invalid: ${invalid.map((entry) => JSON.stringify(entry)).join(', ')}`);
  }
  return entries;
}

/** The value of `--name <value>` or `--name=<value>`; a missing or repeated option throws instead of passing silently. */
function optionValue(args, name) {
  let found;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    let value;
    if (arg === name) {
      value = args[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`);
      index++;
    } else if (arg.startsWith(`${name}=`)) value = arg.slice(name.length + 1);
    else continue;
    if (found !== undefined) throw new Error(`${name} is given twice`);
    found = value;
  }
  return found;
}

/** The bench env the game runs with (P1-02a): `import.meta.env` is the production Vite env. */
export const DEFAULT_BENCHMARK_ENV = 'prod';

/** `--bench-env` value → 'prod' (none or `prod`) or 'dev' (the bundle before P1-02a); anything else throws. */
export function resolveBenchmarkEnv(value) {
  if (value === undefined || value === DEFAULT_BENCHMARK_ENV) return DEFAULT_BENCHMARK_ENV;
  if (value === 'dev') return 'dev';
  throw new Error(`--bench-env expects prod or dev, not ${JSON.stringify(value)}`);
}

/**
 * 09.10: how the bench bundle names functions. `plain` (default) — as the production build: no
 * esbuild `keepNames`, so no `__name(...)` wrapper (an `Object.defineProperty`) on every closure the
 * game creates; with `minify: false` the names are kept anyway. `keep` — the former bundle, for
 * comparisons with results taken before 09.10; such a run is not valid.
 */
export const DEFAULT_BENCHMARK_NAMES = 'plain';

/** `--bench-names` value → 'plain' (none or `plain`) or 'keep'; anything else throws. */
export function resolveBenchmarkNames(value) {
  if (value === undefined || value === DEFAULT_BENCHMARK_NAMES) return DEFAULT_BENCHMARK_NAMES;
  if (value === 'keep') return 'keep';
  throw new Error(`--bench-names expects plain or keep, not ${JSON.stringify(value)}`);
}

/** Bundle options for bench/build.mjs from bench/run.mjs arguments: `{ target, env, names }`. */
export function parseBundleOptions(args) {
  return {
    target: resolveBenchmarkTarget(optionValue(args, '--target')),
    env: resolveBenchmarkEnv(optionValue(args, '--bench-env')),
    names: resolveBenchmarkNames(optionValue(args, '--bench-names')),
  };
}

/** Heap-profile modes (P1-03a): `all` samples every allocation, `promoted` only what survived minor GCs. */
export const HEAP_PROFILE_MODES = Object.freeze(['all', 'promoted']);

/**
 * `--heap-profile` → 'all'; `--heap-profile=all|promoted` → that mode; absent → null. An unknown mode,
 * a separate value (`--heap-profile promoted`, which would pass as a scenario-less flag) or a repeat throws.
 */
export function parseHeapProfileMode(args) {
  let mode = null;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg !== '--heap-profile' && !arg.startsWith('--heap-profile=')) continue;
    if (mode !== null) throw new Error('--heap-profile is given twice');
    if (arg === '--heap-profile') {
      const next = args[index + 1];
      if (next !== undefined && HEAP_PROFILE_MODES.includes(next)) {
        throw new Error(`--heap-profile takes its mode after "=": --heap-profile=${next}`);
      }
      mode = 'all';
      continue;
    }
    const value = arg.slice('--heap-profile='.length);
    if (!HEAP_PROFILE_MODES.includes(value)) {
      throw new Error(`--heap-profile expects all or promoted, not ${JSON.stringify(value)}`);
    }
    mode = value;
  }
  return mode;
}

/**
 * CDP `HeapProfiler.startSampling` parameters for a mode. Without the include flags the profile holds
 * only objects alive at stop; the major flag adds those a full GC freed, the minor flag those a
 * scavenge freed. `promoted` leaves the minor flag off: what outlived the young generation (plus what
 * is still young at stop) — the input of "what feeds the old generation".
 */
export function heapProfileSamplingOptions(mode) {
  if (!HEAP_PROFILE_MODES.includes(mode)) throw new Error(`unknown heap-profile mode ${JSON.stringify(mode)}`);
  return { samplingInterval: 16384, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: mode === 'all' };
}

/** `<scenario>.heapprofile` for `all` (the name before P1-03a), `<scenario>.promoted.heapprofile` for `promoted`. */
export function heapProfileFileName(scenario, mode) {
  if (!HEAP_PROFILE_MODES.includes(mode)) throw new Error(`unknown heap-profile mode ${JSON.stringify(mode)}`);
  return mode === 'all' ? `${scenario}.heapprofile` : `${scenario}.${mode}.heapprofile`;
}
