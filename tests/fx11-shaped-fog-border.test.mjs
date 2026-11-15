// 15.11 (fx11, 7.66/7.67): the shaped fog of Northrend across a zone border against frames of the original client
// (WowOracle `runs/light11-nc-*`, `light11-nd-*`, terrain VS c12: -1/(end-start), end/(end-start), density). Wow.exe
// converts every Light set by 0x007ecd80 (share clamped at 0, density of its own start and end, end to the far clip)
// before 0x007ed4c0 blends them.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { resolveLighting } from "../dist/code/browser/LightClient.js";
import { loadLightMetadata } from "../dist/code/gateway/LightMetadata.js";
import { shapedBlendedFog, shapedZoneFog } from "../dist/code/browser/DistanceFog.js";
import { shapedFogOf } from "../dist/code/browser/ShapedFogSet.js";

const DATASET_DBC = "F:/tswowRoot/tswow-install/modules/default/datasets/dataset/dbc";
const CLIENT = process.env.CLIENT_DIR ?? "F:/Circle";

test("a set's negative share is clamped before the blend, not after it", () => {
  // Two sets far apart in share: 0.1 and -0.5, halfway. Clamped first: 0.05 of the far clip; clamped after: 0.
  const sample = { fogEnd: 1000, fogStart: 0, shapedFogEnd: 1277, shapedFogShare: 0.05, shapedFogDensity: 1.5 };
  const fog = shapedBlendedFog(shapedFogOf(sample), { near: 0, far: 0, density: 1 });
  assert.equal(fog.far, 1277);
  assert.ok(Math.abs(fog.near - 63.85) < 1e-9);
  // A sample with no shaped fields is converted as one set, as shapedZoneFog does.
  const plain = shapedFogOf({ fogEnd: 666.7, fogStart: 333.35 });
  const zone = shapedZoneFog(666.7, 0.5, 1277, { near: 0, far: 0, density: 1 });
  assert.ok(Math.abs(plain.density - zone.density) < 1e-9 && Math.abs(plain.share * plain.end - zone.near) < 1e-9);
});

test("across Northrend's zone borders the shaped fog starts and thickens as Wow.exe drew it", {
  skip: existsSync(DATASET_DBC) && existsSync(`${CLIENT}/Wow.exe`) ? false : "no dataset or no Wow.exe",
}, async () => {
  const northrend = (await loadLightMetadata(DATASET_DBC, CLIENT)).get(571);
  // Points and time as light-recorded-frames.test.mjs; start and density from each frame's terrain c12.
  for (const [name, x, y, z, start, density] of [
    ["nc-m100", 2769.0, 3319.9, 80, 127.7, 1.5],
    ["nc-m25", 2763.9, 3245.1, 80, 74.2, 1.5],
    ["nc-0", 2762.2, 3220.2, 80, 33.66, 1.5],
    ["nc-p25", 2760.5, 3195.2, 80, 8.8, 1.5],
    ["nc-p100", 2755.4, 3120.4, 80, 0, 1.5],
    ["nd-m100", 4941.5, -699.9, 680, 0, 3.6389],
    ["nd-m25", 4866.5, -697.9, 680, 0.28, 3.007],
    ["nd-0", 4841.6, -697.3, 680, 0.4, 2.4743],
    ["nd-p25", 4816.6, -696.6, 680, 0.33, 1.9394],
    ["nd-p100", 4741.6, -694.6, 680, 0, 1.5],
  ]) {
    const sample = resolveLighting(northrend, x, y, 1441.5, 0, z);
    const fog = shapedBlendedFog(shapedFogOf(sample), { near: 0, far: 0, density: 1 });
    assert.ok(Math.abs(fog.far - 1277) < 0.05, `${name} end: ours ${fog.far}`);
    assert.ok(Math.abs(fog.near - start) < 1.5, `${name} start: ours ${fog.near.toFixed(2)}, Wow.exe ${start}`);
    assert.ok(Math.abs(fog.density - density) < 0.01, `${name} density: ours ${fog.density.toFixed(4)}, Wow.exe ${density}`);
  }
});
