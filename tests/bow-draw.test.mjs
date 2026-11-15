import assert from "node:assert/strict";
import test from "node:test";
import {
  BOW_PULL, BOW_RELEASE, BowDraw, HOLD_BOW, HOLD_RIFLE, HOLD_THROWN, LOAD_BOW, LOAD_RIFLE, LOAD_THROWN, PULL_BLOCKING_MOVEMENT,
  READY_UNARMED_ANIMATION, WEAPON_STAND, ammoInventoryType, bowPullSpeed, clipEndFollower, rangedLoadAnimation, rangedSubClass,
} from "../dist/code/browser/BowDraw.js";
import { rangedLoadLadder, readyStance, standingAnimations } from "../dist/code/browser/UnitStandingPose.js";
import { modelEventsOf } from "../tools/generate-model-events.mjs";

// 5.05 (15.11, bow9): the auto-repeat rung 0x00714f90, the clip ends of 0x0073b510, "$BWP" (0x00756240 → 0x00756040) and
// "$BWR" (0x00732650), the stop 0x0072afe0 and the ammo's hang 0x007206a0, on a real character's events and a real bow.

let archives;
try {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const { clientDirectory } = await import("../tools/paths.mjs");
  archives = await clientArchives(clientDirectory());
} catch {
  archives = undefined;
}
const withClient = { skip: archives ? false : "no 3.3.5a client on this machine" };

const ATTACK_BOW = 46;
const ATTACK_RIFLE = 49;
const ev = (id, keys) => ({ id, bone: 0, x: 0, y: 0, z: 0, keys });
/** A HumanMale-like rig: LoadBow 1000 ms with $BWP at 434, AttackBow 1000 ms with $BWR at 33 (bow-census.txt). */
const human = {
  events: [ev("$BWP", [[LOAD_BOW, 0, [434]], [LOAD_RIFLE, 0, [433]]]), ev("$BWR", [[ATTACK_BOW, 0, [33]], [ATTACK_RIFLE, 0, [33]]])],
  sequences: [[0, 0, 2667], [LOAD_BOW, 0, 1000], [LOAD_RIFLE, 0, 1000], [HOLD_BOW, 0, 1000], [ATTACK_BOW, 0, 1000]],
};
/** A bow's own table (bow_1h_pvp330_d_01: Stand 33, BowPull 1000, BowRelease 166). */
const bowSequences = [[0, 0, 33], [BOW_PULL, 0, 1000], [BOW_RELEASE, 0, 166]];

function frame(over = {}) {
  return {
    now: 0, mark: true, sheath: 2, subClass: 2, movement: 0, channel: false, self: false, reqAmmo: false,
    base: undefined, upper: undefined, events: human, weapon: bowSequences, ammo: true, queued: false, ...over,
  };
}
const clip = (animation, timeMs, token, durationMs = 1000) => ({ animation, variation: 0, timeMs, durationMs, token });

test("the rung 0x00714f90: the stance by the ranged subclass", () => {
  assert.equal(rangedLoadAnimation(2), LOAD_BOW, "bow");
  assert.equal(rangedLoadAnimation(3), LOAD_RIFLE, "gun");
  assert.equal(rangedLoadAnimation(18), LOAD_RIFLE, "crossbow");
  assert.equal(rangedLoadAnimation(16), LOAD_THROWN, "thrown");
  assert.equal(rangedLoadAnimation(19), HOLD_THROWN, "wand");
  assert.equal(rangedLoadAnimation(undefined), READY_UNARMED_ANIMATION, "no ranged weapon");
  assert.equal(rangedSubClass({ inventoryType: 15 }), 2, "INVTYPE_RANGED is a bow");
  assert.equal(rangedSubClass({ inventoryType: 25 }), 16, "INVTYPE_THROWN");
  assert.equal(rangedSubClass({ inventoryType: 26 }), undefined, "26 is a gun, a crossbow or a wand");
  assert.equal(ammoInventoryType(25), 25, "thrown ammo");
  assert.equal(ammoInventoryType(15), 24, "arrows and bullets");
});

test("the clip ends 0x0073b510: load → hold; HoldBow again while the mark, HoldRifle only while channelling", () => {
  assert.equal(clipEndFollower(LOAD_BOW, true, false), HOLD_BOW);
  assert.equal(clipEndFollower(LOAD_RIFLE, true, false), HOLD_RIFLE);
  assert.equal(clipEndFollower(HOLD_BOW, true, false), HOLD_BOW);
  assert.equal(clipEndFollower(HOLD_BOW, false, false), undefined);
  assert.equal(clipEndFollower(HOLD_RIFLE, true, false), undefined);
  assert.equal(clipEndFollower(HOLD_RIFLE, true, true), HOLD_RIFLE);
  assert.equal(clipEndFollower(LOAD_THROWN, true, true), HOLD_THROWN);
});

test("0x00756040: BowPull lasts the rest of the unit's clip", () => {
  assert.equal(bowPullSpeed(1000, 1000, 434), 1000 / 566);
  assert.equal(bowPullSpeed(1000, 1000, 1000), undefined, "nothing remains");
  assert.equal(bowPullSpeed(0, 1000, 434), undefined);
});

test("a bow's cycle: LoadBow, $BWP pulls and hangs, HoldBow, the shot's stop, LoadBow again", () => {
  const draw = new BowDraw();
  draw.setAmmo(5996, 15, 2);
  const load = {};
  assert.equal(draw.step(frame({ now: 0 })), LOAD_BOW, "the mark and the ranged sheath: LoadBow");
  assert.equal(draw.step(frame({ now: 16, base: clip(LOAD_BOW, 0, load) })), LOAD_BOW);
  assert.equal(draw.arrow, false);
  assert.equal(draw.step(frame({ now: 300, base: clip(LOAD_BOW, 300, load) })), LOAD_BOW);
  assert.equal(draw.step(frame({ now: 450, base: clip(LOAD_BOW, 450, load) })), LOAD_BOW, "$BWP does not cut LoadBow short");
  assert.equal(draw.arrow, true, "+0xa38 0x4000");
  assert.equal(draw.hung, true, "the ammo on HandArrow");
  assert.equal(draw.weapon.animation, BOW_PULL);
  assert.equal(draw.weapon.speed, 1000 / 566, "BowPull over the rest of LoadBow");
  assert.equal(draw.weapon.at, 450 - 16, "from the key, not the frame");
  // LoadBow loops in this client's base: its wrap is the clip's end.
  assert.equal(draw.step(frame({ now: 1010, base: clip(LOAD_BOW, 10, load) })), HOLD_BOW, "LoadBow → HoldBow");
  const hold = {};
  assert.equal(draw.step(frame({ now: 1030, base: clip(HOLD_BOW, 10, hold) })), HOLD_BOW);
  assert.equal(draw.step(frame({ now: 2005, base: clip(HOLD_BOW, 5, hold) })), HOLD_BOW, "HoldBow again under the mark");
  draw.stop(2100);
  assert.equal(draw.arrow, false);
  assert.equal(draw.hung, false);
  assert.deepEqual(draw.weapon, { animation: WEAPON_STAND, speed: 1, at: 2100 }, "0x0072afe0: the bow to sequence 0");
  const shot = {};
  draw.step(frame({ now: 2116, base: clip(ATTACK_BOW, 16, shot) }));
  assert.equal(draw.step(frame({ now: 3100, base: clip(HOLD_BOW, 900, hold) })), LOAD_BOW, "after the shot: LoadBow");
});

test("$BWP does nothing while the unit moves, and the player's own needs a REQ_AMMO spell", () => {
  const moving = new BowDraw();
  moving.setAmmo(5996, 15, 2);
  moving.step(frame({ now: 0, base: clip(LOAD_BOW, 400, moving), movement: 0x1 }));
  moving.step(frame({ now: 50, base: clip(LOAD_BOW, 450, moving), movement: 0x1 }));
  assert.equal(moving.arrow, false);
  assert.equal(moving.weapon, undefined);
  assert.ok((PULL_BLOCKING_MOVEMENT & 0x200000) !== 0, "swimming");
  const own = new BowDraw();
  own.step(frame({ now: 0, base: clip(LOAD_BOW, 400, own), self: true, reqAmmo: false }));
  own.step(frame({ now: 50, base: clip(LOAD_BOW, 450, own), self: true, reqAmmo: false }));
  assert.equal(own.arrow, false, "own, no REQ_AMMO spell");
  const ownAmmo = new BowDraw();
  ownAmmo.step(frame({ now: 0, base: clip(LOAD_BOW, 400, ownAmmo), self: true, reqAmmo: true }));
  ownAmmo.step(frame({ now: 50, base: clip(LOAD_BOW, 450, ownAmmo), self: true, reqAmmo: true }));
  assert.equal(ownAmmo.arrow, true);
});

test("a gun: LoadRifle, the bit but no arrow in the hand; BowPull only on a model that has it", () => {
  const draw = new BowDraw();
  draw.setAmmo(5998, 26, 3);
  const load = {};
  assert.equal(draw.step(frame({ subClass: 3, weapon: [[0, 0, 33]], now: 0 })), LOAD_RIFLE);
  draw.step(frame({ subClass: 3, weapon: [[0, 0, 33]], now: 10, base: clip(LOAD_RIFLE, 400, load) }));
  draw.step(frame({ subClass: 3, weapon: [[0, 0, 33]], now: 50, base: clip(LOAD_RIFLE, 440, load) }));
  assert.equal(draw.arrow, true);
  assert.equal(draw.hung, false, "0x00756240: not for a gun or a crossbow");
  assert.equal(draw.weapon, undefined, "the gun has no BowPull");
  assert.equal(draw.step(frame({ subClass: 3, now: 600, base: clip(LOAD_RIFLE, 5, load) })), HOLD_RIFLE);
  const crossbow = new BowDraw();
  crossbow.step(frame({ subClass: 18, now: 0, base: clip(LOAD_RIFLE, 400, crossbow) }));
  crossbow.step(frame({ subClass: 18, now: 50, base: clip(LOAD_RIFLE, 450, crossbow) }));
  assert.equal(crossbow.weapon.animation, BOW_PULL, "a crossbow's string is pulled");
  assert.equal(crossbow.hung, false, "but no arrow is hung");
});

test("$BWR: the bit and the arrow go; the weapon moves only with missiles queued (bow → 0, rifle → BowRelease)", () => {
  const draw = new BowDraw();
  draw.setAmmo(5996, 15, 2);
  draw.step(frame({ now: 0, base: clip(LOAD_BOW, 400, draw) }));
  draw.step(frame({ now: 50, base: clip(LOAD_BOW, 450, draw) }));
  const pulled = draw.weapon;
  const shot = {};
  draw.step(frame({ now: 100, upper: clip(ATTACK_BOW, 0, shot) }));
  draw.step(frame({ now: 140, upper: clip(ATTACK_BOW, 40, shot) }));
  assert.equal(draw.arrow, false);
  assert.equal(draw.hung, false);
  assert.equal(draw.weapon, pulled, "no queue: the weapon is left to the stop");
  const queued = new BowDraw();
  queued.step(frame({ now: 0, base: clip(ATTACK_BOW, 0, queued), queued: true }));
  queued.step(frame({ now: 40, base: clip(ATTACK_BOW, 40, queued), queued: true }));
  assert.equal(queued.weapon.animation, WEAPON_STAND, "a bow behaviour");
  const rifle = new BowDraw();
  rifle.step(frame({ subClass: 3, now: 0, base: clip(ATTACK_RIFLE, 0, rifle), queued: true }));
  rifle.step(frame({ subClass: 3, now: 40, base: clip(ATTACK_RIFLE, 40, rifle), queued: true }));
  assert.equal(rifle.weapon.animation, BOW_RELEASE, "a rifle behaviour");
  rifle.stop(50);
  assert.equal(rifle.weapon.animation, BOW_RELEASE, "0x0072afe0 leaves BowRelease playing");
});

test("0x007206a0: an ammo display arriving while the bit is set is hung at once — as ammo, not on a gun", () => {
  const draw = new BowDraw();
  draw.step(frame({ now: 0, base: clip(LOAD_BOW, 400, draw), ammo: false }));
  draw.step(frame({ now: 50, base: clip(LOAD_BOW, 450, draw), ammo: false }));
  assert.equal(draw.arrow, true);
  assert.equal(draw.hung, false, "no ammo model yet");
  draw.setAmmo(5996, 15, 2);
  assert.equal(draw.hung, true);
  draw.setAmmo(5996, 25, 16);
  assert.equal(draw.hung, false, "a thrown weapon's model is not hung as ammo");
  const gun = new BowDraw();
  gun.arrow = true;
  gun.setAmmo(5998, 26, 3);
  assert.equal(gun.hung, false);
});

test("no mark or another sheath: the rung names nothing and the stance ladder is the one before", () => {
  const draw = new BowDraw();
  assert.equal(draw.step(frame({ mark: false })), undefined);
  assert.equal(draw.step(frame({ sheath: 1 })), undefined);
  const bow = [{ slot: 17, inventoryType: 15, subClass: 2 }];
  const ready = readyStance(bow, 2);
  const ladder = rangedLoadLadder(LOAD_BOW, ready);
  assert.deepEqual(ladder, [LOAD_BOW, ...ready], "LoadBow, then the ready stance a rig without it stands in");
  assert.equal(rangedLoadLadder(LOAD_BOW, ready), ladder, "shared");
  assert.equal(standingAnimations({ standState: 0, rangedLoad: ladder, emoteState: 10 }), ladder, "before the emote state");
  assert.deepEqual(standingAnimations({ standState: 0, ready }), ready, "without the rung: as before");
});

test("the client's HumanMale and a real bow: $BWP at 434 ms of LoadBow pulls the bow over the remaining 566 ms", withClient, async () => {
  const base = "Character\\Human\\Male\\HumanMale";
  const human = modelEventsOf(await archives.read(`${base}.m2`), new Map());
  const bowPath = "item\\objectcomponents\\weapon\\bow_1h_pvp330_d_01.m2";
  const bowBytes = await archives.read(bowPath);
  assert.ok(bowBytes, bowPath);
  const bow = modelEventsOf(bowBytes);
  const pull = bow.sequences.find(([id]) => id === BOW_PULL);
  assert.deepEqual(pull, [BOW_PULL, 0, 1000], "the bow's BowPull");
  assert.ok(bow.sequences.some(([id]) => id === BOW_RELEASE), "and BowRelease");
  const loadBow = human.sequences.find(([id, variation]) => id === LOAD_BOW && variation === 0);
  const draw = new BowDraw();
  draw.setAmmo(5996, 15, 2);
  const token = {};
  const f = (now, time) => ({ now, mark: true, sheath: 2, subClass: 2, movement: 0, channel: false, self: false, reqAmmo: false,
    base: { animation: LOAD_BOW, variation: 0, timeMs: time, durationMs: loadBow[2], token }, upper: undefined,
    events: human, weapon: bow.sequences, ammo: true, queued: false });
  draw.step(f(0, 0));
  draw.step(f(400, 400));
  assert.equal(draw.weapon, undefined);
  draw.step(f(440, 440));
  assert.equal(draw.weapon.animation, BOW_PULL);
  assert.equal(draw.weapon.speed, 1000 / (loadBow[2] - 434));
  assert.equal(draw.hung, true);
});
