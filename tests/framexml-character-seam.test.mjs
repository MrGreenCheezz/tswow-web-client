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

test("stock paper-doll item actions accept the one-argument inventory slot signature", () => {
  const actions = [];
  const seam = {
    useInventoryItem: (...args) => actions.push(["use", ...args]),
    pickupInventoryItem: (...args) => actions.push(["pickup", ...args]),
  };
  assert.deepEqual(call("UseInventoryItem", seam, 13), []);
  assert.deepEqual(call("PickupInventoryItem", seam, 16), []);
  assert.deepEqual(actions, [["use", "player", 13], ["pickup", "player", 16]],
    "PaperDollFrame.lua passes self:GetID(), without a unit argument");
});

test("stock UseInventoryItem resolves the current equipped GUID through the live use bridge", () => {
  const selfGuid = 0x101n;
  const itemGuid = 0x202n;
  const fields = new Map([
    [UPDATE_FIELDS.PLAYER_FIELD_INV_SLOT_HEAD.offset, Number(itemGuid)],
    [UPDATE_FIELDS.PLAYER_FIELD_INV_SLOT_HEAD.offset + 1, 0],
  ]);
  const used = [];
  const world = {
    state: { selfGuid, objects: new Map([
      [selfGuid, { guid: selfGuid, typeId: 4, fields }],
      [itemGuid, { guid: itemGuid, fields: new Map() }],
    ]) },
    useItem: (...args) => used.push(args),
  };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: () => undefined,
    monotonic: () => 0, globalCooldownUntil: () => 0, castSpell: () => {},
  });
  call("UseInventoryItem", seam, 1);
  assert.deepEqual(used, [[255, 0, itemGuid]]);
  for (const slot of [0, 2, 24, undefined]) call("UseInventoryItem", seam, slot);
  fields.set(UPDATE_FIELDS.PLAYER_FIELD_INV_SLOT_HEAD.offset, 0);
  call("UseInventoryItem", seam, 1);
  assert.equal(used.length, 1, "empty, invalid and removed equipment cannot send a use packet");
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
  assert.deepEqual(call("UnitStat", seam, "player", 1), [123, 123, 10, -3]);
  assert.deepEqual(call("UnitStat", seam, "player", 5), [0, 0, 0, 0]);
  assert.deepEqual(call("UnitStat", seam, "player", 0), [0, 0, 0, 0]);
  assert.deepEqual(call("UnitStat", seam, "player", 6), [0, 0, 0, 0]);
  assert.deepEqual(call("UnitArmor", seam, "player"), [480, 500, 480, 25, -5]);
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

test("live PaperDoll exposes replicated combat, spell and defense fields and refreshes their changes", () => {
  const selfGuid = 1n;
  const fields = new Map();
  const set = (name, value, index = 0) => fields.set(UPDATE_FIELDS[name].offset + index,
    UPDATE_FIELDS[name].type === "FLOAT" ? floatBits(value) : value >>> 0);
  set("UNIT_FIELD_LEVEL", 80);
  set("UNIT_FIELD_BYTES_0", 1 | (2 << 8));
  set("PLAYER_FIELD_COMBAT_RATING_1", 125, 1);
  set("PLAYER_FIELD_COMBAT_RATING_1", 125, 5);
  set("PLAYER_CRIT_PERCENTAGE", 12.5);
  set("PLAYER_RANGED_CRIT_PERCENTAGE", 13.25);
  set("PLAYER_EXPERTISE", 26);
  set("PLAYER_OFFHAND_EXPERTISE", 20);
  set("PLAYER_DODGE_PERCENTAGE", 18.5);
  set("PLAYER_PARRY_PERCENTAGE", 16.25);
  set("PLAYER_BLOCK_PERCENTAGE", 22.5);
  set("PLAYER_SHIELD_BLOCK", 750);
  set("PLAYER_SPELL_CRIT_PERCENTAGE1", 15.5, 1);
  set("PLAYER_FIELD_MOD_DAMAGE_DONE_POS", 450, 1);
  set("PLAYER_FIELD_MOD_DAMAGE_DONE_NEG", -20, 1);
  set("PLAYER_FIELD_MOD_HEALING_DONE_POS", 600);
  set("PLAYER_FIELD_MOD_TARGET_RESISTANCE", -55);
  set("UNIT_FIELD_POWER_REGEN_FLAT_MODIFIER", 80.5);
  set("UNIT_FIELD_POWER_REGEN_INTERRUPTED_FLAT_MODIFIER", 40.25);
  set("PLAYER_SKILL_INFO_1_1", 95);
  set("PLAYER_SKILL_INFO_1_1", 400 | (400 << 16), 1);
  set("PLAYER_SKILL_INFO_1_1", 15 | (5 << 16), 2);
  const world = {
    state: { selfGuid, objects: new Map([[selfGuid, { guid: selfGuid, typeId: 4, fields }]]) },
    actionButtons: [], casts: new Map(), channels: new Map(), events: { on: () => () => {} },
    itemTemplates: new Map(), cooldownRemaining: () => 0,
  };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: () => undefined,
    monotonic: () => 0, globalCooldownUntil: () => 0, castSpell: () => {},
    characterStats: () => ({ spellCritBase: [], spellCritPerIntellect: [],
      combatRatingPerLevel: Array(2500).fill(5), combatRatingScalar: { 34: 1.5, 38: 2 } }),
  });
  assert.deepEqual(call("GetCombatRating", seam, 6), [125]);
  assert.deepEqual(call("GetCombatRatingBonus", seam, 6), [50]);
  assert.deepEqual(call("GetCombatRatingBonus", seam, 2), [37.5]);
  for (const index of [0, 26, NaN]) assert.deepEqual(call("GetCombatRating", seam, index), [0]);
  assert.deepEqual(call("GetCritChance", seam), [12.5]);
  assert.deepEqual(call("GetRangedCritChance", seam), [13.25]);
  assert.deepEqual(call("GetExpertise", seam), [26, 20]);
  assert.deepEqual(call("GetExpertisePercent", seam), [6.5, 5]);
  assert.deepEqual(call("GetSpellCritChance", seam, 2), [15.5]);
  assert.deepEqual(call("GetSpellBonusDamage", seam, 2), [430]);
  assert.deepEqual(call("GetSpellBonusDamage", seam, 0), [0]);
  assert.deepEqual(call("GetSpellBonusHealing", seam), [600]);
  assert.deepEqual(call("GetSpellPenetration", seam), [55]);
  assert.deepEqual(call("GetManaRegen", seam), [80.5, 40.25]);
  assert.deepEqual(call("GetDodgeChance", seam), [18.5]);
  assert.deepEqual(call("GetParryChance", seam), [16.25]);
  assert.deepEqual(call("GetBlockChance", seam), [22.5]);
  assert.deepEqual(call("GetShieldBlock", seam), [750]);
  assert.deepEqual(call("UnitDefense", seam, "player"), [400, 57], "core truncates fractional defense rating bonus");
  assert.deepEqual(call("GetDodgeBlockParryChanceFromDefense", seam), [2.2800000000000002]);

  const fired = [];
  seam.attach({ fire: (event, ...args) => { fired.push([event, ...args]); return 1; }, now: () => 0 });
  fired.length = 0;
  set("PLAYER_CRIT_PERCENTAGE", 14);
  seam.tick(0.1);
  assert.deepEqual(fired.filter(([event]) => event === "UNIT_STATS"), [["UNIT_STATS", "player"]]);
  assert.deepEqual(call("GetCritChance", seam), [14]);
  seam.tick(0.2);
  assert.equal(fired.filter(([event]) => event === "UNIT_STATS").length, 1);
  seam.detach();
});
