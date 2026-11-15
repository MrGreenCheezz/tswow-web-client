// 15.11 (fx11, 7.66): the fog under a liquid on a shaped map (530 and up) against frames of the original client
// (WowOracle `runs/fx11-nr-*`: the Dragonblight sea, MH2O liquid 2, surface 0; `runs/fx11-ol-*`: a Zangarmarsh lake, MCLQ
// river, surface 18.27; first person, noon; terrain VS c12 = -1/(end-start), end/(end-start), density; PS c2 = colour).
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { resolveLighting } from "../dist/code/browser/LightClient.js";
import { loadLightMetadata } from "../dist/code/gateway/LightMetadata.js";
import { UNDERWATER_SHAPED_DENSITY_SCALE, shapedSceneFog } from "../dist/code/browser/DistanceFog.js";
import { shapedFogOf } from "../dist/code/browser/ShapedFogSet.js";

const DATASET_DBC = "F:/tswowRoot/tswow-install/modules/default/datasets/dataset/dbc";
const CLIENT = process.env.CLIENT_DIR ?? "F:/Circle";
const bytes = (c) => [c.r, c.g, c.b].map((v) => Math.round(v * 255));

test("under a liquid the shaped fog's density is doubled, above it it is not (0x007f16f0)", () => {
  const set = { end: 1277, share: 0, density: 5.1667 };
  assert.equal(UNDERWATER_SHAPED_DENSITY_SCALE, 2);
  assert.ok(Math.abs(shapedSceneFog(set, true, { near: 0, far: 0, density: 1 }).density - 10.3334) < 1e-3);
  assert.equal(shapedSceneFog(set, false, { near: 0, far: 0, density: 1 }).density, 5.1667);
});

test("the fog under and over the water of Northrend and Outland is what Wow.exe drew", {
  skip: existsSync(DATASET_DBC) && existsSync(`${CLIENT}/Wow.exe`) ? false : "no dataset or no Wow.exe",
}, async () => {
  const meta = await loadLightMetadata(DATASET_DBC, CLIENT);
  // [frame, map, player x, y, z, under, liquid type, Wow.exe start, end, density, fog colour]; the eye is 1.86 above the
  // player (K z: −4.14 / 2.46 / 13.86 / 20.46). The light follows the player's position, the liquid test the camera.
  for (const [name, map, x, y, z, under, liquid, start, end, density, colour] of [
    ["nr-under-1", 571, 2916.7, 2116.7, -6, true, 2, 0, 1277, 10.3333, [72, 116, 154]],
    ["nr-above-1", 571, 2916.7, 2116.7, 0.6, false, undefined, 0, 1277, 1.5, [42, 152, 152]],
    ["ol-under-1", 530, -183.3, 5883.3, 12, true, 1, 0, 1277, 7.5833, [34, 72, 132]],
    ["ol-above-1", 530, -183.3, 5883.3, 18.6, false, undefined, 0, 1277, 3.0278, [34, 72, 132]],
  ]) {
    const sample = resolveLighting(meta.get(map), x, y, 1440, 0, z, undefined, under, 0, liquid, 0);
    const fog = shapedSceneFog(shapedFogOf(sample), under, { near: 0, far: 0, density: 1 });
    assert.ok(Math.abs(fog.far - end) < 0.05, `${name} end: ours ${fog.far}`);
    assert.ok(Math.abs(fog.near - start) < 0.05, `${name} start: ours ${fog.near}`);
    assert.ok(Math.abs(fog.density - density) < 0.001, `${name} density: ours ${fog.density}, Wow.exe ${density}`);
    const ours = bytes(sample.colours.fog);
    for (let channel = 0; channel < 3; channel++) {
      assert.ok(Math.abs(ours[channel] - colour[channel]) <= 1, `${name} colour: ours ${ours}, Wow.exe ${colour}`);
    }
  }
});
