// 22.10 ARC-2 S4b — page state the renderer shared through module singletons now crosses as data: the render switches
// and the gateway cache generation are pushed in RenderInputs and applied to the renderer realm's own copy
// (src/browser/RenderSidePushes.ts); the frame-budget sensor, the GPU timer's observer and the patch-chain suspicion
// come back through RenderResults (src/browser/RendererReports.ts) and land in the page's singletons. A renderer realm
// is simulated here by resetting the module state after the push was cloned, as a fresh worker module would start.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { FRAME_BUDGET, FrameBudgetProbe } from "../dist/code/browser/FrameBudgetProbe.js";
import {
  gatewayGenerationPush, noteGatewayCacheGeneration, resetGatewayGeneration, withGeneration,
} from "../dist/code/browser/GatewayGeneration.js";
import { RenderBenchmarkRuntime } from "../dist/code/browser/RenderBenchmarkRuntime.js";
import { NO_RENDER_INPUTS } from "../dist/code/browser/RenderInputs.js";
import { createRenderResults } from "../dist/code/browser/RenderResults.js";
import {
  RENDERER_REPORT_QUEUE_LIMIT, drainPatchChainSuspects, mergeRendererBudget, publishRendererBudget, queuedGpuObserver,
  replayGpuEvents,
} from "../dist/code/browser/RendererReports.js";
import { RenderSidePushes } from "../dist/code/browser/RenderSidePushes.js";
import {
  renderSwitches, renderSwitchesPush, resetRenderSwitches, setRenderSwitches,
} from "../dist/code/browser/RenderSwitches.js";
import { RenderInputsBuilder } from "../dist/code/browser/game/RenderInputsBuilder.js";

const source = (path) => readFileSync(new URL(`../src/browser/${path}`, import.meta.url), "utf8");

/** One frame's inputs as the loop builds them, after the trip to a worker. */
function crossedInputs() {
  const inputs = new RenderInputsBuilder().build({
    world: undefined, spells: new Map(), enchantments: undefined, vehicles: undefined, gameObjectShown: () => true,
  });
  return structuredClone(inputs);
}

test("a DebugTab switch change reaches the renderer realm's switches through the inputs", () => {
  try {
    // DebugTab's checkbox and `webclientDebug.switches(patch)` both call setRenderSwitches.
    assert.match(source("ui/DebugTab.ts"), /setRenderSwitches\(\{ \[key\]: box\.checked \}\)/);
    const before = renderSwitchesPush();
    setRenderSwitches({ particleTwinkle: true, terrainSpecular: false });
    const crossed = crossedInputs();
    assert.ok(crossed.switches.revision > before.revision, "the write moved the revision");
    assert.deepEqual(crossed.switches.values, { ...renderSwitches });
    // The renderer realm starts from its defaults.
    resetRenderSwitches();
    assert.equal(renderSwitches.particleTwinkle, false);
    const pushes = new RenderSidePushes();
    pushes.apply(crossed, undefined);
    assert.equal(renderSwitches.particleTwinkle, true, "the twinkle switch is on in the renderer's copy");
    assert.equal(renderSwitches.terrainSpecular, false);
    // Applying is not a write of the page: the revision stays, and the same revision is not applied twice.
    const applied = renderSwitchesPush();
    pushes.apply(crossed, undefined);
    assert.equal(renderSwitchesPush(), applied, "one frozen record until the next write");
    // Nothing pushed (a benchmark, a test): the renderer's copy stays.
    pushes.apply(NO_RENDER_INPUTS, undefined);
    assert.equal(renderSwitches.particleTwinkle, true);
  } finally {
    resetRenderSwitches();
  }
});

test("the gateway cache generation reaches the renderer realm's tile URLs", () => {
  const gateway = "http://127.0.0.1:8090";
  const generation = "abc123";
  try {
    resetGatewayGeneration();
    noteGatewayCacheGeneration(gateway, generation);
    const crossed = crossedInputs();
    assert.equal(crossed.gatewayGeneration.generation, generation);
    // A fresh renderer realm: no generation yet, so its splat URL carries none.
    resetGatewayGeneration();
    const splat = `${gateway}/terrain-splat/0/32/48?v=7`;
    assert.equal(withGeneration(splat), splat);
    new RenderSidePushes().apply(crossed, undefined);
    assert.equal(withGeneration(splat), `${splat}&g=${generation}`);
    assert.equal(withGeneration(`${gateway}/horizon/0`), `${gateway}/horizon/0?g=${generation}`);
    assert.equal(withGeneration("http://elsewhere.test/horizon/0"), "http://elsewhere.test/horizon/0");
    // The apply is not a change of the page's state: the pushed record stays the same object.
    const push = gatewayGenerationPush();
    new RenderSidePushes().apply(crossed, undefined);
    assert.equal(gatewayGenerationPush(), push);
  } finally {
    resetGatewayGeneration();
  }
});

/** A frame's work: what the page's code and the renderer's limiters spent, period by period. */
const PERIODS = [
  { main: [[FRAME_BUDGET.net, 1.2], [FRAME_BUDGET.framexml, 0.8]], renderer: [[FRAME_BUDGET.units, 2.1], [FRAME_BUDGET.terrain, 1.4]] },
  { main: [[FRAME_BUDGET.collisions, 0.05]], renderer: [[FRAME_BUDGET.environment, 0.3]] },
  { main: [[FRAME_BUDGET.net, 3.5]], renderer: [[FRAME_BUDGET.units, 0.9], [FRAME_BUDGET.effects, 0.6], [FRAME_BUDGET.atlas, 0.2]] },
  { main: [], renderer: [] },
];

test("the frame-budget readings of a renderer with its own sensor arrive on the page's and match one shared sensor", () => {
  // Before: one sensor, written by both sides.
  const shared = new FrameBudgetProbe(() => 0);
  shared.setEnabled(true);
  const sharedRows = [];
  for (const period of PERIODS) {
    shared.frameStart();
    for (const [id, ms] of [...period.main, ...period.renderer]) shared.addOutside(id, ms);
  }
  shared.frameStart();
  sharedRows.push(shared.lastBudgetMs, shared.lastFired);

  // After: the page's sensor and the renderer's, the flag pushed, the readings through the record.
  const page = new FrameBudgetProbe(() => 0);
  const own = new FrameBudgetProbe(() => 0);
  const results = createRenderResults({});
  page.setEnabled(true);
  const inputs = { ...NO_RENDER_INPUTS, frameBudgetProbe: page.enabled };
  new RenderSidePushes().apply(inputs, own);
  assert.equal(own.enabled, true, "the pushed flag turned the renderer's sensor on");
  for (const period of PERIODS) {
    page.frameStart();
    for (const [id, ms] of period.main) page.addOutside(id, ms);
    for (const [id, ms] of period.renderer) own.addOutside(id, ms);
    publishRendererBudget(own, results); // the end of draw
    const crossed = structuredClone({ budgetMs: results.budgetMs, budgetPending: results.budgetPending });
    results.budgetMs.fill(0);
    results.budgetPending = false;
    mergeRendererBudget(crossed, page); // after the frame, before the next starts
    assert.equal(crossed.budgetPending, false);
    assert.ok(crossed.budgetMs.every((ms) => ms === 0), "merged once");
  }
  page.frameStart();
  assert.deepEqual([page.lastBudgetMs, page.lastFired], sharedRows);
  assert.deepEqual(page.report(), shared.report());

  // The flag back off stops the renderer's sensor; a page host (no sensor of its own) publishes nothing.
  new RenderSidePushes().apply(NO_RENDER_INPUTS, own);
  assert.equal(own.enabled, false);
  const pageResults = createRenderResults({});
  publishRendererBudget(undefined, pageResults);
  assert.equal(pageResults.budgetPending, false);
});

test("GPU timer events of a renderer realm replay into the page's benchmark runtime as the direct observer saw them", () => {
  const events = (observer) => {
    observer.onSample(2.5);
    observer.onUnavailable("disjoint");
    observer.onSample(3.25);
    observer.onDropped(2, "queue-full");
    observer.onDropped(1, "epoch-reset");
  };
  const options = { scenario: "s4b", variant: "live", runIndex: 1, startedAt: 1_000 };
  const direct = new RenderBenchmarkRuntime();
  direct.start(options);
  events(direct.gpuObserver);
  const replayed = new RenderBenchmarkRuntime();
  replayed.start(options);
  const results = createRenderResults({});
  events(queuedGpuObserver(results));
  assert.equal(results.gpuEvents.length, 5);
  const crossed = structuredClone({ gpuEvents: results.gpuEvents });
  replayGpuEvents(crossed, replayed.gpuObserver);
  assert.equal(crossed.gpuEvents.length, 0, "drained");
  assert.deepEqual(replayed.finish(2_000), direct.finish(2_000));
  // A page that stops draining keeps the oldest events and a bounded queue.
  const stalled = createRenderResults({});
  const observer = queuedGpuObserver(stalled);
  for (let index = 0; index < RENDERER_REPORT_QUEUE_LIMIT + 5; index++) observer.onSample(index);
  assert.equal(stalled.gpuEvents.length, RENDERER_REPORT_QUEUE_LIMIT);
  assert.equal(stalled.gpuEvents[0].milliseconds, 0);
});

test("queued patch-chain suspicions drain in order, once", () => {
  const results = createRenderResults({});
  results.patchChainSuspects.push("a", "b");
  const seen = [];
  drainPatchChainSuspects(results, (url) => seen.push(url));
  drainPatchChainSuspects(results, (url) => seen.push(url));
  assert.deepEqual(seen, ["a", "b"]);
});

// ---- source guards ------------------------------------------------------------------------------------------

test("the renderer applies the pushes and reports through the record; the loop accepts the reports", () => {
  const renderer = source("WorldRenderer3D.ts");
  assert.doesNotMatch(renderer, /from "\.\/RenderBenchmarkRuntime\.js"/, "the GPU observer comes from the host");
  assert.match(renderer, /createWebGlGpuTimer\(this\.#renderer\.getContext\(\), this\.#host\.gpuTimerObserver\(this\.#results\)\)/);
  const at = (head) => {
    const start = renderer.indexOf(head);
    assert.ok(start >= 0, head);
    return renderer.slice(start, renderer.indexOf("\n  }\n", start));
  };
  assert.match(at("  setRenderInputs(inputs: RenderInputs | undefined): void {"),
    /this\.#renderSidePushes\.apply\(this\.#inputs, this\.#host\.frameBudgetProbe\);/);
  assert.match(at("  #publishResults(state: WorldState | undefined): void {"),
    /publishRendererBudget\(this\.#host\.frameBudgetProbe, results\);/);
  assert.match(at("  observeFrame(timestamp: number): number | undefined {"), /this\.#results\.frameInterval = interval;/);
  assert.match(at("  endRenderFrame(): number | undefined {"), /this\.#results\.rendererFrameMs = elapsed;/);
  // TextureLoad reports to its realm's sink, never to the page's banner module.
  const textures = source("TextureLoad.ts");
  assert.doesNotMatch(textures, /PatchChainChanged\.js/);
  assert.match(textures, /reportPatchChainSuspect\(url\);/);
  // The page host answers with the page's own objects.
  assert.match(source("RenderHost.ts"), /gpuTimerObserver: \(\) => renderBenchmarkGpuObserver,[^\n]*\n\s*frameBudgetProbe: undefined,/);
  const loop = source("game/Loop.ts");
  const frame = loop.slice(loop.indexOf("function frame(now: number): void {"), loop.indexOf("export function animate(now: number): void {"));
  assert.match(frame, /game\.renderer\?\.observeFrame\(now\);\s*const frameInterval = game\.renderer\?\.results\.frameInterval;/);
  const end = frame.indexOf("renderer.endRenderFrame();");
  const accept = frame.indexOf("acceptRendererReports(renderer.results);");
  assert.ok(end >= 0 && accept > end, "the reports are accepted once the renderer frame closed");
  assert.match(frame.slice(end, accept), /const rendererElapsed = renderer\.results\.rendererFrameMs;/);
});

test("absolute main times reach the renderer through RenderClock", () => {
  const renderer = source("WorldRenderer3D.ts");
  assert.match(renderer, /this\.#cadence\.observe\(toRenderTime\(timestamp\)\)/);
  assert.match(renderer, /this\.#environmentStandInMarkers\.showUntil\(toRenderTime\(untilMs\)\)/);
  assert.match(renderer, /this\.#portraits\.render\(mainNow === undefined \? performance\.now\(\) : toRenderTime\(mainNow\)\)/);
});
