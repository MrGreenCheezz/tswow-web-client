import assert from "node:assert/strict";
import test from "node:test";

// 6.03 / 6.04 / 6.07 (line A7a, slice C, 05.10): the standing base of a unit's pose — the held
// UNIT_NPC_EMOTESTATE, the combat stance while UNIT_FLAG_IN_COMBAT is up, the stand-state rows of
// Emotes.dbc — and the flag poses STUNNED/LOOTING, the kneel/sleep/landing one-shots and a far fall.
// Emote and stand-state ids are Emotes.dbc rows of this dataset (probe-emotes.mjs, 05.10):
// 173 STATE_WORK → 136 EmoteWorkNoSheathe, 10 STATE_DANCE → 69, 65 STATE_DEAD (SpecProc 1, param 7),
// 1 ONESHOT_TALK → 60 (SpecProc 0).

const { ANIMATION_DATA_AVAILABLE, ANIMATION_IDS } = await import("../dist/code/generated/animations.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { MOVEMENT_FLAGS } = await import("../dist/code/world/MovementProtocol.js");
const {
  isBaseIdle, poseAnimation, poseTransition,
} = await import("../dist/code/browser/AnimatedModel.js");
const {
  EMOTE_FLAG_STOPS_FOR_INTERACTION, READY_UNARMED, applyStandingPose, emoteStateAnimation, readyStance,
  standingAnimations,
} = await import("../dist/code/browser/UnitStandingPose.js");
const { EMOTE_FLAGS } = await import("../dist/code/generated/animations.js"); // 12.10 6.03
const {
  PLAYBACK_BACKWARD, PLAYBACK_FORWARD, PLAYBACK_HOLD_LAST, wantedPlayback,
} = await import("../dist/code/browser/AnimationPlayback.js"); // 12.10 6.07
const {
  FLAG_POSE_LOOT, FLAG_POSE_STUN, UNIT_FLAG_LOOTING, UNIT_FLAG_STUNNED, flagPoseBits, poseTransitionClip, syncFlagPoses,
} = await import("../dist/code/browser/UnitFlagPoses.js");
const UnitArbiter = await import("../dist/code/browser/UnitActionArbiter.js");
const { UnitActionQueue } = UnitArbiter;

const withData = { skip: ANIMATION_DATA_AVAILABLE ? false : "no locally generated animation data" };
const A = ANIMATION_IDS;
const standing = (extra = {}) => ({ dead: false, movementFlags: 0, spline: false, standState: 0, ...extra });
const IN_COMBAT = 0x00080000;
const weapon = (slot, inventoryType, subClass) => ({ slot, inventoryType, ...(subClass === undefined ? {} : { subClass }) });

test("the combat stance follows ItemSubClass.WeaponReadySeq of the drawn weapon", withData, () => {
  // Two-hander (sword2 8), polearm/staff (6/10: Ready2HL), one-hander, fist, dagger.
  assert.deepEqual(readyStance([weapon(15, 17, 8)], 1), [A.Ready2H, A.Ready1H, A.ReadyUnarmed]);
  assert.deepEqual(readyStance([weapon(15, 17, 6)], 1), [A.Ready2HL, A.Ready2H, A.Ready1H, A.ReadyUnarmed]);
  assert.deepEqual(readyStance([weapon(15, 17, 10)], 1)[0], A.Ready2HL);
  assert.deepEqual(readyStance([weapon(15, 13, 7)], 1), [A.Ready1H, A.ReadyUnarmed]);
  assert.equal(readyStance([weapon(15, 13, 13)], 1)[0], A.Ready1H);
  // Ranged drawn: bow, gun, crossbow (WeaponReadySeq 4 — a rifle stance), thrown, wand (2 — Ready1H).
  assert.deepEqual(readyStance([weapon(15, 13, 7), weapon(17, 15, 2)], 2), [A.ReadyBow, A.ReadyUnarmed]);
  assert.deepEqual(readyStance([weapon(17, 26, 3)], 2), [A.ReadyRifle, A.ReadyBow, A.ReadyUnarmed]);
  assert.equal(readyStance([weapon(17, 26, 18)], 2)[0], A.ReadyRifle);
  assert.equal(readyStance([weapon(17, 25, 16)], 2)[0], ANIMATION_IDS.ReadyThrown);
  assert.equal(readyStance([weapon(17, 26, 19)], 2)[0], A.Ready1H);
  // Sheathed weapons make no stance (Stand stays); a melee stance ignores the bow on the back;
  // nothing held is unarmed.
  assert.equal(readyStance([weapon(15, 17, 8)], 0), undefined);
  assert.deepEqual(readyStance([weapon(17, 15, 2)], 1), READY_UNARMED);
  assert.deepEqual(readyStance(undefined, 1), [A.ReadyUnarmed]);
  // A creature without UNIT_FIELD_BYTES_2 holds its weapon (TC default MELEE).
  assert.equal(readyStance([weapon(15, 17, 1)], undefined)[0], A.Ready2H);
  // Old payloads without the subclass fall back on the inventory type; a relic is not a weapon.
  assert.equal(readyStance([weapon(15, 17)], 1)[0], A.Ready2H);
  assert.equal(readyStance([weapon(15, 21)], 1)[0], A.Ready1H);
  assert.equal(readyStance([weapon(17, 26)], 2), READY_UNARMED, "INVTYPE 26 alone is gun or wand");
  assert.equal(readyStance([weapon(17, 28, 7)], 2), READY_UNARMED, "a libram's subclass is not a sword's");
  // The same answer twice is the same array: nothing is built per frame.
  assert.equal(readyStance([weapon(15, 13, 7)], 1), readyStance([weapon(15, 13, 0)], 1));
});

// 12.10 6.03: Wow.exe 0x007171c0 plays the Emotes.dbc row's AnimID (+8) whatever its EmoteSpecProc, and is the only
// reader of the field that makes a pose (0x0073f4b0 only re-picks; 0x00746ad0 plays SpecProc 2's sound).
test("0x007171c0: every emote-state row is a held pose — one-shot rows too, AnimID-0 rows Stand", withData, () => {
  assert.equal(emoteStateAnimation(173), 136);
  assert.equal(emoteStateAnimation(10), A.EmoteDance);
  assert.equal(emoteStateAnimation(1), 60, "ONESHOT_TALK is held and looped: the NPC keeps talking");
  assert.equal(emoteStateAnimation(36), A.Attack1H, "ONESHOT_ATTACK1H: the soldier at the training dummy");
  assert.equal(emoteStateAnimation(428), ANIMATION_IDS.LootHold, "STATE_LOOT");
  for (const row of [12, 13, 65, 68, 313]) {
    assert.equal(emoteStateAnimation(row), A.Stand, `row ${row}: AnimID 0 is Stand, not the stand state its param names`);
  }
  assert.equal(emoteStateAnimation(999_999), undefined, "a value the table does not know is no stance");
  // The unit the player talks to sets aside a row with EmoteFlags 0x2000 (and turns to face the player).
  assert.equal(EMOTE_FLAG_STOPS_FOR_INTERACTION, 0x2000);
  assert.ok((EMOTE_FLAGS[233] & 0x2000) !== 0, "STATE_WORK_MINING carries 0x2000");
  assert.equal(emoteStateAnimation(233, true), undefined, "the miner stops for the player");
  assert.equal(emoteStateAnimation(233, false), 136);
  assert.equal((EMOTE_FLAGS[1] & 0x2000), 0);
  assert.equal(emoteStateAnimation(1, true), 60, "a row without 0x2000 goes on talking");
});

test("the standing ladder: crouch, then emote stance, then combat stance, then Stand", withData, () => {
  const work = standing({ emoteState: 136 });
  assert.deepEqual(poseAnimation(work).wanted, [136, A.Stand]);
  assert.equal(poseAnimation(work).loop, true);
  assert.equal(poseAnimation(standing({ emoteState: 136, movementFlags: MOVEMENT_FLAGS.forward })).wanted[0], A.Run,
    "a working NPC that walks off walks");
  assert.equal(poseAnimation(standing({ emoteState: 136, standState: 1 })).wanted[0], A.SitGround, "sitting wins");
  assert.equal(poseAnimation(standing({ emoteState: 136, dead: true })).wanted[0], A.Dead);
  const ready = readyStance([weapon(15, 13, 7)], 1);
  assert.equal(poseAnimation(standing({ ready })).wanted, ready, "the stance is the shared ladder");
  assert.equal(poseAnimation(standing({ ready, movementFlags: MOVEMENT_FLAGS.forward })).wanted[0], A.Run);
  assert.equal(poseAnimation(standing({ ready, emoteState: 136 })).wanted[0], 136, "a scripted stance outlasts the flag");
  assert.equal(poseAnimation(standing({ ready, stealth: true })).wanted[0], ANIMATION_IDS.StealthStand);
  // 12.10 6.03: the emote state before the crouch, as 0x007171c0 before 0x0071e340's StealthStand.
  assert.equal(poseAnimation(standing({ emoteState: 136, stealth: true })).wanted[0], 136);
  assert.deepEqual(poseAnimation(standing()).wanted, [A.Stand]);
  assert.equal(standingAnimations(standing()), standingAnimations(standing()), "Stand is not rebuilt per frame");
  assert.equal(standingAnimations(work), standingAnimations(standing({ emoteState: 136 })));
});

test("isBaseIdle: the unit stands on its own feet, whatever stance it holds there", withData, () => {
  assert.equal(isBaseIdle(standing()), true);
  assert.equal(isBaseIdle(standing({ emoteState: 136 })), true, "a working blacksmith takes a swing with his whole body");
  assert.equal(isBaseIdle(standing({ ready: [A.Ready1H] })), true, "so does a guard in his combat stance");
  // Without the stances it is exactly the old rule: the base's first wish is Stand.
  const F = MOVEMENT_FLAGS;
  const variants = [
    {}, { movementFlags: F.forward }, { movementFlags: F.strafeLeft }, { spline: true }, { mounted: true },
    { movementFlags: F.swimming }, { movementFlags: F.falling }, { movementFlags: F.fallingFar },
    { movementFlags: F.flying }, { movementFlags: F.hover, animationTier: 2 }, { movementFlags: F.hover },
    { stealth: true }, { dead: true }, ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((standState) => ({ standState })),
    { vehicleSeat: { id: 1, wanted: [A.Mount], start: undefined, hidden: false } },
  ];
  for (const extra of variants) {
    const pose = standing(extra);
    assert.equal(isBaseIdle(pose), poseAnimation(pose).wanted[0] === A.Stand, JSON.stringify(extra));
    assert.equal(isBaseIdle({ ...pose, ready: [A.Ready1H], emoteState: 136 }), isBaseIdle(pose), JSON.stringify(extra));
  }
});

test("applyStandingPose reads field 83, the combat flag and the sheath byte", withData, () => {
  const fields = (entries) => new Map(entries);
  const EMOTE = UPDATE_FIELDS.UNIT_NPC_EMOTESTATE.offset;
  const FLAGS = UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset;
  const BYTES2 = UPDATE_FIELDS.UNIT_FIELD_BYTES_2.offset;
  assert.equal(EMOTE, 83);
  const worker = standing();
  applyStandingPose(worker, fields([[EMOTE, 173]]), undefined);
  assert.equal(worker.emoteState, 136);
  assert.equal(worker.ready, undefined, "out of combat there is no stance");
  // 12.10 6.03: STATE_DEAD with the stand byte at 0 stands (0x007171c0: AnimID 0); the byte lays a corpse down.
  const corpse = standing();
  applyStandingPose(corpse, fields([[EMOTE, 65]]), undefined);
  assert.equal(corpse.standState, 0, "the emote state does not write the stand state");
  assert.equal(corpse.emoteState, A.Stand);
  const sitter = standing({ standState: 1 });
  applyStandingPose(sitter, fields([[EMOTE, 65]]), undefined);
  assert.equal(sitter.standState, 1, "the stand-state byte stays");
  assert.equal(poseAnimation(sitter).wanted[0], A.SitGround, "and outranks the emote (0x0071e1f0 before 0x007171c0)");
  const miner = standing();
  applyStandingPose(miner, fields([[EMOTE, 233]]), undefined, true);
  assert.equal(miner.emoteState, undefined, "the miner the player talks to stands");
  const guard = standing();
  applyStandingPose(guard, fields([[FLAGS, IN_COMBAT], [BYTES2, 0x0101]]), [weapon(15, 17, 8)]);
  assert.equal(guard.ready[0], A.Ready2H);
  const hunter = standing();
  applyStandingPose(hunter, fields([[FLAGS, IN_COMBAT], [BYTES2, 2]]), [weapon(15, 13, 7), weapon(17, 15, 2)]);
  assert.equal(hunter.ready[0], A.ReadyBow);
  const caster = standing();
  applyStandingPose(caster, fields([[FLAGS, IN_COMBAT], [BYTES2, 0]]), [weapon(15, 17, 10)]);
  assert.equal(caster.ready, undefined, "weapons away: no stance");
  // 12.10 6.03: a one-shot value is a held base like any other, on first sight as on a change.
  const talker = standing();
  assert.equal(applyStandingPose(talker, fields([[EMOTE, 1]]), undefined), undefined, "nothing to play once");
  assert.equal(talker.emoteState, 60);
  assert.deepEqual(poseAnimation(talker), { wanted: [60, A.Stand], loop: true });
});

test("kneel, sleep and landing have their own one-shots; a far fall is Fall", withData, () => {
  const F = MOVEMENT_FLAGS;
  assert.equal(poseTransition(standing(), standing({ standState: 8 })), ANIMATION_IDS.KneelStart);
  assert.equal(poseTransition(standing({ standState: 8 }), standing()), ANIMATION_IDS.KneelEnd);
  assert.equal(poseTransition(standing(), standing({ standState: 3 })), A.SleepDown);
  assert.equal(poseTransition(standing({ standState: 3 }), standing()), ANIMATION_IDS.SleepUp);
  assert.equal(poseTransition(standing(), standing({ standState: 1 })), A.SitGroundDown, "unchanged");
  assert.equal(poseTransition(standing({ standState: 1 }), standing()), A.SitGroundUp, "unchanged");
  const air = standing({ movementFlags: F.falling | F.forward });
  assert.equal(poseTransition(air, standing({ movementFlags: F.forward })), ANIMATION_IDS.JumpLandRun);
  assert.equal(poseTransition(air, standing()), A.JumpEnd);
  assert.equal(poseTransition(air, standing({ movementFlags: F.backward })), A.JumpEnd, "only a forward landing runs on");
  assert.equal(poseTransition(standing(), air), A.JumpStart, "unchanged");
  assert.deepEqual(poseAnimation(standing({ movementFlags: F.fallingFar })).wanted, [A.Fall, A.Jump]);
  assert.deepEqual(poseAnimation(standing({ movementFlags: F.falling | F.fallingFar })).wanted, [A.Fall, A.Jump]);
  assert.deepEqual(poseAnimation(standing({ movementFlags: F.falling })).wanted, [A.Jump, A.Fall]);
});

test("STUNNED and LOOTING are held state entries that leave with their flag", withData, () => {
  const queue = new UnitActionQueue();
  const submit = (request) => queue.submit(request, 0);
  assert.equal(flagPoseBits(UNIT_FLAG_STUNNED | IN_COMBAT, false), UNIT_FLAG_STUNNED);
  assert.equal(flagPoseBits(UNIT_FLAG_STUNNED, true), 0, "a corpse shows none");
  syncFlagPoses(0, UNIT_FLAG_STUNNED, false, 0, undefined, submit);
  const stun = queue.top();
  assert.equal(stun.layer, "state");
  assert.equal(stun.held, true);
  assert.equal(stun.until, Number.POSITIVE_INFINITY);
  assert.equal(stun.owner, FLAG_POSE_STUN);
  assert.deepEqual(stun.payload.wanted, [ANIMATION_IDS.Stun]);
  // A hit's flinch cannot take it away, nor can time.
  assert.equal(queue.submit({ layer: "reaction", held: false, until: 3_000, payload: {} }, 100), undefined);
  queue.expire(1e12);
  assert.equal(queue.top(), stun);
  // Coming back into view with the flag still up does not stack a second hold.
  syncFlagPoses(0, UNIT_FLAG_STUNNED, false, 500, queue, submit);
  assert.equal(queue.size, 1);
  syncFlagPoses(UNIT_FLAG_STUNNED, 0, false, 900, queue, submit);
  assert.equal(queue.size, 0, "the flag falls, the stun goes");

  syncFlagPoses(0, UNIT_FLAG_LOOTING, false, 1_000, queue, submit);
  const loot = queue.top();
  assert.equal(loot.owner, FLAG_POSE_LOOT);
  assert.equal(loot.layer, "emote", "walking away ends the loot pose instead of sliding in it");
  assert.equal(loot.held, true);
  assert.equal(loot.payload.stage, "lead");
  assert.deepEqual(loot.payload.wanted, [A.Loot]);
  assert.deepEqual(loot.payload.followUp, { animation: ANIMATION_IDS.LootHold, mode: "hold" });
  syncFlagPoses(UNIT_FLAG_LOOTING, 0, false, 2_000, queue, submit);
  assert.equal(queue.size, 1);
  const up = queue.top();
  assert.equal(up.held, false);
  assert.equal(up.layer, "emote");
  assert.deepEqual(up.payload.wanted, [ANIMATION_IDS.LootUp]);
  queue.clear();
  syncFlagPoses(UNIT_FLAG_LOOTING, 0, true, 3_000, queue, submit);
  assert.equal(queue.size, 0, "a looter who died does not get up");
});

// 05.10: ревью C. Measured on the clean corpus (.runtime/re-2026-10-05/A7a-C-review/probe-seq.mjs,
// probe-lootshape.mjs): every playable rig carries Loot (500 ms) and JumpLandRun, none carries
// LootHold or LootUp — both fall back to Loot in AnimationData — and HumanMale's Loot is a one-way
// motion that ends 0.56 yd lower than it starts.
// 12.10 6.07: Wow.exe asks for LootUp (0xbd) whatever the rig (0x00724280), and 0x00826350 plays its fallback Loot
// backwards — LootUp's Flags carry 0x10 — so the way down becomes the way up; LootHold (Flags 0x20) holds Loot's
// last frame. (05.10 review C left LootUp out on a rig without it, because forwards it was a second dip.)
test("12.10: LootUp on every rig, as Loot backwards; LootHold as Loot held down", withData, () => {
  const { heldClipPlaysOnce } = UnitArbiter;
  assert.equal(heldClipPlaysOnce(A.Loot), true, "LootHold resolved to Loot holds the last frame instead of bobbing");
  assert.equal(heldClipPlaysOnce(ANIMATION_IDS.LootHold), false, "a rig with its own LootHold (DruidBear) loops it");
  const queue = new UnitActionQueue();
  const submit = (request) => queue.submit(request, 0);
  syncFlagPoses(UNIT_FLAG_LOOTING, 0, false, 2_000, queue, submit);
  assert.deepEqual(queue.top()?.payload.wanted, [ANIMATION_IDS.LootUp], "getting up is asked for on every rig");
  assert.equal(wantedPlayback([ANIMATION_IDS.LootUp], A.Loot), PLAYBACK_BACKWARD, "a rig without LootUp plays Loot backwards");
  assert.equal(wantedPlayback([ANIMATION_IDS.LootUp], ANIMATION_IDS.LootUp), PLAYBACK_FORWARD, "one with it plays its own");
  assert.equal(wantedPlayback([ANIMATION_IDS.LootHold], A.Loot), PLAYBACK_HOLD_LAST, "and LootHold is Loot's last frame");
});

test("review C: a landing that resolves to the gait itself plays no one-shot", withData, () => {
  const base = new Set([A.Stand, A.Run, A.Walk, A.Jump, A.JumpEnd, A.Fall]);
  assert.equal(poseTransitionClip(base, ANIMATION_IDS.JumpLandRun), undefined,
    "JumpLandRun → Run as a one-shot is one stride, then a phase restart of the same clip");
  assert.equal(poseTransitionClip(new Set([...base, ANIMATION_IDS.JumpLandRun]), ANIMATION_IDS.JumpLandRun),
    ANIMATION_IDS.JumpLandRun);
  assert.equal(poseTransitionClip(base, A.JumpEnd), A.JumpEnd);
  assert.equal(poseTransitionClip(new Set([ANIMATION_IDS.KneelStart]), ANIMATION_IDS.KneelEnd), ANIMATION_IDS.KneelStart,
    "the table's fallback still answers outside the gaits");
  assert.equal(poseTransitionClip(base, undefined), undefined);
});
