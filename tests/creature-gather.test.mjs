import assert from "node:assert/strict";
import test from "node:test";
import { SPELL_ROWS_SKIP, spellRows, spellRowsWithEffect } from "./fixtures/spell-rows.mjs";
import { fakeWorldConnection } from "./fixtures/world-packets.mjs";

// 2.06 (docs/implementation/line-A3.ru.md): skinning, and gathering herbs, ore and parts from a
// creature. A right click on a body the server still shows loot on is CMSG_LOOT, as before; once
// the loot is gone and the body still wears UNIT_FLAG_SKINNABLE, the click casts the gathering
// skill the *creature* asks for (CreatureTemplate::GetRequiredLootSkill, CreatureData.h:385) at it,
// and the core opens the LOOT_SKINNING window itself (Spell::EffectSkinning, SpellEffects.cpp:4586).
// Paths in the comments below are relative to tswow/cores/TrinityCore/src/server.

// A document just real enough for Npc.ts and Controls.ts to import: element handles resolve at
// import, listeners are kept so the canvas hover can be driven, children are kept so the notice
// strip can be read back.
function fakeDocument() {
  const byId = new Map();
  const make = (tag) => {
    const listeners = new Map();
    const node = {
      tagName: String(tag).toUpperCase(), children: [], dataset: {}, className: "", textContent: "",
      title: "", hidden: false, disabled: false, id: "", value: "", type: "", listeners,
      style: { setProperty(name, value) { this[name] = value; }, removeProperty(name) { delete this[name]; } },
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      append(...nodes) { node.children.push(...nodes); },
      prepend(...nodes) { node.children.unshift(...nodes); },
      appendChild(child) { node.children.push(child); return child; },
      replaceChildren(...nodes) { node.children = [...nodes]; },
      remove() {}, focus() {}, blur() {},
      addEventListener(name, handler) { listeners.set(name, [...(listeners.get(name) ?? []), handler]); },
      removeEventListener() {},
      setAttribute(name, value) { node[name] = value; },
      getAttribute(name) { return node[name] ?? null; },
      removeAttribute(name) { delete node[name]; },
      setPointerCapture() {}, releasePointerCapture() {},
      querySelector() { return make("div"); }, querySelectorAll() { return []; }, closest() { return undefined; },
      getBoundingClientRect() { return { x: 0, y: 0, width: 1280, height: 720, top: 0, left: 0, right: 1280, bottom: 720 }; },
      getContext() { return null; },
    };
    return node;
  };
  return {
    createElement: make, createElementNS: (_namespace, tag) => make(tag),
    createTextNode: (text) => ({ textContent: text }), createDocumentFragment: () => make("fragment"),
    body: make("body"), documentElement: make("html"), head: make("head"),
    getElementById(id) {
      let node = byId.get(id);
      if (!node) {
        node = make("div");
        node.id = id;
        byId.set(id, node);
      }
      return node;
    },
    querySelector() { return make("div"); }, querySelectorAll() { return []; },
    addEventListener() {}, removeEventListener() {},
  };
}

globalThis.document = fakeDocument();
globalThis.location = { protocol: "http:", hostname: "127.0.0.1", origin: "http://127.0.0.1:5173" };
globalThis.window = {
  addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1,
  innerWidth: 1280, innerHeight: 800,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
};
globalThis.localStorage = globalThis.window.localStorage;
globalThis.matchMedia = globalThis.window.matchMedia;
globalThis.requestAnimationFrame = () => 0;
globalThis.HTMLElement = class {};

const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { OPCODES } = await import("../dist/code/generated/opcodes.js");
const { WorldClient } = await import("../dist/code/world/WorldClient.js");
const { UNIT_FLAG_SKINNABLE } = await import("../dist/code/world/FactionRules.js");
const { game } = await import("../dist/code/browser/game/Context.js");
const {
  gatherPlan, gatherSkillOf, gatherSpellFor, isSkinnableCorpse, performGather,
} = await import("../dist/code/browser/game/CreatureGather.js");
const { interactWithGuid } = await import("../dist/code/browser/ui/Npc.js");
const { resetNotices } = await import("../dist/code/browser/ui/Notices.js");
const { wireControls } = await import("../dist/code/browser/input/Controls.js");

const HEALTH = UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset;
const UNIT_FLAGS = UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset;
const DYNAMIC_FLAGS = UPDATE_FIELDS.UNIT_DYNAMIC_FLAGS.offset;
const ENTRY_FIELD = UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset;
/** `UNIT_DYNFLAG_LOOTABLE` (SharedDefines.h:3124). */
const LOOTABLE = 0x0001;
/** `CREATURE_TYPE_FLAG_SKIN_WITH_*` (SharedDefines.h:2733-2740). */
const SKIN_WITH_HERBALISM = 0x100;
const SKIN_WITH_MINING = 0x200;
const SKIN_WITH_ENGINEERING = 0x8000;

const SELF = 1n;
const ENTRY = 3178;
/** HIGHGUID_UNIT 0xF130, entry 3178 (0x000C6A), counter 0x123 — a creature guid as the core builds it. */
const CORPSE = 0xF130000C6A000123n;
/** The same guid packed by hand: mask 0xDB (bytes 0, 1, 3, 4, 6, 7 non-zero), then those bytes. */
const CORPSE_PACKED = [0xDB, 0x23, 0x01, 0x6A, 0x0C, 0x30, 0xF1];
/** The same guid as a plain little-endian u64 (CMSG_LOOT, `WorldSession::HandleLootOpcode`). */
const CORPSE_U64 = [0x23, 0x01, 0x00, 0x6A, 0x0C, 0x00, 0x30, 0xF1];

/**
 * The effect-95 rows the world tests hand to `game.spells`, copied from this dataset's Spell.dbc
 * (`probes/A3/probe-item-targets.out.txt`); the test «the hand-copied rows are the dataset's own»
 * holds them to the table wherever the dataset is present.
 */
const ROWS = {
  8613: { name: "Снятие шкур", rank: "Ученик", spellLevel: 0, effects: [95, 118, 0], effectMiscValue: [0, 393, 0] },
  8617: { name: "Снятие шкур", rank: "Подмастерье", spellLevel: 0, effects: [95, 118, 0], effectMiscValue: [0, 393, 0] },
  32605: { name: "Сбор трав", rank: "", spellLevel: 0, effects: [95, 0, 0], effectMiscValue: [1, 0, 0] },
  32606: { name: "Горное дело", rank: "", spellLevel: 0, effects: [95, 0, 0], effectMiscValue: [2, 0, 0] },
  49383: { name: "Инженерное дело", rank: "", spellLevel: 0, effects: [95, 0, 0], effectMiscValue: [3, 0, 0] },
};

/** A whole `SpellMetadata` for one of `ROWS`: what `spellCastBlockReason` and the cast read. */
function metadata(id, extra = {}) {
  return {
    id, description: "", iconId: 0, iconPath: "", passive: false, hidden: false, autoRepeat: false,
    displayInStanceBar: false, stanceBarOrder: 0, powerType: 0, powerCost: 0, powerCostPercent: 0,
    recoveryTime: 0, categoryRecoveryTime: 0, startRecoveryTime: 0, cooldownStartedOnEvent: false,
    effectAura: [0, 0, 0], effectBasePoints: [0, 0, 0], effectDieSides: [0, 0, 0], effectPeriod: [0, 0, 0],
    effectChainTargets: [0, 0, 0], effectRadius: [0, 0, 0], duration: 0, maxDuration: 0, procChance: 0,
    spellClassSet: 0, spellClassMask: [0, 0, 0], schoolMask: 1, rangeMin: 0, rangeMax: 5, rangeFlags: 0,
    castTime: 0, descriptionVariablesId: 0,
    ...ROWS[id], ...extra,
  };
}
const handCopied = (id) => (ROWS[id] ? metadata(id) : undefined);

/** A creature template as `parseCreatureQueryResponse` leaves it; only `found` and `flags` matter here. */
function template(flags = 0, found = true) {
  return {
    entry: ENTRY, found, name: "Зверь", subName: "", cursorName: "", flags, creatureType: 1, creatureFamily: 0,
    classification: 0, proxyCreatureIds: [], displayIds: [], healthModifier: 1, powerModifier: 1, leader: false,
    questItems: [], movementId: 0,
  };
}

/** A unit in world state; by default the body of a skinnable creature whose loot has been taken. */
function body({ guid = CORPSE, typeId = 3, health = 0, flags = UNIT_FLAG_SKINNABLE, dynamicFlags = 0, entry = ENTRY } = {}) {
  return {
    guid, typeId, position: { x: 2, y: 0, z: 0, orientation: 0 }, movementFlags: 0, updateFlags: 0,
    targetGuid: undefined, runSpeed: undefined, turnRate: undefined, transport: undefined, speeds: undefined,
    motion: undefined, glide: undefined, transportTime: undefined,
    fields: new Map([[HEALTH, health], [UNIT_FLAGS, flags], [DYNAMIC_FLAGS, dynamicFlags], [ENTRY_FIELD, entry]]),
  };
}

/** The half of a world `gatherPlan` reads, recording what it asked the template cache. */
function planWorld({ known = [8613], flags = 0, cached = true, found = true } = {}) {
  const asked = [];
  return {
    asked,
    knownSpells: known.map((id, slot) => ({ id, slot })),
    creatureTemplate(entry, guid) {
      asked.push([entry, guid]);
      return cached ? template(flags, found) : undefined;
    },
  };
}

/**
 * A real `WorldClient` over a fake socket: the character standing next to one body, the spells in
 * `known` learned and described in `game.spells`, and the creature's template cached unless
 * `cached` is false. Nothing is read from the socket, so every packet in `connection.sent` is one
 * this client chose to send.
 */
function liveWorld({ known = [8613], flags = 0, cached = true, corpse = {} } = {}) {
  const connection = fakeWorldConnection();
  const world = new WorldClient(connection);
  world.state.selfGuid = SELF;
  world.state.move(SELF, { flags: 0, position: { x: 0, y: 0, z: 0, orientation: 0 } });
  world.state.objects.get(SELF).typeId = 4;
  world.state.setField(SELF, HEALTH, 100);
  world.state.objects.set(CORPSE, body(corpse));
  world.knownSpells = known.map((id, slot) => ({ id, slot }));
  if (cached) world.creatureTemplates.set(ENTRY, template(flags));
  game.world = world;
  game.spells = new Map(known.map((id) => [id, metadata(id)]));
  game.globalCooldownUntil = 0;
  resetNotices();
  return { world, connection };
}

function release(world) {
  world.close();
  game.world = undefined;
  game.spells = new Map();
  resetNotices();
}

/** `CMSG_CAST_SPELL` as `WorldSession::HandleCastSpellOpcode` + `SpellCastTargets::Read` take it. */
function castBytes(spellId, castCount) {
  return [
    castCount,
    spellId & 0xff, (spellId >>> 8) & 0xff, (spellId >>> 16) & 0xff, (spellId >>> 24) & 0xff,
    0x00, // castFlags
    0x02, 0x00, 0x00, 0x00, // TARGET_FLAG_UNIT (SpellDefines.h:179): the object guid follows, packed
    ...CORPSE_PACKED,
  ];
}

const opcodesOf = (connection) => connection.sent.map((packet) => packet.opcode);
const bytesOf = (packet) => [...packet.payload];

/** What the notice strip over the world says now. */
function noticeLines() {
  const strip = document.getElementById("world-viewport").children.at(-1);
  return (strip?.children ?? []).map((line) => line.textContent);
}

// (а)

test("(а) the skill is the creature's: herbalism, then mining, then engineering, else skinning", () => {
  assert.equal(gatherSkillOf(SKIN_WITH_HERBALISM), 1);
  assert.equal(gatherSkillOf(SKIN_WITH_MINING), 2);
  assert.equal(gatherSkillOf(SKIN_WITH_ENGINEERING), 3);
  assert.equal(gatherSkillOf(0), 0);
  assert.equal(gatherSkillOf(0x5), 0, "unrelated type flags are skinning, the core's normal case");
  // GetRequiredLootSkill tests the bits in this order and returns on the first one set.
  assert.equal(gatherSkillOf(SKIN_WITH_HERBALISM | SKIN_WITH_MINING), 1);
  assert.equal(gatherSkillOf(SKIN_WITH_MINING | SKIN_WITH_ENGINEERING), 2);
  assert.equal(gatherSkillOf(SKIN_WITH_HERBALISM | SKIN_WITH_ENGINEERING), 1);
});

// (б)

test("(б) the dataset has nine effect-95 spells, and their misc value is the gathering skill", { skip: SPELL_ROWS_SKIP }, async () => {
  const rows = await spellRowsWithEffect(95);
  const skillOf = (row) => row.effectMiscValue[row.effects.indexOf(95)];
  assert.deepEqual(rows.map((row) => [row.id, skillOf(row)]).sort((a, b) => a[0] - b[0]), [
    [8613, 0], [8617, 0], [8618, 0], [10768, 0], [32605, 1], [32606, 2], [32678, 0], [49383, 3], [50305, 0],
  ]);
});

test("(б) the hand-copied rows the world tests use are the dataset's own", { skip: SPELL_ROWS_SKIP }, async () => {
  const ids = Object.keys(ROWS).map(Number);
  const real = await spellRows(ids);
  for (const id of ids) assert.deepEqual(real.get(id), { id, ...ROWS[id] }, `Spell.dbc row ${id}`);
});

test("(б) the highest known rank of the creature's own skill, never another skill's spell", { skip: SPELL_ROWS_SKIP }, async () => {
  const all = await spellRowsWithEffect(95);
  const rows = new Map(all.map((row) => [row.id, row]));
  const knowing = (...ids) => ids.map((id, slot) => ({ id, slot }));
  const rowOf = (id) => rows.get(id);

  assert.equal(gatherSpellFor(knowing(8613, 8617), rowOf, gatherSkillOf(0)), 8617, "Подмастерье over Ученик");
  assert.equal(gatherSpellFor(knowing(8617, 8613), rowOf, gatherSkillOf(0)), 8617, "whatever the book order");
  assert.equal(gatherSpellFor(knowing(32605), rowOf, gatherSkillOf(SKIN_WITH_HERBALISM)), 32605);
  assert.equal(gatherSpellFor(knowing(32605), rowOf, gatherSkillOf(SKIN_WITH_MINING)), undefined,
    "a herbalist has nothing to mine an elemental with: no spell, not «Сбор трав» instead");
  assert.equal(gatherSpellFor(knowing(32605), rowOf, gatherSkillOf(0)), undefined, "nor to skin a beast with");
  assert.equal(gatherSpellFor(knowing(8613), rowOf, gatherSkillOf(SKIN_WITH_HERBALISM)), undefined,
    "and a skinner has nothing to gather a plant creature with");
  assert.equal(gatherSpellFor(knowing(49383), rowOf, gatherSkillOf(SKIN_WITH_ENGINEERING)), 49383);

  const everything = knowing(...all.map((row) => row.id));
  assert.equal(gatherSpellFor(everything, rowOf, 0), 50305, "«Великий мастер» tops the six skinning ranks");
  assert.equal(gatherSpellFor(everything, rowOf, 1), 32605);
  assert.equal(gatherSpellFor(everything, rowOf, 2), 32606);
  assert.equal(gatherSpellFor(everything, rowOf, 3), 49383);
  assert.equal(gatherSpellFor(everything, () => undefined, 0), undefined, "no row, no guess");
});

test("(б) SpellLevel orders ranks before the id does, as the spellbook's rank chains do", () => {
  const rows = new Map([
    [900, { effects: [95, 0, 0], effectMiscValue: [0, 0, 0], spellLevel: 20 }],
    [800, { effects: [95, 0, 0], effectMiscValue: [0, 0, 0], spellLevel: 40 }],
    // Effect 95 counts in any slot, with the misc value of that same slot: these two are a mining
    // and an engineering spell, and the 0 in their first slot, beside effect 118, is not skinning —
    // read loosely, their higher SpellLevel would win the skinning question over 800.
    [700, { effects: [118, 95, 0], effectMiscValue: [0, 2, 0], spellLevel: 60 }],
    [600, { effects: [118, 95, 0], effectMiscValue: [0, 3, 0], spellLevel: 80 }],
  ]);
  const known = [900, 800, 700, 600].map((id, slot) => ({ id, slot }));
  assert.equal(gatherSpellFor(known, (id) => rows.get(id), 0), 800);
  assert.equal(gatherSpellFor(known, (id) => rows.get(id), 2), 700);
  assert.equal(gatherSpellFor(known, (id) => rows.get(id), 3), 600);
  assert.equal(gatherSpellFor(known, (id) => rows.get(id), 1), undefined);
});

// (в)

test("(в) loot first: a body the server still shows loot on has no gathering plan", () => {
  const world = planWorld();
  assert.equal(gatherPlan(world, body({ dynamicFlags: LOOTABLE }), handCopied), undefined);
});

test("(в) only a dead creature wearing UNIT_FLAG_SKINNABLE is gathered from", () => {
  const world = planWorld();
  assert.equal(gatherPlan(world, body({ flags: 0 }), handCopied), undefined, "no skinnable flag");
  assert.equal(gatherPlan(world, body({ health: 100 }), handCopied), undefined, "alive");
  assert.equal(gatherPlan(world, body({ typeId: 4 }), handCopied), undefined,
    "a player's body is SKIN_PLAYER_CORPSE's business, not effect 95's");
  assert.equal(gatherPlan(world, body({ entry: 0 }), handCopied), undefined, "no entry, no template to ask");
  assert.equal(isSkinnableCorpse(body()), true);
  assert.equal(isSkinnableCorpse(body({ flags: 0 })), false);
  assert.equal(isSkinnableCorpse(body({ health: 100 })), false);
  assert.equal(isSkinnableCorpse(body({ typeId: 4 })), false);
});

test("(в) a skinnable body without loot is a cast of the known skill at that body", () => {
  const world = planWorld({ known: [8613] });
  assert.deepEqual(gatherPlan(world, body(), handCopied), { spellId: 8613, guid: CORPSE });
  assert.deepEqual(world.asked, [[ENTRY, CORPSE]], "the template is asked for by entry and guid");
  assert.deepEqual(gatherPlan(planWorld({ known: [32606], flags: SKIN_WITH_MINING }), body(), handCopied),
    { spellId: 32606, guid: CORPSE });
});

test("(в) an unknown template is a wait, not a guess, and a missing skill is named", () => {
  const pending = planWorld({ cached: false });
  assert.deepEqual(gatherPlan(pending, body(), handCopied), { hint: "Загрузка данных существа…" });
  assert.deepEqual(pending.asked, [[ENTRY, CORPSE]], "asking is what starts CMSG_CREATURE_QUERY");
  assert.equal(gatherPlan(planWorld({ found: false }), body(), handCopied), undefined,
    "a template the realm says it does not have leaves the click to CMSG_LOOT, as before");

  const names = [
    [0, "Нужен навык: Снятие шкур"],
    [SKIN_WITH_HERBALISM, "Нужен навык: Травничество"],
    [SKIN_WITH_MINING, "Нужен навык: Горное дело"],
    [SKIN_WITH_ENGINEERING, "Нужен навык: Инженерное дело"],
  ];
  for (const [flags, hint] of names) {
    assert.deepEqual(gatherPlan(planWorld({ known: [], flags }), body(), handCopied), { hint }, hint);
  }
  assert.deepEqual(gatherPlan(planWorld({ known: [32605], flags: 0 }), body(), handCopied),
    { hint: "Нужен навык: Снятие шкур" }, "a herbalist at a beast is told what the beast wants");
});

// (г)

test("(г) the cast is one CMSG_CAST_SPELL naming the body as its unit target", () => {
  const { world, connection } = liveWorld({ known: [8613] });
  try {
    assert.equal(performGather(world, { spellId: 8613, guid: CORPSE }), true);
    assert.deepEqual(opcodesOf(connection), [OPCODES.CMSG_CAST_SPELL], "one packet and nothing else");
    assert.deepEqual(bytesOf(connection.sent[0]), castBytes(8613, 1));
    assert.equal(performGather(world, { spellId: 8613, guid: CORPSE }), true);
    assert.deepEqual(bytesOf(connection.sent[1]), castBytes(8613, 2), "each request counts its own cast");
  } finally {
    release(world);
  }
});

test("(г) a locally blocked cast sends nothing at all", () => {
  const dead = liveWorld({ known: [8613] });
  try {
    dead.world.state.setField(SELF, HEALTH, 0);
    assert.equal(performGather(dead.world, { spellId: 8613, guid: CORPSE }), false);
    assert.deepEqual(dead.connection.sent, []);
  } finally {
    release(dead.world);
  }
  const cooling = liveWorld({ known: [8613] });
  try {
    cooling.world.cooldowns.set(8613, performance.now() + 10_000);
    assert.equal(performGather(cooling.world, { spellId: 8613, guid: CORPSE }), false);
    assert.deepEqual(cooling.connection.sent, []);
  } finally {
    release(cooling.world);
  }
});

// (д)

test("(д) a body with loot on it is looted: only CMSG_LOOT, even when it is also skinnable", () => {
  const { world, connection } = liveWorld({ known: [8613], corpse: { dynamicFlags: LOOTABLE } });
  try {
    interactWithGuid(CORPSE);
    assert.deepEqual(opcodesOf(connection), [OPCODES.CMSG_LOOT]);
    assert.deepEqual(bytesOf(connection.sent[0]), CORPSE_U64);
  } finally {
    release(world);
  }
});

test("(д) a skinnable body whose loot is gone is gathered: only the cast", () => {
  const { world, connection } = liveWorld({ known: [8613] });
  try {
    interactWithGuid(CORPSE);
    assert.deepEqual(opcodesOf(connection), [OPCODES.CMSG_CAST_SPELL]);
    assert.deepEqual(bytesOf(connection.sent[0]), castBytes(8613, 1));
  } finally {
    release(world);
  }
  const miner = liveWorld({ known: [8613, 32606], flags: SKIN_WITH_MINING });
  try {
    interactWithGuid(CORPSE);
    assert.deepEqual(opcodesOf(miner.connection), [OPCODES.CMSG_CAST_SPELL]);
    assert.deepEqual(bytesOf(miner.connection.sent[0]), castBytes(32606, 1), "an elemental is mined, not skinned");
  } finally {
    release(miner.world);
  }
});

test("(д) any other dead body still asks for its loot, as before", () => {
  const { world, connection } = liveWorld({ known: [8613], corpse: { flags: 0 } });
  try {
    interactWithGuid(CORPSE);
    assert.deepEqual(opcodesOf(connection), [OPCODES.CMSG_LOOT]);
    assert.deepEqual(bytesOf(connection.sent[0]), CORPSE_U64);
  } finally {
    release(world);
  }
});

test("(д) without the skill the click names it and sends nothing", () => {
  const { world, connection } = liveWorld({ known: [8613], flags: SKIN_WITH_HERBALISM });
  try {
    interactWithGuid(CORPSE);
    assert.deepEqual(connection.sent, [], "neither a cast the core would refuse nor a loot request");
    assert.deepEqual(noticeLines(), ["Нужен навык: Травничество"]);
  } finally {
    release(world);
  }
});

test("(д) an uncached template asks for it, says so, and the next click casts", () => {
  const { world, connection } = liveWorld({ known: [8613], cached: false });
  try {
    interactWithGuid(CORPSE);
    assert.deepEqual(opcodesOf(connection), [OPCODES.CMSG_CREATURE_QUERY], "the query, and no cast yet");
    assert.deepEqual(noticeLines(), ["Загрузка данных существа…"]);
    world.creatureTemplates.set(ENTRY, template(0));
    interactWithGuid(CORPSE);
    assert.deepEqual(opcodesOf(connection), [OPCODES.CMSG_CREATURE_QUERY, OPCODES.CMSG_CAST_SPELL]);
    assert.deepEqual(bytesOf(connection.sent[1]), castBytes(8613, 1));
  } finally {
    release(world);
  }
});

// (е) The pointer over the body: the gatherer's cursor is its own value, drawn with the loot bag
// until 5.17 gives it the original's picture.

test("(е) the cursor over a skinnable body without loot is the gathering one, not the hand", async () => {
  const worldCanvas = document.getElementById("world-canvas");
  wireControls();
  const [pointerMove] = worldCanvas.listeners.get("pointermove") ?? [];
  assert.equal(typeof pointerMove, "function", "the canvas has to be wired for this to mean anything");
  const objects = new Map([
    [SELF, body({ guid: SELF, typeId: 4, health: 100, flags: 0 })],
    [2n, body({ guid: 2n, dynamicFlags: LOOTABLE })],
    [3n, body({ guid: 3n })],
    [4n, body({ guid: 4n, flags: 0 })],
  ]);
  const previousScene = game.scene;
  game.world = { state: { selfGuid: SELF, objects } };
  game.collision = undefined;
  game.scene = { pick: (x) => (x === 200 ? 2n : x === 300 ? 3n : x === 400 ? 4n : undefined) };
  const cursorAt = async (x) => {
    // Past the 16 ms hover throttle, so each move is answered on its own leading edge.
    await new Promise((resolve) => { setTimeout(resolve, 40); });
    pointerMove({ buttons: 0, clientX: x, clientY: 10, movementX: 0, movementY: 0 });
    return worldCanvas.style.cursor;
  };
  try {
    const bag = await cursorAt(200);
    assert.match(bag, /^url\("data:image\/svg\+xml,/, "a body with loot is the bag");
    assert.equal(await cursorAt(300), bag, "a skinnable body without loot: the gathering cursor, the bag's picture for now");
    assert.equal(await cursorAt(400), "pointer", "a spent body that is not skinnable stays the hand");
    assert.equal(await cursorAt(900), "", "bare ground is left to the stylesheet");
  } finally {
    game.world = undefined;
    game.scene = previousScene;
  }
});
