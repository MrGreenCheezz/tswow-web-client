// 22.10 (7.44): the far ground's minimap detail (HorizonDetail.ts) — the clipmap's slots and
// windows, its streaming and upload budget, the shader it installs and who gets it.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as THREE from "three";
import {
  HORIZON_DETAIL_LEVELS, HORIZON_DETAIL_UPLOADS_PER_FRAME, HorizonDetail, horizonDetailBytes,
  horizonDetailFragment, horizonDetailSlot, horizonDetailWindow,
} from "../dist/code/browser/HorizonDetail.js";
import { HorizonMaterialSelector } from "../dist/code/browser/HorizonMaterial.js";
import { createWorldLightUniforms } from "../dist/code/browser/WorldLighting.js";

test("a tile's slot is its grid coordinate modulo the window, negative-safe", () => {
  assert.equal(horizonDetailSlot(49, 6), 1);
  assert.equal(horizonDetailSlot(-1, 6), 5);
  // Neighbouring tiles are neighbouring slots (wrapping), so filtering runs across their edge.
  for (const level of HORIZON_DETAIL_LEVELS) {
    const width = level.reach * 2 + 1;
    assert.ok(width < level.slots, `a ${width}-tile window fits ${level.slots} slots with one to spare`);
    const slots = new Set();
    for (let grid = 30; grid < 30 + width; grid++) slots.add(horizonDetailSlot(grid, level.slots));
    assert.equal(slots.size, width, "no two tiles of one window share a slot");
  }
});

test("the window is the square around the player's tile, nearest ring first", () => {
  const cells = horizonDetailWindow(49, 31, 2);
  assert.equal(cells.length, 25);
  assert.deepEqual(cells[0], { x: 49, y: 31 });
  const rings = cells.map((cell) => Math.max(Math.abs(cell.x - 49), Math.abs(cell.y - 31)));
  assert.deepEqual(rings, [...rings].sort((a, b) => a - b));
  // Clipped at the map's edge.
  assert.equal(horizonDetailWindow(0, 0, 2).length, 9);
});

test("the GPU memory is bounded: two levels and the residency map, about 21 MB", () => {
  const bytes = horizonDetailBytes();
  assert.ok(bytes > 21e6 && bytes < 22.5e6, `${bytes}`);
});

test("the fragment mixes every level by residency and window fade, sampling each unconditionally", () => {
  const code = horizonDetailFragment();
  for (let index = 0; index < HORIZON_DETAIL_LEVELS.length; index++) {
    assert.match(code, new RegExp(`texture2D\\( horizonDetail${index}, horizonCell / ${HORIZON_DETAIL_LEVELS[index].slots}\\.0 \\)`));
  }
  assert.doesNotMatch(code, /\bif\s*\(/, "no sample inside a branch");
  assert.match(code, /diffuseColor \*= sampledDiffuseColor;/);
});

function fakeRenderer() {
  const copies = [];
  return {
    copies,
    initTexture() {},
    copyTextureToTexture(source, target, region, position) {
      copies.push({ target: target.name, x: position.x, y: position.y, mipmaps: target.generateMipmaps });
    },
  };
}

function fakeTiles({ missing = new Set() } = {}) {
  const asked = [];
  return {
    asked,
    hash(map, gridX, gridY) {
      return missing.has(`${gridX}/${gridY}`) ? null : `${gridX}-${gridY}`;
    },
    async picture(hash, size) {
      asked.push({ hash, size });
      return { close() {} };
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("cells stream nearest first, upload within the frame budget and fade in", async () => {
  const detail = new HorizonDetail();
  const renderer = fakeRenderer();
  const tiles = fakeTiles({ missing: new Set(["49/32"]) });
  let now = 0;
  for (let frame = 0; frame < 200; frame++) {
    const before = renderer.copies.length;
    detail.update(renderer, 0, 49, 31, tiles, now += 16);
    assert.ok(renderer.copies.length - before <= HORIZON_DETAIL_UPLOADS_PER_FRAME, "upload budget per frame");
    await settle();
  }
  // Level 0's first asks are the player's tile and its ring, at 256 texels.
  assert.deepEqual(tiles.asked[0], { hash: "49-31", size: 256 });
  // 25 + 81 cells, one without a bake.
  assert.deepEqual(detail.resident, [24, 80]);
  assert.equal(detail.pending, 0);
  // The player's tile lands in slot (31 mod 6, 49 mod 6) = (1, 1) of level 0.
  assert.ok(renderer.copies.some((copy) => copy.target === "horizon-detail-0" && copy.x === 256 && copy.y === 256));
  // Only the last copy of a frame's batch rebuilds the mip chain.
  for (const texture of detail.textures) assert.equal(texture.generateMipmaps, true);
  // Faded in: the residency map holds 255 for a resident cell, 0 for the cell with no bake.
  const data = detail.residency.image.data;
  assert.equal(data[(49 * 64 + 31) * 4], 255);
  assert.equal(data[(49 * 64 + 32) * 4], 0);
  assert.equal(data[(49 * 64 + 32) * 4 + 1], 0);
});

test("crossing a tile drops the cells that left the window at once", async () => {
  const detail = new HorizonDetail();
  const renderer = fakeRenderer();
  const tiles = fakeTiles();
  let now = 0;
  for (let frame = 0; frame < 200; frame++) {
    detail.update(renderer, 0, 49, 31, tiles, now += 16);
    await settle();
  }
  const data = detail.residency.image.data;
  assert.equal(data[(47 * 64 + 31) * 4], 255, "two rows north is in level 0");
  detail.update(renderer, 0, 50, 31, tiles, now += 16);
  assert.equal(data[(47 * 64 + 31) * 4], 0, "three rows north is out of level 0 the same frame");
  assert.equal(data[(47 * 64 + 31) * 4 + 1], 255, "and still in level 1");
  assert.deepEqual(detail.centre.toArray(), [31.5, 50.5]);
});

test("only a caller on the enhanced path gets the detailed material; the faithful lit one is unchanged", () => {
  const selector = new HorizonMaterialSelector(new THREE.MeshBasicMaterial(), createWorldLightUniforms());
  const colour = new THREE.Texture();
  const lit = selector.select(0, () => colour);
  assert.equal(lit.name, "horizon-lit");
  const detail = new HorizonDetail();
  const detailed = selector.select(2, () => colour, detail);
  assert.equal(detailed.name, "horizon-detail");
  assert.notEqual(detailed, lit);
  assert.equal(detailed.map, colour);
  // The program: the detail hook first, then the world light's (its key keeps both).
  const shader = {
    uniforms: {},
    vertexShader: THREE.ShaderLib.lambert.vertexShader,
    fragmentShader: THREE.ShaderLib.lambert.fragmentShader,
  };
  detailed.onBeforeCompile(shader, undefined);
  assert.match(shader.fragmentShader, /uniform sampler2D horizonDetail0;/);
  assert.ok(shader.uniforms.horizonDetailResidency.value === detail.residency);
  assert.match(detailed.customProgramCacheKey(), /horizon-detail-7\.44/);
  // Without a colour map there is nothing to lay detail over: the flat basic material, as before.
  assert.equal(selector.select(2, () => undefined, detail).type, "MeshBasicMaterial");
});

test("the renderer hands the detail to the enhanced path only (lightingClassicLook)", async () => {
  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("#updateHorizonDetail(map: number"), source.indexOf("get horizonDetailPending"));
  assert.match(body, /if \(lightingClassicLook\(this\.#lightingProfile\.quality\) \|\| !horizonClient\) \{[\s\S]*?dispose\(\);[\s\S]*?return undefined;/);
});
