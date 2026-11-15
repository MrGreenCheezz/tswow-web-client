import assert from "node:assert/strict";
import test from "node:test";
import {
  DISPLAY_ALPHA_FADE_MS, alphaByte, setDisplayAlpha, stepDisplayAlpha, unitDisplayAlpha,
} from "../dist/code/browser/UnitDisplayFade.js";

// 15.11 (6.11): CreatureModelAlpha through Wow.exe's unit fade — 0x0071abe0 → 0x00744030 (a byte target over 1000 ms,
// at once when equal) and 0x0071ac30 (linear in integer bytes).

test("15.11: the byte is round(alpha · 255)", () => {
  assert.equal(alphaByte(1), 255);
  assert.equal(alphaByte(128 / 255), 128);
  assert.equal(alphaByte(0), 0);
  assert.equal(alphaByte(2), 255);
});

test("15.11: a change fades linearly in whole bytes over a second", () => {
  const fade = { current: 255, from: 255, to: 255, startedAt: 0, duration: 0 };
  setDisplayAlpha(fade, 128 / 255, 1000);
  assert.equal(stepDisplayAlpha(fade, 1000), 255);
  // 255 + trunc(−127 · 250 / 1000) = 255 − 31 = 224.
  assert.equal(stepDisplayAlpha(fade, 1250), 224);
  assert.equal(stepDisplayAlpha(fade, 1999), 255 + Math.trunc((-127 * 999) / 1000));
  assert.equal(stepDisplayAlpha(fade, 2000), 128);
  assert.equal(fade.duration, 0);
  // Equal to the current byte: taken at once.
  setDisplayAlpha(fade, 128 / 255, 3000);
  assert.equal(fade.duration, 0);
  // A new target mid-fade starts from where the fade is.
  setDisplayAlpha(fade, 1, 4000);
  assert.equal(stepDisplayAlpha(fade, 4500), 128 + Math.trunc((127 * 500) / 1000));
  setDisplayAlpha(fade, 0, 4500);
  assert.equal(fade.from, 191);
  assert.equal(stepDisplayAlpha(fade, 4500 + DISPLAY_ALPHA_FADE_MS), 0);
});

test("15.11: a unit's first look is taken at once, a later change fades", () => {
  const unit = {};
  assert.equal(unitDisplayAlpha(unit, 128 / 255, 0), 128 / 255);
  assert.equal(unitDisplayAlpha(unit, 128 / 255, 100), 128 / 255);
  assert.equal(unitDisplayAlpha(unit, 1, 200), 128 / 255);
  assert.equal(unitDisplayAlpha(unit, 1, 700), (128 + Math.trunc((127 * 500) / 1000)) / 255);
  assert.equal(unitDisplayAlpha(unit, 1, 1200), 1);
  assert.equal(unitDisplayAlpha({}, 1, 0), 1);
});
