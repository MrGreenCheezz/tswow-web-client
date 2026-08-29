import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

import { WorldState } from "../dist/code/world/WorldState.js";
import {
  FORMAL_BENCHMARK_ALLOWED_KNOB_PATH,
  FORMAL_BENCHMARK_COMPARISON_ID,
  buildFixedBenchmarkCameraFrames,
  buildFormalBenchmarkCandidateSnapshot,
  createFormalRenderBenchmarkConsole,
} from "../dist/code/browser/FormalRenderBenchmarkConsole.js";
import {
  FORMAL_BENCHMARK_FRAME_COUNT,
  FORMAL_BENCHMARK_FRAME_STEP_MS,
} from "../dist/code/browser/FormalRenderBenchmarkRunner.js";

const camera = Object.freeze({
  yaw: 0.2, pitch: -0.4, distance: 18, view: 18, viewPitch: -0.4, zoom: 18,
  wallView: Infinity, terrainView: Infinity, pivotHeight: 1.5, eyeHeight: 1.7,
});

function liveWorld() {
  const world = new WorldState();
  world.objects.set(1n, {
    guid: 1n, typeId: 3, position: { x: -9461.82, y: 63.31, z: 56.23, orientation: 0 },
    movementFlags: 0, updateFlags: 0, targetGuid: undefined, runSpeed: 7, turnRate: 3,
    motion: undefined, glide: undefined, transport: undefined, transportTime: undefined,
    speeds: undefined, fields: new Map(),
  });
  world.selfGuid = 1n;
  return world;
}

const scenario = {
  id: "goldshire-exterior", label: "Goldshire exterior", status: "approved", fixtureStatus: "pending",
  kind: "exterior", mapId: 0, position: { x: -9461.82, y: 63.31, z: 56.23 }, halfMinute: 1440,
  weather: { mode: "fine" },
};

const environment = {
  canvas: {
    cssWidth: 1920, cssHeight: 1080, backingWidth: 1920, backingHeight: 1080,
    systemDpr: 1, effectivePixelRatio: 1, renderScalePercent: 100,
  },
  lighting: 1,
  browser: { name: "Test", version: "1" },
  webgl: { version: "WebGL 2.0", shadingLanguageVersion: "GLSL", extensions: [] },
  settings: { renderScale: 100, lightingQuality: 1, characterAtlasAnisotropy: false },
};

function dependencies(runner, overrides = {}) {
  return {
    captureLiveState: () => ({ world: liveWorld(), mapId: 0, camera }),
    captureEnvironment: () => environment,
    captureSettings: () => ({ renderScale: 75, lightingQuality: 2, characterAtlasAnisotropy: false }),
    createLiveHost: () => ({}),
    runner,
    logger: { log() {}, warn() {} },
    now: () => 1,
    ...overrides,
  };
}

test("candidate helper emits independent dense 5400-frame static path", () => {
  const frames = buildFixedBenchmarkCameraFrames(camera);
  assert.equal(frames.length, FORMAL_BENCHMARK_FRAME_COUNT);
  assert.equal(frames[0].frameIndex, 0);
  assert.equal(frames.at(-1).frameIndex, FORMAL_BENCHMARK_FRAME_COUNT - 1);
  assert.notEqual(frames[0], frames[1]);
  assert.deepEqual({ ...frames[0], frameIndex: undefined }, { ...frames[1], frameIndex: undefined });
  const snapshot = buildFormalBenchmarkCandidateSnapshot(
    scenario,
    { world: liveWorld(), mapId: 0, camera },
    1,
  );
  assert.equal(snapshot.frames.length, FORMAL_BENCHMARK_FRAME_COUNT);
  assert.equal(snapshot.frameStepMs, FORMAL_BENCHMARK_FRAME_STEP_MS);
  assert.equal(snapshot.weather.state, 0);
  assert.equal(snapshot.expectations.scene, "exterior");
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.frames[0]));
});

test("console owns candidate state and never runs approved pending fixture", async () => {
  const calls = [];
  const runner = {
    createDiagnosticCandidate: async (definition) => ({
      runDiagnostic: async () => ({ formalGateEligible: false, definition }),
      run: async () => { throw new Error("wrong run"); },
    }),
    create: async () => { calls.push("approved-create"); throw new Error("fixture pending approval"); },
  };
  const api = createFormalRenderBenchmarkConsole(dependencies(runner));
  const candidate = await api.captureCandidate("goldshire-exterior");
  assert.equal(candidate.formalGateEligible, false);
  assert.equal(candidate.snapshot.frames.length, 5400);
  assert.equal(Object.isFrozen(candidate), true);
  assert.match(candidate.issues[0], /fixture pending/);
  await assert.rejects(api.runApproved(), /fixture pending/);
  assert.deepEqual(calls, ["approved-create"]);
  assert.equal(api.lastResult(), undefined);
  const result = await api.runCandidate();
  assert.equal(result.formalGateEligible, false);
  assert.equal(api.status().state, "complete");
  assert.equal(api.lastResult().formalGateEligible, false);
  assert.equal(FORMAL_BENCHMARK_COMPARISON_ID, "atlas-anisotropy-r1");
  assert.equal(FORMAL_BENCHMARK_ALLOWED_KNOB_PATH, "settings.characterAtlasAnisotropy");
  const { A, B } = result.definition.configurations;
  assert.equal(A.lighting, 1);
  assert.equal(B.lighting, 1);
  assert.equal(A.settings.renderScale, 100);
  assert.equal(B.settings.renderScale, 100);
  assert.equal(A.settings.characterAtlasAnisotropy, false);
  assert.equal(B.settings.characterAtlasAnisotropy, true);
  const aWithoutKnob = { ...A.settings };
  const bWithoutKnob = { ...B.settings };
  delete aWithoutKnob.characterAtlasAnisotropy;
  delete bWithoutKnob.characterAtlasAnisotropy;
  assert.deepEqual(aWithoutKnob, bWithoutKnob, "atlas anisotropy is the only A/B setting leaf");
});

test("supplied candidates verify their hashes and become the result's current candidate", async () => {
  const runner = {
    createDiagnosticCandidate: async (definition) => ({
      runDiagnostic: async () => ({ formalGateEligible: false, definition }),
      run: async () => { throw new Error("wrong run"); },
    }),
    create: async () => { throw new Error("wrong run"); },
  };
  const first = createFormalRenderBenchmarkConsole(dependencies(runner));
  const original = await first.captureCandidate("goldshire-exterior");
  await assert.rejects(
    first.runCandidate({ ...original, snapshotHash: "tampered" }),
    /snapshotHash does not match/,
  );
  assert.equal(first.lastResult(), undefined);

  const second = createFormalRenderBenchmarkConsole(dependencies(runner, {
    captureLiveState: () => ({ world: liveWorld(), mapId: 0, camera: { ...camera, yaw: 0.75 } }),
  }));
  const supplied = await second.captureCandidate("goldshire-exterior");
  assert.notEqual(supplied.snapshotHash, original.snapshotHash);
  const completed = await first.runCandidate(supplied);
  assert.equal(first.lastCandidate().snapshotHash, supplied.snapshotHash);
  assert.equal(completed.definition.snapshot.frames[0].yaw, 0.75);
});

test("unavailable renderer or WebGL fails preflight before a host is created", async () => {
  let hosts = 0;
  const runner = {
    createDiagnosticCandidate: async () => { throw new Error("runner must not be created"); },
    create: async () => { throw new Error("runner must not be created"); },
  };
  const unusable = {
    ...environment,
    canvas: { ...environment.canvas, effectivePixelRatio: "unsupported" },
    webgl: { version: "unsupported", shadingLanguageVersion: "unsupported", extensions: [] },
  };
  const api = createFormalRenderBenchmarkConsole(dependencies(runner, {
    captureEnvironment: () => unusable,
    createLiveHost: () => { hosts++; return {}; },
  }));
  const captured = await api.captureCandidate("goldshire-exterior");
  assert.match(captured.issues.join("; "), /renderer pixel ratio is unavailable/);
  assert.match(captured.issues.join("; "), /WebGL context is unavailable/);
  await assert.rejects(api.runCandidate(), /candidate is not runnable/);
  assert.equal(hosts, 0);
});

test("abort is idempotent and exposes no partial result", async () => {
  const runner = {
    createDiagnosticCandidate: async () => ({
      runDiagnostic: async (_host, signal) => new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
      run: async () => { throw new Error("wrong run"); },
    }),
    create: async () => { throw new Error("wrong run"); },
  };
  const api = createFormalRenderBenchmarkConsole(dependencies(runner));
  await api.captureCandidate("goldshire-exterior");
  const pending = api.runCandidate();
  await new Promise((resolve) => setImmediate(resolve));
  api.abort("cancelled");
  api.abort("cancelled again");
  await assert.rejects(pending, /cancelled/);
  assert.equal(api.status().state, "aborted");
  assert.equal(api.lastResult(), undefined);
});

test("main wires the frozen formal console without replacing live diagnostics", async () => {
  const source = await readFile(new URL("../src/browser/main.ts", import.meta.url), "utf8");
  assert.match(source, /webclientRenderBenchmark\s*=\s*renderBenchmarkConsole/);
  assert.match(source, /game\.renderer\?\.benchmarkGraphicsConfiguration/,
    "formal environment metadata reads applied renderer settings, not only requested settings");
  assert.match(source, /createFormalRenderBenchmarkConsole\(\{/);
  assert.match(source, /webclientFormalRenderBenchmark\s*=\s*formalRenderBenchmarkConsole/);
  assert.doesNotMatch(source, /import\s+\{\s*createFormalRenderBenchmarkConsole/,
    "formal console implementation must not remain in the eager login graph");
  assert.doesNotMatch(source, /import\s+\{\s*FormalRenderBenchmarkRunner/,
    "formal runner implementation must not remain in the eager login graph");
  assert.match(source, /webclientBenchmarksReady/);
  const loginWired = source.lastIndexOf("wireLoginForms()");
  const demandGetter = source.lastIndexOf('Object.defineProperty(globalThis, "webclientBenchmarksReady"');
  assert.ok(loginWired >= 0 && demandGetter > loginWired,
    "login handlers are wired before the demand-loaded benchmark promise is exposed");
  const parsed = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const installCallOwners = [];
  const visit = (node, owner) => {
    let nextOwner = owner;
    if (ts.isFunctionDeclaration(node) && node.name) nextOwner = node.name.text;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
      && node.expression.text === "installRenderBenchmarkConsoles") {
      installCallOwners.push(nextOwner ?? "<top-level>");
    }
    ts.forEachChild(node, (child) => visit(child, nextOwner));
  };
  visit(parsed, undefined);
  assert.deepEqual(installCallOwners, ["ensureRenderBenchmarkConsoles"],
    "only the public demand getter may fetch or parse benchmark chunks");
  assert.match(source, /get:\s*ensureRenderBenchmarkConsoles/,
    "awaiting the public promise must be the explicit demand signal");
});
