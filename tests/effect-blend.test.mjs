// Slice Э1: what a batch's blend mode means for fog, for lighting and for a second texture layer.
//
// Everything here is about the material a build makes, not about the file it is made from — the
// file's own numbers are `tests/m2.test.mjs` and `tests/batch-colour.test.mjs`. Three things were
// being decided the same way for every batch and are not the same for all of them: distance mixes
// the fog colour in (which an additive card must never do), the sun shades a batch unless a flag
// forbids it (which an additive card must never allow), and the second texture unit was dropped.
//
// The shader source is inspected rather than rendered. `onBeforeCompile` is where all three of
// those decisions land, and there is no WebGL context in `node --test`; what the substitutions
// produce is a string, and a string is exactly what a test can hold to.

import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { EVERY_GEOSET, buildModel, setBuiltModelFantasyGlow } from "../dist/code/browser/ModelBuild.js";
import { ModelTextureLoader } from "../dist/code/browser/TextureLoad.js";

const MATERIAL_UNLIT = 0x01;

/**
 * A second UV set the artist filled in, for the three vertices `material` builds.
 *
 * Needed explicitly because a zeroed one now means "there is no second set": a file may point a
 * unit at set 1 and never write it, and 43 batches in 43 `item\` models do exactly that. See
 * `authoredSecondUvSet` and the two tests below.
 */
const SECOND_UV_SET = Float32Array.from([0, 0, 1, 0, 0, 1]);

function batch(overrides = {}) {
  return {
    submesh: 0, blendMode: 0, materialFlags: 0, priorityPlane: 0, materialLayer: 0,
    textures: [0], uvSets: [0], shaderId: 0, colorIndex: 0xffff, textureWeight: -1,
    textureTransform: -1, ...overrides,
  };
}

/** One batch, built the way the renderer builds it, and the material it produced. */
function material(overrides, extras = {}, buildOptions = {}) {
  const model = {
    positions: new Float32Array(9), normals: new Float32Array(9),
    uv0: new Float32Array(6), uv1: new Float32Array(6),
    indices: new Uint16Array([0, 1, 2]),
    submeshes: [{ geosetId: 0, indexStart: 0, indexCount: 3 }],
    batches: [batch(overrides)],
    textures: [
      { type: 0, flags: 0, path: "Spells\\Layer0.blp" },
      { type: 0, flags: 0, path: "Spells\\Layer1.blp" },
    ],
    attachments: [],
    bounds: { min: [0, 0, 0], max: [1, 1, 1], radius: 1 },
    globalSequences: new Uint32Array(0),
    particleEmitters: [], ribbonEmitters: [], colours: [], textureWeights: [], textureTransforms: [],
    ...extras,
  };
  const built = buildModel(model, {
    modelPath: "Spells\\Test.m2", baseUrl: "http://127.0.0.1:8090",
    loadTexture: () => new THREE.Texture(), geosets: EVERY_GEOSET, ...buildOptions,
  });
  return built.materials[0];
}

/**
 * The shader source a material's handler leaves behind.
 *
 * The templates are three's own, unresolved, which is what a handler is actually handed: three
 * calls `onBeforeCompile` before `WebGLProgram` expands the `#include`s
 * (`three.module.js:18210`, and `resolveIncludes` runs inside the constructor below it).
 */
function compiled(material) {
  const shader = {
    vertexShader: THREE.ShaderLib.basic.vertexShader,
    fragmentShader: THREE.ShaderLib.basic.fragmentShader,
    uniforms: {},
    defines: {},
  };
  material.onBeforeCompile(shader, undefined);
  return shader;
}

test("Э1 fog dims an additive batch instead of mixing the fog colour into it", () => {
  // three's `fog_fragment` is `mix( gl_FragColor.rgb, fogColor, fogFactor )` for everything. On a
  // card composited `SrcAlpha/One` that adds the fog colour to the scene, so the card's own black
  // corners light up and a glow becomes a rectangle hanging in the air. The reference client
  // branches on exactly this: `wowee/assets/shaders/m2.frag.glsl:261-269`.
  for (const blendMode of [3, 4, 7]) {
    const source = compiled(material({ blendMode })).fragmentShader;
    assert.ok(source.includes("gl_FragColor.rgb *= ( 1.0 - fogFactor );"),
      `blend mode ${blendMode} dims with distance`);
    assert.ok(!source.includes("mix( gl_FragColor.rgb, fogColor"),
      `blend mode ${blendMode} does not mix the fog colour in`);
    assert.ok(!source.includes("#include <fog_fragment>"), "and the chunk really was replaced");
  }
});

test("Э1 an alpha-blended batch keeps three's own fog", () => {
  // The other side of the same switch. Mode 2 composites by source alpha, which is exactly what
  // three's chunk assumes, so nothing is substituted at all.
  const source = compiled(material({ blendMode: 2, materialFlags: MATERIAL_UNLIT })).fragmentShader;
  assert.ok(source.includes("#include <fog_fragment>"), "the chunk is left alone");
  assert.ok(!source.includes("1.0 - fogFactor"));
});

test("fantasy glow lifts only explicitly spell-owned additive batches in the existing pass", () => {
  const baseline = material({ blendMode: 4 }, {}, { fantasyGlow: false });
  const fantasy = material({ blendMode: 4 }, {}, { fantasyGlow: true });
  const ordinary = material({ blendMode: 2 }, {}, { fantasyGlow: true });
  assert.doesNotMatch(compiled(baseline).fragmentShader, /spell-fantasy-glow-v1/);
  assert.match(compiled(fantasy).fragmentShader, /spell-fantasy-glow-v1/);
  assert.match(fantasy.customProgramCacheKey(), /spell-fantasy-glow-v1/);
  assert.doesNotMatch(compiled(ordinary).fragmentShader, /spell-fantasy-glow-v1/,
    "opaque/alpha surfaces keep their authored colour and lighting");
  const baselineKey = baseline.customProgramCacheKey();
  setBuiltModelFantasyGlow({ materials: [baseline] }, true);
  assert.match(compiled(baseline).fragmentShader, /spell-fantasy-glow-v1/,
    "an already-built spell material updates in place");
  assert.match(baseline.customProgramCacheKey(), /spell-fantasy-glow-v1/);
  setBuiltModelFantasyGlow({ materials: [baseline] }, false);
  assert.doesNotMatch(compiled(baseline).fragmentShader, /spell-fantasy-glow-v1/);
  assert.equal(baseline.customProgramCacheKey(), baselineKey, "OFF restores the exact prior program key");

  const malformed = { vertexShader: "", fragmentShader: "void main() {}", uniforms: {}, defines: {} };
  setBuiltModelFantasyGlow({ materials: [baseline] }, true);
  assert.throws(() => baseline.onBeforeCompile(malformed, undefined), /exactly one MeshBasic color marker/);
});

test("Э1 a modulating batch fades towards its own identity rather than towards black", () => {
  // Modes 5 and 6 multiply what is already in the frame. Mixing the fog colour in is wrong for the
  // same reason as for an additive card, and dimming towards black is worse still — it would paint
  // the distance out. White is the identity of `DstColor*SrcColor`. Mod2x's identity is strictly
  // 0.5 and rides the same branch: there is 1 mod batch and 11 mod2x in the whole of `spells\`.
  for (const blendMode of [5, 6]) {
    const source = compiled(material({ blendMode })).fragmentShader;
    assert.ok(source.includes("mix( gl_FragColor.rgb, vec3( 1.0 ), fogFactor );"), `blend mode ${blendMode}`);
  }
});

test("Э1 an additive batch is unlit whether or not the file says so", () => {
  // 153 of the 2,625 additive batches under `spells\` do not set `MATERIAL_UNLIT`, and those were
  // built as `MeshStandardMaterial` and multiplied by N·L: a flat glow card that dims as it turns
  // away from the sun, so the effect flickers as the caster turns.
  assert.ok(material({ blendMode: 4 }).isMeshBasicMaterial, "additive, no flag");
  assert.ok(material({ blendMode: 3 }).isMeshBasicMaterial, "and the other additive mode");
  assert.ok(material({ blendMode: 0, materialFlags: MATERIAL_UNLIT }).isMeshBasicMaterial, "the flag still counts");
  assert.ok(material({ blendMode: 0 }).isMeshStandardMaterial, "an opaque surface is still shaded");
  assert.ok(material({ blendMode: 7 }).isMeshStandardMaterial,
    "and mode 7 composites over what is behind it, so it keeps its shading");
});

test("Э1 a batch that needs two substitutions gets both, because the handler is a chain", () => {
  // The mutation this exists to catch is `material.onBeforeCompile = …` written twice: the second
  // assignment throws the first away silently, and one of the two fixes disappears with no error
  // anywhere. A two-unit additive batch needs the layer fold *and* the additive fog.
  const built = material({ blendMode: 4, textures: [0, 1], uvSets: [0, 1] }, { uv1: SECOND_UV_SET });
  const source = compiled(built).fragmentShader;
  assert.ok(source.includes("vec4 wvmLayer = texture2D( alphaMap, vAlphaMapUv );"), "the second layer");
  assert.ok(source.includes("gl_FragColor.rgb *= ( 1.0 - fogFactor );"), "and the additive fog");
  // And three is told the two programs differ, or it would hand this material whichever program a
  // one-substitution material compiled first.
  assert.equal(built.customProgramCacheKey(), "wvm-layer2-0|wvm-fog-4");
});

test("Э1 the second texture unit is sampled, and folded the way shaderId says", () => {
  // `buildModel` took `batch.textures[0]` and stopped: 528 batches in 207 models under `spells\`
  // drew one layer of two. 0 multiplies, 1 adds, 2 multiplies doubled — and 398 of the 423 batches
  // this path takes are shaderId 0, which is what that reading is worth if it is wrong.
  const fold = (shaderId) =>
    compiled(material({ blendMode: 4, shaderId, textures: [0, 1], uvSets: [0, 1] }, { uv1: SECOND_UV_SET }))
      .fragmentShader;
  assert.ok(fold(0).includes("diffuseColor.rgb *= wvmLayer.rgb;"), "shaderId 0 multiplies");
  assert.ok(fold(0).includes("diffuseColor.a *= wvmLayer.a;"), "and carries the layer's alpha");
  assert.ok(fold(1).includes("diffuseColor.rgb += wvmLayer.rgb;"), "shaderId 1 adds");
  assert.ok(fold(2).includes("diffuseColor.rgb *= wvmLayer.rgb * 2.0;"), "shaderId 2 doubles");
  const built = material({ blendMode: 4, textures: [0, 1], uvSets: [0, 1] }, { uv1: SECOND_UV_SET });
  assert.ok(built.alphaMap, "and the layer is bound where three can see it");
  assert.equal(built.alphaMap.channel, 1, "reading the UV set the file gave it");
});

test("Э1 a second unit with no coordinates of its own is left alone", () => {
  // Both units on UV set 0 is not "two layers at the same UVs": outside `spells\` it is the
  // environment reflection, whose coordinates the original client generates from the vertex normal
  // and the eye. `item\` has 3,893 two-unit batches in 3,081 models and 3,608 of them are
  // `ARMORREFLECT4.BLP` and its neighbours in exactly that shape. Folding a reflection map in at
  // the mesh's own UVs would put a picture of a sky on a sword.
  const built = material({ blendMode: 0, textures: [0, 1], uvSets: [0, 0] });
  assert.equal(built.alphaMap, null, "no second sampler");
  assert.equal(built.onBeforeCompile, THREE.Material.prototype.onBeforeCompile,
    "and no handler at all, because an opaque batch needs no fog substitution either");
});

test("Э1 a batch that names a texture transform gets a texture of its own to move", () => {
  // Two batches of one model that name the same file are handed the *same* `THREE.Texture` by the
  // spell loader, which caches by URL — and 176 batches in 98 models under `spells\` share a
  // texture slot with a batch naming a different transform. Writing the matrix into a shared
  // texture would let the last one written decide where both of them sat.
  const still = { interpolation: 0, globalSequence: -1, components: 3, tracks: [] };
  const model = {
    positions: new Float32Array(18), normals: new Float32Array(18),
    uv0: new Float32Array(12), uv1: new Float32Array(12),
    indices: new Uint16Array([0, 1, 2, 3, 4, 5]),
    submeshes: [{ geosetId: 0, indexStart: 0, indexCount: 3 }, { geosetId: 0, indexStart: 3, indexCount: 3 }],
    batches: [batch({ textureTransform: 0 }), batch({ submesh: 1, textureTransform: -1 })],
    textures: [{ type: 0, flags: 0, path: "Spells\\Layer0.blp" }],
    attachments: [],
    bounds: { min: [0, 0, 0], max: [1, 1, 1], radius: 1 },
    globalSequences: new Uint32Array(0),
    particleEmitters: [], ribbonEmitters: [], colours: [], textureWeights: [],
    textureTransforms: [{
      translation: { ...still, tracks: [{ sequence: 0, times: Uint32Array.from([0, 1000]), values: Float32Array.from([0, 0, 0, 0.25, 0, 0]) }] },
      rotation: { interpolation: 0, globalSequence: -1, components: 4, tracks: [] },
      scaling: { ...still, tracks: [] },
    }],
  };
  // One texture object per call, as the uncached loader does; the shared case is the cached spell
  // loader, and what matters here is that the two materials do not end up holding one object.
  const shared = new THREE.Texture();
  const built = buildModel(model, {
    modelPath: "Spells\\Test.m2", baseUrl: "http://127.0.0.1:8090",
    loadTexture: () => shared, geosets: EVERY_GEOSET,
  });
  const [moving, still2] = built.materials;
  assert.notEqual(moving.map, still2.map, "the moving batch does not share the still one's texture");
  assert.equal(still2.map, shared, "and the still one keeps what the loader handed over");
  assert.equal(moving.map.matrixAutoUpdate, false, "three must not recompute the matrix over the top");
  assert.equal(built.animatedBatches.length, 1, "the transform is what makes this batch move at all");
  assert.equal(built.animatedBatches[0].material, moving);
});

test("Э1 a second UV set has to be filled in and not merely named", () => {
  // The review's blocker. `uvSets[0] === 1` says a batch samples `uv1`, and the file may say it
  // over vertices whose second set was never written: measured over the archives, 85 batches in 82
  // of the 8,205 readable models under `item\` name it and **43 of them, in 43 models, carry a
  // second set that is zero to the bit** — every `helm_cloth_pvpmage_b_01_*` and
  // `stave_2h_caster_pvp_c_01`. Honouring the number there samples texel (0, 0) for the whole
  // batch: the mage helm's third batch is the 102-vertex cap over the head, painted one flat
  // corner pixel. The guard that used to stand here asked the *geometry* for a `uv1` attribute,
  // which `buildModel` always adds, so it could not fail.
  assert.equal(material({ uvSets: [1] }).map.channel, 0,
    "a zeroed second set is no second set, whatever the batch says");
  assert.equal(material({ uvSets: [1] }, { uv1: SECOND_UV_SET }).map.channel, 1,
    "and an authored one is read, which is what the 3 `creature\\` batches want");
  assert.equal(material({ uvSets: [0] }, { uv1: SECOND_UV_SET }).map.channel, 0,
    "a batch that never asked keeps the first set");
  // The same test on the second texture unit, where it is a smaller matter but the same defect: 10
  // of the 433 batches `secondLayer` would take under `spells\` have a zeroed second set, 1 of 107
  // under `item\` and 3 of 62 under `creature\`.
  assert.equal(material({ blendMode: 4, textures: [0, 1], uvSets: [0, 1] }).alphaMap, null,
    "and no upper layer is folded in at coordinates that are not there");
});

test("Э1 the texture matrix turns the way the file's own quaternion turns", () => {
  // `Matrix3.setUvTransform`'s `rotation` argument is `Texture.rotation` — the angle the *image*
  // turns by — so the matrix it builds is `S·R(−rotation)`, the inverse of the record's own turn.
  // Passing `2·atan2(z, w)` straight in spun every rune backwards; 80 of the 84 rotation keys in
  // the 418 records under `spells\` are pure turns about Z, so it was all of them.
  const key = (components, values) => ({
    interpolation: 0, globalSequence: -1, components,
    tracks: [{ sequence: 0, times: Uint32Array.from([0]), values: Float32Array.from(values) }],
  });
  const quarterTurn = Math.SQRT1_2; // q = (0, 0, sin 45°, cos 45°): +90° about Z, a key the corpus holds.
  const model = {
    positions: new Float32Array(9), normals: new Float32Array(9),
    uv0: new Float32Array(6), uv1: new Float32Array(6),
    indices: new Uint16Array([0, 1, 2]),
    submeshes: [{ geosetId: 0, indexStart: 0, indexCount: 3 }],
    batches: [batch({ textureTransform: 0 })],
    textures: [{ type: 0, flags: 0, path: "Spells\\Layer0.blp" }],
    attachments: [],
    bounds: { min: [0, 0, 0], max: [1, 1, 1], radius: 1 },
    globalSequences: new Uint32Array(0),
    particleEmitters: [], ribbonEmitters: [], colours: [], textureWeights: [],
    textureTransforms: [{
      translation: key(3, [0, 0, 0]),
      rotation: key(4, [0, 0, quarterTurn, quarterTurn]),
      scaling: key(3, [1, 1, 1]),
    }],
  };
  const built = buildModel(model, {
    modelPath: "Spells\\Test.m2", baseUrl: "http://127.0.0.1:8090",
    loadTexture: () => new THREE.Texture(), geosets: EVERY_GEOSET,
  });
  const [surface] = built.materials;
  // `-0` and `0` are the same UV and `deepEqual` says otherwise, so the sign of zero is dropped.
  const round = (value) => (Math.round(value * 1e6) / 1e6) || 0;
  const through = (u, v) => {
    const out = new THREE.Vector3(u, v, 1).applyMatrix3(surface.map.matrix);
    return [round(out.x), round(out.y)];
  };
  // What the record itself says: turn the coordinate about the texture's centre by that quaternion.
  const byRecord = (u, v) => {
    const point = new THREE.Vector3(u - 0.5, v - 0.5, 0)
      .applyQuaternion(new THREE.Quaternion(0, 0, quarterTurn, quarterTurn));
    return [round(point.x + 0.5), round(point.y + 0.5)];
  };
  for (const [u, v] of [[1, 0], [1, 0.5], [0.5, 1], [0, 0]]) {
    assert.deepEqual(through(u, v), byRecord(u, v), `UV (${u}, ${v}) turns the record's way`);
  }
  // Named outright, so a sign flip cannot pass by agreeing with itself: (1, 0) is the corner that
  // goes to (1, 1), and the un-negated angle sent it to (0, 0) instead.
  assert.deepEqual(through(1, 0), [1, 1]);
});

test("Э1 a batch's own texture still becomes the white pixel when its fetch fails", () => {
  // A material with a texture transform holds a *clone*, and a clone copies once. The loader turns
  // a 404 into an opaque white pixel afterwards, writing the bytes into the shared `Source` — which
  // the clone does see — and the flag that decides the upload branch into the object the loader
  // holds, which the material never sees. Without this the clone went down three's image branch,
  // `texSubImage2D` was handed a bare `{data, width, height}`, and what stayed bound was the
  // zero-filled 1×1: transparent black. 154 batches in 35 `creature\` models name a transform and
  // are built by the loader that does not cache, so each of them is exactly this case.
  const still = { interpolation: 0, globalSequence: -1, components: 3, tracks: [] };
  const model = {
    positions: new Float32Array(9), normals: new Float32Array(9),
    uv0: new Float32Array(6), uv1: new Float32Array(6),
    indices: new Uint16Array([0, 1, 2]),
    submeshes: [{ geosetId: 0, indexStart: 0, indexCount: 3 }],
    batches: [batch({ textureTransform: 0 })],
    textures: [{ type: 0, flags: 0, path: "Creature\\Missing.blp" }],
    attachments: [],
    bounds: { min: [0, 0, 0], max: [1, 1, 1], radius: 1 },
    globalSequences: new Uint32Array(0),
    particleEmitters: [], ribbonEmitters: [], colours: [], textureWeights: [],
    textureTransforms: [{
      translation: { ...still, tracks: [{ sequence: 0, times: Uint32Array.from([0, 1000]), values: Float32Array.from([0, 0, 0, 0.25, 0, 0]) }] },
      rotation: { interpolation: 0, globalSequence: -1, components: 4, tracks: [] },
      scaling: { ...still, tracks: [] },
    }],
  };
  const originalLoad = THREE.TextureLoader.prototype.load;
  const requests = [];
  THREE.TextureLoader.prototype.load = function (url, onLoad, _progress, onError) {
    const texture = new THREE.Texture();
    requests.push({ texture, onError });
    return texture;
  };
  let built;
  try {
    const loader = new ModelTextureLoader();
    built = buildModel(model, {
      modelPath: "Creature\\Test.m2", baseUrl: "http://127.0.0.1:8090",
      loadTexture: (url) => loader.load(url), geosets: EVERY_GEOSET,
    });
    assert.equal(requests.length, 1, "one request, and the material holds a clone of what it returned");
    assert.notEqual(built.materials[0].map, requests[0].texture, "a clone, so the matrix is its own");
    requests[0].onError(new Error("missing"));
  } finally {
    THREE.TextureLoader.prototype.load = originalLoad;
  }
  const { map } = built.materials[0];
  assert.equal(map.isDataTexture, true, "three picks its upload branch on this and nothing else");
  assert.ok(map.image?.data instanceof Uint8Array, "with real bytes behind it");
  assert.deepEqual([...map.image.data], [255, 255, 255, 255], "one opaque white pixel");
  assert.deepEqual([map.image.width, map.image.height], [1, 1]);
});
