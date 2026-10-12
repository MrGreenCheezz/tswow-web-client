// 12.10 6.24 — «модели персонажей не держат оружие, рука расслабленная». Wow.exe closes a hand round
// what hangs on attachment 1 or 2: 0x004eaa70 → 0x004e7700 → `CM2Model::SetBoneSequence(key bones
// 8–12 / 13–17, HandsClosed)` (0x00832ab0); taking it off (0x004e79a0) or moving it to a sheath point
// (0x007310a0 → 0x004e7750) hands the fingers back to the model's own sequence. See src/browser/HandsClosed.ts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as THREE from "three";
import {
  applyGlobalSequenceBones, buildSkinnedTemplateFrom, fastPoseProgramFor, instantiateSkinned, skinDemandFor,
  writeGlobalSequenceLocals,
} from "../dist/code/browser/AnimatedModel.js";
import { PoseEngine, SharedPose } from "../dist/code/browser/PoseEngine.js";
import {
  HAND_LEFT, HAND_RIGHT, HANDS_CLOSED_ANIMATION, closedHandBones, closedHandsFor, handOfPoint, handsClosedMask,
  releaseClosedHands,
} from "../dist/code/browser/HandsClosed.js";
import { worldAttachmentPoint } from "../dist/code/browser/SheathPoints.js";
import { SHEATH_MELEE, SHEATH_RANGED, SHEATH_UNARMED } from "../dist/code/browser/Attachment.js";
import { decodeWvm9 } from "../dist/code/browser/Wvm.js";
import { ANIMATION_IDS } from "../dist/code/generated/animations.js";
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

// A hand in miniature: the right one with an index finger of two joints, a thumb and the bone the
// hand attachment hangs from (not a finger — NightElfMale's is not even under the hand); the left
// with one finger.
//   0 root · 1 arm R · 2 hand R · 3 index R (key 8, 9) · 4 index R tip · 5 thumb R (key 12) ·
//   6 grip R (attachment 1) · 7 arm L · 8 hand L · 9 index L (key 13)
const parents = Int16Array.from([-1, 0, 1, 2, 3, 2, 2, 0, 7, 8]);
const pivots = Float32Array.from([
  0, 0, 0, 0, -0.3, 1.4, 0, -0.5, 1, 0.05, -0.55, 0.9, 0.07, -0.56, 0.85, 0.03, -0.48, 0.95,
  0, -0.52, 0.92, 0, 0.3, 1.4, 0, 0.5, 1, 0.05, 0.55, 0.9,
]);
const keyBones = Int16Array.from({ length: 27 }, () => -1);
keyBones[8] = 3; keyBones[9] = 3; keyBones[12] = 5; keyBones[13] = 9;

const turn = (x, y, z) => new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z)).toArray();
const rotation = (bone, values, times = [0]) => ({ bone, kind: 1, times: Float32Array.from(times), values: Float32Array.from(values) });
const vector = (bone, kind, values, times = [0]) => ({ bone, kind, times: Float32Array.from(times), values: Float32Array.from(values) });

/** Stand: every bone turned a little, still (so Three's mixer skips its unchanged writes); bone 4's joint pushed. */
const standTurn = (bone) => turn(0.1 * bone, -0.05 * bone, 0.2);
const STAND = {
  animationId: 0, duration: 1,
  channels: [
    ...Array.from({ length: parents.length }, (_, bone) => rotation(bone, [...standTurn(bone), ...standTurn(bone)], [0, 1])),
    vector(4, 0, [0.02, 0.01, 0, 0.02, 0.01, 0], [0, 1]),
  ],
};
/** HandsClosed: the fingers curled; bone 3 keyed in position too, bone 5 in scale; bone 4 not at all. */
const CLOSED_TURN = { 3: turn(0, 1.2, 0), 5: turn(0.4, 0.6, 0), 9: turn(0, -1.2, 0) };
const HANDS_CLOSED = {
  animationId: HANDS_CLOSED_ANIMATION, duration: 0.033,
  channels: [
    rotation(3, CLOSED_TURN[3]), rotation(5, CLOSED_TURN[5]), rotation(9, CLOSED_TURN[9]),
    vector(3, 0, [0.01, 0, 0]), vector(5, 2, [0.9, 0.9, 0.9]),
    rotation(2, turn(1, 1, 1)), // the hand itself is not a finger: this key must stay unused
  ],
};

function template(clips = [STAND, HANDS_CLOSED]) {
  const drawn = [1, 2, 3, 4, 5, 7, 8, 9];
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
  return buildSkinnedTemplateFrom(geometry, {
    parents, pivots, flags: new Uint16Array(parents.length), animations: clips.map((clip) => clip.animationId), clips,
    // The rig's own global channel stays in front of the fingers'.
    globalChannels: [{ bone: 1, kind: 0, globalSequence: 0, interpolation: 1,
      times: Float32Array.from([0, 0.5]), values: Float32Array.from([0, 0, 0, 0.05, 0.1, -0.05]) }],
  }, 2);
}

const rest = (bone) => [0, 1, 2].map((axis) => pivots[bone * 3 + axis] - (parents[bone] >= 0 ? pivots[parents[bone] * 3 + axis] : 0));
const near = (actual, expected, label, epsilon = 1e-6) => {
  assert.equal(actual.length, expected.length, label);
  for (let index = 0; index < actual.length; index++) {
    assert.ok(Math.abs(actual[index] - expected[index]) < epsilon, `${label}: ${actual} vs ${expected}`);
  }
};
/** A quaternion up to sign. */
const sameTurn = (actual, expected, label) => {
  const dot = actual.reduce((sum, value, index) => sum + value * expected[index], 0);
  assert.ok(Math.abs(Math.abs(dot) - 1) < 1e-6, `${label}: ${actual} vs ${expected}`);
};
const normalized = (q) => new THREE.Quaternion(...q).normalize().toArray();

test("0x004e7700: key bones 8–12 close the right hand, 13–17 the left, and every joint below them", () => {
  assert.deepEqual(closedHandBones(parents, keyBones, HAND_RIGHT), [3, 4, 5]);
  assert.deepEqual(closedHandBones(parents, keyBones, HAND_LEFT), [9]);
  assert.deepEqual(closedHandBones(parents, keyBones, HAND_RIGHT | HAND_LEFT), [3, 4, 5, 9]);
  assert.deepEqual(closedHandBones(parents, keyBones, 0), []);
  assert.deepEqual(closedHandBones(parents, undefined, HAND_RIGHT), [], "no key bone table, no fingers");
  // An id past a short table names nothing (0x00832ab0: `keyBone < count` or no bone).
  assert.deepEqual(closedHandBones(parents, keyBones.subarray(0, 10), HAND_RIGHT | HAND_LEFT), [3, 4]);
  // The grip bone the weapon hangs from is never a finger.
  assert.ok(!closedHandBones(parents, keyBones, HAND_RIGHT | HAND_LEFT).includes(6));
});

test("0x004eaa70: points 1 and 2 close their hand; a shield, a sheath point or a stowed weapon closes none", () => {
  // The sequence 0x004e7700 pushes: 0xf, AnimationData's HandsClosed.
  assert.equal(HANDS_CLOSED_ANIMATION, 0xf);
  assert.equal(HANDS_CLOSED_ANIMATION, ANIMATION_IDS.HandsClosed);
  assert.equal(handOfPoint(1), HAND_RIGHT);
  assert.equal(handOfPoint(2), HAND_LEFT);
  assert.equal(handOfPoint(0), 0, "a shield rides point 0 and 0x004eaa70 closes nothing for it");
  assert.equal(handsClosedMask([1, 2, 0, 26, 32]), HAND_RIGHT | HAND_LEFT);
  const sword = { slot: 15, side: "", model: "", texture: "", inventoryType: 13, sheathe: 3 };
  const dagger = { slot: 16, side: "", model: "", texture: "", inventoryType: 13, sheathe: 3 };
  const shield = { slot: 16, side: "", model: "", texture: "", inventoryType: 14, sheathe: 4 };
  const bow = { slot: 17, side: "", model: "", texture: "", inventoryType: 15, sheathe: 0 };
  const gun = { slot: 17, side: "", model: "", texture: "", inventoryType: 26, sheathe: 0 };
  const points = (items, sheath) => items.map((item) => worldAttachmentPoint(item, sheath));
  assert.equal(handsClosedMask(points([sword, dagger], SHEATH_MELEE)), HAND_RIGHT | HAND_LEFT, "both drawn");
  assert.equal(handsClosedMask(points([sword, shield], SHEATH_MELEE)), HAND_RIGHT, "the shield hand stays as the clip has it");
  assert.equal(handsClosedMask(points([sword, dagger, shield], SHEATH_UNARMED)), 0, "sheathed: the hands let go");
  assert.equal(handsClosedMask(points([sword, bow], SHEATH_RANGED)), HAND_LEFT, "the bow in the left hand, the sword on the hip");
  assert.equal(handsClosedMask(points([gun], SHEATH_RANGED)), HAND_RIGHT, "a gun in the right");
});

test("the closed hand is HandsClosed's first key, the rest where it keys nothing, over the rig's own channels", () => {
  const tpl = template();
  assert.equal(closedHandsFor(tpl, keyBones, 0), undefined);
  assert.equal(closedHandsFor(tpl, undefined, HAND_RIGHT), undefined);
  const hands = closedHandsFor(tpl, keyBones, HAND_RIGHT);
  assert.deepEqual(hands.bones, [3, 4, 5]);
  assert.equal(closedHandsFor(tpl, keyBones, HAND_RIGHT), hands, "cached per template and mask");
  const channels = hands.source.globalChannels;
  assert.equal(channels[0], tpl.globalChannels[0], "the template's own channels first");
  const of = (bone, kind) => channels.find((channel) => channel.bone === bone && channel.kind === kind);
  sameTurn([...of(3, 1).values], CLOSED_TURN[3], "index turn");
  near([...of(3, 0).values], [0.01, 0, 0], "index offset off the rest pivot, as a global channel carries it");
  near([...of(5, 2).values], [0.9, 0.9, 0.9], "thumb scale");
  near([...of(4, 1).values], [0, 0, 0, 1], "tip: no key, no turn");
  near([...of(4, 0).values], [0, 0, 0], "tip: no key, the rest pivot");
  near([...of(4, 2).values], [1, 1, 1], "tip: no key, unit scale");
  assert.equal(of(2, 1), undefined, "the hand bone is not closed");
  // A model whose HandsClosed has not been built yet: no source until it is (the renderer asks for it).
  const bare = template([STAND]);
  assert.equal(closedHandsFor(bare, keyBones, HAND_RIGHT), undefined);
});

function rig(tpl) {
  const scene = new THREE.Scene();
  const instance = instantiateSkinned(tpl, new THREE.MeshBasicMaterial());
  scene.add(instance.root);
  instance.mixer.clipAction(tpl.clips.get(0)).play();
  return { scene, instance };
}

test("Three's path, the flat pose and the pose worker close the hand alike, and give it back on release", () => {
  const tpl = template();
  const program = fastPoseProgramFor(tpl, [6]);
  const palette = [...skinDemandFor(tpl).palette];
  const engine = PoseEngine.create({ workers: 0, arenaBytes: 4 << 20 });
  const cpu = rig(tpl), fast = rig(tpl), shared = rig(tpl);
  const durations = Uint32Array.from([500]);
  const hands = closedHandsFor(tpl, keyBones, HAND_RIGHT);
  let held = true;
  let now = 0;
  const bones = cpu.instance.skeleton.bones;
  for (let frame = 0; frame < 40; frame++) {
    const dt = 1 / 60;
    now += dt * 1000;
    if (frame === 20) {
      // Sheathed: the renderer releases the fingers before the step (`#closedHandChannels`).
      held = false;
      for (const state of [cpu, fast, shared]) releaseClosedHands(state.instance, tpl, hands.bones);
    }
    const source = held ? hands.source : tpl;
    cpu.instance.mixer.update(dt);
    applyGlobalSequenceBones(cpu.instance, source, durations, now);
    const flat = fast.instance.skeleton.fastPose(program);
    flat.advance(fast.instance.mixer, dt);
    writeGlobalSequenceLocals(source, durations, now, flat);
    flat.compose(fast.instance.root, undefined);
    fast.instance.skeleton.setFastPoseActive(true, fast.instance.mixer);
    const worker = shared.instance.skeleton.sharedPose(program, engine, shared.instance.mixer, source, durations);
    assert.ok(worker instanceof SharedPose, `frame ${frame}: the pose worker takes the step`);
    worker.advance(shared.instance.mixer, dt);
    worker.globalSequences(source, durations, now);
    worker.compose(shared.instance.root, undefined);
    shared.instance.skeleton.setFastPoseActive(true, shared.instance.mixer);
    for (const state of [cpu, fast, shared]) { state.scene.updateMatrixWorld(); state.instance.skeleton.update(); }

    if (held) {
      sameTurn(bones[3].quaternion.toArray(), normalized(CLOSED_TURN[3]), `frame ${frame}: index closed`);
      near(bones[3].position.toArray(), rest(3).map((value, axis) => value + [0.01, 0, 0][axis]), `frame ${frame}: index joint`);
      sameTurn(bones[4].quaternion.toArray(), [0, 0, 0, 1], `frame ${frame}: tip follows HandsClosed, not Stand`);
      near(bones[4].position.toArray(), rest(4), `frame ${frame}: tip at its rest pivot, not Stand's push`);
      near(bones[5].scale.toArray(), [0.9, 0.9, 0.9], `frame ${frame}: thumb scale`);
      sameTurn(bones[2].quaternion.toArray(), normalized(standTurn(2)), `frame ${frame}: the hand plays Stand`);
      sameTurn(bones[9].quaternion.toArray(), normalized(standTurn(9)), `frame ${frame}: the empty left hand plays Stand`);
    } else {
      sameTurn(bones[3].quaternion.toArray(), normalized(standTurn(3)), `frame ${frame}: index back on Stand`);
      sameTurn(bones[4].quaternion.toArray(), normalized(standTurn(4)), `frame ${frame}: tip back on Stand`);
      near(bones[4].position.toArray(), rest(4).map((value, axis) => value + [0.02, 0.01, 0][axis]), `frame ${frame}: tip pushed by Stand again`);
      near(bones[5].scale.toArray(), [1, 1, 1], `frame ${frame}: thumb scale back to the rest Stand leaves alone`);
    }
    for (const bone of palette) {
      for (let element = 0; element < 16; element++) {
        const a = cpu.instance.skeleton.boneMatrices[bone * 16 + element];
        for (const [state, name] of [[fast, "flat"], [shared, "worker"]]) {
          const b = state.instance.skeleton.boneMatrices[bone * 16 + element];
          assert.ok(Math.abs(a - b) < 2e-5, `frame ${frame} ${name} bone ${bone}[${element}]: ${a} vs ${b}`);
        }
      }
    }
  }
  engine.dispose?.();
});

test("the renderer poses each unit with the closed-hand source and tags hung items by point", () => {
  const source = readFileSync(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const step = source.slice(source.indexOf("  #animateUnit("), source.indexOf("  #flatPose("));
  assert.match(step, /const channels = this\.#closedHandChannels\(unit, template, skinned, client, metadata\);/);
  assert.match(step, /this\.#flatPose\(unit, unit\.wvm, mount\?\.skinned === undefined, channels\)/);
  assert.match(step, /flat\.globalSequences\(channels, unit\.wvm\.globalSequences, now\)/);
  assert.match(step, /writeGlobalSequenceLocals\(channels, unit\.wvm\.globalSequences, now, flat\)/);
  assert.match(step, /applyGlobalSequenceBones\(skinned, channels, unit\.wvm\.globalSequences, now\)/);
  // The channels are chosen before the step that applies them, after the cadence decided there is one.
  assert.ok(step.indexOf("#closedHandChannels(") > step.indexOf("stepUnitAnimationClock("));
  assert.ok(step.indexOf("#closedHandChannels(") < step.indexOf("skinned.mixer.update(poseElapsed)"));
  assert.match(source, /mesh\.userData\["point"\] = item\.point;/);
});

test("visual-v24: the key bone table travels in WVE1 from the client's own rigs", withClient, async () => {
  for (const base of ["Character\\Human\\Male\\HumanMale", "Character\\NightElf\\Male\\NightElfMale"]) {
    const [m2, skin] = await Promise.all([archives.read(`${base}.m2`), archives.read(`${base}00.skin`)]);
    if (!m2 || !skin) continue;
    const skeleton = parseM2Skeleton(m2, { wanted: new Set([0]) });
    assert.ok(skeleton.keyBones.length >= 18, `${base}: key bones through the left thumb`);
    const encoded = encodeWvm9(parseM2(m2, skin), skeleton, m2Animations(m2).map((animation) => animation.animationId),
      undefined, { extensions: true });
    const decoded = decodeWvm9(encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength));
    assert.deepEqual([...decoded.keyBones], [...skeleton.keyBones], `${base}: the table round-trips`);
    assert.ok(decoded.skeleton.animations.includes(HANDS_CLOSED_ANIMATION), `${base}: has HandsClosed`);
    const right = closedHandBones(decoded.skeleton.parents, decoded.keyBones, HAND_RIGHT);
    const left = closedHandBones(decoded.skeleton.parents, decoded.keyBones, HAND_LEFT);
    assert.ok(right.length >= 4 && left.length >= 4, `${base}: both hands have fingers (${right.length}, ${left.length})`);
    // Why the table and not the rig's shape: the hand attachment's bone does not lead to the fingers.
    const grip = decoded.attachments.find((attachment) => attachment.id === 1).bone;
    for (const finger of right) {
      let above = decoded.skeleton.parents[finger];
      while (above >= 0 && above !== grip) above = decoded.skeleton.parents[above];
      assert.notEqual(above, grip, `${base}: finger ${finger} is not under the grip bone ${grip}`);
    }
    // Without the extension (a gateway still on visual-v23 bytes) there is no table to read.
    const legacy = encodeWvm9(parseM2(m2, skin), skeleton);
    assert.equal(decodeWvm9(legacy.buffer.slice(legacy.byteOffset, legacy.byteOffset + legacy.byteLength)).keyBones, undefined);
  }
});
