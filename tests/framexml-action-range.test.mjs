// Plan item 1.14b: IsActionInRange as Wow.exe 0x005a9d50 → 0x005a94c0 → 0x00809610 → 0x00803850 answers
// it (FrameXmlActionRange.ts), over the `/dbc/spells?v=14` columns. Synthetic units; real SpellRange
// rows of this dataset (2 melee 0..5 flag 1, 4 0..30, 114 0..35 flag 2, 159 hostile 40 / friendly 100).
import assert from "node:assert/strict";
import test from "node:test";

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
