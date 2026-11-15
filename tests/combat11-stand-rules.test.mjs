import assert from "node:assert/strict";
import test from "node:test";
import { BowDraw, HOLD_BOW, LOAD_BOW } from "../dist/code/browser/BowDraw.js";
import {
  HIP_SHEATH_ANIMATION, SHEATH_ANIMATION, beginSheathCeremony, ceremonySheath, sheathArmPlans,
} from "../dist/code/browser/SheathCeremony.js";
import { sheathArmPlaying, sheathArmWeight } from "../dist/code/browser/SheathArms.js";
import { worldAttachmentPoint } from "../dist/code/browser/SheathPoints.js";
import { SHEATH_MELEE, SHEATH_RANGED, SHEATH_UNARMED } from "../dist/code/browser/input/StockVerbs.js";
import { woundTakesWholeBody } from "../dist/code/browser/WoundTrack.js";
import { advanceOffscreenSwing } from "../dist/code/browser/OffscreenSwingClock.js";
import { mountShownDisplay } from "../dist/code/browser/MountPassengerHold.js";

// 15.11 (combat11): rules recorded on the Oracle stand (Wow.exe 3.3.5a 12340, F:\WowOracle\runs\combat11-*).

const ev = (id, keys) => ({ id, bone: 0, x: 0, y: 0, z: 0, keys });
const human = { events: [ev("$BWP", [[LOAD_BOW, 0, [434]]])], sequences: [[LOAD_BOW, 0, 1000], [HOLD_BOW, 0, 1000]] };
const frame = (over) => ({
  now: 0, mark: true, sheath: 2, subClass: 2, movement: 0, channel: false, self: false, reqAmmo: false,
  base: undefined, upper: undefined, events: human, weapon: [[0, 0, 33], [0xa0, 0, 1000]], ammo: true, queued: false, ...over,
});
const clip = (animation, timeMs, token) => ({ animation, variation: 0, timeMs, durationMs: 1000, token });

test("5.05: a cancel in LoadBow lets LoadBow run out, then HoldBow once, then nothing (combat11-d2-bow-move)", () => {
  const draw = new BowDraw();
  const load = {};
  assert.equal(draw.step(frame({ now: 0 })), LOAD_BOW);
  assert.equal(draw.step(frame({ now: 16, base: clip(LOAD_BOW, 0, load) })), LOAD_BOW);
  // SMSG_CANCEL_AUTO_REPEAT: the mark is gone, LoadBow is still on show.
  assert.equal(draw.step(frame({ now: 300, mark: false, base: clip(LOAD_BOW, 300, load) })), LOAD_BOW, "no re-pick mid-clip");
  assert.equal(draw.step(frame({ now: 1010, mark: false, base: clip(LOAD_BOW, 10, load) })), HOLD_BOW,
    "LoadBow's end hands to HoldBow without the mark");
  const hold = {};
  assert.equal(draw.step(frame({ now: 1030, mark: false, base: clip(HOLD_BOW, 20, hold) })), HOLD_BOW);
  assert.equal(draw.step(frame({ now: 2015, mark: false, base: clip(HOLD_BOW, 5, hold) })), undefined,
    "HoldBow's end without the mark: the chooser again (Stand on the stand)");
  assert.equal(draw.step(frame({ now: 2040, mark: false, base: clip(0, 25, {}) })), undefined);
});

test("5.05: a cancel while another clip is on the body ends the cycle at once", () => {
  const draw = new BowDraw();
  draw.step(frame({ now: 0 }));
  draw.step(frame({ now: 16, base: clip(LOAD_BOW, 0, {}) }));
  assert.equal(draw.step(frame({ now: 40, mark: false, base: clip(46, 24, {}) })), undefined, "AttackBow on show");
});

const piece = (slot, inventoryType, sheathe) => ({ slot, inventoryType, sheathe, side: "right", model: `Item\\${slot}.m2`, texture: "" });
const pointOf = (item, sheath) => worldAttachmentPoint(item, sheath, item.sheathe);
const SWORD = piece(15, 21, 3), OFF_SWORD = piece(16, 13, 3), BOW = piece(17, 15, 0);

test("6.08: ToggleSheath 1→2 with a one-hander in each hand and a bow: the left arm's HipSheath, then its Sheath for the bow (combat11-b1)", () => {
  const plans = sheathArmPlans([SWORD, OFF_SWORD, BOW], SHEATH_MELEE, SHEATH_RANGED, pointOf);
  assert.deepEqual(plans.map((p) => [p.keyBone, p.animation, p.slots.join(","), p.after === true]),
    [[3, HIP_SHEATH_ANIMATION, "15", false], [2, HIP_SHEATH_ANIMATION, "16", false], [2, SHEATH_ANIMATION, "17", true]]);
  // HumanMale on the stand: HipSheath about 1 s, the off hand away at its event; the bow's Sheath from the clip's end, the bow
  // in the hand at that clip's event (1.6 s after the toggle).
  const shapes = { [HIP_SHEATH_ANIMATION]: { duration: 1, blend: 0.15 }, [SHEATH_ANIMATION]: { duration: 1.067, blend: 0.15 } };
  const c = beginSheathCeremony(plans, SHEATH_MELEE, SHEATH_RANGED, 0, (a) => shapes[a], () => 0.5);
  const [, left, bow] = c.arms;
  assert.equal(bow.startAt, left.endAt, "the second clip starts when the first one on that arm ends");
  assert.equal(ceremonySheath(c, 16, 499), SHEATH_MELEE);
  assert.equal(ceremonySheath(c, 16, 500), SHEATH_RANGED, "the off hand at the HipSheath's event");
  assert.equal(ceremonySheath(c, 17, 999), SHEATH_MELEE, "the bow not yet drawn when the off hand has gone");
  assert.equal(ceremonySheath(c, 17, 1000 + 533.5), SHEATH_RANGED, "the bow at its own clip's event");
  // Sheathing plays to the end; the draw lets go at its event and is back in the body's pose over the blend.
  assert.equal(left.releaseAt, undefined);
  assert.ok(sheathArmWeight(left, 950) > 0 && sheathArmPlaying(left, 950));
  assert.equal(bow.releaseAt, bow.eventAt);
  assert.equal(sheathArmWeight(bow, bow.eventAt - 1), 1);
  assert.ok(sheathArmWeight(bow, bow.eventAt + 75) < 1 && sheathArmWeight(bow, bow.eventAt + 75) > 0);
  assert.equal(sheathArmWeight(bow, bow.eventAt + 151), 0);
  assert.equal(sheathArmPlaying(bow, bow.eventAt + 151), false, "the arm handed back before the clip's end");
});

test("6.08: drawing both one-handers lets both arms go at their events; putting a bow away plays Sheath to its end", () => {
  const c = beginSheathCeremony(sheathArmPlans([SWORD, OFF_SWORD], SHEATH_UNARMED, SHEATH_MELEE, pointOf), SHEATH_UNARMED,
    SHEATH_MELEE, 0, () => ({ duration: 1, blend: 0.2 }), () => 0.5);
  for (const arm of c.arms) assert.equal(arm.releaseAt, arm.eventAt);
  const away = beginSheathCeremony(sheathArmPlans([BOW], SHEATH_RANGED, SHEATH_UNARMED, pointOf), SHEATH_RANGED,
    SHEATH_UNARMED, 0, () => ({ duration: 1, blend: 0.2 }), () => 0.5);
  assert.equal(away.arms[0].releaseAt, undefined);
  assert.ok(sheathArmPlaying(away.arms[0], 900));
});

test("6.43: a wound on a sleeper takes the whole body (combat11-e1-sleep-hit); a sitter keeps the split track", () => {
  assert.equal(woundTakesWholeBody(true, { standState: 0 }), true);
  assert.equal(woundTakesWholeBody(false, { standState: 3 }), true, "asleep");
  assert.equal(woundTakesWholeBody(false, { standState: 1 }), false, "sitting: legs stay seated (face6-react)");
  assert.equal(woundTakesWholeBody(false, { standState: 3, mounted: true }), false);
  assert.equal(woundTakesWholeBody(false, { standState: 0 }), false, "moving and the like: as before");
});

test("6.06: an off-screen attacker's swing keeps its clock, so the victim's cue comes at its event (combat11-e2)", () => {
  const action = { time: 0, timeScale: 1, getClip: () => ({ duration: 1.5 }) };
  const shown = { entry: { layer: "melee" }, action };
  for (let i = 0; i < 10; i++) advanceOffscreenSwing(shown, 0.034);
  assert.ok(Math.abs(action.time - 0.34) < 1e-9, "the wolf's $CAH at 334 ms is reached off screen");
  for (let i = 0; i < 100; i++) advanceOffscreenSwing(shown, 0.1);
  assert.equal(action.time, 1.5, "up to the clip's end");
  const emote = { entry: { layer: "emote" }, action: { time: 0, timeScale: 1, getClip: () => ({ duration: 1 }) } };
  advanceOffscreenSwing(emote, 0.1);
  assert.equal(emote.action.time, 0, "only the swing");
});

test("6.20: the mount stays while a passenger sits when its field drops; a new field ends it (combat11-m1, -m2, -h-mount)", () => {
  const owner = {};
  let aboard = true;
  const shown = (field) => mountShownDisplay(owner, field, () => aboard);
  assert.equal(shown(27238), 27238);
  assert.equal(shown(0), 27238, "field 0 with the passenger seated: the mammoth stays");
  aboard = false;
  assert.equal(shown(0), 27238, "the passenger leaving changes nothing");
  assert.equal(shown(27244), 27244, "another mount");
  assert.equal(shown(0), 0, "field 0 with nobody aboard: gone at once");
  const other = {};
  assert.equal(mountShownDisplay(other, 0, () => true), 0, "a unit first seen without a mount holds nothing");
});
