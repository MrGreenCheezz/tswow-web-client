import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import {
  EMITTER_SPHERE, PARTICLE_FLAG_FOLLOW, PARTICLE_FLAG_HEAD, PARTICLE_FLAG_MODEL_SPACE, PARTICLE_FLAG_SORT,
  PARTICLE_FLAG_SPHERE_STOP_AT_CENTRE, PARTICLE_FLAG_SPHERE_STRAIGHT_UP, PARTICLE_FLAG_TAIL, PARTICLE_FLAG_UNFOGGED,
  PARTICLE_FLAG_VELOCITY_HEAD, createParticleSystem, createQuadBuffers, particleAppearance, particleCapacity,
  particleQuadsPerParticle, stepParticles, writeParticleQuads,
} from "../dist/code/browser/Particles.js";
import { buildModelEffects, disposeModelEffects, setModelEffectsGround, updateModelEffects } from "../dist/code/browser/ParticleRender.js";
import {
  SPELL_GLOW_KNEE, SPELL_SOFT_GROUND, spellGlowColour, spellParticleLookOf, spellSoftGroundFade,
} from "../dist/code/browser/SpellParticleLook.js";
import {
  SPELL_LIGHT_LIMIT, SPELL_LIGHT_PEAK, SPELL_LIGHT_RADIUS, SpellLights, spellLightIntensity,
} from "../dist/code/browser/SpellLights.js";
import { ENHANCED_GRAPHICS_OVERRIDES } from "../dist/code/browser/ui/EnhancedGraphics.js";
import { COMPARISON_GRAPHICS_OVERRIDES } from "../dist/code/browser/ui/ComparisonProfile.js";
import { settingDefinition } from "../dist/code/browser/ui/SettingsModel.js";

// 23.10 (6.27): spell effects — the particle parity found on Seal of Righteousness (Wow.exe 3.3.5a 12340, record
// flags read at 0x00833c80…0x00833e10, CParticleEmitter2 at 0x0097be80, 0x0097a390, 0x009815c0, 0x00981950,
// 0x00979bb0, 0x0097e580, 0x0097eb10, corner tables 0x00b2d5b4/0x00b2d5d4) and the enhanced «Живые эффекты
// заклинаний» look (SpellParticleLook.ts, SpellLights.ts).

const IDENTITY = new THREE.Matrix4().elements;
const VIEW = { rightX: 1, rightY: 0, rightZ: 0, upX: 0, upY: 1, upZ: 0 };
const NONE = new Uint32Array(0);
const track = (values, times = [0]) => ({ interpolation: 1, globalSequence: -1, components: 1,
  tracks: [{ sequence: 0, times: Uint32Array.from(times), values: Float32Array.from(values) }] });
const emptyTrack = () => ({ interpolation: 0, globalSequence: -1, components: 1, tracks: [] });
const ramp = (values, times, components = 1) => ({ components, times: Float32Array.from(times), values: Float32Array.from(values) });
const emptyRamp = (components = 1) => ({ components, times: new Float32Array(0), values: new Float32Array(0) });

function emitter(overrides = {}) {
  const blank = {
    id: 1, flags: PARTICLE_FLAG_HEAD, position: [0, 0, 0], bone: 0, texture: 0, blendType: 4, emitterType: 1,
    particleType: 0, headTail: 0, particleColorIndex: 0, textureTileRotation: 0,
    textureRows: 1, textureColumns: 1, lifespanVary: 0, emissionRateVary: 0, scaleVary: [0, 0],
    tailLength: 0, twinkleSpeed: 0, twinklePercent: 1, twinkleScaleMin: 1, twinkleScaleMax: 1,
    burstMultiplier: 1, drag: 0, baseSpin: 0, baseSpinVary: 0, spin: 0, spinVary: 0,
    windVector: [0, 0, 0], windTime: 0, followSpeed1: 0, followScale1: 0, followSpeed2: 0,
    followScale2: 0, splinePoints: new Float32Array(0),
  };
  for (const name of ["emissionSpeed", "speedVariation", "verticalRange", "horizontalRange", "gravity",
    "lifespan", "emissionRate", "emissionAreaLength", "emissionAreaWidth", "zSource", "enabledIn"]) blank[name] = emptyTrack();
  blank.color = emptyRamp(3); blank.opacity = emptyRamp(); blank.scale = ramp([1, 1], [0], 2);
  blank.headCell = emptyRamp(); blank.tailCell = emptyRamp();
  return { ...blank, ...overrides };
}

function particle(overrides = {}) {
  return { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, bx: 0, by: 0, bz: 0, age: 0.1, life: 2,
    scaleX: 1, scaleY: 1, spin: 0, spinRate: 0, cellOffset: 0, ...overrides };
}

/* --- Parity -------------------------------------------------------------------------------------- */

test("6.27 the record bits are Wow.exe's: 0x10 model space, 0x20000 head, 0x40000 tail", () => {
  assert.equal(PARTICLE_FLAG_MODEL_SPACE, 0x10);
  assert.equal(PARTICLE_FLAG_HEAD, 0x20000);
  assert.equal(PARTICLE_FLAG_TAIL, 0x40000);
  assert.equal(PARTICLE_FLAG_UNFOGGED, 0x8);
  assert.equal(createParticleSystem(emitter({ flags: 0x10 }), NONE).modelSpace, true);
  assert.equal(createParticleSystem(emitter({ flags: 0x80 }), NONE).modelSpace, false);
  assert.equal(particleQuadsPerParticle({ flags: PARTICLE_FLAG_HEAD }), 1);
  assert.equal(particleQuadsPerParticle({ flags: PARTICLE_FLAG_TAIL }), 1);
  assert.equal(particleQuadsPerParticle({ flags: PARTICLE_FLAG_HEAD | PARTICLE_FLAG_TAIL }), 2);
});

test("6.27 a world-space particle's speed carries the emitter's scale and it falls along the world's down", () => {
  // 0x009815c0 multiplies the velocity by the transform's 3×3 as it stands; 0x00979bb0 drops it along its own z.
  const thrown = emitter({ emissionSpeed: track([3]), emissionRate: track([600]), lifespan: track([10]), gravity: track([4]) });
  const scaled = createParticleSystem(thrown, NONE, 3);
  stepParticles(scaled, 1 / 240, { matrix: new THREE.Matrix4().makeScale(2, 2, 2).elements, animationMs: 0, worldMs: 0 });
  const first = scaled.particles[0];
  assert.ok(Math.abs(Math.hypot(first.vx, first.vy, first.vz + 4 / 240) - 6) < 0.05, "twice the speed at twice the size");
  // Turned on its side, the emitter throws along scene +x — and gravity still pulls along scene −y.
  const side = createParticleSystem(thrown, NONE, 3);
  const turned = new THREE.Matrix4().makeRotationY(Math.PI / 2).elements;
  stepParticles(side, 1 / 240, { matrix: turned, animationMs: 0, worldMs: 0 });
  const spark = side.particles[0];
  for (let frame = 0; frame < 30; frame++) stepParticles(side, 1 / 60, { matrix: turned, animationMs: 0, worldMs: 0 });
  assert.ok(spark.vy < -1.5, `falls along scene −y: ${spark.vy}`);
  assert.ok(Math.abs(spark.vx - 3) < 0.05, `keeps its throw along x: ${spark.vx}`);
});

test("6.27 only a following emitter (0x4000) drags its particles along", () => {
  const authored = { followSpeed1: 0, followScale1: 1, followSpeed2: 10, followScale2: 1,
    emissionRate: track([600]), lifespan: track([10]) };
  const run = (flags) => {
    const system = createParticleSystem(emitter({ ...authored, flags: PARTICLE_FLAG_HEAD | flags }), NONE, 5);
    const at = (x) => new THREE.Matrix4().makeTranslation(x, 0, 0).elements;
    stepParticles(system, 1 / 60, { matrix: at(0), animationMs: 0, worldMs: 0 });
    const first = system.particles[0];
    for (let frame = 1; frame <= 10; frame++) stepParticles(system, 1 / 60, { matrix: at(frame * 0.1), animationMs: 0, worldMs: 0 });
    return first.x;
  };
  assert.ok(Math.abs(run(0)) < 1e-6, "Seal of Righteousness authors follow values without the bit");
  assert.ok(run(PARTICLE_FLAG_FOLLOW) > 0.7, "the bit carries the old particle with the emitter");
});

test("6.27 sphere bits: 0x100 rises straight up, 0x80 stops a particle at the centre, 0x40000 no longer reverses", () => {
  const sphere = (flags, speed) => emitter({ flags, emitterType: EMITTER_SPHERE, emissionSpeed: track([speed]),
    emissionRate: track([600]), lifespan: track([10]), emissionAreaLength: track([1]), emissionAreaWidth: track([1]),
    verticalRange: track([1]), horizontalRange: track([3]) });
  const up = createParticleSystem(sphere(PARTICLE_FLAG_HEAD | PARTICLE_FLAG_SPHERE_STRAIGHT_UP, 2), NONE, 3);
  stepParticles(up, 0.05, { matrix: IDENTITY, animationMs: 0, worldMs: 0 });
  assert.ok(up.particles.length > 3 && up.particles.every((p) => Math.abs(p.vx) < 1e-6 && Math.abs(p.vy) < 1e-6 && p.vz > 0));
  const tail = createParticleSystem(sphere(PARTICLE_FLAG_TAIL, 2), NONE, 3);
  stepParticles(tail, 0.05, { matrix: IDENTITY, animationMs: 0, worldMs: 0 });
  assert.ok(tail.particles.every((p) => p.x * p.vx + p.y * p.vy + p.z * p.vz > 0), "a tail-only sphere still flies outward");
  const inward = createParticleSystem(sphere(PARTICLE_FLAG_HEAD | PARTICLE_FLAG_SPHERE_STOP_AT_CENTRE, -2), NONE, 3);
  for (let frame = 0; frame < 120; frame++) stepParticles(inward, 1 / 60, { matrix: IDENTITY, animationMs: 0, worldMs: 0 });
  assert.ok(inward.particles.every((p) => Math.hypot(p.x, p.y, p.z) <= 1.05), "none flies out past the centre");
});

test("6.27 a sorted emitter (0x2) writes far particles first", () => {
  const system = createParticleSystem(emitter({ flags: PARTICLE_FLAG_HEAD | PARTICLE_FLAG_SORT }), NONE, 3);
  // VIEW looks down −z: z = −10 is farther than z = −2.
  system.particles.push(particle({ z: -2 }), particle({ z: -10 }), particle({ z: -5 }));
  const buffers = createQuadBuffers(3);
  assert.equal(writeParticleQuads(system, VIEW, buffers), 3);
  assert.deepEqual([0, 1, 2].map((quad) => buffers.positions[quad * 12 + 2]), [-10, -5, -2]);
  const plain = createParticleSystem(emitter(), NONE, 3);
  plain.particles.push(particle({ z: -2 }), particle({ z: -10 }));
  writeParticleQuads(plain, VIEW, buffers);
  assert.deepEqual([0, 1].map((quad) => buffers.positions[quad * 12 + 2]), [-2, -10], "unsorted keeps spawn order");
});

test("6.27 a velocity head (0x4) lies along its motion as the eye sees it", () => {
  const system = createParticleSystem(emitter({ flags: PARTICLE_FLAG_HEAD | PARTICLE_FLAG_VELOCITY_HEAD,
    scale: ramp([1, 0.25], [0], 2) }), NONE, 3);
  system.particles.push(particle({ vy: 5 }));
  const buffers = createQuadBuffers(1);
  assert.equal(writeParticleQuads(system, VIEW, buffers), 1);
  const xs = [0, 1, 2, 3].map((corner) => buffers.positions[corner * 3]);
  const ys = [0, 1, 2, 3].map((corner) => buffers.positions[corner * 3 + 1]);
  assert.ok(Math.abs(Math.max(...ys) - Math.min(...ys) - 2) < 1e-6, "its long side runs along the flight");
  assert.ok(Math.abs(Math.max(...xs) - Math.min(...xs) - 0.5) < 1e-6);
});

test("6.27 the record's 0x8 leaves a particle unfogged; the pool counts no burst multiplier", () => {
  const model = (flags) => ({ globalSequences: NONE, particleEmitters: [emitter({ flags, emissionRate: track([10]), lifespan: track([1]) })],
    ribbonEmitters: [], textures: [{ type: 0, flags: 0, path: "spells\\glow.blp" }] });
  const build = (flags) => buildModelEffects(model(flags), { baseUrl: "http://gateway", loadTexture: () => new THREE.Texture() });
  const fogged = build(PARTICLE_FLAG_HEAD);
  const clear = build(PARTICLE_FLAG_HEAD | PARTICLE_FLAG_UNFOGGED);
  assert.equal(fogged.emitters[0].material.fog, true);
  assert.equal(clear.emitters[0].material.fog, false);
  disposeModelEffects(fogged);
  disposeModelEffects(clear);
  // 0x40 is velocity inheritance (0x0097eb10), not a burst: 10 × 1 × 1.15 → 16 with or without it.
  assert.equal(particleCapacity(emitter({ flags: 0x40, burstMultiplier: 8, emissionRate: track([10]), lifespan: track([1]) })), 16);
});

/* --- The enhanced look ----------------------------------------------------------------------------- */

function compile(material) {
  const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.basic.vertexShader, fragmentShader: THREE.ShaderLib.basic.fragmentShader };
  material.onBeforeCompile(shader);
  return shader;
}

test("6.27 off, a spell's particles build exactly as before; on, they blend frames, fade at the ground and glow", () => {
  const flipbook = emitter({ textureRows: 2, textureColumns: 2, headCell: ramp([0, 3], [0, 1]),
    emissionRate: track([10]), lifespan: track([1]) });
  const model = { globalSequences: NONE, particleEmitters: [flipbook], ribbonEmitters: [],
    textures: [{ type: 0, flags: 0, path: "spells\\clouds.blp" }] };
  const build = (livingSpells) => buildModelEffects(model, { baseUrl: "http://gateway",
    loadTexture: () => new THREE.Texture(), fantasyGlow: false, ...(livingSpells ? { livingSpells } : {}) });
  const faithful = build(undefined);
  const off = build(false);
  const living = build(true);
  const attributes = (effects) => Object.keys(effects.emitters[0].geometry.attributes).sort();
  assert.deepEqual(attributes(faithful), ["color", "position", "uv"]);
  assert.deepEqual(attributes(off), ["color", "position", "uv"]);
  assert.equal(off.emitters[0].material.customProgramCacheKey(), faithful.emitters[0].material.customProgramCacheKey());
  assert.equal(compile(off.emitters[0].material).fragmentShader, compile(faithful.emitters[0].material).fragmentShader);
  assert.equal(spellParticleLookOf(faithful.emitters[0].material), undefined);
  assert.deepEqual(attributes(living), ["cellBlend", "color", "position", "uv", "uv2Cell"]);
  const shader = compile(living.emitters[0].material);
  assert.match(shader.fragmentShader, /spell-look-v1 frame blend/);
  assert.match(shader.fragmentShader, /spellSoft/);
  assert.match(shader.fragmentShader, /spellPeak/);
  assert.match(living.emitters[0].material.customProgramCacheKey(), /spell-look-v1/);
  setModelEffectsGround(living, 12.5);
  assert.equal(shader.uniforms.spellGround.value, 12.5);
  for (const effects of [faithful, off, living]) disposeModelEffects(effects);
});

test("6.27 frame blending writes the next cell and how far the ramp has gone towards it", () => {
  const sheet = emitter({ textureRows: 2, textureColumns: 2, headCell: ramp([0, 3], [0, 1]) });
  const look = particleAppearance(sheet, particle({ age: 0.5, life: 1 }), {});
  assert.equal(look.cell, 1);
  assert.equal(look.nextCell, 2);
  assert.ok(Math.abs(look.cellBlend - 0.5) < 1e-6);
  const last = particleAppearance(sheet, particle({ age: 1, life: 1 }), {});
  assert.equal(last.cell, 3);
  assert.equal(last.cellBlend, 0, "never blends past the ramp's own last cell");
  const system = createParticleSystem(sheet, NONE, 3);
  system.particles.push(particle({ age: 0.5, life: 1 }));
  const buffers = createQuadBuffers(1, true);
  writeParticleQuads(system, VIEW, buffers);
  assert.ok(Math.abs(buffers.blends[0] - 0.5) < 1e-6);
  assert.deepEqual([...buffers.uvs2.slice(0, 2)], [0, 1], "cell 2: column 0, lower row, bottom-left corner");
});

test("6.27 the soft ground fade and the glow are bounded, and the glow whitens only a dense core", () => {
  assert.equal(spellSoftGroundFade(0), 0);
  assert.equal(spellSoftGroundFade(SPELL_SOFT_GROUND), 1);
  assert.ok(spellSoftGroundFade(SPELL_SOFT_GROUND / 2) > 0.4 && spellSoftGroundFade(SPELL_SOFT_GROUND / 2) < 0.6);
  const faint = spellGlowColour([1, 0.6, 0.1], 0.2);
  assert.ok(faint[2] < 0.2, "a faint particle keeps its hue");
  const dense = spellGlowColour([1, 0.6, 0.1], 1);
  assert.ok(dense[0] > 1 && dense[2] - 0.1 > 0.2, "a dense one rolls towards white, over the bloom threshold");
  assert.equal(SPELL_GLOW_KNEE, 0.6);
  // 6.27 review: no gain on the whole quad — below the knee a particle is exactly its own colour.
  assert.deepEqual(faint, [1, 0.6, 0.1]);
});

test("6.27 review: a quad lying in its XY plane (a ground ring) gets neither the glow nor the soft fade", () => {
  const ring = emitter({ flags: PARTICLE_FLAG_HEAD | 0x1000, emissionRate: track([10]), lifespan: track([1]) });
  const effects = buildModelEffects({ globalSequences: NONE, particleEmitters: [ring], ribbonEmitters: [],
    textures: [{ type: 0, flags: 0, path: "spells\\shockwave.blp" }] },
  { baseUrl: "http://gateway", loadTexture: () => new THREE.Texture(), livingSpells: true });
  const shader = compile(effects.emitters[0].material);
  assert.match(shader.fragmentShader, /spell-look-v1/);
  assert.doesNotMatch(shader.fragmentShader, /spellPeak|spellSoft/);
  disposeModelEffects(effects);
});

test("6.27 spell lights follow the drawn glow, saturate, smooth, keep the brightest two and fade out", () => {
  assert.equal(spellLightIntensity(0), 0);
  assert.ok(spellLightIntensity(1e6) <= SPELL_LIGHT_PEAK);
  const lights = new SpellLights();
  const sample = { position: new THREE.Vector3(), colour: new THREE.Vector3(), radius: 0, intensity: 0 };
  const frame = (energies, elapsed = 1 / 60) => {
    lights.begin();
    energies.forEach((energy, effect) => {
      if (energy <= 0) return;
      const glow = lights.glowOf(effect);
      glow.energy += energy; glow.red += energy; glow.green += energy * 0.8; glow.blue += energy * 0.2;
      glow.x += energy * 1; glow.y += energy * 2; glow.z += energy * 3;
    });
    lights.end(elapsed);
    const seen = [];
    lights.forEach(sample, (light) => seen.push({ ...light, position: light.position.clone(), colour: light.colour.clone() }));
    return seen;
  };
  let seen = frame([0, 5, 1, 20]);
  for (let index = 0; index < 60; index++) seen = frame([0, 5, 1, 20]);
  assert.equal(seen.length, SPELL_LIGHT_LIMIT);
  assert.ok(seen[0].intensity > seen[1].intensity && Math.abs(seen[0].intensity - spellLightIntensity(20)) < 1e-3);
  assert.deepEqual(seen[0].position.toArray(), [1, 2, 3]);
  assert.ok(Math.abs(seen[0].colour.y - 0.8) < 1e-6 && seen[0].radius === SPELL_LIGHT_RADIUS && seen[0].halo === false);
  const first = frame([0, 0, 0, 0])[0];
  assert.ok(first && first.intensity < spellLightIntensity(20) && first.intensity > 0, "an ended effect fades, not cuts");
  for (let index = 0; index < 120; index++) seen = frame([0, 0, 0, 0]);
  assert.equal(seen.length, 0);
  assert.equal(lights.count, 0);
});

test("6.27 the leaf is the enhanced profile's: off by default and in the comparison profile", () => {
  const definition = settingDefinition("experimentalLivingSpells");
  assert.ok(definition);
  assert.equal(definition.fallback, false);
  assert.equal(ENHANCED_GRAPHICS_OVERRIDES.experimentalLivingSpells, true);
  assert.equal(COMPARISON_GRAPHICS_OVERRIDES.experimentalLivingSpells, false);
});

test("6.27 a living effect sums its drawn particles' glow into the frame's accumulator", () => {
  const model = { globalSequences: NONE, particleEmitters: [emitter({ emissionRate: track([60]), lifespan: track([5]),
    color: ramp([1, 0.5, 0.25], [0], 3), opacity: ramp([1], [0]) })], ribbonEmitters: [],
    textures: [{ type: 0, flags: 0, path: "spells\\glow.blp" }] };
  const effects = buildModelEffects(model, { baseUrl: "http://gateway", loadTexture: () => new THREE.Texture(), livingSpells: true });
  const glow = { energy: 0, red: 0, green: 0, blue: 0, x: 0, y: 0, z: 0 };
  for (let frame = 0; frame < 30; frame++) {
    updateModelEffects(effects, 1 / 60, { matrixFor: () => new THREE.Matrix4().makeTranslation(4, 5, 6).elements,
      animationMs: frame * 16, worldMs: frame * 16 }, VIEW, frame === 29 ? { glow } : {});
  }
  const count = effects.emitters[0].particles.particles.length;
  assert.ok(count > 10);
  // Each head counts its half sizes' product (1 × 1) at full opacity and brightness 1.
  assert.ok(Math.abs(glow.energy - count) < 1e-6, `${glow.energy} for ${count} particles`);
  assert.ok(Math.abs(glow.green / glow.red - 0.5) < 1e-6);
  assert.ok(Math.abs(glow.x / glow.energy - 4) < 0.5 && Math.abs(glow.y / glow.energy - 5) < 0.5, "centred on the emitter");
  disposeModelEffects(effects);
});
