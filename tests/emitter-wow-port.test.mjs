import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as THREE from "three";
import {
  EMITTER_CAPACITY, PARTICLE_FLAG_RANDOM_FLIPBOOK, PARTICLE_FLAG_SPIN_EITHER_WAY,
  createParticleSystem, createQuadBuffers, emitterTrackSequence, particleCapacity, particleSpins,
  stepParticles, writeParticleQuads,
} from "../dist/code/browser/Particles.js";
import {
  createRibbonSystem, ribbonCapacity, ribbonLifetime, stepRibbon, writeRibbonStrip,
} from "../dist/code/browser/RibbonEmitter.js";
import { buildModelEffects, disposeModelEffects, updateModelEffects } from "../dist/code/browser/ParticleRender.js";
import {
  emittingItemModel, itemEffectKey, modelEmits, playingSequence, rememberItemModel,
} from "../dist/code/browser/AttachedEmitters.js";

// 13.10 6.15: M2 particles and ribbons ported from Wow.exe 3.3.5a 12340 (read-only Ghidra):
// CParticleEmitter2 pool 0x0097edf0/0x0097e3f0 and draw limit 0x0097e730; per-sequence tracks 0x0082d2f0 →
// 0x0082b340; quad spin 0x0097be80/0x0097a130; random cell 0x00979e90/0x00978e30; CRibbonEmitter 0x009808a0,
// 0x00980090, 0x0097f700, 0x0097fef0, 0x0097f510, render 0x00980b70; CM2Model::Animate 0x00828a00.

const IDENTITY = new THREE.Matrix4().elements;
const VIEW = { rightX: 1, rightY: 0, rightZ: 0, upX: 0, upY: 1, upZ: 0 };
const NONE = new Uint32Array(0);

function track(values, times = [0], sequence = 0) {
  return { interpolation: 0, globalSequence: -1, components: 1,
    tracks: [{ sequence, times: Uint32Array.from(times), values: Float32Array.from(values) }] };
}
function tracks(subs) {
  return { interpolation: 0, globalSequence: -1, components: 1,
    tracks: subs.map(([sequence, value]) => ({ sequence, times: Uint32Array.of(0), values: Float32Array.of(value) })) };
}
const emptyTrack = (components = 1) => ({ interpolation: 0, globalSequence: -1, components, tracks: [] });
const emptyRamp = (components = 1) => ({ components, times: new Float32Array(0), values: new Float32Array(0) });

function emitter(overrides = {}) {
  const blank = {
    id: 1, flags: 0, position: [0, 0, 0], bone: 0, texture: 0, blendType: 4, emitterType: 1,
    particleType: 0, headTail: 0, particleColorIndex: 0, textureTileRotation: 0,
    textureRows: 1, textureColumns: 1, lifespanVary: 0, emissionRateVary: 0, scaleVary: [0, 0],
    tailLength: 0, twinkleSpeed: 0, twinklePercent: 1, twinkleScaleMin: 1, twinkleScaleMax: 1,
    burstMultiplier: 0, drag: 0, baseSpin: 0, baseSpinVary: 0, spin: 0, spinVary: 0,
    windVector: [0, 0, 0], windTime: 0, followSpeed1: 0, followScale1: 0, followSpeed2: 0,
    followScale2: 0, splinePoints: new Float32Array(0),
  };
  for (const name of ["emissionSpeed", "speedVariation", "verticalRange", "horizontalRange", "gravity",
    "lifespan", "emissionRate", "emissionAreaLength", "emissionAreaWidth", "zSource", "enabledIn"]) blank[name] = emptyTrack();
  blank.color = emptyRamp(3); blank.opacity = emptyRamp(); blank.scale = emptyRamp(2);
  blank.headCell = emptyRamp(); blank.tailCell = emptyRamp();
  return { ...blank, ...overrides };
}

function ribbon(overrides = {}) {
  const blank = {
    id: 1, bone: 0, position: [0, 0, 0], textures: Uint16Array.of(0), materials: [{ blendMode: 4, flags: 0 }],
    edgesPerSecond: 10, edgeLifetime: 1, gravity: 0, textureRows: 1, textureColumns: 1,
    priorityPlane: 0, ribbonColorIndex: 0, textureTransformLookupIndex: 0,
  };
  for (const name of ["color", "alpha", "heightAbove", "heightBelow", "textureSlot", "visibility"]) {
    blank[name] = emptyTrack(name === "color" ? 3 : 1);
  }
  return { ...blank, ...overrides };
}

/* --- Tracks on the playing sequence ------------------------------------------------------------ */

test("6.15 a track keyed per sequence is read on the playing slot; a lone sequence-0 track on every slot", () => {
  const perSequence = tracks([[0, 5], [3, 40]]);
  assert.equal(emitterTrackSequence(perSequence, 3), 3);
  assert.equal(emitterTrackSequence(perSequence, 7), 7, "an empty slot is the default, as 0x0082b340 gives it");
  assert.equal(emitterTrackSequence(perSequence, undefined), undefined, "nothing playing: the first sub-track");
  assert.equal(emitterTrackSequence(track([5]), 9), undefined, "one sub-array: constant on every sequence");
  assert.equal(emitterTrackSequence({ ...perSequence, globalSequence: 0 }, 3), undefined, "a global loop ignores it");
  assert.equal(emitterTrackSequence(tracks([[2, 1]]), 4), 4, "a lone track on another slot is that slot's own");
});

test("6.15 an emitter keyed only under one sequence emits only while that sequence plays", () => {
  // A cast flourish keyed under its spell sequence (slot 3) and silent elsewhere: Wow.exe samples the playing
  // slot, so Stand (slot 0) has no rate; reading the first sub-track whatever plays lit it all the time.
  const flourish = emitter({ emissionRate: tracks([[0, 0], [3, 200]]), lifespan: track([1]) });
  const run = (sequence) => {
    const system = createParticleSystem(flourish, NONE, 5);
    for (let frame = 0; frame < 5; frame++) stepParticles(system, 0.05, { matrix: IDENTITY, animationMs: 0, worldMs: 0, sequence });
    return system.particles.length;
  };
  assert.ok(run(3) > 0, "the spell sequence emits");
  assert.equal(run(0), 0, "Stand does not");
  assert.equal(run(5), 0, "nor a slot the track leaves empty");
});

/* --- The pool ----------------------------------------------------------------------------------- */

test("6.15 an emitter's pool is Wow.exe's: next power of two of (rate+vary)·(life+vary)·1.15, at most 4096", () => {
  assert.equal(particleCapacity(emitter({ emissionRate: track([100]), lifespan: track([3]) })), 512, "345 → 512");
  assert.equal(particleCapacity(emitter({ emissionRate: track([100]), lifespan: track([1.2]) })), 256, "138: the 1.15 headroom");
  assert.equal(particleCapacity(emitter({ emissionRate: track([10]), emissionRateVary: 10, lifespan: track([2]), lifespanVary: 2 })), 128, "92 → 128");
  assert.equal(particleCapacity(emitter({ emissionRate: track([30000]), lifespan: track([5]) })), EMITTER_CAPACITY);
  assert.equal(EMITTER_CAPACITY, 4096, "0x4000 vertices a draw, four a quad (0x0097e730)");
  assert.equal(particleCapacity(emitter({ emissionRate: track([0]) })), 0, "no rate, no pool");
  assert.equal(particleCapacity(emitter({ emissionRate: track([2]), lifespan: track([0.05]) })), 1);
});

test("6.15 a greedy emitter holds more than the old 256 and stops at its own pool", () => {
  const greedy = emitter({ emissionRate: track([1000]), lifespan: track([10]) });
  const system = createParticleSystem(greedy, NONE, 9);
  assert.equal(system.capacity, 4096);
  for (let frame = 0; frame < 60; frame++) stepParticles(system, 0.1, { matrix: IDENTITY, animationMs: 0, worldMs: 0 });
  assert.ok(system.particles.length > 256, `${system.particles.length} live`);
  assert.ok(system.particles.length <= system.capacity);
  const small = createParticleSystem(emitter({ emissionRate: track([100]), lifespan: track([10]) }), NONE, 9);
  for (let frame = 0; frame < 200; frame++) stepParticles(small, 0.1, { matrix: IDENTITY, animationMs: 0, worldMs: 0 });
  assert.equal(small.capacity, 2048);
  assert.ok(small.particles.length <= 2048);
  const buffers = createQuadBuffers(system.capacity);
  assert.equal(writeParticleQuads(system, VIEW, buffers), system.particles.length, "every live one is drawn");
});

/* --- Spin and cells ----------------------------------------------------------------------------- */

test("6.15 no spin rate, no turn: the base angle alone never rotates a quad (0x0097be80)", () => {
  const still = emitter({ emissionRate: track([50]), lifespan: track([10]), baseSpinVary: Math.PI * 2 });
  assert.equal(particleSpins(still), false);
  const system = createParticleSystem(still, NONE, 3);
  stepParticles(system, 0.1, { matrix: IDENTITY, animationMs: 0, worldMs: 0 });
  const buffers = createQuadBuffers(system.capacity);
  const quads = writeParticleQuads(system, VIEW, buffers);
  assert.ok(quads > 0);
  for (let quad = 0; quad < quads; quad++) {
    const at = quad * 12;
    // Corner 0 → corner 1 runs along the view's right axis only.
    assert.ok(Math.abs(buffers.positions[at + 4] - buffers.positions[at + 1]) < 1e-6, "an upright quad");
  }
  assert.equal(particleSpins(emitter({ spinVary: 1 })), true);
});

test("6.15 half the particles of a spin-either-way emitter turn the other way", () => {
  const either = emitter({ flags: PARTICLE_FLAG_SPIN_EITHER_WAY, emissionRate: track([200]), lifespan: track([10]), spin: 2 });
  const system = createParticleSystem(either, NONE, 3);
  stepParticles(system, 0.1, { matrix: IDENTITY, animationMs: 0, worldMs: 0 });
  const rates = new Set(system.particles.map((particle) => Math.sign(particle.spinRate)));
  assert.deepEqual([...rates].sort(), [-1, 1]);
});

test("6.15 a random cell (record flag 0x10000) only when the grid has cells and the head ramp is empty", () => {
  assert.equal(PARTICLE_FLAG_RANDOM_FLIPBOOK, 0x10000);
  const grid = { textureRows: 2, textureColumns: 2, emissionRate: track([200]), lifespan: track([10]) };
  const random = createParticleSystem(emitter({ flags: PARTICLE_FLAG_RANDOM_FLIPBOOK, ...grid }), NONE, 3);
  stepParticles(random, 0.1, { matrix: IDENTITY, animationMs: 0, worldMs: 0 });
  assert.ok(new Set(random.particles.map((particle) => particle.cellOffset)).size > 1, "cells vary");
  const ramped = createParticleSystem(emitter({ flags: PARTICLE_FLAG_RANDOM_FLIPBOOK, ...grid,
    headCell: { components: 1, times: Float32Array.of(0), values: Float32Array.of(2) } }), NONE, 3);
  stepParticles(ramped, 0.1, { matrix: IDENTITY, animationMs: 0, worldMs: 0 });
  assert.ok(ramped.particles.every((particle) => particle.cellOffset === 0), "the ramp names the cell");
});

/* --- Ribbons ------------------------------------------------------------------------------------ */

test("6.15 a ribbon's ring is ceil(lifetime·ceil(rate)) + 2 and its lifetime at least a quarter second", () => {
  assert.equal(ribbonCapacity(ribbon({ edgesPerSecond: 30, edgeLifetime: 2 })), 62);
  assert.equal(ribbonCapacity(ribbon({ edgesPerSecond: 7.2, edgeLifetime: 0.1 })), 4, "ceil(0.25·8) + 2");
  assert.equal(ribbonLifetime(ribbon({ edgeLifetime: 0.1 })), 0.25);
  assert.equal(ribbonCapacity(ribbon({ edgesPerSecond: 100, edgeLifetime: 25 })), 2502, "the longest the client has");
});

test("6.15 the strip reaches the bone: a head edge is rewritten at it every frame", () => {
  const trail = createRibbonSystem(ribbon({ edgesPerSecond: 4 }), NONE);
  const move = new THREE.Matrix4();
  for (let frame = 0; frame < 10; frame++) {
    move.makeTranslation(frame * 0.5, 0, 0);
    stepRibbon(trail, 1 / 30, { matrix: move.elements, animationMs: 0, worldMs: 0 });
  }
  assert.ok(trail.head, "a head edge");
  assert.ok(Math.abs(trail.head.x - 4.5) < 1e-9, `at the bone (${trail.head.x})`);
  assert.equal(trail.head.age, 0);
  const buffers = createQuadBuffers(trail.capacity);
  const quads = writeRibbonStrip(trail, buffers);
  assert.equal(quads, trail.edges.length, "one quad more than the laid edges join: the last reaches the head");
  assert.ok(Math.abs(buffers.positions[(quads - 1) * 12 + 3] - 4.5) < 1e-9, "the last quad ends at the bone");
});

test("6.15 edges laid in one frame spread along last frame's path instead of piling on the bone", () => {
  const trail = createRibbonSystem(ribbon({ edgesPerSecond: 100 }), NONE);
  stepRibbon(trail, 0.01, { matrix: IDENTITY, animationMs: 0, worldMs: 0 });
  const laid = trail.edges.length;
  stepRibbon(trail, 0.1, { matrix: new THREE.Matrix4().makeTranslation(1, 0, 0).elements, animationMs: 0, worldMs: 0 });
  const fresh = trail.edges.slice(laid);
  assert.ok(fresh.length >= 9, `${fresh.length} new edges`);
  const xs = fresh.map((edge) => edge.x);
  assert.ok(Math.min(...xs) < 0.2 && Math.max(...xs) > 0.9, `spread ${Math.min(...xs)}…${Math.max(...xs)}`);
  for (let index = 1; index < fresh.length; index++) {
    assert.ok(fresh[index].x >= fresh[index - 1].x - 1e-9, "in order along the path");
    assert.ok(fresh[index].age <= fresh[index - 1].age + 1e-9, "and the nearer the bone, the younger");
  }
});

test("6.15 a ribbon is as wide as its bone's Y axis, keeps its colour, and samples its cell from the slot", () => {
  const trail = createRibbonSystem(ribbon({
    edgesPerSecond: 20, edgeLifetime: 1, textureRows: 2, textureColumns: 2,
    heightAbove: track([1]), heightBelow: track([0.5]), alpha: track([0.6]), textureSlot: track([3]),
  }), NONE);
  for (let frame = 0; frame < 20; frame++) stepRibbon(trail, 1 / 30, { matrix: IDENTITY, animationMs: 0, worldMs: 0 });
  const edge = trail.edges[0];
  assert.deepEqual([edge.belowX, edge.belowY, edge.belowZ].map((v) => Math.round(v * 1e6) / 1e6), [0, -0.5, 0], "below = −Y·heightBelow");
  assert.deepEqual([edge.aboveX, edge.aboveY, edge.aboveZ].map((v) => Math.round(v * 1e6) / 1e6), [0, 1, 0], "above = +Y·heightAbove");
  const buffers = createQuadBuffers(trail.capacity);
  const quads = writeRibbonStrip(trail, buffers);
  assert.ok(quads > 4);
  for (let corner = 0; corner < quads * 4; corner++) {
    assert.ok(Math.abs(buffers.colors[corner * 4 + 3] - 0.6) < 1e-6, "no fade with age (0x00980090)");
  }
  // Slot 3 of a 2 × 2 grid: column 1, row 1 — u from 0.5 over half the texture, v from 0.5 to 1.
  const near = trail.edges[0];
  assert.ok(Math.abs(buffers.uvs[0] - (0.5 + (near.age / 1) * 0.5)) < 1e-6, `u ${buffers.uvs[0]}`);
  assert.ok(Math.abs(buffers.uvs[1] - 0.5) < 1e-6 && Math.abs(buffers.uvs[7] - 1) < 1e-6, "v across the row");
  const last = quads - 1;
  assert.ok(Math.abs(buffers.uvs[last * 8 + 2] - 0.5) < 1e-6, "the head is the cell's start");
});

test("6.15 ribbon gravity lifts an edge by g·age² along world up, unchanged in sign (0x00833a3b)", () => {
  // Each step adds g·(2·age·dt + dt²) = g·((age + dt)² − age²), so from one moment to another an edge rises by
  // g·(age₂² − age₁²) — whatever the frame rate — and a positive gravity rises, as Wow.exe adds it to z.
  const trail = createRibbonSystem(ribbon({ edgesPerSecond: 1, edgeLifetime: 10, gravity: 2 }), NONE);
  stepRibbon(trail, 0.1, { matrix: IDENTITY, animationMs: 0, worldMs: 0 });
  const edge = trail.edges[0];
  const startAge = edge.age;
  const startY = edge.y;
  for (let frame = 0; frame < 10; frame++) stepRibbon(trail, 0.1, { matrix: IDENTITY, animationMs: 0, worldMs: 0 });
  const expected = 2 * (edge.age * edge.age - startAge * startAge);
  assert.ok(expected > 1.9, `the edge aged a second (${edge.age})`);
  assert.ok(Math.abs(edge.y - startY - expected) < 1e-6, `${edge.y - startY} against ${expected}`);
  assert.ok(Math.abs(edge.aboveY - edge.belowY - 1) < 1e-9, "both vertices rise with it");
});

test("6.15 a hidden ribbon lays nothing and forgets where its bone was", () => {
  const blink = ribbon({ edgesPerSecond: 50, visibility: { interpolation: 0, globalSequence: -1, components: 1,
    tracks: [{ sequence: 0, times: Uint32Array.of(0, 500, 1000), values: Float32Array.of(1, 0, 0) }] } });
  const trail = createRibbonSystem(blink, NONE);
  stepRibbon(trail, 0.05, { matrix: IDENTITY, animationMs: 100, worldMs: 0 });
  const before = trail.edges.length;
  assert.ok(before > 0);
  stepRibbon(trail, 0.05, { matrix: IDENTITY, animationMs: 600, worldMs: 0 });
  assert.equal(trail.edges.length, before, "nothing laid while hidden");
  assert.equal(trail.placed, false);
});

test("6.15 every texture of a ribbon is drawn, the further ones over the leader's strip (0x00980b70)", () => {
  const model = {
    globalSequences: NONE, particleEmitters: [],
    ribbonEmitters: [ribbon({ textures: Uint16Array.of(0, 1), materials: [{ blendMode: 4, flags: 0 }, { blendMode: 2, flags: 0 }] })],
    textures: [{ type: 0, path: "spells\\a.blp" }, { type: 0, path: "spells\\b.blp" }],
  };
  const effects = buildModelEffects(model, { baseUrl: "http://gateway", loadTexture: () => new THREE.Texture() });
  assert.ok(effects);
  assert.equal(effects.emitters.length, 2);
  const [leader, further] = effects.emitters;
  assert.ok(leader.ribbon && !leader.follows);
  assert.equal(further.follows, leader);
  assert.equal(further.geometry, leader.geometry, "one strip");
  assert.notEqual(further.material, leader.material, "its own blend");
  for (let frame = 0; frame < 5; frame++) {
    updateModelEffects(effects, 1 / 30, { matrixFor: () => new THREE.Matrix4().makeTranslation(frame, 0, 0).elements,
      animationMs: 0, worldMs: 0 }, VIEW);
  }
  assert.equal(leader.mesh.visible, true);
  assert.equal(further.mesh.visible, true, "drawn with its leader");
  let disposals = 0;
  leader.geometry.addEventListener("dispose", () => disposals++);
  disposeModelEffects(effects);
  assert.equal(disposals, 1, "the shared strip is freed once");
});

test("6.15 a particle system is sized by its own pool in the renderer", () => {
  const model = {
    globalSequences: NONE, ribbonEmitters: [], textures: [{ type: 0, path: "spells\\a.blp" }],
    particleEmitters: [emitter({ emissionRate: track([1000]), lifespan: track([2]) })],
  };
  const effects = buildModelEffects(model, { baseUrl: "http://gateway", loadTexture: () => new THREE.Texture() });
  assert.equal(effects.emitters[0].buffers.positions.length, 4096 * 12, "2300 → 4096 quads of room");
  disposeModelEffects(effects);
});

/* --- Items and mounts ---------------------------------------------------------------------------- */

test("6.15 a worn item's model and the clip's slot reach the effects pass", () => {
  const node = new THREE.Object3D();
  const quiet = { particleEmitters: [], ribbonEmitters: [] };
  const lit = { particleEmitters: [{}], ribbonEmitters: [] };
  assert.equal(emittingItemModel(node), undefined);
  rememberItemModel(node, quiet);
  assert.equal(emittingItemModel(node), undefined, "an item with no emitters adds nothing");
  rememberItemModel(node, lit);
  assert.equal(emittingItemModel(node), lit);
  assert.equal(modelEmits(lit), true);
  assert.equal(itemEffectKey(node, "42", "16/0"), "unit:42:item:16/0");
  assert.equal(itemEffectKey(node, "42", "other"), "unit:42:item:16/0", "built once per mesh");
  assert.equal(playingSequence({ getClip: () => ({ userData: { variationIndex: 4 } }) }), 4);
  assert.equal(playingSequence({ getClip: () => ({ userData: {} }) }), undefined);
  assert.equal(playingSequence(undefined), undefined);
});

test("6.15 the renderer runs worn items' and mounts' emitters and samples on the playing slot", () => {
  const source = readFileSync(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const start = source.indexOf("#updateEffects(player: WorldPosition");
  const effects = source.slice(start, source.indexOf("#markExpiredSpellEffectPhases(now: number)", start));
  assert.ok(effects.length > 1000, "the effects pass is found");
  assert.match(effects, /mount\?\.skinned && modelEmits\(mount\.wvm\) && glowShown\(mount\.skinned\.root\)/, "the mount, when shown");
  assert.match(effects, /posed: mount, fade: unit\.unitOpacity/, "on its own rig, faded with its rider");
  assert.match(effects, /const itemWvm = emittingItemModel\(node\);\s*if \(itemWvm && glowShown\(node\)\)/, "each shown worn piece");
  assert.match(effects, /visual: node, fade: unit\.unitOpacity/, "in the piece's own frame");
  assert.match(effects, /sequence: playingSequence\(entry\.spell \? entry\.spell\.action : posed\?\.action\)/);
  const attachments = source.slice(source.indexOf("#updateAttachments(unit: RenderedUnit"), source.indexOf("#glowBodyBuild ="));
  assert.match(attachments, /rememberItemModel\(mesh, itemModel\)/);
});
