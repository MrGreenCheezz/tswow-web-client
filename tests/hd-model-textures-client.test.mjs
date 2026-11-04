// 24.10 (7.48 step 3): «Чёткие текстуры мира» for the scenery models — which `/texture` URLs carry `hd=` (only scenery
// paths, only with the setting, BC7 support and a published generation), how a model build asks for them, and how a
// compressed answer on `/texture` becomes a BC7 texture while an effect's `hd=` answer stays a bitmap. Off — the
// default and the faithful/comparison profile — every URL is byte-identical to before.
import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import { compressTexture } from "../tools/hd-texture-bc7.mjs";
import { noteGatewayAssetGenerations, resetGatewayGeneration } from "../dist/code/browser/GatewayGeneration.js";
import {
  isHdModelTexturePath, isHdModelTextureUrl, setHdWorldTexturesEnabled, withHdModelTexture,
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
  const bodies = { [tree]: container, [effect]: container, [plain]: "PLAIN" };
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
    await settle();
    assert.equal(hd.isCompressedTexture, true);
    assert.equal(hd.format, THREE.RGBA_BPTC_Format);
    assert.deepEqual([hd.image.width, hd.image.height], [16, 16]);
    assert.equal(fx.isCompressedTexture, false, "an effect's hd= answer is the effects set's PNG: never read as a container");
    assert.equal(original.isCompressedTexture, false);
    assert.deepEqual(decoded.sort((a, b) => a - b), [5, container.length], "the effect and the plain URL went through the decoder");
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[name];
      else globalThis[name] = value;
    }
  }
});
