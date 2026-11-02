// The defaults the owner ruled on 12.10 (WORK_PLAN «Решения владельца»): the stock interface for every
// player (0.4a, 0.4h), AutoQuality off (0.4d, 12.15) and the highest lighting quality (0.4e). A saved
// choice still wins over each of them. The TSWoW modules' addons (0.4b, 9.02) have no switch at all.

import assert from "node:assert/strict";
import test from "node:test";
import { defaultSettings, parseSettings } from "../dist/code/browser/ui/SettingsModel.js";

test("12.10 the owner's defaults", () => {
  const defaults = defaultSettings();
  assert.equal("originalFrameXml" in defaults, false, "02.11: the stock interface is the only one, no switch");
  assert.equal("tswowAddons" in defaults, false, "0.4b: the modules' addons are part of the interface, no switch");
  assert.equal(defaults.autoQuality, false, "0.4d: AutoQuality off until turned on");
  assert.equal(defaults.lightingQuality, 2, "0.4e: the highest lighting quality");
});

test("12.10 a saved choice wins over the new defaults", () => {
  const saved = parseSettings('{"originalFrameXml":false,"autoQuality":true,"lightingQuality":1}');
  assert.deepEqual([saved.autoQuality, saved.lightingQuality], [true, 1]);
  assert.equal("originalFrameXml" in saved, false, "a blob from before 02.11 no longer carries the switch");
  const blank = parseSettings("{}");
  assert.deepEqual(
    [blank.autoQuality, blank.lightingQuality],
    [false, 2], "a blob without these keys takes the defaults");
});
