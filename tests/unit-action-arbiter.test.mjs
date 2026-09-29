// Who owns a unit's action pose (UnitActionArbiter.ts) and how the renderer shows it.
//
// Three levels: the pure queue and display rules; the real HumanMale rig, for the claim that the
// underlay cut makes an upper-body cast exact; and the renderer's own executor methods, extracted
// from WorldRenderer3D.ts source the way unit-model-streaming.test.mjs does, driven over a small
// three.js rig so the hand-overs between layers are asserted on real mixer weights and phases.
//
// `UNIT_ACTION_ARBITER_MODULE` points the suite at another build of the module, and
// `UNIT_ACTION_RENDERER_SOURCE` at another copy of the renderer source (mutation checks on scratch
// copies; the real files are never edited for that).

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as THREE from "three";
import { m2Animations, parseM2Skeleton } from "../tools/m2.mjs";
import {
  ACTION_ANIMATION_BLEND, LOOP_ANIMATION_BLEND, animationBlend, animationFadeWindow, animationTransition,
  clipBlendTime, commitLocomotion, locomotionBoneMask, locomotionOverlayClip, pendingActionExpired,
} from "../dist/code/browser/AnimatedModel.js";
import { ANIMATION_DATA_AVAILABLE, ANIMATION_IDS } from "../dist/code/generated/animations.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { appearsDead, isWorldObjectDead } from "../dist/code/world/WorldState.js";

const arbiter = await import(process.env.UNIT_ACTION_ARBITER_MODULE
  ?? new URL("../dist/code/browser/UnitActionArbiter.js", import.meta.url).href);
const {
  UNIT_ACTION_PRIORITY, UnitActionQueue, animationPlaysOnUpperBody, heldClipPlaysOnce,
  locomotionUnderlayClip, unitActionDisplay, unitActionEndsOnMovement,
} = arbiter;

const withAnimationData = { skip: ANIMATION_DATA_AVAILABLE ? false : "no locally generated animation data" };

const request = (layer, held, until, extra = {}) => ({ layer, held, until, payload: {}, ...extra });

/* --- The queue --------------------------------------------------------------------------------- */

test("layers are ordered state > cast > melee > reaction > emote", () => {
  const order = Object.entries(UNIT_ACTION_PRIORITY).sort((a, b) => b[1] - a[1]).map(([layer]) => layer);
  assert.deepEqual(order, ["state", "cast", "melee", "reaction", "emote"]);
});

test("a weaker one-shot never interrupts a stronger live pose, and a stronger one takes over", () => {
  const queue = new UnitActionQueue();
  const precast = queue.submit(request("cast", true, 3_000), 0);
  // A CombatWound impact landing on a caster used to replace the precast for good.
  assert.equal(queue.submit(request("reaction", false, 3_000), 10), undefined);
  assert.equal(queue.submit(request("melee", false, 3_000), 10), undefined);
  assert.equal(queue.top(), precast);
  const stun = queue.submit(request("state", true, Number.POSITIVE_INFINITY), 20);
  assert.equal(queue.top(), stun, "an aura state outranks the cast");
  // A weaker hold is kept underneath rather than refused.
  const stance = queue.submit(request("emote", true, 9_000), 30);
  assert.ok(stance);
  assert.equal(queue.top(), stun);
});

test("when a pose ends the strongest surviving hold comes back", () => {
  const queue = new UnitActionQueue();
  const precast = queue.submit(request("cast", true, 3_000), 0);
  const stun = queue.submit(request("state", true, Number.POSITIVE_INFINITY, { owner: "aura" }), 10);
  assert.equal(queue.top(), stun);
  assert.deepEqual(queue.removeWhere((entry) => entry.owner === "aura"), [stun]);
  assert.equal(queue.top(), precast, "the stance the stun covered is shown again");
  const dance = queue.submit(request("emote", true, 9_000), 20);
  const wound = new UnitActionQueue();
  wound.submit(request("emote", true, 9_000), 0);
  const flinch = wound.submit(request("reaction", false, 500), 10);
  assert.equal(wound.top(), flinch);
  wound.expire(500);
  assert.equal(wound.top().layer, "emote", "the dance resumes when the flinch hands back");
  assert.ok(dance);
});

test("a newer request retires the one-shots of its own layer and keeps the holds", () => {
  const queue = new UnitActionQueue();
  const release = queue.submit(request("cast", false, 1_000), 0);
  const channel = queue.submit(request("cast", true, 5_000), 10);
  assert.equal(queue.entries.includes(release), false, "a channel hold replaces the release before it");
  assert.equal(queue.top(), channel);
  const swing = queue.submit(request("melee", true, 800), 20);
  queue.submit(request("melee", false, 800), 30);
  assert.equal(queue.entries.includes(swing), true, "a held melee pose stays under a newer swing");
  assert.equal(queue.submit(request("cast", true, 5), 10), undefined, "a request whose moment passed is refused");
});

test("expiry drops what has run out and an idle queue can be forgotten", () => {
  const queue = new UnitActionQueue();
  queue.submit(request("reaction", false, 100), 0);
  assert.equal(queue.idle, false);
  queue.shown = { entry: queue.top() };
  queue.expire(100);
  assert.equal(queue.size, 0);
  assert.equal(queue.idle, false, "something still on show keeps the queue");
  queue.shown = undefined;
  assert.equal(queue.idle, true);
});

/* --- Where a pose is drawn --------------------------------------------------------------------- */

test("a pose goes to the upper layer over a non-idle base by its body flags, not by an action kind", withAnimationData, () => {
  // The old rule promoted a running one-shot only when it had an action kind (a swing, a shot);
  // spell and emote poses had none, so a unit that started moving slid with its legs locked.
  for (const [name, layer] of [["SpellCastOmni", "cast"], ["SpellCastDirected", "cast"], ["ReadySpellOmni", "cast"],
    ["Attack1H", "melee"], ["CombatWound", "reaction"], ["EmoteTalk", "emote"], ["EmoteWave", "emote"]]) {
    const animation = ANIMATION_IDS[name];
    assert.equal(animationPlaysOnUpperBody(animation), true, `${name} carries Bodyflags 0x8`);
    assert.equal(unitActionDisplay(layer, true, false), "upper", `${name} plays over a moving base`);
    assert.equal(unitActionDisplay(layer, true, true), "full", `${name} owns a standing unit`);
  }
  for (const name of ["EmoteRoar", "EmoteDance", "Special1H", "ChannelCastOmni", "ChannelCastDirected", "Whirlwind"]) {
    assert.equal(animationPlaysOnUpperBody(ANIMATION_IDS[name]), false, `${name} is a whole-body pose`);
  }
  assert.equal(unitActionDisplay("emote", false, false), "yield", "a roar is not drawn over running legs");
  assert.equal(unitActionDisplay("cast", false, false), "yield", "a channel pose waits for the unit to stop");
  assert.equal(unitActionDisplay("state", false, false), "full", "Bladestorm's Whirlwind spins while it moves");
  assert.equal(unitActionEndsOnMovement("emote", true), true, "walking away ends /dance");
  assert.equal(unitActionEndsOnMovement("cast", true), false, "a cast is ended by the server's interrupt");
  assert.equal(unitActionEndsOnMovement("state", true), false);
  assert.equal(heldClipPlaysOnce(ANIMATION_IDS.Death), true, "a held Death falls once and stays down");
  assert.equal(heldClipPlaysOnce(ANIMATION_IDS.SpellCastOmni), false);
});

test("the underlay cut gives each property of a pair one owner and is cached per pair", () => {
  const keyed = (name) => new THREE.QuaternionKeyframeTrack(`${name}.quaternion`, [0, 1], [0, 0, 0, 1, 0, 0, 0, 1]);
  const gait = new THREE.AnimationClip("run", 1, [keyed("bone1"), keyed("bone2"), keyed("bone3")]);
  gait.userData = { movingSpeed: 7, blendTime: 0.15 };
  const overlay = new THREE.AnimationClip("cast-overlay", 1, [keyed("bone2")]);
  const under = locomotionUnderlayClip(gait, overlay);
  assert.deepEqual(under.tracks.map((track) => track.name), ["bone1.quaternion", "bone3.quaternion"]);
  assert.deepEqual(under.userData, gait.userData, "the stride's speed and blend travel with the cut");
  assert.equal(locomotionUnderlayClip(gait, overlay), under, "one cut per pair");
  const unrelated = new THREE.AnimationClip("other", 1, [keyed("bone9")]);
  assert.equal(locomotionUnderlayClip(gait, unrelated), gait, "a pose that keys nothing the gait keys cuts nothing");
});

test("a feigned death lies down for the pose and stays alive for everything else", () => {
  const unit = (typeId, health, dynamicFlags) => ({
    typeId,
    fields: new Map([
      ...(health === undefined ? [] : [[UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, health]]),
      [UPDATE_FIELDS.UNIT_DYNAMIC_FLAGS.offset, dynamicFlags],
    ]),
  });
  // TrinityCore's HandleFeignDeath keeps the health and raises UNIT_DYNFLAG_DEAD (0x20).
  const feigning = unit(3, 4_200, 0x20);
  assert.equal(isWorldObjectDead(feigning), false, "targeting, loot and frames still see a live unit");
  assert.equal(appearsDead(feigning), true, "the body is drawn lying down");
  assert.equal(appearsDead(unit(4, 9_000, 0x20)), true, "a hunter's Feign Death too");
  assert.equal(appearsDead(unit(3, 0, 0)), true, "a real corpse is still dead");
  assert.equal(appearsDead(unit(3, 4_200, 0x01)), false, "other bits do not lay a unit down");
  assert.equal(appearsDead(unit(5, 1, 0x20)), false, "only units have a dead pose");
});

/* --- The real rig ------------------------------------------------------------------------------- */

let archives;
try {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const { clientDirectory } = await import("../tools/paths.mjs");
  archives = await clientArchives(clientDirectory());
} catch {
  archives = undefined;
}
const withClient = { skip: archives && ANIMATION_DATA_AVAILABLE ? false : "no 3.3.5a client or animation data" };
test.after(() => archives?.close());

function threeClip(source, skeleton, animationId) {
  const tracks = [];
  for (const channel of source.channels) {
    const name = `bone${channel.bone}`;
    const times = Float32Array.from(channel.times, (time) => time / 1000);
    if (channel.kind === 1) {
      const values = new Float32Array(channel.values.length);
      for (let index = 0; index < channel.values.length; index++) {
        const raw = channel.values[index];
        values[index] = (raw < 0 ? raw + 32768 : raw - 32767) / 32767;
      }
      tracks.push(new THREE.QuaternionKeyframeTrack(`${name}.quaternion`, times, values));
      continue;
    }
    if (channel.kind === 2) {
      tracks.push(new THREE.VectorKeyframeTrack(`${name}.scale`, times, channel.values));
      continue;
    }
    const parent = skeleton.parents[channel.bone];
    const rest = [0, 1, 2].map((axis) =>
      skeleton.pivots[channel.bone * 3 + axis] - (parent >= 0 ? skeleton.pivots[parent * 3 + axis] : 0));
    const values = new Float32Array(channel.values.length);
    for (let key = 0; key < times.length; key++) {
      for (let axis = 0; axis < 3; axis++) values[key * 3 + axis] = rest[axis] + channel.values[key * 3 + axis];
    }
    tracks.push(new THREE.VectorKeyframeTrack(`${name}.position`, times, values));
  }
  return new THREE.AnimationClip(`test-${animationId}`, source.duration / 1000, tracks);
}

function threeRig(parents, pivots) {
  const root = new THREE.Group();
  const bones = [];
  for (let index = 0; index < parents.length; index++) {
    const bone = new THREE.Bone();
    bone.name = `bone${index}`;
    const parent = parents[index];
    if (parent >= 0) {
      bone.position.set(pivots[index * 3] - pivots[parent * 3], pivots[index * 3 + 1] - pivots[parent * 3 + 1],
        pivots[index * 3 + 2] - pivots[parent * 3 + 2]);
      bones[parent].add(bone);
    } else {
      bone.position.set(pivots[index * 3], pivots[index * 3 + 1], pivots[index * 3 + 2]);
      root.add(bone);
    }
    bones.push(bone);
  }
  return { root, bones, mixer: new THREE.AnimationMixer(root) };
}

test("on HumanMale the underlay makes a moving cast exact on the upper body while the legs still run", withClient, async () => {
  const base = "Character/Human/Male/HumanMale";
  const m2 = await archives.read(`${base}.m2`);
  assert.ok(m2, "HumanMale should be in the client");
  const files = new Map();
  for (const animation of m2Animations(m2)) {
    if (animation.external && !files.has(animation.external)) {
      files.set(animation.external, await archives.read(`${base}${animation.external}.anim`));
    }
  }
  const source = parseM2Skeleton(m2, {
    wanted: new Set([ANIMATION_IDS.Run, ANIMATION_IDS.SpellCastOmni]), animations: files,
  });
  const parents = Int16Array.from(source.bones.map((bone) => bone.parent));
  const pivots = Float32Array.from(source.bones.flatMap((bone) => bone.pivot));
  const mask = locomotionBoneMask(parents, pivots);
  const clip = (id) => threeClip(source.clips.find((one) => one.animationId === id), { parents, pivots }, id);
  const run = clip(ANIMATION_IDS.Run);
  const cast = clip(ANIMATION_IDS.SpellCastOmni);
  const overlay = locomotionOverlayClip(cast, mask);
  const underlay = locomotionUnderlayClip(run, overlay);
  const pose = (layers) => {
    const rig = threeRig(parents, pivots);
    for (const [layerClip, loop] of layers) {
      rig.mixer.clipAction(layerClip).setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity).play();
    }
    rig.mixer.update(0.45);
    rig.root.updateWorldMatrix(true, true);
    return rig;
  };
  const alone = pose([[cast, false]]);
  const gait = pose([[run, true]]);
  const layered = pose([[underlay, true], [overlay, false]]);
  const averaged = pose([[run, true], [overlay, false]]);
  // Every rotation the cast keys is the cast's. (A bone the cast only translates keeps the gait's
  // rotation, as it keeps its own when the cast plays alone — ownership is per property.)
  const upper = overlay.tracks.filter((track) => track.name.endsWith(".quaternion"))
    .map((track) => Number(/^bone(\d+)\./.exec(track.name)[1]));
  // M2 rotation keys decode a hair off unit length, and `angleTo` of two identical non-unit
  // quaternions is not zero (0.025 rad on HumanMale bone49), so both sides are normalised first.
  const angle = (left, right) => left.clone().normalize().angleTo(right.clone().normalize());
  let worst = 0;
  let ratio = 0;
  let compared = 0;
  for (const bone of upper) {
    worst = Math.max(worst, angle(layered.bones[bone].quaternion, alone.bones[bone].quaternion));
    const spread = angle(gait.bones[bone].quaternion, alone.bones[bone].quaternion);
    if (spread < 0.05) continue;
    ratio += angle(averaged.bones[bone].quaternion, alone.bones[bone].quaternion) / spread;
    compared++;
  }
  assert.ok(worst < 1e-6, `the cast owns the upper body exactly (worst ${worst} rad)`);
  // What two weight-1 layers did before the cut: an even average (measured 0.50 over 114 bones).
  assert.ok(compared > 50 && Math.abs(ratio / compared - 0.5) < 0.05,
    `the old layering averaged run and cast (${(ratio / compared).toFixed(3)} over ${compared} bones)`);
  for (const bone of [...mask].flatMap((value, index) => value ? [index] : [])) {
    assert.deepEqual(layered.bones[bone].getWorldPosition(new THREE.Vector3()).toArray(),
      gait.bones[bone].getWorldPosition(new THREE.Vector3()).toArray(), `bone${bone} still runs`);
  }
});

/* --- The renderer's executor ------------------------------------------------------------------- */

const source = readFileSync(process.env.UNIT_ACTION_RENDERER_SOURCE
  ?? new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
function methods(names, dependencies) {
  const parsed = ts.createSourceFile("renderer.ts", source, ts.ScriptTarget.ES2022, true);
  const renderer = parsed.statements.find((node) => ts.isClassDeclaration(node) && node.name?.text === "WorldRenderer3D");
  const members = names.map((name) => {
    const member = renderer.members.find((candidate) => candidate.name?.getText(parsed) === name);
    assert.ok(member, name);
    return member.getText(parsed).replaceAll("#", "");
  });
  const body = ts.transpileModule(`class Harness { ${members.join("\n")} }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const deps = { THREE, ...dependencies };
  return Function(...Object.keys(deps), `${body}; return Harness;`)(...Object.values(deps));
}

// A three-bone rig: 0 the root and 1 a leg (the lower body), 2 an arm (the upper body). The gait
// swings both; the cast raises the arm and plants the leg.
const RUN = 5;
const CAST = 54;
const PRECAST = 52;
const CHANNEL = 124;
const DEATH = ANIMATION_IDS.Death;
const lowerBody = Uint8Array.from([1, 1, 0]);
const turn = (angle) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), angle).toArray();
const swing = (bone, from, to, duration = 1) => new THREE.QuaternionKeyframeTrack(`bone${bone}.quaternion`,
  [0, duration], [...turn(from), ...turn(to)]);

function executor({ moving = false, overrides = {}, legless = false } = {}) {
  const state = { moving };
  const Harness = methods([
    "#settleUnitAction", "#advanceLeadIn", "#entryAnimation", "#startUnitAction", "#shownAs",
    "#releaseUnitAction", "#poseBase", "#commitGait", "#playAnimation", "#clearOverlay",
  ], {
    UnitActionQueue, unitActionDisplay, unitActionEndsOnMovement, heldClipPlaysOnce, locomotionUnderlayClip,
    animationPlaysOnUpperBody: (animation) => animation === CAST || animation === PRECAST,
    ANIMATION_IDS: { Stand: 0 }, poseAnimation: () => ({ wanted: [state.moving ? RUN : 0] }),
    isTerminalUnitPose: (pose) => pose.dead === true, isUnitMoving: () => state.moving,
    pendingActionExpired: () => false, pendingActionFate: () => "drop",
    weaponPose: () => "unarmed", actionAnimation: () => [],
    resolveSpellVisualAnimation: (clips, wanted) => wanted.find((id) => clips.has(id)),
    resolveActionAnimation: () => undefined, spellVisualAnimationCandidates: (wanted) => wanted,
    chooseAnimation: () => ({ animation: state.moving ? RUN : 0, loop: true }),
    poseAnimationFamily: () => "any", commitLocomotion,
    animationBlend, animationTransition, clipBlendTime, animationFadeWindow,
    ACTION_ANIMATION_BLEND, ANIMATION_BLEND: LOOP_ANIMATION_BLEND, ACTION_CLIP_WAIT: 900, ACTION_SIDECAR_WAIT: 3_000,
    ...overrides,
  });
  const h = new Harness();
  h.requestAnimations = () => false;
  h.applyUnitGait = () => {};
  const root = new THREE.Group();
  const bones = [0, 1, 2].map((index) => {
    const bone = new THREE.Bone();
    bone.name = `bone${index}`;
    return bone;
  });
  root.add(bones[0]);
  bones[0].add(bones[1]);
  bones[0].add(bones[2]);
  const clips = new Map([
    [0, new THREE.AnimationClip("stand", 2, [swing(1, 0, 0, 2), swing(2, 0, 0, 2)])],
    [RUN, new THREE.AnimationClip("run", 1, [swing(1, -0.6, 0.6), swing(2, 0.4, -0.4)])],
    [CAST, new THREE.AnimationClip("cast", 1, [swing(1, 0.1, 0.1), swing(2, 1.2, 1.6)])],
    [PRECAST, new THREE.AnimationClip("precast", 0.5, [swing(1, 0.1, 0.1, 0.5), swing(2, 1.0, 1.1, 0.5)])],
    [CHANNEL, new THREE.AnimationClip("channel", 0.5, [swing(1, 0.1, 0.1, 0.5), swing(2, 0.9, 0.95, 0.5)])],
    [DEATH, new THREE.AnimationClip("death", 1, [swing(1, 0, 1.5), swing(2, 0, 1.5)])],
  ]);
  // A rig with no leg branches keeps every clip whole as its own "overlay" (`locomotionOverlayClip`
  // with an empty mask returns the clip itself).
  const overlayClips = new Map([...clips].map(([id, clip]) =>
    [id, legless ? clip : locomotionOverlayClip(clip, lowerBody)]));
  const unit = {
    skinned: { mixer: new THREE.AnimationMixer(root) },
    template: { clips, overlayClips, animations: new Set(clips.keys()), parents: [-1, 0, 0] },
    action: undefined, animationId: -1, overlayUntil: 0,
  };
  const queue = new UnitActionQueue();
  const payload = (animation) => ({
    wanted: [animation], action: undefined, stage: "main", sequenceAt: 0,
    waitUntil: 900, sidecarWaitUntil: 3_000, source: "visual",
  });
  const submit = (layer, animation, held, until, now) =>
    queue.submit({ layer, held, until, payload: payload(animation) }, now);
  const frame = (now, pose = {}) => {
    const display = h.settleUnitAction(unit, queue, pose, now, undefined, undefined);
    if (display === "upper") h.poseBase(unit, pose, now, undefined, undefined, unit.overlayAction?.getClip());
    else if (display === undefined) {
      if (unit.overlayPreservesLocomotion === true) h.clearOverlay(unit);
      h.poseBase(unit, pose, now, undefined, undefined);
    }
    return display;
  };
  return { h, unit, bones, queue, submit, frame, clips, state };
}

test("executor: a moving cast plays on the upper body at its own phase, exactly, over a running gait", () => {
  const { unit, bones, submit, frame, clips, state } = executor();
  submit("cast", CAST, false, 3_000, 0);
  assert.equal(frame(0), "full", "a standing caster casts with the whole body");
  assert.equal(unit.animationId, CAST);
  unit.skinned.mixer.update(0.3);
  const phase = unit.action.time;

  // The unit starts moving mid-cast: the old path left it sliding in the full-body clip.
  state.moving = true;
  assert.equal(frame(300), "upper");
  assert.ok(Math.abs(unit.overlayAction.time - phase) < 1e-9, "the cast continues at its own phase");
  assert.equal(unit.animationId, RUN, "the legs are given to the gait");
  assert.notEqual(unit.action.getClip(), clips.get(RUN), "the gait plays its lower-body cut");
  assert.equal(unit.action.getClip().tracks.some((track) => track.name.startsWith("bone2.")), false);
  unit.skinned.mixer.update(0.2);
  const referenceRoot = new THREE.Group();
  const arm = new THREE.Bone();
  arm.name = "bone2";
  referenceRoot.add(arm);
  const reference = new THREE.AnimationMixer(referenceRoot);
  reference.clipAction(clips.get(CAST)).play();
  reference.update(phase + 0.2);
  assert.ok(bones[2].quaternion.angleTo(arm.quaternion) < 1e-6,
    "past the hand-over window the arm is the cast's, not an average with the run");
});

test("executor: a whole-body one-shot gives way when the unit moves, and the gait cross-fades in", () => {
  const moving = executor({ moving: true });
  moving.submit("emote", CHANNEL, false, 3_000, 0);
  assert.equal(moving.frame(0), undefined, "a pose that cannot be drawn over running legs is not drawn");
  assert.equal(moving.queue.size, 0, "and a one-shot that gave way is over");
  assert.equal(moving.unit.animationId, RUN);
  const held = executor({ moving: true });
  held.submit("cast", CHANNEL, true, 3_000, 0);
  assert.equal(held.frame(0), undefined);
  assert.equal(held.queue.size, 1, "a held channel waits under the gait for the unit to stop");
  held.state.moving = false;
  assert.equal(held.frame(100), "full", "and comes back when it does");
  const aura = executor({ moving: true });
  aura.submit("state", CHANNEL, true, Number.POSITIVE_INFINITY, 0);
  assert.equal(aura.frame(0), "full", "an aura state keeps the whole body while moving");
  const stance = executor({ moving: true });
  stance.submit("emote", PRECAST, true, 9_000, 0);
  assert.equal(stance.frame(0), undefined);
  assert.equal(stance.queue.size, 0, "walking away ends an emote stance outright");
  // A rig with no upper-body cut cannot layer: its whole clip would slide the legs, so it gives way.
  const legless = executor({ moving: true, legless: true });
  legless.submit("cast", CAST, false, 3_000, 0);
  assert.equal(legless.frame(0), undefined);
  assert.equal(legless.queue.size, 0);
  assert.equal(legless.unit.overlayAction, undefined);
});

test("executor: a release takes over from the precast by cross-fade, and a cancelled pose is faded, never stopped", () => {
  const { unit, queue, submit, frame } = executor();
  const precast = submit("cast", PRECAST, true, 2_400, 0);
  assert.equal(frame(0), "full");
  const precastAction = unit.action;
  unit.skinned.mixer.update(0.3);
  // SPELL_GO: the lifecycle cancels the precast's handle and dispatches the release.
  queue.remove(precast);
  submit("cast", CAST, false, 3_000, 300);
  assert.equal(frame(300), "full");
  assert.equal(unit.animationId, CAST);
  unit.skinned.mixer.update(0.05);
  // `isScheduled` and not the weight alone: a stopped action keeps its last effective weight.
  assert.ok(precastAction.isScheduled()
    && precastAction.getEffectiveWeight() > 0 && precastAction.getEffectiveWeight() < 1,
  "the precast fades out beside the release instead of being cut on the tick");
  // Cancelling the release mid-way hands the unit back the same way.
  const releaseAction = unit.action;
  queue.clear();
  assert.equal(frame(400), undefined);
  unit.skinned.mixer.update(0.05);
  assert.ok(releaseAction.isScheduled() && releaseAction.getEffectiveWeight() > 0,
    "a released pose is the cross-fade source, not stopped");
  assert.equal(unit.animationId, 0, "the unit's own pose takes over");
});

test("executor: a channel hold after its release keeps the running clip, and a held Death falls once", () => {
  const { unit, queue, submit, frame } = executor();
  submit("cast", CHANNEL, false, 3_000, 0);
  assert.equal(frame(0), "full");
  const release = unit.action;
  unit.skinned.mixer.update(0.2);
  submit("cast", CHANNEL, true, 5_000, 200);
  assert.equal(frame(200), "full");
  assert.equal(unit.action, release, "the same clip is not restarted for the hold");
  assert.ok(release.time > 0.1, "it continues from where the release had got to");
  assert.equal(release.loop, THREE.LoopRepeat, "and now loops for the channel");

  const corpse = executor();
  corpse.submit("state", DEATH, true, Number.POSITIVE_INFINITY, 0);
  assert.equal(corpse.frame(0), "full");
  const death = corpse.unit.action;
  assert.equal(death.loop, THREE.LoopOnce);
  assert.equal(death.clampWhenFinished, true);
  corpse.unit.skinned.mixer.update(1.5);
  for (let now = 1_500; now < 4_000; now += 500) {
    assert.equal(corpse.frame(now), "full");
    corpse.unit.skinned.mixer.update(0.5);
  }
  assert.equal(corpse.unit.action, death);
  assert.ok(death.time >= 0.99, "it stays on its last frame instead of falling again");
  assert.equal(queue.size, 1, "the channel hold is still live");
});

test("executor: a one-shot hands back one blend before its clip ends, and the weaker hold returns", () => {
  const { unit, queue, submit, frame } = executor();
  submit("emote", PRECAST, true, 9_000, 0);
  submit("reaction", CAST, false, 3_000, 0);
  assert.equal(frame(0), "full");
  assert.equal(unit.animationId, CAST, "the flinch outranks the stance");
  // The same arithmetic as the renderer: the clip's length less the action blend.
  const handBack = (1 - ACTION_ANIMATION_BLEND) * 1_000;
  assert.equal(queue.top().until, handBack);
  assert.equal(frame(handBack - 1), "full");
  assert.equal(frame(handBack), "full");
  assert.equal(unit.animationId, PRECAST, "the stance underneath comes back when the flinch hands back");
});

test("executor: the start deadlines do not cut short a shot that started late", () => {
  const { unit, queue, frame } = executor({
    overrides: { pendingActionExpired, resolveActionAnimation: () => CAST },
  });
  queue.submit({
    layer: "melee", held: false, until: 3_000,
    payload: {
      wanted: [], action: "shoot", stage: "main", sequenceAt: 0,
      waitUntil: 1_500, sidecarWaitUntil: 3_000, source: "external",
    },
  }, 0);
  assert.equal(frame(1_200), "full", "the shot starts inside its metadata window");
  assert.equal(frame(1_600), "full", "and runs past that window to its own hand-back");
  assert.equal(unit.animationId, CAST);
  assert.equal(frame(1_200 + (1 - ACTION_ANIMATION_BLEND) * 1_000), undefined, "then hands back");
});
