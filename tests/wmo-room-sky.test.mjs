// 05.11 (7.61): whether the sky is drawn over a room no portal on screen leads out of. Measured: 146 of 146 frames of Stormwind
// (F:\WowOracle\tools\sky-rule.mjs), and the Goldshire Inn, the farm, the mine and the rest with their doors behind the camera.
import assert from "node:assert/strict";
import test from "node:test";

import { wmoGroupShowsSky } from "../dist/code/browser/WmoCameraWalk.js";

const MEASURED = [
  // Flags of the group under the camera, and whether Wow.exe drew the sky.
  [0x2805, false, "OuterCloister01, ThroneRoom02, Onyxia's InstanceHall"],
  [0x2a05, false, "CryptRm09, shopC39, Onyxia's Bridge"],
  [0x2841, true, "CloisterInner01, magic07"],
  [0x2a41, true, "holy01, bazaar01, Warrior01, the squares"],
  [0x3a41, true, "NightElf02"],
  [0x1809, true, "canalA"],
  [0x809, true, "city_outside01"],
  [0xa09, true, "cathy_facade01, the Lair's own outside"],
  [0x8020080d, true, "HarborEntrance"],
];

for (const [flags, sky, names] of MEASURED) {
  test(`group flags 0x${(flags >>> 0).toString(16)}: ${sky ? "sky" : "no sky"} (${names})`, () => {
    assert.equal(wmoGroupShowsSky({ flags }), sky);
  });
}
