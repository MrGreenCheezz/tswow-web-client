// 23.10 (7.48 step 2): what the `world` set takes (tools/hd-texture-set.mjs) — the ground textures without their `_s`
// masks and every root WMO's diffuse textures (MOMT texture 1), never doodads, character art or effect folders — and
// the tool's compressed-entry bookkeeping (tools/upscale-textures.mjs).
import assert from "node:assert/strict";
import test from "node:test";
import { wmoDiffuseTextures, worldSet } from "../tools/hd-texture-set.mjs";
import { compressedFile, compressPipeline, COMPRESS_PIPELINE, SCALE_POLICY } from "../tools/upscale-textures.mjs";

function chunk(tag, body) {
  const head = Buffer.alloc(8);
  head.write([...tag].reverse().join(""), 0, "latin1");
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

/** A root WMO with MOTX names and MOMT records pointing their texture 1 (and 2) at them. */
function rootWmo(names, texture1Offsets, texture2Offsets = []) {
  const motx = Buffer.from(`${names.join("\0")}\0`, "latin1");
  const momt = Buffer.alloc(texture1Offsets.length * 0x40);
  texture1Offsets.forEach((offset, index) => {
    momt.writeUInt32LE(offset, index * 0x40 + 0x0c);
    momt.writeUInt32LE(texture2Offsets[index] ?? 0, index * 0x40 + 0x18);
  });
  return Buffer.concat([chunk("MVER", Buffer.alloc(4)), chunk("MOHD", Buffer.alloc(64)), chunk("MOTX", motx), chunk("MOMT", momt)]);
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

test("the world set: ground without _s masks, buildings' diffuse textures, never doodads, characters or effects", async () => {
  const files = new Map([
    ["world\\wmo\\stormwind\\stormwind.wmo", (() => {
      const names = ["Dungeons\\Textures\\Wall.blp", "Creature\\X\\Skin.blp", "Spells\\Glow.blp"];
      const offsets = names.map((_, index) => names.slice(0, index).reduce((sum, name) => sum + name.length + 1, 0));
      return rootWmo(names, offsets);
    })()],
    ["world\\wmo\\stormwind\\stormwind_000.wmo", rootWmo(["Group\\Should\\Not.blp"], [0])],
  ]);
  const listings = {
    "tileset\\": ["tileset\\elwynn\\grass.blp", "tileset\\elwynn\\grass_s.blp", "tileset\\elwynn\\readme.txt"],
    "world\\wmo\\": [...files.keys()],
  };
  const archives = {
    list: async (prefix) => new Set(listings[prefix] ?? []),
    read: async (path) => files.get(path),
  };
  let report;
  const entries = await worldSet(archives, (value) => { report = value; });
  assert.deepEqual(entries.map((entry) => entry.path), ["dungeons\\textures\\wall.blp", "tileset\\elwynn\\grass.blp"]);
  assert.ok(entries.every((entry) => entry.wrap === true && entry.grids.length === 0));
  assert.deepEqual(report, { ground: 1, roots: 1, wmoTextures: 1 });
});

test("×2 only up to 256 a side and never past 1024; compressed bookkeeping per kind", () => {
  assert.equal(SCALE_POLICY.world(256, 256), 2);
  assert.equal(SCALE_POLICY.world(128, 256), 2);
  assert.equal(SCALE_POLICY.world(512, 512), 1);
  assert.equal(SCALE_POLICY.world(256, 512), 1);
  assert.equal(compressedFile("C:\\set\\abc.png"), "C:\\set\\abc.wht");
  assert.equal(compressPipeline("dungeons\\textures\\wall.blp"), COMPRESS_PIPELINE);
  assert.notEqual(compressPipeline("tileset\\elwynn\\grass.blp"), COMPRESS_PIPELINE, "the ground also carries its specular mask");
});
