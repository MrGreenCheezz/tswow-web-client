// 13.10 (7.16): the terrain glint's colour c[27].rgb is the world light's specular, which Wow.exe sets
// every frame (0x007816F0) from the sampled light block's band 9 (0x00D38B00 + 0xF8) — `TerrainSplat.ts`
// `setTerrainSpecularColour` — and the renderer feeds it from the light sample.
// What this does NOT prove: the glint's strength against the original's wet stone (14.25).

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { setTerrainSpecularColour, terrainSpecularColourValue } from "../dist/code/browser/TerrainSplat.js";
import { renderSwitches } from "../dist/code/browser/RenderSwitches.js";

test("c[27].rgb: band 9's bytes over 255, the diffuse band without the v5 channels", () => {
  setTerrainSpecularColour(0xff8040, { r: 0.1, g: 0.2, b: 0.3 });
  assert.deepEqual(terrainSpecularColourValue(), [1, 0x80 / 255, 0x40 / 255]);
  setTerrainSpecularColour(0x1ff8040, { r: 0.1, g: 0.2, b: 0.3 });
  assert.deepEqual(terrainSpecularColourValue(), [1, 0x80 / 255, 0x40 / 255], "only the colour bytes");
  setTerrainSpecularColour(undefined, { r: 0.1, g: 0.2, b: 0.3 });
  assert.deepEqual(terrainSpecularColourValue(), [0.1, 0.2, 0.3]);
  setTerrainSpecularColour(Number.NaN, { r: Number.NaN, g: 0.2, b: 0.3 });
  assert.deepEqual(terrainSpecularColourValue(), [0, 0.2, 0.3], "nothing broken reaches the uniform");
});

test("the renderer feeds band 9 with the world light, and the glint is on by default", async () => {
  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  assert.match(source,
    /setWorldLightUniforms\(this\.#worldLight, colours\.ambient, colours\.diffuse\);\r?\n.*\r?\n\s+setTerrainSpecularColour\(sample\.skyChannels \? sample\.sunColour : undefined, colours\.diffuse\);/);
  assert.equal(renderSwitches.terrainSpecular, true);
});
