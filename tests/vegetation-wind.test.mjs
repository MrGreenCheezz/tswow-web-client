import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as THREE from "three";
import { EVERY_GEOSET, buildModel } from "../dist/code/browser/ModelBuild.js";
import {
  BLEND_ALPHA_KEY,
  MATERIAL_NO_DEPTH_TEST,
  MATERIAL_NO_DEPTH_WRITE,
  MATERIAL_TWO_SIDED,
  MATERIAL_UNLIT,
  decodeWvm9,
} from "../dist/code/browser/Wvm.js";
import {
  VEGETATION_WIND_A_UNIFORM,
  VEGETATION_WIND_B_UNIFORM,
  VEGETATION_WIND_MARKER,
  VEGETATION_WIND_TIME,
  VEGETATION_WIND_TIME_UNIFORM,
  installVegetationWind,
  isBotanicalTexturePath,
  isVegetationWindBatch,
  numberText,
  vegetationWindProfileKey,
  windFieldAmplitude,
} from "../dist/code/browser/VegetationWind.js";
import { createModelPlacementTintMaterials } from "../dist/code/browser/ModelPlacementTint.js";
import ts from "typescript";
import { readFile } from "node:fs/promises";

async function currentVegetationWind() {
  const source = await readFile(new URL("../src/browser/VegetationWind.ts", import.meta.url), "utf8");
  const wvmUrl = new URL("../dist/code/browser/Wvm.js", import.meta.url).href;
  const windFieldUrl = new URL("../dist/code/browser/WindField.js", import.meta.url).href;
  // P1-08: the module now builds `THREE.Vector4` uniforms, so "three" is a runtime import too.
  const linked = source.replace('"./Wvm.js"', JSON.stringify(wvmUrl))
    .replace('"./WindField.js"', JSON.stringify(windFieldUrl))
    .replace('from "three"', `from ${JSON.stringify(import.meta.resolve("three"))}`);
  const javascript = ts.transpileModule(linked, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);
}

const sourceWind = await currentVegetationWind();

function batch(overrides = {}) {
  return {
    submesh: 0, blendMode: BLEND_ALPHA_KEY, materialFlags: MATERIAL_TWO_SIDED,
    priorityPlane: 0, materialLayer: 0, textures: [0], uvSets: [0], shaderId: 0,
    colorIndex: 0xffff, textureWeight: -1, textureTransform: -1, ...overrides,
  };
}

function model(batches, submeshes = batches.map((entry) => ({
  geosetId: 0, indexStart: entry.submesh * 3, indexCount: 3,
}))) {
  return { batches, submeshes };
}

const PROFILE = { amplitude: 0.08, frequency: 1.7, phase: 0.25, baseZ: 0, height: 2 };

function shader() {
  return {
    vertexShader: THREE.ShaderLib.basic.vertexShader,
    fragmentShader: THREE.ShaderLib.basic.fragmentShader,
    uniforms: {},
    defines: {},
  };
}

function assertLiveWindMaterial(material) {
  const compiled = shader();
  material.onBeforeCompile(compiled, undefined);
  assert.equal(compiled.uniforms[VEGETATION_WIND_TIME_UNIFORM], VEGETATION_WIND_TIME);
  const previousTime = VEGETATION_WIND_TIME.value;
  try {
    VEGETATION_WIND_TIME.value = 19.25;
    assert.equal(compiled.uniforms[VEGETATION_WIND_TIME_UNIFORM].value, 19.25);
    assert.match(compiled.vertexShader, /uVegetationWindTime/);
  } finally {
    VEGETATION_WIND_TIME.value = previousTime;
  }
}

test("vegetation wind accepts only explicit botanical alpha-key paths", () => {
  assert.equal(sourceWind.isBotanicalTexturePath("World\\Elwynn\\Grass\\TallGrass.blp"), true);
  assert.equal(sourceWind.isBotanicalTexturePath("World\\Elwynn\\Leaves\\OakLeaf.blp"), true);
  assert.equal(sourceWind.isBotanicalTexturePath("World\\Elwynn\\Tree.blp"), true);
  assert.equal(sourceWind.isBotanicalTexturePath("World\\Elwynn\\TreeBark.blp"), false);
  assert.equal(sourceWind.isBotanicalTexturePath("World\\Elwynn\\LeafBranch.blp"), true);
  assert.equal(sourceWind.isBotanicalTexturePath("World\\Elwynn\\GrassBanner.blp"), false);
  assert.equal(sourceWind.isBotanicalTexturePath("World\\Grass\\generic.blp"), false);
  assert.equal(sourceWind.isBotanicalTexturePath("World\\Grass\\grass01.blp"), true);
  assert.equal(sourceWind.isBotanicalTexturePath("World\\Elwynn\\grass.dds"), false);
  assert.equal(sourceWind.isBotanicalTexturePath(""), false);
});

test("source wind recognises shrub, bush, tree and plant foliage instead of dropping whole families", () => {
  for (const path of [
    "World\\Plants\\Bush01.blp",
    "World\\Plants\\ShrubLeaves02.blp",
    "World\\Trees\\TreeCanopy03.blp",
    "WORLD\\AZEROTH\\TREES\\DUSKWOODTREECANOPY11.BLP",
    "World\\Plants\\PlantFronds04.blp",
    "World\\Plants\\Sholazar_UnderbrushA.blp",
    "World\\Ruin\\Plants\\Bush01.blp",
  ]) assert.equal(sourceWind.isBotanicalTexturePath(path), true, path);
  for (const path of [
    "World\\Trees\\TreeBark.blp",
    "World\\Trees\\OakTrunk.blp",
    "World\\Trees\\TreeWood.blp",
    "World\\Rocks\\TreeRock.blp",
  ]) assert.equal(sourceWind.isBotanicalTexturePath(path), false, path);
  for (const path of [
    "Spells\\BlessingOfFreedom.blp",
    "World\\Creatures\\InfernalSkin.blp",
    "Dungeons\\Textures\\MM_STREET_03.blp",
    "World\\Props\\Barbershop_ShaveBrush.blp",
    "World\\Props\\Leather_Blood_C_01Guard.blp",
    "World\\Plants\\StormwindPlanter.blp",
  ]) assert.equal(sourceWind.isBotanicalTexturePath(path), false, `embedded English word: ${path}`);
});

test("source wind varies by plant family and by instance origin", () => {
  assert.ok(sourceWind.VEGETATION_WIND_CULL_PADDING
    >= Math.hypot(sourceWind.VEGETATION_WIND_MAX_AMPLITUDE,
      sourceWind.VEGETATION_WIND_MAX_AMPLITUDE * 0.5),
  "frustum padding covers simultaneous sway on both local horizontal axes");
  const bounds = { min: [0, 0, 0], max: [1, 1, 2], radius: 2 };
  const grass = sourceWind.vegetationWindProfile(bounds, "World\\Plants\\Grass01.m2");
  const tree = sourceWind.vegetationWindProfile(bounds, "World\\Trees\\OakTree01.m2");
  assert.ok(grass && tree);
  assert.notEqual(grass.frequency, tree.frequency, "plant families do not all sway at one speed");
  assert.notEqual(grass.phase, tree.phase, "model identities do not all start at phase zero");

  const material = new THREE.MeshBasicMaterial();
  sourceWind.installVegetationWind(material, grass);
  const value = shader();
  material.onBeforeCompile(value, undefined);
  assert.match(value.vertexShader, /vegetationWindWorldOrigin/);
  assert.match(value.vertexShader, /instanceMatrix/);
  assert.match(value.vertexShader, /dot\( vegetationWindWorldOrigin\.xz/);
});

test("the model build passes authored model identity into both wind decisions", async () => {
  const source = await readFile(new URL("../src/browser/ModelBuild.ts", import.meta.url), "utf8");
  assert.match(source, /vegetationWindProfile\(model\.bounds, options\.modelPath\)/);
  assert.match(source, /isVegetationWindBatch\(model, batchIndex, path, options\.modelPath\)/);
});

test("a botanical model path admits a safe generic foliage texture but never bark", () => {
  const foliage = model([batch()]);
  assert.equal(sourceWind.isVegetationWindBatch(
    foliage, 0, "World\\Generic\\Green01.blp", "World\\Plants\\ForestBush01.m2",
  ), true);
  assert.equal(sourceWind.isVegetationWindBatch(
    foliage, 0, "World\\Trees\\OakBark.blp", "World\\Trees\\OakTree01.m2",
  ), false);
  for (const modelPath of [
    "WORLD\\EXPANSION02\\DOODADS\\GENERIC\\BARBERSHOP\\BARBERSHOP_SHAVEBRUSH.m2",
    "WORLD\\GENERIC\\TAUREN\\PASSIVE DOODADS\\BALLANDHOOP\\TAURENLEATHERBALL.m2",
    "WORLD\\AZEROTH\\SWAMPOSORROW\\PASSIVEDOODADS\\TREEHUTS\\LOSTTREEHUTS03.M2",
    "WORLD\\EXPANSION02\\DOODADS\\DALARAN\\DALARAN_FLOWER_STAND.m2",
  ]) {
    assert.equal(sourceWind.isVegetationWindBatch(
      foliage, 0, "World\\Generic\\AlphaCard01.blp", modelPath,
    ), false, `rigid alpha-card model: ${modelPath}`);
  }
  assert.equal(sourceWind.isVegetationWindBatch(
    foliage, 0, "World\\LochModan\\LochModanShrub02a.blp",
    "WORLD\\GENERIC\\HUMAN\\PASSIVE DOODADS\\ANIMALHEADS\\STUFFEDBEAR.m2",
  ), false, "a taxidermy mount does not sway because it borrowed a shrub texture");
  assert.equal(sourceWind.isVegetationWindBatch(
    foliage, 0, "WORLD\\SKILLACTIVATED\\TRADESKILLNODES\\STRANGLEKELP_01.BLP",
    "WORLD\\GENERIC\\HUMAN\\PASSIVE DOODADS\\SACKS\\SACKHERBSSTRANGLEKELP01.m2",
  ), false, "a rigid herb sack does not inherit wind from the herb texture");
});

test("the real one-sided Duskwood canopy reaches the wind gate", () => {
  const bytes = readFileSync(new URL(
    "../data/visual-models/00a9c36199b2ff1efee57ea520f0bfc2eb6ca4f9.bin",
    import.meta.url,
  ));
  const modelData = decodeWvm9(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const modelPath = "WORLD\\AZEROTH\\DUSKWOOD\\PASSIVEDOODADS\\TREES\\DUSKWOODTREE06.M2";
  const texturePath = "WORLD\\AZEROTH\\DUSKWOOD\\PASSIVEDOODADS\\TREES\\DUSKWOODTREECANOPY11.BLP";
  const canopy = modelData.batches.findIndex((entry) =>
    modelData.textures[entry.textures[0]]?.path === texturePath);
  assert.notEqual(canopy, -1);
  assert.equal(modelData.batches[canopy].blendMode, BLEND_ALPHA_KEY);
  assert.equal(modelData.batches[canopy].materialFlags & MATERIAL_TWO_SIDED, 0,
    "this authored foliage is exactly the one-sided family the old gate dropped");
  assert.equal(sourceWind.isVegetationWindBatch(modelData, canopy, texturePath, modelPath), true);
});

test("batch gate is alpha-key and depth-safe, including unlit and one-sided foliage", () => {
  const accepted = model([batch()]);
  assert.equal(sourceWind.isVegetationWindBatch(accepted, 0, "World\\Grass\\Leaf.blp"), true);
  assert.equal(sourceWind.isVegetationWindBatch(
    model([batch({ materialFlags: MATERIAL_UNLIT | MATERIAL_TWO_SIDED })]),
    0,
    "World\\Grass\\Leaf.blp",
  ), true, "unlit is a lighting choice, not a rigid-geometry marker");
  for (const materialFlags of [
    MATERIAL_NO_DEPTH_TEST,
    MATERIAL_NO_DEPTH_WRITE,
  ]) {
    assert.equal(sourceWind.isVegetationWindBatch(
      model([batch({ materialFlags: materialFlags | MATERIAL_TWO_SIDED })]),
      0,
      "World\\Grass\\Leaf.blp",
    ), false, `flags ${materialFlags} are rejected`);
  }
  assert.equal(sourceWind.isVegetationWindBatch(
    model([batch({ blendMode: 0 })]), 0, "World\\Grass\\Leaf.blp",
  ), false);
  assert.equal(sourceWind.isVegetationWindBatch(
    model([batch({ materialFlags: 0 })]), 0, "World\\Grass\\Leaf.blp",
  ), true, "one-sided alpha-card leaves receive wind too");
});

test("duplicate or mixed batches sharing one submesh fail closed", () => {
  const mixed = model([
    batch(),
    batch({ blendMode: 0, materialFlags: MATERIAL_TWO_SIDED }),
  ], [{ geosetId: 0, indexStart: 0, indexCount: 3 }]);
  assert.equal(isVegetationWindBatch(mixed, 0, "World\\Grass\\Leaf.blp"), false);
  assert.equal(isVegetationWindBatch(mixed, 1, "World\\Grass\\Leaf.blp"), false);

  const separate = model([
    batch(),
    batch({ submesh: 1, blendMode: 0 }),
  ], [
    { geosetId: 0, indexStart: 0, indexCount: 3 },
    { geosetId: 0, indexStart: 3, indexCount: 3 },
  ]);
  assert.equal(isVegetationWindBatch(separate, 0, "World\\Grass\\Leaf.blp"), true);
  assert.equal(isVegetationWindBatch(separate, 1, "World\\Grass\\Bark.blp"), false);
});

test("profile key is finite and stable", () => {
  assert.match(vegetationWindProfileKey(PROFILE), /^vegetation-wind-v2:/);
  assert.equal(vegetationWindProfileKey({ ...PROFILE, amplitude: Number.NaN }), undefined);
  assert.equal(vegetationWindProfileKey({ ...PROFILE, height: 0 }), undefined);
});

test("wind OFF is a strict no-op", () => {
  const material = new THREE.MeshBasicMaterial();
  const beforeCompile = material.onBeforeCompile;
  const beforeKey = material.customProgramCacheKey;
  const beforeJson = JSON.stringify(material.toJSON());
  installVegetationWind(material, undefined);
  assert.equal(material.onBeforeCompile, beforeCompile);
  assert.equal(material.customProgramCacheKey, beforeKey);
  assert.equal(JSON.stringify(material.toJSON()), beforeJson);
});

test("enabled wind chains the old hook, adds one shared uniform and patches vertex sway", () => {
  const material = new THREE.MeshStandardMaterial();
  const calls = [];
  material.onBeforeCompile = (value) => {
    calls.push("previous");
    value.fragmentShader += "\n// previous-hook";
  };
  material.customProgramCacheKey = () => "base-material";

  installVegetationWind(material, PROFILE);
  const value = shader();
  material.onBeforeCompile(value, undefined);

  assert.deepEqual(calls, ["previous"]);
  assert.equal(value.uniforms[VEGETATION_WIND_TIME_UNIFORM], VEGETATION_WIND_TIME);
  assert.match(value.vertexShader, new RegExp(VEGETATION_WIND_MARKER));
  assert.match(value.vertexShader, /position\.z/);
  assert.match(value.vertexShader, /modelMatrix/);
  assert.match(value.vertexShader, /instanceMatrix/);
  assert.match(value.vertexShader, /vegetationWindBend/);
  assert.match(value.vertexShader, /transformed\.x \+=/);
  assert.match(value.vertexShader, /transformed\.y \+=/);
  assert.doesNotMatch(value.vertexShader, /transformed\.z \+=/);
  assert.equal(value.vertexShader.includes("#include <begin_vertex>"), true);
  assert.equal(value.fragmentShader.includes("previous-hook"), true);
  // P1-08: the key carries the shader version, not the profile's numbers.
  assert.equal(material.customProgramCacheKey(), `base-material|${VEGETATION_WIND_MARKER}`);
  assert.equal(material.customProgramCacheKey().includes(vegetationWindProfileKey(PROFILE)), false);
});

test("enabled wind material keeps the renderer clock live after shader compilation", () => {
  const material = new THREE.MeshStandardMaterial();
  installVegetationWind(material, PROFILE);
  const compiled = shader();
  material.onBeforeCompile(compiled, undefined);

  assert.equal(compiled.uniforms[VEGETATION_WIND_TIME_UNIFORM], VEGETATION_WIND_TIME);
  const previousTime = VEGETATION_WIND_TIME.value;
  try {
    VEGETATION_WIND_TIME.value = 37.5;
    assert.equal(compiled.uniforms[VEGETATION_WIND_TIME_UNIFORM].value, 37.5);
    assert.match(compiled.vertexShader, /uVegetationWindTime/);
  } finally {
    VEGETATION_WIND_TIME.value = previousTime;
    material.dispose();
  }
});

/** The eight numbers the v1 shader printed as literals, in the uniforms' (A, B) order. */
function v1Literals(profile) {
  const inverseHeight = 1 / profile.height;
  const fieldAmplitude = windFieldAmplitude(profile);
  return [
    profile.amplitude, profile.frequency, profile.phase, profile.baseZ,
    inverseHeight, fieldAmplitude, profile.frequency * 0.73, profile.frequency * 4.7,
  ].map((value) => numberText(value));
}

function windUniforms(compiled) {
  const a = compiled.uniforms[VEGETATION_WIND_A_UNIFORM];
  const b = compiled.uniforms[VEGETATION_WIND_B_UNIFORM];
  assert.ok(a?.value instanceof THREE.Vector4, "uVegetationWindA is a Vector4 uniform");
  assert.ok(b?.value instanceof THREE.Vector4, "uVegetationWindB is a Vector4 uniform");
  return [...a.value.toArray(), ...b.value.toArray()];
}

test("P1-08: the profile reaches the shader as two vec4 uniforms and no number of it is in the text", () => {
  const profile = { amplitude: 0.0731, frequency: 1.83, phase: 4.125, baseZ: -0.75, height: 3.5 };
  const material = new THREE.MeshBasicMaterial();
  installVegetationWind(material, profile);
  const compiled = shader();
  material.onBeforeCompile(compiled, undefined);
  assert.match(compiled.vertexShader, /uniform vec4 uVegetationWindA;/);
  assert.match(compiled.vertexShader, /uniform vec4 uVegetationWindB;/);
  assert.deepEqual(windUniforms(compiled), v1Literals(profile).map(Number));
  const body = compiled.vertexShader.slice(compiled.vertexShader.indexOf(`// ${VEGETATION_WIND_MARKER}`));
  for (const text of v1Literals(profile)) {
    assert.equal(new RegExp(`(?<![\\w.])${text.replace(/[.-]/g, "\\$&")}(?![\\d])`).test(body), false,
      `profile number ${text} is not printed into the shader`);
  }
  assert.match(compiled.vertexShader, /mix\( uVegetationWindA\.x \* vegetationWindWave,/);
  assert.match(compiled.vertexShader, /position\.z - uVegetationWindA\.w \) \* uVegetationWindB\.x/);
});

test("P1-08: two profiles share one program key and one vertex text but keep their own values", () => {
  const first = new THREE.MeshLambertMaterial();
  const second = new THREE.MeshLambertMaterial();
  installVegetationWind(first, PROFILE);
  installVegetationWind(second, { amplitude: 0.2, frequency: 0.9, phase: 2, baseZ: 1.5, height: 9 });
  assert.equal(first.customProgramCacheKey(), second.customProgramCacheKey());
  const a = shader();
  const b = shader();
  first.onBeforeCompile(a, undefined);
  second.onBeforeCompile(b, undefined);
  assert.equal(a.vertexShader, b.vertexShader, "a shared program must get one text from either material");
  assert.equal(a.fragmentShader, b.fragmentShader);
  assert.notDeepEqual(windUniforms(a), windUniforms(b));
  assert.notStrictEqual(a.uniforms[VEGETATION_WIND_A_UNIFORM], b.uniforms[VEGETATION_WIND_A_UNIFORM]);
  assert.strictEqual(a.uniforms[VEGETATION_WIND_TIME_UNIFORM], b.uniforms[VEGETATION_WIND_TIME_UNIFORM],
    "the clock stays one shared object");
});

test("P1-08: every uniform holds the float32 of the v1 literal over a corpus of real-shaped profiles", () => {
  let seed = 0x2f6b1d3;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const families = ["Plants\\Grass", "Trees\\OakTree", "Bush\\Shrub", "Plants\\Reed", "Detail\\ElwGra", ""];
  let checked = 0;
  for (let index = 0; index < 400; index++) {
    const baseZ = (random() - 0.5) * 12;
    const height = 0.01 + random() * random() * 60;
    const family = families[index % families.length];
    const path = family ? `World\\${family}${index}.m2` : "";
    const profile = sourceWind.vegetationWindProfile({ min: [0, 0, baseZ], max: [1, 1, baseZ + height], radius: 1 }, path);
    if (!profile) continue;
    const material = new THREE.MeshBasicMaterial();
    installVegetationWind(material, profile);
    const compiled = shader();
    material.onBeforeCompile(compiled, undefined);
    const uploaded = Float32Array.from(windUniforms(compiled));
    const literal = v1Literals(profile).map((text) => Math.fround(Number(text)));
    for (let lane = 0; lane < 8; lane++) {
      assert.ok(Object.is(uploaded[lane], literal[lane]),
        `${path || "(no path)"} lane ${lane}: ${uploaded[lane]} vs literal ${literal[lane]}`);
    }
    checked++;
  }
  assert.ok(checked > 350, `corpus covers the profiles (${checked})`);
});

test("P1-08: a zero profile value is +0 in the uniform, as the v1 literal 0.0 was", () => {
  const material = new THREE.MeshBasicMaterial();
  installVegetationWind(material, { ...PROFILE, phase: -0, baseZ: -1e-12 });
  const compiled = shader();
  material.onBeforeCompile(compiled, undefined);
  const values = windUniforms(compiled);
  assert.ok(Object.is(values[2], 0), "phase");
  assert.ok(Object.is(values[3], 0), "baseZ");
});

test("P1-08: a placement-tint copy carries the same wind uniforms and the same program key suffix", () => {
  const source = new THREE.MeshBasicMaterial();
  installVegetationWind(source, PROFILE);
  const [copy] = createModelPlacementTintMaterials([source], [128, 200, 64]);
  assert.ok(copy);
  const original = shader();
  const tinted = shader();
  source.onBeforeCompile(original, undefined);
  copy.onBeforeCompile(tinted, undefined);
  assert.strictEqual(tinted.uniforms[VEGETATION_WIND_A_UNIFORM], original.uniforms[VEGETATION_WIND_A_UNIFORM]);
  assert.strictEqual(tinted.uniforms[VEGETATION_WIND_B_UNIFORM], original.uniforms[VEGETATION_WIND_B_UNIFORM]);
  assert.deepEqual(windUniforms(tinted), v1Literals(PROFILE).map(Number));
  assert.equal(tinted.vertexShader, original.vertexShader);
  assert.ok(copy.customProgramCacheKey().startsWith(`${source.customProgramCacheKey()}|`));
});

test("same material/profile is not wrapped twice, conflicting profile is rejected", () => {
  const material = new THREE.MeshBasicMaterial();
  installVegetationWind(material, PROFILE);
  const firstHook = material.onBeforeCompile;
  installVegetationWind(material, PROFILE);
  assert.equal(material.onBeforeCompile, firstHook);
  assert.throws(() => installVegetationWind(material, { ...PROFILE, phase: 1 }), /already installed/);
});

test("buildModel winds only an eligible foliage material and keeps OFF/trunk source exact", () => {
  const build = (path, vegetationWind) => buildModel({
    positions: Float32Array.from([0, 0, 0, 1, 0, 2, 0, 1, 2]),
    normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    uv0: Float32Array.from([0, 0, 1, 0, 0, 1]),
    uv1: new Float32Array(6),
    indices: Uint16Array.from([0, 1, 2]),
    submeshes: [{ geosetId: 0, indexStart: 0, indexCount: 3 }],
    batches: [batch()],
    textures: [{ type: 0, flags: 0, path }],
    attachments: [],
    bounds: { min: [0, 0, 0], max: [1, 1, 2], radius: 2 },
    globalSequences: new Uint32Array(0),
    particleEmitters: [], ribbonEmitters: [], colours: [], textureWeights: [], textureTransforms: [],
  }, {
    modelPath: "World\\Trees\\Oak.m2", baseUrl: "http://gateway",
    loadTexture: () => new THREE.Texture(), geosets: EVERY_GEOSET, vegetationWind,
  });

  const off = build("World\\Trees\\OakLeaves.blp", false).materials[0];
  const leaves = build("World\\Trees\\OakLeaves.blp", true).materials[0];
  const trunk = build("World\\Trees\\OakBark.blp", true).materials[0];
  assert.doesNotMatch(off.customProgramCacheKey(), /vegetation-wind/);
  assert.match(leaves.customProgramCacheKey(), /vegetation-wind-v2/);
  assert.doesNotMatch(trunk.customProgramCacheKey(), /vegetation-wind/);
  const leavesShader = shader();
  leaves.onBeforeCompile(leavesShader, undefined);
  assert.match(leavesShader.vertexShader, /vegetation-wind-v2/);
  const offShader = shader();
  off.onBeforeCompile(offShader, undefined);
  assert.doesNotMatch(offShader.vertexShader, /vegetation-wind-v2/);
  assert.deepEqual(sourceWind.vegetationWindProfile({ min: [0, 0, 0], max: [1, 1, 2], radius: 2 }), {
    amplitude: 0.05, frequency: 1.25, phase: 0, baseZ: 0, height: 2,
  });
});

test("the real Elwynn tree canopy WVM activates one wind material", () => {
  const bytes = readFileSync(new URL(
    "../data/visual-models/ddac16a144dcfef4bcdb3ca42e84c795df276b29.bin",
    import.meta.url,
  ));
  const modelData = decodeWvm9(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const canopyIndex = modelData.batches.findIndex((entry) => {
    const texture = modelData.textures[entry.textures[0]]?.path ?? "";
    return entry.blendMode === BLEND_ALPHA_KEY && (entry.materialFlags & MATERIAL_TWO_SIDED) !== 0
      && /canopy/i.test(texture);
  });
  assert.notEqual(canopyIndex, -1, "fixture must contain the real alpha/two-sided canopy batch");
  const canopyPath = modelData.textures[modelData.batches[canopyIndex].textures[0]].path;
  assert.equal(isBotanicalTexturePath(canopyPath), true);
  assert.equal(isVegetationWindBatch(modelData, canopyIndex, canopyPath), true);

  const built = buildModel(modelData, {
    modelPath: "World\\Azeroth\\Elwynn\\PassiveDoodads\\Trees\\ElwynnTreeMid01.m2",
    baseUrl: "http://gateway",
    geosets: EVERY_GEOSET,
    loadTexture: () => new THREE.Texture(),
    vegetationWind: true,
  });
  try {
    const windMaterials = built.materials.filter((material) => /vegetation-wind-v2/.test(material.customProgramCacheKey()));
    assert.equal(windMaterials.length, 1, "the canopy batch must receive the wind shader variant");
    assertLiveWindMaterial(windMaterials[0]);
  } finally {
    for (const material of built.materials) material.dispose();
    for (const texture of built.ownedTextures) texture.dispose();
    built.geometry.dispose();
  }
});

test("the real Elwynn ground-clutter WVM activates its shared grass atlas", () => {
  const modelPath = "World\\NoDXT\\Detail\\ElwGra07.m2";
  const atlasPath = "World\\NoDXT\\Detail\\NewElynnGrassFlowerRock128.blp";
  const bytes = readFileSync(new URL(
    "../data/visual-models/0bf277b3c3f7b60382b36a28967a54d932b98d09.bin",
    import.meta.url,
  ));
  const modelData = decodeWvm9(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  assert.equal(modelData.batches.length, 1, "fixture is one alpha ground-clutter card");
  assert.equal(modelData.textures[modelData.batches[0].textures[0]].path, atlasPath);
  // The atlas name contains a rock tile too.  Texture-only classification must remain fail-closed;
  // only the exact known ground-clutter model identity may supply the missing semantic.
  assert.equal(isBotanicalTexturePath(atlasPath), false);
  assert.equal(isVegetationWindBatch(modelData, 0, atlasPath), false);
  assert.equal(isVegetationWindBatch(modelData, 0, atlasPath, modelPath), true);

  const built = buildModel(modelData, {
    modelPath,
    baseUrl: "http://gateway",
    geosets: EVERY_GEOSET,
    loadTexture: () => new THREE.Texture(),
    vegetationWind: true,
  });
  try {
    const windMaterials = built.materials.filter((material) => /vegetation-wind-v2/.test(material.customProgramCacheKey()));
    assert.equal(windMaterials.length, 1, "the ground-clutter card must receive the wind shader variant");
    assertLiveWindMaterial(windMaterials[0]);
  } finally {
    for (const material of built.materials) material.dispose();
    for (const texture of built.ownedTextures) texture.dispose();
    built.geometry.dispose();
  }
});
