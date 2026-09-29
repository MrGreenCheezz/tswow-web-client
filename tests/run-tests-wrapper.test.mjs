import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  DEFAULTS,
  needsNewerNode,
  parseArgs,
  resolveFiles,
  suiteFiles,
  summarizeMemory,
  testArgs,
  withNodeOptions,
} from "../tools/run-tests.mjs";

const root = resolve(import.meta.dirname, "..");
const guardUrl = pathToFileURL(join(root, "tools", "test-memory-guard.mjs")).href;

test("named files run one at a time, the whole suite four at a time", () => {
  const named = parseArgs(["tests/a.test.mjs", "tests/b.test.mjs"]);
  assert.equal(named.mode, "source");
  assert.deepEqual(named.files, ["tests/a.test.mjs", "tests/b.test.mjs"]);
  assert.equal(named.concurrency, 1);
  assert.equal(named.timeoutMs, 240_000);
  assert.equal(named.heapMb, 4096);
  assert.equal(parseArgs([]).concurrency, DEFAULTS.suiteConcurrency);
  assert.equal(parseArgs(["--dist", "--concurrency=2"]).concurrency, 2);
  assert.equal(parseArgs(["--dist"]).mode, "dist");
  assert.deepEqual(parseArgs(["--test-name-pattern=frame"]).passthrough, ["--test-name-pattern=frame"]);
  assert.throws(() => parseArgs(["--concurrency=0"]), /positive integer/);
  assert.throws(() => parseArgs(["--test-concurrency=19"]), /unknown option/);
});

test("the heap cap and the guard are added to NODE_OPTIONS without dropping the caller's flags", () => {
  const options = withNodeOptions("--enable-source-maps", { heapMb: 4096, guardUrl });
  assert.deepEqual(options.split(" "), ["--enable-source-maps", "--max-old-space-size=4096", `--import=${guardUrl}`]);
  assert.equal(withNodeOptions(options, { heapMb: 4096, guardUrl }), options, "applying twice changes nothing");
  assert.equal(withNodeOptions("--max-old-space-size=2048", { heapMb: 4096, guardUrl: null }), "--max-old-space-size=2048",
    "an explicit caller limit wins");
  assert.equal(withNodeOptions(undefined, { heapMb: 1024, guardUrl: null }), "--max-old-space-size=1024");
});

test("node --test gets the source hook, the limits and exactly the named files", () => {
  const source = testArgs(parseArgs(["tests/x.test.mjs"]), ["tests/x.test.mjs"]);
  assert.deepEqual(source, ["--import", "./tools/register-test-sources.mjs", "--test", "--test-concurrency=1",
    "--test-timeout=240000", "tests/x.test.mjs"]);
  const dist = testArgs(parseArgs(["--dist"]), ["tests/a.test.mjs"]);
  assert.equal(dist.includes("./tools/register-test-sources.mjs"), false);
  assert.ok(dist.includes("--test-concurrency=4"));
});

test("the suite is tests/*.test.mjs and nothing from .runtime or the helpers", () => {
  const files = suiteFiles();
  assert.ok(files.length > 100, `${files.length} files`);
  assert.ok(files.includes("tests/run-tests-wrapper.test.mjs"));
  assert.ok(files.every((file) => /^tests\/[^/]+\.test\.mjs$/.test(file)), "only top-level test files");
  assert.equal(files.includes("tests/terrain-streaming-harness.mjs"), false);
  assert.deepEqual(files, [...files].sort());
  assert.deepEqual(resolveFiles(["tests/run-tests-wrapper.test.mjs"], root), ["tests/run-tests-wrapper.test.mjs"]);
  assert.throws(() => resolveFiles(["tests/no-such.test.mjs"], root), /no such test file/);
});

test("Node without registerHooks is replaced for source tests only", () => {
  assert.equal(needsNewerNode("20.18.0", false, "source"), true);
  assert.equal(needsNewerNode("20.18.0", false, "dist"), true, "the suite targets Node 22");
  assert.equal(needsNewerNode("22.10.0", false, "source"), true);
  assert.equal(needsNewerNode("22.10.0", false, "dist"), false);
  assert.equal(needsNewerNode("v22.23.2", true, "source"), false);
});

test("the memory summary names the largest process and every terminated one", () => {
  const summary = summarizeMemory([
    JSON.stringify({ pid: 1, label: "node --test runner", peakMb: 90, killed: false, code: 0 }),
    JSON.stringify({ pid: 2, label: "a.test.mjs", peakMb: 420, killed: false, code: 0 }),
    "not json",
    JSON.stringify({ pid: 3, label: "b.test.mjs", peakMb: 6200, killed: true }),
    "",
  ].join("\n"));
  assert.equal(summary.processes, 3);
  assert.equal(summary.peak.label, "b.test.mjs");
  assert.deepEqual(summary.killed.map((record) => record.pid), [3]);
  assert.equal(summarizeMemory("").peak, null);
});

function guarded(script, env) {
  const directory = mkdtempSync(join(tmpdir(), "memory-guard-"));
  const report = join(directory, "memory.jsonl");
  writeFileSync(report, "");
  try {
    const result = spawnSync(process.execPath, ["--import", guardUrl, "--input-type=module", "-e", script], {
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, NODE_OPTIONS: "", WEBCLIENT_TEST_MEMORY_REPORT: report, ...env },
    });
    return { ...result, records: summarizeMemory(readFileSync(report, "utf8")) };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("the guard terminates a process whose own memory passes the limit, even inside a synchronous loop", () => {
  // 8 MB of touched memory every 20 ms, without ever yielding: a main-thread timer could not fire.
  const script = `
    const held = [];
    const until = (ms) => { const end = Date.now() + ms; while (Date.now() < end) {} };
    for (let i = 0; i < 128; i++) { held.push(Buffer.alloc(8 * 1024 * 1024, 1)); until(20); }
    console.log("survived", held.length);`;
  const result = guarded(script, { WEBCLIENT_TEST_RSS_LIMIT_MB: "256", WEBCLIENT_TEST_GUARD_INTERVAL_MS: "50" });
  assert.notEqual(result.status, 0, `exit ${result.status}, signal ${result.signal}`);
  assert.equal(result.stdout.includes("survived"), false);
  assert.match(result.stderr, /\[test-memory-guard\] .*passed the limit of 256 MB/);
  assert.equal(result.records.killed.length, 1);
  assert.ok(result.records.killed[0].peakMb > 256 && result.records.killed[0].peakMb < 1024,
    `terminated at ${result.records.killed[0].peakMb} MB`);
});

test("a process under the limit exits normally and reports its peak", () => {
  const result = guarded("const b = Buffer.alloc(32 * 1024 * 1024, 1); console.log('done', b.length);",
    { WEBCLIENT_TEST_RSS_LIMIT_MB: "2048" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /done 33554432/);
  assert.equal(result.records.processes, 1);
  assert.equal(result.records.killed.length, 0);
  assert.ok(result.records.peak.peakMb >= 32, `${result.records.peak.peakMb} MB`);
});

test("WEBCLIENT_TEST_GUARD=0 switches the guard off", () => {
  const result = guarded("console.log('off')", { WEBCLIENT_TEST_GUARD: "0" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.records.processes, 0);
});
