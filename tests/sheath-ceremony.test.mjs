// 12.10 6.08 — «анимации доставания и убирания оружия не сделаны». Wow.exe plays Sheath (89) or HipSheath (90)
// on one arm per piece — key bone 3 (ShoulderR) for the main hand, 2 (ShoulderL) for the off hand — through
// 0x00736b60 → 0x00735820 → `CM2Model::SetBoneSequence` (0x00832ab0), and moves the piece at the clip's own
// `$SHR`/`$SHL` event (0x00732650 → 0x00732500 → 0x007310a0). Only the active player's ToggleSheath
// (0x0051a6b0 → 0x006e23a0 → 0x00736d30(next, 0, 0)) does it; a field update (0x00737aa0 → 0x00736d30(byte,
// 1, 1)) moves the pieces at once. See src/browser/SheathCeremony.ts and src/browser/SheathArms.ts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as THREE from "three";
import { buildSkinnedTemplateFrom, instantiateSkinned, applyGlobalSequenceBones } from "../dist/code/browser/AnimatedModel.js";
import {
  HIP_SHEATH_ANIMATION, KEY_BONE_SHOULDER_LEFT, KEY_BONE_SHOULDER_RIGHT, SHEATH_ANIMATION, SHEATH_ECHO_WAIT_MS,
  SHEATH_EVENTS, SHEATH_EVENT_MEDIAN, SHEATH_REQUEST_WAIT_MS, armOfPiece, beginSheathCeremony, ceremonyBusyUntil,
  ceremonySheath, ownSheathRefused, publishOwnSheathRig, requestOwnSheath, resetOwnSheath, rigRefusesSheath,
  settleSheathCeremony, sheathAnimationFor, sheathArmPlans, sheathEventFraction, stepOwnSheath, takeOwnSheathRequest,
} from "../dist/code/browser/SheathCeremony.js";
import {
  keyBoneSubtree, poseSheathArm, resetArmBones, sheathArmPlaying, sheathArmWeight,
} from "../dist/code/browser/SheathArms.js";
import { closedHandsFor, HAND_RIGHT, HANDS_CLOSED_ANIMATION } from "../dist/code/browser/HandsClosed.js";
import { worldAttachmentPoint } from "../dist/code/browser/SheathPoints.js";
import { SHEATH_MELEE, SHEATH_RANGED, SHEATH_UNARMED } from "../dist/code/browser/Attachment.js";
import { ANIMATION_IDS } from "../dist/code/generated/animations.js";
import { decodeWvm9 } from "../dist/code/browser/Wvm.js";
import { m2Animations, parseM2, parseM2Skeleton } from "../tools/m2.mjs";
import { encodeWvm9 } from "../tools/wvm.mjs";

let archives;
try {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const { clientDirectory } = await import("../tools/paths.mjs");
  archives = await clientArchives(clientDirectory());
} catch {
  archives = undefined;
}
const withClient = { skip: archives ? false : "no 3.3.5a client on this machine" };

const piece = (slot, inventoryType, sheathe) => ({
  slot, inventoryType, sheathe, side: "right", model: `Item\\${slot}.m2`, texture: "",
});
const pointOf = (item, sheath) => worldAttachmentPoint(item, sheath, item.sheathe);
const SWORD = piece(15, 13, 3);
const DAGGER_OFF = piece(16, 13, 3);
const TWO_HANDER = piece(15, 17, 1);
const STAFF = piece(15, 17, 2);
const SHIELD = piece(16, 14, 4);
const FIST = piece(15, 13, 7);
const BOW = piece(17, 15, 0);
const GUN = piece(17, 26, 0);
const THROWN = piece(17, 25, 0);

test("0x007367b0: HipSheath for SheatheType 3 and 7 ((1 << type) & 0x88), Sheath otherwise", () => {
  assert.equal(SHEATH_ANIMATION, 0x59);
  assert.equal(HIP_SHEATH_ANIMATION, 0x5a);
  assert.equal(SHEATH_ANIMATION, ANIMATION_IDS.Sheath ?? SHEATH_ANIMATION);
  assert.equal(HIP_SHEATH_ANIMATION, ANIMATION_IDS.HipSheath ?? HIP_SHEATH_ANIMATION);
  assert.equal(sheathAnimationFor(3), HIP_SHEATH_ANIMATION, "a one-hander on the hip");
  assert.equal(sheathAnimationFor(7), HIP_SHEATH_ANIMATION, "a fist weapon");
  for (const type of [0, 1, 2, 4, 5, 6, undefined]) assert.equal(sheathAnimationFor(type), SHEATH_ANIMATION, `type ${type}`);
});

test("0x00735820: the main hand's arm is key bone 3, the off hand's 2; a bow is the left arm's, a gun or thrown the right's", () => {
  assert.equal(KEY_BONE_SHOULDER_RIGHT, 3);
  assert.equal(KEY_BONE_SHOULDER_LEFT, 2);
  assert.equal(armOfPiece(SWORD), KEY_BONE_SHOULDER_RIGHT);
  assert.equal(armOfPiece(SHIELD), KEY_BONE_SHOULDER_LEFT);
  assert.equal(armOfPiece(BOW), KEY_BONE_SHOULDER_LEFT);
  assert.equal(armOfPiece(GUN), KEY_BONE_SHOULDER_RIGHT);
  assert.equal(armOfPiece(THROWN), KEY_BONE_SHOULDER_RIGHT);
  assert.equal(armOfPiece(piece(0, 1, undefined)), undefined, "a helmet is nobody's");
});

test("0x00736b60: the arms a toggle plays, with which clip, and which slots each one's event moves", () => {
  const plans = (pieces, from, to) => sheathArmPlans(pieces, from, to, pointOf)
    .map((plan) => [plan.keyBone, plan.animation, plan.slots.join(",")]);
  // A rogue's pair: both arms, both on the hips.
  assert.deepEqual(plans([SWORD, DAGGER_OFF], SHEATH_UNARMED, SHEATH_MELEE),
    [[3, HIP_SHEATH_ANIMATION, "15"], [2, HIP_SHEATH_ANIMATION, "16"]]);
  assert.deepEqual(plans([SWORD, DAGGER_OFF], SHEATH_MELEE, SHEATH_UNARMED),
    [[3, HIP_SHEATH_ANIMATION, "15"], [2, HIP_SHEATH_ANIMATION, "16"]]);
  // A two-hander or a staff: the right arm only, over the shoulder.
  assert.deepEqual(plans([TWO_HANDER], SHEATH_UNARMED, SHEATH_MELEE), [[3, SHEATH_ANIMATION, "15"]]);
  assert.deepEqual(plans([STAFF], SHEATH_MELEE, SHEATH_UNARMED), [[3, SHEATH_ANIMATION, "15"]]);
  // Sword and board: the shield is SheatheType 4.
  assert.deepEqual(plans([SWORD, SHIELD], SHEATH_MELEE, SHEATH_UNARMED),
    [[3, HIP_SHEATH_ANIMATION, "15"], [2, SHEATH_ANIMATION, "16"]]);
  // A fist weapon is not hung stowed, and still plays HipSheath as it goes (0x007310a0 to no point).
  assert.deepEqual(plans([FIST], SHEATH_MELEE, SHEATH_UNARMED), [[3, HIP_SHEATH_ANIMATION, "15"]]);
  // Melee to the bow: the right arm puts the sword away, the left draws the bow (007368b0, its own SheatheType 0 → 89).
  assert.deepEqual(plans([SWORD, BOW], SHEATH_MELEE, SHEATH_RANGED),
    [[3, HIP_SHEATH_ANIMATION, "15"], [2, SHEATH_ANIMATION, "17"]]);
  // Unarmed to the gun: the right arm (007369b0).
  assert.deepEqual(plans([SWORD, GUN], SHEATH_UNARMED, SHEATH_RANGED), [[3, SHEATH_ANIMATION, "17"]]);
  // Putting a ranged piece away is always Sheath (the literal 0x59 of 0x00736b60's state-2 branch).
  const hipBow = piece(17, 15, 3);
  assert.deepEqual(plans([hipBow], SHEATH_RANGED, SHEATH_UNARMED), [[2, SHEATH_ANIMATION, "17"]]);
  assert.deepEqual(plans([SWORD, DAGGER_OFF, hipBow], SHEATH_RANGED, SHEATH_MELEE),
    [[3, HIP_SHEATH_ANIMATION, "15"], [2, SHEATH_ANIMATION, "16,17"]]);
  // Nothing in the hands to move between 0 and 1: no arm plays.
  assert.deepEqual(plans([BOW], SHEATH_UNARMED, SHEATH_MELEE), []);
  assert.deepEqual(plans([], SHEATH_MELEE, SHEATH_UNARMED), []);
});

test("`$SHR`/`$SHL`: each arm's pieces hang by the old state until its event, by the new one from it", () => {
  const plans = sheathArmPlans([SWORD, DAGGER_OFF], SHEATH_UNARMED, SHEATH_MELEE, pointOf);
  const model = "Character\\NightElf\\Female\\NightElfFemale.m2";
  const ceremony = beginSheathCeremony(plans, SHEATH_UNARMED, SHEATH_MELEE, 1000,
    (animation) => (animation === HIP_SHEATH_ANIMATION ? { duration: 1, blend: 0.15 } : undefined),
    (animation, keyBone) => sheathEventFraction(model, animation, keyBone));
  // NightElfFemale's HipSheath: `$SHR` at 0.400, `$SHL` at 0.334 of the clip.
  const [right, left] = ceremony.arms;
  assert.equal(right.eventAt, 1400);
  assert.equal(left.eventAt, 1334);
  assert.equal(right.endAt, 2000);
  assert.equal(ceremonySheath(ceremony, 15, 1399), SHEATH_UNARMED, "the sword still on the hip");
  assert.equal(ceremonySheath(ceremony, 15, 1400), SHEATH_MELEE, "in the hand at the event");
  assert.equal(ceremonySheath(ceremony, 16, 1340), SHEATH_MELEE, "the left hand's own, earlier event");
  assert.equal(ceremonySheath(ceremony, 0, 1000), SHEATH_MELEE, "a piece no arm moves hangs by the new state");
  assert.equal(ceremonyBusyUntil(ceremony), 2000);
  // A rig whose clip is not built yet: the pieces move at once and nothing plays (0x00731f40's move).
  const bare = beginSheathCeremony(plans, SHEATH_UNARMED, SHEATH_MELEE, 1000, () => undefined, () => 0.5);
  assert.equal(ceremonySheath(bare, 15, 1000), SHEATH_MELEE);
  assert.equal(bare.arms[0].duration, 0);
  assert.equal(ceremonyBusyUntil(bare), -Infinity, "nothing playing: ToggleSheath is not held up");
  // The blend never outlasts half the clip.
  const short = beginSheathCeremony(plans.slice(0, 1), SHEATH_UNARMED, SHEATH_MELEE, 0, () => ({ duration: 0.2, blend: 0.3 }), () => 0.5);
  assert.equal(short.arms[0].blend, 0.1);
});

test("SHEATH_EVENTS: the playable rigs by basename, any path form; any other rig takes the median", () => {
  assert.equal(Object.keys(SHEATH_EVENTS).length, 20, "ten races, two sexes");
  assert.equal(sheathEventFraction("Character\\Human\\Male\\HumanMale.m2", HIP_SHEATH_ANIMATION, KEY_BONE_SHOULDER_RIGHT), 0.567);
  assert.equal(sheathEventFraction("character/humanfemale/../Human/Female/HumanFemale.M2", HIP_SHEATH_ANIMATION, KEY_BONE_SHOULDER_LEFT), 0.4);
  assert.equal(sheathEventFraction("Character\\NightElf\\Female\\NightElfFemale.m2", SHEATH_ANIMATION, KEY_BONE_SHOULDER_RIGHT), 0.649);
  assert.equal(sheathEventFraction("Creature\\Ogre\\Ogre.m2", SHEATH_ANIMATION, KEY_BONE_SHOULDER_RIGHT), SHEATH_EVENT_MEDIAN);
  assert.equal(sheathEventFraction(undefined, SHEATH_ANIMATION, KEY_BONE_SHOULDER_LEFT), SHEATH_EVENT_MEDIAN);
});

test("0x00737aa0: a field moved anywhere but the two ends wins at once; the ceremony ends with its arms and the echo", () => {
  const plans = sheathArmPlans([TWO_HANDER], SHEATH_UNARMED, SHEATH_MELEE, pointOf);
  const ceremony = beginSheathCeremony(plans, SHEATH_UNARMED, SHEATH_MELEE, 0, () => ({ duration: 1, blend: 0.1 }), () => 0.5);
  assert.equal(settleSheathCeremony(ceremony, SHEATH_UNARMED, 500), ceremony, "no echo yet, still playing");
  const echoed = settleSheathCeremony(ceremony, SHEATH_MELEE, 500);
  assert.equal(echoed.echoed, true, "the echo of its own toggle is noted");
  assert.equal(echoed.arms, ceremony.arms, "and changes nothing else");
  assert.equal(settleSheathCeremony(echoed, SHEATH_MELEE, 600), echoed);
  assert.equal(settleSheathCeremony(echoed, SHEATH_UNARMED, 600), undefined,
    "back to the old state after the echo: the server's own (a swing drawing again), at once");
  assert.equal(settleSheathCeremony(ceremony, SHEATH_RANGED, 500), undefined, "a state the server forced: at once");
  assert.equal(settleSheathCeremony(ceremony, SHEATH_MELEE, 1000), undefined, "over and echoed");
  assert.equal(settleSheathCeremony(ceremony, SHEATH_UNARMED, 1000), ceremony, "over, the echo still on the way");
  assert.equal(settleSheathCeremony(ceremony, SHEATH_UNARMED, SHEATH_ECHO_WAIT_MS), undefined, "a refused toggle snaps back");
  assert.equal(settleSheathCeremony(undefined, SHEATH_MELEE, 0), undefined);
});

test("0x006e23a0's guards: no Sheath/HipSheath or no shoulder key bones, or an arm still playing, refuses the toggle", () => {
  const keyBones = Int16Array.from({ length: 27 }, (_, index) => (index < 4 ? 10 + index : -1));
  assert.equal(rigRefusesSheath(new Set([0, 89, 90]), keyBones), false);
  assert.equal(rigRefusesSheath(new Set([0, 89]), keyBones), true, "a cat has neither");
  assert.equal(rigRefusesSheath(new Set([0, 90]), keyBones), true);
  const noShoulder = keyBones.slice(); noShoulder[2] = -1;
  assert.equal(rigRefusesSheath(new Set([89, 90]), noShoulder), true);
  assert.equal(rigRefusesSheath(new Set([89, 90]), keyBones.subarray(0, 3)), true, "a table too short for key bone 3");
  assert.equal(rigRefusesSheath(new Set([0]), undefined), false, "no key bone table travelled: nothing is known, nothing refused");

  resetOwnSheath();
  assert.equal(ownSheathRefused(0), false, "no rig seen: nothing refused");
  publishOwnSheathRig(false, 1500, 1000);
  assert.equal(ownSheathRefused(1200), true, "an arm still plays");
  assert.equal(ownSheathRefused(1500), false);
  publishOwnSheathRig(true, -Infinity, 1000);
  assert.equal(ownSheathRefused(1500), true, "the rig cannot play the clips");
  assert.equal(ownSheathRefused(2500), false, "a report over a second old refuses nothing");
  resetOwnSheath();
});

test("the toggle reaches the renderer once, from the state on show, and goes stale unclaimed", () => {
  resetOwnSheath();
  requestOwnSheath(SHEATH_MELEE, 100);
  assert.equal(takeOwnSheathRequest(150), SHEATH_MELEE);
  assert.equal(takeOwnSheathRequest(160), undefined, "once");
  requestOwnSheath(SHEATH_MELEE, 100);
  assert.equal(takeOwnSheathRequest(100 + SHEATH_REQUEST_WAIT_MS + 1), undefined, "stale");

  const rig = { model: "Character\\Human\\Male\\HumanMale.m2", animations: new Set([0, 89, 90]),
    keyBones: Int16Array.from({ length: 27 }, () => 5), clip: () => ({ duration: 1, blend: 0.15 }) };
  const pieces = () => [SWORD, DAGGER_OFF];
  let ceremony = stepOwnSheath(undefined, SHEATH_UNARMED, 0, pieces, pointOf, rig);
  assert.equal(ceremony, undefined, "nothing asked");
  requestOwnSheath(SHEATH_MELEE, 10);
  ceremony = stepOwnSheath(undefined, SHEATH_UNARMED, 16, pieces, pointOf, rig);
  assert.equal(ceremony.from, SHEATH_UNARMED);
  assert.equal(ceremony.to, SHEATH_MELEE);
  assert.equal(ceremony.startedAt, 16, "started on the renderer's clock, before any echo");
  assert.equal(ceremony.arms[0].eventAt, 16 + 567, "HumanMale's HipSheath `$SHR`");
  assert.equal(ownSheathRefused(100), true, "the arms are playing");
  // Asked again for the state on show, before the echo (the field still 0): nothing new starts — the state on show
  // is the ceremony's, as Wow.exe's `[+0xb5c]` is set by the toggle and not by the field.
  requestOwnSheath(SHEATH_MELEE, 100);
  assert.equal(stepOwnSheath(ceremony, SHEATH_UNARMED, 120, pieces, pointOf, rig), ceremony);
  requestOwnSheath(SHEATH_MELEE, 100);
  const after = stepOwnSheath(ceremony, SHEATH_MELEE, 130, pieces, pointOf, rig);
  assert.equal(after.arms, ceremony.arms, "nor after it");
  assert.equal(after.echoed, true);
  resetOwnSheath();
});

// An arm in miniature: 0 root · 1 shoulder R (key 3) · 2 hand R · 3 index R (key 8) · 4 grip R ·
// 5 shoulder L (key 2) · 6 hand L · 7 spine.
const parents = Int16Array.from([-1, 0, 1, 2, 2, 0, 5, 0]);
const pivots = Float32Array.from([0, 0, 0, 0, -0.3, 1.4, 0, -0.5, 1, 0.05, -0.55, 0.9, 0, -0.52, 0.92, 0, 0.3, 1.4, 0, 0.5, 1, 0, 0, 1]);
const keyBones = Int16Array.from({ length: 27 }, () => -1);
keyBones[3] = 1; keyBones[2] = 5; keyBones[8] = 3;
const turn = (x, y, z) => new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z)).toArray();
const rotation = (bone, values, times = [0]) => ({ bone, kind: 1, times: Float32Array.from(times), values: Float32Array.from(values) });
const standTurn = (bone) => turn(0.1 * bone, -0.05 * bone, 0.2);
const STAND = { animationId: 0, duration: 1,
  channels: Array.from({ length: parents.length }, (_, bone) => rotation(bone, [...standTurn(bone), ...standTurn(bone)], [0, 1])) };
// Sheath keys the shoulder (moving) and the finger; the hand is not keyed and stands at its rest.
const SHOULDER_A = turn(0, 0, 0), SHOULDER_B = turn(1.2, 0, 0);
const SHEATH = { animationId: SHEATH_ANIMATION, duration: 1, blendTime: 0.1,
  channels: [rotation(1, [...SHOULDER_A, ...SHOULDER_B], [0, 1]), rotation(3, turn(0, 0.7, 0)), rotation(7, turn(0, 0, 1))] };
const HANDS_CLOSED = { animationId: HANDS_CLOSED_ANIMATION, duration: 0.033, channels: [rotation(3, turn(0, 1.4, 0))] };

function template() {
  const drawn = [1, 2, 3, 4, 5, 6, 7];
  const vertices = drawn.length * 3;
  const geometry = new THREE.BufferGeometry();
  const position = new Float32Array(vertices * 3), skinIndex = new Uint16Array(vertices * 4), skinWeight = new Float32Array(vertices * 4);
  for (let vertex = 0; vertex < vertices; vertex++) {
    position.set([Math.sin(vertex) * 0.1, vertex * 0.01, 1 + Math.cos(vertex) * 0.1], vertex * 3);
    skinIndex.set([drawn[vertex % drawn.length], 0, 0, 0], vertex * 4);
    skinWeight.set([1, 0, 0, 0], vertex * 4);
  }
  geometry.setAttribute("position", new THREE.BufferAttribute(position, 3));
  geometry.setAttribute("skinIndex", new THREE.BufferAttribute(skinIndex, 4));
  geometry.setAttribute("skinWeight", new THREE.BufferAttribute(skinWeight, 4));
  geometry.setIndex(Array.from({ length: vertices }, (_, vertex) => vertex));
  geometry.addGroup(0, vertices, 0);
  const clips = [STAND, SHEATH, HANDS_CLOSED];
  return buildSkinnedTemplateFrom(geometry, {
    parents, pivots, flags: new Uint16Array(parents.length), animations: clips.map((clip) => clip.animationId), clips,
    globalChannels: [],
  }, 2);
}
const sameTurn = (actual, expected, label) => {
  const a = new THREE.Quaternion(...actual).normalize(), b = new THREE.Quaternion(...expected).normalize();
  assert.ok(Math.abs(Math.abs(a.dot(b)) - 1) < 1e-5, `${label}: ${actual} vs ${expected}`);
};

test("0x00832ab0 on key bone 3: the shoulder and every bone below it, nothing else", () => {
  assert.deepEqual([...keyBoneSubtree(parents, keyBones, KEY_BONE_SHOULDER_RIGHT)], [1, 2, 3, 4]);
  assert.deepEqual([...keyBoneSubtree(parents, keyBones, KEY_BONE_SHOULDER_LEFT)], [5, 6]);
  assert.deepEqual([...keyBoneSubtree(parents, undefined, 3)], [], "no table, no arm");
  assert.equal(keyBoneSubtree(parents, keyBones, 3), keyBoneSubtree(parents, keyBones, 3), "cached per rig");
  const arm = { startAt: 1000, duration: 1, blend: 0.1 };
  assert.equal(sheathArmWeight(arm, 999), 0);
  assert.equal(sheathArmWeight(arm, 1050), 0.5);
  assert.equal(sheathArmWeight(arm, 1500), 1);
  assert.ok(Math.abs(sheathArmWeight(arm, 1950) - 0.5) < 1e-9);
  assert.equal(sheathArmWeight(arm, 2000), 0);
  assert.equal(sheathArmPlaying(arm, 1999), true);
  assert.equal(sheathArmPlaying(arm, 2000), false);
  assert.equal(sheathArmPlaying({ startAt: 0, duration: 0 }, 0), false);
});

test("the arm plays the clip over Three's pose, a closed hand keeps its own, and the release gives the arm back to Stand", () => {
  const tpl = template();
  const scene = new THREE.Scene();
  const instance = instantiateSkinned(tpl, new THREE.MeshBasicMaterial());
  scene.add(instance.root);
  instance.mixer.clipAction(tpl.clips.get(0)).play();
  const hands = closedHandsFor(tpl, keyBones, HAND_RIGHT);
  const arm = { startAt: 0, duration: 1, blend: 0.1 };
  const clip = tpl.clips.get(SHEATH_ANIMATION);
  const bones = keyBoneSubtree(parents, keyBones, KEY_BONE_SHOULDER_RIGHT);
  const objects = instance.skeleton.bones;
  let previous = false;
  const dt = 1 / 50;
  for (let frame = 0; frame <= 70; frame++) {
    const now = frame * dt * 1000;
    const playing = sheathArmPlaying(arm, now);
    // `#sheathArmsStep`: last step's arm and this step's back to their rest, every bound property written again.
    if (previous || playing) resetArmBones(instance, tpl, bones);
    previous = playing;
    instance.mixer.update(dt);
    applyGlobalSequenceBones(instance, hands.source, new Uint32Array(0), now);
    if (playing) poseSheathArm(instance, tpl, clip, bones, now / 1000, sheathArmWeight(arm, now), hands.bones);
    if (frame === 25) {
      const expected = new THREE.Quaternion(...SHOULDER_A).slerp(new THREE.Quaternion(...SHOULDER_B), 0.5);
      sameTurn(objects[1].quaternion.toArray(), expected.toArray(), "mid-clip: the shoulder on Sheath");
      sameTurn(objects[2].quaternion.toArray(), [0, 0, 0, 1], "the hand Sheath does not key stands at its rest, not on Stand");
      sameTurn(objects[3].quaternion.toArray(), turn(0, 1.4, 0), "the closed finger keeps HandsClosed");
      sameTurn(objects[7].quaternion.toArray(), standTurn(7), "the spine is not the arm's: Sheath's key there is unused");
      sameTurn(objects[5].quaternion.toArray(), standTurn(5), "the left arm plays Stand");
    }
    if (frame === 2) {
      // In the blend window (40 ms of 100): from this step's Stand, not from last step's blend.
      const expected = new THREE.Quaternion(...standTurn(1)).normalize()
        .slerp(new THREE.Quaternion(...SHOULDER_A).slerp(new THREE.Quaternion(...SHOULDER_B), 0.04), 0.4);
      sameTurn(objects[1].quaternion.toArray(), expected.toArray(), "entering over the blend window");
    }
    if (frame >= 50) {
      sameTurn(objects[1].quaternion.toArray(), standTurn(1), `frame ${frame}: the shoulder back on Stand`);
      sameTurn(objects[2].quaternion.toArray(), standTurn(2), `frame ${frame}: the hand back on Stand`);
    }
  }
});

test("the renderer: only the active player's toggle plays; every other unit hangs by the field at once", () => {
  const source = readFileSync(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const draw = source.slice(source.indexOf("  #drawUnit("), source.indexOf("  #updateAttachments("));
  assert.match(draw, /if \(self\) this\.#ownSheath\(unit, metadata, object, now\);/);
  assert.ok(draw.indexOf("#ownSheath(") < draw.indexOf("#updateAttachments("), "the ceremony settles before the pieces hang");
  assert.equal((source.match(/unit\.sheathCeremony = /g) ?? []).length, 2, "set only in #ownSheath");
  const hang = source.slice(source.indexOf("  #updateAttachments("), source.indexOf("  #glowBody("));
  assert.match(hang, /worldAttachmentPoint\(item, ceremony \? ceremonySheath\(ceremony, item\.slot, now\) : sheath,/);
  const step = source.slice(source.indexOf("  #animateUnit("), source.indexOf("  #flatPose("));
  assert.match(step, /const sheathArms = this\.#sheathArmsStep\(unit, template, skinned, now\);/);
  assert.match(step, /!portraitNeedsPose && sheathArms === undefined && this\.#strafeYawIdle/);
  assert.ok(step.indexOf("#sheathArmsStep(") < step.indexOf("skinned.mixer.update(poseElapsed)"));
  assert.ok(step.indexOf("poseSheathArm(") > step.indexOf("applyGlobalSequenceBones(skinned, channels"));
  assert.match(step, /if \(self && sidecarClaims\(template, SHEATH_ANIMATIONS\)\)/);
  const actions = readFileSync(new URL("../src/browser/input/Actions.ts", import.meta.url), "utf8");
  const toggle = actions.slice(actions.indexOf("function toggleSheath("), actions.indexOf("function castShapeshiftForm("));
  assert.ok(toggle.indexOf("ownSheathRefused(now)") < toggle.indexOf("world.setSheathed(next)"), "the guards before the packet");
  assert.ok(toggle.indexOf("requestOwnSheath(next, now)") > toggle.indexOf("world.setSheathed(next)"));
});

test("SHEATH_EVENTS is what the clean client's playable rigs key in sequences 89 and 90", withClient, async () => {
  const rd = (b, o) => b.readUInt32LE(o);
  const races = ["Human", "Orc", "Dwarf", "NightElf", "Scourge", "Tauren", "Gnome", "Troll", "BloodElf", "Draenei"];
  let checked = 0;
  for (const race of races) {
    for (const sex of ["Male", "Female"]) {
      const base = `Character\\${race}\\${sex}\\${race}${sex}`;
      const m2 = await archives.read(`${base}.m2`);
      if (!m2 || m2.toString("latin1", 0, 4) !== "MD20") continue;
      const sequences = [];
      for (let index = 0; index < rd(m2, 0x1c); index++) {
        const at = rd(m2, 0x20) + index * 64;
        sequences.push({ index, id: m2.readUInt16LE(at), variation: m2.readUInt16LE(at + 2), duration: rd(m2, at + 4), flags: rd(m2, at + 12) });
      }
      const row = SHEATH_EVENTS[`${race}${sex}`.toLowerCase()];
      assert.ok(row, `${base}: in the table`);
      for (let event = 0; event < rd(m2, 0x100); event++) {
        const at = rd(m2, 0x104) + event * 36;
        const tag = m2.toString("latin1", at, at + 4);
        if (tag !== "$SHR" && tag !== "$SHL") continue;
        for (const sequence of sequences.filter((entry) => (entry.id === 89 || entry.id === 90) && entry.variation === 0)) {
          if (sequence.index >= rd(m2, at + 28)) continue;
          const keys = rd(m2, rd(m2, at + 32) + sequence.index * 8), offset = rd(m2, rd(m2, at + 32) + sequence.index * 8 + 4);
          if (keys === 0) continue;
          const source = (sequence.flags & 0x20) !== 0 ? m2
            : await archives.read(`${base}${String(sequence.id).padStart(4, "0")}-00.anim`);
          if (!source) continue;
          const fraction = source.readUInt32LE(offset) / sequence.duration;
          const column = (sequence.id === 90 ? 2 : 0) + (tag === "$SHL" ? 1 : 0);
          assert.ok(Math.abs(row[column] - fraction) < 0.001, `${base} ${tag} ${sequence.id}: ${row[column]} vs ${fraction.toFixed(3)}`);
          checked++;
        }
      }
    }
  }
  assert.ok(checked >= 40, `checked ${checked} keys`);
});

test("on the client's rigs the arm alone, over Stand, brings the grip to the sheath point at `$SHR`", withClient, async () => {
  // Key bone 3's subtree playing HipSheath (to point 32) or Sheath (to 26) over the rest of the body on Stand —
  // the renderer's own path (SheathArms.ts) — reaches its nearest to the sheath point at the event the table names.
  let rigs = 0;
  for (const base of ["Character\\Human\\Male\\HumanMale", "Character\\NightElf\\Female\\NightElfFemale",
    "Character\\NightElf\\Male\\NightElfMale", "Character\\Orc\\Male\\OrcMale"]) {
    const [m2, skin] = await Promise.all([archives.read(`${base}.m2`), archives.read(`${base}00.skin`)]);
    if (!m2 || !skin) continue;
    rigs++;
    const skeleton = parseM2Skeleton(m2, { wanted: new Set([0, SHEATH_ANIMATION, HIP_SHEATH_ANIMATION]) });
    const encoded = encodeWvm9(parseM2(m2, skin), skeleton, m2Animations(m2).map((animation) => animation.animationId),
      undefined, { extensions: true });
    const decoded = decodeWvm9(encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength));
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(9), 3));
    geometry.setAttribute("skinIndex", new THREE.BufferAttribute(new Uint16Array(12), 4));
    geometry.setAttribute("skinWeight", new THREE.BufferAttribute(Float32Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]), 4));
    geometry.setIndex([0, 1, 2]);
    geometry.addGroup(0, 3, 0);
    const tpl = buildSkinnedTemplateFrom(geometry, decoded.skeleton, 2);
    const instance = instantiateSkinned(tpl, new THREE.MeshBasicMaterial());
    instance.mixer.clipAction(tpl.clips.get(0)).play();
    const point = (id) => decoded.attachments.find((attachment) => attachment.id === id);
    const where = (attachment) => {
      const bone = instance.skeleton.bones[attachment.bone];
      bone.updateWorldMatrix(true, false);
      const pivot = [0, 1, 2].map((axis) => tpl.pivots[attachment.bone * 3 + axis]);
      return new THREE.Vector3(...attachment.position.map((value, axis) => value - pivot[axis])).applyMatrix4(bone.matrixWorld);
    };
    const bones = keyBoneSubtree(tpl.parents, decoded.keyBones, KEY_BONE_SHOULDER_RIGHT);
    for (const [animation, sheathPoint] of [[HIP_SHEATH_ANIMATION, 32], [SHEATH_ANIMATION, 26]]) {
      const clip = tpl.clips.get(animation);
      assert.ok(clip && point(1) && point(sheathPoint), `${base}: ${animation}, the grip and point ${sheathPoint}`);
      const reach = (fraction) => {
        resetArmBones(instance, tpl, bones);
        instance.mixer.setTime(0.5);
        poseSheathArm(instance, tpl, clip, bones, clip.duration * fraction, 1);
        return where(point(1)).distanceTo(where(point(sheathPoint)));
      };
      const samples = Array.from({ length: 41 }, (_, step) => reach(step / 40));
      const nearest = Math.min(...samples);
      const atEvent = reach(sheathEventFraction(`${base}.m2`, animation, KEY_BONE_SHOULDER_RIGHT));
      assert.ok(atEvent <= nearest + 0.08, `${base} ${animation}: ${atEvent.toFixed(3)} at $SHR, nearest ${nearest.toFixed(3)}`);
      assert.ok(atEvent < samples[0] * 0.7, `${base} ${animation}: ${atEvent.toFixed(3)} at $SHR against ${samples[0].toFixed(3)} at rest`);
    }
  }
  assert.equal(rigs, 4, "every rig read");
});
