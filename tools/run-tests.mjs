// One entry point for running tests with the limits the 2026-09-28 memory incident taught
// (docs/implementation/stage-0.ru.md, item 0.3): named files run one at a time, the whole suite at
// most four at a time, every test process capped at a 4 GB JS heap and watched by
// tools/test-memory-guard.mjs, the whole run bounded by a total timeout. The suite is the explicit
// list tests/*.test.mjs: Node's default discovery would also pick up the rejected experiments kept
// under .runtime/.
//
//   node tools/run-tests.mjs [--source|--dist] [options] [tests/<file>.test.mjs ...]
//
//   --source             test current TypeScript through tools/register-test-sources.mjs (default)
//   --dist               test the built dist/code instead (what `npm test` does after its build)
//   --concurrency=N      files in parallel; default 1 for named files, 4 for the whole suite
//   --timeout=MS         per-test timeout, default 240000
//   --heap-mb=N          --max-old-space-size of every test process, default 4096
//   --rss-limit-mb=N     resident memory at which the guard terminates a test process, default 6144
//   --total-timeout-min=N  stop the whole run (its own process tree only) after N minutes, default 40
//   --test-name-pattern=…, --test-skip-pattern=…, --test-reporter=…  passed through to node --test
//   --dry-run            print the command and environment without running
//
// The source hook needs module.registerHooks (Node 22.15+). A Node without it re-runs this script
// with the bundled .runtime/node/node.exe when that exists.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import module from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const DEFAULTS = Object.freeze({
  timeoutMs: 240_000,
  heapMb: 4096,
  rssLimitMb: 6144,
  totalTimeoutMin: 40,
  fileConcurrency: 1,
  suiteConcurrency: 4,
});

const PASSTHROUGH = ["--test-name-pattern=", "--test-skip-pattern=", "--test-reporter=", "--test-reporter-destination="];

function positiveInt(arg, value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${arg}: expected a positive integer, got "${value}"`);
  return number;
}

export function parseArgs(argv) {
  const options = {
    mode: "source",
    files: [],
    concurrency: null,
    timeoutMs: DEFAULTS.timeoutMs,
    heapMb: DEFAULTS.heapMb,
    rssLimitMb: DEFAULTS.rssLimitMb,
    totalTimeoutMin: DEFAULTS.totalTimeoutMin,
    passthrough: [],
    dryRun: false,
  };
  for (const arg of argv) {
    const [name, value] = arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, ""];
    if (arg === "--source") options.mode = "source";
    else if (arg === "--dist") options.mode = "dist";
    else if (arg === "--dry-run") options.dryRun = true;
    else if (name === "--concurrency") options.concurrency = positiveInt(name, value);
    else if (name === "--timeout") options.timeoutMs = positiveInt(name, value);
    else if (name === "--heap-mb") options.heapMb = positiveInt(name, value);
    else if (name === "--rss-limit-mb") options.rssLimitMb = positiveInt(name, value);
    else if (name === "--total-timeout-min") options.totalTimeoutMin = positiveInt(name, value);
    else if (PASSTHROUGH.some((prefix) => arg.startsWith(prefix))) options.passthrough.push(arg);
    else if (arg.startsWith("-")) throw new Error(`unknown option ${arg}`);
    else options.files.push(arg);
  }
  options.concurrency ??= options.files.length > 0 ? DEFAULTS.fileConcurrency : DEFAULTS.suiteConcurrency;
  return options;
}

/** Adds the heap cap and the memory guard to NODE_OPTIONS, keeping whatever the caller set. */
export function withNodeOptions(existing, { heapMb, guardUrl }) {
  const parts = (existing ?? "").split(/\s+/).filter(Boolean);
  if (!parts.some((part) => part.startsWith("--max-old-space-size"))) parts.push(`--max-old-space-size=${heapMb}`);
  if (guardUrl && !parts.includes(`--import=${guardUrl}`)) parts.push(`--import=${guardUrl}`);
  return parts.join(" ");
}

/** The whole suite: tests/*.test.mjs, sorted, as paths relative to the repository root. */
export function suiteFiles(testsDirectory = join(root, "tests")) {
  return readdirSync(testsDirectory)
    .filter((name) => name.endsWith(".test.mjs") && statSync(join(testsDirectory, name)).isFile())
    .sort()
    .map((name) => relative(root, join(testsDirectory, name)).split(sep).join("/"));
}

/** Resolves named files against the working directory and returns them relative to the root. */
export function resolveFiles(files, cwd = process.cwd()) {
  return files.map((file) => {
    const absolute = isAbsolute(file) ? file : resolve(cwd, file);
    if (!existsSync(absolute) || !statSync(absolute).isFile()) throw new Error(`no such test file: ${file}`);
    return relative(root, absolute).split(sep).join("/");
  });
}

export function testArgs(options, files) {
  const args = [];
  if (options.mode === "source") args.push("--import", "./tools/register-test-sources.mjs");
  args.push("--test", `--test-concurrency=${options.concurrency}`, `--test-timeout=${options.timeoutMs}`);
  args.push(...options.passthrough, ...files);
  return args;
}

/** True when this Node cannot run the requested mode: the source hook needs registerHooks. */
export function needsNewerNode(version, hasRegisterHooks, mode) {
  const major = Number(version.replace(/^v/, "").split(".")[0]);
  return major < 22 || (mode === "source" && !hasRegisterHooks);
}

/** Summarises the guard's JSON lines: process count, the largest peak, terminated processes. */
export function summarizeMemory(text) {
  const records = text.split("\n").filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  const byPeak = [...records].sort((a, b) => b.peakMb - a.peakMb);
  return {
    processes: records.length,
    peak: byPeak[0] ?? null,
    top: byPeak.slice(0, 5),
    killed: records.filter((record) => record.killed),
  };
}

function labelOf(record) {
  return record.label.startsWith(root) ? relative(root, record.label).split(sep).join("/") : record.label;
}

function killTree(pid) {
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
  else try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch {} }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (needsNewerNode(process.versions.node, typeof module.registerHooks === "function", options.mode)) {
    const bundled = join(root, ".runtime", "node", process.platform === "win32" ? "node.exe" : "node");
    if (existsSync(bundled) && resolve(process.execPath).toLowerCase() !== bundled.toLowerCase()) {
      console.error(`run-tests: Node ${process.version} cannot run these tests; using ${relative(root, bundled)}`);
      const rerun = spawnSync(bundled, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: "inherit" });
      process.exit(rerun.status ?? 1);
    }
    throw new Error(`Node ${process.version} cannot run the ${options.mode} tests: Node 22.15+ is required`);
  }

  const files = options.files.length > 0 ? resolveFiles(options.files) : suiteFiles();
  const guardUrl = pathToFileURL(join(root, "tools", "test-memory-guard.mjs")).href;
  const reportDirectory = mkdtempSync(join(tmpdir(), "webclient-tests-"));
  const report = join(reportDirectory, "memory.jsonl");
  const env = {
    ...process.env,
    NODE_OPTIONS: withNodeOptions(process.env.NODE_OPTIONS, { heapMb: options.heapMb, guardUrl }),
    WEBCLIENT_TEST_RSS_LIMIT_MB: String(options.rssLimitMb),
    WEBCLIENT_TEST_MEMORY_REPORT: report,
  };
  const args = testArgs(options, files);
  console.error(`run-tests: Node ${process.version}, ${options.mode}, ${files.length} file(s), concurrency `
    + `${options.concurrency}, timeout ${options.timeoutMs} ms, heap ${options.heapMb} MB, `
    + `guard ${options.rssLimitMb} MB, total ${options.totalTimeoutMin} min`);
  if (options.dryRun) {
    console.log(JSON.stringify({ node: process.execPath, args, NODE_OPTIONS: env.NODE_OPTIONS }, null, 2));
    rmSync(reportDirectory, { recursive: true, force: true });
    return;
  }

  const child = spawn(process.execPath, args, { cwd: root, env, stdio: "inherit" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    console.error(`run-tests: the run passed ${options.totalTimeoutMin} min; stopping its process tree`);
    killTree(child.pid);
  }, options.totalTimeoutMin * 60_000);
  const stop = () => killTree(child.pid);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  child.on("exit", (code, signal) => {
    clearTimeout(timer);
    const summary = summarizeMemory(existsSync(report) ? readFileSync(report, "utf8") : "");
    rmSync(reportDirectory, { recursive: true, force: true });
    if (summary.peak) {
      console.error(`run-tests: memory peak ${summary.peak.peakMb} MB in ${labelOf(summary.peak)} `
        + `(${summary.processes} processes)`);
    }
    for (const record of summary.killed) {
      console.error(`run-tests: the memory guard terminated ${labelOf(record)} at ${record.peakMb} MB`);
    }
    const failed = timedOut || signal !== null || summary.killed.length > 0;
    process.exit(code !== null && code !== 0 ? code : failed ? 1 : 0);
  });
}

const samePath = (a, b) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
if (process.argv[1] && samePath(resolve(process.argv[1]), fileURLToPath(import.meta.url))) main();
