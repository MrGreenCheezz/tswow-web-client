import assert from "node:assert/strict";
import test from "node:test";
import { installFakeUiDocument } from "./fixtures/fake-ui-document.mjs";
import { castFailedPacket, initialSpellsPacket, settle, spellGoPacket, travelClient } from "./fixtures/world-packets.mjs";

// The native bar and the book import `ui/Dom.ts`, which resolves its handles at import.
installFakeUiDocument();

// Plan item 3.47 (12.10): a refusal on cooldown is never silent. Wow.exe 3.3.5a 12340 (read-only Ghidra): the request
// builder 0x0080cce0 refuses a recovering, held or global-held spell in 0x00739650 with NOT_READY (67) and an item
// with ITEM_NOT_READY (45), before any packet, through 0x00808200 — which asks 0x00807f10 for the error frame's row
// (45: Category 4/9 ERR_POTION_COOLDOWN, 10/11 ERR_FOOD_COOLDOWN, else ERR_ITEM_COOLDOWN; 67: the same two, else
// ERR_ABILITY_COOLDOWN for SPELL_ATTR0_ABILITY, else ERR_SPELL_COOLDOWN), keeps it quiet for the same spell and
// result within 3 s, writes the combat log's SPELL_CAST_FAILED and ends in 0x007fecc0: UNIT_SPELLCAST_FAILED for the
// request object 0x00805010(1) made, with the cast count it drew. The realm's SMSG_CAST_FAILED (0x00809af0) goes
// through the same 0x00808200, so its NOT_READY says the same row, not SPELL_FAILED_NOT_READY's sentence.

const { OPCODES } = await import("../dist/code/generated/opcodes.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { globalString } = await import("../dist/code/generated/globalStrings.js");
const { cooldownRefusalErrorName, cooldownRefusalText, SPELL_FAILED_ITEM_NOT_READY } =
  await import("../dist/code/world/CooldownRefusalWords.js");
const { SPELL_FAILED_NOT_READY } = await import("../dist/code/world/AutoRepeatRefusal.js");
const { setPetSpellAttributesSource } = await import("../dist/code/world/PetCastSpell.js");
const { ACTION_BUTTON_ITEM, ACTION_BUTTON_SPELL } = await import("../dist/code/world/ActionBarProtocol.js");
const { game } = await import("../dist/code/browser/game/Context.js");
const { useSlot } = await import("../dist/code/browser/ui/ActionBar.js");
const { castSpell } = await import("../dist/code/browser/ui/Spellbook.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");

const words = (name) => globalString(name) ?? name;
const SELF = 0x10n;
const ABILITY = 0x10;
/** Synthetic rows: a spell, an ability (SPELL_ATTR0_ABILITY), a potion's spell (Category 4), a food's (Category 11). */
const spellRow = (id, columns = {}) => ({
  id, name: `spell ${id}`, rank: "", description: "", iconId: 0, iconPath: "", passive: false, hidden: false,
  powerType: 0, recoveryTime: 0, categoryRecoveryTime: 0, cooldownStartedOnEvent: false, category: 0,
  attributes: [0, 0, 0, 0, 0, 0, 0, 0], effectAura: [], effectMiscValue: [], schoolMask: 1, spellClassMask: [0, 0, 0],
  startRecoveryCategory: 0, startRecoveryTime: 0, ...columns,
});
const ROWS = new Map([
  [116, spellRow(116)],
  [1752, spellRow(1752, { attributes: [ABILITY, 0, 0, 0, 0, 0, 0, 0] })],
  [17531, spellRow(17531, { category: 4, categoryRecoveryTime: 60_000 })],
  [433, spellRow(433, { category: 11, recoveryTime: 0 })],
  // Two stances of category 47 (1 s): the second is held by the first's category part.
  [71, spellRow(71, { category: 47, categoryRecoveryTime: 1000 })],
  [2457, spellRow(2457, { category: 47, categoryRecoveryTime: 1000, attributes: [ABILITY, 0, 0, 0, 0, 0, 0, 0] })],
]);

test("3.47: 0x00807f10's rows for ITEM_NOT_READY and NOT_READY, by the spell row's Category and Attributes", () => {
  const spell = (category, attributes) => cooldownRefusalErrorName(SPELL_FAILED_NOT_READY, { category, attributes });
  assert.deepEqual([4, 9, 10, 11, 0, 47, undefined].map((category) => spell(category)), [
    "ERR_POTION_COOLDOWN", "ERR_POTION_COOLDOWN", "ERR_FOOD_COOLDOWN", "ERR_FOOD_COOLDOWN",
    "ERR_SPELL_COOLDOWN", "ERR_SPELL_COOLDOWN", "ERR_SPELL_COOLDOWN",
  ]);
  assert.equal(spell(0, [ABILITY]), "ERR_ABILITY_COOLDOWN", "(Attributes & 0x10 | 0x340) >> 4 = 0x35");
  assert.equal(spell(0, [0x40]), "ERR_SPELL_COOLDOWN", "another attribute bit is no ability");
  assert.equal(spell(4, [ABILITY]), "ERR_POTION_COOLDOWN", "the Category is asked first");
  assert.equal(cooldownRefusalErrorName(SPELL_FAILED_ITEM_NOT_READY, { category: 0, attributes: [ABILITY] }),
    "ERR_ITEM_COOLDOWN", "an item's refusal has no ability row");
  assert.equal(cooldownRefusalErrorName(SPELL_FAILED_ITEM_NOT_READY, { category: 10 }), "ERR_FOOD_COOLDOWN");
  assert.equal(cooldownRefusalErrorName(SPELL_FAILED_NOT_READY, undefined), "ERR_SPELL_COOLDOWN", "no row: a plain spell");
  assert.equal(cooldownRefusalErrorName(12, { category: 4 }), undefined, "any other result keeps its own words");
  assert.equal(cooldownRefusalText(SPELL_FAILED_NOT_READY, { category: 0 }), words("ERR_SPELL_COOLDOWN"));
  assert.notEqual(words("ERR_SPELL_COOLDOWN"), words("SPELL_FAILED_NOT_READY"));
});

/** A carried potion (entry 13444, its spell 17531) in backpack slot 1, the page's rows, a stub world for the native bar. */
function stubWorld({ cooling, held }) {
  const potion = 0x4000_0000_0000_0b01n;
  const player = { guid: SELF, typeId: 4, fields: new Map([
    [UPDATE_FIELDS.PLAYER_FIELD_PACK_SLOT_1.offset, Number(potion & 0xffff_ffffn)],
    [UPDATE_FIELDS.PLAYER_FIELD_PACK_SLOT_1.offset + 1, Number(potion >> 32n)],
  ]) };
  const templates = new Map([[13444, { entry: 13444, found: true, flags: 0, bonding: 0, inventoryType: 0,
    spells: [{ spellId: 17531, trigger: 0, charges: 1, cooldown: -1, category: 4, categoryCooldown: 60_000 }] }]]);
  const log = { refusals: [], casts: [], uses: [] };
  const world = {
    knownSpells: [116, 1752].map((id, slot) => ({ id, slot })),
    initialSpellsReceived: true, equipmentSets: [],
    actionButtons: [
      { slot: 0, action: 116, type: ACTION_BUTTON_SPELL },
      { slot: 1, action: 1752, type: ACTION_BUTTON_SPELL },
      { slot: 2, action: 13444, type: ACTION_BUTTON_ITEM },
    ],
    state: { selfGuid: SELF, objects: new Map([[SELF, player], [potion, { guid: potion, typeId: 1,
      fields: new Map([[UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, 13444]]) }]]) },
    spellModifiers: new Map(),
    itemTemplates: templates, itemTemplate: (entry) => templates.get(entry),
    cooldownRemaining: (id) => (cooling.has(id) ? 5000 : 0),
    itemCooldownRemaining: () => 0,
    cooldownState: () => undefined,
    isSpellOnHold: (id) => held.has(id),
    isActiveMountSpell: () => false,
    castSpell: (id) => log.casts.push(id),
    useItem: (...args) => log.uses.push(args),
    spellRefusedLocally: (...args) => log.refusals.push(args),
  };
  return { world, log };
}

test("3.47: a press on a recovering or held slot of the bar is refused with Wow.exe's words, and nothing goes out", () => {
  const saved = { world: game.world, spells: game.spells, gcd: game.globalCooldownUntil, client: game.spellMetadataClient };
  const cooling = new Set([116, 1752, 17531]);
  const held = new Set();
  const { world, log } = stubWorld({ cooling, held });
  try {
    game.world = world;
    game.spells = new Map(ROWS);
    game.globalCooldownUntil = 0;
    game.spellMetadataClient = undefined;
    // The native bar and stock UseAction (FrameXmlWorldMount: useAction → useSlot) press the same way.
    for (const column of [0, 1, 2]) useSlot(column, 0);
    assert.deepEqual(log.casts, [], "no cast");
    assert.deepEqual(log.uses, [], "no use");
    assert.deepEqual(log.refusals, [
      [116, SPELL_FAILED_NOT_READY, words("ERR_SPELL_COOLDOWN")],
      [1752, SPELL_FAILED_NOT_READY, words("ERR_ABILITY_COOLDOWN")],
      [17531, SPELL_FAILED_ITEM_NOT_READY, words("ERR_POTION_COOLDOWN")],
    ], "the spell, the ability and the potion each say their row");
    // Held (Stealth after a stealthed login): refused the same way.
    cooling.clear();
    held.add(116);
    useSlot(0, 0);
    assert.deepEqual(log.refusals.at(-1), [116, SPELL_FAILED_NOT_READY, words("ERR_SPELL_COOLDOWN")]);
    // The global cooldown that holds the row (0x00807980's global part): refused too.
    held.clear();
    game.spells.set(116, { ...ROWS.get(116), startRecoveryCategory: 133, startRecoveryTime: 1500 });
    game.globalCooldownUntil = performance.now() + 60_000;
    useSlot(0, 0);
    assert.equal(log.refusals.length, 5);
    assert.deepEqual(log.casts, []);
    // Ready: the presses go out and nothing more is said.
    game.globalCooldownUntil = 0;
    for (const column of [0, 1, 2]) useSlot(column, 0);
    assert.deepEqual(log.casts, [116, 1752]);
    assert.equal(log.uses.length, 1, "the potion is used");
    assert.equal(log.refusals.length, 5);
  } finally {
    game.world = saved.world;
    game.spells = saved.spells;
    game.globalCooldownUntil = saved.gcd;
    game.spellMetadataClient = saved.client;
  }
});

test("3.47: the book's refusal says its row once in 3 s, logs, and raises UNIT_SPELLCAST_FAILED with a count of its own", async () => {
  const { client, connection } = await travelClient([
    { opcode: OPCODES.SMSG_INITIAL_SPELLS, payload: initialSpellsPacket({ spells: [71, 2457] }) },
  ], SELF);
  const saved = { world: game.world, spells: game.spells, gcd: game.globalCooldownUntil };
  const statuses = [];
  const refusals = [];
  const fired = [];
  // The error frame's lines (a request's own progress lines are not errors).
  client.onSpellStatus = (text, error) => { if (error) statuses.push([text, error]); };
  client.events.on("SPELL_CAST_REFUSED_LOCAL", (event) => refusals.push(event));
  client.spellCooldownRow = (id) => ROWS.get(id);
  const seam = new LiveWorldSeam({
    world: () => client, store: () => undefined, spell: (id) => ROWS.get(id),
    monotonic: () => performance.now(), globalCooldownUntil: () => 0, castSpell: () => {},
  });
  seam.attach({ now: () => performance.now() / 1000, fire: (name, ...args) => { fired.push([name, ...args]); return 1; } });
  try {
    game.world = client;
    game.spells = new Map(ROWS);
    game.globalCooldownUntil = 0;
    const casts = () => connection.sentOf(OPCODES.CMSG_CAST_SPELL);
    assert.equal(castSpell(71), true);
    const castCount = casts().at(-1).payload[0];
    connection.push(OPCODES.SMSG_SPELL_GO, spellGoPacket({ caster: SELF, castId: castCount, spellId: 71 }));
    await settle();
    assert.ok(client.cooldownRemaining(2457) > 0, "the stance's category part holds the other one");
    fired.length = 0;
    assert.equal(castSpell(2457), false);
    assert.equal(casts().length, 1, "no CMSG_CAST_SPELL");
    assert.deepEqual(statuses, [[words("ERR_ABILITY_COOLDOWN"), true]], "the ability's row (0x35)");
    const failed = fired.filter(([name]) => name === "UNIT_SPELLCAST_FAILED");
    assert.deepEqual(failed, [["UNIT_SPELLCAST_FAILED", "player", "spell 2457", "", (castCount + 1) & 0xff]],
      "0x007fecc0 for the player, with the count the refused request drew");
    assert.deepEqual(refusals.map(({ spellId, result, casterGuid, castCount: count }) => [spellId, result, casterGuid, count]),
      [[2457, SPELL_FAILED_NOT_READY, SELF, (castCount + 1) & 0xff]]);
    // Again at once: the error frame is quiet (the same spell and result within 3 s), the event is not.
    castSpell(2457);
    assert.equal(statuses.length, 1, "quiet");
    assert.deepEqual(fired.filter(([name]) => name === "UNIT_SPELLCAST_FAILED").map((event) => event[4]),
      [(castCount + 1) & 0xff, (castCount + 2) & 0xff], "each refusal draws a count");
    assert.equal(refusals.length, 2, "the combat log keeps its own rule");
    // The guard's other NOT_READY: the global cooldown that holds the row (0x00807980's global part).
    client.cooldowns.clear();
    client.categoryCooldowns.clear();
    game.spells.set(71, { ...ROWS.get(71), startRecoveryCategory: 133, startRecoveryTime: 1500 });
    game.globalCooldownUntil = performance.now() + 60_000;
    assert.equal(castSpell(71), false);
    assert.equal(casts().length, 1, "no CMSG_CAST_SPELL inside the global cooldown");
    assert.deepEqual(statuses.at(-1), [words("ERR_SPELL_COOLDOWN"), true], "a plain spell's row (0x34)");
  } finally {
    game.world = saved.world;
    game.spells = saved.spells;
    game.globalCooldownUntil = saved.gcd;
    seam.detach();
    client.close();
  }
});

test("3.47: the realm's NOT_READY says the row 0x00807f10 picks, the combat log its own sentence", async () => {
  const { client, connection } = await travelClient([], SELF);
  const statuses = [];
  const results = [];
  client.onSpellStatus = (text, error) => statuses.push([text, error]);
  client.events.on("SPELL_CAST_RESULT", (event) => results.push(event));
  client.spellCooldownRow = (id) => ROWS.get(id);
  setPetSpellAttributesSource((id) => ROWS.get(id)?.attributes);
  try {
    for (const spellId of [116, 1752, 17531, 433]) {
      connection.push(OPCODES.SMSG_CAST_FAILED, castFailedPacket({ spellId, result: SPELL_FAILED_NOT_READY }));
    }
    connection.push(OPCODES.SMSG_CAST_FAILED, castFailedPacket({ spellId: 17531, result: SPELL_FAILED_ITEM_NOT_READY }));
    await settle();
    assert.deepEqual(statuses.map(([text]) => text), [
      words("ERR_SPELL_COOLDOWN"), words("ERR_ABILITY_COOLDOWN"), words("ERR_POTION_COOLDOWN"), words("ERR_FOOD_COOLDOWN"),
      words("ERR_POTION_COOLDOWN"),
    ]);
    assert.deepEqual(results.map(({ text }) => text), [
      ...Array(4).fill(words("SPELL_FAILED_NOT_READY")), words("SPELL_FAILED_ITEM_NOT_READY"),
    ], "SPELL_CAST_FAILED carries the refusal's own sentence (0x00808200's local_10)");
    // Another result keeps its own words.
    connection.push(OPCODES.SMSG_CAST_FAILED, castFailedPacket({ spellId: 116, result: 12 }));
    await settle();
    assert.notEqual(statuses.at(-1)[0], words("ERR_SPELL_COOLDOWN"));
  } finally {
    setPetSpellAttributesSource(undefined);
    client.close();
  }
});
