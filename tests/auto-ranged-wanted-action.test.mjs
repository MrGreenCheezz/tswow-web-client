// L18 5.05 (04.10): the shot the autoRangedCombat controller wants (world/AutoRangedCombat.ts
// `wantedSpellId`, Wow.exe 0x00d397cc) lights the Auto Shot button before the first shot goes out.
//
// Wow.exe 3.3.5a 12340 (Ghidra read-only, .runtime/re-2026-10-04/l15-combat/g1.c, .runtime/re-2026-10-01/
// a9-combat/e2.c): IsAutoRepeatAction 0x005a9470 answers 1 when the slot's spell is the repeating one
// (0x007fe130 → 0x00d397d0) or the wanted one (0x007fe180 → 0x00d397cc). The wanted slot's setter 0x007fe140
// fires START/STOP_AUTOREPEAT_SPELL only while nothing repeats, the repeat's setter 0x00800a00 (and the
// cancel 0x00807560) only while nothing is wanted — so the edges follow "the repeating spell, else the
// wanted one" (FrameXmlAutoRepeatWanted.ts).
import assert from "node:assert/strict";
import test from "node:test";

const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { frameXmlAutoRepeatShown, frameXmlIsAutoRepeatSpell } =
  await import("../dist/code/browser/framexml/FrameXmlAutoRepeatWanted.js");

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
    autoRanged: { wantedSpellId: undefined },
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

test("L18 5.05: 0x005a9470 — the repeating spell or the wanted one", () => {
  assert.equal(frameXmlIsAutoRepeatSpell(75, undefined, undefined), false);
  assert.equal(frameXmlIsAutoRepeatSpell(75, 75, undefined), true);
  assert.equal(frameXmlIsAutoRepeatSpell(75, undefined, 75), true, "wanted, not shot yet");
  assert.equal(frameXmlIsAutoRepeatSpell(75, 5019, 75), true, "both slots are read");
  assert.equal(frameXmlIsAutoRepeatSpell(5019, 5019, 75), true);
  assert.equal(frameXmlIsAutoRepeatSpell(133, 5019, 75), false);
  assert.equal(frameXmlIsAutoRepeatSpell(0, undefined, undefined), false);
  assert.equal(frameXmlAutoRepeatShown(undefined), undefined);
  assert.equal(frameXmlAutoRepeatShown({ autoRepeatSpellId: undefined, autoRanged: { wantedSpellId: 75 } }), 75);
  assert.equal(frameXmlAutoRepeatShown({ autoRepeatSpellId: 5019, autoRanged: { wantedSpellId: 75 } }), 5019);
  assert.equal(frameXmlAutoRepeatShown({ autoRepeatSpellId: undefined }), undefined, "a world without the controller");
});

test("L18 5.05: IsAutoRepeatAction lights the Auto Shot button while the shot is only wanted", () => {
  const { world, api } = fixture();
  assert.deepEqual(api("IsAutoRepeatAction", 2), [undefined]);
  world.autoRanged.wantedSpellId = 75; // the controller wants it; the player is still moving
  assert.deepEqual(api("IsAutoRepeatAction", 2), [1]);
  assert.deepEqual(api("IsAutoRepeatAction", 3), [undefined], "Shoot is neither");
  world.autoRepeatSpellId = 5019;
  assert.deepEqual(api("IsAutoRepeatAction", 2), [1], "0x005a9470 compares both slots");
  assert.deepEqual(api("IsAutoRepeatAction", 3), [1]);
  world.autoRanged.wantedSpellId = undefined;
  assert.deepEqual(api("IsAutoRepeatAction", 2), [undefined]);
  // A world client without the controller (a stand-in) answers as before.
  delete world.autoRanged;
  world.autoRepeatSpellId = 75;
  assert.deepEqual(api("IsAutoRepeatAction", 2), [1]);
});

test("L18 5.05: START_AUTOREPEAT_SPELL when the shot becomes wanted, no second one when it goes out, STOP when it ends", () => {
  const { world, seam } = fixture();
  world.events = { on: () => () => {} };
  const fired = [];
  seam.attach({ fire: (event, ...args) => { fired.push([event, ...args]); return 1; }, now: () => 100 });
  const edges = () => fired.map(([event]) => event).filter((event) => /AUTOREPEAT/.test(event));
  seam.tick(1);
  assert.deepEqual(edges(), []);
  world.autoRanged.wantedSpellId = 75; // 0x007fe140(75) while nothing repeats
  seam.tick(2);
  assert.deepEqual(edges(), ["START_AUTOREPEAT_SPELL"]);
  world.autoRepeatSpellId = 75; // 0x00800a00(75) while it is wanted: no event
  seam.tick(3);
  assert.deepEqual(edges(), ["START_AUTOREPEAT_SPELL"]);
  world.autoRanged.wantedSpellId = undefined; // StopAttack 0x006e1660: 0x007fe140(0) while it repeats — no event
  world.autoRepeatSpellId = undefined; // then 0x00807560(1): STOP
  seam.tick(4);
  assert.deepEqual(edges(), ["START_AUTOREPEAT_SPELL", "STOP_AUTOREPEAT_SPELL"]);
  seam.detach();
});

test("L18 5.05: a mount while the shot is wanted is not a start", () => {
  const { world, seam } = fixture();
  world.events = { on: () => () => {} };
  world.autoRanged.wantedSpellId = 75;
  const fired = [];
  seam.attach({ fire: (event) => { fired.push(event); return 1; }, now: () => 100 });
  seam.tick(1);
  assert.deepEqual(fired.filter((event) => /AUTOREPEAT/.test(event)), []);
  seam.detach();
});
