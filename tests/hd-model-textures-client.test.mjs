// 24.10 (7.48 step 3): «Чёткие текстуры мира» for the scenery models — which `/texture` URLs carry `hd=` (only scenery
// paths, only with the setting, BC7 support and a published generation), how a model build asks for them, and how a
// compressed answer on `/texture` becomes a BC7 texture while an effect's `hd=` answer stays a bitmap. Off — the
// default and the faithful/comparison profile — every URL is byte-identical to before.
import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import { compressTexture } from "../tools/hd-texture-bc7.mjs";
import { UNIT_TEXTURE_PREFIXES } from "../tools/hd-texture-set.mjs";
import { noteGatewayAssetGenerations, resetGatewayGeneration } from "../dist/code/browser/GatewayGeneration.js";
import {
  HD_UNIT_TEXTURE_PREFIXES, isHdModelTexturePath, isHdModelTextureUrl, isHdUnitTexturePath, setHdUnitTexturesEnabled,
  setHdWorldTexturesEnabled, withHdModelTexture,
} from "../dist/code/browser/HdWorldTextures.js";
import { setHdEffectTexturesEnabled } from "../dist/code/browser/HdEffectTextures.js";
import { ModelTextureLoader } from "../dist/code/browser/TextureLoad.js";
import { EVERY_GEOSET, buildModel } from "../dist/code/browser/ModelBuild.js";
import { textureUrl } from "../dist/code/browser/Wvm.js";

const BASE = "http://gateway.test:8090";
const HG = "cccccccccccccccccccc";
const TREE = "World\\Azeroth\\Elwynn\\Passivedoodads\\Trees\\ElwynnTree01Leaves.blp";

function withGeneration(run) {
  resetGatewayGeneration();
  noteGatewayAssetGenerations(BASE, undefined, undefined, HG);
  try {
    return run();
  } finally {
    setHdWorldTexturesEnabled(false, false);
    setHdEffectTexturesEnabled(false);
    resetGatewayGeneration();
  }
}

test("only a scenery /texture URL gains hd=, only with the setting, BC7 and a generation", () => withGeneration(() => {
  const tree = textureUrl(BASE, TREE);
  setHdWorldTexturesEnabled(false, true);
  assert.equal(withHdModelTexture(tree), tree, "the setting off: byte-identical");
  setHdWorldTexturesEnabled(true, false);
  assert.equal(withHdModelTexture(tree), tree, "no EXT_texture_compression_bptc");
  setHdWorldTexturesEnabled(true, true);
  assert.equal(withHdModelTexture(tree), `${tree}&hd=${HG}`);
  assert.equal(isHdModelTextureUrl(tree), true);
  for (const path of ["Creature\\Wolf\\Wolf.blp", "Character\\Human\\Male\\HumanMaleSkin00_00.blp", "Item\\ObjectComponents\\X.blp",
    "Spells\\Glow.blp", "Interface\\Icons\\X.blp", "Tileset\\Elwynn\\ElwynnGrassBase.blp", "World\\Minimaps\\Azeroth\\map32_48.blp"]) {
    const url = textureUrl(BASE, path);
    assert.equal(withHdModelTexture(url), url, path);
  }
  for (const url of [`${BASE}/visual/texture/${"c".repeat(40)}-2.png`, `${BASE}/terrain-layer/${"a".repeat(40)}.png`,
    `${BASE}/visual/model?path=${encodeURIComponent(TREE)}`, `http://other:1/texture?path=${encodeURIComponent(TREE)}`]) {
    assert.equal(withHdModelTexture(url), url, url);
  }
  assert.equal(isHdModelTexturePath("environments\\stars\\clouds.blp"), true);
  assert.equal(isHdModelTexturePath("dungeons\\textures\\wall.blp"), true);
  noteGatewayAssetGenerations(BASE, undefined, undefined, undefined);
  assert.equal(withHdModelTexture(tree), tree, "the gateway stopped publishing a generation");
}));

test("04.11 (7.62): creature and item-model art asks under its own switch, a character's and a body piece's never", () => withGeneration(() => {
  try {
    assert.deepEqual([...HD_UNIT_TEXTURE_PREFIXES], UNIT_TEXTURE_PREFIXES, "the tool's folders");
    const wolf = textureUrl(BASE, "Creature\\Wolf\\WolfSkinTimber.blp");
    const sword = textureUrl(BASE, "Item\\ObjectComponents\\Weapon\\Sword_1H_Long_A_01.blp");
    const tree = textureUrl(BASE, TREE);
    assert.equal(withHdModelTexture(wolf), wolf, "off: byte-identical");
    setHdUnitTexturesEnabled(true, false);
    assert.equal(withHdModelTexture(wolf), wolf, "no EXT_texture_compression_bptc");
    setHdUnitTexturesEnabled(true, true);
    assert.equal(withHdModelTexture(wolf), `${wolf}&hd=${HG}`);
    assert.equal(withHdModelTexture(sword), `${sword}&hd=${HG}`);
    assert.equal(withHdModelTexture(tree), tree, "the scenery keeps its own switch");
    for (const path of ["Character\\Human\\Male\\HumanMaleSkin00_00.blp", "Item\\TextureComponents\\ArmUpperTexture\\Robe.blp", "Spells\\Glow.blp"]) {
      const url = textureUrl(BASE, path);
      assert.equal(withHdModelTexture(url), url, path);
    }
    assert.equal(isHdUnitTexturePath("creature/wolf/wolf.blp"), true);
    assert.equal(isHdUnitTexturePath("item\\texturecomponents\\x.blp"), false);
    setHdUnitTexturesEnabled(false, false);
    setHdWorldTexturesEnabled(true, true);
    assert.equal(withHdModelTexture(wolf), wolf, "and the scenery's switch does not turn this one on");
    assert.equal(withHdModelTexture(tree), `${tree}&hd=${HG}`);
  } finally {
    setHdUnitTexturesEnabled(false, false);
  }
}));

const MODEL = (paths) => ({
  positions: Float32Array.from([0, 0, 0, 1, 0, 2, 0, 1, 2]),
  normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  uv0: Float32Array.from([0, 0, 1, 0, 0, 1]),
  uv1: new Float32Array(6),
  indices: Uint16Array.from([0, 1, 2]),
  submeshes: paths.map(() => ({ geosetId: 0, indexStart: 0, indexCount: 3 })),
  batches: paths.map((_, index) => ({
    submesh: index, blendMode: 0, materialFlags: 0, priorityPlane: 0, materialLayer: 0, textures: [index], uvSets: [0],
    shaderId: 0, colorIndex: 0xffff, textureWeight: -1, textureTransform: -1,
  })),
  textures: paths.map((path) => ({ type: 0, flags: 0, path })),
  attachments: [],
  bounds: { min: [0, 0, 0], max: [1, 1, 2], radius: 2 },
  globalSequences: new Uint32Array(0),
  particleEmitters: [], ribbonEmitters: [], colours: [], textureWeights: [], textureTransforms: [],
});

function builtUrls(paths) {
  const asked = [];
  buildModel(MODEL(paths), {
    modelPath: "World\\Azeroth\\Elwynn\\Tree.m2", baseUrl: BASE, geosets: EVERY_GEOSET,
    loadTexture: (url) => {
      asked.push(url);
      return new THREE.Texture();
    },
  });
  return asked;
}

test("a model build asks for a scenery texture with hd= while active; a creature's never; off, exactly the URLs of before", () => withGeneration(() => {
  const paths = [TREE, "Creature\\Wolf\\Wolf.blp"];
  const before = paths.map((path) => textureUrl(BASE, path));
  setHdWorldTexturesEnabled(false, true);
  assert.deepEqual(builtUrls(paths), before, "the faithful/comparison profile and the default: byte-identical");
  setHdWorldTexturesEnabled(true, true);
  assert.deepEqual(builtUrls(paths), [`${before[0]}&hd=${HG}`, before[1]]);
}));

class FakeImageBitmap {
  constructor(width, height) { this.width = width; this.height = height; }
  close() {}
}

const settle = async (turns = 10) => {
  for (let turn = 0; turn < turns; turn++) await new Promise((resolve) => setImmediate(resolve));
};

test("a scenery /texture answer that is a container is a BC7 texture; an effect's hd= answer always goes to the decoder", async () => {
  const container = compressTexture({ width: 16, height: 16, data: new Uint8Array(16 * 16 * 4).fill(200) }).bytes;
  const tree = `${textureUrl(BASE, TREE)}&hd=${HG}`;
  const effect = `${textureUrl(BASE, "Spells\\Glow.blp")}&hd=${HG}`;
  const plain = textureUrl(BASE, TREE);
  // 04.11 (7.62): a creature's and an item model's, and a creature's the set does not hold (the original answered to hd=).
  const skin = `${textureUrl(BASE, "Creature\\Wolf\\WolfSkinTimber.blp")}&hd=${HG}`;
  const sword = `${textureUrl(BASE, "Item\\ObjectComponents\\Weapon\\Sword.blp")}&hd=${HG}`;
  const bigSkin = `${textureUrl(BASE, "Creature\\Wolf\\WolfSkinLarge.blp")}&hd=${HG}`;
  const bodies = { [tree]: container, [effect]: container, [plain]: "PLAIN", [skin]: container, [sword]: container, [bigSkin]: "PLAIN" };
  const saved = { fetch: globalThis.fetch, createImageBitmap: globalThis.createImageBitmap, ImageBitmap: globalThis.ImageBitmap };
  const decoded = [];
  globalThis.ImageBitmap = FakeImageBitmap;
  globalThis.fetch = async (url) => {
    const body = bodies[String(url)];
    return body === undefined ? new Response(null, { status: 404 }) : new Response(body, { status: 200 });
  };
  globalThis.createImageBitmap = async (blob) => {
    decoded.push((await blob.arrayBuffer()).byteLength);
    return new FakeImageBitmap(4, 4);
  };
  try {
    const loader = new ModelTextureLoader();
    const hd = loader.load(tree);
    const fx = loader.load(effect);
    const original = loader.load(plain);
    const skinned = loader.load(skin);
    const sharp = loader.load(sword);
    const unheld = loader.load(bigSkin);
    await settle();
    assert.equal(skinned.isCompressedTexture, true, "a creature's container is a BC7 texture, never handed to the image decoder");
    assert.equal(sharp.isCompressedTexture, true, "and an item model's");
    assert.equal(unheld.isCompressedTexture, false, "the original PNG answered to hd= is decoded as before");
    assert.equal(hd.isCompressedTexture, true);
    assert.equal(hd.format, THREE.RGBA_BPTC_Format);
    assert.deepEqual([hd.image.width, hd.image.height], [16, 16]);
    assert.equal(fx.isCompressedTexture, false, "an effect's hd= answer is the effects set's PNG: never read as a container");
    assert.equal(original.isCompressedTexture, false);
    assert.deepEqual(decoded.sort((a, b) => a - b), [5, 5, container.length], "the effect, the plain URL and the unheld skin went through the decoder");
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[name];
      else globalThis[name] = value;
    }
  }
});
