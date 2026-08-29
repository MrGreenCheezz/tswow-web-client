import assert from "node:assert/strict";
import test from "node:test";

import { LightClient } from "../dist/code/browser/LightClient.js";
import { HorizonClient } from "../dist/code/browser/Horizon.js";
import { GroundCoverClient } from "../dist/code/browser/GroundCover.js";
import { GameObjectMetadataClient } from "../dist/code/browser/GameObjectMetadata.js";
import { CharacterAtlasClient } from "../dist/code/browser/CharacterAtlas.js";
import { RenderBenchmarkReadinessTracker } from "../dist/code/browser/RenderBenchmarkReadiness.js";
import { makeRenderTelemetrySnapshot } from "../dist/code/browser/RenderStats.js";

const renderer = Object.freeze({
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

const accounting = Object.freeze({
  cpu: Object.freeze({ uniqueRetainedBytes: 0, uniqueResources: 0, owners: 0, references: 0, sharedResources: 0 }),
  gpuBuffers: Object.freeze({ estimatedGpuBufferBytes: 0, uniqueResources: 0, owners: 0, references: 0, sharedResources: 0 }),
  gpuTextures: Object.freeze({ estimatedLogicalTextureBytes: 0, knownByteResources: 0, unknownByteResources: 0, uniqueResources: 0, owners: 0, references: 0, sharedResources: 0 }),
  gpuRenderbuffers: Object.freeze({ estimatedLogicalRenderbufferBytes: 0, knownByteResources: 0, unknownByteResources: 0, uniqueResources: 0, owners: 0, references: 0, sharedResources: 0 }),
  gpuRenderTargetTopology: Object.freeze({ unknownTopologyResources: 0, uniqueResources: 0, owners: 0, references: 0, sharedResources: 0 }),
  unsupported: Object.freeze({ uniqueResources: 0, owners: 0, references: 0, sharedResources: 0 }),
  coverage: Object.freeze({ complete: false, gaps: Object.freeze([]) }),
});

function telemetry(capturedAt, overrides = {}) {
  return {
    capturedAt,
    renderer: { textureCount: 0, geometryCount: 0, groundCoverResidentMeshes: 0 },
    resources: {
      terrain: { resident: 0, failed: 0, active: 0, typedPayloadBytes: 0 },
      terrainSplat: { resident: 0, failed: 0, active: 0, decodedLayerBytes: 0, layerRequestEntries: 0 },
      environment: {
        residentTiles: 0, knownMissingTiles: 0, failedTiles: 0, activeTiles: 0,
        residentObjects: 0, residentModels: 0, knownMissingModels: 0, deferredModels: 0,
        failedModels: 0, queuedModels: 0, activeModels: 0, queuedGroups: 0, activeGroups: 0,
        deferredGroups: 0, failedGroups: 0,
        residentAnimations: 0, failedAnimations: 0, deferredAnimations: 0, queuedAnimations: 0, activeAnimations: 0,
      },
      assetWarmup: { accepted: 0, queued: 0, active: 0, closed: false },
      accounting,
      ...(overrides.resources ?? {}),
    },
  };
}

function clients(overrides = {}) {
  const empty = { pending: 0, success: 0, error: 0, generation: 0 };
  return Object.freeze({
    light: { ...empty, ...(overrides.light ?? {}) },
    liquids: { ...empty, ...(overrides.liquids ?? {}) },
    groundCover: { ...empty, ...(overrides.groundCover ?? {}) },
    horizon: { ...empty, ...(overrides.horizon ?? {}) },
    transportPaths: { ...empty, ...(overrides.transportPaths ?? {}) },
    creatureModels: { ...empty, ...(overrides.creatureModels ?? {}) },
    creatureMetadata: { ...empty, ...(overrides.creatureMetadata ?? {}) },
    gameObjectMetadata: { ...empty, ...(overrides.gameObjectMetadata ?? {}) },
    itemMetadata: { ...empty, ...(overrides.itemMetadata ?? {}) },
    collision: { ...empty, ...(overrides.collision ?? {}) },
  });
}

test("LightClient balances pending exactly once for success and synchronous fetch throw", async () => {
  const originalFetch = globalThis.fetch;
  let answer;
  globalThis.fetch = () => new Promise((resolve) => { answer = resolve; });
  try {
    const client = new LightClient("ws://readiness.test/world");
    client.sample(1, 0, 0, 0);
    assert.deepEqual(client.stats, { pending: 1, success: 0, error: 0, generation: 0 });
    assert.ok(Object.isFrozen(client.stats));
    answer({ ok: true, json: async () => ({ volumes: [], params: {} }) });
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(client.stats, { pending: 0, success: 1, error: 0, generation: 1 });

    globalThis.fetch = () => { throw new Error("sync failure"); };
    const failed = new LightClient("ws://readiness.test/world");
    failed.sample(2, 0, 0, 0);
    await Promise.resolve();
    assert.deepEqual(failed.stats, { pending: 0, success: 0, error: 1, generation: 1 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Horizon treats a normal 404 as cached absence and malformed data as current error", async () => {
  const originalFetch = globalThis.fetch;
  try {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return { ok: false, status: 404 };
    };
    const absent = new HorizonClient("ws://readiness.test/world");
    absent.get(1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(absent.stats, { pending: 0, success: 1, error: 0, generation: 1 });
    absent.get(1);
    assert.equal(calls, 1, "a normal map absence is cached");

    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    const malformed = new HorizonClient("ws://readiness.test/world");
    malformed.get(2);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(malformed.stats, { pending: 0, success: 0, error: 1, generation: 1 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GroundCover treats a normal absent cover tile as cached success", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => {
      calls++;
      return { ok: false, status: 404 };
    };
    const client = new GroundCoverClient("ws://readiness.test/world");
    assert.equal(client.get(1, { x: 2, y: 3 }), undefined);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(client.stats, { pending: 0, success: 1, error: 0, generation: 1 });
    client.get(1, { x: 2, y: 3 });
    assert.equal(calls, 1, "an absent optional cover is cached");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GameObject metadata retry is pending until it recovers, not a lifetime error", async () => {
  const originalFetch = globalThis.fetch;
  let now = 0;
  let attempts = 0;
  try {
    globalThis.fetch = async () => {
      attempts++;
      if (attempts === 1) return { ok: false, status: 503 };
      return { ok: true, json: async () => [{ id: 7, model: "World\\Door.m2" }] };
    };
    const client = new GameObjectMetadataClient("ws://readiness.test/world", () => now);
    await assert.rejects(client.load([7]));
    assert.deepEqual(client.stats, { pending: 1, success: 0, error: 0, generation: 1 });
    now = 2_000;
    await client.load([7]);
    assert.equal(client.stats.pending, 0);
    assert.equal(client.stats.error, 0);
    assert.equal(client.get(7)?.model, "World\\Door.m2");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("CharacterAtlasClient counts only in-flight image work and settles composition exactly once", async () => {
  const originalFetch = globalThis.fetch;
  const originalDocument = globalThis.document;
  const originalCreateImageBitmap = globalThis.createImageBitmap;
  let answer;
  globalThis.fetch = () => new Promise((resolve) => { answer = resolve; });
  globalThis.createImageBitmap = async () => ({ width: 256, height: 128 });
  globalThis.document = {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({ drawImage() {} }),
    }),
  };
  try {
    const atlas = new CharacterAtlasClient("http://readiness.test/world");
    const composed = atlas.compose("human", [{ path: "Character\\Human\\Male\\Skin.blp" }]);
    assert.deepEqual(atlas.stats, { pending: 2, success: 0, error: 0, generation: 0 });
    assert.ok(Object.isFrozen(atlas.stats));
    answer({ ok: true, status: 200, blob: async () => ({}) });
    assert.ok(await composed);
    assert.deepEqual(atlas.stats, { pending: 0, success: 2, error: 0, generation: 2 });

    // A resolved image promise is a cache hit, not another pending request or settle event.
    assert.ok(await atlas.compose("cached", [{ path: "Character\\Human\\Male\\Skin.blp" }]));
    assert.deepEqual(atlas.stats, { pending: 0, success: 3, error: 0, generation: 3 });
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.document = originalDocument;
    globalThis.createImageBitmap = originalCreateImageBitmap;
  }
});

test("CharacterAtlas readiness treats fallbacks/retries as pending, not permanent errors", async () => {
  const originalFetch = globalThis.fetch;
  const originalDocument = globalThis.document;
  const originalCreateImageBitmap = globalThis.createImageBitmap;
  const retryable = { ok: false, status: 500 };
  const found = { ok: true, status: 200, blob: async () => ({}) };
  const missing = { ok: false, status: 404 };
  let retryAnswer = retryable;
  let now = 0;
  globalThis.fetch = async (url) => String(url).includes("primary") ? missing : retryAnswer;
  globalThis.createImageBitmap = async () => ({ width: 256, height: 128 });
  globalThis.document = {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({ drawImage() {} }),
    }),
  };
  try {
    const fallback = new CharacterAtlasClient("http://readiness.test/world", () => now);
    globalThis.fetch = async (url) => String(url).includes("primary") ? missing : found;
    assert.ok(await fallback.compose("fallback", [
      { path: "primary.blp", alternate: "alternate.blp" },
    ]));
    assert.equal(fallback.stats.error, 0, "a missing primary spelling has a valid alternate");

    const retry = new CharacterAtlasClient("http://readiness.test/world", () => now);
    globalThis.fetch = async () => retryAnswer;
    assert.equal(await retry.compose("retry", [{ path: "retry.blp" }]), undefined);
    assert.equal(retry.stats.error, 0);
    assert.ok(retry.stats.pending > 0, "a scheduled retry is still readiness work");
    retryAnswer = found;
    now = 2_000;
    assert.ok(await retry.compose("retry", [{ path: "retry.blp" }]));
    assert.equal(retry.stats.error, 0, "a retry that recovers is not a permanent error");

    const terminal = new CharacterAtlasClient("http://readiness.test/world", () => now);
    globalThis.fetch = async () => missing;
    assert.equal(await terminal.compose("terminal", [{ path: "terminal.blp" }]), undefined);
    assert.ok(terminal.stats.error > 0, "all candidate spellings missing is terminal");

    const partial = new CharacterAtlasClient("http://readiness.test/world", () => now);
    globalThis.fetch = async (url) => String(url).includes("base") ? found : missing;
    assert.ok(await partial.compose("partial-terminal", [
      { path: "base.blp" },
      { path: "missing-trousers.blp", section: "legUpper" },
    ]));
    assert.ok(partial.stats.error > 0, "a painted atlas with a terminally missing layer is incomplete");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.document = originalDocument;
    globalThis.createImageBitmap = originalCreateImageBitmap;
  }
});

test("readiness blocks an active client and detects a settled request between observations", () => {
  const tracker = new RenderBenchmarkReadinessTracker({ stableResidencyMs: 0, minimumStableSamples: 2 });
  const first = tracker.observe(telemetry(0), renderer, clients());
  assert.deepEqual(first.blockingReasons, ["stable-window-incomplete"]);

  const settled = tracker.observe(telemetry(1), renderer, clients({ light: { generation: 1 } }));
  assert.deepEqual(settled.blockingReasons, ["resource-signature-changing", "stable-window-incomplete"]);

  const pending = new RenderBenchmarkReadinessTracker({ stableResidencyMs: 0, minimumStableSamples: 2 });
  const blocked = pending.observe(telemetry(0), renderer, clients({ creatureModels: { pending: 1 } }));
  assert.deepEqual(blocked.blockingReasons, ["creature-models-pending"]);
});

test("renderer character-atlas work blocks and its short settle changes the signature", () => {
  const tracker = new RenderBenchmarkReadinessTracker({ stableResidencyMs: 0, minimumStableSamples: 2 });
  const first = tracker.observe(telemetry(0), { ...renderer, characterAtlasGeneration: 0 }, clients());
  assert.deepEqual(first.blockingReasons, ["stable-window-incomplete"]);
  const settled = tracker.observe(telemetry(1), { ...renderer, characterAtlasGeneration: 1 }, clients());
  assert.ok(settled.blockingReasons.includes("resource-signature-changing"));

  const pending = new RenderBenchmarkReadinessTracker({ stableResidencyMs: 0, minimumStableSamples: 2 });
  const blocked = pending.observe(telemetry(0), { ...renderer, characterAtlasPending: 1 }, clients());
  assert.deepEqual(blocked.blockingReasons, ["character-atlas-pending"]);

  for (const [field, reason] of [
    ["modelTexturesErrors", "model-textures-errors"],
    ["worldTexturesErrors", "world-textures-errors"],
    ["characterAtlasErrors", "character-atlas-errors"],
  ]) {
    const failed = new RenderBenchmarkReadinessTracker({ stableResidencyMs: 0, minimumStableSamples: 2 });
    const error = failed.observe(telemetry(0), { ...renderer, [field]: 1 }, clients());
    assert.deepEqual(error.blockingReasons, [reason]);
  }
});

test("terminal terrain and client errors remain explicit readiness blockers", () => {
  const tracker = new RenderBenchmarkReadinessTracker({ stableResidencyMs: 0, minimumStableSamples: 2 });
  const observation = tracker.observe(telemetry(0, {
    resources: {
      terrain: { resident: 0, failed: 1, active: 0, typedPayloadBytes: 0 },
      terrainSplat: { resident: 0, failed: 1, active: 0, decodedLayerBytes: 0, layerRequestEntries: 0 },
      environment: {
        residentTiles: 0, knownMissingTiles: 0, failedTiles: 1, activeTiles: 0,
        residentObjects: 0, residentModels: 0, knownMissingModels: 0, deferredModels: 0,
        failedModels: 1, queuedModels: 0, activeModels: 0, queuedGroups: 0, activeGroups: 0,
        deferredGroups: 0, failedGroups: 0,
        residentAnimations: 0, failedAnimations: 1, deferredAnimations: 0, queuedAnimations: 0, activeAnimations: 0,
      },
    },
  }), renderer, clients({ horizon: { error: 1 } }));
  assert.ok(observation.blockingReasons.includes("terrain-failed"));
  assert.ok(observation.blockingReasons.includes("terrain-splat-failed"));
  assert.ok(observation.blockingReasons.includes("environment-tiles-failed"));
  assert.ok(observation.blockingReasons.includes("environment-models-failed"));
  assert.ok(observation.blockingReasons.includes("environment-animations-failed"));
  assert.ok(observation.blockingReasons.includes("horizon-errors"));
  assert.equal(observation.ready, false);
});

test("finite environment model backoff remains readiness work", () => {
  const tracker = new RenderBenchmarkReadinessTracker({ stableResidencyMs: 0, minimumStableSamples: 2 });
  const observation = tracker.observe(telemetry(0, {
    resources: {
      environment: {
        residentTiles: 0, knownMissingTiles: 0, failedTiles: 0, activeTiles: 0,
        residentObjects: 0, residentModels: 0, knownMissingModels: 0, deferredModels: 1,
        failedModels: 0, queuedModels: 0, activeModels: 0, queuedGroups: 0, activeGroups: 0,
        deferredGroups: 0, failedGroups: 0,
        residentAnimations: 0, failedAnimations: 0, deferredAnimations: 0, queuedAnimations: 0, activeAnimations: 0,
      },
    },
  }), renderer, clients());
  assert.deepEqual(observation.blockingReasons, ["environment-models-deferred"]);
});

test("missing live client aggregate is an explicit fail-closed blocker", () => {
  const tracker = new RenderBenchmarkReadinessTracker({ stableResidencyMs: 0, minimumStableSamples: 2 });
  const missing = tracker.observe({ ...telemetry(0), benchmarkClients: undefined }, renderer);
  assert.deepEqual(missing.blockingReasons, ["client-readiness-missing"]);
});

test("captured client readiness is a deep immutable snapshot", () => {
  const input = clients();
  const snapshot = makeRenderTelemetrySnapshot(0, { count: 0 }, undefined, {}, input);
  input.light.pending = 9;
  input.light.generation = 4;
  assert.deepEqual(snapshot.benchmarkClients.light, { pending: 0, success: 0, error: 0, generation: 0 });
  assert.ok(Object.isFrozen(snapshot.benchmarkClients));
  assert.ok(Object.isFrozen(snapshot.benchmarkClients.light));
});
