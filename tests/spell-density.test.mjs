// 26.10 (6.27, test version): «Плотные эффекты заклинаний» — a spell's emitters spawn twice the particles at 0.6 of
// their opacity; runes and rings on the ground are left as authored; off by default, outside the enhanced preset.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as THREE from "three";

import {
  PARTICLE_FLAG_SPAWN_ON_GROUND, PARTICLE_FLAG_XY_QUAD, createParticleSystem, createQuadBuffers, stepParticles,
  writeParticleQuads,
} from "../dist/code/browser/Particles.js";
import { SPELL_DENSITY_ALPHA, SPELL_DENSITY_EMISSION, spellDensityFor } from "../dist/code/browser/SpellDensity.js";
import { ENHANCED_GRAPHICS_OVERRIDES } from "../dist/code/browser/ui/EnhancedGraphics.js";
import { COMPARISON_GRAPHICS_OVERRIDES } from "../dist/code/browser/ui/ComparisonProfile.js";
import { settingDefinition } from "../dist/code/browser/ui/SettingsModel.js";
import { SETTING_SECTIONS } from "../dist/code/browser/ui/SettingsSections.js";
import { RENDER_WORKER_COMMANDS } from "../dist/code/browser/RenderWorkerClientProtocol.js";

const IDENTITY = new THREE.Matrix4().elements;
const VIEW = { rightX: 1, rightY: 0, rightZ: 0, upX: 0, upY: 1, upZ: 0 };
const track = (values, times) => ({
  interpolation: 0, globalSequence: -1, components: 1,
  tracks: [{ sequence: 0, times: Uint32Array.from(times), values: Float32Array.from(values) }],
});
const ramp = (values, times, components = 1) => ({ components, times: Float32Array.from(times), values: Float32Array.from(values) });

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
  for (const name of ["emissionSpeed", "speedVariation", "verticalRange", "horizontalRange",
    "gravity", "lifespan", "emissionRate", "emissionAreaLength", "emissionAreaWidth", "zSource",
    "enabledIn"]) blank[name] = { interpolation: 0, globalSequence: -1, components: 1, tracks: [] };
  for (const name of ["color", "opacity", "scale", "headCell", "tailCell"]) {
    blank[name] = { components: name === "color" ? 3 : name === "scale" ? 2 : 1, times: new Float32Array(0), values: new Float32Array(0) };
  }
  return {
    ...blank,
    emissionRate: track([30], [0]), lifespan: track([10], [0]),
    opacity: ramp([0.8], [0]), scale: ramp([1, 1], [0], 2), color: ramp([1, 1, 1], [0], 3),
    ...overrides,
  };
}

const run = (system, frames = 60) => {
  for (let frame = 0; frame < frames; frame++) stepParticles(system, 1 / 60, { matrix: IDENTITY, animationMs: 0, worldMs: 0 });
  return system.particles.length;
};

test("a dense spell emitter spawns twice the authored particles, into a pool twice the size", () => {
  const authored = createParticleSystem(emitter(), new Uint32Array(0), 3);
  const dense = createParticleSystem(emitter(), new Uint32Array(0), 3, spellDensityFor(emitter()));
  assert.equal(dense.capacity, authored.capacity * SPELL_DENSITY_EMISSION);
  const plain = run(authored);
  const thick = run(dense);
  assert.ok(Math.abs(thick - plain * SPELL_DENSITY_EMISSION) <= 2, `${plain} → ${thick}`);
});

test("each of them keeps 0.6 of its authored opacity; a system without density is the client's", () => {
  const opacityOf = (density) => {
    const system = createParticleSystem(emitter(), new Uint32Array(0), 5, density);
    run(system, 2);
    const buffers = createQuadBuffers(system.capacity);
    assert.ok(writeParticleQuads(system, VIEW, buffers) > 0);
    return buffers.colors[3];
  };
  assert.ok(Math.abs(opacityOf(undefined) - 0.8) < 1e-6);
  assert.ok(Math.abs(opacityOf(spellDensityFor(emitter())) - 0.8 * SPELL_DENSITY_ALPHA) < 1e-6);
  assert.ok(SPELL_DENSITY_EMISSION * SPELL_DENSITY_ALPHA <= 1.25, "the added light stays about a fifth over the authored");
});

test("a rune or ring on the ground (XY quad, spawned on the ground) is left as authored", () => {
  assert.equal(spellDensityFor({ flags: PARTICLE_FLAG_XY_QUAD }), undefined);
  assert.equal(spellDensityFor({ flags: PARTICLE_FLAG_SPAWN_ON_GROUND }), undefined);
  assert.deepEqual(spellDensityFor({ flags: 0 }), { emission: SPELL_DENSITY_EMISSION, alpha: SPELL_DENSITY_ALPHA });
});

test("setting: off by default, outside the enhanced preset, off in the comparison profile, beside «Живые эффекты»", async () => {
  const definition = settingDefinition("experimentalSpellDensity");
  assert.equal(definition?.kind, "boolean");
  assert.equal(definition?.fallback, false);
  assert.equal(ENHANCED_GRAPHICS_OVERRIDES.experimentalSpellDensity, undefined);
  assert.equal(COMPARISON_GRAPHICS_OVERRIDES.experimentalSpellDensity, false);
  const section = SETTING_SECTIONS["Эффекты"].find((entry) => entry.title === "Свет и атмосфера");
  assert.equal(section.ids[section.ids.indexOf("experimentalLivingSpells") + 1], "experimentalSpellDensity");
  assert.equal(RENDER_WORKER_COMMANDS.setSpellDensity, "setting");
  const source = (path) => readFile(new URL(`../src/browser/${path}`, import.meta.url), "utf8");
  for (const file of ["ui/Settings.ts", "RendererGraphicsSettings.ts"]) {
    assert.match(await source(file), /setSpellDensity\?\.\(settingBoolean\(values, "experimentalSpellDensity"\)\)/, file);
  }
  const renderer = await source("WorldRenderer3D.ts");
  assert.match(renderer, /\.\.\.\(entry\.spell && this\.#spellDensity \? \{ spellDensity: true \} : \{\}\)/, "spell effects only");
  assert.match(await source("ParticleRender.ts"), /options\.spellDensity \? spellDensityFor\(emitter\) : undefined/);
});
