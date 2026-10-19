import assert from "node:assert/strict";
import test from "node:test";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { cooldownEventPacket, initialSpellsPacket, settle, spellGoPacket, travelClient } from "./fixtures/world-packets.mjs";

// Plan item 3.39, the stock interface's side (12.10). Wow.exe 3.3.5a 12340 (read-only Ghidra, 2026-10-12):
// GetSpellCooldown (0x00540e80 → 0x00809000), GetItemCooldown (0x00510fc0 → 0x00809030) and GetContainerItemCooldown
// (0x005d7d90 → 0x008090c0) all answer from 0x00807980 — a sibling's category part with the part's own start, an
// item asked under its own category for its spell, and a held entry with `enable` 0 (start now, the held part's
// length: 1 ms for the own entry, the category recovery for its category part). UseContainerItem (0x005d8650 →
// 0x00708c20 → 0x0080da40 → 0x0080cce0) refuses a recovering or held item in 0x00739650 before any packet, with
// SPELL_FAILED_ITEM_NOT_READY (45), whose error-frame words 0x00807f10 picks by the spell row's Category: 4 and 9
// ERR_POTION_COOLDOWN, 10 and 11 ERR_FOOD_COOLDOWN, else ERR_ITEM_COOLDOWN.

const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS, FRAMEXML_SEAM_EVENTS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { FRAMEXML_COMPANION_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlCompanions.js");
const { ACTION_BUTTON_ITEM, ACTION_BUTTON_SPELL } = await import("../dist/code/world/ActionBarProtocol.js");
const { globalString } = await import("../dist/code/generated/globalStrings.js");
const { itemUseSpellCategory } = await import("../dist/code/world/SpellCooldownParts.js");
const { SPELL_FAILED_ITEM_NOT_READY, itemCooldownErrorName, itemUseCooldownBlock } =
  await import("../dist/code/browser/game/ItemUseCooldown.js");
const { game } = await import("../dist/code/browser/game/Context.js");

const call = (seam, name, ...args) => [...FRAMEXML_SEAM_BINDINGS[name](seam, args)];
const companions = (seam, name, ...args) => [...FRAMEXML_COMPANION_BINDINGS[name](seam, args)];
const words = (name) => globalString(name) ?? name;

const SELF = 0x10n;
const row = (category, recoveryTime, categoryRecoveryTime, cooldownStartedOnEvent = false, extra = {}) =>
  ({ category, recoveryTime, categoryRecoveryTime, cooldownStartedOnEvent, ...extra });
/** The dataset's Spell.dbc values (spell-category-cooldown.test.mjs), and two trinket-like rows of Category 0. */
const ROWS = new Map([
  [71, row(47, 0, 1000)], // Оборонительная стойка
  [2457, row(47, 0, 1000)], // Боевая стойка
  [2458, row(47, 0, 1000)], // Стойка берсерка
  [17534, row(4, 0, 10_000, true)], // the healing potion of 13446
  [17531, row(4, 0, 60_000, true)], // the mana potion of 13444
  [8690, row(1176, 0, 1_800_000, false, { startRecoveryCategory: 133, startRecoveryTime: 1500 })], // Камень возвращения
  [90010, row(0, 0, 0)],
  [90011, row(0, 0, 0)],
]);
const metadata = (id) => ROWS.has(id)
  ? { id, name: `spell ${id}`, rank: "", iconPath: "", passive: false, hidden: false, startRecoveryTime: 0, ...ROWS.get(id) }
  : undefined;
/** 3.47: two mounts sharing a category of 1.5 s (synthetic), for GetCompanionCooldown. */
const EXTRA_ROWS = new Map([[458, row(330, 0, 1500)], [470, row(330, 0, 1500)]]);
/** 3.47: the stances as a stance bar lists them (SPELL_AURA_MOD_SHAPESHIFT 36 and its form), and the two mounts (78). */
const FORM_OF = new Map([[2457, 17], [71, 18], [2458, 19]]);
const formsAndMounts = (id) => {
  const base = metadata(id);
  if (base !== undefined && FORM_OF.has(id)) {
    return { ...base, iconPath: `Interface\\Icons\\stance${id}`, stanceBarOrder: FORM_OF.get(id), spellLevel: 1,
      effectAura: [36, 0, 0], effectMiscValue: [FORM_OF.get(id), 0, 0] };
  }
  if (!EXTRA_ROWS.has(id)) return base;
  return { id, name: `mount ${id}`, rank: "", iconPath: `Interface\\Icons\\mount${id}`, passive: false, hidden: false,
    startRecoveryTime: 0, effects: [6, 0, 0], effectAura: [78, 0, 0], effectMiscValue: [284, 0, 0], ...EXTRA_ROWS.get(id) };
};

const POTION_A = 0x4000_0000_0000_0a01n;
const POTION_B = 0x4000_0000_0000_0a02n;
const STONE = 0x4000_0000_0000_0a03n;
const TRINKET_X = 0x4000_0000_0000_0a04n;
const TRINKET_Y = 0x4000_0000_0000_0a05n;
const itemSpell = (spellId, cooldown, category, categoryCooldown) =>
  ({ spellId, trigger: 0, charges: 1, cooldown, category, categoryCooldown });
const template = (entry, spells) => ({ entry, found: true, flags: 0, bonding: 0, inventoryType: 0, spells });
const TEMPLATES = [
  [POTION_A, template(13446, [itemSpell(17534, -1, 4, 60_000)])],
  [POTION_B, template(13444, [itemSpell(17531, -1, 4, 60_000)])],
  [STONE, template(6948, [itemSpell(8690, -1, 0, -1)])],
  // Two items sharing their own category 1141 (20 s) over spell rows of Category 0.
  [TRINKET_X, template(90020, [itemSpell(90010, -1, 1141, 20_000)])],
  [TRINKET_Y, template(90021, [itemSpell(90011, -1, 1141, 20_000)])],
];

/** The stances known, the five items in backpack slots 1-5 (wire 255/23-27), the rows registered as EnterWorld does. */
async function world(spell = metadata, spells = [71, 2457, 2458]) {
  const { client, connection } = await travelClient([
    { opcode: OPCODES.SMSG_INITIAL_SPELLS, payload: initialSpellsPacket({ spells }) },
  ], SELF);
  client.spellCooldownRow = (spellId) => ROWS.get(spellId) ?? EXTRA_ROWS.get(spellId);
  const player = client.state.objects.get(SELF);
  TEMPLATES.forEach(([guid, item], index) => {
    const offset = UPDATE_FIELDS.PLAYER_FIELD_PACK_SLOT_1.offset + index * 2;
    player.fields.set(offset, Number(guid & 0xffff_ffffn));
    player.fields.set(offset + 1, Number(guid >> 32n));
    client.state.objects.set(guid, { guid, typeId: 1, fields: new Map([[UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, item.entry]]) });
    client.itemTemplates.set(item.entry, item);
  });
  client.actionButtons = [
    { slot: 0, action: 2457, type: ACTION_BUTTON_SPELL },
    { slot: 1, action: 13444, type: ACTION_BUTTON_ITEM },
  ];
  // The stock clock: Lua seconds beside the world's performance.now() milliseconds.
  const clock = { monotonic: performance.now(), lua: 500 };
  const fired = [];
  const seam = new LiveWorldSeam({
    world: () => client, store: () => undefined, spell,
    monotonic: () => clock.monotonic, globalCooldownUntil: () => 0, castSpell: () => {},
  });
  seam.attach({ now: () => clock.lua, fire: (name, ...args) => { fired.push([name, ...args]); return 1; } });
  /** Lua's clock catches up with the world's (after a packet), the second moved by as much. */
  const now = () => {
    const moved = performance.now() - clock.monotonic;
    clock.monotonic += moved;
    clock.lua += moved / 1000;
  };
  const go = async (spellId, casterItem) => {
    const opcode = casterItem === undefined ? OPCODES.CMSG_CAST_SPELL : OPCODES.CMSG_USE_ITEM;
    const request = connection.sentOf(opcode).at(-1);
    const castId = opcode === OPCODES.CMSG_USE_ITEM ? request.payload[2] : request.payload[0];
    connection.push(OPCODES.SMSG_SPELL_GO, spellGoPacket({ caster: casterItem ?? SELF, casterUnit: SELF, castId, spellId }));
    await settle();
    now();
  };
  return { client, connection, seam, clock, fired, now, go };
}

/** `answer` started `startedAt` (world ms) and runs `duration` seconds, `enable` as given: within float noise. */
function assertSweep(answer, expected, message) {
  assert.equal(answer.length, 3, message);
  for (let index = 0; index < 3; index++) {
    assert.ok(Math.abs(answer[index] - expected[index]) < 1e-6, `${message}: ${answer} vs ${expected}`);
  }
}

test("a sibling's category part sweeps in the stock book and bar with the part's own start", async () => {
  const { client, seam, clock, go } = await world();
  try {
    client.castSpell(71);
    await go(71);
    const part = client.cooldownState(2457);
    assert.equal(part?.duration, 1000, "the stance's category 47 holds Боевая стойка");
    const start = clock.lua - (clock.monotonic - part.startedAt) / 1000;
    // GetSpellCooldown by spell id (a book slot past the book's three answers the known spell) and GetActionCooldown.
    assertSweep(call(seam, "GetSpellCooldown", 2457, "spell"), [start, 1, 1], "the book sweeps the sibling's part");
    assertSweep(call(seam, "GetActionCooldown", 1), [start, 1, 1], "and the bar");
    // A tenth of a second on, the same start: the sweep runs on, it does not start over.
    clock.monotonic += 100;
    clock.lua += 0.1;
    assertSweep(call(seam, "GetSpellCooldown", 2457, "spell"), [start, 1, 1], "the start stays put");
    assertSweep(call(seam, "GetSpellCooldown", 2458, "spell"), [start, 1, 1], "the third stance too");
  } finally {
    seam.detach();
    client.close();
  }
});

test("a potion drunk in combat: both potions answer held (enable 0, the category's minute), greyed and not usable", async () => {
  const { client, connection, seam, clock, fired, now, go } = await world();
  try {
    seam.tick(clock.lua);
    fired.length = 0;
    client.useItem(255, 23, POTION_A);
    await go(17534, POTION_A);
    assert.equal(client.isSpellOnHold(17531), true, "held by category 4 until the event");
    // The seam's poll (60 ms) after the hold: BAG_UPDATE_COOLDOWN, so ContainerFrame asks again.
    clock.monotonic += 100;
    clock.lua += 0.1;
    seam.tick(clock.lua);
    assert.ok(fired.some(([name]) => name === FRAMEXML_SEAM_EVENTS.bagUpdateCooldown), "the bags hear the hold");
    // ContainerFrame_UpdateCooldown greys an answer with a length and `enable` 0; CooldownFrame_SetTimer draws nothing.
    assert.deepEqual(call(seam, "GetContainerItemCooldown", 0, 2), [clock.lua, 60, 0], "the other potion");
    assert.deepEqual(call(seam, "GetContainerItemCooldown", 0, 1), [clock.lua, 60, 0],
      "the potion drunk: its category part (60 s) ends after its own held entry (1 ms)");
    assert.deepEqual(call(seam, "GetItemCooldown", 13444), [clock.lua, 60, 0]);
    assert.deepEqual(call(seam, "IsUsableAction", 2), [false, false], "the bar's potion is grey");

    // Out of combat the event starts the minute: the other potion sweeps the category part, from its own start.
    connection.push(OPCODES.SMSG_COOLDOWN_EVENT, cooldownEventPacket(17534, SELF));
    await settle();
    now();
    const part = client.cooldownState(17531, 4);
    assert.equal(part?.duration, 60_000);
    const start = clock.lua - (clock.monotonic - part.startedAt) / 1000;
    assertSweep(call(seam, "GetContainerItemCooldown", 0, 2), [start, 60, 1], "the sibling's sweep");
    clock.monotonic += 250;
    clock.lua += 0.25;
    assertSweep(call(seam, "GetContainerItemCooldown", 0, 2), [start, 60, 1], "the same start a moment later");
    // 19.10: recovering is not held: white under the sweep (UpdateUsableAction 0x005a9e20 asks the hold only, 0x0080ac10).
    assert.deepEqual(call(seam, "IsUsableAction", 2), [true, false], "recovering");
  } finally {
    seam.detach();
    client.close();
  }
});

test("an item is asked under its own category for its spell (0x00809030), not its spell row's", async () => {
  const { client, seam, clock, go } = await world();
  try {
    assert.equal(itemUseSpellCategory(TEMPLATES[4][1], 90011), 1141);
    assert.equal(itemUseSpellCategory(TEMPLATES[2][1], 8690), undefined, "a category below 1 leaves the row's");
    client.useItem(255, 26, TRINKET_X);
    await go(90010, TRINKET_X);
    const part = client.cooldownState(90011, 1141);
    assert.equal(part?.duration, 20_000, "the GO filed the item's category 1141");
    assert.equal(client.cooldownRemaining(90011), 0, "the spell row (Category 0) alone is not held");
    const start = clock.lua - (clock.monotonic - part.startedAt) / 1000;
    assertSweep(call(seam, "GetContainerItemCooldown", 0, 5), [start, 20, 1], "the other item of category 1141");
  } finally {
    seam.detach();
    client.close();
  }
});

test("a bag click on a recovering or held item is refused at home with Wow.exe's words, and no packet", async () => {
  const { client, connection, seam, go } = await world();
  const saved = { world: game.world, spells: game.spells, gcd: game.globalCooldownUntil, client: game.spellMetadataClient };
  const statuses = [];
  const refusals = [];
  client.onSpellStatus = (text, error) => statuses.push([text, error]);
  client.events.on("SPELL_CAST_REFUSED_LOCAL", (event) => refusals.push(event));
  try {
    game.world = client;
    game.spells = new Map([...ROWS.keys()].map((id) => [id, metadata(id)]));
    game.globalCooldownUntil = 0;
    game.spellMetadataClient = undefined;
    const uses = () => connection.sentOf(OPCODES.CMSG_USE_ITEM).length;
    // A ready potion goes out (the control).
    call(seam, "UseContainerItem", 0, 1);
    assert.equal(uses(), 1, "UseContainerItem sends CMSG_USE_ITEM for a ready potion");
    await go(17534, POTION_A);
    // Held: the other potion's right click stays at home.
    call(seam, "UseContainerItem", 0, 2);
    assert.equal(uses(), 1, "no CMSG_USE_ITEM for the held potion");
    assert.deepEqual(statuses, [[words("ERR_POTION_COOLDOWN"), true]], "0x00807f10: Category 4 is the potion's words");
    assert.deepEqual(refusals.map(({ spellId, result }) => [spellId, result]), [[17531, SPELL_FAILED_ITEM_NOT_READY]],
      "the combat log's SPELL_CAST_FAILED");
    // Again at once: still refused, the error frame quiet (0x00808200's repeat rule: the same spell and result
    // within 3 s); the potion drunk is held as well, and its own refusal is said.
    call(seam, "UseContainerItem", 0, 2);
    assert.equal(uses(), 1);
    assert.equal(statuses.length, 1, "the same refusal again within 3 s says nothing");
    assert.equal(refusals.length, 2, "the combat log keeps its own rule (FrameXmlCombatLogLive.localRefusal)");
    call(seam, "UseContainerItem", 0, 1);
    assert.equal(uses(), 1);
    assert.deepEqual(statuses.at(-1), [words("ERR_POTION_COOLDOWN"), true]);
    // A recovering hearthstone: the item's own words.
    client.useItem(255, 25, STONE);
    await go(8690, STONE);
    assert.equal(uses(), 2);
    call(seam, "UseContainerItem", 0, 3);
    assert.equal(uses(), 2, "no CMSG_USE_ITEM for the recovering hearthstone");
    assert.deepEqual(statuses.at(-1), [words("ERR_ITEM_COOLDOWN"), true], "Category 1176: ERR_ITEM_COOLDOWN");
    // An item whose row is on the global cooldown that runs (0x00807980's global branch): refused too.
    game.spells.set(90011, { ...metadata(90011), startRecoveryCategory: 133, startRecoveryTime: 1500 });
    game.globalCooldownUntil = performance.now() + 1500;
    call(seam, "UseContainerItem", 0, 5);
    assert.equal(uses(), 2, "no CMSG_USE_ITEM inside the global cooldown");
    assert.deepEqual(statuses.at(-1), [words("ERR_ITEM_COOLDOWN"), true]);
    game.globalCooldownUntil = 0;
    call(seam, "UseContainerItem", 0, 5);
    assert.equal(uses(), 3, "after it, the use goes out");
  } finally {
    game.world = saved.world;
    game.spells = saved.spells;
    game.globalCooldownUntil = saved.gcd;
    game.spellMetadataClient = saved.client;
    seam.detach();
    client.close();
  }
});

test("a row still on its way is fetched first, so the refusal's words follow its Category", async () => {
  const { client, connection, seam, go } = await world();
  const saved = { world: game.world, spells: game.spells, gcd: game.globalCooldownUntil, client: game.spellMetadataClient };
  const statuses = [];
  client.onSpellStatus = (text, error) => statuses.push([text, error]);
  try {
    // A potion drunk before the rows arrived (a fresh login): EnterWorld's row source is the page's map.
    game.world = client;
    game.spells = new Map();
    game.globalCooldownUntil = 0;
    client.spellCooldownRow = (spellId) => game.spells.get(spellId);
    const asked = [];
    game.spellMetadataClient = { load: async (ids) => { asked.push(...ids); return new Map(ids.map((id) => [id, metadata(id)])); } };
    client.useItem(255, 23, POTION_A);
    await go(17534, POTION_A);
    assert.ok(client.cooldownRemaining(17531, performance.now(), 4) > 59_000, "category 4 holds the other potion");
    const uses = connection.sentOf(OPCODES.CMSG_USE_ITEM).length;
    call(seam, "UseContainerItem", 0, 2);
    await settle();
    assert.deepEqual(asked, [17531], "the row is asked for");
    assert.equal(connection.sentOf(OPCODES.CMSG_USE_ITEM).length, uses, "and the use refused after it");
    assert.deepEqual(statuses, [[words("ERR_POTION_COOLDOWN"), true]], "with the potion's words, not the item's");
  } finally {
    game.world = saved.world;
    game.spells = saved.spells;
    game.globalCooldownUntil = saved.gcd;
    game.spellMetadataClient = saved.client;
    seam.detach();
    client.close();
  }
});

test("the refusal's words and reasons, as 0x00807f10 and 0x00739650 choose them", () => {
  assert.deepEqual([4, 9, 10, 11, 0, 1176, undefined].map(itemCooldownErrorName), [
    "ERR_POTION_COOLDOWN", "ERR_POTION_COOLDOWN", "ERR_FOOD_COOLDOWN", "ERR_FOOD_COOLDOWN",
    "ERR_ITEM_COOLDOWN", "ERR_ITEM_COOLDOWN", "ERR_ITEM_COOLDOWN",
  ]);
  const spells = [{ spellId: 7, category: 30 }];
  const asked = [];
  const world = {
    itemCooldownRemaining: () => 0,
    cooldownRemaining: (id, now, category) => { asked.push(category); return 0; },
    isSpellOnHold: () => false,
  };
  assert.equal(itemUseCooldownBlock(world, { spells }, 7, 1000), undefined);
  assert.deepEqual(asked, [30], "asked under the item's category");
  assert.equal(itemUseCooldownBlock(world, { spells }, 7, 1000, 1500), "cooldown", "a running global part refuses it too");
  assert.equal(itemUseCooldownBlock({ ...world, isSpellOnHold: () => true }, { spells }, 7, 1000), "hold");
  assert.equal(itemUseCooldownBlock({ ...world, itemCooldownRemaining: () => 5 }, { spells }, 7, 1000), "cooldown",
    "the item's equip cooldown");
});

// Plan item 3.47 (12.10): 0x00807980 sets `enable` 1 before it looks, so whatever a reader asks it about answers
// 0, 0, 1 when ready: GetItemCooldown (0x00510fc0) of a carried item (0x005a86b0 → 0x008090c0) or of one whose record
// has an on-use spell (0x00809030: spell > 0, trigger 0), GetContainerItemCooldown (0x005d7d90) of an occupied slot,
// GetActionCooldown's spell and item slots (0x005a8e40). A reader that asks nothing keeps 0, 0, 0.
test("3.47: a ready spell or item answers enable 1 wherever Wow.exe asks 0x00807980; an unasked one 0, 0, 0", async () => {
  const { client, seam } = await world();
  try {
    // An item record not carried with an on-use spell, and one whose only spell teaches (trigger 6).
    client.itemTemplates.set(90030, template(90030, [itemSpell(90010, -1, 0, -1)]));
    client.itemTemplates.set(90031, template(90031, [{ ...itemSpell(90011, -1, 0, -1), trigger: 6 }]));
    assert.deepEqual(call(seam, "GetItemCooldown", 13444), [0, 0, 1], "a carried potion");
    assert.deepEqual(call(seam, "GetItemCooldown", 90030), [0, 0, 1], "not carried, an on-use spell in its record");
    assert.deepEqual(call(seam, "GetItemCooldown", 90031), [0, 0, 0], "not carried, no on-use spell: nothing is asked");
    assert.deepEqual(call(seam, "GetItemCooldown", 77777), [0, 0, 0], "an item nobody knows");
    assert.deepEqual(call(seam, "GetContainerItemCooldown", 0, 3), [0, 0, 1], "the hearthstone's slot");
    assert.deepEqual(call(seam, "GetContainerItemCooldown", 0, 9), [0, 0, 0], "an empty slot");
    assert.deepEqual(call(seam, "GetActionCooldown", 1), [0, 0, 1], "a ready stance on the bar");
    assert.deepEqual(call(seam, "GetActionCooldown", 2), [0, 0, 1], "a ready potion on the bar");
    assert.deepEqual(call(seam, "GetActionCooldown", 3), [0, 0, 0], "an empty slot");
  } finally {
    seam.detach();
    client.close();
  }
});

// Plan item 3.47 (12.10): GetShapeshiftFormCooldown (0x0053c180) and GetCompanionCooldown (0x0053e490) ask
// 0x00809000 like GetSpellCooldown — a sibling's category part with the part's own start, a ready spell 0, 0, 1 —
// where they read the bare snapshot before (a sweep restarting at every call, a ready one 0, 0, 0). An index past
// the stance bar answers 0, 0, 1; one past the mounts nothing (stock guards for it).
test("3.47: the stance bar and the mounts read their cooldowns through cooldownState", async () => {
  const { client, seam, clock, go } = await world(formsAndMounts, [71, 2457, 2458, 458, 470]);
  try {
    seam.tick(clock.lua);
    assert.equal(call(seam, "GetNumShapeshiftForms")[0], 3, "three stances on the bar");
    assert.deepEqual(call(seam, "GetShapeshiftFormCooldown", 1), [0, 0, 1], "ready");
    assert.deepEqual(call(seam, "GetShapeshiftFormCooldown", 4), [0, 0, 1], "past the bar");
    client.castSpell(71);
    await go(71);
    const part = client.cooldownState(2457);
    const start = clock.lua - (clock.monotonic - part.startedAt) / 1000;
    assertSweep(call(seam, "GetShapeshiftFormCooldown", 1), [start, 1, 1], "Боевая стойка sweeps the category part");
    clock.monotonic += 100;
    clock.lua += 0.1;
    assertSweep(call(seam, "GetShapeshiftFormCooldown", 1), [start, 1, 1], "from the part's own start");

    assert.equal(companions(seam, "GetNumCompanions", "MOUNT")[0], 2, "two mounts");
    const mountIndex = (spellId) => [1, 2].find((index) => companions(seam, "GetCompanionInfo", "MOUNT", index)[2] === spellId);
    assert.deepEqual(companions(seam, "GetCompanionCooldown", "MOUNT", mountIndex(470)), [0, 0, 1], "a ready mount");
    client.castSpell(458);
    await go(458);
    const mount = client.cooldownState(470);
    assert.equal(mount?.duration, 1500, "the sibling's category part");
    const mountStart = clock.lua - (clock.monotonic - mount.startedAt) / 1000;
    assertSweep(companions(seam, "GetCompanionCooldown", "MOUNT", mountIndex(470)), [mountStart, 1.5, 1],
      "the other mount sweeps it");
    assert.deepEqual(companions(seam, "GetCompanionCooldown", "MOUNT", 3), [], "past the list: nothing");
  } finally {
    seam.detach();
    client.close();
  }
});
