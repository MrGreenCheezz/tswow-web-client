// 10.18 (L10) — the crowd pose worker's state is shown in the diagnostics window ("Состояние
// клиента", O) beside the frame times, and recorded with a freeze capture: a player on plain http
// runs crowd poses on the main thread, and the panel now says so and why.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { poseWorkerReport, poseWorkerStatusLine } from "../dist/code/browser/ui/PoseWorkerStatus.js";

const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("each state reads as where crowd poses run and why", () => {
  assert.equal(poseWorkerStatusLine({ state: "on" }), "Позы толпы: в воркере");
  const off = poseWorkerStatusLine({ state: "off", reason: "not isolated" });
  assert.match(off, /^Позы толпы: в основном потоке — /);
  assert.match(off, /https/, "the remedy is named: TLS or the player app");
  assert.match(off, /приложение игрока/);
  assert.match(poseWorkerStatusLine({ state: "no-sab", reason: "x" }), /SharedArrayBuffer/);
  assert.match(poseWorkerStatusLine({ state: "no-worker", reason: "x" }), /Web Workers/);
  assert.match(poseWorkerStatusLine({ state: "query", reason: "x" }), /\?poseworker=0/);
  assert.match(poseWorkerStatusLine({ state: "failed", reason: "x" }), /не создался/);
});

test("before the first crowd the line says what the page will do, not what it did", () => {
  assert.equal(poseWorkerStatusLine({ state: "on" }, true), "Позы толпы: будут в воркере");
  assert.match(poseWorkerStatusLine({ state: "off", reason: "x" }, true), /^Позы толпы: будут в основном потоке — /);
});

test("the capture report carries the state with its reason", () => {
  const report = poseWorkerReport();
  assert.equal(typeof report.state, "string");
  assert.equal(typeof report.predicted, "boolean");
  // Node has no crossOriginIsolated, so the pure decision says "off" with the reason.
  assert.equal(report.state, "off");
  assert.equal(report.predicted, true);
  assert.match(String(report.reason), /cross-origin isolated/);
});

test("the diagnostics tick shows the line and the freeze capture records it", () => {
  const loop = source("src/browser/game/Loop.ts");
  assert.match(loop, /if \(!diagnosticsWindow\.hidden\) showPoseWorkerStatus\(fullFrameStatus\);/);
  const capture = source("src/browser/game/PerformanceCapture.ts");
  assert.match(capture, /metadata\["poseWorker"\] = poseWorkerReport\(\);/);
});
