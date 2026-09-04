import assert from "node:assert/strict";
import test from "node:test";

const {
  FRAMEXML_INVENTORY_SLOTS,
  FRAMEXML_SEAM_BINDINGS,
  FRAMEXML_SEAM_PRELUDE,
  FRAMEXML_SEAM_EVENTS,
} = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { FRAMEXML_NEUTRAL_PRELUDE } = await import("../dist/code/browser/framexml/FrameXmlNeutralApi.js");
const { GlueLuaVm } = await import("../dist/code/browser/glue/GlueLua.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

const call = (name, seam, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);
const floatBits = (value) => {
  const bytes = new ArrayBuffer(4);
  new DataView(bytes).setFloat32(0, value, true);
  return new DataView(bytes).getUint32(0, true);
};

test("CVar seam composition preserves string values and the host ShowAllSpellRanks override", () => {
  const vm = new GlueLuaVm();
  let showAllSpellRanks = false;
  const hostWrites = [];
  const seam = new LiveWorldSeam({
    world: () => undefined,
    store: () => undefined,
    spell: () => undefined,
    monotonic: () => 0,
    globalCooldownUntil: () => 0,
    castSpell: () => {},
    getCVarBool: (name) => name.toLowerCase() === "showallspellranks"
      ? showAllSpellRanks : undefined,
    setCVar: (name, value) => {
      hostWrites.push([name, value]);
      if (name.toLowerCase() === "showallspellranks") showAllSpellRanks = value;
    },
  });
  try {
    vm.setGlobal("__fxNeutralImpl", {});
    vm.setGlobal("__fxAddonModules", []);
    assert.equal(vm.execute(FRAMEXML_NEUTRAL_PRELUDE, "@character-seam:neutral").ok, true);
    vm.registerGlobal("__fxSeam_GetCVarBool", (args) => FRAMEXML_SEAM_BINDINGS.GetCVarBool(seam, args));
    vm.registerGlobal("__fxSeam_SetCVar", (args) => FRAMEXML_SEAM_BINDINGS.SetCVar(seam, args));
    vm.setGlobal("__fxSeamNames", ["GetCVarBool", "SetCVar"]);
    assert.equal(vm.execute(FRAMEXML_SEAM_PRELUDE, "@character-seam:seam").ok, true);
    const run = vm.execute(`
      __setResult = __fxNeutralImpl.SetCVar("playerStatLeftDropdown", "PLAYERSTAT_BASE_STATS")
      __value = __fxNeutralImpl.GetCVar("playerStatLeftDropdown")
      __valueBool = __fxNeutralImpl.GetCVarBool("playerStatLeftDropdown")
      __unknownBool = __fxNeutralImpl.GetCVarBool("framexml_unknown_cvar")
      __showBefore = __fxNeutralImpl.GetCVarBool("showAllSpellRanks")
      __fxNeutralImpl.SetCVar("showAllSpellRanks", "1")
      __showAfter = __fxNeutralImpl.GetCVarBool("showAllSpellRanks")
    `, "@character-seam:cvars");
    assert.equal(run.ok, true, run.error);
    assert.equal(vm.getGlobal("__setResult"), true, "neutral SetCVar return is preserved");
    assert.equal(vm.getGlobal("__value"), "PLAYERSTAT_BASE_STATS");
    assert.equal(vm.getGlobal("__valueBool"), true, "neutral GetCVarBool remains the fallback");
    assert.equal(vm.getGlobal("__unknownBool"), undefined, "unknown CVar stays nil");
    assert.equal(vm.getGlobal("__showBefore"), false, "host owns ShowAllSpellRanks");
    assert.equal(vm.getGlobal("__showAfter"), true, "host boolean override wins over neutral CVar");
    assert.deepEqual(hostWrites, [
      ["playerStatLeftDropdown", false],
      ["showAllSpellRanks", true],
    ], "host notification sees the original CVar names and the boolean bridge value");
  } finally {
    vm.close();
  }
});

test("paper-doll slot lookup exposes all nineteen equipment and four bag IDs", () => {
  const expected = [
    ["HeadSlot", 1, "Head"], ["NeckSlot", 2, "Neck"], ["ShoulderSlot", 3, "Shoulder"],
    ["ShirtSlot", 4, "Shirt"], ["ChestSlot", 5, "Chest"], ["WaistSlot", 6, "Waist"],
    ["LegsSlot", 7, "Legs"], ["FeetSlot", 8, "Feet"], ["WristSlot", 9, "Wrists"],
    ["HandsSlot", 10, "Hands"], ["Finger0Slot", 11, "Finger"], ["Finger1Slot", 12, "Finger"],
    ["Trinket0Slot", 13, "Trinket"], ["Trinket1Slot", 14, "Trinket"], ["BackSlot", 15, "Rear"],
    ["MainHandSlot", 16, "MainHand"], ["SecondaryHandSlot", 17, "SecondaryHand"],
    ["RangedSlot", 18, "Ranged"], ["TabardSlot", 19, "Tabard"],
    ["Bag0Slot", 20, "Bag"], ["Bag1Slot", 21, "Bag"], ["Bag2Slot", 22, "Bag"],
    ["Bag3Slot", 23, "Bag"],
  ];
  const seam = new CannedWorldSeam();
  for (const [name, id, suffix] of expected) {
    assert.deepEqual(call("GetInventorySlotInfo", seam, name), [
      id, `Interface\\Paperdoll\\UI-PaperDoll-Slot-${suffix}`,
    ], name);
    assert.deepEqual(FRAMEXML_INVENTORY_SLOTS[name], [
      id, `Interface\\Paperdoll\\UI-PaperDoll-Slot-${suffix}`,
    ]);
  }
  assert.deepEqual(call("GetInventorySlotInfo", seam, "unknown"), []);
});

test("canned equipment texture/count and PaperDoll tuples are explicit and deduplicated", () => {
  const seam = new CannedWorldSeam();
  const fired = [];
  seam.attach({ fire: (event, ...args) => { fired.push([event, ...args]); return 1; }, now: () => 1 });
  assert.deepEqual(call("GetInventoryItemTexture", seam, "player", 1), [
    "Interface\\Icons\\INV_Potion_54",
  ]);
  assert.deepEqual(call("GetInventoryItemCount", seam, "player", 1), [1]);
  assert.deepEqual(call("GetInventoryItemCooldown", seam, "player", 1), [0, 0, 0]);
  assert.deepEqual(call("IsInventoryItemLocked", seam, "player", 1), [false]);
  assert.deepEqual(call("IsInventoryItemBroken", seam, "player", 1), [false]);
  assert.deepEqual(call("UnitStat", seam, "player", 1), [100, 100, 0, 0]);
  assert.deepEqual(call("UnitStat", seam, "player", 5), [60, 60, 0, 0]);
  assert.deepEqual(call("UnitStat", seam, "player", 0), [0, 0, 0, 0]);
  assert.deepEqual(call("UnitStat", seam, "player", 6), [0, 0, 0, 0]);
    assert.deepEqual(call("UnitArmor", seam, "player"), [120, 130, 120, 10, 0]);
    assert.deepEqual(call("UnitAttackPower", seam, "player"), [950, 25, -5]);
    assert.deepEqual(call("GetAttackPowerForStat", seam, 1, 100), [0],
      "unsupported class-specific AP contribution stays neutral");
    assert.deepEqual(call("GetUnitMaxHealthModifier", seam, "player"), [1],
      "multiplicative health modifier uses its neutral identity");
    assert.deepEqual(call("GetCVarBool", seam, "framexml_unknown_cvar"), [],
      "Canned unknown boolean CVar stays undefined for neutral fallback");
    assert.deepEqual(call("GetCVarBool", seam, "showAllSpellRanks"), [false]);
    assert.deepEqual(call("UnitDamage", seam, "player"), [55, 80, 0, 0, 0, 0, 1]);
  fired.length = 0;
  const changedStat = [91, 96, 5, 0];
  assert.equal(seam.setPlayerStat(1, changedStat), 1);
  assert.deepEqual(fired, [[FRAMEXML_SEAM_EVENTS.stats, "player"]]);
  fired.length = 0;
  assert.equal(seam.setPlayerStat(1, changedStat), 0, "the same tuple stays quiet");
  fired.length = 0;
  const item = { texture: "Interface\\Icons\\INV_Misc_QuestionMark", count: 2, broken: true };
  assert.equal(seam.setInventoryItem(1, item), 1);
  assert.deepEqual(fired, [[FRAMEXML_SEAM_EVENTS.inventoryChanged, "player"]]);
  assert.deepEqual(call("GetInventoryItemTexture", seam, "player", 1), [item.texture]);
  assert.deepEqual(call("GetInventoryItemCount", seam, "player", 1), [2]);
  assert.deepEqual(call("IsInventoryItemBroken", seam, "player", 1), [true]);
});

test("live paper-doll reads use owner fields and the cached item texture", () => {
  const selfGuid = 0x101n;
  const itemGuid = 0x202n;
  const playerFields = new Map([
    [UPDATE_FIELDS.PLAYER_FIELD_INV_SLOT_HEAD.offset, Number(itemGuid)],
    [UPDATE_FIELDS.PLAYER_FIELD_INV_SLOT_HEAD.offset + 1, 0],
    [UPDATE_FIELDS.UNIT_FIELD_BYTES_0.offset, 0x02010000],
    [UPDATE_FIELDS.UNIT_FIELD_STAT0.offset, 123],
    [UPDATE_FIELDS.UNIT_FIELD_POSSTAT0.offset, 10],
    [UPDATE_FIELDS.UNIT_FIELD_NEGSTAT0.offset, -3],
    [UPDATE_FIELDS.UNIT_FIELD_RESISTANCES.offset, 500],
    [UPDATE_FIELDS.UNIT_FIELD_RESISTANCEBUFFMODSPOSITIVE.offset, 25],
    [UPDATE_FIELDS.UNIT_FIELD_RESISTANCEBUFFMODSNEGATIVE.offset, -5],
    [UPDATE_FIELDS.UNIT_FIELD_ATTACK_POWER.offset, 900],
    [UPDATE_FIELDS.UNIT_FIELD_ATTACK_POWER_MODS.offset, ((-4 & 0xffff) << 16) | 15],
    [UPDATE_FIELDS.UNIT_FIELD_BASEATTACKTIME.offset, 2000],
    [UPDATE_FIELDS.UNIT_FIELD_MINDAMAGE.offset, floatBits(50)],
    [UPDATE_FIELDS.UNIT_FIELD_MAXDAMAGE.offset, floatBits(75)],
    [UPDATE_FIELDS.PLAYER_FIELD_MOD_DAMAGE_DONE_PCT.offset, floatBits(1.25)],
  ]);
  const itemFields = new Map([
    [UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, 13446],
    [UPDATE_FIELDS.ITEM_FIELD_STACK_COUNT.offset, 3],
  ]);
  const store = { field: () => () => {}, any: () => () => {} };
  const world = {
    state: { selfGuid, objects: new Map([
      [selfGuid, { guid: selfGuid, typeId: 4, fields: playerFields }],
      [itemGuid, { guid: itemGuid, fields: itemFields }],
    ]) },
    actionButtons: [], casts: new Map(), channels: new Map(), events: { on: () => () => {} },
    itemTemplates: new Map(), cooldownRemaining: () => 0,
  };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => store, spell: () => undefined,
    monotonic: () => 0, globalCooldownUntil: () => 0, castSpell: () => {},
    itemTexture: (entry) => entry === 13446 ? "Interface\\Icons\\INV_Potion_54" : undefined,
  });
  const fired = [];
  seam.attach({ fire: (event, ...args) => { fired.push([event, ...args]); return 1; }, now: () => 0 });
  assert.deepEqual(call("GetInventoryItemTexture", seam, "player", 1), [
    "Interface\\Icons\\INV_Potion_54",
  ]);
  assert.deepEqual(call("GetInventoryItemCount", seam, "player", 1), [3]);
  assert.deepEqual(call("UnitStat", seam, "player", 1), [123, 130, 10, -3]);
  assert.deepEqual(call("UnitStat", seam, "player", 5), [0, 0, 0, 0]);
  assert.deepEqual(call("UnitStat", seam, "player", 0), [0, 0, 0, 0]);
  assert.deepEqual(call("UnitStat", seam, "player", 6), [0, 0, 0, 0]);
  assert.deepEqual(call("UnitArmor", seam, "player"), [500, 520, 500, 25, -5]);
  assert.deepEqual(call("UnitAttackPower", seam, "player"), [900, 15, -4]);
  assert.deepEqual(call("UnitAttackSpeed", seam, "player"), [2, undefined]);
  assert.deepEqual(call("GetCVarBool", seam, "framexml_unknown_cvar"), []);
  assert.deepEqual(call("GetCVarBool", seam, "showAllSpellRanks"), [false]);
  assert.deepEqual(call("UnitDamage", seam, "player"), [50, 75, 0, 0, 0, 0, 1.25]);
  fired.length = 0;
  playerFields.set(UPDATE_FIELDS.UNIT_FIELD_STAT0.offset, 124);
  seam.tick(0.1);
  assert.deepEqual(fired.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.stats), [
    [FRAMEXML_SEAM_EVENTS.stats, "player"],
  ]);
  seam.tick(0.11);
  assert.deepEqual(fired.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.stats), [
    [FRAMEXML_SEAM_EVENTS.stats, "player"],
  ], "sub-60ms poll does not duplicate stats events");
  seam.detach();
});
