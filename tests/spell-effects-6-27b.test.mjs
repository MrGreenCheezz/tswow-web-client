import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import {
  EMITTER_SPHERE, PARTICLE_FLAG_BURST, PARTICLE_FLAG_HEAD, PARTICLE_FLAG_INHERIT_VELOCITY, PARTICLE_FLAG_MODEL_SPACE,
  PARTICLE_FLAG_SPAWN_ALONG_PATH, PARTICLE_FLAG_SPAWN_ON_GROUND, PARTICLE_FLAG_XY_QUAD,
  createParticleSystem, createQuadBuffers, emitterDistanceScale, primeParticleSystem, stepParticles, writeParticleQuads,
} from "../dist/code/browser/Particles.js";
import { buildModelEffects, disposeModelEffects, particleLightColour, updateModelEffects } from "../dist/code/browser/ParticleRender.js";

// 25.10 (6.27): the emitter behaviours the spell census found unread (.runtime/lane-spells2/census): bursts (record
// 0x8000), the emitter frame's quarter turn (0x008309c0), velocity inheritance (0x40), path and ground spawning
// (0x800, 0x2000), distance thinning (0x0097d8c0), lit particles (no 0x1) and Wow.exe's emission rounding.

const IDENTITY = new THREE.Matrix4().elements;
const VIEW = { rightX: 1, rightY: 0, rightZ: 0, upX: 0, upY: 1, upZ: 0 };
const NONE = new Uint32Array(0);
const track = (values, times = [0]) => ({ interpolation: 0, globalSequence: -1, components: 1,
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
const frame = (overrides = {}) => ({ matrix: IDENTITY, animationMs: 0, worldMs: 0, ...overrides });

test("6.27b record 0x8000 fires int(rate) particles once per visible stretch, no steady stream", () => {
  // 0x008309c0 raises m_flags 0x40 on the edge; 0x0097d8c0 spends int(rate) at once and 0x8000 clears the stream bit.
  const burst = emitter({ flags: PARTICLE_FLAG_HEAD | PARTICLE_FLAG_BURST, emissionRate: track([40]), lifespan: track([5]),
    enabledIn: track([1, 0, 1], [0, 1000, 2000]) });
  const system = createParticleSystem(burst, NONE, 5);
  stepParticles(system, 1 / 60, frame());
  assert.equal(system.particles.length, 40, "the whole burst on the first step");
  for (let step = 1; step < 50; step++) stepParticles(system, 1 / 60, frame({ animationMs: step * 16 }));
  assert.equal(system.particles.length, 40, "and nothing more while it stays visible");
  stepParticles(system, 1 / 60, frame({ animationMs: 1500 }));
  stepParticles(system, 1 / 60, frame({ animationMs: 2100 }));
  assert.equal(system.particles.length, 80, "visible again: a second burst");
  // The first-burst prime of a freshly resolved spell model is the whole burst too.
  const primed = createParticleSystem(burst, NONE, 6);
  assert.equal(primeParticleSystem(primed, frame()), true);
  assert.equal(primed.particles.length, 40);
  stepParticles(primed, 1 / 60, frame());
  assert.equal(primed.particles.length, 40, "and it is spent");
});

test("6.27b the emitter's frame is the bone's turned a quarter about z (0x008309c0)", () => {
  // A plane 4 long (0xC8) and 0 wide spawns along the bone's y, not its x.
  const long = emitter({ emissionAreaLength: track([4]), emissionAreaWidth: track([0]), emissionRate: track([600]),
    lifespan: track([5]) });
  const system = createParticleSystem(long, NONE, 9);
  stepParticles(system, 0.05, frame());
  assert.ok(system.particles.length > 10);
  const spanX = Math.max(...system.particles.map((p) => Math.abs(p.x)));
  const spanY = Math.max(...system.particles.map((p) => Math.abs(p.y)));
  assert.ok(spanX < 1e-6 && spanY > 1.5, `along y (x ${spanX}, y ${spanY})`);
  // A model-space XY quad's first axis is the bone's y: with an identity frame its corners differ along y first.
  const flat = emitter({ flags: PARTICLE_FLAG_HEAD | PARTICLE_FLAG_XY_QUAD | PARTICLE_FLAG_MODEL_SPACE,
    scale: ramp([1, 0.25], [0], 2) });
  const quad = createParticleSystem(flat, NONE, 1);
  quad.particles.push({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, bx: 0, by: 0, bz: 0, age: 0.1, life: 2,
    scaleX: 1, scaleY: 1, spin: 0, spinRate: 0, cellOffset: 0 });
  const buffers = createQuadBuffers(1);
  assert.equal(writeParticleQuads(quad, VIEW, buffers), 1);
  const p = buffers.positions;
  // Corner 0 → corner 1 is 2 × width along the first axis (width 1, height 0.25).
  assert.ok(Math.abs(p[4] - p[1] - 2) < 1e-6 && Math.abs(p[3] - p[0]) < 1e-6, `first axis is y: ${Array.from(p.slice(0, 6))}`);
});

test("6.27b record 0x40 inherits the emitter's move, measured every 1/30 s, × ivelScale / (30 × elapsed)", () => {
  const moving = emitter({ flags: PARTICLE_FLAG_HEAD | PARTICLE_FLAG_INHERIT_VELOCITY, emissionRate: track([120]),
    lifespan: track([5]), burstMultiplier: 1 });
  const system = createParticleSystem(moving, NONE, 3);
  const at = (x) => new THREE.Matrix4().makeTranslation(x, 0, 0).elements;
  // 0.6 yd a step of 1/60 s: 36 yd/s. A measurement after 3 steps (0.05 s) is 0.6 / (0.05 × 30) = 0.4.
  for (let step = 0; step < 6; step++) stepParticles(system, 1 / 60, frame({ matrix: at(step * 0.6) }));
  assert.ok(Math.abs(system.parentVX - 0.4) < 1e-3, `inherited ${system.parentVX}`);
  const newest = system.particles[system.particles.length - 1];
  assert.ok(Math.abs(newest.vx - 0.4) < 1e-3, `the last spawn carries it: ${newest.vx}`);
  // Without the bit nothing is inherited.
  const plain = createParticleSystem(emitter({ emissionRate: track([120]), lifespan: track([5]) }), NONE, 3);
  for (let step = 0; step < 6; step++) stepParticles(plain, 1 / 60, frame({ matrix: at(step * 0.6) }));
  assert.ok(plain.particles.every((one) => one.vx === 0));
});

test("6.27b record 0x800 spreads spawns along the move; 0x2000 stands them on the ground", () => {
  const path = emitter({ flags: PARTICLE_FLAG_HEAD | PARTICLE_FLAG_SPAWN_ALONG_PATH, emissionRate: track([3000]), lifespan: track([5]) });
  const system = createParticleSystem(path, NONE, 4);
  stepParticles(system, 1 / 60, frame());
  system.particles.length = 0;
  stepParticles(system, 1 / 60, frame({ matrix: new THREE.Matrix4().makeTranslation(10, 0, 0).elements }));
  const xs = system.particles.map((p) => p.x);
  assert.ok(Math.min(...xs) < 3 && Math.max(...xs) > 7, `spread over the 10 yards: ${Math.min(...xs)}…${Math.max(...xs)}`);
  const grounded = emitter({ flags: PARTICLE_FLAG_HEAD | PARTICLE_FLAG_SPAWN_ON_GROUND, emissionRate: track([600]),
    lifespan: track([5]), scale: ramp([0.5, 0.75], [0], 2) });
  const ground = createParticleSystem(grounded, NONE, 4);
  stepParticles(ground, 1 / 60, frame({ matrix: new THREE.Matrix4().makeTranslation(0, 20, 0).elements, ground: () => 3 }));
  assert.ok(ground.particles.length > 0 && ground.particles.every((p) => Math.abs(p.y - 3.75) < 1e-6), "ground + the larger birth scale");
  // World::ProjectPositionCallback (0x0077f540): a ray 20 yards down — a floor above or further below is no floor.
  for (const level of [25, -10]) {
    const away = createParticleSystem(grounded, NONE, 4);
    stepParticles(away, 1 / 60, frame({ matrix: new THREE.Matrix4().makeTranslation(0, 20, 0).elements, ground: () => level }));
    assert.ok(away.particles.every((p) => Math.abs(p.y - 20) < 1e-6), `left where born with a floor at ${level}`);
  }
});

test("6.27b distance thinning: rate × clamp(1 − (d − 50) · 0.02, 0.25, 1) (0x0097d8c0)", () => {
  assert.equal(emitterDistanceScale(10), 1);
  assert.equal(emitterDistanceScale(50), 1);
  assert.ok(Math.abs(emitterDistanceScale(60) - 0.8) < 1e-9);
  assert.equal(emitterDistanceScale(200), 0.25);
  const busy = emitter({ emissionRate: track([600]), lifespan: track([5]) });
  const near = createParticleSystem(busy, NONE, 2);
  const far = createParticleSystem(busy, NONE, 2);
  stepParticles(near, 0.1, frame({ viewX: 0, viewY: 0, viewZ: 10 }));
  stepParticles(far, 0.1, frame({ viewX: 0, viewY: 0, viewZ: 100 }));
  assert.equal(near.particles.length, 60);
  assert.equal(far.particles.length, 15, "a quarter at 100 yards");
});

test("6.27b emission spends int(owed + 0.5): a slow emitter's first particle comes half a period early", () => {
  const slow = createParticleSystem(emitter({ emissionRate: track([4]), lifespan: track([5]) }), NONE, 1);
  // 4 a second: 0.5 owed after 0.125 s.
  for (let step = 0; step < 8; step++) stepParticles(slow, 1 / 64, frame());
  assert.equal(slow.particles.length, 1);
  assert.ok(slow.pending < 0, "the rest is owed back");
});

test("6.27b a lit emitter (no record 0x1) takes the model light on an upward normal (0x0097a390); an unlit one stays white", () => {
  const light = particleLightColour({ r: 0.3, g: 0.3, b: 0.4 }, { r: 0.8, g: 0.7, b: 0.5 },
    { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: 1 }, { r: 0, g: 0, b: 0 });
  assert.ok(Math.abs(light.r - 1) < 1e-9 && Math.abs(light.g - 1) < 1e-9 && Math.abs(light.b - 0.9) < 1e-9, "clamped at 1");
  const away = particleLightColour({ r: 0.3, g: 0.3, b: 0.4 }, { r: 0.8, g: 0.7, b: 0.5 },
    { x: 0, y: 0, z: -1 }, { x: 0, y: 0, z: 1 }, { r: 0, g: 0, b: 0 });
  assert.deepEqual(away, { r: 0.3, g: 0.3, b: 0.4 }, "sun below the normal: ambient only");
  const model = {
    particleEmitters: [
      emitter({ flags: PARTICLE_FLAG_HEAD, emissionRate: track([60]), lifespan: track([5]) }),
      emitter({ flags: PARTICLE_FLAG_HEAD | 0x1, emissionRate: track([60]), lifespan: track([5]) }),
    ],
    ribbonEmitters: [], textures: [{ type: 0, flags: 0, path: "spells\\x.blp" }], globalSequences: NONE,
  };
  const effects = buildModelEffects(model, { baseUrl: "", loadTexture: () => new THREE.Texture() });
  updateModelEffects(effects, 0.1, { matrixFor: () => IDENTITY, animationMs: 0, worldMs: 0 }, VIEW,
    { particleLight: { r: 0.25, g: 0.5, b: 0.75 } });
  assert.deepEqual(effects.emitters[0].material.color.toArray(), [0.25, 0.5, 0.75]);
  assert.deepEqual(effects.emitters[1].material.color.toArray(), [1, 1, 1]);
  disposeModelEffects(effects);
});

test("6.27b a sphere's equator ring starts on the bone's y (the quarter turn applies to every generator)", () => {
  const ring = emitter({ emitterType: EMITTER_SPHERE, emissionAreaLength: track([2]), emissionAreaWidth: track([2]),
    emissionRate: track([600]), lifespan: track([5]) });
  const system = createParticleSystem(ring, NONE, 8);
  stepParticles(system, 1 / 60, frame());
  // No azimuth range: every particle at azimuth 0, which is the emitter's +x — the bone's +y.
  assert.ok(system.particles.every((p) => Math.abs(p.x) < 1e-6 && Math.abs(p.y - 2) < 1e-6));
});

test("6.27b a spell model plays Stand, then Hold for an aura or Decay for a one-shot (0x00744870, 0x007449c0)", async () => {
  const { SPELL_ANIM_DECAY, SPELL_ANIM_HOLD, SPELL_ANIM_STAND, spellModelSequence, spellOneShotModelMs } =
    await import("../dist/code/browser/SpellModelSequence.js");
  const pick = { animation: -1, time: 0, loop: false };
  const shield = { stand: 0.7, hold: 0.633, decay: 1.1 };
  // Power Word: Shield's state model: the Stand flash once, then the Hold shimmer for as long as the aura lasts.
  assert.deepEqual({ ...spellModelSequence(0.3, true, shield, pick) }, { animation: SPELL_ANIM_STAND, time: 0.3, loop: true });
  spellModelSequence(1.0, true, shield, pick);
  assert.equal(pick.animation, SPELL_ANIM_HOLD);
  assert.ok(Math.abs(pick.time - 0.3) < 1e-9 && pick.loop);
  spellModelSequence(0.7 + 0.633 * 3 + 0.1, true, shield, pick);
  assert.ok(pick.animation === SPELL_ANIM_HOLD && Math.abs(pick.time - 0.1) < 1e-9, "Hold loops");
  // Without Hold (or before its clip arrives) an aura keeps looping Stand.
  spellModelSequence(1.0, true, { stand: 0.7 }, pick);
  assert.ok(pick.animation === SPELL_ANIM_STAND && Math.abs(pick.time - 0.3) < 1e-9);
  // A one-shot: Stand, then Decay, then it holds the end.
  spellModelSequence(0.9, false, shield, pick);
  assert.ok(pick.animation === SPELL_ANIM_DECAY && Math.abs(pick.time - 0.2) < 1e-9 && !pick.loop);
  spellModelSequence(5, false, shield, pick);
  assert.ok(pick.animation === SPELL_ANIM_DECAY && Math.abs(pick.time - 1.1) < 1e-9);
  spellModelSequence(5, false, { stand: 0.7 }, pick);
  assert.ok(pick.animation === SPELL_ANIM_STAND && Math.abs(pick.time - 0.7) < 1e-9);
  assert.equal(spellOneShotModelMs(shield), 1800);
  // The renderer drives it for models that declare Hold or Decay, and samples their batches on that sequence.
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  assert.match(source, /if \(!this\.#sequenceSpellModel\(visual, now, client\)\) visual\.skinned\.mixer\.update\(elapsed\);/);
  assert.match(source, /updateBatchColours\(visual\.built\.animatedBatches, visual\.sequenceMs \?\? 0, now, visual\.sequenceSlot\)/);
});

test("6.27b a spline emitter spawns along its Bézier by arc length, first at the end, straight up, rate × end (0x00981d40)", async () => {
  const { EMITTER_SPLINE } = await import("../dist/code/browser/Particles.js");
  const line = emitter({ emitterType: EMITTER_SPLINE, splinePoints: Float32Array.from([0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0]),
    emissionAreaLength: track([0.5]), emissionAreaWidth: track([1]), emissionSpeed: track([2]), emissionRate: track([600]),
    lifespan: track([5]) });
  const system = createParticleSystem(line, NONE, 12);
  stepParticles(system, 0.05, frame());
  assert.equal(system.particles.length, 30);
  const first = system.particles[0];
  // At the end of the path (x 3), turned into the bone frame (y 3), thrown up its z.
  assert.ok(Math.abs(first.x) < 1e-6 && Math.abs(first.y - 3) < 1e-5 && Math.abs(first.vz - 2) < 1e-6, JSON.stringify(first));
  // The rest between arc length 0.5 and 1: bone y 1.5 … 3.
  assert.ok(system.particles.every((p) => p.y >= 1.5 - 1e-5 && p.y <= 3 + 1e-5));
  const half = createParticleSystem({ ...line, emissionAreaWidth: track([0.5]), emissionAreaLength: track([0]) }, NONE, 12);
  stepParticles(half, 0.05, frame());
  assert.equal(half.particles.length, 15, "rate × end");
});

test("6.27b a spell model's batches are sampled on the sequence it plays (Hold's weights, not Stand's)", async () => {
  const { updateBatchAppearance } = await import("../dist/code/browser/ModelBuild.js");
  const weight = { interpolation: 0, globalSequence: -1, components: 1, tracks: [
    { sequence: 0, times: Uint32Array.from([0]), values: Float32Array.from([1]) },
    { sequence: 1, times: Uint32Array.from([0]), values: Float32Array.from([0.2]) },
  ] };
  const material = new THREE.MeshBasicMaterial();
  const entry = { material, weight, globalSequences: NONE, tinted: false };
  updateBatchAppearance([entry], 100, 100);
  assert.equal(material.opacity, 1, "Stand");
  updateBatchAppearance([entry], 100, 100, 1);
  assert.ok(Math.abs(material.opacity - 0.2) < 1e-6, "Hold's slot");
});

test("6.27b living spells: one light per spell model, by kind; a missile's sits on the bolt", async () => {
  const { SpellLights, SPELL_LIGHT_KIND_SCALE, spellLightIntensity } = await import("../dist/code/browser/SpellLights.js");
  const lights = new SpellLights();
  const bolt = {}, aura = {};
  lights.begin();
  const trail = lights.glowOf(bolt, "missile");
  Object.assign(trail, { energy: 6, red: 6, green: 3, blue: 0, x: -30, y: 6, z: 0 }); // the trail's centre, 5 yd behind
  lights.pin(bolt, 0, 1, 0);
  Object.assign(lights.glowOf(aura, "aura"), { energy: 6, red: 6, green: 6, blue: 6, x: 0, y: 0, z: 0 });
  lights.end(0);
  const seen = [];
  lights.forEach({ position: new THREE.Vector3(), colour: new THREE.Vector3(), radius: 0, intensity: 0, client: false, halo: false },
    (sample) => seen.push({ at: sample.position.toArray(), intensity: sample.intensity }));
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[0].at, [0, 1, 0], "the bolt's light is on the bolt");
  assert.ok(Math.abs(seen[0].intensity - spellLightIntensity(6) * SPELL_LIGHT_KIND_SCALE.missile) < 1e-9);
  assert.ok(Math.abs(seen[1].intensity - spellLightIntensity(6) * SPELL_LIGHT_KIND_SCALE.aura) < 1e-9, "an aura is fainter");
});

test("6.27b a sphere of no radius throws along its drawn azimuth, not straight up (0x00981950)", () => {
  const point = emitter({ emitterType: EMITTER_SPHERE, emissionSpeed: track([3]), emissionRate: track([600]), lifespan: track([5]) });
  const system = createParticleSystem(point, NONE, 4);
  stepParticles(system, 1 / 60, frame());
  // Azimuth 0 and latitude 0: the emitter's +x, the bone's +y after the quarter turn.
  assert.ok(system.particles.length > 0 && system.particles.every((p) => Math.abs(p.vy - 3) < 1e-6 && Math.abs(p.vz) < 1e-6));
});

test("6.27b an aura's held model plays its Decay when the aura ends (OnSpellEffectClear 0x00743250)", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const cancel = source.slice(source.indexOf("  cancelSpellVisual(id: number): void {"), source.indexOf("  retimeSpellVisual(id: number"));
  assert.match(cancel, /visual\.decayStartedAt = now;\n\s+visual\.instance\.endsAt = now \+ Math\.min\(MODEL_VFX_MAX_MS, decay\.duration \* 1000\);\n\s+continue;/);
  assert.match(source, /if \(visual\.decayStartedAt !== undefined && durations\.decay !== undefined\) \{[\s\S]{0,200}pick\.animation = SPELL_ANIM_DECAY;/);
});

test("6.27b a spell with a SpellMissile row is never thinned by distance (0x00745230 → 0x006f75f0)", async () => {
  const { planSpellVisual, planSpellAuraState, setMissileGravitySource } = await import("../dist/code/browser/SpellVisuals.js");
  const kit = { startAnimation: -1, animation: -1, sound: 0, effects: [{ path: "spells/x.m2", attachment: 34, scale: 1 }] };
  const visual = { id: 99, impact: kit, state: kit };
  const cast = { caster: 1n, casterPoint: { x: 0, y: 0, z: 0 }, targets: [{ guid: 2n, point: { x: 5, y: 0, z: 0 } }] };
  try {
    setMissileGravitySource((spell) => spell === 99 ? 19.29 : undefined);
    assert.ok(planSpellVisual(visual, cast, 0).instances.every((one) => one.ignoreDistance === true));
    assert.ok(planSpellAuraState(visual, { guid: 2n, point: { x: 0, y: 0, z: 0 } }, 0).instances.every((one) => one.ignoreDistance));
    setMissileGravitySource(() => undefined);
    assert.ok(planSpellVisual(visual, cast, 0).instances.every((one) => one.ignoreDistance === undefined));
  } finally {
    setMissileGravitySource(undefined);
  }
});
