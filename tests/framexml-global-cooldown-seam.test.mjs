// Plan item 5.30 (L12, 04.10): the stock UI's view of the global cooldown over LiveWorldSeam.
// Wow.exe raises ACTIONBAR_UPDATE_COOLDOWN (0x005a7cc0) and SPELL_UPDATE_COOLDOWN (0x0053bac0) right after a
// request writes its history entry (0x00805d70), and GetSpellCooldown/GetActionCooldown (0x00807980) answer
// the global part beside the spell's own timer, the later end winning.
import assert from "node:assert/strict";
import test from "node:test";

const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS, FRAMEXML_SEAM_EVENTS } =
  await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { ACTION_BUTTON_SPELL } = await import("../dist/code/world/ActionBarProtocol.js");

const SPELLS = new Map([
  [133, { id: 133, name: "Огненный шар", rank: "", iconPath: "x", passive: false, hidden: false, startRecoveryTime: 1500 }],
  [12472, { id: 12472, name: "Стылая кровь", rank: "", iconPath: "y", passive: false, hidden: false, startRecoveryTime: 0 }],
]);

function fixture() {
  const fired = [];
  const clock = { monotonic: 100_000, lua: 500 };
  const gcd = { until: 0 };
  const world = {
    state: { selfGuid: 1n, objects: new Map([[1n, { guid: 1n, typeId: 4, fields: new Map() }]]) },
    knownSpells: [{ id: 133, slot: 0 }, { id: 12472, slot: 1 }],
    actionButtons: [
      { slot: 12, action: 133, type: ACTION_BUTTON_SPELL },
      { slot: 13, action: 12472, type: ACTION_BUTTON_SPELL },
    ],
    casts: new Map(), cooldownSnapshots: new Map(), itemCooldowns: new Map(), mirrorTimers: new Map(),
    itemTemplates: new Map(),
    cooldownRemaining: (id, now) => Math.max(0, (world.cooldownSnapshots.get(id)?.endsAt ?? 0) - now),
    cooldownState: (id) => {
      const snapshot = world.cooldownSnapshots.get(id);
      return snapshot && snapshot.endsAt > clock.monotonic ? snapshot : undefined;
    },
    isActiveMountSpell: () => false,
    events: { on: () => () => {} },
  };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: (id) => SPELLS.get(id),
    monotonic: () => clock.monotonic, globalCooldownUntil: () => gcd.until, castSpell: () => {},
  });
  const pump = { now: () => clock.lua, fire: (name, ...args) => { fired.push([name, ...args]); return 1; } };
  return { seam, world, fired, clock, gcd, pump };
}

const call = (seam, name, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);
const edges = (fired) => fired.filter(([name]) => name === FRAMEXML_SEAM_EVENTS.actionCooldown
  || name === FRAMEXML_SEAM_EVENTS.spellUpdateCooldown).map(([name]) => name);

test("a moved end raises ACTIONBAR_UPDATE_COOLDOWN and SPELL_UPDATE_COOLDOWN once; counting down raises nothing", () => {
  const { seam, fired, clock, gcd, pump } = fixture();
  seam.attach(pump);
  try {
    seam.tick(clock.lua);
    fired.length = 0;
    gcd.until = clock.monotonic + 1500; // the request left
    seam.tick(clock.lua);
    assert.deepEqual(edges(fired), ["ACTIONBAR_UPDATE_COOLDOWN", "SPELL_UPDATE_COOLDOWN"]);
    fired.length = 0;
    clock.monotonic += 400;
    clock.lua += 0.4;
    seam.tick(clock.lua);
    assert.deepEqual(edges(fired), [], "running down is the Cooldown frame's own business");
    gcd.until = 0; // the realm refused it
    seam.tick(clock.lua);
    assert.deepEqual(edges(fired), ["ACTIONBAR_UPDATE_COOLDOWN", "SPELL_UPDATE_COOLDOWN"], "the sweep is taken back");
  } finally {
    seam.detach();
  }
});

test("GetSpellCooldown and GetActionCooldown answer the global part, never a start in the future", () => {
  const { seam, clock, gcd, pump } = fixture();
  seam.attach(pump);
  try {
    assert.deepEqual(call(seam, "GetSpellCooldown", 1, "spell"), [0, 0, 1], "ready");
    gcd.until = clock.monotonic + 1500;
    assert.deepEqual(call(seam, "GetSpellCooldown", 1, "spell"), [500, 1.5, 1]);
    assert.deepEqual(call(seam, "GetActionCooldown", 13), [500, 1.5, 1]);
    assert.deepEqual(call(seam, "GetSpellCooldown", 2, "spell"), [0, 0, 1], "a spell off the global cooldown");
    assert.deepEqual(call(seam, "GetActionCooldown", 14), [0, 0, 0]);
    clock.monotonic += 500;
    clock.lua += 0.5;
    assert.deepEqual(call(seam, "GetSpellCooldown", 1, "spell"), [500, 1.5, 1], "the start stays put");
    // A longer end than this spell's own global part: the sweep starts now and runs what is left.
    gcd.until = clock.monotonic + 2000;
    assert.deepEqual(call(seam, "GetActionCooldown", 13), [clock.lua, 2, 1]);
    assert.deepEqual(call(seam, "GetSpellCooldown", 1, "spell"), [clock.lua, 2, 1]);
  } finally {
    seam.detach();
  }
});

// L12-review: the sweep of a hasted global cooldown starts at the request and runs the realm's duration
// (Wow.exe's history entry: start = send, duration = StartRecoveryTime × cast speed, 0x00805d70), not a
// 1.5 s sweep begun in the past.
test("a hasted global cooldown: the sweep starts at the request and runs the hasted duration", async () => {
  const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
  const { seam, world, clock, gcd, pump } = fixture();
  const speed = new DataView(new ArrayBuffer(4));
  speed.setFloat32(0, 0.8, true);
  world.state.objects.get(1n).fields.set(UPDATE_FIELDS.UNIT_MOD_CAST_SPEED.offset, speed.getUint32(0, true));
  world.spellModifiers = new Map();
  SPELLS.set(133, { ...SPELLS.get(133), dmgClass: 1, attributes: [0, 0, 0, 0, 0, 0, 0, 0], spellClassMask: [0, 0, 0] });
  seam.attach(pump);
  try {
    gcd.until = clock.monotonic + 1200; // Огненный шар sent now at cast speed 0.8
    assert.deepEqual(call(seam, "GetActionCooldown", 13), [500, 1.2, 1]);
    assert.deepEqual(call(seam, "GetSpellCooldown", 1, "spell"), [500, 1.2, 1]);
    clock.monotonic += 300;
    clock.lua += 0.3;
    assert.deepEqual(call(seam, "GetActionCooldown", 13), [500, 1.2, 1], "the start stays put");
  } finally {
    seam.detach();
    SPELLS.set(133, { id: 133, name: "Огненный шар", rank: "", iconPath: "x", passive: false, hidden: false, startRecoveryTime: 1500 });
  }
});

// L13-review (04.10), 5.30: with `/dbc/spells?v=17`'s StartRecoveryCategory the seam answers the global part of the
// entry whose category is the spell's (Wow.exe 0x00807980), from the page's model (`globalCooldown`, the
// game/PredictedGlobalCooldown.ts view): its end and its own length. And the redraw edge follows any category's
// change — a category-38 request moves no shared end, yet Wow.exe raises the two events after every history write.
test("L13-review 5.30: by category — 133/0 shows the 133 entry, 0 nothing, 38 only its own; a 38 request redraws", async () => {
  const { PredictedGlobalCooldown, globalCooldownView } = await import("../dist/code/browser/game/PredictedGlobalCooldown.js");
  const rows = new Map([
    [1752, { id: 1752, name: "Коварный удар", rank: "", iconPath: "a", passive: false, hidden: false, startRecoveryCategory: 133, startRecoveryTime: 1000 }],
    [7744, { id: 7744, name: "Воля Отрекшихся", rank: "", iconPath: "b", passive: false, hidden: false, startRecoveryCategory: 133, startRecoveryTime: 0 }],
    [45469, { id: 45469, name: "Удар смерти", rank: "", iconPath: "c", passive: false, hidden: false, startRecoveryCategory: 0, startRecoveryTime: 1500 }],
    [48941, { id: 48941, name: "Аура благочестия", rank: "", iconPath: "d", passive: false, hidden: false, startRecoveryCategory: 38, startRecoveryTime: 1500 }],
  ]);
  const fired = [];
  const clock = { monotonic: 100_000, lua: 500 };
  const sink = { globalCooldownUntil: 0 };
  const model = new PredictedGlobalCooldown(sink, () => rows);
  const ids = [...rows.keys()];
  const world = {
    state: { selfGuid: 1n, objects: new Map([[1n, { guid: 1n, typeId: 4, fields: new Map() }]]) },
    knownSpells: ids.map((id, slot) => ({ id, slot })),
    actionButtons: ids.map((action, index) => ({ slot: 12 + index, action, type: ACTION_BUTTON_SPELL })),
    casts: new Map(), cooldownSnapshots: new Map(), itemCooldowns: new Map(), mirrorTimers: new Map(),
    itemTemplates: new Map(),
    cooldownRemaining: () => 0, cooldownState: () => undefined, isActiveMountSpell: () => false,
    events: { on: () => () => {} },
  };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: (id) => rows.get(id),
    monotonic: () => clock.monotonic, globalCooldownUntil: () => sink.globalCooldownUntil, castSpell: () => {},
    globalCooldown: globalCooldownView(sink),
  });
  const pump = { now: () => clock.lua, fire: (name, ...args) => { fired.push([name, ...args]); return 1; } };
  seam.attach(pump);
  const action = (id) => call(seam, "GetActionCooldown", 13 + ids.indexOf(id));
  const book = (id) => call(seam, "GetSpellCooldown", 1 + ids.indexOf(id), "spell");
  try {
    seam.tick(clock.lua);
    fired.length = 0;
    model.sent(1752, 1, clock.monotonic); // a 1000-ms 133 global cooldown
    seam.tick(clock.lua);
    assert.deepEqual(edges(fired), ["ACTIONBAR_UPDATE_COOLDOWN", "SPELL_UPDATE_COOLDOWN"]);
    assert.deepEqual(action(7744), [500, 1, 1], "Воля Отрекшихся: the running 133 entry, its own length");
    assert.deepEqual(book(7744), [500, 1, 1]);
    assert.deepEqual([action(45469), book(45469)], [[0, 0, 0], [0, 0, 1]], "category 0: none");
    assert.deepEqual([action(48941), book(48941)], [[0, 0, 0], [0, 0, 1]], "category 38: not the 133 one");
    clock.monotonic += 250;
    clock.lua += 0.25;
    fired.length = 0;
    model.sent(48941, 2, clock.monotonic);
    assert.equal(sink.globalCooldownUntil, 101_000, "the shared end did not move");
    seam.tick(clock.lua);
    assert.deepEqual(edges(fired), ["ACTIONBAR_UPDATE_COOLDOWN", "SPELL_UPDATE_COOLDOWN"], "yet the 38 sweep is drawn");
    assert.deepEqual(action(48941), [clock.lua, 1.5, 1]);
    assert.deepEqual(action(1752), [500, 1, 1], "the 133 rows keep theirs");
    fired.length = 0;
    model.accepted(48941, 2);
    seam.tick(clock.lua);
    assert.deepEqual(edges(fired), [], "the acceptance moves no end: no redraw");
  } finally {
    seam.detach();
  }
});

test("the spell's own timer and the global part: the one that ends later is answered", () => {
  const { seam, world, clock, gcd, pump } = fixture();
  seam.attach(pump);
  try {
    gcd.until = clock.monotonic + 1500;
    // Its own timer ends in 0.5 s (8 s long): the global part ends later.
    world.cooldownSnapshots.set(133, { startedAt: clock.monotonic - 7500, duration: 8000, endsAt: clock.monotonic + 500 });
    assert.deepEqual(call(seam, "GetSpellCooldown", 1, "spell"), [500, 1.5, 1]);
    assert.deepEqual(call(seam, "GetActionCooldown", 13), [500, 1.5, 1]);
    // Its own timer ends in 5 s: that one.
    world.cooldownSnapshots.set(133, { startedAt: clock.monotonic - 3000, duration: 8000, endsAt: clock.monotonic + 5000 });
    assert.deepEqual(call(seam, "GetSpellCooldown", 1, "spell"), [497, 8, 1]);
    assert.deepEqual(call(seam, "GetActionCooldown", 13), [497, 8, 1]);
  } finally {
    seam.detach();
  }
});
