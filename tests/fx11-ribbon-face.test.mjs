// 15.11 (fx11, 6.15): which face of a ribbon Wow.exe keeps, against stand frames of the original client (WowOracle
// `runs/fx11-rib-haunt-500` #1023 and `fx11-rib-assn-200` #1012: the Haunt and Assassinate missiles' ribbons, M2 material
// flags 0x13, drawn as D3D triangle strips with D3DCULL_CW; the Haunt kit's other ribbons, whose materials set bit 4, with
// D3DCULL_NONE). CW is also what the original sets for a one-sided M2 batch, which this client draws as FrontSide over
// the file's own triangles; so the face to keep follows from the strip's own order (0x00980b70: below_k, above_k,
// below_k+1, …) against this client's quads.
import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { createQuadBuffers } from "../dist/code/browser/Particles.js";
import { createRibbonSystem, ribbonDrawState, stepRibbon, writeRibbonStrip } from "../dist/code/browser/RibbonEmitter.js";
import { buildModelEffects } from "../dist/code/browser/ParticleRender.js";

const NONE = new Uint32Array(0);
const track = (value, components = 1) => ({ interpolation: 0, globalSequence: -1, components,
  tracks: [{ sequence: 0, times: Uint32Array.of(0), values: Float32Array.of(...Array(components).fill(value)) }] });
const emptyTrack = (components = 1) => ({ interpolation: 0, globalSequence: -1, components, tracks: [] });

function ribbon(materials) {
  return {
    id: 1, bone: 0, position: [0, 0, 0], textures: Uint16Array.of(0), materials,
    edgesPerSecond: 30, edgeLifetime: 1, gravity: 0, textureRows: 1, textureColumns: 1,
    priorityPlane: 0, ribbonColorIndex: 0, textureTransformLookupIndex: 0,
    color: emptyTrack(3), alpha: emptyTrack(), textureSlot: emptyTrack(), visibility: emptyTrack(),
    heightAbove: track(1), heightBelow: track(1),
  };
}

test("a culled ribbon keeps the face the original's strip keeps", () => {
  const trail = createRibbonSystem(ribbon([{ blendMode: 4, flags: 0x13 }]), NONE);
  const move = new THREE.Matrix4();
  for (let frame = 0; frame < 12; frame++) {
    move.makeTranslation(frame * 0.3, 0, 0);
    stepRibbon(trail, 1 / 30, { matrix: move.elements, animationMs: 100 + frame * 33, worldMs: 0 });
  }
  const buffers = createQuadBuffers(trail.capacity);
  assert.ok(writeRibbonStrip(trail, buffers) > 2);
  const corner = (index) => new THREE.Vector3().fromArray(buffers.positions, index * 3);
  // This client's first triangle (createQuadBuffers: 0, 1, 2) over the quad below_k, below_k+1, above_k+1, above_k …
  const [b0, b1, a1, a0] = [0, 1, 2, 3].map(corner);
  const ours = new THREE.Vector3().subVectors(b1, b0).cross(new THREE.Vector3().subVectors(a1, b0));
  // … and the original's first strip triangle over the same edges: below_k, above_k, below_k+1.
  const original = new THREE.Vector3().subVectors(a0, b0).cross(new THREE.Vector3().subVectors(b1, b0));
  assert.ok(ours.length() > 0 && original.length() > 0);
  assert.ok(ours.dot(original) < 0, "the two orders turn opposite ways");
  // The original culls CW = keeps the faces a one-sided batch keeps, which three calls front over the original order:
  // over this client's order that is the back face.
  assert.equal(ribbonDrawState(0x13, 4).face, "back");
  assert.equal(ribbonDrawState(0x13 | 0x04, 2).face, "both");
});

test("a lit ribbon is its texture alone, an unlit one takes its vertex colours (color_t1 vs cdiffuse_t1)", () => {
  // WowOracle fx11-rib2-misd-300 #1005–1012 (Misdirection's head ribbons, flags 0x14) and fx11-rib2-frog-* (ArrowFrog,
  // 0x16): vertex shader color_t1.bls, colour 1.0 for every vertex; the Haunt and Assassinate ribbons (0x13):
  // cdiffuse_t1.bls, the vertex diffuse.
  const model = {
    globalSequences: NONE, particleEmitters: [],
    ribbonEmitters: [ribbon([{ blendMode: 4, flags: 0x14 }]), ribbon([{ blendMode: 4, flags: 0x13 }])],
    textures: [{ type: 0, path: "spells\\arrow.blp" }],
  };
  const effects = buildModelEffects(model, { baseUrl: "http://gateway", loadTexture: () => new THREE.Texture() });
  assert.ok(effects);
  const [lit, unlit] = effects.emitters;
  assert.equal(lit.material.vertexColors, false, "lit (0x14): colour 1");
  assert.equal(lit.material.side, THREE.DoubleSide, "0x14 sets bit 4");
  assert.equal(unlit.material.vertexColors, true, "unlit (0x13): the vertex diffuse");
});

test("a built ribbon's material is one-sided only where the original culls it", () => {
  const model = {
    globalSequences: NONE, particleEmitters: [],
    ribbonEmitters: [ribbon([{ blendMode: 4, flags: 0x13 }]), ribbon([{ blendMode: 2, flags: 0x17 }])],
    textures: [{ type: 0, path: "spells\\a.blp" }],
  };
  const effects = buildModelEffects(model, { baseUrl: "http://gateway", loadTexture: () => new THREE.Texture() });
  assert.ok(effects);
  const [haunt, kit] = effects.emitters;
  assert.equal(haunt.material.side, THREE.BackSide, "haunt_missile's ribbon (0x13): culled");
  assert.equal(kit.material.side, THREE.DoubleSide, "a ribbon with bit 4: both faces");
  assert.equal(haunt.material.depthWrite, false);
  assert.equal(haunt.material.alphaTest, 1 / 255);
});
