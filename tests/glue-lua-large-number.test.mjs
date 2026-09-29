import assert from "node:assert/strict";
import test from "node:test";
import { GlueLuaVm } from "../dist/code/browser/glue/GlueLua.js";

const CAST_START_MS = 1788097991493;
const CAST_END_MS = 1788097992993;

test("a UnitCastingInfo-shaped binding preserves epoch milliseconds and all tuple slots", () => {
  const vm = new GlueLuaVm();
  vm.registerGlobal("UnitCastingInfo", () => [
    "Огненный шар",
    "Уровень 1",
    "Огненный шар",
    "Interface\\Icons\\Spell_Fire_FlameBolt",
    CAST_START_MS,
    CAST_END_MS,
    false,
    42,
    true,
  ]);

  const outcome = vm.execute(`
    local name, rank, displayName, texture, startTime, endTime, isTradeSkill, castID, notInterruptible = UnitCastingInfo("player")
    captureName = name
    captureRank = rank
    captureDisplayName = displayName
    captureTexture = texture
    captureStart = startTime
    captureEnd = endTime
    captureTradeSkill = isTradeSkill
    captureCastID = castID
    captureNotInterruptible = notInterruptible
    captureStartExact = (startTime == 1788097991493)
    captureEndExact = (endTime == 1788097992993)
    captureSmallText = tostring(castID - 41)
  `, "@large-number-probe");

  assert.equal(outcome.ok, true, outcome.error ?? "UnitCastingInfo binding failed");
  assert.equal(vm.getGlobal("captureName"), "Огненный шар");
  assert.equal(vm.getGlobal("captureRank"), "Уровень 1");
  assert.equal(vm.getGlobal("captureDisplayName"), "Огненный шар");
  assert.equal(vm.getGlobal("captureTexture"), "Interface\\Icons\\Spell_Fire_FlameBolt");
  assert.equal(vm.getGlobal("captureStart"), CAST_START_MS);
  assert.equal(vm.getGlobal("captureEnd"), CAST_END_MS);
  assert.equal(vm.getGlobal("captureTradeSkill"), false);
  assert.equal(vm.getGlobal("captureCastID"), 42);
  assert.equal(vm.getGlobal("captureNotInterruptible"), true);
  assert.equal(vm.getGlobal("captureStartExact"), true);
  assert.equal(vm.getGlobal("captureEndExact"), true);
  assert.equal(vm.getGlobal("captureSmallText"), "1");
  assert.deepEqual(vm.errors, []);
  vm.close();
});

test("only in-range safe integers use Lua integer formatting", () => {
  const vm = new GlueLuaVm();
  vm.registerGlobal("Numbers", () => [1, CAST_START_MS]);
  const outcome = vm.execute("small, large = Numbers(); smallText = tostring(small); largeExact = (large == 1788097991493)", "@number-format-probe");

  assert.equal(outcome.ok, true, outcome.error ?? "number binding failed");
  assert.equal(vm.getGlobal("small"), 1);
  assert.equal(vm.getGlobal("smallText"), "1");
  assert.equal(vm.getGlobal("large"), CAST_START_MS);
  assert.equal(vm.getGlobal("largeExact"), true);
  assert.deepEqual(vm.errors, []);
  vm.close();
});
