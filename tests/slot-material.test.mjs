import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import {
  WVM_SLOT_NONE, buildSlotAttribute, createSlotDepthMaterial, createSlotUniforms, slotDepthMaterialFor, slotMapsOf,
  slotStep,
} from "../dist/code/browser/SlotMaterial.js";
import {
  buildModel, cloneMaterialFaded, geosetList, guardSlotFolds, planSlotFolds,
} from "../dist/code/browser/ModelBuild.js";
import { portraitTextureRevision } from "../dist/code/browser/PortraitRenderer.js";
import { shadowDepthStandIn } from "../dist/code/browser/ProgramWarmup.js";
import { BLEND_ALPHA, BLEND_ALPHA_KEY, MATERIAL_TWO_SIDED, MATERIAL_UNLIT } from "../dist/code/browser/Wvm.js";

// --- the planner --------------------------------------------------------------------------------

const fact = (code, texture = "a") => ({
  foldable: !code.startsWith("!"), sided: code.includes("T"), keyed: code.includes("k"),
  fogged: !code.includes("u"), texture, caster: !code.includes("x"), tint: [1, 1, 1, 1],
});
const facts = (codes) => codes.split(" ").map((code, index) => fact(code, `t${index}`));
const spans = (series) => series.map((run) => [run.start, run.end]);

test("merged folds across sides; sameSide splits at a side change", () => {
  assert.deepEqual(spans(planSlotFolds(facts("S T S"), "merged")), [[0, 3]]);
  assert.equal(planSlotFolds(facts("S T S"), "merged")[0].facing, true);
  assert.deepEqual(spans(planSlotFolds(facts("S T S"), "sameSide")), [], "no two adjacent passes share a side");
  assert.deepEqual(spans(planSlotFolds(facts("S S T T"), "sameSide")), [[0, 2], [2, 4]]);
  assert.equal(planSlotFolds(facts("T T"), "merged")[0].facing, false, "all two-sided: a two-sided carrier, no per-slot side");
  assert.deepEqual(planSlotFolds(facts("S T S"), "coalesce"), []);
  assert.deepEqual(planSlotFolds(facts("S T S"), "off"), []);
});

test("a barrier, a fog change and the limits end a series", () => {
  assert.deepEqual(spans(planSlotFolds(facts("S !S S"), "merged")), [], "an unfoldable pass in between leaves two runs of one");
  assert.deepEqual(spans(planSlotFolds(facts("S S !S S S"), "merged")), [[0, 2], [3, 5]]);
  assert.deepEqual(spans(planSlotFolds(facts("S Su"), "merged")), [], "one fog switch per carrier");
  // Five distinct textures: four fit, the fifth starts a run of one.
  assert.deepEqual(spans(planSlotFolds(facts("S S S S S"), "merged")), [[0, 4]]);
  assert.deepEqual(spans(planSlotFolds(facts("S S S S S S"), "merged", 2)), [[0, 2], [2, 4], [4, 6]], "the renderer's sampler limit");
  // Nine passes of one texture: eight rows, then a run of one.
  const same = Array.from({ length: 9 }, () => fact("S", "same"));
  assert.deepEqual(spans(planSlotFolds(same, "merged")), [[0, 8]]);
  assert.equal(planSlotFolds(same, "merged")[0].samplers, 1, "one picture, one sampler");
  assert.equal(planSlotFolds([fact("S", "x"), fact("Sk", "y"), fact("S", "x")], "merged")[0].samplers, 2);
});

test("one mesh carries one custom depth: the guard", () => {
  const keyed = facts("S Sk !S S Sk");
  const both = planSlotFolds(keyed, "merged");
  assert.equal(both.length, 2);
  assert.deepEqual(guardSlotFolds(keyed, both), [], "two carriers needing slot depth cannot share the mesh's one");
  const caster = facts("S Sk !S");
  assert.deepEqual(guardSlotFolds(caster, planSlotFolds(caster, "merged")), [],
    "an unfolded shadow caster would be drawn with the carrier's depth shader");
  const glow = [fact("S", "a"), fact("Sk", "b"), fact("!Sx", "c")];
  assert.equal(guardSlotFolds(glow, planSlotFolds(glow, "merged")).length, 1, "an unfolded non-caster is fine");
  const plain = facts("S S !S");
  assert.equal(guardSlotFolds(plain, planSlotFolds(plain, "merged")).length, 1, "no slot depth, no constraint");
  const twoRuns = [fact("S", "a"), fact("Sk", "b"), fact("!Sx", "c"), fact("S", "d"), fact("S", "e")];
  assert.equal(planSlotFolds(twoRuns, "merged").length, 2);
  assert.deepEqual(guardSlotFolds(twoRuns, planSlotFolds(twoRuns, "merged")), [],
    "a plain carrier beside a slot-depth carrier would be drawn with its depth shader");
  const plainRuns = facts("S S !Sx S S");
  assert.equal(guardSlotFolds(plainRuns, planSlotFolds(plainRuns, "merged")).length, 2, "two plain carriers are fine");
});

test("the slot attribute, and a vertex two slots would claim", () => {
  const indices = [0, 1, 2, 2, 3, 4, 5, 6, 7];
  const slots = buildSlotAttribute(9, indices, [{ start: 0, count: 3, slot: 0 }, { start: 6, count: 3, slot: 1 }]);
  assert.deepEqual([...slots], [0, 0, 0, WVM_SLOT_NONE, WVM_SLOT_NONE, 1, 1, 1, WVM_SLOT_NONE]);
  assert.equal(buildSlotAttribute(9, indices, [{ start: 0, count: 3, slot: 0 }, { start: 3, count: 3, slot: 1 }]), undefined,
    "vertex 2 is in both");
});

// --- buildModel ---------------------------------------------------------------------------------

const batch = (submesh, changes = {}) => ({ submesh, blendMode: 0, materialFlags: 0,
  priorityPlane: 0, materialLayer: 0, textures: [0], uvSets: [0], shaderId: 0,
  colorIndex: 65535, textureWeight: -1, textureTransform: -1, ...changes });

/** Four disjoint triangles: body, hair (two-sided), body again, and a fourth pass per test. */
function model(fourth = batch(3, { textures: [2] }), extra = {}) {
  return {
    positions: Float32Array.from({ length: 36 }, (_, index) => index / 10),
    normals: new Float32Array(36), uv0: new Float32Array(24), uv1: new Float32Array(24),
    boneIndices: new Uint8Array(48), boneWeights: Float32Array.from({ length: 48 }, (_, index) => index % 4 === 0 ? 1 : 0),
    indices: Uint16Array.from({ length: 12 }, (_, index) => index),
    submeshes: Array.from({ length: 4 }, (_, index) => ({ geosetId: 0, indexStart: index * 3, indexCount: 3 })),
    batches: [batch(0), batch(1, { textures: [1], materialFlags: MATERIAL_TWO_SIDED }), batch(2), fourth],
    textures: [{ type: 0, flags: 0, path: "Body.blp" }, { type: 0, flags: 0, path: "Hair.blp" }, { type: 0, flags: 0, path: "Cape.blp" }],
    attachments: [], bounds: { min: [0, 0, 0], max: [1, 1, 2], radius: 2 },
    colours: [], textureWeights: [], textureTransforms: [], globalSequences: new Uint32Array(),
    ...extra,
  };
}

function build(source, slotFold, slotLimit) {
  return buildModel(source, { modelPath: "Character/Test.m2", baseUrl: "http://test", skinned: true,
    geosets: geosetList([0]), coalesceAdjacentBatches: true, slotFold, ...(slotLimit ? { slotLimit } : {}),
    loadTexture(url) { const texture = new THREE.Texture(); texture.name = url; return texture; } });
}

const stream = (built) => built.geometry.groups.flatMap((group) =>
  Array.from(built.geometry.index.array.subarray(group.start, group.start + group.count)));

test("merged: a body of four passes is one group and one carrier, over the same triangle stream", () => {
  const off = build(model(), "off");
  const merged = build(model(), "merged");
  assert.equal(off.geometry.groups.length, 3, "body atlas joined, hair and cape apart");
  assert.equal(merged.geometry.groups.length, 1);
  assert.deepEqual(stream(merged), stream(off), "no triangle moves");
  const carrier = merged.materials[0];
  assert.ok(carrier instanceof THREE.MeshStandardMaterial);
  assert.equal(carrier.side, THREE.DoubleSide);
  assert.equal(carrier.shadowSide, THREE.DoubleSide);
  assert.equal(carrier.alphaTest, 0, "no keyed slot, no alpha test");
  assert.equal(carrier.map.name, "http://test/texture?path=Body.blp");
  assert.deepEqual(slotMapsOf(carrier).map((texture) => texture.name),
    ["http://test/texture?path=Hair.blp", "http://test/texture?path=Cape.blp"]);
  assert.equal(carrier.wvmMap1, slotMapsOf(carrier)[0], "accounting sees the extra textures as properties");
  assert.match(carrier.customProgramCacheKey(), /wvm-slots-v1:n3:f1/);
  const slots = merged.geometry.getAttribute("wvmSlot");
  assert.ok(slots.array instanceof Uint8Array);
  // Group order after gathering: body 0, body 2, hair 1, cape 3 → slots 0, 0, 1, 2 (the bodies joined first).
  assert.deepEqual([...slots.array], [0, 0, 0, 1, 1, 1, 0, 0, 0, 2, 2, 2]);
  assert.ok(slotDepthMaterialFor(merged.materials), "mixed sides cast through the slot depth shader");
  assert.deepEqual(merged.slotFolds, { groupsBefore: 3, groupsAfter: 1, series: 1, customDepth: true });
  assert.deepEqual(merged.texturePaths, off.texturePaths);
  assert.equal(off.slotFolds, undefined, "an unfolded build carries no summary");
});

test("sameSide keeps the side change; a keyed slot sets the client's threshold", () => {
  const keyedCape = model(batch(3, { textures: [2], blendMode: BLEND_ALPHA_KEY }));
  const sameSide = build(keyedCape, "sameSide");
  // body(0+2) | hair(T) | cape(S, keyed): only the two-sided hair breaks it, and runs of one stay.
  assert.equal(sameSide.geometry.groups.length, 3);
  assert.equal(sameSide.slotFolds.series, 0);
  const merged = build(keyedCape, "merged");
  assert.equal(merged.geometry.groups.length, 1);
  assert.equal(merged.materials[0].alphaTest, 224 / 255);
  const slotsAt = createSlotUniforms([], [{ sampler: 0, tint: [1, 1, 1, 1], keyed: false, sided: false }]);
  assert.equal(slotsAt.wvmSlotKeyed.value[0], 0);
});

test("what never folds: unlit, blended, animated and layered passes stay groups", () => {
  for (const fourth of [batch(3, { textures: [2], materialFlags: MATERIAL_UNLIT }), batch(3, { textures: [2], blendMode: BLEND_ALPHA })]) {
    const built = build(model(fourth), "merged");
    // body + hair fold (no keyed, mixed sides need slot depth), the fourth stays; a blended or unlit
    // fourth casts no shadow, so the guard lets the fold stand.
    assert.equal(built.geometry.groups.length, 2, `fourth ${JSON.stringify(fourth)}`);
  }
  // An unknown blend mode is opaque to the shadow policy (applyBlendMode's default): a caster that
  // never folds, so beside a slot-depth carrier it cancels the fold.
  const unknown = build(model(batch(3, { textures: [2], blendMode: 9 })), "merged");
  assert.equal(unknown.slotFolds.series, 0);
  // A colour track that moves keeps its pass out of the carrier — and an opaque lit pass is a
  // shadow caster, which beside a slot-depth carrier (mixed sides) cancels the whole fold.
  const moving = model(batch(3, { textures: [2], colorIndex: 0 }), {
    colours: [{ rgb: { interpolation: 1, globalSequence: -1, components: 3, tracks: [{ sequence: 0, times: new Uint32Array([0, 100]), values: new Float32Array([1, 1, 1, 0, 0, 0]) }] },
      alpha: { interpolation: 0, globalSequence: -1, components: 1, tracks: [] } }],
  });
  const animated = build(moving, "merged");
  assert.equal(animated.slotFolds.series, 0);
  assert.equal(animated.geometry.groups.length, 3);
  // The same submesh drawn twice (a layered pass) never folds; here it also is a shadow caster
  // next to a slot-depth carrier, so the guard keeps the whole build unfolded.
  const layered = build(model(batch(0, { textures: [2] })), "merged");
  assert.equal(layered.slotFolds.series, 0);
  // A blended layer over the body's triangles: its twin, the body pass, stays out even though the
  // layer itself never folds (the vertex check alone would not see it).
  const overlay = build(model(batch(0, { textures: [2], blendMode: BLEND_ALPHA })), "merged");
  assert.equal(overlay.slotFolds.series, 0, "a pass with a layer over it does not fold");
});

test("the carrier's shaders: one substitution each, side branches only when facing", () => {
  const uniforms = createSlotUniforms([new THREE.Texture()], [
    { sampler: 0, tint: [1, 1, 1, 1], keyed: false, sided: false },
    { sampler: 1, tint: [0.5, 1, 1, 1], keyed: true, sided: true },
  ]);
  const surface = (facing) => {
    const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader };
    slotStep(uniforms, 2, facing).apply(shader);
    return shader;
  };
  const faced = surface(true), flat = surface(false);
  assert.match(faced.vertexShader, /attribute float wvmSlot;/);
  assert.match(faced.vertexShader, /#include <uv_vertex>\n\tvWvmSlot = wvmSlot;/);
  assert.match(faced.fragmentShader, /if \( diffuseColor\.a < alphaTest \* wvmSlotKeyed\[ wvmS \] \) discard;/);
  assert.match(faced.fragmentShader, /#if defined\( DOUBLE_SIDED \)[\s\S]*! gl_FrontFacing \) discard;[\s\S]*#elif defined\( FLIP_SIDED \)/);
  assert.doesNotMatch(flat.fragmentShader, /gl_FrontFacing|FLIP_SIDED/);
  assert.doesNotMatch(faced.fragmentShader, /#include <map_fragment>|#include <alphatest_fragment>/);
  assert.match(faced.fragmentShader, /texture2D\( wvmMap1, vMapUv \)/);
  assert.doesNotMatch(faced.fragmentShader, /texture2D\( wvmMap2, vMapUv \)/, "only the samplers it has");
  assert.strictEqual(faced.uniforms.wvmSlotTint, uniforms.wvmSlotTint, "shared uniform objects");
  const depth = createSlotDepthMaterial(uniforms, 2, true);
  const depthShader = { uniforms: {}, vertexShader: THREE.ShaderLib.depth.vertexShader, fragmentShader: THREE.ShaderLib.depth.fragmentShader };
  depth.onBeforeCompile(depthShader);
  assert.match(depthShader.fragmentShader, /if \( wvmSlotSided\[ wvmS \] < 0\.5 && gl_FrontFacing \) discard;/,
    "a single-sided slot keeps only back faces in the depth pass, like BackSide");
  assert.match(depthShader.fragmentShader, /diffuseColor \*= wvmTexel;/);
  assert.equal(depth.customProgramCacheKey(), "wvm-slot-depth-v1:n2:f1");
  const noFacing = createSlotDepthMaterial(uniforms, 2, false);
  const noFacingShader = { uniforms: {}, vertexShader: THREE.ShaderLib.depth.vertexShader, fragmentShader: THREE.ShaderLib.depth.fragmentShader };
  noFacing.onBeforeCompile(noFacingShader);
  assert.doesNotMatch(noFacingShader.fragmentShader, /gl_FrontFacing/);
});

test("fade copies, portraits, depth warm-up and disposal follow the carrier", () => {
  const merged = build(model(), "merged");
  const carrier = merged.materials[0];
  const faded = cloneMaterialFaded(carrier, 0.5);
  assert.equal(faded.customProgramCacheKey(), carrier.customProgramCacheKey(), "the fade copy keeps the slot program key");
  assert.equal(faded.forceSinglePass, true, "a mixed-side carrier's fade copy draws in one pass, keeping the authored order");
  const plainOff = build(model(), "off");
  assert.equal(cloneMaterialFaded(plainOff.materials[0], 0.5).forceSinglePass, false, "other materials keep three's two passes");
  assert.equal(slotDepthMaterialFor(merged.materials).customProgramCacheKey(), "wvm-slot-depth-v1:n1:f1",
    "a facing-only carrier never alpha-tests: its depth samples one texture");
  assert.equal(shadowDepthStandIn(carrier).customProgramCacheKey(), slotDepthMaterialFor(merged.materials).customProgramCacheKey(),
    "registered without its mesh, a carrier still warms its slot depth program");
  assert.strictEqual(faded.onBeforeCompile, carrier.onBeforeCompile);
  assert.equal(faded.opacity, 0.5);
  const before = portraitTextureRevision(merged);
  slotMapsOf(carrier)[1].version++;
  assert.notEqual(portraitTextureRevision(merged), before, "a late slot texture redraws the portrait");
  const depth = slotDepthMaterialFor(merged.materials);
  const standIn = shadowDepthStandIn(carrier, depth);
  assert.equal(standIn.customProgramCacheKey(), depth.customProgramCacheKey(), "the warm pass compiles the custom depth program");
  let disposed = false;
  depth.addEventListener("dispose", () => { disposed = true; });
  carrier.dispose();
  assert.equal(disposed, true, "the slot depth material goes with its carrier");
});

test("a carrier's arithmetic is the lone pass's: tint where colour and opacity were", () => {
  // Static tint of the hair pass: colour (0.5, 0.25, 1) at full alpha, from a one-key track.
  const tinted = model(undefined, {
    colours: [{ rgb: { interpolation: 0, globalSequence: -1, components: 3, tracks: [{ sequence: 0, times: new Uint32Array([0]), values: new Float32Array([0.5, 0.25, 1]) }] },
      alpha: { interpolation: 0, globalSequence: -1, components: 1, tracks: [] } }],
  });
  tinted.batches[1] = batch(1, { textures: [1], materialFlags: MATERIAL_TWO_SIDED, colorIndex: 0 });
  const off = build(tinted, "off");
  const merged = build(tinted, "merged");
  const hairOff = off.materials[1];
  assert.deepEqual(hairOff.color.toArray(), [0.5, 0.25, 1]);
  const carrier = merged.materials[0];
  assert.deepEqual(carrier.color.toArray(), [1, 1, 1], "the carrier stays white");
  assert.equal(carrier.opacity, 1);
  // The uniform rows are reachable through the shader hook.
  const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader };
  carrier.onBeforeCompile(shader, undefined);
  assert.deepEqual(shader.uniforms.wvmSlotTint.value[1].toArray(), [0.5, 0.25, 1, 1]);
  assert.deepEqual(shader.uniforms.wvmSlotSided.value.slice(0, 3), [0, 1, 0]);
  assert.deepEqual(shader.uniforms.wvmSlotSampler.value.slice(0, 3), [0, 1, 2]);
});

test("the wiring: unit meshes carry the slot depth, and the warm pass reads it", async () => {
  const { readFile } = await import("node:fs/promises");
  const animated = await readFile(new URL("../src/browser/AnimatedModel.ts", import.meta.url), "utf8");
  const renderer = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  assert.match(animated, /const slotDepth = slotDepthMaterialFor\(material\);\s+if \(slotDepth\) mesh\.customDepthMaterial = slotDepth;/);
  // Every plain Mesh made from a build (a mount without a rig, attachments) takes it too.
  const meshes = renderer.match(/const mesh = new THREE\.Mesh\(built\.geometry, (?:built\.)?materials\);\n\s*applySlotDepth\(mesh\);/g) ?? [];
  assert.equal(meshes.length, 4);
  const warmup = await readFile(new URL("../src/browser/ProgramWarmup.ts", import.meta.url), "utf8");
  assert.match(warmup, /shadowDepthStandIn\(material, \(mesh as THREE\.Mesh \| undefined\)\?\.customDepthMaterial\)/);
  assert.match(renderer, /slotFold: cache === this\.#builtUnits && skinned \? UNIT_SLOT_FOLD : "off",/);
  assert.match(renderer, /slotLimit: Math\.min\(WVM_SLOT_SAMPLERS, this\.#renderer\.capabilities\.maxTextures - 8\),/);
});
