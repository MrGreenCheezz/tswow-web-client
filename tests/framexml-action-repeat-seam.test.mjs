// Plan item 1.14 (slice a): IsAttackAction, IsAutoRepeatAction and IsCurrentAction for the attack
// button answer 1/nil from the live world, and START/STOP_AUTOREPEAT_SPELL follow the repeating spell
// (FrameXmlActionRepeat.ts; Wow.exe 0x5a9ba0/0x5a96d0, 0x5a9c10/0x5a9470, 0x5aad40/0x5aa240,
// 0x7fe140/0x800a00/0x807560).
import assert from "node:assert/strict";
import test from "node:test";

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
