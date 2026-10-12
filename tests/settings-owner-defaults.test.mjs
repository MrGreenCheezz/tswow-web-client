// The defaults the owner ruled on 12.10 (WORK_PLAN «Решения владельца»): the stock interface for every
// player (0.4a, 0.4h), the TSWoW modules' addons on (0.4b, 9.02), AutoQuality off (0.4d, 12.15) and the
// highest lighting quality (0.4e). A saved choice still wins over each of them.

import assert from "node:assert/strict";
import test from "node:test";
import { defaultSettings, parseSettings } from "../dist/code/browser/ui/SettingsModel.js";

test("12.10 the owner's defaults", () => {
  const defaults = defaultSettings();
  assert.equal(defaults.originalFrameXml, true, "0.4a: the stock FrameXML interface");
  assert.equal(defaults.tswowAddons, true, "0.4b: the installed modules' addons");
  assert.equal(defaults.autoQuality, false, "0.4d: AutoQuality off until turned on");
  assert.equal(defaults.lightingQuality, 2, "0.4e: the highest lighting quality");
});

test("12.10 a saved choice wins over the new defaults", () => {
  const saved = parseSettings('{"originalFrameXml":false,"tswowAddons":false,"autoQuality":true,"lightingQuality":1}');
  assert.deepEqual(
    [saved.originalFrameXml, saved.tswowAddons, saved.autoQuality, saved.lightingQuality],
    [false, false, true, 1]);
  const blank = parseSettings("{}");
  assert.deepEqual(
    [blank.originalFrameXml, blank.tswowAddons, blank.autoQuality, blank.lightingQuality],
    [true, true, false, 2], "a blob without these keys takes the defaults");
});
