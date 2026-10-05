// 6.21 (05.10): the journal of the ability-animation decisions of 29.09, each next to the Wow.exe
// 3.3.5a (12340) address that settles it. Changing a decision means changing this file on purpose.
// Notes: .runtime/re-2026-10-05/l621/ (probe-split.out.txt, r1.c, 723e30.asm.txt, 73b140.asm.txt).

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { ANIMATION_DATA_AVAILABLE, ANIMATION_IDS } from "../dist/code/generated/animations.js";
import {
  WOW_SPLIT_BEHAVIORS, animationBehavior, animationSplitsOverBase, kitWoundAnimation, kitWoundBehavior,
} from "../dist/code/browser/game/AnimationSplit.js";
import {
  CAST_END_GRACE_MS, kitAnimations, kitNamesPose, planSpellCastStart,
} from "../dist/code/browser/SpellVisuals.js";
import { UNIT_ACTION_PRIORITY, animationPlaysOnUpperBody } from "../dist/code/browser/UnitActionArbiter.js";
import { SwingReactionCues } from "../dist/code/browser/game/SwingReactionCues.js";
import {
  WOW_ATTACK_BEHAVIORS, attackSplitsWhileFalling, poseTakesWholeBody, unitBaseSeated,
  wholeBodyOutlivesBase, // 05.10: ревью 6.21b
} from "../dist/code/browser/game/ActionOverBase.js"; // 05.10-6.21b
import { unitActionDisplay } from "../dist/code/browser/UnitActionArbiter.js"; // 05.10-6.21b

const withAnimationData = { skip: ANIMATION_DATA_AVAILABLE ? false : "no locally generated animation data" };
const kit = (startAnimation, animation) => ({ id: 1, startAnimation, animation, effects: [], sound: 0 });

test("decision 1: kit animation id 0 names no pose, as -1 does (Wow.exe 0x7fa3a4: signed > 0)", () => {
  assert.equal(kitNamesPose(-1), false);
  assert.equal(kitNamesPose(0), false);
  assert.equal(kitNamesPose(1), true);
  assert.deepEqual(kitAnimations(kit(0, -1), 1n, 0, 0, "once", "reaction"), []);
  const single = kitAnimations(kit(0, 53), 1n, 0, 0, "once", "cast");
  assert.equal(single.length, 1);
  assert.equal(single[0].animation, 53);
  assert.equal(single[0].followUp, undefined, "a (0, 53) kit is one pose, not a lead-in");
});

test("decision 3: a precast holds cast time + 400 ms (not observable offline; 14.25 S5)", () => {
  assert.equal(CAST_END_GRACE_MS, 400);
  const plan = planSpellCastStart({ id: 1, precast: kit(-1, 52) },
    { caster: 1n, casterPoint: { x: 0, y: 0, z: 0 }, targets: [], castTime: 1500 }, 1000);
  assert.equal(plan.animations[0].hold, 1500 + 400);
});

test("decision 4: layers keep their order state > cast > melee > reaction > emote", () => {
  const order = Object.entries(UNIT_ACTION_PRIORITY).sort((a, b) => b[1] - a[1]).map(([layer]) => layer);
  assert.deepEqual(order, ["state", "cast", "melee", "reaction", "emote"]);
});

test("decision 2: the split over a moving base is Wow.exe's behaviour list 0x71d800, not Bodyflags 0x8", () => {
  // 0x723e30 asks 0x71d800 with the requested animation in eax (0x723f29) and splits only over a
  // moving/turning/swimming/flying base (movement flags & 0x2e000ff, 0x723f44); the split track is
  // the subtree of key bone 4 (SpineLow), else 6 (Head) (0x73e922-0x73e952).
  assert.equal(WOW_SPLIT_BEHAVIORS.size, 110);
  for (const id of [2, 8, 9, 10, 14, 31, 32, 51, 52, 53, 54, 57, 58, 74, 118, 124, 125, 130, 225]) {
    assert.equal(WOW_SPLIT_BEHAVIORS.has(id), true, `behaviour ${id}`);
  }
  for (const id of [0, 1, 4, 5, 6, 75, 79, 126, 199, 208, 212, 474, 502]) {
    assert.equal(WOW_SPLIT_BEHAVIORS.has(id), false, `behaviour ${id}`);
  }
  // BehaviorID: every row that differs from its id is a Fly twin of a ground row (277 of 506).
  const names = { 54: "SpellCastOmni", 283: "FlySpellCastOmni", 126: "Whirlwind", 355: "FlyWhirlwind", 600: "FlyNothing" };
  const ids = { SpellCastOmni: 54, FlySpellCastOmni: 283, Whirlwind: 126, FlyWhirlwind: 355, FlyNothing: 600 };
  assert.equal(animationBehavior(283, names, ids), 54);
  assert.equal(animationBehavior(600, names, ids), 600, "no ground twin, its own behaviour");
  assert.equal(animationSplitsOverBase(283, names, ids), true);
  assert.equal(animationSplitsOverBase(355, names, ids), false);
  assert.equal(animationSplitsOverBase(54, {}, {}), true, "without names the id is the behaviour");
});

test("decision 2 on this build's AnimationData", withAnimationData, () => {
  for (const name of ["SpellCastOmni", "SpellCastDirected", "ReadySpellOmni", "SpellPrecast", "Attack1H",
    "CombatWound", "EmoteTalk", "Special1H", "Special2H", "ChannelCastOmni", "ChannelCastDirected", "EmoteRoar",
    "FlySpellCastOmni", "FlyChannelCastOmni", "Stun"]) {
    assert.equal(animationPlaysOnUpperBody(ANIMATION_IDS[name]), true, `${name} splits over a moving base`);
  }
  for (const name of ["Whirlwind", "Mutilate", "EmoteTalkNoSheathe", "Stand", "Run", "EmoteKneel", "Death",
    "Carry2H", "FlyWhirlwind"]) {
    if (ANIMATION_IDS[name] === undefined) continue;
    assert.equal(animationPlaysOnUpperBody(ANIMATION_IDS[name]), false, `${name} does not split`);
  }
});

test("kit wound poses go through the flinch chooser (0x73b35f -> 0x736640)", () => {
  // AnimID with behaviour 8..10 (0x71d510); crit only for the raw id 10 (0x73b372 sete).
  assert.equal(kitWoundBehavior(9, {}, {}), true);
  assert.equal(kitWoundBehavior(7, {}, {}), false);
  assert.equal(kitWoundBehavior(11, {}, {}), false);
  assert.equal(kitWoundAnimation(10, false), 10, "CombatCritical stays");
  assert.equal(kitWoundAnimation(9, true), 9, "CombatWound for a unit with a melee target (+0xa20)");
  assert.equal(kitWoundAnimation(9, false), 8, "StandWound otherwise");
  assert.equal(kitWoundAnimation(8, true), 9);
  assert.equal(kitWoundAnimation(239, false), 8, "a Fly twin of CombatCritical is not the raw 10");
});

test("kitAnimations marks the AnimID wound of a non-state kit, never a lead-in or a state", () => {
  assert.equal(kitAnimations(kit(-1, 9), 1n, 0, 0, "once", "reaction")[0].kitWound, true);
  assert.equal(kitAnimations(kit(-1, 10), 1n, 0, 0, "once", "cast")[0].kitWound, true);
  assert.equal(kitAnimations(kit(-1, 9), 1n, 0, 0, "hold", "state")[0].kitWound, undefined,
    "a state kit goes through SetAnimation(-1), not the flinch (0x73b123)");
  assert.equal(kitAnimations(kit(10, -1), 1n, 0, 0, "once", "reaction")[0].kitWound, undefined,
    "StartAnimID is played as named (0x73b160)");
  assert.equal(kitAnimations(kit(-1, 53), 1n, 0, 0, "once", "cast")[0].kitWound, undefined);
  const lead = kitAnimations(kit(5, 9), 1n, 0, 0, "once", "reaction")[0];
  assert.equal(lead.kitWound, undefined);
  assert.equal(lead.followUp.kitWound, true);
});

test("the melee target the flinch reads is public on the cues", () => {
  const cues = new SwingReactionCues();
  const stamp = {};
  const host = { sameUnit: (_unit, s) => s === stamp };
  assert.equal(cues.hasMeleeTarget(5n, host), false);
  cues.attackStarted(5n, 6n, stamp);
  assert.equal(cues.hasMeleeTarget(5n, host), true);
  assert.equal(cues.hasMeleeTarget(5n, { sameUnit: () => false }), false, "a recreated unit has none");
  cues.attackStarted(5n, 6n, stamp);
  cues.attackStopped(5n);
  assert.equal(cues.hasMeleeTarget(5n, host), false);
});

// The renderer's #setUnitAnimation, extracted from source as unit-action-arbiter.test.mjs does.
const RENDERER_SOURCE = process.env.UNIT_ACTION_RENDERER_SOURCE
  ?? new URL("../src/browser/WorldRenderer3D.ts", import.meta.url);
function setUnitAnimationHarness(dependencies) {
  const source = readFileSync(RENDERER_SOURCE, "utf8");
  const parsed = ts.createSourceFile("WorldRenderer3D.ts", source, ts.ScriptTarget.Latest, true);
  const renderer = parsed.statements.find((node) => ts.isClassDeclaration(node) && node.name?.text === "WorldRenderer3D");
  const member = renderer.members.find((candidate) => candidate.name?.getText(parsed) === "#setUnitAnimation");
  assert.ok(member);
  const body = ts.transpileModule(`class Harness { ${member.getText(parsed).replaceAll("#", "")} }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return Function(...Object.keys(dependencies), `${body}; return Harness;`)(...Object.values(dependencies));
}

test("renderer: a kit wound resolves by the unit's melee target when it is queued", () => {
  const Harness = setUnitAnimationHarness({ ACTION_CLIP_WAIT: 900, ACTION_SIDECAR_WAIT: 3_000, kitWoundAnimation });
  const h = new Harness();
  const submitted = [];
  h.submitUnitAction = (guid, request) => submitted.push(request);
  const wound = { guid: 7n, animation: 9, at: 0, hold: 0, mode: "once", layer: "reaction", kitWound: true };
  h.setUnitAnimation(wound, "visual");
  assert.deepEqual(submitted[0].payload.wanted, [8], "no melee target known: StandWound");
  h.kitWoundCombat = (guid) => guid === 7n;
  h.setUnitAnimation(wound, "visual");
  assert.deepEqual(submitted[1].payload.wanted, [9]);
  h.setUnitAnimation({ ...wound, kitWound: undefined }, "visual");
  assert.deepEqual(submitted[2].payload.wanted, [9], "an unmarked pose is played as named");
  h.kitWoundCombat = () => false;
  h.setUnitAnimation({ guid: 7n, animation: 5, at: 0, hold: 0, mode: "once", layer: "reaction",
    followUp: { animation: 9, mode: "once", hold: 0, kitWound: true } }, "visual");
  assert.deepEqual(submitted[3].payload.wanted, [5]);
  assert.equal(submitted[3].payload.followUp.animation, 8, "the follow-up AnimID is the one rerouted");
});

// 05.10 review 6.21: the host hands the renderer the `+0xa20` question once, keeps it through
// SMSG_ATTACK_START/STOP, and takes back only its own callback on dispose.
test("review: SwingMeleeReactions wires kitWoundCombat once and releases only its own", async () => {
  const { SwingMeleeReactions } = await import("../dist/code/browser/game/SwingReactionHost.js");
  const unit = { fields: new Map() };
  const world = { objects: new Map([[5n, unit]]) };
  let renderer;
  const reactions = new SwingMeleeReactions(world, () => renderer);
  renderer = { afterUnits: undefined, kitWoundCombat: undefined, playUnitAction: () => undefined,
    playUnitReaction: () => {}, meleeSwingProgress: () => undefined };
  reactions.meleeAttack(5n, 6n); // the renderer appears after the entry: the first start attaches
  const wired = renderer.kitWoundCombat;
  assert.equal(typeof wired, "function");
  assert.equal(wired(5n), true, "a unit with SMSG_ATTACK_START has a melee target");
  assert.equal(wired(6n), false);
  reactions.meleeAttack(5n, 6n);
  assert.equal(renderer.kitWoundCombat === wired, true, "no second attach");
  reactions.meleeAttack(5n, undefined);
  assert.equal(wired(5n), false, "SMSG_ATTACK_STOP clears it");
  reactions.dispose();
  assert.equal(renderer.kitWoundCombat, undefined, "dispose takes its callback back");
  const other = () => true;
  const next = new SwingMeleeReactions(world, () => renderer);
  renderer.kitWoundCombat = other; // a later entry's own callback
  next.dispose();
  assert.equal(renderer.kitWoundCombat === other, true, "a foreign callback is left alone");
});

/* --- 05.10-6.21b: owner decision — a pose off the list over a travelling base takes the whole body - */

const base = (extra = {}) => ({ dead: false, movementFlags: 0, spline: false, standState: 0, ...extra });

test("6.21b: a one-shot off the split list plays with the whole body over a travelling base (0x723e30 -> whole-model track)", () => {
  // Travel: moving, on a spline, swimming, flying, falling, sneaking — the legs take the pose.
  for (const [label, pose] of [["running", base({ movementFlags: 0x1 })], ["on a spline", base({ spline: true })],
    ["swimming", base({ movementFlags: 0x200000 })], ["flying", base({ movementFlags: 0x2000000 })],
    ["falling", base({ movementFlags: 0x1000 })], ["sneaking", base({ stealth: true })]]) {
    assert.equal(unitBaseSeated(pose), false, `${label} is travel`);
    assert.equal(poseTakesWholeBody(pose, false, false), true, `a one-shot off the list over ${label} takes the whole body`);
    assert.equal(poseTakesWholeBody(pose, true, false), false, `a listed pose over ${label} still splits`);
    assert.equal(poseTakesWholeBody(pose, false, true), false, `a hold over ${label} keeps waiting`);
  }
  // Rider (0x7385c0 rider branch: neither track), vehicle seat, sitting: unchanged, the pose gives way.
  for (const [label, pose] of [["mounted", base({ mounted: true, movementFlags: 0x1 })],
    ["in a vehicle seat", base({ vehicleSeat: { wanted: [91] } })], ["sitting", base({ standState: 1 })],
    ["kneeling", base({ standState: 8 })], ["dead", base({ dead: true })]]) {
    assert.equal(unitBaseSeated(pose), true, `${label} is seated`);
    assert.equal(poseTakesWholeBody(pose, false, false), false, `${label}: the one-shot gives way`);
  }
  assert.equal(unitBaseSeated(base({ vehicleSeat: { wanted: [] } })), false, "a seat with no pose of its own is no seat");
  // The display: idle and listed-with-a-cut come first, an aura state keeps the body, then the decision.
  assert.equal(unitActionDisplay("cast", false, false, true), "full", "Mutilate on the run: the whole body");
  assert.equal(unitActionDisplay("cast", false, false, false), "yield");
  assert.equal(unitActionDisplay("cast", false, false), "yield", "the old three-argument call is unchanged");
  assert.equal(unitActionDisplay("cast", true, false, true), "upper", "a split pose never takes the legs");
  assert.equal(unitActionDisplay("emote", false, true, false), "full", "standing still: the whole body, as always");
});

test("6.21b: an attack-class pose off the list splits over a fall (0x71d590 + FALLING, 0x723fc0)", () => {
  assert.equal(WOW_ATTACK_BEHAVIORS.size, 33);
  for (const id of [10, 16, 24, 30, 36, 57, 95, 117, 118, 170, 179, 212]) assert.equal(WOW_ATTACK_BEHAVIORS.has(id), true, `behaviour ${id}`);
  for (const id of [14, 25, 31, 54, 126, 169, 180, 211, 213]) assert.equal(WOW_ATTACK_BEHAVIORS.has(id), false, `behaviour ${id}`);
  assert.equal(attackSplitsWhileFalling(212, 0x1000, {}, {}), true, "Mutilate in a fall");
  assert.equal(attackSplitsWhileFalling(212, 0x1001, {}, {}), true, "Mutilate in a running jump");
  assert.equal(attackSplitsWhileFalling(212, 0x2001, {}, {}), false, "FALLING_FAR alone is not the bit 0x723fd1 tests");
  assert.equal(attackSplitsWhileFalling(212, 0x1, {}, {}), false, "Mutilate on the run takes the whole body");
  assert.equal(attackSplitsWhileFalling(14, 0x1000, {}, {}), false, "Stun is no attack");
});

test("6.21b on this build's AnimationData: Mutilate takes the whole body on the run and splits in a fall", withAnimationData, () => {
  const mutilate = ANIMATION_IDS.Mutilate;
  assert.equal(mutilate, 212);
  assert.equal(animationPlaysOnUpperBody(mutilate), false);
  assert.equal(animationPlaysOnUpperBody(mutilate, 0x1), false);
  assert.equal(animationPlaysOnUpperBody(mutilate, 0x1000), true);
  assert.equal(animationPlaysOnUpperBody(ANIMATION_IDS.Kick, 0x1000), true);
  assert.equal(animationPlaysOnUpperBody(ANIMATION_IDS.Whirlwind, 0x1000), false, "Whirlwind is no attack class");
  assert.equal(animationPlaysOnUpperBody(ANIMATION_IDS.Stun, 0x1000), true, "a listed pose splits in a fall (0x723350)");
});

// 05.10: ревью 6.21b — the base re-set: a whole-body pose begun with the unit still shares the
// whole-model track with the base, which the run replaces when the unit sets off.
test("review 6.21b: a whole-body pose begun standing ends when the unit sets off; one begun on the run keeps going", () => {
  const still = { started: false };
  assert.equal(wholeBodyOutlivesBase(still, false), true, "not started: never refused");
  still.started = true;
  assert.equal(wholeBodyOutlivesBase(still, false), true, "begun standing, still standing");
  assert.equal(wholeBodyOutlivesBase(still, true), false, "begun standing, now running: over");
  const running = { started: false };
  assert.equal(wholeBodyOutlivesBase(running, true), true);
  running.started = true;
  assert.equal(wholeBodyOutlivesBase(running, true), true, "begun on the run, still running");
  assert.equal(wholeBodyOutlivesBase(running, false), true, "and when it stops");
  // The answer is the travel noted on the last frame before it started.
  const late = { started: false };
  wholeBodyOutlivesBase(late, true);
  wholeBodyOutlivesBase(late, false);
  late.started = true;
  assert.equal(wholeBodyOutlivesBase(late, true), false);
});

test("review 6.21b: the attack class is answered by behaviour for Fly twins too, and only in a fall", () => {
  const names = { 212: "Mutilate", 600: "FlyMutilate", 601: "FlyWhirlwind", 126: "Whirlwind" };
  const ids = { Mutilate: 212, Whirlwind: 126 };
  for (let pass = 0; pass < 2; pass++) { // the second pass answers from the per-id cache
    assert.equal(attackSplitsWhileFalling(600, 0x1000, names, ids), true, "FlyMutilate is Mutilate's attack");
    assert.equal(attackSplitsWhileFalling(601, 0x1000, names, ids), false, "FlyWhirlwind is no attack");
    assert.equal(attackSplitsWhileFalling(600, 0x1, names, ids), false, "not falling: no split");
  }
});
