import assert from "node:assert/strict";
import test from "node:test";

import {
  RenderBenchmarkReadinessTracker,
} from "../dist/code/browser/RenderBenchmarkReadiness.js";

const accounting = Object.freeze({
  cpu: Object.freeze({ uniqueRetainedBytes: 1, uniqueResources: 1, owners: 1, references: 1, sharedResources: 0 }),
  gpuBuffers: Object.freeze({ estimatedGpuBufferBytes: 2, uniqueResources: 1, owners: 1, references: 1, sharedResources: 0 }),
  gpuTextures: Object.freeze({ estimatedLogicalTextureBytes: 3, knownByteResources: 1, unknownByteResources: 0, uniqueResources: 1, owners: 1, references: 1, sharedResources: 0 }),
  gpuRenderbuffers: Object.freeze({ estimatedLogicalRenderbufferBytes: 4, knownByteResources: 1, unknownByteResources: 0, uniqueResources: 1, owners: 1, references: 1, sharedResources: 0 }),
  gpuRenderTargetTopology: Object.freeze({ unknownTopologyResources: 0, uniqueResources: 0, owners: 0, references: 0, sharedResources: 0 }),
  unsupported: Object.freeze({ uniqueResources: 0, owners: 0, references: 0, sharedResources: 0 }),
  coverage: Object.freeze({ complete: false, gaps: Object.freeze(["known gap"]) }),
});

function telemetry(capturedAt, overrides = {}) {
  const emptyClient = { pending: 0, success: 0, error: 0, generation: 0 };
  return {
    capturedAt,
    renderer: {
      textureCount: 10,
      geometryCount: 20,
      groundCoverResidentMeshes: 2,
    },
    resources: {
      terrain: { resident: 9, failed: 0, active: 0, typedPayloadBytes: 100 },
      terrainSplat: { resident: 9, failed: 0, active: 0, decodedLayerBytes: 200, layerRequestEntries: 8 },
      environment: {
        residentTiles: 9, knownMissingTiles: 0, failedTiles: 0, activeTiles: 0,
        residentObjects: 50, residentModels: 20, knownMissingModels: 0, deferredModels: 0,
        failedModels: 0, queuedModels: 0, activeModels: 0, queuedGroups: 0, activeGroups: 0,
        deferredGroups: 0, failedGroups: 0,
        residentAnimations: 3, failedAnimations: 0, deferredAnimations: 0, queuedAnimations: 0, activeAnimations: 0,
      },
      assetWarmup: { accepted: 10, queued: 0, active: 0, closed: false },
      accounting,
      ...(overrides.resources ?? {}),
    },
    benchmarkClients: Object.fromEntries([
      "light", "liquids", "groundCover", "horizon", "transportPaths", "creatureModels",
      "creatureMetadata", "gameObjectMetadata", "itemMetadata", "collision",
    ].map((key) => [key, { ...emptyClient }])),
    ...(overrides.renderer === undefined ? {} : { renderer: overrides.renderer }),
  };
}

const rendererReady = Object.freeze({
  renderFrameActive: false,
  gpuQueriesPending: 0,
  modelTexturesPending: 0,
  modelTexturesErrors: 0,
  modelTexturesGeneration: 0,
  worldTexturesPending: 0,
  worldTexturesErrors: 0,
  worldTexturesGeneration: 0,
  groundCoverModelsPending: 0,
  transientVisuals: 0,
  persistentStateVisuals: 0,
  pendingVisualAnimations: 0,
  pendingUnitActions: 0,
  pendingGameObjectAnimations: 0,
  characterAtlasPending: 0,
  characterAtlasErrors: 0,
  characterAtlasGeneration: 0,
});

test("requires an idle, unchanged resource set for the full stable window", () => {
  const tracker = new RenderBenchmarkReadinessTracker();
  const first = tracker.observe(telemetry(100), rendererReady);
  assert.equal(first.ready, false);
  assert.deepEqual(first.blockingReasons, ["stable-window-incomplete"]);

  const middle = tracker.observe(telemetry(1_100), rendererReady);
  assert.equal(middle.ready, false);
  assert.equal(middle.stableSamples, 2);
  assert.equal(middle.stableForMs, 1_000);

  const ready = tracker.observe(telemetry(2_100), rendererReady);
  assert.equal(ready.ready, true);
  assert.equal(ready.stableSamples, 3);
  assert.equal(ready.stableForMs, 2_000);
  assert.deepEqual(ready.blockingReasons, []);
  assert.ok(Object.isFrozen(ready));
  assert.ok(Object.isFrozen(ready.blockingReasons));
});

test("queue activity resets the stable epoch", () => {
  const tracker = new RenderBenchmarkReadinessTracker({ stableResidencyMs: 10, minimumStableSamples: 2 });
  tracker.observe(telemetry(0), rendererReady);
  const busy = tracker.observe(telemetry(10, {
    resources: { terrain: { resident: 9, failed: 0, active: 1, typedPayloadBytes: 100 } },
  }), rendererReady);
  assert.equal(busy.ready, false);
  assert.equal(busy.stableSamples, 0);
  assert.deepEqual(busy.blockingReasons, ["terrain-active"]);

  assert.equal(tracker.observe(telemetry(20), rendererReady).stableSamples, 1);
  assert.equal(tracker.observe(telemetry(30), rendererReady).ready, true);
});

test("a residency change starts a new stable epoch", () => {
  const tracker = new RenderBenchmarkReadinessTracker({ stableResidencyMs: 10, minimumStableSamples: 2 });
  tracker.observe(telemetry(0), rendererReady);
  const changed = tracker.observe(telemetry(10, {
    renderer: { textureCount: 11, geometryCount: 20, groundCoverResidentMeshes: 2 },
  }), rendererReady);
  assert.equal(changed.ready, false);
  assert.equal(changed.stableSamples, 1);
  assert.equal(changed.stableForMs, 0);
  assert.deepEqual(changed.blockingReasons, [
    "resource-signature-changing",
    "stable-window-incomplete",
  ]);
  assert.equal(tracker.observe(telemetry(20, {
    renderer: { textureCount: 11, geometryCount: 20, groundCoverResidentMeshes: 2 },
  }), rendererReady).ready, true);
});

test("every renderer-owned pending class blocks readiness", () => {
  for (const field of [
    "gpuQueriesPending", "modelTexturesPending", "worldTexturesPending",
    "groundCoverModelsPending", "transientVisuals", "persistentStateVisuals",
    "pendingVisualAnimations", "pendingUnitActions",
  ]) {
    const tracker = new RenderBenchmarkReadinessTracker({ stableResidencyMs: 0, minimumStableSamples: 2 });
    const busy = { ...rendererReady, [field]: 1 };
    assert.equal(tracker.observe(telemetry(0), busy).ready, false, field);
  }
  const activeFrame = new RenderBenchmarkReadinessTracker({ stableResidencyMs: 0, minimumStableSamples: 2 });
  assert.equal(activeFrame.observe(telemetry(0), { ...rendererReady, renderFrameActive: true }).ready, false);
});

test("persistent state visuals have their own terminal blocker", () => {
  const tracker = new RenderBenchmarkReadinessTracker({ stableResidencyMs: 0, minimumStableSamples: 2 });
  const blocked = tracker.observe(telemetry(0), {
    ...rendererReady,
    transientVisuals: 2,
    persistentStateVisuals: 3,
  });
  assert.equal(blocked.ready, false);
  assert.deepEqual(blocked.blockingReasons, [
    "transient-visuals-active",
    "persistent-state-visuals-active",
  ]);
});

test("deferred and exhausted WMO groups remain explicit readiness blockers", () => {
  const tracker = new RenderBenchmarkReadinessTracker({ stableResidencyMs: 0, minimumStableSamples: 2 });
  const base = telemetry(0);
  tracker.observe({
    ...base,
    resources: {
      ...base.resources,
      environment: { ...base.resources.environment, deferredGroups: 1, failedGroups: 1 },
    },
  }, rendererReady);
  const blocked = tracker.observe({
    ...base,
    capturedAt: 1,
    resources: {
      ...base.resources,
      environment: { ...base.resources.environment, deferredGroups: 1, failedGroups: 1 },
    },
  }, rendererReady);
  assert.deepEqual(blocked.blockingReasons, [
    "environment-groups-deferred",
    "environment-groups-failed",
  ]);
});

test("missing required sources are explicit blockers, not an empty ready state", () => {
  const tracker = new RenderBenchmarkReadinessTracker({ stableResidencyMs: 0, minimumStableSamples: 2 });
  const missing = tracker.observe({ capturedAt: 0, renderer: undefined, resources: {} });
  assert.deepEqual(missing.blockingReasons, [
    "renderer-telemetry-missing",
    "terrain-stats-missing",
    "terrain-splat-stats-missing",
    "environment-stats-missing",
    "asset-warmup-stats-missing",
    "resource-accounting-missing",
    "renderer-readiness-missing",
    "client-readiness-missing",
  ]);
});

test("timestamps, options, and renderer counters are strictly validated", () => {
  assert.throws(() => new RenderBenchmarkReadinessTracker({ stableResidencyMs: -1 }), /stableResidencyMs/);
  assert.throws(() => new RenderBenchmarkReadinessTracker({ minimumStableSamples: 1 }), /minimumStableSamples/);
  const tracker = new RenderBenchmarkReadinessTracker();
  tracker.observe(telemetry(1), rendererReady);
  assert.throws(() => tracker.observe(telemetry(1), rendererReady), /strictly increasing/);
  assert.throws(() => tracker.observe(telemetry(2), { ...rendererReady, gpuQueriesPending: 0.5 }), /gpuQueriesPending/);
  tracker.reset();
  assert.doesNotThrow(() => tracker.observe(telemetry(1), rendererReady));
});
