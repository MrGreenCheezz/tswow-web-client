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

/** Bundle options for bench/build.mjs from bench/run.mjs arguments: `{ target }`. */
export function parseBundleOptions(args) {
  return { target: resolveBenchmarkTarget(optionValue(args, '--target')) };
}
