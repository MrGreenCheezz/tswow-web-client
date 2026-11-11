import assert from "node:assert/strict";
import test from "node:test";

// 11.10: the owner's rogue had a blue «Мана» bar under the energy bar that moved like energy.
// Stock AlternatePowerBar.lua:57-62 shows PlayerFrameAlternateManaBar while
// `UnitPowerType(unit) ~= 0 and UnitPowerMax(unit, 0) ~= 0` and fills it with UnitPower(unit, 0);
// the seam ignored the type and answered the energy. Wow.exe 0x0060ed40/0x0060ef40 read it
// (FrameXmlUnitPower.ts).

const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");

const POWER = UPDATE_FIELDS.UNIT_FIELD_POWER1.offset;
const MAXPOWER = UPDATE_FIELDS.UNIT_FIELD_MAXPOWER1.offset;

/** A unit object: race, class and displayed power in UNIT_FIELD_BYTES_0, then `power → [value, max]`. */
function unit(guid, typeId, race, classId, shown, powers) {
  const fields = new Map([[UPDATE_FIELDS.UNIT_FIELD_BYTES_0.offset, (race | (classId << 8) | (shown << 24)) >>> 0]]);
  for (const [power, [value, maximum]] of Object.entries(powers)) {
    fields.set(POWER + Number(power), value);
    fields.set(MAXPOWER + Number(power), maximum);
  }
  return { guid, typeId, fields };
}

function seamFor(player, others = [], extra = {}) {
  const objects = new Map([[player.guid, player], ...others.map((object) => [object.guid, object])]);
  const world = {
    state: { selfGuid: player.guid, objects },
    actionButtons: [], casts: new Map(), channels: new Map(), events: { on: () => () => {} },
    itemTemplates: new Map(), cooldownRemaining: () => 0, names: new Map(), creatureTemplates: new Map(),
    partyStats: new Map(), knownSpells: [], ...extra,
  };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: () => undefined,
    monotonic: () => 0, globalCooldownUntil: () => 0, castSpell: () => {},
  });
  return (name, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);
}

test("11.10 UnitPowerMax(unit, 0) of a rogue is its mana maximum, 0 — the alternate mana bar stays hidden", () => {
  // Night elf rogue: energy 80 of 100 shown, UNIT_FIELD_MAXPOWER1 0 as Player::UpdateMaxPower leaves it.
  const call = seamFor(unit(1n, 4, 4, 4, 3, { 0: [0, 0], 3: [80, 100] }));
  assert.deepEqual(call("UnitPowerType", "player"), [3, "ENERGY"]);
  assert.deepEqual(call("UnitPower", "player"), [80]);
  assert.deepEqual(call("UnitPowerMax", "player"), [100]);
  assert.deepEqual(call("UnitPowerMax", "player", 0), [0], "AlternatePowerBar.lua:62 hides the bar on this 0");
  assert.deepEqual(call("UnitPower", "player", 0), [0]);
  assert.deepEqual(call("UnitPower", "player", 3), [80]);
  // lua_isnumber: a numeric string is a type, anything else is the displayed power.
  assert.deepEqual(call("UnitPower", "player", "3"), [80]);
  assert.deepEqual(call("UnitPowerMax", "player", "MANA"), [100]);
  assert.deepEqual(call("UnitPower", "player", 7), [80], "7 is the displayed power");
  // Outside 0..7 both answer a bare 0 before looking at the unit.
  assert.deepEqual(call("UnitPower", "player", 8), [0]);
  assert.deepEqual(call("UnitPowerMax", "player", -1), [0]);
  // UnitMana/UnitManaMax are the same two functions in Wow.exe (.data 0x00ad2308/0x00ad2310).
  assert.deepEqual(call("UnitManaMax", "player", 0), [0]);
  assert.deepEqual(call("UnitMana", "player"), [80]);
});

test("11.10 the active player's other powers are answered, anyone else's are 0; rage reads in tenths", () => {
  // A tauren druid in cat form: energy shown, its mana kept beside it (what the alternate bar shows).
  const druid = unit(1n, 4, 6, 11, 3, { 0: [3000, 5000], 3: [60, 100] });
  // A warrior target with the same mana words set: 0x004cee50 is false for it.
  const warrior = unit(2n, 4, 1, 1, 1, { 0: [700, 900], 1: [450, 1000] });
  const call = seamFor(druid, [warrior], { targetGuid: 2n });
  assert.deepEqual(call("UnitPowerMax", "player", 0), [5000]);
  assert.deepEqual(call("UnitPower", "player", 0), [3000]);
  assert.deepEqual(call("UnitPower", "player"), [60]);
  assert.deepEqual(call("UnitPower", "target"), [45], "0x007fde00: rage is kept in tenths");
  assert.deepEqual(call("UnitPowerMax", "target"), [100]);
  assert.deepEqual(call("UnitPower", "target", 0), [0], "not the active player: only its displayed power");
  assert.deepEqual(call("UnitPowerMax", "target", 0), [900], "UnitPowerMax has no such check");
});

test("11.10 a group member out of view answers its cached power for its own type only", () => {
  const player = unit(1n, 4, 1, 1, 1, { 1: [0, 1000] });
  const call = seamFor(player, [], {
    group: { groupType: 0, members: [{ name: "Альфа", guid: 0x21n, online: true, status: 1, subGroup: 0, flags: 0, roles: 0 }] },
    partyStats: new Map([[0x21n, { guid: 0x21n, flags: 0, powerType: 6, power: 400, maxPower: 1300 }]]),
  });
  assert.deepEqual(call("UnitPower", "party1"), [40], "runic power in tenths");
  assert.deepEqual(call("UnitPowerMax", "party1", 6), [130]);
  assert.deepEqual(call("UnitPower", "party1", 0), [0]);
  assert.deepEqual(call("UnitPowerMax", "party1", 0), [0]);
});

test("3.41 a dead unit's power is 0 unless it is the player's, a group member's or one of their pets (0x0060ed40, 0x00512a30)", () => {
  const DYNAMIC = UPDATE_FIELDS.UNIT_DYNAMIC_FLAGS.offset;
  const SUMMON = UPDATE_FIELDS.UNIT_FIELD_SUMMON.offset;
  const dead = (object) => { object.fields.set(DYNAMIC, 0x20); return object; };
  const player = dead(unit(1n, 4, 1, 8, 0, { 0: [500, 1000] }));
  player.fields.set(SUMMON, 0x31);
  const enemy = dead(unit(2n, 3, 0, 1, 0, { 0: [700, 900] }));
  const pet = dead(unit(0x31n, 3, 0, 1, 2, { 2: [40, 100] }));
  const member = dead(unit(0x21n, 4, 1, 2, 0, { 0: [300, 600] }));
  // The out-of-view member's pet, known from the group cache only (0x0052d310's cached branch).
  const memberPet = dead(unit(0x41n, 3, 0, 1, 0, { 0: [80, 200] }));
  const group = { groupType: 0, members: [{ name: "Альфа", guid: 0x51n, online: true, status: 1, subGroup: 0, flags: 0, roles: 0 }] };
  const partyStats = new Map([[0x51n, { guid: 0x51n, flags: 0, petGuid: 0x41n }]]);
  const target = (guid) => seamFor(player, [enemy, pet, member, memberPet], { targetGuid: guid, group, partyStats });
  assert.deepEqual(target(2n)("UnitPower", "target"), [0], "a dead stranger: 0");
  assert.deepEqual(target(2n)("UnitPowerMax", "target"), [900], "UnitPowerMax (0x0060ef40) has no such check");
  assert.deepEqual(target(2n)("UnitPower", "player"), [500], "the player keeps it");
  assert.deepEqual(target(0x31n)("UnitPower", "target"), [40], "the player's summon keeps it");
  assert.deepEqual(target(0x41n)("UnitPower", "target"), [80], "a group member's cached pet keeps it");
  assert.deepEqual(target(0x21n)("UnitPower", "target"), [0], "not in the group: 0");
  enemy.fields.delete(DYNAMIC);
  assert.deepEqual(target(2n)("UnitPower", "target"), [700], "alive: answered as before");
});

// The symptom itself, through the client's own AlternatePowerBar.lua and PlayerFrame.
let clientDirectory;
try {
  clientDirectory = (await import("../tools/paths.mjs")).clientDirectory();
} catch {
  clientDirectory = undefined;
}

test("11.10 stock PlayerFrameAlternateManaBar: hidden for a rogue, the druid's mana in cat form", {
  skip: clientDirectory ? false : "no 3.3.5a client on this machine",
}, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
  const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
  const chain = await clientArchives(clientDirectory);
  const decoder = new TextDecoder("utf-8");
  const provider = { async read(path) { const data = await chain.read(path); return data ? decoder.decode(data) : undefined; } };
  const bar = async (player) => {
    const objects = new Map([[player.guid, player]]);
    const world = {
      state: { selfGuid: player.guid, objects },
      actionButtons: [], casts: new Map(), channels: new Map(), events: { on: () => () => {} },
      itemTemplates: new Map(), cooldownRemaining: () => 0, names: new Map(), creatureTemplates: new Map(),
      partyStats: new Map(), knownSpells: [],
    };
    const seam = new LiveWorldSeam({
      world: () => world, store: () => undefined, spell: () => undefined,
      monotonic: () => 0, globalCooldownUntil: () => 0, castSpell: () => {},
    });
    const boot = new FrameXmlBoot({
      provider, locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam, screen: () => ({ width: 1024, height: 768 }),
    });
    try {
      await boot.load(); // the session exercise raises PLAYER_ENTERING_WORLD (AlternatePowerBar.lua:33)
      boot.tickSeam(1);
      const chunk = boot.vm.compileFunction(
        "local b = PlayerFrameAlternateManaBar local _, max = b:GetMinMaxValues() return b:IsShown(), b:GetValue(), max",
        "@alternate-mana", []);
      try { return boot.vm.call(chunk, [], 3); } finally { boot.vm.release(chunk); }
    } finally {
      boot.close();
    }
  };
  try {
    const [rogueShown] = await bar(unit(1n, 4, 4, 4, 3, { 0: [0, 0], 3: [80, 100] }));
    assert.equal(rogueShown, false, "no mana: no mana bar");
    assert.deepEqual(await bar(unit(1n, 4, 6, 11, 3, { 0: [3000, 5000], 3: [60, 100] })), [true, 3000, 5000]);
  } finally {
    chain.close();
  }
});
