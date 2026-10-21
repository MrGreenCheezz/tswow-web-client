// 10.18 — why a page has no crowd pose worker is decided in one pure function and said out loud.
import assert from "node:assert/strict";
import test from "node:test";
import { poseEngineAvailability } from "../dist/code/browser/PoseEngine.js";

const capable = { crossOriginIsolated: true, Worker: class {}, SharedArrayBuffer, Atomics, location: { search: "" } };

test("a plain-http page outside loopback is not isolated, so no worker — and the reason says so", () => {
  const off = poseEngineAvailability({ ...capable, crossOriginIsolated: false });
  assert.equal(off.state, "off");
  assert.match(off.reason, /not cross-origin isolated/);
  assert.equal(poseEngineAvailability({ ...capable, crossOriginIsolated: undefined }).state, "off");
});

test("the other refusals each have their own state; an isolated capable page is on", () => {
  assert.deepEqual(poseEngineAvailability(capable), { state: "on" });
  assert.equal(poseEngineAvailability({ ...capable, Worker: undefined }).state, "no-worker");
  assert.equal(poseEngineAvailability({ ...capable, SharedArrayBuffer: undefined }).state, "no-sab");
  assert.equal(poseEngineAvailability({ ...capable, Atomics: undefined }).state, "no-sab");
  assert.deepEqual(poseEngineAvailability({ ...capable, location: { search: "?a=1&poseworker=0" } }),
    { state: "query", reason: "?poseworker=0" });
  assert.equal(poseEngineAvailability({ ...capable, location: { search: "?poseworker=01" } }).state, "on");
});

// 21.10 ARC-2 S1: a worker has no page location; the renderer passes its host's query flags.
test("injected query flags decide ?poseworker=0 in place of location.search", () => {
  assert.deepEqual(poseEngineAvailability({ ...capable, flags: new URLSearchParams("a=1&poseworker=0") }),
    { state: "query", reason: "?poseworker=0" });
  assert.equal(poseEngineAvailability({ ...capable, flags: new URLSearchParams("poseworker=01") }).state, "on");
  // Given flags are the whole answer: the page's own search is not consulted beside them.
  assert.equal(poseEngineAvailability({
    ...capable, location: { search: "?poseworker=0" }, flags: new URLSearchParams(""),
  }).state, "on");
  assert.equal(poseEngineAvailability({ ...capable, location: undefined, flags: undefined }).state, "on");
});
