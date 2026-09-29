import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import { buildModelEffects, disposeModelEffects } from "../dist/code/browser/ParticleRender.js";
import { buildLiquidMaterial } from "../dist/code/browser/Water.js";
import { effectFixture } from "./fixtures/billboard-effects.mjs";

/**
 * three draws a transparent two-sided material in two passes (back faces, then front) unless
 * `forceSinglePass` is set, and on every draw of every frame each pass marks the material changed,
 * so `setProgram` re-derives the program parameters and walks the program cache twice. Quads and
 * height fields have no inside to order, so they draw once.
 */
test("every particle and ribbon material draws in one pass, whatever its blend mode", () => {
  for (const blend of [0, 1, 2, 3, 4, 5, 6, 7]) {
    const model = effectFixture(4);
    model.particleEmitters[0].blendType = blend;
    model.ribbonEmitters[0].materials[0].blendMode = blend;
    const effects = buildModelEffects(model, { baseUrl: "", loadTexture: () => new THREE.Texture(), seed: 1 });
    assert.ok(effects && effects.emitters.length === 2, `blend ${blend} builds both emitters`);
    for (const emitter of effects.emitters) {
      assert.equal(emitter.material.side, THREE.DoubleSide, `blend ${blend}: both faces stay visible`);
      assert.equal(emitter.material.transparent, true);
      assert.equal(emitter.material.forceSinglePass, true, `blend ${blend}: one pass`);
    }
    disposeModelEffects(effects);
  }
});

test("liquid sheets draw in one pass", () => {
  const texture = new THREE.Texture();
  for (const liquidClass of ["water", "ocean", "magma", "slime"]) {
    const liquid = buildLiquidMaterial(liquidClass, { texture, frames: 30 });
    assert.equal(liquid.material.side, THREE.DoubleSide, `${liquidClass} stays two-sided`);
    assert.equal(liquid.material.forceSinglePass, true, `${liquidClass} draws once`);
  }
});
