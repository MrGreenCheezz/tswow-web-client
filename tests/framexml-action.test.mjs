import assert from "node:assert/strict";
import test from "node:test";

// Merged 2026-10-20 from 3 files; each block below is one former file,
// kept in its own scope so its helpers and module loads stay as they were.

// ── framexml-action-range.test.mjs
{
// Plan item 1.14b: IsActionInRange as Wow.exe 0x005a9d50 → 0x005a94c0 → 0x00809610 → 0x00803850 answers
// it (FrameXmlActionRange.ts), over the `/dbc/spells?v=14` columns. Synthetic units; real SpellRange
// rows of this dataset (2 melee 0..5 flag 1, 4 0..30, 114 0..35 flag 2, 159 hostile 40 / friendly 100).

const range = await import("../dist/code/browser/framexml/FrameXmlActionRange.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { REACTION_FRIENDLY, REACTION_HOSTILE, REACTION_NEUTRAL } = await import("../dist/code/world/FactionRules.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");

const F = (name) => UPDATE_FIELDS[name].offset;
const bits = (value) => new DataView(Float32Array.of(value).buffer).getUint32(0, true);

let nextGuid = 0x100n;
function unit({ player = false, x = 0, y = 0, z = 0, reach = 1.5, health = 100, flags = 0, pvp = 0, dyn = 0, faction = 1, entry = 0, moving = 0 } = {}) {
  const fields = new Map([
    [F("UNIT_FIELD_HEALTH"), health], [F("UNIT_FIELD_FLAGS"), (player ? 0x8 : 0) | flags],
    [F("UNIT_FIELD_COMBATREACH"), bits(reach)], [F("UNIT_FIELD_BYTES_2"), pvp << 8],
    [F("UNIT_DYNAMIC_FLAGS"), dyn], [F("UNIT_FIELD_FACTIONTEMPLATE"), faction], [F("OBJECT_FIELD_ENTRY"), entry],
  ]);
  return { guid: nextGuid++, typeId: player ? 4 : 3, position: { x, y, z }, movementFlags: moving, fields };
}

function host(objects, extra = {}) {
  const byGuid = new Map(objects.map((object) => [object.guid, object]));
  return {
    object: (guid) => byGuid.get(guid),
    // Faction 1 is the player's side, 2 hostile, 3 neutral.
    reaction: (left, right) => {
      const a = left.fields.get(F("UNIT_FIELD_FACTIONTEMPLATE"));
      const b = right.fields.get(F("UNIT_FIELD_FACTIONTEMPLATE"));
      if (a === b) return REACTION_FRIENDLY;
      return a === 3 || b === 3 ? REACTION_NEUTRAL : REACTION_HOSTILE;
    },
    creatureType: (object) => object.typeId === 4 ? 7 : (extra.types?.get(object.guid) ?? 0),
    creatureTypeFlags: (object) => extra.typeFlags?.get(object.guid) ?? 0,
    selfGuid: objects[0]?.guid,
    inParty: (guid) => extra.party?.has(guid) ?? false,
    inRaid: (guid) => extra.party?.has(guid) ?? false,
    rangedModRange: () => extra.rangedModRange,
    playerSpellFamily: () => extra.family,
    spellModifiers: () => extra.mods ?? [],
  };
}

const SPELL = { targets: 0, implicitTargetB: [0, 0, 0], targetCreatureType: 0, attributes: [0, 0, 0, 0, 0, 0, 0, 0],
  effectAura: [0, 0, 0], rangeFlags: 0, spellClassSet: 0, spellClassMask: [0, 0, 0] };
const FIREBALL = { ...SPELL, implicitTargetA: [6, 0, 0], rangeMin: 0, rangeMax: 35, rangeMinFriendly: 0, rangeMaxFriendly: 35,
  spellClassSet: 3, spellClassMask: [1, 0, 0] };
const HEAL = { ...SPELL, implicitTargetA: [21, 0, 0], rangeMin: 0, rangeMax: 40, rangeMinFriendly: 0, rangeMaxFriendly: 40 };
const REND = { ...SPELL, implicitTargetA: [6, 0, 0], rangeMin: 0, rangeMax: 5, rangeMinFriendly: 0, rangeMaxFriendly: 5, rangeFlags: 1 };
const AUTO_SHOT = { ...SPELL, implicitTargetA: [6, 0, 0], rangeMin: 0, rangeMax: 35, rangeMinFriendly: 0, rangeMaxFriendly: 35,
  rangeFlags: 2, attributes: [0x2, 0, 0, 0, 0, 0, 0, 0] };
const SELF_BUFF = { ...SPELL, implicitTargetA: [1, 0, 0], rangeMin: 0, rangeMax: 0, rangeMinFriendly: 0, rangeMaxFriendly: 0 };

test("old rows, no target, a self-only spell: nil", () => {
  const me = unit({ player: true });
  const enemy = unit({ faction: 2, x: 10 });
  const world = host([me, enemy]);
  assert.equal(range.frameXmlActionInRange({ ...FIREBALL, implicitTargetA: undefined }, me, enemy, world), undefined,
    "a gateway older than /dbc/spells?v=14");
  assert.equal(range.frameXmlActionInRange(FIREBALL, me, undefined, world), undefined);
  assert.equal(range.frameXmlActionInRange(SELF_BUFF, me, enemy, world), undefined);
  assert.equal(range.frameXmlActionInRange(undefined, me, enemy, world), undefined);
});

test("a harmful spell: 1 inside max + both reaches, 0 beyond, nil on a friend", () => {
  const me = unit({ player: true });
  const near = unit({ faction: 2, x: 37.9 });
  const far = unit({ faction: 2, x: 38.1 });
  const friend = unit({ faction: 1, x: 10 });
  const world = host([me, near, far, friend]);
  assert.equal(range.frameXmlActionInRange(FIREBALL, me, near, world), 1, "35 + 1.5 + 1.5");
  assert.equal(range.frameXmlActionInRange(FIREBALL, me, far, world), 0);
  assert.equal(range.frameXmlActionInRange(FIREBALL, me, friend, world), undefined);
  const neutral = unit({ faction: 3, x: 5 });
  assert.equal(range.frameXmlActionInRange(FIREBALL, me, neutral, host([me, neutral])), 1, "a neutral creature is attackable");
});

test("a helpful spell: friends and the player, not enemies; the friendly SpellRange slot", () => {
  const me = unit({ player: true });
  const ally = unit({ player: true, faction: 1, x: 42 });
  const enemy = unit({ player: true, faction: 2, x: 5, pvp: 1 });
  const world = host([me, ally, enemy]);
  assert.equal(range.frameXmlActionInRange(HEAL, me, ally, world), 1);
  assert.equal(range.frameXmlActionInRange(HEAL, me, me, world), 1, "the caster itself");
  assert.equal(range.frameXmlActionInRange(HEAL, me, enemy, world), undefined);
  // Row 159: hostile 40, friendly 100 yards.
  const row159 = { ...HEAL, rangeMax: 40, rangeMaxFriendly: 100 };
  const distant = unit({ player: true, faction: 1, x: 90 });
  assert.equal(range.frameXmlActionInRange(row159, me, distant, host([me, distant])), 1, "the friendly slot");
  assert.equal(range.frameXmlActionInRange({ ...row159, rangeMaxFriendly: undefined }, me, distant, host([me, distant])), 0,
    "without the friendly slot the hostile one");
});

test("a player cannot assist a creature that is not PvP-flagged unless its template allows (0x007293d0)", () => {
  const me = unit({ player: true });
  const guard = unit({ faction: 1, x: 5 });
  assert.equal(range.frameXmlActionInRange(HEAL, me, guard, host([me, guard])), undefined);
  assert.equal(range.frameXmlActionInRange(HEAL, me, guard, host([me, guard], { typeFlags: new Map([[guard.guid, 0x1000]]) })), 1);
  const flagged = unit({ faction: 1, x: 5, pvp: 1 });
  assert.equal(range.frameXmlActionInRange(HEAL, me, flagged, host([me, flagged])), 1);
});

test("melee rows: max(5, reach + reach + 4/3), no max of their own; next-swing spells 100", () => {
  const me = unit({ player: true });
  const small = unit({ faction: 2, x: 4.9 });
  const smallFar = unit({ faction: 2, x: 5.1 });
  const big = unit({ faction: 2, x: 5.8, reach: 3 });
  const world = host([me, small, smallFar, big]);
  assert.equal(range.frameXmlActionInRange(REND, me, small, world), 1);
  assert.equal(range.frameXmlActionInRange(REND, me, smallFar, world), 0);
  assert.equal(range.frameXmlActionInRange(REND, me, big, world), 1, "3 + 1.5 + 4/3 = 5.83");
  const nextSwing = { ...REND, attributes: [0x400, 0, 0, 0, 0, 0, 0, 0] };
  const away = unit({ faction: 2, x: 99 });
  assert.equal(range.frameXmlActionInRange(nextSwing, me, away, host([me, away])), 1, "ON_NEXT_SWING: 100 yards");
});

test("ranged rows: a dead zone of max(5, reaches + 4/3); the weapon's RangedModRange scales the max", () => {
  const me = unit({ player: true });
  const close = unit({ faction: 2, x: 4 });
  const mid = unit({ faction: 2, x: 30 });
  const edge = unit({ faction: 2, x: 37 });
  const objects = [me, close, mid, edge];
  assert.equal(range.frameXmlActionInRange(AUTO_SHOT, me, close, host(objects, { rangedModRange: 100 })), 0, "inside 5 yards");
  assert.equal(range.frameXmlActionInRange(AUTO_SHOT, me, mid, host(objects, { rangedModRange: 100 })), 1);
  assert.equal(range.frameXmlActionInRange(AUTO_SHOT, me, edge, host(objects, { rangedModRange: 100 })), 1, "35 + 3 reach");
  assert.equal(range.frameXmlActionInRange(AUTO_SHOT, me, edge, host(objects, { rangedModRange: 80 })), 0, "28 + 3");
  assert.equal(range.frameXmlActionInRange(AUTO_SHOT, me, edge, host(objects, {})), 1, "no weapon read: the row");
});

test("SPELLMOD_RANGE for the player's family and the mask bit; moving leeway", () => {
  const me = unit({ player: true });
  const target = unit({ faction: 2, x: 41 });
  const objects = [me, target];
  assert.equal(range.frameXmlActionInRange(FIREBALL, me, target, host(objects)), 0);
  const mods = [{ effectIndex: 0, op: 5, value: 10, pct: true }];
  assert.equal(range.frameXmlActionInRange(FIREBALL, me, target, host(objects, { family: 3, mods })), 1, "35 × 110% + 3 = 41.5");
  assert.equal(range.frameXmlActionInRange(FIREBALL, me, target, host(objects, { family: 4, mods })), 0, "another family");
  assert.equal(range.frameXmlActionInRange(FIREBALL, me, target, host(objects, { family: 3, mods: [{ ...mods[0], effectIndex: 1 }] })), 0,
    "a bit the spell does not carry");
  assert.equal(range.frameXmlActionInRange({ ...FIREBALL, attributes: [0, 0, 0, 0x20000000, 0, 0, 0, 0] }, me, target,
    host(objects, { family: 3, mods })), 0, "SPELL_ATTR3 0x20000000 ignores caster modifiers");
  // Both moving, target a player: 8/3 more.
  const runner = unit({ player: true, faction: 2, pvp: 1, x: 40, moving: 1 });
  const meRunning = unit({ player: true, moving: 1 });
  assert.equal(range.frameXmlActionInRange(FIREBALL, meRunning, runner, host([meRunning, runner])), 1, "38 + 2.67");
  const walking = unit({ player: true, moving: 0x101 });
  assert.equal(range.frameXmlActionInRange(FIREBALL, walking, runner, host([walking, runner])), 0, "walking: no leeway");
});

test("target checks: creature type, dead units, untargetable, party-only spells", () => {
  const me = unit({ player: true });
  const beast = unit({ faction: 2, x: 5 });
  const types = new Map([[beast.guid, 1]]);
  const hibernate = { ...FIREBALL, targetCreatureType: 0x1 | 0x2 };
  assert.equal(range.frameXmlActionInRange(hibernate, me, beast, host([me, beast], { types })), 1);
  assert.equal(range.frameXmlActionInRange({ ...hibernate, targetCreatureType: 0x4 }, me, beast, host([me, beast], { types })), undefined);
  const corpse = unit({ faction: 2, x: 5, health: 0, dyn: 0x20 });
  const dead = unit({ faction: 2, x: 5, health: 0 });
  assert.equal(range.frameXmlActionInRange(FIREBALL, me, dead, host([me, dead])), undefined, "dead, no corpse flag");
  assert.equal(range.frameXmlActionInRange(FIREBALL, me, corpse, host([me, corpse])), 1, "UNIT_DYNFLAG_DEAD: still checked");
  const warded = unit({ faction: 2, x: 5, flags: 0x10000 });
  assert.equal(range.frameXmlActionInRange(FIREBALL, me, warded, host([me, warded])), undefined, "NON_ATTACKABLE_2");
  assert.equal(range.frameXmlActionInRange({ ...FIREBALL, attributes: [0, 0, 0, 0, 0, 0, 0x1000000, 0] }, me, warded, host([me, warded])), undefined,
    "SPELL_ATTR6 0x1000000 passes the first gate, but the unit is still not attackable (0x00729740)");
  const wardedAlly = unit({ player: true, faction: 1, x: 5, flags: 0x10000 });
  assert.equal(range.frameXmlActionInRange(HEAL, me, wardedAlly, host([me, wardedAlly])), undefined);
  assert.equal(range.frameXmlActionInRange({ ...HEAL, attributes: [0, 0, 0, 0, 0, 0, 0x1000000, 0] }, me, wardedAlly,
    host([me, wardedAlly])), 1, "an untargetable ally with SPELL_ATTR6 0x1000000");
  const partySpell = { ...HEAL, implicitTargetA: [35, 0, 0] };
  const mate = unit({ player: true, faction: 1, x: 5 });
  assert.equal(range.frameXmlActionInRange(partySpell, me, mate, host([me, mate])), undefined, "not in the party");
  assert.equal(range.frameXmlActionInRange(partySpell, me, mate, host([me, mate], { party: new Set([mate.guid]) })), 1);
});

test("the seam: IsActionInRange by slot, current target or a named unit, 1/0/nil", () => {
  const me = unit({ player: true });
  const enemy = unit({ faction: 2, x: 20 });
  const far = unit({ faction: 2, x: 60 });
  const world = {
    state: { selfGuid: me.guid, objects: new Map([[me.guid, me], [enemy.guid, enemy], [far.guid, far]]) },
    actionButtons: [{ slot: 0, action: 133, type: 0 }, { slot: 1, action: 99999, type: 0 }],
    casts: new Map(),
    cooldownRemaining: () => 0,
    targetGuid: enemy.guid,
    itemTemplates: new Map(),
    creatureTemplates: new Map(),
    spellModifiers: new Map(),
  };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: (id) => (id === 133 ? FIREBALL : undefined),
    monotonic: () => 1000, globalCooldownUntil: () => 0, castSpell: () => {},
    reaction: (left, right) => left.fields.get(F("UNIT_FIELD_FACTIONTEMPLATE")) === right.fields.get(F("UNIT_FIELD_FACTIONTEMPLATE"))
      ? REACTION_FRIENDLY : REACTION_HOSTILE,
  });
  const ask = (...args) => [...FRAMEXML_SEAM_BINDINGS.IsActionInRange(seam, args)];
  assert.deepEqual(ask(1), [1]);
  assert.deepEqual(ask(2), [], "no spell row: nil");
  assert.deepEqual(ask(3), [], "an empty slot: nil");
  world.targetGuid = far.guid;
  assert.deepEqual(ask(1), [0]);
  assert.deepEqual(ask(1, "player"), [], "the player is no Fireball target");
  world.targetGuid = undefined;
  assert.deepEqual(ask(1), []);
  // Stock ActionButton_OnUpdate asks every button every 0.2 s: the three answers are shared frozen
  // arrays, so the binding allocates nothing of its own per call (review 30.09).
  const raw = (...args) => FRAMEXML_SEAM_BINDINGS.IsActionInRange(seam, args);
  world.targetGuid = enemy.guid;
  const inside = raw(1);
  assert.equal(inside === raw(1), true, "1 is one shared array");
  assert.equal(Object.isFrozen(inside), true);
  world.targetGuid = far.guid;
  const outside = raw(1);
  assert.equal(outside === raw(1), true, "0 is one shared array");
  assert.equal(Object.isFrozen(outside), true);
});
}

// ── framexml-action-repeat-seam.test.mjs
{
// Plan item 1.14 (slice a): IsAttackAction, IsAutoRepeatAction and IsCurrentAction for the attack
// button answer 1/nil from the live world, and START/STOP_AUTOREPEAT_SPELL follow the repeating spell
// (FrameXmlActionRepeat.ts; Wow.exe 0x5a9ba0/0x5a96d0, 0x5a9c10/0x5a9470, 0x5aad40/0x5aa240,
// 0x7fe140/0x800a00/0x807560).

const { FrameXmlAutoRepeatEdge, frameXmlIsAttackSpell, SPELL_EFFECT_ATTACK } =
  await import("../dist/code/browser/framexml/FrameXmlActionRepeat.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");

const SPELLS = new Map([
  [6603, { id: 6603, name: "Атака", effects: [78, 0, 0], autoRepeat: false }],
  [75, { id: 75, name: "Автоматическая стрельба", effects: [2, 0, 0], autoRepeat: true }],
  [5019, { id: 5019, name: "Выстрел", effects: [2, 0, 0], autoRepeat: true }],
  [133, { id: 133, name: "Огненный шар", effects: [2, 6, 0], autoRepeat: false }],
]);

function fixture() {
  const world = {
    state: { selfGuid: undefined, objects: new Map() },
    casts: new Map(),
    // Wire slots 0..3: Attack, Auto Shot, Shoot, Fireball.
    actionButtons: [
      { slot: 0, action: 6603, type: 0 },
      { slot: 1, action: 75, type: 0 },
      { slot: 2, action: 5019, type: 0 },
      { slot: 3, action: 133, type: 0 },
    ],
    cooldownRemaining: () => 0,
    autoRepeatSpellId: undefined,
    attacking: false,
    isActiveMountSpell: () => false,
  };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: (id) => SPELLS.get(id),
    monotonic: () => 1000, globalCooldownUntil: () => 0, castSpell: () => {},
  });
  const api = (name, ...args) => [...FRAMEXML_SEAM_BINDINGS[name](seam, args)];
  return { world, seam, api };
}

test("SPELL_EFFECT_ATTACK is 78 (SharedDefines.h:884)", () => {
  assert.equal(SPELL_EFFECT_ATTACK, 78);
});

test("IsAttackAction is 1 for a spell whose first effect is SPELL_EFFECT_ATTACK, nil otherwise", () => {
  const { api } = fixture();
  assert.deepEqual(api("IsAttackAction", 1), [1]);
  for (const slot of [2, 3, 4, 5]) assert.deepEqual(api("IsAttackAction", slot), [undefined], `slot ${slot}`);
  assert.equal(frameXmlIsAttackSpell({ effects: [0, SPELL_EFFECT_ATTACK, 0] }), false, "only the first effect counts");
  assert.equal(frameXmlIsAttackSpell(undefined), false);
});

test("IsAutoRepeatAction is 1 only for the spell being repeated", () => {
  const { world, api } = fixture();
  for (const slot of [1, 2, 3, 4]) assert.deepEqual(api("IsAutoRepeatAction", slot), [undefined], "nothing repeating");
  world.autoRepeatSpellId = 75;
  assert.deepEqual(api("IsAutoRepeatAction", 2), [1]);
  assert.deepEqual(api("IsAutoRepeatAction", 3), [undefined], "Shoot is not repeating while Auto Shot is");
  world.autoRepeatSpellId = 5019;
  assert.deepEqual(api("IsAutoRepeatAction", 2), [undefined]);
  assert.deepEqual(api("IsAutoRepeatAction", 3), [1]);
});

test("IsCurrentAction answers the attack button by auto-attack, 1 or nil (Wow.exe 0x5aad40)", () => {
  const { world, api } = fixture();
  assert.deepEqual(api("IsCurrentAction", 1), [undefined]);
  world.attacking = true;
  assert.deepEqual(api("IsCurrentAction", 1), [1]);
  assert.deepEqual(api("IsCurrentAction", 4), [undefined], "a spell that is not the attack is not current by melee");
});

test("START/STOP_AUTOREPEAT_SPELL fire once per change, each followed by ACTIONBAR_UPDATE_STATE", () => {
  const fired = [];
  const edge = new FrameXmlAutoRepeatEdge();
  edge.attach({ fire(event) { fired.push(event); return 1; } }, undefined);
  edge.sync(undefined);
  assert.deepEqual(fired, []);
  edge.sync(75);
  edge.sync(75);
  assert.deepEqual(fired, ["START_AUTOREPEAT_SPELL", "ACTIONBAR_UPDATE_STATE"]);
  edge.sync(5019);
  assert.deepEqual(fired.slice(2), ["START_AUTOREPEAT_SPELL", "ACTIONBAR_UPDATE_STATE"],
    "a new repeating spell starts again (0x800a00)");
  edge.sync(undefined);
  assert.deepEqual(fired.slice(4), ["STOP_AUTOREPEAT_SPELL", "ACTIONBAR_UPDATE_STATE"]);
  edge.detach();
  edge.sync(75);
  assert.equal(fired.length, 6, "detached: silent");

  const late = [];
  const mounted = new FrameXmlAutoRepeatEdge();
  mounted.attach({ fire(event) { late.push(event); return 1; } }, 75);
  mounted.sync(75);
  assert.deepEqual(late, [], "a mount during the repeat is not a start");
});

test("the live seam publishes the edges from its frame tick", () => {
  const { world, seam } = fixture();
  world.events = { on: () => () => {} };
  const fired = [];
  seam.attach({ fire: (event, ...args) => { fired.push([event, ...args]); return 1; }, now: () => 100 });
  const edges = () => fired.map(([event]) => event).filter((event) => /AUTOREPEAT/.test(event));
  seam.tick(1);
  assert.deepEqual(edges(), []);
  world.autoRepeatSpellId = 75;
  seam.tick(2);
  seam.tick(3);
  assert.deepEqual(edges(), ["START_AUTOREPEAT_SPELL"]);
  world.autoRepeatSpellId = undefined;
  seam.tick(4);
  assert.deepEqual(edges(), ["START_AUTOREPEAT_SPELL", "STOP_AUTOREPEAT_SPELL"]);
  seam.detach();
});
}

// ── framexml-action-usable.test.mjs
{
// 19.10: IsUsableAction / IsUsableSpell as Wow.exe 3.3.5a answers them (FrameXmlActionUsable.ts): the slot's spell
// passes Spell_C_IsUsableAction (0x0080b5d0) and is then short of power or not (0x008017e0); a cooldown is no gate;
// ACTIONBAR_UPDATE_USABLE is raised when a pair moves (CGActionBar::UpdateUsable 0x005aa470). The spell rows carry
// this dataset's own Spell.dbc words (1784 Stealth, 8676 Ambush, 2098 Eviscerate, 7384 Overpower, 2457 Battle Stance).

const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS, FRAMEXML_SEAM_EVENTS } =
  await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { ACTION_BUTTON_SPELL } = await import("../dist/code/world/ActionBarProtocol.js");

const SELF = 1n;
const TARGET = 50n;
const DAGGER = 7n;
const POWDER = 8n;

const row = (id, name, extra) => ({
  id, name, rank: "", iconPath: "", passive: false, spellLevel: 1, spellClassSet: 0, spellClassMask: [0, 0, 0],
  schoolMask: 1, powerType: 0, powerCost: 0, powerCostPercent: 0, recoveryTime: 0, categoryRecoveryTime: 0,
  effectAura: [0, 0, 0], effectMiscValue: [0, 0, 0], equippedItemClass: -1, equippedItemSubclass: 0, reagents: [],
  shapeshiftMask: [0, 0], shapeshiftExclude: [0, 0], ...extra,
});
const SPELLS = new Map([
  [133, row(133, "Огненный шар", { powerCost: 100, schoolMask: 4, attributes: [0x10000, 0, 0, 0, 0, 0, 0, 0] })],
  [1784, row(1784, "Незаметность", {
    attributes: [0x1a150010, 0x10, 0x200000, 0x4000000, 0, 0, 0, 0], effects: [6, 6, 6], effectAura: [36, 16, 33],
    effectMiscValue: [30, 0, 0], shapeshiftFormFlags: 1,
  })],
  [8676, row(8676, "Внезапный удар", {
    powerType: 3, powerCost: 60, attributes: [0x270010, 0x8000200, 0x100000, 0x400, 0, 0, 0, 0],
    equippedItemClass: 2, equippedItemSubclass: 0x8000, shapeshiftMask: [0x20000000, 0], implicitTargetA: [6, 6, 6],
  })],
  [2098, row(2098, "Потрошение", {
    powerType: 3, powerCost: 35, attributes: [0x50010, 0x100200, 0, 0x400, 0x8, 0, 0, 0],
    equippedItemClass: 2, equippedItemSubclass: 173555, implicitTargetA: [6, 1, 0],
  })],
  [7384, row(7384, "Превосходство", {
    powerType: 1, powerCost: 50, attributes: [0x250010, 0x58100200, 0, 0x400, 0x200, 0, 0x400, 0],
    shapeshiftMask: [65536, 0], implicitTargetA: [6, 6, 0],
  })],
  [2457, row(2457, "Боевая стойка", {
    effects: [6, 6, 0], effectAura: [36, 280, 0], effectMiscValue: [17, 0, 0], shapeshiftFormFlags: 7,
  })],
  [2094, row(2094, "Ослепление", { powerType: 3, powerCost: 30, reagents: [{ itemId: 5530, count: 1 }] })],
]);

function fixture() {
  const fired = [];
  const clock = { monotonic: 100_000, lua: 500 };
  const fields = new Map([
    [UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 1000],
    [UPDATE_FIELDS.UNIT_FIELD_POWER1.offset, 50], // mana
    [UPDATE_FIELDS.UNIT_FIELD_POWER1.offset + 1, 0], // rage
    [UPDATE_FIELDS.UNIT_FIELD_POWER1.offset + 3, 100], // energy
  ]);
  const player = { guid: SELF, typeId: 4, movementFlags: 0, fields };
  const target = { guid: TARGET, typeId: 3, movementFlags: 0, fields: new Map([[UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 500]]) };
  const item = (guid, entry, count = 1) => ({ guid, typeId: 1, movementFlags: 0, fields: new Map([
    [UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, entry], [UPDATE_FIELDS.ITEM_FIELD_STACK_COUNT.offset, count],
  ]) });
  const auras = new Map();
  const world = {
    state: { selfGuid: SELF, objects: new Map([[SELF, player], [TARGET, target]]) },
    targetGuid: TARGET,
    knownSpells: [...SPELLS.keys()].map((id, slot) => ({ id, slot })),
    actionButtons: [133, 1784, 8676, 2098, 7384, 2094].map((action, slot) => ({ slot, action, type: ACTION_BUTTON_SPELL })),
    casts: new Map(), cooldownSnapshots: new Map(), itemCooldowns: new Map(), mirrorTimers: new Map(),
    itemTemplates: new Map([
      [3000, { found: true, entry: 3000, name: "Кинжал", itemClass: 2, subClass: 15, ammoType: 0, stackable: 1, spells: [] }],
      [5530, { found: true, entry: 5530, name: "Ослепляющий порошок", itemClass: 7, subClass: 0, stackable: 20, spells: [] }],
    ]),
    comboPoints: undefined,
    names: new Map(), creatureTemplates: new Map(),
    spellModifiers: new Map(),
    cooldownRemaining: (id, now) => Math.max(0, (world.cooldownSnapshots.get(id)?.endsAt ?? 0) - now),
    cooldownState: (id) => world.cooldownSnapshots.get(id),
    isActiveMountSpell: () => false,
    aurasFor: (guid) => auras.get(guid) ?? [],
    events: { on: () => () => {} },
  };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: (id) => SPELLS.get(id),
    monotonic: () => clock.monotonic, globalCooldownUntil: () => 0, castSpell: () => {},
  });
  const pump = { now: () => clock.lua, fire: (name, ...args) => { fired.push([name, ...args]); return 1; } };
  const usableEvents = () => fired.filter(([name]) => name === FRAMEXML_SEAM_EVENTS.actionUsable).length;
  const step = (ms = 120) => { clock.monotonic += ms; clock.lua += ms / 1000; seam.tick(clock.lua); };
  const setBytes = (name, byte, value) => {
    const offset = UPDATE_FIELDS[name].offset;
    const word = fields.get(offset) ?? 0;
    fields.set(offset, ((word & ~(0xff << (byte * 8))) | (value << (byte * 8))) >>> 0);
  };
  const wield = () => {
    world.state.objects.set(DAGGER, item(DAGGER, 3000));
    fields.set(UPDATE_FIELDS.PLAYER_FIELD_INV_SLOT_HEAD.offset + 15 * 2, Number(DAGGER));
  };
  const carry = (count) => {
    world.state.objects.set(POWDER, item(POWDER, 5530, count));
    fields.set(UPDATE_FIELDS.PLAYER_FIELD_PACK_SLOT_1.offset, Number(POWDER));
  };
  return { seam, world, player, fields, auras, fired, clock, pump, usableEvents, step, setBytes, wield, carry };
}

const call = (seam, name, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);

test("19.10: short of power is notEnoughMana (blue), enough is usable, and only the change raises the event", () => {
  const f = fixture();
  f.seam.attach(f.pump);
  f.step();
  assert.deepEqual(call(f.seam, "IsUsableAction", 1), [false, true], "50 mana for a 100 mana spell: blue");
  f.fired.length = 0;
  f.step();
  assert.equal(f.usableEvents(), 0, "the same pairs are no news");
  f.fields.set(UPDATE_FIELDS.UNIT_FIELD_POWER1.offset, 400);
  f.step();
  assert.deepEqual(call(f.seam, "IsUsableAction", 1), [true, false]);
  assert.equal(f.usableEvents(), 1, "ACTIONBAR_UPDATE_USABLE once on the crossing (0x005a8d30)");
  f.fired.length = 0;
  f.fields.set(UPDATE_FIELDS.UNIT_FIELD_POWER1.offset, 380);
  f.step();
  assert.equal(f.usableEvents(), 0, "a power change that crosses nothing");
  // A recovering spell keeps its colour: UpdateUsableAction (0x005a9e20) has no cooldown gate.
  f.world.cooldownSnapshots.set(133, { startedAt: 100_000, duration: 60_000, endsAt: 200_000 });
  assert.deepEqual(call(f.seam, "IsUsableAction", 1), [true, false]);
  f.seam.detach();
});

test("19.10: a rogue's Ambush wants stealth and a dagger; Eviscerate wants combo points on the target", () => {
  const f = fixture();
  f.seam.attach(f.pump);
  assert.deepEqual(call(f.seam, "IsUsableAction", 3), [false, false], "not stealthed (ShapeshiftMask form 30)");
  f.setBytes("UNIT_FIELD_BYTES_2", 3, 30);
  f.setBytes("UNIT_FIELD_BYTES_1", 2, 0x02);
  f.auras.set(SELF, [{ spellId: 1784, flags: 0x7 }]);
  assert.deepEqual(call(f.seam, "IsUsableAction", 3), [false, false], "no dagger in the main hand");
  f.wield();
  assert.deepEqual(call(f.seam, "IsUsableAction", 3), [true, false]);
  f.fields.set(UPDATE_FIELDS.UNIT_FIELD_POWER1.offset + 3, 40);
  assert.deepEqual(call(f.seam, "IsUsableAction", 3), [false, true], "40 energy of 60: blue");
  f.fields.set(UPDATE_FIELDS.UNIT_FIELD_POWER1.offset + 3, 100);
  assert.deepEqual(call(f.seam, "IsUsableAction", 4), [false, false], "no combo points");
  f.world.comboPoints = { guid: 999n, points: 3 };
  assert.deepEqual(call(f.seam, "IsUsableAction", 4), [false, false], "points on another unit");
  f.world.comboPoints = { guid: TARGET, points: 3 };
  assert.deepEqual(call(f.seam, "IsUsableAction", 4), [true, false]);
  // Stealth itself: SPELL_ATTR0_CANT_USED_IN_COMBAT.
  f.fields.set(UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset, 0x80000);
  assert.deepEqual(call(f.seam, "IsUsableAction", 2), [false, false], "in combat");
  f.fields.set(UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset, 0);
  assert.deepEqual(call(f.seam, "IsUsableAction", 2), [true, false]);
  f.seam.detach();
});

test("19.10: a stance spell wants its stance; a reagent spell its reagent, which it counts", () => {
  const f = fixture();
  f.fields.set(UPDATE_FIELDS.UNIT_FIELD_POWER1.offset + 1, 1000);
  assert.deepEqual(call(f.seam, "IsUsableAction", 5), [false, false], "Overpower outside Battle Stance");
  f.setBytes("UNIT_FIELD_BYTES_2", 3, 17);
  f.auras.set(SELF, [{ spellId: 2457, flags: 0x3 }]);
  assert.deepEqual(call(f.seam, "IsUsableAction", 5), [false, false], "in stance, but the target has not dodged");
  // AttributesEx 0x100000 (REQ_COMBO_POINTS1): the realm's point for a dodge is what lights Overpower up.
  f.world.comboPoints = { guid: TARGET, points: 1 };
  assert.deepEqual(call(f.seam, "IsUsableAction", 5), [true, false]);
  assert.deepEqual(call(f.seam, "IsConsumableAction", 6), [true], "a spell with a reagent (0x005a9360)");
  assert.deepEqual(call(f.seam, "GetActionCount", 6), [0]);
  assert.deepEqual(call(f.seam, "IsUsableAction", 6), [false, false], "no Blinding Powder");
  f.carry(3);
  assert.deepEqual(call(f.seam, "GetActionCount", 6), [3], "casts the bags hold (0x007ffa30)");
  assert.deepEqual(call(f.seam, "IsUsableAction", 6), [true, false]);
  assert.deepEqual(call(f.seam, "IsConsumableAction", 1), [false]);
});

test("19.10: the dead cast nothing, and IsUsableSpell answers a book name with 1 / nil", () => {
  const f = fixture();
  f.fields.set(UPDATE_FIELDS.UNIT_FIELD_POWER1.offset, 400);
  assert.deepEqual(call(f.seam, "IsUsableSpell", "Огненный шар"), [1, undefined]);
  f.fields.set(UPDATE_FIELDS.UNIT_FIELD_POWER1.offset, 10);
  assert.deepEqual(call(f.seam, "IsUsableSpell", "Огненный шар"), [undefined, 1]);
  f.fields.set(UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 0);
  assert.deepEqual(call(f.seam, "IsUsableAction", 1), [false, false]);
  assert.deepEqual(call(f.seam, "IsUsableSpell", "Огненный шар"), [undefined, undefined]);
  assert.deepEqual(call(f.seam, "IsUsableSpell", "Нет такого"), [undefined, undefined]);
});
}
