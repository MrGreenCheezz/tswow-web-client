import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  LiveFormalRenderBenchmarkHost,
  createLiveFormalRenderBenchmarkHost,
  formalBenchmarkActivityStamp,
  formalBenchmarkResourceCheckpoint,
  isLiveFormalRenderBenchmarkHost,
} from "../dist/code/browser/LiveFormalRenderBenchmarkHost.js";
import { formalRenderBenchmarkExclusiveActive } from "../dist/code/browser/RenderBenchmarkExclusiveLease.js";
import { EnvironmentClient } from "../dist/code/browser/Terrain.js";

const clients = Object.freeze(Object.fromEntries([
  "light", "liquids", "groundCover", "horizon", "transportPaths", "creatureModels",
  "creatureMetadata", "gameObjectMetadata", "itemMetadata", "collision",
].map((key, generation) => [key, Object.freeze({ pending: 0, success: 1, error: 0, generation })])));

function frame(frameIndex) {
  return {
    frameIndex,
    yaw: frameIndex * 0.01,
    pitch: -0.4,
    distance: 18,
    view: 18,
    viewPitch: -0.4,
    zoom: 18,
    wallView: null,
    terrainView: null,
    pivotHeight: 1.5,
    eyeHeight: 1.7,
  };
}

function snapshot(frameCount = 3) {
  return {
    schemaVersion: 1,
    scenarioId: "goldshire-exterior",
    mapId: 0,
    selfGuid: "1",
    targetGuid: null,
    focusGuid: null,
    halfMinute: 1440,
    weather: { state: 0, intensity: 0, abrupt: false },
    rngSeed: 123,
    frameStepMs: 1000 / 60,
    frames: Array.from({ length: frameCount }, (_, index) => frame(index)),
    objects: [{
      guid: "1",
      typeId: 4,
      position: { x: -9461.82, y: 63.31, z: 56.23, orientation: 0 },
      movementFlags: 0,
      updateFlags: 0,
      targetGuid: null,
      runSpeed: 7,
      turnRate: 3.14,
      transport: null,
      transportTime: null,
      speeds: [],
      fields: [],
    }],
    expectations: {
      scene: "exterior",
      indoors: false,
      underwater: false,
      precipitation: false,
      rainIntensity: 0,
    },
  };
}

function configuration(anisotropy = false) {
  return {
    lighting: 1,
    settings: {
      renderScale: 100,
      wmoOcclusion: true,
      characterAtlasAnisotropy: anisotropy,
      grassRadius: 50,
      grassDense: true,
    },
  };
}

function epoch(index = 0) {
  return Object.freeze({ suiteNonce: "suite-live-test", epochNonce: `epoch-${index}` });
}

function environment(config) {
  return {
    canvas: {
      cssWidth: 1920,
      cssHeight: 1080,
      backingWidth: 1920,
      backingHeight: 1080,
      systemDpr: 1,
      effectivePixelRatio: 1,
      renderScalePercent: config.settings.renderScale,
    },
    lighting: config.lighting,
    browser: { name: "Fake", version: "1" },
    webgl: { version: "WebGL 2.0", shadingLanguageVersion: "GLSL", extensions: [] },
    settings: config.settings,
  };
}

function accounting() {
  const common = { uniqueResources: 0, owners: 0, references: 0, sharedResources: 0 };
  return {
    cpu: { ...common, uniqueRetainedBytes: 0 },
    gpuBuffers: { ...common, estimatedGpuBufferBytes: 0 },
    unsupported: { ...common },
    coverage: { complete: true, gaps: [] },
  };
}

function rendererTelemetry(pending = 0) {
  const frames = { count: 0, average: 0, p50: 0, p95: 0, p99: 0, worst: 0, longFrames: 0 };
  return {
    cpu: frames,
    gpu: { status: "pending", pending, dropped: 0 },
    observedFps: 60,
    drawCalls: 9,
    triangles: 100,
    unitsDrawn: 1,
    unitsDropped: 0,
    gameObjectsDrawn: 2,
    gameObjectsDropped: 0,
    effectsDrawn: 0,
    effectsDropped: 0,
    groundCoverDrawn: 5,
    groundCoverSelected: 5,
    groundCoverSelectionDroppedCells: 0,
    groundCoverResidentMeshes: 1,
    wmoPortalModels: 0,
    wmoPortalCandidates: 0,
    wmoPortalCulled: 0,
    textureCount: 3,
    geometryCount: 4,
  };
}

function telemetry(capturedAt, pending = 0) {
  return {
    capturedAt,
    fullFrame: { count: 0, average: 0, p50: 0, p95: 0, p99: 0, worst: 0, longFrames: 0 },
    renderer: rendererTelemetry(pending),
    resources: {
      terrain: { resident: 1, failed: 0, active: 0, typedPayloadBytes: 32 },
      terrainSplat: { resident: 1, failed: 0, active: 0, decodedLayerBytes: 64, layerRequestEntries: 1 },
      environment: {
        residentTiles: 1, knownMissingTiles: 0, failedTiles: 0, activeTiles: 0,
        residentObjects: 1, residentModels: 1, knownMissingModels: 0, deferredModels: 0,
        failedModels: 0, queuedModels: 0, activeModels: 0, queuedGroups: 0, activeGroups: 0,
        deferredGroups: 0, failedGroups: 0,
        residentAnimations: 0, failedAnimations: 0, deferredAnimations: 0, queuedAnimations: 0, activeAnimations: 0,
      },
      assetWarmup: { accepted: 1, queued: 0, active: 0, closed: false },
      accounting: accounting(),
    },
    benchmarkClients: clients,
  };
}

class FakeRenderer {
  replayEpochActive = false;
  serial = 40;
  beginCount = 0;
  resetGpuCount = 0;
  drawCalls = [];
  settingsCalls = [];
  groundCoverClients = [];
  unitActionCalls = [];
  portraitTargetsCalls = [];
  stateVisualCalls = [];
  clearSpellVisualCalls = 0;
  clearPortraitCalls = 0;
  portraitRenderCalls = 0;
  persistentStateVisuals = 0;
  gpuQueriesPending = 0;
  order = [];
  isolationActive = false;
  lightingQuality = 2;
  renderScalePercent = 75;
  wmoOcclusion = false;
  characterAtlasAnisotropy = false;
  grassRadius = 20;
  grassDense = false;
  surface = {
    cssWidth: 1920,
    cssHeight: 1080,
    backingWidth: 1920,
    backingHeight: 1080,
    systemDpr: 1,
    effectivePixelRatio: 1,
    contextLost: false,
    contextGeneration: 0,
  };

  get weatherStorm() { return 0; }
  get benchmarkGraphicsConfiguration() {
    return {
      lightingQuality: this.lightingQuality,
      renderScalePercent: this.renderScalePercent,
      wmoOcclusion: this.wmoOcclusion,
      characterAtlasAnisotropy: this.characterAtlasAnisotropy,
      grassRadius: this.grassRadius,
      grassDense: this.grassDense,
    };
  }
  get formalRenderSurfaceStamp() { return { ...this.surface }; }
  get benchmarkReadiness() {
    return {
      renderFrameActive: false,
      gpuQueriesPending: this.gpuQueriesPending,
      modelTexturesPending: 0,
      modelTexturesErrors: 0,
      modelTexturesGeneration: 8,
      worldTexturesPending: 0,
      worldTexturesErrors: 0,
      worldTexturesGeneration: 9,
      groundCoverModelsPending: 0,
      transientVisuals: 0,
      persistentStateVisuals: this.persistentStateVisuals,
      pendingVisualAnimations: 0,
      pendingUnitActions: 0,
      pendingGameObjectAnimations: 0,
      characterAtlasPending: 0,
      characterAtlasErrors: 0,
      characterAtlasGeneration: 7,
    };
  }
  beginFormalBenchmarkIsolation() { this.isolationActive = true; }
  endFormalBenchmarkIsolation() { this.isolationActive = false; }
  resetRenderEvolutionClock() {}
  resetFrameCadence() {}
  resetGpuTimingEpoch() { this.resetGpuCount++; return "unsupported"; }
  setLightingQuality(value) { this.lightingQuality = value; this.settingsCalls.push(["lighting", value]); }
  setRenderScale(value) { this.renderScalePercent = value * 100; this.settingsCalls.push(["scale", value]); }
  setWmoOcclusion(value) { this.wmoOcclusion = value; this.settingsCalls.push(["wmo", value]); }
  setCharacterAtlasAnisotropy(value) {
    this.characterAtlasAnisotropy = value;
    this.settingsCalls.push(["atlas", value]);
  }
  setGroundCover(client, radius, dense) {
    this.groundCoverClients.push(client);
    if (radius !== undefined) this.grassRadius = radius;
    if (dense !== undefined) this.grassDense = dense;
    this.settingsCalls.push(["grass", radius, dense]);
  }
  setWeather() {}
  setIndoors() {}
  updateLighting() {}
  setSelection() {}
  playSpellVisual() { throw new Error("suppressed spell visual reached renderer"); }
  cancelSpellVisual() { throw new Error("suppressed spell cancellation reached renderer"); }
  retimeSpellVisual() { throw new Error("suppressed spell retime reached renderer"); }
  setStateVisuals(value) { this.stateVisualCalls.push(value); }
  clearSpellVisuals() { this.clearSpellVisualCalls++; }
  clearPortraits() { this.clearPortraitCalls++; }
  setPortraitTargets(targets) { this.portraitTargetsCalls.push(targets); }
  renderPortraits() { this.portraitRenderCalls++; return 1; }
  playUnitAction(...args) { this.unitActionCalls.push(args); }
  resetReplayEpoch() { this.replayEpochActive = true; }
  endReplayEpoch() { this.replayEpochActive = false; }
  beginRenderFrame() { this.beginCount++; this.order.push("begin"); }
  endRenderFrame() { this.order.push("end"); return 0.25; }
  draw(...args) {
    this.order.push("draw");
    this.drawCalls.push(args);
    return Object.freeze({ submitted: true, submissionSerial: ++this.serial });
  }
}

function makeHarness(options = {}) {
  const renderer = new FakeRenderer();
  const resourceFrameEvents = [];
  let clock = 0;
  let nextHandle = 1;
  let pendingGpu = 0;
  let wakeCount = 0;
  let frameCount = 0;
  let clearPendingOnFrame = options.clearPendingOnFrame ?? false;
  const cancelledFrames = new Set();
  const cancelledWakes = new Set();
  let userGraphics = {
    lightingQuality: 2,
    renderScalePercent: 75,
    wmoOcclusion: false,
    characterAtlasAnisotropy: false,
    grassRadius: 20,
    grassDense: false,
  };
  const context = {
    renderer,
    terrain: { heightAt: () => 10, liquidAt: () => undefined },
    terrainSplat: {},
    groundCover: {},
    light: { sample: () => undefined },
    liquids: {},
    environment: options.environment ?? {
      beginResourceFrame() { resourceFrameEvents.push("begin"); },
      endResourceFrame() { resourceFrameEvents.push("end"); },
      objectsAround: () => [],
    },
    assetWarmup: { tick: options.assetWarmupTick ?? (() => {}) },
    creatureModels: { get: () => undefined },
    creatureMetadata: {},
    itemMetadata: {},
    factions: { ready: true },
    gameObjectMetadata: { get: () => undefined, revision: 0 },
    transportPaths: {},
    horizon: {},
    collision: {
      refresh() {},
      staticWmoFloorUnder: () => undefined,
      world: { indoorsAt: () => false },
      models: { model: () => undefined },
    },
  };
  const bindings = {
    captureTelemetry: (capturedAt) => Object.freeze({
      ...telemetry(capturedAt, pendingGpu),
      benchmarkClients: options.captureClientReadiness?.() ?? clients,
    }),
    captureClientReadiness: options.captureClientReadiness ?? (() => clients),
    captureUserGraphics: () => ({ ...userGraphics }),
    unitModel: () => undefined,
    mountModel: () => undefined,
    selectionRingColour: () => 0xffffff,
  };
  const host = new LiveFormalRenderBenchmarkHost(
    options.captureEnvironment ?? ((config) => environment(config)),
    {
      context,
      now: options.now ?? (() => clock),
      requestFrame: options.requestFrame ?? ((callback) => {
        const handle = nextHandle++;
        queueMicrotask(() => {
          if (cancelledFrames.delete(handle)) return;
          frameCount++;
          clock += options.frameAdvance ?? 1_000;
          if (clearPendingOnFrame) {
            pendingGpu = 0;
            renderer.gpuQueriesPending = 0;
          }
          callback(clock);
        });
        return handle;
      }),
      cancelFrame: options.cancelFrame ?? ((handle) => { cancelledFrames.add(handle); }),
      scheduleWake: options.scheduleWake ?? ((callback, delayMs) => {
        const handle = nextHandle++;
        queueMicrotask(() => {
          if (cancelledWakes.delete(handle)) return;
          wakeCount++;
          clock += delayMs;
          callback();
        });
        return handle;
      }),
      cancelWake: options.cancelWake ?? ((handle) => { cancelledWakes.add(handle); }),
      prewarmChunkFrames: options.prewarmChunkFrames ?? 2,
      prewarmTimeoutMs: options.prewarmTimeoutMs ?? 20_000,
      gpuDrainTimeoutMs: options.gpuDrainTimeoutMs ?? 5_000,
      waitTimeoutMs: options.waitTimeoutMs ?? 5_000,
      bindings,
    },
  );
  return {
    host,
    renderer,
    context,
    setPendingGpu(value) {
      pendingGpu = value;
      renderer.gpuQueriesPending = value;
    },
    setClearPendingOnFrame(value) { clearPendingOnFrame = value; },
    setUserGraphics(value) { userGraphics = { ...value }; },
    get clock() { return clock; },
    get wakeCount() { return wakeCount; },
    get frameCount() { return frameCount; },
    resourceFrameEvents,
  };
}

async function readyHost(harness, replay = snapshot()) {
  const lease = await harness.host.acquireExclusiveLease();
  const identity = epoch();
  harness.host.applyVariant(lease, identity, "A", configuration());
  await harness.host.prewarm(lease, identity, replay);
  harness.host.resetReplayEpoch(lease, identity, replay);
  return { lease, identity };
}

test("live host has unforgeable provenance and its lease gates ordinary RAF work", async () => {
  const harness = makeHarness();
  const production = createLiveFormalRenderBenchmarkHost(() => environment(configuration()));
  assert.equal(isLiveFormalRenderBenchmarkHost(production), true);
  assert.equal(isLiveFormalRenderBenchmarkHost(harness.host), false,
    "an injected seam instance must never mint formal provenance");
  assert.equal(isLiveFormalRenderBenchmarkHost(Object.create(LiveFormalRenderBenchmarkHost.prototype)), false);
  assert.equal(formalRenderBenchmarkExclusiveActive(), false);
  const lease = await harness.host.acquireExclusiveLease();
  try {
    assert.equal(formalRenderBenchmarkExclusiveActive(), true);
    assert.throws(() => harness.host.applyVariant({ release() {} }, epoch(), "A", configuration()), /lease is not active/);
    const identity = epoch();
    harness.host.applyVariant(lease, identity, "A", configuration());
    await assert.rejects(
      harness.host.prewarm(lease, Object.freeze({ ...identity }), snapshot()),
      /epoch identity is not active/,
      "equal nonce strings cannot replace the runner-owned epoch object",
    );
  } finally {
    await lease.release();
    await lease.release();
  }
  assert.equal(formalRenderBenchmarkExclusiveActive(), false);
});

test("release restores every graphics knob and resumes RAF even when one setter fails", async () => {
  const harness = makeHarness();
  const originalScale = harness.renderer.setRenderScale.bind(harness.renderer);
  harness.renderer.setRenderScale = (value) => {
    originalScale(value);
    if (value === 0.75) throw new Error("restore scale failed");
  };
  const lease = await harness.host.acquireExclusiveLease();
  harness.host.applyVariant(lease, epoch(), "A", configuration());
  await assert.rejects(lease.release(), /restore scale failed/);
  assert.equal(formalRenderBenchmarkExclusiveActive(), false);
  assert.deepEqual(harness.renderer.settingsCalls.slice(-5), [
    ["lighting", 2], ["scale", 0.75], ["wmo", false], ["atlas", false], ["grass", 20, false],
  ]);
  await lease.release();
});

test("prewarm traverses every fixed frame without GPU begin, then render wraps the actual receipt and ticket time", async () => {
  const harness = makeHarness();
  const replay = snapshot(3);
  const { lease, identity } = await readyHost(harness, replay);
  try {
    assert.ok(harness.renderer.drawCalls.length >= 3, "every prewarm camera frame submits the real scene path");
    assert.deepEqual(
      harness.renderer.drawCalls.slice(0, 3).map((draw) => draw[7]),
      replay.frames.map((item) => item.yaw),
      "the initial traversal preserves the complete deterministic camera order",
    );
    assert.equal(harness.renderer.beginCount, 0, "prewarm never opens a renderer/GPU frame");
    assert.deepEqual(harness.resourceFrameEvents.slice(0, 6),
      ["begin", "end", "begin", "end", "begin", "end"],
      "each submitted formal preparation commits one closed environment resource frame");
    await harness.host.captureBarrier(lease, identity, "start");
    harness.renderer.order.length = 0;
    const ticket = { frameIndex: 0, nowMs: 0, elapsedSeconds: 0 };
    const receipt = harness.host.renderFrame(lease, identity, ticket, replay.frames[0]);
    assert.equal(receipt.submissionSerial, harness.renderer.serial);
    assert.equal(receipt.submitted, true);
    assert.equal(receipt.rendererFrameCpuMs, 0.25);
    assert.equal(receipt.completedAtWallMs, harness.clock);
    assert.equal(receipt.suiteNonce, identity.suiteNonce);
    assert.equal(receipt.epochNonce, identity.epochNonce);
    const draw = harness.renderer.drawCalls.at(-1);
    assert.strictEqual(draw.at(-2), ticket, "renderer receives the exact fixed ticket object");
    assert.equal(draw.at(-1), 0, "formal rendering supplies the matching game-object metadata revision");
    assert.equal(harness.renderer.beginCount, 1);
    assert.deepEqual(harness.renderer.order, ["begin", "draw", "end"],
      "the renderer/GPU timing envelope contains only the world submission");
  } finally {
    harness.host.endReplayEpoch(lease, identity);
    await lease.release();
  }
  assert.deepEqual(harness.renderer.settingsCalls.slice(-5), [
    ["lighting", 2], ["scale", 0.75], ["wmo", false], ["atlas", false], ["grass", 20, false],
  ], "release restores the captured user settings without persistence");
});

test("formal transient animation demand is framed and respects backoff across reset-only preparation", async () => {
  const originalFetch = globalThis.fetch;
  let animationRequests = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/visual/animations")) {
      animationRequests++;
      return { ok: false, status: 500 };
    }
    return { ok: false, status: 404 };
  };
  try {
    const environmentClient = new EnvironmentClient("ws://example.test/world", () => 0, 64, 256, 8);
    const formalEnvironment = {
      beginResourceFrame: () => environmentClient.beginResourceFrame(),
      endResourceFrame: () => environmentClient.endResourceFrame(),
      objectsAround: (...args) => {
        environmentClient.animations("Transient.m2", 1, "critical");
        return environmentClient.objectsAround(...args);
      },
    };
    const harness = makeHarness({ environment: formalEnvironment });
    const replay = snapshot(1);
    const lease = await harness.host.acquireExclusiveLease();
    const identity = epoch();
    try {
      harness.host.applyVariant(lease, identity, "A", configuration());
      await harness.host.prewarm(lease, identity, replay);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(animationRequests, 1);
      assert.equal(environmentClient.stats.deferredAnimations, 1,
        "the transient failure remains demand-owned and deferred after formal prewarm");

      // resetReplayEpoch prepares frame zero but does not draw it; it must not replace the live
      // prewarm footprint or immediately re-request a failure whose 2s deadline has not arrived.
      harness.host.resetReplayEpoch(lease, identity, replay);
      await harness.host.captureBarrier(lease, identity, "start");
      harness.host.renderFrame(
        lease, identity, { frameIndex: 0, nowMs: 0, elapsedSeconds: 0 }, replay.frames[0],
      );
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(animationRequests, 1, "formal reset/render must preserve retry backoff");
      assert.equal(environmentClient.stats.deferredAnimations, 1);
    } finally {
      if (harness.renderer.replayEpochActive) harness.host.endReplayEpoch(lease, identity);
      await lease.release();
      environmentClient.dispose();
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("formal resource frame closes when preparation throws before renderer submission", async () => {
  const harness = makeHarness();
  const replay = snapshot(1);
  const { lease, identity } = await readyHost(harness, replay);
  try {
    await harness.host.captureBarrier(lease, identity, "start");
    harness.context.environment.objectsAround = () => {
      throw new Error("formal resource preparation failed");
    };
    assert.throws(
      () => harness.host.renderFrame(
        lease, identity, { frameIndex: 0, nowMs: 0, elapsedSeconds: 0 }, replay.frames[0],
      ),
      /formal resource preparation failed/,
    );
    assert.deepEqual(harness.resourceFrameEvents.slice(-2), ["begin", "end"]);
  } finally {
    if (harness.renderer.replayEpochActive) harness.host.endReplayEpoch(lease, identity);
    await lease.release();
  }
});

test("prewarm keeps rendering the deterministic path so accessor-driven backoff can retry", async () => {
  let ticks = 0;
  let settled = false;
  const captureClientReadiness = () => Object.freeze({
    ...clients,
    creatureModels: Object.freeze({
      ...clients.creatureModels,
      pending: settled ? 0 : 1,
      generation: settled ? 1 : 0,
    }),
  });
  const harness = makeHarness({
    frameAdvance: 1_000,
    prewarmChunkFrames: 1,
    assetWarmupTick: () => {
      ticks++;
      if (ticks >= 2) settled = true;
    },
    captureClientReadiness,
  });

  const lease = await harness.host.acquireExclusiveLease();
  const identity = epoch();
  try {
    harness.host.applyVariant(lease, identity, "A", configuration());
    // The single initial frame leaves the simulated accessor retry pending. A second deterministic
    // submission from the readiness loop settles it; a wait-only implementation times out here.
    await harness.host.prewarm(lease, identity, snapshot(1));
    assert.ok(ticks >= 2);
    assert.equal(settled, true);
    assert.equal(harness.renderer.beginCount, 0, "retry pumping never opens a GPU query");
  } finally {
    await lease.release();
  }
});

test("persistent state visuals fail prewarm before the 5400-frame path is submitted", async () => {
  const harness = makeHarness();
  harness.renderer.persistentStateVisuals = 1;
  const lease = await harness.host.acquireExclusiveLease();
  const identity = epoch();
  try {
    harness.host.applyVariant(lease, identity, "A", configuration());
    await assert.rejects(
      harness.host.prewarm(lease, identity, snapshot(5_400)),
      /terminal readiness blocker.*persistent-state-visuals-active/,
    );
    assert.equal(harness.renderer.drawCalls.length, 0,
      "a terminal renderer state is rejected before any prewarm draw");
  } finally {
    await lease.release();
  }
});

test("barrier uses one timestamp, owns immutable evidence, and excludes volatile draw counters", async () => {
  const harness = makeHarness();
  const replay = snapshot();
  const { lease, identity } = await readyHost(harness, replay);
  try {
    const barrier = await harness.host.captureBarrier(lease, identity, "start");
    assert.equal(barrier.capturedAt, barrier.readiness.capturedAt);
    assert.equal(barrier.suiteNonce, identity.suiteNonce);
    assert.equal(barrier.epochNonce, identity.epochNonce);
    assert.equal(Object.isFrozen(barrier), true);
    assert.equal(Object.isFrozen(barrier.environment.settings), true);
    assert.equal(Object.isFrozen(barrier.observation.weather), true);
    assert.equal(barrier.resources.counters["renderer.drawCalls"], undefined);
    assert.equal(barrier.resources.counters["renderer.triangles"], undefined);
    assert.equal(barrier.resources.counters["renderer.textureCount"], 3);
    assert.match(barrier.activityStamp, /characterAtlas/);
    assert.equal(barrier.observation.indoors, false);
    assert.equal(barrier.observation.underwater, false);
  } finally {
    harness.host.endReplayEpoch(lease, identity);
    await lease.release();
  }
});

test("an external renderer setter during exclusive ownership makes the next barrier fail closed", async () => {
  const harness = makeHarness();
  const replay = snapshot();
  const { lease, identity } = await readyHost(harness, replay);
  try {
    harness.renderer.setWmoOcclusion(false);
    harness.renderer.setWmoOcclusion(true);
    await assert.rejects(
      harness.host.captureBarrier(lease, identity, "start"),
      /graphics configuration drifted at wmoOcclusion/,
    );
  } finally {
    await lease.release();
  }
});

test("setGroundCover(undefined) executes but permanently taints the active formal lease", async () => {
  const harness = makeHarness();
  const { lease, identity } = await readyHost(harness);
  try {
    harness.context.groundCover = undefined;
    harness.renderer.setGroundCover(undefined);
    assert.strictEqual(harness.renderer.groundCoverClients.at(-1), undefined,
      "disconnect cleanup is not swallowed by the exclusive host");
    await assert.rejects(
      harness.host.captureBarrier(lease, identity, "start"),
      /graphics configuration drifted at groundCover: external setGroundCover/,
    );
  } finally {
    await lease.release();
  }
  assert.strictEqual(harness.renderer.groundCoverClients.at(-1), undefined);
});

test("replay-irrelevant transient unit actions are suppressed without tainting the suite", async () => {
  const harness = makeHarness();
  const replay = snapshot();
  const { lease, identity } = await readyHost(harness, replay);
  try {
    await harness.host.captureBarrier(lease, identity, "start");
    harness.renderer.playUnitAction(1n, "attack");
    assert.deepEqual(harness.renderer.unitActionCalls, [],
      "the fixed replay renderer never receives the live action");
    const receipt = harness.host.renderFrame(
      lease, identity, { frameIndex: 0, nowMs: 0, elapsedSeconds: 0 }, replay.frames[0],
    );
    assert.equal(receipt.submitted, true);
  } finally {
    await lease.release();
  }
});

test("spell, state-visual, and portrait ingress is isolated then reconciled on release", async () => {
  const harness = makeHarness();
  const { lease } = await readyHost(harness);
  const stateVisuals = new Map([[1n, [{ spellId: 7, path: "spell/state.m2", attachment: 0, scale: 1 }]]]);
  const portraitTargets = new Map([["player", { guid: 1n, canvas: undefined }]]);

  const handle = harness.renderer.playSpellVisual({ instances: [], animations: [] });
  assert.ok(handle.id < 0, "suppressed casts still receive an opaque cancellable handle");
  harness.renderer.cancelSpellVisual(handle);
  harness.renderer.retimeSpellVisual(handle, 10);
  harness.renderer.clearSpellVisuals();
  harness.renderer.setStateVisuals(stateVisuals);
  harness.renderer.clearPortraits();
  harness.renderer.setPortraitTargets(portraitTargets);
  assert.equal(harness.renderer.renderPortraits(), 0);
  assert.equal(harness.renderer.clearSpellVisualCalls, 0);
  assert.equal(harness.renderer.stateVisualCalls.length, 0);
  assert.equal(harness.renderer.clearPortraitCalls, 0);
  assert.equal(harness.renderer.portraitTargetsCalls.length, 0);

  await lease.release();
  assert.equal(harness.renderer.isolationActive, false);
  assert.equal(harness.renderer.clearSpellVisualCalls, 1);
  assert.deepEqual([...harness.renderer.stateVisualCalls.at(-1)], [...stateVisuals]);
  assert.equal(harness.renderer.clearPortraitCalls, 1);
  assert.deepEqual([...harness.renderer.portraitTargetsCalls.at(-1)], [...portraitTargets]);
});

test("clearSpellVisuals supersedes an earlier deferred state-visual map", async () => {
  const harness = makeHarness();
  const { lease } = await readyHost(harness);
  const stateVisuals = new Map([[1n, [{ spellId: 7, path: "spell/state.m2", attachment: 0, scale: 1 }]]]);

  harness.renderer.setStateVisuals(stateVisuals);
  harness.renderer.clearSpellVisuals();
  await lease.release();

  assert.equal(harness.renderer.clearSpellVisualCalls, 1);
  assert.equal(harness.renderer.stateVisualCalls.length, 0,
    "release must not replay state visuals cleared during exclusive ownership");
});

test("waitUntil uses an absolute abortable timer instead of display RAF cadence", async () => {
  const harness = makeHarness({ frameAdvance: 1_000 / 59.94 });
  const { lease, identity } = await readyHost(harness);
  try {
    await harness.host.captureBarrier(lease, identity, "start");
    const frameCount = harness.frameCount;
    const wakeCount = harness.wakeCount;
    const dueAt = harness.clock + 1_000 / 60;
    const wokeAt = await harness.host.waitUntil(lease, identity, dueAt);
    assert.equal(wokeAt, dueAt);
    assert.equal(harness.frameCount, frameCount, "measured cadence does not wait for the 59.94 Hz RAF");
    assert.equal(harness.wakeCount, wakeCount + 1);
  } finally {
    await lease.release();
  }
});

test("environment evidence rejects thenables instead of holding the lease indefinitely", async () => {
  const harness = makeHarness({ captureEnvironment: () => Promise.resolve(environment(configuration())) });
  const lease = await harness.host.acquireExclusiveLease();
  const identity = epoch();
  try {
    harness.host.applyVariant(lease, identity, "A", configuration());
    await assert.rejects(
      harness.host.prewarm(lease, identity, snapshot()),
      /captureEnvironment must be synchronous/,
    );
  } finally {
    await lease.release();
  }
});

test("actual renderer readback catches a silently clamped formal setting", async () => {
  const harness = makeHarness();
  harness.renderer.setRenderScale = function(value) {
    this.renderScalePercent = Math.min(value, 0.5) * 100;
    this.settingsCalls.push(["scale", value]);
  };
  const lease = await harness.host.acquireExclusiveLease();
  try {
    assert.throws(
      () => harness.host.applyVariant(lease, epoch(), "A", configuration()),
      /graphics configuration drifted at renderScalePercent/,
    );
  } finally {
    await lease.release();
  }
});

test("every measured submission is bound to one exact surface and WebGL context epoch", async () => {
  const harness = makeHarness();
  const replay = snapshot();
  const { lease, identity } = await readyHost(harness, replay);
  try {
    await harness.host.captureBarrier(lease, identity, "start");
    harness.renderer.surface = { ...harness.renderer.surface, backingWidth: 1919 };
    assert.throws(
      () => harness.host.renderFrame(
        lease, identity, { frameIndex: 0, nowMs: 0, elapsedSeconds: 0 }, replay.frames[0],
      ),
      /surface changed during measurement/,
    );
    harness.renderer.surface = {
      ...harness.renderer.surface,
      backingWidth: 1920,
      contextGeneration: 2,
    };
    assert.throws(
      () => harness.host.renderFrame(
        lease, identity, { frameIndex: 0, nowMs: 0, elapsedSeconds: 0 }, replay.frames[0],
      ),
      /WebGL context epoch changed during the suite/,
    );
  } finally {
    await lease.release();
  }
});

test("release reapplies the latest user settings changed during the suite", async () => {
  const harness = makeHarness();
  const lease = await harness.host.acquireExclusiveLease();
  harness.host.applyVariant(lease, epoch(), "A", configuration());
  const latest = {
    lightingQuality: 3,
    renderScalePercent: 60,
    wmoOcclusion: true,
    characterAtlasAnisotropy: true,
    grassRadius: 35,
    grassDense: true,
  };
  harness.setUserGraphics(latest);
  harness.renderer.setLightingQuality(latest.lightingQuality);
  harness.renderer.setRenderScale(latest.renderScalePercent / 100);
  harness.renderer.setWmoOcclusion(latest.wmoOcclusion);
  harness.renderer.setCharacterAtlasAnisotropy(latest.characterAtlasAnisotropy);
  harness.renderer.setGroundCover(harness.context.groundCover, latest.grassRadius, latest.grassDense);
  await lease.release();
  assert.deepEqual(harness.renderer.benchmarkGraphicsConfiguration, latest);
  assert.deepEqual(harness.renderer.settingsCalls.slice(-5), [
    ["lighting", 3], ["scale", 0.6], ["wmo", true], ["atlas", true], ["grass", 35, true],
  ]);
});

test("captured GameContext resources must retain identity for every formal operation", async () => {
  const harness = makeHarness();
  const { lease, identity } = await readyHost(harness);
  try {
    harness.context.groundCover = {};
    await assert.rejects(
      harness.host.captureBarrier(lease, identity, "start"),
      /GameContext resource identity changed: groundCover/,
    );
  } finally {
    await lease.release();
  }
});

test("formal ownership requires faction content to be loaded and remain available", async () => {
  const unavailable = makeHarness();
  unavailable.context.factions.ready = false;
  await assert.rejects(unavailable.host.acquireExclusiveLease(), /faction data is not ready/);

  const harness = makeHarness();
  const { lease, identity } = await readyHost(harness);
  try {
    harness.context.factions.ready = false;
    await assert.rejects(
      harness.host.captureBarrier(lease, identity, "start"),
      /faction data became unavailable/,
    );
  } finally {
    await lease.release();
  }
});

test("GPU drain polls existing telemetry without opening a new query and reports incomplete coverage", async () => {
  const harness = makeHarness({ clearPendingOnFrame: true });
  const replay = snapshot();
  const { lease, identity } = await readyHost(harness, replay);
  try {
    await harness.host.captureBarrier(lease, identity, "start");
    harness.host.renderFrame(lease, identity, { frameIndex: 0, nowMs: 0, elapsedSeconds: 0 }, replay.frames[0]);
    harness.setPendingGpu(1);
    await harness.host.captureBarrier(lease, identity, "measurement-end");
    const begins = harness.renderer.beginCount;
    const drained = await harness.host.drainGpu(lease, identity, harness.clock);
    assert.deepEqual(drained, {
      status: "unavailable", reason: "unsupported", samples: [], attempted: 1, dropped: 1,
    });
    assert.equal(harness.renderer.beginCount, begins, "drain never calls beginRenderFrame");
  } finally {
    harness.host.endReplayEpoch(lease, identity);
    await lease.release();
  }
});

test("post-GPU barrier gets a fresh window to re-establish readiness after pending drain", async () => {
  const harness = makeHarness({ waitTimeoutMs: 2_000 });
  const replay = snapshot();
  const { lease, identity } = await readyHost(harness, replay);
  try {
    await harness.host.captureBarrier(lease, identity, "start");
    harness.host.renderFrame(lease, identity, { frameIndex: 0, nowMs: 0, elapsedSeconds: 0 }, replay.frames[0]);
    harness.setPendingGpu(1);
    const measurementEnd = await harness.host.captureBarrier(lease, identity, "measurement-end");
    assert.equal(measurementEnd.readiness.ready, false);
    assert.ok(measurementEnd.readiness.blockingReasons.includes("gpu-queries-pending"));

    harness.setClearPendingOnFrame(true);
    await harness.host.drainGpu(lease, identity, harness.clock);
    const postDrain = await harness.host.captureBarrier(lease, identity, "post-gpu-drain");
    assert.equal(postDrain.readiness.ready, true);
    assert.ok(postDrain.readiness.stableForMs >= 2_000);
  } finally {
    harness.host.endReplayEpoch(lease, identity);
    await lease.release();
  }
});

test("prewarm readiness has bounded timeout and AbortSignal cleanup", async (context) => {
  await context.test("timeout", async () => {
    let clock = 0;
    const harness = makeHarness({ now: () => ++clock * 10, prewarmTimeoutMs: 15 });
    const lease = await harness.host.acquireExclusiveLease();
    const identity = epoch();
    try {
      harness.host.applyVariant(lease, identity, "A", configuration());
      await assert.rejects(harness.host.prewarm(lease, identity, snapshot()), /prewarm timed out/);
    } finally {
      await lease.release();
    }
  });

  await context.test("abort", async () => {
    const harness = makeHarness();
    const controller = new AbortController();
    const lease = await harness.host.acquireExclusiveLease();
    const identity = epoch();
    try {
      harness.host.applyVariant(lease, identity, "A", configuration());
      controller.abort(new Error("stop prewarm"));
      await assert.rejects(harness.host.prewarm(lease, identity, snapshot(), controller.signal), /stop prewarm/);
    } finally {
      await lease.release();
    }
  });
});

test("a retained RAF cannot outlive the absolute prewarm deadline", async () => {
  let clock = 0;
  let nextHandle = 1;
  const frames = new Map();
  const wakes = new Map();
  const cancelledFrames = [];
  const abortListeners = new Set();
  const signal = {
    aborted: false,
    reason: undefined,
    addEventListener(type, listener) {
      assert.equal(type, "abort");
      abortListeners.add(listener);
    },
    removeEventListener(type, listener) {
      assert.equal(type, "abort");
      abortListeners.delete(listener);
    },
  };
  const harness = makeHarness({
    now: () => clock,
    prewarmChunkFrames: 1,
    prewarmTimeoutMs: 25,
    requestFrame: (callback) => {
      const handle = nextHandle++;
      frames.set(handle, callback);
      return handle;
    },
    cancelFrame: (handle) => {
      cancelledFrames.push(handle);
      frames.delete(handle);
    },
    scheduleWake: (callback, delayMs) => {
      const handle = nextHandle++;
      wakes.set(handle, { callback, dueAt: clock + delayMs });
      return handle;
    },
    cancelWake: (handle) => { wakes.delete(handle); },
  });
  const lease = await harness.host.acquireExclusiveLease();
  const identity = epoch();
  try {
    harness.host.applyVariant(lease, identity, "A", configuration());
    const prewarm = harness.host.prewarm(lease, identity, snapshot(2), signal);
    const rejected = assert.rejects(prewarm, /prewarm timed out/);
    assert.equal(frames.size, 1, "the Chromium RAF callback is retained and never invoked");
    assert.equal(wakes.size, 1, "the deadline watchdog is armed beside RAF");
    assert.equal(abortListeners.size, 1);

    const [wakeHandle, wake] = wakes.entries().next().value;
    wakes.delete(wakeHandle);
    clock = wake.dueAt;
    wake.callback();
    await rejected;

    assert.equal(frames.size, 0, "deadline cancels the retained RAF");
    assert.equal(wakes.size, 0, "the fired deadline timer leaves no pending timer");
    assert.equal(abortListeners.size, 0, "settlement removes the abort listener");
    assert.equal(cancelledFrames.length, 1);
  } finally {
    await lease.release();
  }
  assert.equal(formalRenderBenchmarkExclusiveActive(), false, "timeout cleanup must not leak the exclusive lease");
});

test("synchronous frame settlement cleans the returned handle before arming a timer", async () => {
  let clock = 0;
  let nextHandle = 1;
  const cancelledFrames = [];
  let scheduledWakes = 0;
  const harness = makeHarness({
    now: () => clock,
    prewarmChunkFrames: 1,
    requestFrame: (callback) => {
      const handle = nextHandle++;
      clock += 1_000;
      callback(clock);
      return handle;
    },
    cancelFrame: (handle) => { cancelledFrames.push(handle); },
    scheduleWake: () => {
      scheduledWakes++;
      throw new Error("a settled synchronous RAF must not arm its watchdog");
    },
  });
  const lease = await harness.host.acquireExclusiveLease();
  const identity = epoch();
  try {
    harness.host.applyVariant(lease, identity, "A", configuration());
    await harness.host.prewarm(lease, identity, snapshot(2));
    assert.ok(cancelledFrames.length >= 1);
    assert.equal(scheduledWakes, 0);
  } finally {
    await lease.release();
  }
});

test("synchronous deadline settlement cleans both returned scheduler handles", async () => {
  let clock = 0;
  let nextHandle = 1;
  const frames = new Map();
  const cancelledFrames = [];
  const cancelledWakes = [];
  const harness = makeHarness({
    now: () => clock,
    prewarmChunkFrames: 1,
    prewarmTimeoutMs: 25,
    requestFrame: (callback) => {
      const handle = nextHandle++;
      frames.set(handle, callback);
      return handle;
    },
    cancelFrame: (handle) => {
      cancelledFrames.push(handle);
      frames.delete(handle);
    },
    scheduleWake: (callback, delayMs) => {
      const handle = nextHandle++;
      clock += delayMs;
      callback();
      return handle;
    },
    cancelWake: (handle) => { cancelledWakes.push(handle); },
  });
  const lease = await harness.host.acquireExclusiveLease();
  const identity = epoch();
  try {
    harness.host.applyVariant(lease, identity, "A", configuration());
    await assert.rejects(harness.host.prewarm(lease, identity, snapshot(2)), /prewarm timed out/);
    assert.equal(frames.size, 0);
    assert.deepEqual(cancelledFrames, [1]);
    assert.deepEqual(cancelledWakes, [2]);
  } finally {
    await lease.release();
  }
});

test("pure evidence helpers include all generations and filter only per-frame renderer counters", () => {
  const stamp = formalBenchmarkActivityStamp(clients, {
    characterAtlasGeneration: 77,
    modelTexturesGeneration: 78,
    worldTexturesGeneration: 79,
  });
  for (const key of Object.keys(clients)) assert.match(stamp, new RegExp(key));
  for (const generation of [77, 78, 79]) assert.match(stamp, new RegExp(String(generation)));
  assert.throws(
    () => formalBenchmarkActivityStamp(clients, {
      characterAtlasGeneration: undefined,
      modelTexturesGeneration: 78,
      worldTexturesGeneration: 79,
    }),
    /character atlas generation must be a non-negative safe integer/,
    "mandatory renderer generations fail closed instead of becoming zero or undefined",
  );
  const checkpoint = formalBenchmarkResourceCheckpoint(telemetry(1));
  assert.equal(checkpoint.counters["renderer.drawCalls"], undefined);
  assert.equal(checkpoint.counters["renderer.groundCoverResidentMeshes"], 1);
  assert.equal(Object.isFrozen(checkpoint), true);
});

test("ordinary animate checks the exclusive gate before clocks and every live mutation", async () => {
  const source = await readFile(new URL("../src/browser/game/Loop.ts", import.meta.url), "utf8");
  const animateStart = source.indexOf("export function animate(now: number): void {");
  const animateEnd = source.indexOf("\n}\n\n/** Starts the frame loop", animateStart);
  const animate = source.slice(animateStart, animateEnd);
  const gate = animate.indexOf("if (formalRenderBenchmarkExclusiveActive()) {");
  const rebase = animate.indexOf("lastFrame = now;", gate);
  const rearm = animate.indexOf("requestAnimationFrame(animate);", gate);
  const begin = animate.indexOf("fullFrameClock.begin()");
  const liveFrame = animate.indexOf("frame(now)");
  const outerFinally = animate.lastIndexOf("} finally {", rearm);
  assert.ok(gate >= 0 && rebase > gate && begin > rebase && liveFrame > begin
    && outerFinally > liveFrame && rearm > outerFinally);
  assert.match(animate.slice(gate, begin), /return;/);
  assert.equal((animate.match(/requestAnimationFrame\(animate\)/g) ?? []).length, 1,
    "the exclusive early return and live frame share one guaranteed RAF re-arm");
});
