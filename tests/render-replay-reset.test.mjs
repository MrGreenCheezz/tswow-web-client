import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as THREE from "three";

import {
  createParticleSystem,
  createRibbonSystem,
  resetParticleSystem,
  resetRibbonSystem,
  stepParticles,
  stepRibbon,
} from "../dist/code/browser/Particles.js";
import {
  buildModelEffects,
  disposeModelEffects,
  resetModelEffects,
  updateModelEffects,
} from "../dist/code/browser/ParticleRender.js";
import {
  modelEffectSeed,
  validateReplayEpochBoundary,
  validateRenderEvolutionMode,
} from "../dist/code/browser/WorldRenderer3D.js";

const IDENTITY = new THREE.Matrix4().elements;
const VIEW = { rightX: 1, rightY: 0, rightZ: 0, upX: 0, upY: 1, upZ: 0 };

function track(value) {
  return {
    interpolation: 0,
    globalSequence: -1,
    components: 1,
    tracks: [{ sequence: 0, times: Uint32Array.from([0]), values: Float32Array.from([value]) }],
  };
}

function emitter(overrides = {}) {
  const blank = {
    id: 1, flags: 0, position: [0, 0, 0], bone: 0, texture: 0, blendType: 4, emitterType: 1,
    particleType: 0, headTail: 0, particleColorIndex: 0, textureTileRotation: 0,
    textureRows: 1, textureColumns: 1, lifespanVary: 0.4, emissionRateVary: 0.25,
    scaleVary: [0.4, 0], tailLength: 0, twinkleSpeed: 0, twinklePercent: 0,
    twinkleScaleMin: 0, twinkleScaleMax: 0, burstMultiplier: 0, drag: 0,
    baseSpin: 0, baseSpinVary: 2, spin: 0, spinVary: 1,
    windVector: [0, 0, 0], windTime: 0, followSpeed1: 0, followScale1: 0,
    followSpeed2: 0, followScale2: 0, splinePoints: new Float32Array(0),
    emissionSpeed: track(3), speedVariation: track(0.25), verticalRange: track(0.6),
    horizontalRange: track(1.2), gravity: track(0), lifespan: track(2), emissionRate: track(24),
    emissionAreaLength: track(1), emissionAreaWidth: track(1), zSource: track(0), enabledIn: track(1),
    color: { components: 3, times: new Float32Array(0), values: new Float32Array(0) },
    opacity: { components: 1, times: new Float32Array(0), values: new Float32Array(0) },
    scale: { components: 2, times: new Float32Array(0), values: new Float32Array(0) },
    headCell: { components: 1, times: new Float32Array(0), values: new Float32Array(0) },
    tailCell: { components: 1, times: new Float32Array(0), values: new Float32Array(0) },
  };
  return { ...blank, ...overrides };
}

function ribbon(overrides = {}) {
  const scalar = { interpolation: 0, globalSequence: -1, components: 1, tracks: [] };
  return {
    id: 1, bone: 0, position: [0, 0, 0], textures: Uint16Array.from([0]),
    materials: [{ blendMode: 4, flags: 0 }], edgesPerSecond: 10, edgeLifetime: 1,
    gravity: 0, textureRows: 1, textureColumns: 1, priorityPlane: 0,
    ribbonColorIndex: 0, textureTransformLookupIndex: 0,
    color: { ...scalar, components: 3 }, alpha: scalar, heightAbove: scalar,
    heightBelow: scalar, textureSlot: scalar, visibility: scalar,
    ...overrides,
  };
}

function evolve(system, frames = 12) {
  for (let frame = 0; frame < frames; frame++) {
    stepParticles(system, 1 / 60, {
      matrix: IDENTITY,
      animationMs: frame * (1000 / 60),
      worldMs: frame * (1000 / 60),
    });
  }
  return structuredClone(system.particles);
}

test("particle and ribbon resets rewind temporal state in place", () => {
  const globals = Uint32Array.from([1_000]);
  const system = createParticleSystem(emitter(), globals, 0x12345678);
  const particles = system.particles;
  const matrix = system.matrix;
  const first = evolve(system);
  assert.ok(first.length > 0);

  resetParticleSystem(system, 0x12345678);
  assert.strictEqual(system.particles, particles);
  assert.strictEqual(system.matrix, matrix);
  assert.strictEqual(system.globalSequences, globals);
  assert.equal(system.pending, 0);
  assert.equal(system.placed, false);
  assert.deepEqual([...system.matrix], [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  assert.deepEqual(evolve(system), first, "same seed has the same particle evolution");

  resetParticleSystem(system, 0x87654321);
  assert.notDeepEqual(evolve(system), first, "different seed changes particle evolution");
  const beforeInvalid = system.particles.length;
  assert.throws(() => resetParticleSystem(system, -1), /uint32/);
  assert.equal(system.particles.length, beforeInvalid, "validation happens before mutation");

  const trail = createRibbonSystem(ribbon(), globals);
  const edges = trail.edges;
  stepRibbon(trail, 0.1, { matrix: IDENTITY, animationMs: 0, worldMs: 0 });
  assert.ok(trail.edges.length > 0);
  resetRibbonSystem(trail);
  assert.strictEqual(trail.edges, edges);
  assert.strictEqual(trail.globalSequences, globals);
  assert.equal(trail.edges.length, 0);
  assert.equal(trail.pending, 0);
});

test("model effect reset preserves retained GPU/CPU identities and emitter seed offsets", () => {
  const model = {
    particleEmitters: [emitter({ id: 1 }), emitter({ id: 2 })],
    ribbonEmitters: [ribbon()],
    globalSequences: Uint32Array.from([2_000]),
    textures: [{ type: 0, flags: 0, path: "spells\\replay.blp" }],
  };
  const effects = buildModelEffects(model, {
    baseUrl: "http://gateway",
    loadTexture: () => new THREE.Texture(),
    seed: 17,
  });
  assert.ok(effects);
  const identities = effects.emitters.map((drawn) => ({
    geometry: drawn.geometry,
    material: drawn.material,
    buffers: drawn.buffers,
    position: drawn.geometry.getAttribute("position"),
    uv: drawn.geometry.getAttribute("uv"),
    color: drawn.geometry.getAttribute("color"),
    matrix: drawn.particles?.matrix,
    globals: drawn.particles?.globalSequences ?? drawn.ribbon?.globalSequences,
  }));
  const texture = effects.textures[0];

  try {
    for (let frame = 0; frame < 12; frame++) {
      updateModelEffects(effects, 1 / 60, {
        matrixFor: () => IDENTITY,
        animationMs: frame * (1000 / 60),
        worldMs: frame * (1000 / 60),
      }, VIEW);
    }
    assert.ok(effects.emitters.some((drawn) => drawn.geometry.drawRange.count > 0));
    resetModelEffects(effects, 0x10203040);

    assert.strictEqual(effects.textures[0], texture);
    effects.emitters.forEach((drawn, index) => {
      const held = identities[index];
      assert.strictEqual(drawn.geometry, held.geometry);
      assert.strictEqual(drawn.material, held.material);
      assert.strictEqual(drawn.buffers, held.buffers);
      assert.strictEqual(drawn.geometry.getAttribute("position"), held.position);
      assert.strictEqual(drawn.geometry.getAttribute("uv"), held.uv);
      assert.strictEqual(drawn.geometry.getAttribute("color"), held.color);
      assert.strictEqual(drawn.particles?.matrix, held.matrix);
      assert.strictEqual(drawn.particles?.globalSequences ?? drawn.ribbon?.globalSequences, held.globals);
      assert.equal(drawn.geometry.drawRange.count, 0);
      assert.ok(drawn.buffers.positions.every((value) => value === 0));
      assert.ok(drawn.buffers.uvs.every((value) => value === 0));
      assert.ok(drawn.buffers.colors.every((value) => value === 0));
    });

    const particleEmitters = effects.emitters.filter((drawn) => drawn.particles);
    for (let frame = 0; frame < 12; frame++) {
      updateModelEffects(effects, 1 / 60, {
        matrixFor: () => IDENTITY,
        animationMs: frame * (1000 / 60),
        worldMs: frame * (1000 / 60),
      }, VIEW);
    }
    assert.notDeepEqual(particleEmitters[0].particles.particles, particleEmitters[1].particles.particles,
      "the original per-emitter seed offset survives a replay rewind");
  } finally {
    disposeModelEffects(effects);
  }
});

test("replay boundary and placement seed behavior are runtime-testable", () => {
  const clean = {
    renderFrameActive: false,
    transientVisuals: 0,
    persistentStateVisuals: 0,
    pendingVisualAnimations: 0,
    pendingUnitActions: 0,
    pendingGameObjectAnimations: 0,
  };
  assert.equal(validateReplayEpochBoundary(clean), undefined);
  for (const field of Object.keys(clean)) {
    const blocked = { ...clean, [field]: field === "renderFrameActive" ? true : 1 };
    assert.throws(() => validateReplayEpochBoundary(blocked), /active render frame|transient requests/);
  }

  assert.equal(modelEffectSeed("env:42"), modelEffectSeed("env:42"), "live fallback stays stable");
  assert.notEqual(modelEffectSeed("env:42", 1), modelEffectSeed("env:42", 2));
  assert.notEqual(modelEffectSeed("env:42", 1), modelEffectSeed("env:43", 1));
  for (const invalid of [-1, 0x1_0000_0000, 1.5, Number.NaN]) {
    assert.throws(() => modelEffectSeed("env:42", invalid), /uint32/);
  }

  assert.equal(validateRenderEvolutionMode(false, false), undefined);
  assert.equal(validateRenderEvolutionMode(true, true), undefined);
  assert.throws(() => validateRenderEvolutionMode(true, false), /requires RenderFrameTime/);
  assert.throws(() => validateRenderEvolutionMode(false, true), /requires an active replay epoch/);
});

test("renderer replay epoch rewinds every temporal owner without disposal", async () => {
  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const start = source.indexOf("  resetReplayEpoch(rngSeed: number): void {");
  const end = source.indexOf("\n  /** Leaves deterministic evolution", start);
  const reset = source.slice(start, end);
  assert.ok(start >= 0 && end > start);

  const guard = reset.indexOf("validateReplayEpochBoundary({");
  const mutation = reset.indexOf("this.#replaySeed = seed;");
  assert.ok(guard >= 0 && mutation > guard, "the full transient boundary is checked before mutation");
  for (const field of [
    "renderFrameActive: this.#renderFrameDepth > 0",
    "transientVisuals: this.#visuals.filter((visual) => !visual.key.startsWith(\"state:\")).length",
    "persistentStateVisuals: this.#visuals.filter((visual) => visual.key.startsWith(\"state:\")).length",
    "pendingVisualAnimations: this.#pendingVisualAnimations.length",
    "pendingUnitActions: this.#actions.size",
    "pendingGameObjectAnimations: this.#gameObjectAnimations.size",
  ]) assert.equal(reset.includes(field), true, field);

  for (const expected of [
    "this.#frames.reset();",
    "this.#cadence.reset();",
    "this.#gpuTimer.resetEpoch();",
    "this.#renderer.info.reset();",
    "this.#resetFrameCounters();",
    "rendered.skinned?.mixer.setTime(0)",
    "this.#skyboxSkinned.mixer.setTime(0);",
    "rendered.skinned.mixer.stopAllAction();",
    "unit.skinned.mixer.stopAllAction();",
    "mount.skinned.mixer.stopAllAction();",
    "delete rendered.state;",
    "delete rendered.phaseMs;",
    "delete rendered.phaseAt;",
    "unit.pose = undefined;",
    "this.#weatherPacket = undefined;",
    "this.#weather?.reset(0);",
    "this.#weather?.set(this.#weatherFade, false);",
    "resetModelEffects(held.effects, modelEffectSeed(key, seed));",
  ]) assert.equal(reset.includes(expected), true, expected);
  assert.equal(reset.includes(".dispose("), false);
  assert.equal(reset.includes("uncacheRoot"), false);

  const updateEffectsStart = source.indexOf("  #updateEffects(");
  const updateEffectsEnd = source.indexOf("\n  #dropEffects(", updateEffectsStart);
  assert.match(source.slice(updateEffectsStart, updateEffectsEnd),
    /seed: modelEffectSeed\(entry\.key, this\.#replaySeed\)/);

  const drawStart = source.indexOf("  draw(\n");
  const drawTime = source.indexOf("const evolutionTime =", drawStart);
  const modeGuard = source.indexOf(
    "validateRenderEvolutionMode(this.#replaySeed !== undefined, frameTime !== undefined);",
    drawStart,
  );
  assert.ok(drawStart >= 0 && modeGuard > drawStart && drawTime > modeGuard,
    "epoch/time consistency is validated before a logical ticket is consumed");

  const leaveStart = source.indexOf("  endReplayEpoch(): void {");
  const leaveEnd = source.indexOf("\n  }", leaveStart) + 4;
  const leave = source.slice(leaveStart, leaveEnd);
  assert.match(leave, /this\.#replaySeed = undefined;/);
  assert.match(leave, /this\.#lastFrame = performance\.now\(\);/);
  assert.match(leave, /this\.#cadence\.reset\(\);/);
  assert.equal(leave.includes("dispose"), false);
});
