import assert from "node:assert/strict";
import test from "node:test";

import {
  FORMAL_BENCHMARK_FRAME_COUNT,
  FORMAL_BENCHMARK_FRAME_STEP_MS,
  FORMAL_BENCHMARK_POSITION_TOLERANCE_YARDS,
  FormalRenderBenchmarkRunner,
  buildTrustedFormalBenchmarkReport,
  isTrustedFormalBenchmarkSuiteResult,
} from "../dist/code/browser/FormalRenderBenchmarkRunner.js";
import {
  hashWorldReplayFrameOrder,
  hashWorldReplaySnapshot,
} from "../dist/code/browser/BenchmarkReplay.js";
import {
  hashBenchmarkRuntimeEnvironment,
  hashBenchmarkVariantConfiguration,
} from "../dist/code/browser/RenderBenchmarkIdentity.js";
import { PAIRED_BENCHMARK_ORDER } from "../dist/code/browser/RenderBenchmarkPairing.js";

const QUEUE_COUNTERS = Object.freeze({
  "terrain.active": 0,
  "terrain.failed": 0,
  "terrainSplat.active": 0,
  "terrainSplat.failed": 0,
  "environment.activeTiles": 0,
  "environment.failedTiles": 0,
  "environment.queuedModels": 0,
  "environment.activeModels": 0,
  "environment.deferredModels": 0,
  "environment.failedModels": 0,
  "environment.queuedGroups": 0,
  "environment.activeGroups": 0,
  "environment.deferredGroups": 0,
  "environment.failedGroups": 0,
  "environment.queuedAnimations": 0,
  "environment.deferredAnimations": 0,
  "environment.activeAnimations": 0,
  "environment.failedAnimations": 0,
  "assetWarmup.queued": 0,
  "assetWarmup.active": 0,
});

function cameraFrame(frameIndex) {
  return {
    frameIndex,
    yaw: frameIndex * 0.0001,
    pitch: -0.4,
    distance: 18,
    view: 18,
    viewPitch: -0.4,
    zoom: 1,
    wallView: null,
    terrainView: null,
    pivotHeight: 1.5,
    eyeHeight: 1.7,
  };
}

function snapshot(overrides = {}) {
  return {
    schemaVersion: 1,
    scenarioId: "goldshire-exterior",
    mapId: 0,
    selfGuid: "1",
    targetGuid: null,
    focusGuid: null,
    halfMinute: 1440,
    weather: { state: 0, intensity: 0, abrupt: false },
    rngSeed: 0x12345678,
    frameStepMs: FORMAL_BENCHMARK_FRAME_STEP_MS,
    frames: Array.from({ length: FORMAL_BENCHMARK_FRAME_COUNT }, (_, index) => cameraFrame(index)),
    objects: [{
      guid: "1",
      typeId: 4,
      position: { x: -9461.82, y: 63.31, z: 56.23, orientation: 0.2 },
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
    ...overrides,
  };
}

function environment(overrides = {}) {
  return {
    canvas: {
      cssWidth: 1920,
      cssHeight: 1080,
      backingWidth: 1920,
      backingHeight: 1080,
      systemDpr: 1,
      effectivePixelRatio: 1,
      renderScalePercent: 100,
    },
    lighting: 1,
    browser: { name: "TestBrowser", version: "1" },
    webgl: {
      version: "WebGL 2.0",
      shadingLanguageVersion: "WebGL GLSL ES 3.00",
      extensions: ["EXT_disjoint_timer_query_webgl2"],
    },
    settings: { characterAtlasAnisotropy: false, drawDistance: 300, renderScale: 100 },
    ...overrides,
  };
}

function configurations(overrides = {}) {
  return {
    A: { lighting: 1, settings: { characterAtlasAnisotropy: false, drawDistance: 300, renderScale: 100 } },
    B: { lighting: 1, settings: { characterAtlasAnisotropy: true, drawDistance: 300, renderScale: 100 } },
    ...overrides,
  };
}

function definition(overrides = {}) {
  return {
    snapshot: snapshot(),
    environment: environment(),
    configurations: configurations(),
    comparisonId: "atlas-anisotropy-r1",
    allowedKnobPath: "settings.characterAtlasAnisotropy",
    ...overrides,
  };
}

function variantEnvironment(base, configuration) {
  return {
    ...base,
    lighting: configuration.lighting,
    settings: configuration.settings,
  };
}

class FakeHost {
  constructor({ fault } = {}) {
    this.fault = fault;
    this.variants = [];
    this.events = [];
    this.serial = 0;
    this.runNumber = -1;
    this.currentWall = 0;
    this.configuration = undefined;
    this.released = false;
    this.epoch = undefined;
  }

  async acquireExclusiveLease() {
    this.events.push("acquire");
    return {
      release: async () => {
        this.released = true;
        this.events.push("release");
      },
    };
  }

  async applyVariant(_lease, epoch, variant, configuration) {
    this.runNumber++;
    this.variants.push(variant);
    this.events.push(`apply:${variant}`);
    this.configuration = configuration;
    this.epoch = epoch;
  }

  async prewarm(_lease, epoch) {
    assert.equal(epoch, this.epoch);
    this.events.push("prewarm");
  }

  async resetReplayEpoch(_lease, epoch, fixedSnapshot) {
    assert.equal(epoch, this.epoch);
    assert.equal(fixedSnapshot.frames.length, FORMAL_BENCHMARK_FRAME_COUNT);
    this.events.push("reset");
    if (this.fault === "reset-failure") throw new Error("reset failed");
  }

  async endReplayEpoch(_lease, epoch) {
    assert.equal(epoch, this.epoch);
    this.events.push("end");
  }

  async waitUntil(_lease, epoch, dueAtWallMs) {
    assert.equal(epoch, this.epoch);
    const target = this.fault === "compressed-catch-up"
      && dueAtWallMs > this.currentWall
      && dueAtWallMs < 1_090_000
      ? dueAtWallMs + 10_000
      : dueAtWallMs;
    this.currentWall = Math.max(this.currentWall, target);
    return this.currentWall;
  }

  async renderFrame(_lease, epoch, ticket, frame) {
    assert.equal(epoch, this.epoch);
    assert.equal(frame.frameIndex, ticket.frameIndex);
    if (this.fault === "missing-submission" && ticket.frameIndex === 0) return undefined;
    if (this.fault === "not-submitted" && ticket.frameIndex === 0) {
      return {
        suiteNonce: epoch.suiteNonce, epochNonce: epoch.epochNonce,
        submitted: false, frameIndex: 0, submissionSerial: 0, completedAtWallMs: this.currentWall,
        fullFrameCpuMs: 1, rendererFrameCpuMs: 0.5,
      };
    }
    let serial = ++this.serial;
    if (this.fault === "duplicate-submission" && ticket.frameIndex === 1) serial = this.serial - 1;
    if (this.fault === "out-of-order-submission" && ticket.frameIndex === 1) serial = 0;
    return {
      suiteNonce: epoch.suiteNonce,
      epochNonce: epoch.epochNonce,
      submitted: true,
      frameIndex: this.fault === "mismatched-submission" && ticket.frameIndex === 0 ? 1 : ticket.frameIndex,
      submissionSerial: serial,
      completedAtWallMs: this.currentWall
        + (this.fault === "slow-submission" && ticket.frameIndex === 0 ? FORMAL_BENCHMARK_FRAME_STEP_MS : 0),
      fullFrameCpuMs: this.configuration.settings.characterAtlasAnisotropy ? 1.01 : 1,
      rendererFrameCpuMs: 0.5,
    };
  }

  async drainGpu(_lease, epoch, measurementEndedAt) {
    assert.equal(epoch, this.epoch);
    if (this.fault !== "late-measurement-end") {
      assert.equal(measurementEndedAt, this.currentWall - 1, "GPU drain keeps the scheduler measurement end");
    }
    this.events.push(`drain:${measurementEndedAt}`);
    if (this.fault === "partial-gpu") {
      return {
        status: "unavailable", reason: "context-lost", samples: [2, 3], attempted: 3, dropped: 1,
      };
    }
    if (this.fault === "bad-gpu-coverage") {
      return {
        status: "unavailable", reason: "context-lost", samples: [2, 3], attempted: 4, dropped: 1,
      };
    }
    return { status: "unavailable", reason: "unsupported", samples: [], attempted: 0, dropped: 0 };
  }

  async captureBarrier(_lease, epoch, phase) {
    assert.equal(epoch, this.epoch);
    this.events.push(`barrier:${phase}`);
    if (phase === "start") {
      this.currentWall = this.fault === "stale-start-barrier" && this.runNumber === 1
        ? 1_090_002
        : 1_000_000 + this.runNumber * 100_000;
    } else {
      this.currentWall += this.fault === "late-measurement-end"
        && phase === "measurement-end" ? 251 : 1;
    }
    const capturedAt = this.currentWall;
    if (phase === "start" && this.fault === "validation-delay") this.currentWall += 20;
    const isMeasurementEnd = phase === "measurement-end";
    const isPostGpuDrain = phase === "post-gpu-drain";
    const isFaultedEnd = isMeasurementEnd && this.runNumber === 0;
    const config = this.configuration ?? configurations().A;
    const actualEnvironment = variantEnvironment(environment(), config);
    if (isFaultedEnd && this.fault === "environment-drift") {
      actualEnvironment.canvas = { ...actualEnvironment.canvas, backingWidth: 1279 };
    }
    const resourceSignature = isFaultedEnd && this.fault === "resource-drift" ? "resident:v2" : "resident:v1";
    const activityStamp = isFaultedEnd && this.fault === "activity-drift" ? "activity:1" : "activity:0";
    const counters = isFaultedEnd && this.fault === "resource-map-drift"
      ? { ...QUEUE_COUNTERS, "environment.resident": 1 }
      : QUEUE_COUNTERS;
    const wrongObservation = phase === "start" && this.fault === "wrong-observation";
    const nonGpuMeasurementBlocker = isMeasurementEnd && this.fault === "measurement-non-gpu-blocker";
    const postDrainNotReady = isPostGpuDrain && this.fault === "post-drain-not-ready";
    const pendingGpu = isMeasurementEnd || postDrainNotReady;
    return {
      suiteNonce: epoch.suiteNonce,
      epochNonce: this.fault === "stale-epoch-evidence" && phase === "start"
        ? "stale-epoch"
        : epoch.epochNonce,
      capturedAt,
      readiness: {
        capturedAt,
        ready: !pendingGpu && !nonGpuMeasurementBlocker,
        stableForMs: pendingGpu || nonGpuMeasurementBlocker ? 0 : 2_000,
        stableSamples: pendingGpu || nonGpuMeasurementBlocker ? 0 : 3,
        resourceSignature,
        blockingReasons: nonGpuMeasurementBlocker
          ? ["model-textures-pending"]
          : pendingGpu ? ["gpu-queries-pending"] : [],
      },
      environment: actualEnvironment,
      observation: {
        indoors: wrongObservation,
        underwater: false,
        weather: { state: 0, intensity: 0, abrupt: false },
      },
      resourceSignature,
      activityStamp,
      resources: { counters, bytes: { retained: 4096 } },
    };
  }
}

test("create recomputes and freezes snapshot, frame-order, environment, and configuration identities", async () => {
  const input = definition();
  const expected = await Promise.all([
    hashWorldReplaySnapshot(input.snapshot),
    hashWorldReplayFrameOrder(input.snapshot),
    hashBenchmarkRuntimeEnvironment(input.environment),
    hashBenchmarkVariantConfiguration(variantEnvironment(input.environment, input.configurations.A)),
    hashBenchmarkVariantConfiguration(variantEnvironment(input.environment, input.configurations.B)),
  ]);
  const runner = await FormalRenderBenchmarkRunner.createDiagnosticCandidate(input);
  assert.deepEqual(runner.identity, {
    scenarioId: "goldshire-exterior",
    comparisonId: "atlas-anisotropy-r1",
    allowedKnobPath: "settings.characterAtlasAnisotropy",
    snapshotHash: expected[0],
    frameOrderHash: expected[1],
    environmentHash: expected[2],
    variantConfigHashes: { A: expected[3], B: expected[4] },
  });
  assert.equal(Object.isFrozen(runner.identity), true);
  assert.equal(Object.isFrozen(runner.identity.variantConfigHashes), true);

  input.snapshot.frames[0].yaw = 99;
  input.configurations.B.settings.characterAtlasAnisotropy = false;
  assert.equal(runner.identity.snapshotHash, expected[0], "create owns its validated inputs");
  assert.notEqual(runner.identity.variantConfigHashes.A, runner.identity.variantConfigHashes.B);

  await assert.rejects(
    FormalRenderBenchmarkRunner.createDiagnosticCandidate({ ...definition(), snapshotHash: "0".repeat(64) }),
    /exactly/,
    "caller hashes are not part of the definition boundary",
  );
  await assert.rejects(
    FormalRenderBenchmarkRunner.createDiagnosticCandidate(definition({
      configurations: configurations({
        B: {
          lighting: 1,
          settings: { characterAtlasAnisotropy: "true", drawDistance: 300, renderScale: 100 },
        },
      }),
    })),
    /same scalar type/,
  );
});

test("formal construction fails closed until reviewed replay fixture hashes are pinned", async () => {
  await assert.rejects(
    FormalRenderBenchmarkRunner.create(definition()),
    /fixture is pending approval/,
  );
  const candidate = await FormalRenderBenchmarkRunner.createDiagnosticCandidate(definition());
  await assert.rejects(candidate.run(new FakeHost()), /branded live formal renderer host/);
});

test("create binds an approved scenario id to its scene kind, not to the scene label", async () => {
  const accepted = await FormalRenderBenchmarkRunner.createDiagnosticCandidate(definition());
  assert.equal(accepted.identity.scenarioId, "goldshire-exterior");
  const stormwind = snapshot({ scenarioId: "stormwind" });
  stormwind.objects[0].position = { x: -8913.25, y: 554.5, z: 93.75, orientation: 0.7 };
  const acceptedStormwind = await FormalRenderBenchmarkRunner.createDiagnosticCandidate(definition({ snapshot: stormwind }));
  assert.equal(acceptedStormwind.identity.scenarioId, "stormwind");

  const missingPosition = snapshot();
  missingPosition.objects[0].position = null;
  await assert.rejects(
    FormalRenderBenchmarkRunner.createDiagnosticCandidate(definition({ snapshot: missingPosition })),
    /self must exist and have a position/,
  );
  await assert.rejects(
    FormalRenderBenchmarkRunner.createDiagnosticCandidate(definition({ snapshot: snapshot({ scenarioId: "fixture" }) })),
    /approved benchmark scenario/,
  );
  await assert.rejects(
    FormalRenderBenchmarkRunner.createDiagnosticCandidate(definition({
      snapshot: snapshot({
        expectations: {
          scene: "interior",
          indoors: true,
          underwater: false,
          precipitation: false,
          rainIntensity: 0,
        },
      }),
    })),
    /scene must match the approved scenario kind/,
  );
});

test("create binds approved scenario identity to map, position, time, and weather fixtures", async () => {
  await assert.rejects(
    FormalRenderBenchmarkRunner.createDiagnosticCandidate(definition({ snapshot: snapshot({ mapId: 1 }) })),
    /mapId must match the approved scenario fixture/,
  );
  await assert.rejects(
    FormalRenderBenchmarkRunner.createDiagnosticCandidate(definition({ snapshot: snapshot({ halfMinute: 1439 }) })),
    /halfMinute must match the approved scenario fixture/,
  );

  const nearPosition = snapshot();
  nearPosition.objects[0].position.x += FORMAL_BENCHMARK_POSITION_TOLERANCE_YARDS / 2;
  await FormalRenderBenchmarkRunner.createDiagnosticCandidate(definition({ snapshot: nearPosition }));
  const spoofedPosition = snapshot();
  spoofedPosition.objects[0].position.z += FORMAL_BENCHMARK_POSITION_TOLERANCE_YARDS * 2;
  await assert.rejects(
    FormalRenderBenchmarkRunner.createDiagnosticCandidate(definition({ snapshot: spoofedPosition })),
    /self position must match the approved scenario fixture/,
  );

  for (const weather of [
    { state: 1, intensity: 0, abrupt: false },
    { state: 0, intensity: 0.1, abrupt: false },
    { state: 0, intensity: 0, abrupt: true },
  ]) {
    await assert.rejects(
      FormalRenderBenchmarkRunner.createDiagnosticCandidate(definition({ snapshot: snapshot({ weather }) })),
      /fixed weather|fine-weather fixture/,
    );
  }
});

test("create enforces the formal 1920x1080, DPR 1, render-scale 100 canvas profile", async () => {
  for (const canvasOverride of [
    { backingWidth: 1919 },
    { systemDpr: 2, effectivePixelRatio: 1 },
    { renderScalePercent: 75 },
  ]) {
    const base = environment();
    await assert.rejects(
      FormalRenderBenchmarkRunner.createDiagnosticCandidate(definition({
        environment: environment({ canvas: { ...base.canvas, ...canvasOverride } }),
      })),
      /formal benchmark canvas must be 1920x1080/,
    );
  }
});

test("create enforces manifest lighting and explicit render scale in both variants", async () => {
  const base = configurations();
  await assert.rejects(
    FormalRenderBenchmarkRunner.createDiagnosticCandidate(definition({
      configurations: { ...base, A: { ...base.A, lighting: 2 } },
    })),
    /lighting must equal the formal manifest lighting profile/,
  );
  const { renderScale: _omitted, ...withoutRenderScale } = base.A.settings;
  await assert.rejects(
    FormalRenderBenchmarkRunner.createDiagnosticCandidate(definition({
      configurations: { ...base, A: { ...base.A, settings: withoutRenderScale } },
    })),
    /renderScale must equal the formal canvas render scale/,
  );
  await assert.rejects(
    FormalRenderBenchmarkRunner.createDiagnosticCandidate(definition({
      configurations: {
        ...base,
        B: { ...base.B, settings: { ...base.B.settings, renderScale: 75 } },
      },
    })),
    /renderScale must equal the formal canvas render scale/,
  );
});

test("start observation must match the fixed scene and cleanup still runs", async () => {
  const runner = await FormalRenderBenchmarkRunner.createDiagnosticCandidate(definition());
  const host = new FakeHost({ fault: "wrong-observation" });
  await assert.rejects(runner.runDiagnostic(host), /indoors mismatch/);
  assert.equal(host.events.includes("end"), true);
  assert.equal(host.released, true);
});

test("barriers must echo the active suite and epoch nonce", async () => {
  const runner = await FormalRenderBenchmarkRunner.createDiagnosticCandidate(definition());
  const host = new FakeHost({ fault: "stale-epoch-evidence" });
  await assert.rejects(runner.runDiagnostic(host), /active formal replay epoch/);
  assert.equal(host.events.includes("end"), true);
  assert.equal(host.released, true);
});

test("unavailable GPU evidence preserves partial samples and exact drops", async () => {
  const runner = await FormalRenderBenchmarkRunner.createDiagnosticCandidate(definition());
  const result = await runner.runDiagnostic(new FakeHost({ fault: "partial-gpu" }));
  assert.deepEqual(result.records[0].gpu, {
    status: "invalid",
    reason: "context-lost",
    coverage: { attempted: 3, covered: 2, dropped: 1 },
  });

  const invalid = await FormalRenderBenchmarkRunner.createDiagnosticCandidate(definition());
  await assert.rejects(
    invalid.runDiagnostic(new FakeHost({ fault: "bad-gpu-coverage" })),
    /attempted must equal covered samples plus dropped/,
  );
});

test("every ticket requires one matching, submitted receipt with a strictly increasing serial", async (context) => {
  for (const [fault, pattern] of [
    ["missing-submission", /submission receipt must be a plain object/],
    ["not-submitted", /submitted:true/],
    ["mismatched-submission", /does not match ticket/],
    ["duplicate-submission", /must be strictly greater/],
    ["out-of-order-submission", /must be strictly greater/],
    ["slow-submission", /did not complete inside its 60 Hz submission window/],
  ]) {
    await context.test(fault, async () => {
      const runner = await FormalRenderBenchmarkRunner.createDiagnosticCandidate(definition());
      const host = new FakeHost({ fault });
      await assert.rejects(runner.runDiagnostic(host), pattern);
      assert.equal(host.events.includes("end"), true);
      assert.equal(host.released, true);
    });
  }
});

test("a failed replay reset still closes a potentially partial epoch", async () => {
  const runner = await FormalRenderBenchmarkRunner.createDiagnosticCandidate(definition());
  const host = new FakeHost({ fault: "reset-failure" });
  await assert.rejects(runner.runDiagnostic(host), /reset failed/);
  assert.equal(host.events.includes("end"), true);
  assert.equal(host.released, true);
});

test("one runner rejects concurrent suites and clears the guard after acquisition failure", async () => {
  const runner = await FormalRenderBenchmarkRunner.createDiagnosticCandidate(definition());
  let rejectAcquire;
  const blockedHost = new FakeHost();
  blockedHost.acquireExclusiveLease = () => new Promise((_resolve, reject) => {
    rejectAcquire = reject;
  });
  const first = runner.runDiagnostic(blockedHost);
  await Promise.resolve();
  await assert.rejects(runner.runDiagnostic(new FakeHost()), /already running/);
  rejectAcquire(new Error("acquire failed"));
  await assert.rejects(first, /acquire failed/);
  await assert.rejects(runner.runDiagnostic({}), /acquireExclusiveLease/, "failed acquisition releases the reentrancy guard");
});

test("end barriers reject environment, resource-signature/map, and activity drift", async (context) => {
  for (const [fault, pattern] of [
    ["environment-drift", /environment changed/],
    ["resource-drift", /resource residency changed/],
    ["resource-map-drift", /resource residency changed/],
    ["activity-drift", /resource activity changed/],
  ]) {
    await context.test(fault, async () => {
      const runner = await FormalRenderBenchmarkRunner.createDiagnosticCandidate(definition());
      const host = new FakeHost({ fault });
      await assert.rejects(runner.runDiagnostic(host), pattern);
      assert.equal(host.events.includes("end"), true);
      assert.equal(host.released, true);
    });
  }
});

test("every run requires a fresh start barrier after the preceding end barrier", async () => {
  const runner = await FormalRenderBenchmarkRunner.createDiagnosticCandidate(definition());
  const host = new FakeHost({ fault: "stale-start-barrier" });
  await assert.rejects(runner.runDiagnostic(host), /start barrier must be fresher/);
  assert.equal(host.events.filter((event) => event === "end").length, 2);
  assert.equal(host.released, true);
});

test("measurement end allows only GPU pending, then post-drain requires full readiness", async (context) => {
  for (const [fault, pattern] of [
    ["measurement-non-gpu-blocker", /may only be blocked by pending GPU queries/],
    ["post-drain-not-ready", /post-GPU-drain barrier does not prove stable readiness/],
  ]) {
    await context.test(fault, async () => {
      const runner = await FormalRenderBenchmarkRunner.createDiagnosticCandidate(definition());
      const host = new FakeHost({ fault });
      await assert.rejects(runner.runDiagnostic(host), pattern);
      assert.equal(host.events.includes("end"), true);
      assert.equal(host.released, true);
    });
  }
});

test("diagnostic runner owns ABBAABBAAB but never mints formal provenance", async () => {
  const runner = await FormalRenderBenchmarkRunner.createDiagnosticCandidate(definition());
  const host = new FakeHost();
  const result = await runner.runDiagnostic(host);
  assert.deepEqual(host.variants, PAIRED_BENCHMARK_ORDER.map((entry) => entry.variant));
  assert.equal(host.variants.join(""), "ABBAABBAAB");
  assert.equal(result.records.length, 10);
  assert.equal(result.report.runCount, 10);
  assert.equal(result.formalGateEligible, false);
  assert.equal(result.report.formalGateEligible, false);
  assert.equal(isTrustedFormalBenchmarkSuiteResult(result), false);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.records), true);
  assert.throws(
    () => buildTrustedFormalBenchmarkReport(result.records),
    /runner provenance/,
    "diagnostic records never inherit the module-private WeakSet brand",
  );
  assert.throws(
    () => buildTrustedFormalBenchmarkReport(structuredClone(result.records)),
    /runner provenance/,
    "JSON-safe lookalikes remain untrusted",
  );
  assert.equal(host.events.filter((event) => event === "end").length, 10);
  const firstMeasurementEnd = host.events.indexOf("barrier:measurement-end");
  const firstDrain = host.events.findIndex((event) => event.startsWith("drain:"));
  const firstPostDrain = host.events.indexOf("barrier:post-gpu-drain");
  assert.ok(
    firstMeasurementEnd >= 0 && firstMeasurementEnd < firstDrain && firstDrain < firstPostDrain,
    "measurement end is sealed before drain and full readiness is recaptured afterward",
  );
  assert.equal(host.released, true);
});

test("cadence starts after asynchronous start-barrier validation", async () => {
  const runner = await FormalRenderBenchmarkRunner.createDiagnosticCandidate(definition());
  const host = new FakeHost({ fault: "validation-delay" });
  const result = await runner.runDiagnostic(host);
  assert.equal(result.records.length, 10);
  assert.equal(result.records.every((record) => record.frameSequenceComplete), true);
  assert.equal(host.released, true);
});

test("measurement-end barrier cannot move the sealed replay endpoint", async () => {
  const runner = await FormalRenderBenchmarkRunner.createDiagnosticCandidate(definition());
  const host = new FakeHost({ fault: "late-measurement-end" });
  await assert.rejects(
    runner.runDiagnostic(host),
    /measurement-end barrier must be within \[0, 250\]ms of replay endpoint/,
  );
  assert.equal(host.released, true);
});

test("overdue frames cannot be compressed into a catch-up burst", async () => {
  const runner = await FormalRenderBenchmarkRunner.createDiagnosticCandidate(definition());
  const host = new FakeHost({ fault: "compressed-catch-up" });
  await assert.rejects(
    runner.runDiagnostic(host),
    /missed its 60 Hz submission window/,
  );
  assert.equal(host.events.includes("end"), true);
  assert.equal(host.released, true);
});

test("abort cannot return a partial trusted report and executes both cleanup boundaries", async () => {
  const runner = await FormalRenderBenchmarkRunner.createDiagnosticCandidate(definition());
  const controller = new AbortController();
  const host = new FakeHost();
  const original = host.renderFrame.bind(host);
  host.renderFrame = async (...args) => {
    const receipt = await original(...args);
    controller.abort(new Error("test abort"));
    return receipt;
  };
  await assert.rejects(runner.runDiagnostic(host, controller.signal), /test abort/);
  assert.equal(host.events.includes("end"), true);
  assert.equal(host.released, true);
});
