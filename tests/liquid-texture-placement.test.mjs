import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import * as THREE from "three";
import {
  LIQUID_ANIMATION_PERIOD_MS, LIQUID_MOTION_NONE, LIQUID_UV_PER_YARD, buildLiquidMaterial, liquidFrameAt,
  liquidMotionOf, liquidMotionOfRow, parseLiquidTypes, pushLiquidCellUvs, updateLiquidMaterial,
} from "../dist/code/browser/Water.js";
import { loadLiquidRows } from "../dist/code/gateway/LiquidMetadata.js";
import { dbcDirectory } from "../tools/paths.mjs";

// 11.11 (7.31): how Wow.exe places and moves a terrain liquid's texture.
//   0x007ce390  uv = position.xy * 0.06 (0x00a40410) for a vertex without stored (s, t)
//   0x008a1d60  frame = floor(frames * (t mod period) / period), the magma material's period 1250 ms
//   0x008a34b0  the magma material's scroll: (t mod P) / P with P = round(1000 / Float[n]) ms
//   0x008a5590  the water material scales the animated texture by Float[0]
// The rows come from the dataset's own LiquidType.dbc and LiquidMaterial.dbc.

const directory = dbcDirectory();
const haveDbc = existsSync(join(directory, "LiquidType.dbc")) && existsSync(join(directory, "LiquidMaterial.dbc"));

test("frames: the whole strip once per 1250 ms, whatever its length (0x008a1d60)", () => {
  assert.equal(LIQUID_ANIMATION_PERIOD_MS, 1250);
  assert.equal(liquidFrameAt(0, 30), 0);
  assert.equal(liquidFrameAt(625, 30), 15);
  assert.equal(liquidFrameAt(1249, 30), 29);
  assert.equal(liquidFrameAt(1250, 30), 0, "the loop closes at 1250 ms, not at one second");
  assert.equal(liquidFrameAt(1000, 30), 24, "thirty frames walk at 24 a second");
  // Fast water's sixteen frames take the same 1.25 s: 12.8 a second.
  assert.equal(liquidFrameAt(17 / 30 * 1000, 16), 7);
  assert.equal(liquidFrameAt(1250 * 1000 + 1249, 16), 15, "the clock's phase is the period's");
});

test("uv: 0.06 a yard of world X and Y, one repeat per four cells (0x007ce390)", () => {
  assert.equal(LIQUID_UV_PER_YARD, 0.06);
  const uvs = [];
  // A Shadowmoon Valley cell: world X -1000 .. -995.83, Y 2000 .. 1995.83.
  pushLiquidCellUvs(uvs, -1000, -1000 + 533.3333333333334 / 128, 2000, 2000 - 533.3333333333334 / 128);
  assert.equal(uvs.length, 8);
  assert.ok(Math.abs(uvs[0] - -60) < 1e-9 && Math.abs(uvs[1] - 120) < 1e-9, "u follows X, v follows Y");
  assert.ok(Math.abs((uvs[2] - uvs[0]) - 0.25) < 1e-9, "a quarter of a repeat per cell along X");
  assert.ok(Math.abs((uvs[5] - uvs[1]) - -0.25) < 1e-9, "a quarter of a repeat per cell along Y");
  // A chunk (33⅓ yards) is two whole repeats, so chunk and tile seams fall on the texture's edge.
  const chunk = [];
  pushLiquidCellUvs(chunk, 0, 100 / 3, 0, 0);
  assert.ok(Math.abs(chunk[2] - 2) < 1e-9);
  const scaled = [];
  pushLiquidCellUvs(scaled, 10, 11, 0, 0, 2);
  assert.ok(Math.abs(scaled[0] - 1.2) < 1e-9, "the water material's Float[0] scales the placement");
});

test("motion of the dataset's rows: magma scrolls, water scales (0x008a34b0, 0x008a5590)",
  { skip: haveDbc ? false : `no LiquidType.dbc/LiquidMaterial.dbc under ${directory}` }, async () => {
    const table = await loadLiquidRows(directory);
    const motion = (id) => {
      const row = table.rows[id];
      assert.ok(row, `row ${id}`);
      return liquidMotionOfRow(row.materialId, row.floatParams);
    };
    // 15 "Green Lava" and 3 "Magma": material 2, Float[0] 0.025 → one repeat along u every 40 s.
    for (const id of [3, 4, 15]) {
      assert.equal(table.rows[id].materialId, 2);
      assert.deepEqual(motion(id), { uvScale: 1, scrollU: 0.025, scrollV: 0 });
    }
    // 19 "WMO Magma": Float[1] 0.1 → along v every 10 s.
    assert.deepEqual(motion(19), { uvScale: 1, scrollU: 0, scrollV: 0.1 });
    // Water rows keep the placement as it is; 181 "Orange Slime" is a water-material row at Float[0] 2.
    assert.deepEqual(motion(1), { uvScale: 1, scrollU: 0, scrollV: 0 });
    assert.deepEqual(motion(181), { uvScale: 2, scrollU: 0, scrollV: 0 });
    // The procedural material is not read: as it was.
    assert.deepEqual(motion(100), { ...LIQUID_MOTION_NONE });
    // The browser's own parse of the route body gives the same answers.
    const parsed = parseLiquidTypes(JSON.parse(JSON.stringify(table)));
    assert.deepEqual(liquidMotionOf(15, parsed.motions), { uvScale: 1, scrollU: 0.025, scrollV: 0 });
    assert.equal(liquidMotionOf(0, parsed.motions), LIQUID_MOTION_NONE);
    assert.equal(parseLiquidTypes(table.classes).motions, undefined, "a v1 body has no motions");
  });

test("a scroll speed whose period is not a whole millisecond takes the rounded period", () => {
  // 1000 / 0.3 = 3333.3 ms → 3333 ms → 0.30003 a second.
  const { scrollU } = liquidMotionOfRow(2, [0.3, 0]);
  assert.ok(Math.abs(scrollU - 1000 / 3333) < 1e-12);
  assert.deepEqual(liquidMotionOfRow(2, [-0.1, 0]), { uvScale: 1, scrollU: 0, scrollV: 0 });
});

test("material: the frame and the scroll clock follow the time; the shader shifts by the scroll", () => {
  const lava = buildLiquidMaterial("magma|lavagreen", { texture: new THREE.Texture(), frames: 30 });
  updateLiquidMaterial(lava, "magma|lavagreen", undefined, 1);
  assert.equal(lava.uniforms.liquidFrame.value, 24);
  assert.equal(lava.uniforms.liquidSeconds.value, 1);
  updateLiquidMaterial(lava, "magma|lavagreen", undefined, 36001.5);
  assert.equal(lava.uniforms.liquidSeconds.value, 1.5, "wrapped at a multiple of 40 s and 10 s");
  const shader = {
    uniforms: {},
    vertexShader: THREE.ShaderLib.basic.vertexShader,
    fragmentShader: THREE.ShaderLib.basic.fragmentShader,
  };
  lava.material.onBeforeCompile(shader);
  assert.ok(shader.uniforms.liquidSeconds === lava.uniforms.liquidSeconds);
  assert.match(shader.vertexShader, /attribute vec2 liquidScroll;/);
  assert.match(shader.vertexShader, /vLiquidShift = fract\(liquidScroll \* liquidSeconds\);/);
  assert.match(shader.fragmentShader, /vec2 liquidPlaced = vMapUv \+ vLiquidShift;/);
  lava.material.dispose();
});
