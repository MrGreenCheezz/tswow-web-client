// 23.10 (7.48 step 2): what the `world` set takes (tools/hd-texture-set.mjs) — the ground textures without their `_s`
// masks and every root WMO's diffuse textures (MOMT texture 1), never character art or effect folders — and the tool's
// compressed-entry bookkeeping (tools/upscale-textures.mjs).
// 24.10 (7.48 step 3): plus the scenery models' own textures (world\, dungeons\, environments\ models; never a
// creature, character, item, effect, interface or minimap texture, even when a doodad borrows one), the WMO second
// textures an env/composite material draws, and ×2 up to 512 a side (but the ground, still 256).
import assert from "node:assert/strict";
import test from "node:test";
import {
  MODEL_TEXTURE_PREFIXES, modelTexturePath, wmoDiffuseTextures, wmoSecondTextures, worldSet,
} from "../tools/hd-texture-set.mjs";
import {
  compressedFile, compressPipeline, pipelineFor, COMPRESS_PIPELINE, DILATED_PIPELINE, MODEL, PIPELINE, SCALE_POLICY, SET_MODEL,
} from "../tools/upscale-textures.mjs";
import { assemble, buildWorkImages, dilateUnderAlpha, planLayout } from "../tools/hd-texture-image.mjs";
import { HD_MODEL_TEXTURE_PREFIXES, isHdModelTexturePath } from "../dist/code/browser/HdWorldTextures.js";

function chunk(tag, body) {
  const head = Buffer.alloc(8);
  head.write([...tag].reverse().join(""), 0, "latin1");
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

/** A root WMO with MOTX names and MOMT records pointing their texture 1 (and 2) at them, with their shaders. */
function rootWmo(names, texture1Offsets, texture2Offsets = [], shaders = []) {
  const motx = Buffer.from(`${names.join("\0")}\0`, "latin1");
  const momt = Buffer.alloc(texture1Offsets.length * 0x40);
  texture1Offsets.forEach((offset, index) => {
    momt.writeUInt32LE(shaders[index] ?? 0, index * 0x40 + 0x04);
    momt.writeUInt32LE(offset, index * 0x40 + 0x0c);
    momt.writeUInt32LE(texture2Offsets[index] ?? 0, index * 0x40 + 0x18);
  });
  return Buffer.concat([chunk("MVER", Buffer.alloc(4)), chunk("MOHD", Buffer.alloc(64)), chunk("MOTX", motx), chunk("MOMT", momt)]);
}

const offsetsOf = (names) => names.map((_, index) => names.slice(0, index).reduce((sum, name) => sum + name.length + 1, 0));

/** A minimal MD20 naming `names` as own textures (type 0; flags 3 = wrap on the first), plus one type-11 slot. */
function doodadModel(names) {
  const model = Buffer.alloc(0x800);
  model.write("MD20", 0, "latin1");
  model.writeUInt32LE(264, 4);
  model.writeUInt32LE(names.length + 1, 0x50);
  model.writeUInt32LE(0x200, 0x54);
  names.forEach((name, index) => {
    const at = 0x200 + index * 16;
    model.writeUInt32LE(0, at);
    model.writeUInt32LE(index === 0 ? 3 : 0, at + 4);
    model.writeUInt32LE(name.length + 1, at + 8);
    model.writeUInt32LE(0x400 + index * 0x60, at + 12);
    model.write(name, 0x400 + index * 0x60, "latin1");
  });
  model.writeUInt32LE(11, 0x200 + names.length * 16); // a creature skin slot, filled at run time: never a path
  return model;
}

test("a root WMO's diffuse textures: MOMT texture 1 into MOTX, backslashed and lowercased, deduplicated", () => {
  const names = ["Dungeons\\Textures\\Stormwind\\Wall.BLP", "Dungeons/Textures/Env/Metal.blp", "notatexture.txt"];
  const second = names[0].length + 1;
  const third = second + names[1].length + 1;
  const wmo = rootWmo(names, [0, 0, third, 9999], [second, second]);
  assert.deepEqual(wmoDiffuseTextures(wmo), ["dungeons\\textures\\stormwind\\wall.blp"], "texture 2 (env maps) is not the diffuse");
  assert.deepEqual(wmoDiffuseTextures(Buffer.alloc(3)), []);
  assert.deepEqual(wmoDiffuseTextures(chunk("MVER", Buffer.alloc(4))), [], "no MOTX/MOMT: nothing");
});

test("a WMO's second textures: only what an env (3), env-metal (5) or composite (6) material draws", () => {
  const names = ["World\\Wall.blp", "Environments\\Env\\Sky.blp", "World\\Layer.blp", "World\\Unused.blp"];
  const [wall, env, layer, unused] = offsetsOf(names);
  const wmo = rootWmo(names, [wall, wall, wall, wall], [env, layer, unused, 0], [3, 6, 0, 5]);
  assert.deepEqual(wmoSecondTextures(wmo).sort(), ["environments\\env\\sky.blp", "world\\layer.blp"],
    "a diffuse (0) material's texture 2 is never loaded; offset 0 names nothing");
  assert.deepEqual(wmoSecondTextures(Buffer.alloc(3)), []);
});

test("the scenery folders: one list for the tool and the browser; character, creature, item, effect, UI and minimap art never", () => {
  assert.deepEqual([...HD_MODEL_TEXTURE_PREFIXES], MODEL_TEXTURE_PREFIXES, "the browser asks for exactly what the tool builds");
  for (const path of ["World\\Azeroth\\Elwynn\\Tree.blp", "dungeons\\textures\\x.blp", "environments\\stars\\sky.blp"]) {
    assert.equal(modelTexturePath(path), true, path);
    assert.equal(isHdModelTexturePath(path), true, path);
  }
  for (const path of ["creature\\wolf\\wolf.blp", "character\\human\\male\\skin.blp", "item\\objectcomponents\\weapon\\x.blp",
    "spells\\glow.blp", "particles\\smoke.blp", "interface\\icons\\x.blp", "world\\minimaps\\azeroth\\map32_48.blp",
    "textures\\minimap\\x.blp", "tileset\\elwynn\\grass.blp", "world\\azeroth\\elwynn\\tree.m2"]) {
    assert.equal(modelTexturePath(path), false, path);
    assert.equal(isHdModelTexturePath(path), false, path);
  }
});

test("the world set: ground without _s masks, buildings, WMO second textures and scenery models' own textures", async () => {
  const wmoNames = ["Dungeons\\Textures\\Wall.blp", "Creature\\X\\Skin.blp", "Spells\\Glow.blp", "Environments\\Env.blp"];
  const offsets = offsetsOf(wmoNames);
  const files = new Map([
    ["world\\wmo\\stormwind\\stormwind.wmo", rootWmo(wmoNames, offsets.slice(0, 3), [offsets[3]], [3])],
    ["world\\wmo\\stormwind\\stormwind_000.wmo", rootWmo(["Group\\Should\\Not.blp"], [0])],
    ["world\\azeroth\\elwynn\\tree.m2", doodadModel(["World\\Azeroth\\Elwynn\\Bark.blp", "World\\Azeroth\\Elwynn\\Leaf.blp",
      "Creature\\Wolf\\Wolf.blp", "Spells\\Fire.blp", "Item\\ObjectComponents\\X.blp", "Interface\\Icons\\X.blp",
      "Dungeons\\Textures\\Wall.blp"])],
    ["environments\\stars\\sky.m2", doodadModel(["Environments\\Stars\\Clouds.blp"])],
    ["creature\\wolf\\wolf.m2", doodadModel(["Creature\\Wolf\\Fur.blp"])],
  ]);
  const listings = {
    "tileset\\": ["tileset\\elwynn\\grass.blp", "tileset\\elwynn\\grass_s.blp", "tileset\\elwynn\\readme.txt"],
    "world\\wmo\\": ["world\\wmo\\stormwind\\stormwind.wmo", "world\\wmo\\stormwind\\stormwind_000.wmo"],
    "world\\": ["world\\azeroth\\elwynn\\tree.m2", "world\\azeroth\\elwynn\\tree.skin", "world\\minimaps\\x.m2",
      "world\\wmo\\stormwind\\stormwind.wmo"],
    "environments\\": ["environments\\stars\\sky.m2"],
    "creature\\": ["creature\\wolf\\wolf.m2"],
  };
  const read = [];
  const archives = {
    list: async (prefix) => new Set(listings[prefix] ?? []),
    read: async (path) => {
      read.push(path);
      return files.get(path);
    },
  };
  let report;
  const entries = await worldSet(archives, (value) => { report = value; });
  assert.deepEqual(entries.map((entry) => entry.path), [
    "dungeons\\textures\\wall.blp", "environments\\env.blp", "environments\\stars\\clouds.blp", "tileset\\elwynn\\grass.blp",
    "world\\azeroth\\elwynn\\bark.blp", "world\\azeroth\\elwynn\\leaf.blp",
  ]);
  const byPath = Object.fromEntries(entries.map((entry) => [entry.path, entry]));
  assert.equal(byPath["dungeons\\textures\\wall.blp"].wrap, true, "a building texture a doodad also uses stays wrapped");
  assert.equal(byPath["world\\azeroth\\elwynn\\bark.blp"].wrap, true, "the model's wrap flags");
  assert.equal(byPath["world\\azeroth\\elwynn\\leaf.blp"].wrap, false, "a clamped doodad texture is padded by clamping");
  assert.ok(!read.includes("creature\\wolf\\wolf.m2") && !read.includes("world\\minimaps\\x.m2"), "only scenery models are read");
  assert.deepEqual(report, { ground: 1, roots: 1, wmoTextures: 1, secondTextures: 1, models: 2, modelTextures: 3 });
});

test("×2 up to 512 a side (never past 1024), the ground only up to 256; compressed bookkeeping per kind", () => {
  assert.equal(SCALE_POLICY.world(256, 256, undefined, "world\\x.blp"), 2);
  assert.equal(SCALE_POLICY.world(128, 256, undefined, "dungeons\\x.blp"), 2);
  assert.equal(SCALE_POLICY.world(512, 512, undefined, "world\\wmo\\x.blp"), 2, "a 512 building or doodad texture → 1024");
  assert.equal(SCALE_POLICY.world(256, 512, undefined, "world\\x.blp"), 2);
  assert.equal(SCALE_POLICY.world(1024, 1024, undefined, "world\\x.blp"), 1, "never past 1024");
  assert.equal(SCALE_POLICY.world(512, 1024, undefined, "world\\x.blp"), 1);
  assert.equal(SCALE_POLICY.world(512, 512, 512, "world\\x.blp"), 1, "--max-side still caps");
  assert.equal(SCALE_POLICY.world(256, 256, undefined, "tileset\\elwynn\\grass.blp"), 2);
  assert.equal(SCALE_POLICY.world(512, 512, undefined, "tileset\\elwynn\\grass.blp"), 1, "the ground array is 512: a 512 ground stays");
  assert.equal(compressedFile("C:\\set\\abc.png"), "C:\\set\\abc.wht");
  assert.equal(compressPipeline("dungeons\\textures\\wall.blp"), COMPRESS_PIPELINE);
  assert.equal(compressPipeline("world\\azeroth\\elwynn\\leaf.blp"), COMPRESS_PIPELINE, "a doodad keeps its alpha");
  assert.notEqual(compressPipeline("tileset\\elwynn\\grass.blp"), COMPRESS_PIPELINE, "the ground is stored opaque");
  assert.equal(SET_MODEL.effects, MODEL, "effects keep animevideov3");
  assert.equal(SET_MODEL.world, "realesrgan-x4plus", "the world keeps its grain with x4plus");
});

// 24.10 (7.48 step 3): a cut-out's colour under its transparent texels (DXT1: black) must not reach the network.
test("a world cut-out is upscaled from its dilated colour; the original colour returns under alpha 0; opaque and effects unchanged", () => {
  const leaf = [60, 140, 40];
  // 8×2, two cells of a 1×2 sheet: the left cell a leaf with a cut-out middle, the right cell red and fully opaque.
  const image = { width: 8, height: 2, data: new Uint8Array(64) };
  for (let y = 0; y < 2; y++) {
    for (let x = 0; x < 8; x++) {
      const at = (y * 8 + x) * 4;
      if (x >= 4) image.data.set([200, 20, 20, 255], at);
      else image.data.set(x === 1 || x === 2 ? [0, 0, 0, 0] : [...leaf, 255], at);
    }
  }
  const layout = planLayout(8, 2, { grids: [[1, 2]], pad: 2 });
  const dilated = dilateUnderAlpha(image, layout);
  for (const x of [1, 2]) {
    assert.deepEqual([...dilated.data.subarray(x * 4, x * 4 + 4)], [...leaf, 0], "the leaf's colour under its cut-out, alpha kept");
  }
  assert.deepEqual([...image.data.subarray(4, 8)], [0, 0, 0, 0], "the source is not modified");
  // A nearest ×2 stand-in for the network, then assembly with the original put back under alpha 0.
  const { colour, alpha } = buildWorkImages(dilated, layout);
  const nearest = (picture) => {
    const out = { width: picture.width * 2, height: picture.height * 2, data: new Uint8Array(picture.width * picture.height * 16) };
    for (let y = 0; y < out.height; y++) {
      for (let x = 0; x < out.width; x++) {
        out.data.set(picture.data.subarray(((y >> 1) * picture.width + (x >> 1)) * 4, ((y >> 1) * picture.width + (x >> 1)) * 4 + 4), (y * out.width + x) * 4);
      }
    }
    return out;
  };
  const result = assemble(layout, 2, nearest(colour), nearest(alpha), 4, image);
  const texel = (x, y) => [...result.data.subarray((y * 16 + x) * 4, (y * 16 + x) * 4 + 4)];
  assert.deepEqual(texel(3, 0), [0, 0, 0, 0], "under alpha 0: the original's black, as an additive no-alpha draw saw it");
  assert.deepEqual(texel(1, 1), [...leaf, 255]);
  assert.deepEqual(texel(9, 0), [200, 20, 20, 255], "the opaque cell is untouched");
  assert.equal(pipelineFor("world", image), DILATED_PIPELINE);
  const opaque = { width: 1, height: 1, data: Uint8Array.from([1, 2, 3, 255]) };
  assert.equal(pipelineFor("world", opaque), PIPELINE, "an opaque texture keeps its entry");
  assert.equal(pipelineFor("effects", image), PIPELINE, "the effects set is not rebuilt");
});
