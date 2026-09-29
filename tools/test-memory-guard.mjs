// Preloaded into every test process by tools/run-tests.mjs (NODE_OPTIONS --import). A worker thread
// samples this process's own resident memory and terminates the process once it passes the limit,
// so a runaway test dies alone instead of exhausting the machine: on 2026-09-28 two test processes
// reached 101 and 131 GB and took Chrome and the desktop app down with them. The sampling runs on
// its own thread because a runaway is often one synchronous loop that never yields to a timer on
// the main thread. It never looks at any other process. Every process appends its peak to the
// report file named by WEBCLIENT_TEST_MEMORY_REPORT; the wrapper prints the summary.
//
// Environment: WEBCLIENT_TEST_RSS_LIMIT_MB (default 6144), WEBCLIENT_TEST_GUARD_INTERVAL_MS
// (default 500, at least 20), WEBCLIENT_TEST_MEMORY_REPORT (JSON lines), WEBCLIENT_TEST_GUARD=0
// switches the guard off.
import { appendFileSync } from "node:fs";
import { isMainThread, Worker } from "node:worker_threads";

const INSTALLED = Symbol.for("webclient.testMemoryGuard");

function settings(env) {
  const limitMb = Number.parseInt(env.WEBCLIENT_TEST_RSS_LIMIT_MB ?? "", 10);
  const intervalMs = Number.parseInt(env.WEBCLIENT_TEST_GUARD_INTERVAL_MS ?? "", 10);
  return {
    limitMb: Number.isFinite(limitMb) && limitMb > 0 ? limitMb : 6144,
    intervalMs: Number.isFinite(intervalMs) && intervalMs >= 20 ? intervalMs : 500,
    report: env.WEBCLIENT_TEST_MEMORY_REPORT || null,
    disabled: env.WEBCLIENT_TEST_GUARD === "0",
  };
}

// The `node --test` runner, or the test file a runner child executes.
function label() {
  if (process.execArgv.includes("--test") || process.argv.slice(2).includes("--test")) return "node --test runner";
  return process.argv[1] ?? "(no script)";
}

// Runs as CommonJS inside the worker. shared[0] holds the peak RSS in bytes; shared[1] is set to 1
// just before the worker terminates the process, so the exit hook does not report it twice.
const WORKER_SOURCE = `
const { appendFileSync, writeSync } = require("node:fs");
const { workerData } = require("node:worker_threads");
const shared = new Float64Array(workerData.shared);
function sample() {
  const rss = process.memoryUsage.rss();
  if (rss > shared[0]) shared[0] = rss;
  if (rss <= workerData.limitBytes) return;
  shared[1] = 1;
  const mb = Math.round(rss / 1048576);
  const line = "[test-memory-guard] " + workerData.label + ": resident memory " + mb
    + " MB passed the limit of " + workerData.limitMb + " MB; terminating this test process.\\n";
  try { writeSync(2, line); } catch {}
  if (workerData.report) {
    try {
      appendFileSync(workerData.report, JSON.stringify({ pid: process.pid, label: workerData.label,
        peakMb: mb, killed: true }) + "\\n");
    } catch {}
  }
  process.kill(process.pid, "SIGKILL");
}
sample();
setInterval(sample, workerData.intervalMs);
`;

function install() {
  const config = settings(process.env);
  if (!isMainThread || config.disabled || globalThis[INSTALLED]) return;
  globalThis[INSTALLED] = true;
  const name = label();
  const shared = new SharedArrayBuffer(16);
  const view = new Float64Array(shared);
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    execArgv: [],
    stdout: false,
    stderr: false,
    workerData: {
      shared,
      label: name,
      limitMb: config.limitMb,
      limitBytes: config.limitMb * 1048576,
      intervalMs: config.intervalMs,
      report: config.report,
    },
  });
  worker.unref();
  // The guard must never be the reason a test fails.
  worker.on("error", () => {});
  if (config.report) {
    const report = config.report;
    process.on("exit", (code) => {
      if (view[1] === 1) return;
      const peak = Math.max(view[0], process.memoryUsage.rss());
      try {
        appendFileSync(report, JSON.stringify({ pid: process.pid, label: name, peakMb: Math.round(peak / 1048576),
          killed: false, code }) + "\n");
      } catch {}
    });
  }
}

install();
