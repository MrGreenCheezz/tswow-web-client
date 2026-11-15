import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { createQuadBuffers } from "../dist/code/browser/Particles.js";
import {
  createRibbonSystem, ribbonAlphaReference, ribbonDrawState, stepRibbon, writeRibbonStrip,
} from "../dist/code/browser/RibbonEmitter.js";
import { buildModelEffects } from "../dist/code/browser/ParticleRender.js";

// 15.11 (6.15): CRibbonEmitter as Wow.exe 3.3.5a 12340 updates and draws it (read-only Ghidra,
// .runtime/re-2026-11-15/fx7): 0x00980090 rewrites every edge's texture coordinates from the current slot each frame;
// 0x00980b70 sets per pass the depth test from M2 material flag 0x08 (0x00832ea0) and the alpha reference of its
// blend from 0x00ad8b7c through 0x00a45570.

const IDENTITY = new THREE.Matrix4().elements;
const NONE = new Uint32Array(0);
const emptyTrack = (components = 1) => ({ interpolation: 0, globalSequence: -1, components, tracks: [] });

function ribbon(overrides = {}) {
  const blank = {
    id: 1, bone: 0, position: [0, 0, 0], textures: Uint16Array.of(0), materials: [{ blendMode: 4, flags: 0 }],
    edgesPerSecond: 20, edgeLifetime: 2, gravity: 0, textureRows: 1, textureColumns: 1,
    priorityPlane: 0, ribbonColorIndex: 0, textureTransformLookupIndex: 0,
  };
  for (const name of ["color", "alpha", "heightAbove", "heightBelow", "textureSlot", "visibility"]) {
    blank[name] = emptyTrack(name === "color" ? 3 : 1);
  }
  return { ...blank, ...overrides };
}

test("6.15 a stepped slot track moves every laid edge to the new cell row, not only the new ones (0x00980090)", () => {
  // One column, two rows: slot 0 is the top row (v 0…0.5), slot 1 the bottom (v 0.5…1); the track steps at 500 ms.
  const slots = { interpolation: 0, globalSequence: -1, components: 1,
    tracks: [{ sequence: 0, times: Uint32Array.of(0, 500, 1000), values: Float32Array.of(0, 1, 1) }] };
  const trail = createRibbonSystem(ribbon({ textureRows: 2, textureSlot: slots }), NONE);
  const move = new THREE.Matrix4();
  for (let frame = 0; frame < 10; frame++) {
    move.makeTranslation(frame * 0.2, 0, 0);
    stepRibbon(trail, 1 / 30, { matrix: move.elements, animationMs: 100 + frame * 10, worldMs: 0 });
  }
  const laid = trail.edges.length;
  assert.ok(laid > 3, `${laid} edges laid on slot 0`);
  move.makeTranslation(2.2, 0, 0);
  stepRibbon(trail, 1 / 30, { matrix: move.elements, animationMs: 600, worldMs: 0 });
  const buffers = createQuadBuffers(trail.capacity);
  const quads = writeRibbonStrip(trail, buffers);
  assert.ok(quads >= laid);
  for (let quad = 0; quad < quads; quad++) {
    const v = buffers.uvs.subarray(quad * 8, quad * 8 + 8);
    assert.deepEqual([v[1], v[3], v[5], v[7]], [0.5, 0.5, 1, 1], `quad ${quad} on the slot-1 row`);
  }
});

test("6.15 a ribbon pass's alpha reference is 0x00ad8b7c's by its blend, and flag 0x08 turns its depth test off", () => {
  assert.equal(ribbonAlphaReference(0), 0, "opaque");
  assert.equal(ribbonAlphaReference(1), 224 / 255, "alpha key");
  for (const blend of [2, 4, 5, 6]) assert.equal(ribbonAlphaReference(blend), 1 / 255, `blend ${blend}`);
  assert.equal(ribbonAlphaReference(3), 0, "no-alpha add is Gx blend 10, which reads 0");
  assert.deepEqual(ribbonDrawState(0x10 | 0x02, 4), { depthTest: true, alphaTest: 1 / 255 });
  assert.deepEqual(ribbonDrawState(0x10 | 0x08, 2), { depthTest: false, alphaTest: 1 / 255 });
});

test("6.15 a built ribbon carries its pass's depth test and gate, and still writes no depth", () => {
  const model = {
    globalSequences: NONE, particleEmitters: [],
    ribbonEmitters: [ribbon({ textures: Uint16Array.of(0, 1),
      materials: [{ blendMode: 4, flags: 0x10 | 0x08 }, { blendMode: 2, flags: 0x10 }] })],
    textures: [{ type: 0, path: "spells\\a.blp" }, { type: 0, path: "spells\\b.blp" }],
  };
  const effects = buildModelEffects(model, { baseUrl: "http://gateway", loadTexture: () => new THREE.Texture() });
  assert.ok(effects);
  const [leader, further] = effects.emitters;
  assert.equal(leader.material.depthTest, false, "flag 0x08: no depth test");
  assert.equal(leader.material.alphaTest, 1 / 255);
  assert.equal(leader.material.depthWrite, false);
  assert.equal(further.material.depthTest, true);
  assert.equal(further.material.alphaTest, 1 / 255);
  assert.equal(further.material.depthWrite, false);
});
