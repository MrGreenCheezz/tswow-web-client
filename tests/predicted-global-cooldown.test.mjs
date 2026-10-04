// Plan item 5.30 (L12, 04.10): the global cooldown predicted from the moment a cast request leaves
// (Wow.exe 0x0080ac90 → 0x00805d70 → 0x00805230; refused locally by 0x0080cce0 → 0x00809000 while it
// runs), taken back by the realm's refusal (SMSG_CAST_FAILED), confirmed — not moved — by its acceptance
// (L12-review), and as long as the realm's own (game/GlobalCooldownDuration.ts).
import assert from "node:assert/strict";
import test from "node:test";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";
import { castFailedPacket, initialSpellsPacket, settle, spellGoPacket, travelClient } from "./fixtures/world-packets.mjs";

const { PredictedGlobalCooldown, attachPredictedGlobalCooldown } =
  await import("../dist/code/browser/game/PredictedGlobalCooldown.js");

const SPELLS = new Map([
  [133, { startRecoveryTime: 1500 }], // Огненный шар
  [116, { startRecoveryTime: 1500 }], // Ледяная стрела
  [1953, { startRecoveryTime: 1000 }], // a shorter global part
  [12472, { startRecoveryTime: 0 }], // Стылая кровь: off the global cooldown
]);

function model(initial = 0) {
  const sink = { globalCooldownUntil: initial };
  return { sink, gcd: new PredictedGlobalCooldown(sink, () => SPELLS) };
}

test("the request starts the global cooldown; its refusal takes it back", () => {
  const { sink, gcd } = model();
  gcd.sent(133, 7, 1000);
  assert.equal(sink.globalCooldownUntil, 2500, "send + StartRecoveryTime");
  gcd.refused(133, 6);
  gcd.refused(116, 7);
  assert.equal(sink.globalCooldownUntil, 2500, "another request's refusal changes nothing");
  gcd.refused(133, 7);
  assert.equal(sink.globalCooldownUntil, 0, "the refusal of this request: back to before it");
  gcd.refused(133, 7);
  assert.equal(sink.globalCooldownUntil, 0, "a second refusal of the same request is nothing");
});

// L12-review: the acceptance no longer re-anchors the end at the answer. Wow.exe's SMSG_SPELL_GO leaves the
// player's history alone (0x0080e1b0), and the realm's own end (send + one-way delay + duration) is reached by
// a request sent at send + duration; anchoring at the answer refused casts the realm would take for one
// round trip after every global cooldown.
test("the acceptance confirms the request's own end without moving it; a later refusal (an interrupt) keeps it", () => {
  const { sink, gcd } = model();
  gcd.sent(133, 7, 1000);
  gcd.accepted(133, 7, 1080);
  assert.equal(sink.globalCooldownUntil, 2500, "accepted 80 ms later: still send + StartRecoveryTime");
  gcd.refused(133, 7);
  assert.equal(sink.globalCooldownUntil, 2500, "the accepted cast's end stays (Wow.exe keeps it on an interrupt)");
  // An acceptance with no prediction (a spell off the global cooldown, or none was made) changes nothing.
  gcd.accepted(116, 8, 3000);
  assert.equal(sink.globalCooldownUntil, 2500);
});

// L12-review: the off-GCD / on-GCD / hasted table end to end — WorldClient, the prediction EnterWorld.ts
// attaches and the shared cast guard (SpellCastGuard.ts) every cast path asks.
test("the guard over a live prediction: off-GCD spells pass, the hasted end is the realm's, melee is not hasted", async () => {
  const { game } = await import("../dist/code/browser/game/Context.js");
  const { spellCastBlockReason } = await import("../dist/code/browser/SpellCastGuard.js");
  const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
  const SELF = 0x10n;
  // Dataset Spell.dbc: StartRecoveryTime, DefenseType, Attributes.
  const row = (id, startRecoveryTime, dmgClass, attr0) => ({
    id, name: `spell ${id}`, passive: false, startRecoveryTime, recoveryTime: 0, categoryRecoveryTime: 0,
    powerType: 0, powerCost: 0, powerCostPercent: 0, schoolMask: 1, spellClassMask: [0x1, 0, 0],
    dmgClass, attributes: [attr0, 0, 0, 0, 0, 0, 0, 0],
  });
  const rows = new Map([
    [133, row(133, 1500, 1, 0x0)], // Огненный шар
    [116, row(116, 1500, 1, 0x0)], // Ледяная стрела
    [47486, row(47486, 1500, 2, 0x40010)], // Смертельный удар (melee: not hasted)
    [2139, row(2139, 0, 1, 0x0)], // Антимагия (off the global cooldown)
    [1766, row(1766, 0, 2, 0x40010)], // Пинок
  ]);
  const { client, connection } = await travelClient([
    { opcode: OPCODES.SMSG_INITIAL_SPELLS, payload: initialSpellsPacket({ spells: [...rows.keys()] }) },
  ], SELF);
  const speed = new DataView(new ArrayBuffer(4));
  speed.setFloat32(0, 0.8, true); // ≈25 % haste
  client.state.objects.get(SELF).fields.set(UPDATE_FIELDS.UNIT_MOD_CAST_SPEED.offset, speed.getUint32(0, true));
  const saved = { world: game.world, spells: game.spells, gcd: game.globalCooldownUntil };
  game.world = client;
  game.spells = rows;
  game.globalCooldownUntil = 0;
  let clock = 10_000;
  const offs = attachPredictedGlobalCooldown(client, game, () => game.spells, () => true, () => clock);
  const reason = (id, at) => spellCastBlockReason(client, id, at);
  try {
    // Off the global cooldown: starts nothing, and is never held by a running one.
    client.castSpell(2139);
    assert.equal(game.globalCooldownUntil, 0, "Антимагия starts no global cooldown");
    client.castSpell(133);
    assert.equal(game.globalCooldownUntil, 11_200, "1500 × 0.8 from the request, as the realm and Wow.exe");
    assert.equal(reason(2139, 10_001), undefined, "an interrupt right after a GCD spell goes out");
    assert.equal(reason(1766, 10_001), undefined);
    assert.equal(reason(116, 11_100), "global-cooldown", "inside the realm's 1.2 s");
    assert.equal(reason(116, 11_200), undefined, "the realm takes it from here: so does the guard");
    // The realm's answer does not push the end out by its round trip.
    const castCount = connection.sentOf(OPCODES.CMSG_CAST_SPELL).at(-1).payload[0];
    clock = 10_090;
    connection.push(OPCODES.SMSG_SPELL_GO, spellGoPacket({ caster: SELF, castId: castCount, spellId: 133 }));
    await settle();
    assert.equal(game.globalCooldownUntil, 11_200, "accepted 90 ms later: the same end");
    // A melee spell is not hasted.
    clock = 20_000;
    client.castSpell(47486);
    assert.equal(game.globalCooldownUntil, 21_500);
    // Власть нечестивости's −500 on the spell's family bit (SMSG_SET_FLAT_SPELL_MODIFIER: bit, op 21, value).
    connection.push(OPCODES.SMSG_SET_FLAT_SPELL_MODIFIER, new PacketWriter().u8(0).u8(21).i32(-500).toUint8Array());
    await settle();
    clock = 30_000;
    client.castSpell(47486);
    assert.equal(game.globalCooldownUntil, 31_000, "1500 − 500");
  } finally {
    for (const off of offs) off();
    game.world = saved.world;
    game.spells = saved.spells;
    game.globalCooldownUntil = saved.gcd;
    client.close?.();
  }
});

test("spells off the global cooldown or without a row predict nothing and disturb nothing", () => {
  const { sink, gcd } = model();
  gcd.sent(12472, 1, 1000);
  gcd.sent(99999, 2, 1000);
  assert.equal(sink.globalCooldownUntil, 0);
  gcd.sent(133, 3, 1000);
  gcd.sent(12472, 4, 1010);
  gcd.refused(12472, 4);
  assert.equal(sink.globalCooldownUntil, 2500, "the off-GCD spell's refusal leaves the running one");
});

test("two requests in flight: refusing the later falls back to the earlier one's end", () => {
  const { sink, gcd } = model();
  gcd.sent(1953, 1, 1000);
  gcd.sent(133, 2, 1200);
  assert.equal(sink.globalCooldownUntil, 2700);
  gcd.refused(133, 2);
  assert.equal(sink.globalCooldownUntil, 2000, "1953's own 1000 ms from its request");
  gcd.refused(1953, 1);
  assert.equal(sink.globalCooldownUntil, 0);
});

test("a value written by someone else is the floor a refusal returns to", () => {
  const { sink, gcd } = model(5000);
  gcd.sent(133, 1, 1000);
  assert.equal(sink.globalCooldownUntil, 5000, "a longer end already running is kept");
  sink.globalCooldownUntil = 9000;
  gcd.sent(116, 2, 8000);
  assert.equal(sink.globalCooldownUntil, 9500);
  gcd.refused(116, 2);
  assert.equal(sink.globalCooldownUntil, 9000);
});

test("on a WorldClient: the request moves the end at once, SMSG_CAST_FAILED takes it back", async () => {
  const SELF = 0x10n;
  const { client, connection } = await travelClient([
    { opcode: OPCODES.SMSG_INITIAL_SPELLS, payload: initialSpellsPacket({ spells: [133, 116] }) },
  ], SELF);
  const sink = { globalCooldownUntil: 0 };
  let current = true;
  const offs = attachPredictedGlobalCooldown(client, sink, () => SPELLS, () => current, () => 1000);
  try {
    client.castSpell(133);
    const [request] = connection.sentOf(OPCODES.CMSG_CAST_SPELL);
    assert.ok(request);
    assert.equal(sink.globalCooldownUntil, 2500, "set inside the request, before any answer");
    const castCount = request.payload[0];
    connection.push(OPCODES.SMSG_CAST_FAILED, castFailedPacket({ castCount, spellId: 133, result: 97 }));
    await settle();
    assert.equal(sink.globalCooldownUntil, 0, "OUT_OF_RANGE from the realm: the prediction is gone");
    // The interrupt pair alone (SMSG_SPELL_FAILURE, the player's own, INTERRUPTED) and someone else's
    // SMSG_SPELL_FAILED_OTHER are no refusal: the end stays.
    client.castSpell(116);
    const second = connection.sentOf(OPCODES.CMSG_CAST_SPELL)[1];
    connection.push(OPCODES.SMSG_SPELL_FAILURE, new PacketWriter().packedGuid(SELF)
      .u8(second.payload[0]).u32(116).u8(40).toUint8Array());
    connection.push(OPCODES.SMSG_SPELL_FAILED_OTHER, new PacketWriter().packedGuid(0xf130000000000abcn)
      .u8(second.payload[0]).u32(116).u8(40).toUint8Array());
    await settle();
    assert.equal(sink.globalCooldownUntil, 2500);
    // Another world's late events change nothing.
    current = false;
    connection.push(OPCODES.SMSG_CAST_FAILED, castFailedPacket({ castCount: second.payload[0], spellId: 116, result: 97 }));
    await settle();
    assert.equal(sink.globalCooldownUntil, 2500);
  } finally {
    for (const off of offs) off();
    client.close?.();
  }
});

// L13 (04.10): with `/dbc/spells?v=17`'s StartRecoveryCategory the prediction is kept per category, as the realm
// keys its own (SpellHistory.cpp:585-594) and Wow.exe 0x00807980 matches the entry's global category with the
// asked spell's: a category-0 row starts none (Spell.cpp:8698), a row of category C is held only by a global
// cooldown of C, and a category-133 row without a time (Воля Отрекшихся) is held by the running 133 one.
// `game.globalCooldownUntil` keeps the end the ordinary (133) spells share; the guard asks per row.
const { globalCooldownEndFor } = await import("../dist/code/browser/game/PredictedGlobalCooldown.js");
// Dataset Spell.dbc (StartRecoveryCategory/StartRecoveryTime), read 2026-10-04.
const CATEGORY_ROWS = new Map([
  [133, { startRecoveryCategory: 133, startRecoveryTime: 1500 }], // Огненный шар
  [116, { startRecoveryCategory: 133, startRecoveryTime: 1500 }], // Ледяная стрела
  [45469, { startRecoveryCategory: 0, startRecoveryTime: 1500 }], // Удар смерти
  [61193, { startRecoveryCategory: 0, startRecoveryTime: 1500 }], // Духовный удар
  [48941, { startRecoveryCategory: 38, startRecoveryTime: 1500 }], // Аура благочестия
  [7744, { startRecoveryCategory: 133, startRecoveryTime: 0 }], // Воля Отрекшихся
  [2139, { startRecoveryCategory: 0, startRecoveryTime: 0 }], // Антимагия
]);

test("L13: per category — 0 starts none, 38 holds only 38, 133 holds 133 rows with or without a time", () => {
  const sink = { globalCooldownUntil: 0 };
  const gcd = new PredictedGlobalCooldown(sink, () => CATEGORY_ROWS);
  const end = (id) => globalCooldownEndFor(sink, CATEGORY_ROWS.get(id));
  gcd.sent(45469, 1, 1000);
  assert.equal(sink.globalCooldownUntil, 0, "category 0: the realm starts no global cooldown");
  assert.deepEqual([133, 7744, 61193, 2139].map(end), [0, 0, 0, 0], "and nothing is held after it");
  gcd.sent(48941, 2, 1000);
  assert.equal(sink.globalCooldownUntil, 0, "the shared (133) end does not move for category 38");
  assert.equal(end(48941), 2500, "but a category-38 spell is held by it");
  assert.deepEqual([133, 7744, 45469].map(end), [0, 0, 0]);
  gcd.sent(133, 3, 1200);
  assert.equal(sink.globalCooldownUntil, 2700);
  assert.deepEqual([116, 7744, 48941, 45469, 61193, 2139].map(end), [2700, 2700, 2500, 0, 0, 0],
    "133 holds 133 rows, the timeless Воля Отрекшихся too; 38 keeps its own end; category 0 is never held");
  // The acceptance confirms per category; a refusal takes back only its own.
  gcd.accepted(48941, 2);
  gcd.refused(133, 3);
  assert.equal(sink.globalCooldownUntil, 0);
  assert.deepEqual([116, 7744, 48941].map(end), [0, 0, 2500]);
  // A row without the column (an older gateway) asks the shared end, as before L13.
  assert.equal(globalCooldownEndFor(sink, { startRecoveryTime: 1500 }), 0);
  gcd.sent(116, 4, 3000);
  assert.equal(globalCooldownEndFor(sink, { startRecoveryTime: 1500 }), 4500);
  assert.equal(globalCooldownEndFor(sink, { startRecoveryTime: 0 }), 0);
  assert.equal(globalCooldownEndFor(sink, undefined), 0);
});

test("L13: an older gateway's rows (no category) keep one end for every spell with a time", () => {
  const sink = { globalCooldownUntil: 0 };
  const gcd = new PredictedGlobalCooldown(sink, () => SPELLS);
  gcd.sent(1953, 1, 1000);
  assert.equal(sink.globalCooldownUntil, 2000, "an unknown category is the shared end");
  assert.equal(globalCooldownEndFor(sink, SPELLS.get(133)), 2000);
  assert.equal(globalCooldownEndFor(sink, SPELLS.get(12472)), 0, "no time: never held, as before");
  // A known-category row is held by a prediction of unknown category unless it is category 0.
  assert.equal(globalCooldownEndFor(sink, CATEGORY_ROWS.get(48941)), 2000);
  assert.equal(globalCooldownEndFor(sink, CATEGORY_ROWS.get(45469)), 0);
});

test("L13: a value written by someone else holds every category but 0; a reset clears them", () => {
  const sink = { globalCooldownUntil: 0 };
  const gcd = new PredictedGlobalCooldown(sink, () => CATEGORY_ROWS);
  gcd.sent(48941, 1, 1000);
  gcd.accepted(48941, 1);
  sink.globalCooldownUntil = 9000; // a test, or the world's reset
  assert.deepEqual([133, 7744, 48941, 45469].map((id) => globalCooldownEndFor(sink, CATEGORY_ROWS.get(id))), [9000, 9000, 9000, 0]);
  sink.globalCooldownUntil = 0; // clearWorldContext
  assert.deepEqual([133, 48941].map((id) => globalCooldownEndFor(sink, CATEGORY_ROWS.get(id))), [0, 0],
    "the confirmed category-38 end goes with the reset");
  // Without a model at all: the value stands for every category but 0.
  const bare = { globalCooldownUntil: 7000 };
  assert.deepEqual([133, 48941, 45469].map((id) => globalCooldownEndFor(bare, CATEGORY_ROWS.get(id))), [7000, 7000, 0]);
});

test("L13: the guard over a live prediction — category 0 and 38 do not hold 133 spells; 133 holds Воля Отрекшихся", async () => {
  const { game } = await import("../dist/code/browser/game/Context.js");
  const { spellCastBlockReason } = await import("../dist/code/browser/SpellCastGuard.js");
  const SELF = 0x10n;
  const rows = new Map([...CATEGORY_ROWS].map(([id, columns]) => [id, {
    id, name: `spell ${id}`, passive: false, recoveryTime: 0, categoryRecoveryTime: 0,
    powerType: 0, powerCost: 0, powerCostPercent: 0, schoolMask: 1, spellClassMask: [0, 0, 0],
    dmgClass: 1, attributes: [0, 0, 0, 0, 0, 0, 0, 0], ...columns,
  }]));
  const { client } = await travelClient([
    { opcode: OPCODES.SMSG_INITIAL_SPELLS, payload: initialSpellsPacket({ spells: [...rows.keys()] }) },
  ], SELF);
  const saved = { world: game.world, spells: game.spells, gcd: game.globalCooldownUntil };
  game.world = client;
  game.spells = rows;
  game.globalCooldownUntil = 0;
  let clock = 10_000;
  const offs = attachPredictedGlobalCooldown(client, game, () => game.spells, () => true, () => clock);
  const reason = (id, at) => spellCastBlockReason(client, id, at);
  try {
    client.castSpell(45469);
    assert.equal(game.globalCooldownUntil, 0, "Удар смерти (0/1500) starts no global cooldown");
    assert.equal(reason(133, 10_001), undefined, "so a fireball right after it goes out (the realm takes it)");
    client.castSpell(48941);
    assert.equal(reason(133, 10_002), undefined, "Аура благочестия (38) does not hold a 133 spell");
    assert.equal(reason(48941, 10_002), "global-cooldown", "but holds its own category");
    client.castSpell(133);
    assert.equal(reason(7744, 10_003), "global-cooldown", "Воля Отрекшихся (133/0) waits for the 133 one");
    assert.equal(reason(116, 10_003), "global-cooldown");
    assert.equal(reason(61193, 10_003), undefined, "category 0 is never held");
    assert.equal(reason(2139, 10_003), undefined);
    assert.equal(reason(7744, 11_500), undefined, "free when it ends");
  } finally {
    for (const off of offs) off();
    game.world = saved.world;
    game.spells = saved.spells;
    game.globalCooldownUntil = saved.gcd;
    client.close?.();
  }
});

test("L13: a detached model no longer answers for its sink — the shared end stands alone", () => {
  const handlers = new Map();
  const world = { events: { on(name, handler) { handlers.set(name, handler); return () => handlers.delete(name); } } };
  const sink = { globalCooldownUntil: 0 };
  const offs = attachPredictedGlobalCooldown(world, sink, () => CATEGORY_ROWS, () => true, () => 1000);
  handlers.get("SPELL_CAST_SENT")({ spellId: 48941, castCount: 1 });
  handlers.get("SPELL_CAST_SENT")({ spellId: 133, castCount: 2 });
  assert.equal(sink.globalCooldownUntil, 2500);
  assert.equal(globalCooldownEndFor(sink, CATEGORY_ROWS.get(48941)), 2500, "category 38: the model's own end");
  assert.equal(globalCooldownEndFor(sink, CATEGORY_ROWS.get(45469)), 0);
  for (const off of offs) off();
  sink.globalCooldownUntil = 1500; // what the world's next writer leaves
  assert.equal(globalCooldownEndFor(sink, CATEGORY_ROWS.get(48941)), 1500,
    "no model: the sink's value for every category (an attached model would still hold 38 to 2500)");
  assert.equal(globalCooldownEndFor(sink, CATEGORY_ROWS.get(45469)), 0, "but never category 0");
  assert.equal(handlers.size, 0, "every subscription let go");
});

// L13-review (04.10), 5.30: what the sweeps read from the same model. Wow.exe's GetSpellCooldown/GetActionCooldown
// (0x00807980) answer the global part of the history entry whose category is the spell's — that entry's start and
// its own length — so a 133 spell with no time of its own (Воля Отрекшихся) shows the running 133 sweep, a
// category-0 spell none, a category-38 spell only a 38 one, and a 1500-ms button under a 1000-ms global cooldown
// the 1000-ms sweep. `globalCooldownSpanFor` is that entry's length (0 when no entry of the model holds the row).
const { globalCooldownSpanFor, globalCooldownRevision } = await import("../dist/code/browser/game/PredictedGlobalCooldown.js");

test("L13-review 5.30: the span is the holding global cooldown's own length, by category", () => {
  const rows = new Map([...CATEGORY_ROWS, [1752, { startRecoveryCategory: 133, startRecoveryTime: 1000 }]]); // Коварный удар
  const sink = { globalCooldownUntil: 0 };
  const gcd = new PredictedGlobalCooldown(sink, () => rows);
  const span = (id) => globalCooldownSpanFor(sink, rows.get(id));
  assert.deepEqual([116, 7744, 48941, 45469].map(span), [0, 0, 0, 0], "nothing running");
  gcd.sent(1752, 1, 1000);
  assert.deepEqual([116, 7744, 48941, 45469, 2139].map(span), [1000, 1000, 0, 0, 0],
    "the 1000-ms 133 entry holds Ледяная стрела and Воля Отрекшихся for its own 1000 ms");
  gcd.sent(48941, 2, 1200);
  assert.deepEqual([116, 48941].map(span), [1000, 1500], "38 has its own entry");
  gcd.sent(116, 3, 1500);
  assert.deepEqual([7744, 1752].map(span), [1500, 1500], "the later 133 entry decides");
  gcd.accepted(116, 3);
  assert.equal(span(7744), 1500, "confirmed, the length stays");
  gcd.refused(48941, 2);
  assert.equal(span(48941), 0);
  // A row without the column (an older gateway) reads the shared entry, as its end does.
  assert.equal(globalCooldownSpanFor(sink, { startRecoveryTime: 1500 }), 1500);
  assert.equal(globalCooldownSpanFor(sink, { startRecoveryTime: 0 }), 0);
  assert.equal(globalCooldownSpanFor(sink, undefined), 0);
  // A value written by someone else has no known length.
  sink.globalCooldownUntil = 9000;
  assert.equal(globalCooldownEndFor(sink, rows.get(7744)), 9000);
  assert.equal(span(7744), 0, "unknown: the caller's own fallback");
  assert.equal(globalCooldownSpanFor({ globalCooldownUntil: 5000 }, rows.get(116)), 0, "no model");
});

test("L13-review 5.30: the revision moves with any category's end — a 38 request too — not with an acceptance", () => {
  const sink = { globalCooldownUntil: 0 };
  const gcd = new PredictedGlobalCooldown(sink, () => CATEGORY_ROWS);
  const first = globalCooldownRevision(sink);
  gcd.sent(45469, 1, 1000);
  assert.equal(globalCooldownRevision(sink), first, "category 0 predicts nothing");
  gcd.sent(48941, 2, 1000);
  const afterAura = globalCooldownRevision(sink);
  assert.notEqual(afterAura, first, "a 38 request moved its category's end (the shared end did not)");
  assert.equal(sink.globalCooldownUntil, 0);
  gcd.accepted(48941, 2);
  assert.equal(globalCooldownRevision(sink), afterAura, "the acceptance changes no end");
  gcd.sent(133, 3, 1100);
  const afterBolt = globalCooldownRevision(sink);
  assert.notEqual(afterBolt, afterAura);
  gcd.refused(133, 3);
  assert.notEqual(globalCooldownRevision(sink), afterBolt, "the refusal took an end back");
  const beforeWrite = globalCooldownRevision(sink);
  sink.globalCooldownUntil = 7000;
  assert.notEqual(globalCooldownRevision(sink), beforeWrite, "a value written by someone else");
  assert.equal(globalCooldownRevision({ globalCooldownUntil: 4321 }), 4321, "no model: the sink's own value");
});
