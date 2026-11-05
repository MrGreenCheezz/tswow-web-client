// 03.11 (6.16в, 6.34): a unit's clips as Wow.exe chooses them. The table finds an animation's sequence (0x00832ab0), a start draws a
// variation by frequency and how many times over it runs (0x00826b00), and a loop draws again at its end. Measured on the stand:
// RidingHorse's JumpStart runs 467 ms, its second record; HumanMale's Stand plays its 3.4 % fidget on cycle boundaries.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as THREE from "three";
import { m2Animations, parseM2Skeleton } from "../tools/m2.mjs";
import { encodeWvaAnimations } from "../tools/wvm.mjs";
import { isUnitModelPath, visualModelNamespace } from "../tools/visual-model-key.mjs";
import {
  addSkinnedClips, buildSkinnedTemplateFrom, chooseAnimation, chooseClipVariation, clipReplays, drawClipVariation, playedSeconds, playsAs,
} from "../dist/code/browser/AnimatedModel.js";
import { decodeWvaAnimations, decodeWvaAnimationsPacked } from "../dist/code/browser/Wvm.js";
import { unpackWvaAnimations } from "../dist/code/browser/WvaAnimationDecode.js";
import { visualModelCacheNamespace } from "../dist/code/gateway/Gateway.js";

let archives;
try {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const { clientDirectory } = await import("../tools/paths.mjs");
  archives = await clientArchives(clientDirectory());
} catch {
  archives = undefined;
}
const withClient = { skip: archives ? false : "no 3.3.5a client on this machine" };

/** A model with sequences and a lookup table and nothing else. A record: [id, variation, ms, frequency, next, replayMin, replayMax]. */
function model(records, lookup) {
  const header = 0x130;
  const sequencesAt = header;
  const lookupAt = sequencesAt + records.length * 64;
  const data = Buffer.alloc(lookupAt + lookup.length * 2 + 64);
  data.write("MD20", 0, "latin1");
  data.writeUInt32LE(records.length, 0x1c);
  data.writeUInt32LE(sequencesAt, 0x20);
  data.writeUInt32LE(lookup.length, 0x24);
  data.writeUInt32LE(lookupAt, 0x28);
  records.forEach(([id, variation, ms, frequency, next, replayMin = 0, replayMax = 0], index) => {
    const at = sequencesAt + index * 64;
    data.writeUInt16LE(id, at);
    data.writeUInt16LE(variation, at + 2);
    data.writeUInt32LE(ms, at + 4);
    data.writeUInt32LE(0x20, at + 12);
    data.writeInt16LE(frequency, at + 0x10);
    data.writeUInt32LE(replayMin, at + 0x14);
    data.writeUInt32LE(replayMax, at + 0x18);
    data.writeUInt32LE(150, at + 0x1c);
    data.writeInt16LE(next, at + 0x3c);
    data.writeUInt16LE(index, at + 0x3e);
  });
  lookup.forEach((value, slot) => data.writeUInt16LE(value, lookupAt + slot * 2));
  return data;
}

test("an animation is the sequence the model's table finds, not the first record with its id", () => {
  // RidingHorse's JumpStart in small: two records of id 37 with variation 0, and the table names the second.
  const horse = model([[0, 0, 4000, 32767, -1], [37, 0, 833, 32767, -1], [37, 0, 467, 32767, -1]], [0, 2, 0xffff]);
  // 37 % 3 = 1 → record 2; 0 % 3 = 0 → record 0.
  const asExe = m2Animations(horse, { asWowExe: true });
  assert.deepEqual(asExe.map((clip) => [clip.animationId, clip.duration]), [[0, 4000], [37, 467]]);
  // Not asked: what a visual-v24 artifact was built from, byte for byte.
  assert.deepEqual(m2Animations(horse).map((clip) => [clip.animationId, clip.duration]), [[0, 4000], [37, 833]]);
  assert.equal(m2Animations(horse)[0].variation, undefined, "and no variation fields on it");

  // A collision: ids 5, 13 and 21 all hash to slot 5 of 8, and the probe adds the square of its step: slot 6, then 10 % 8 = 2. The
  // trap in slot 0 is where a probe adding the step alone would land, a record of 21 that the table does not mean.
  const probed = model([[5, 0, 100, 32767, -1], [13, 0, 200, 32767, -1], [21, 0, 300, 32767, -1], [21, 0, 999, 32767, -1]],
    [3, 0xffff, 2, 0xffff, 0xffff, 0, 1, 0xffff]);
  assert.deepEqual(m2Animations(probed, { asWowExe: true }).map((clip) => clip.duration), [100, 200, 300]);

  // No table: the records in order, as 0x00832ab0 reads them then.
  const bare = model([[37, 0, 833, 32767, -1], [37, 0, 467, 32767, -1]], []);
  assert.deepEqual(m2Animations(bare, { asWowExe: true }).map((clip) => clip.duration), [833]);
  // An id the table leaves out still has its record.
  const gap = model([[7, 0, 300, 32767, -1]], [0xffff, 0xffff]);
  assert.deepEqual(m2Animations(gap, { asWowExe: true }).map((clip) => clip.duration), [300]);
});

test("the variations travel with the sequence the table found, the head first and those with a share of the draw", () => {
  // HumanMale's Stand: 0 → 25 → 208 → 214 → 215, the last two with no share. A record of another id keeps out of the chain.
  const records = [
    [0, 0, 2667, 15818, 2], [5, 0, 667, 32767, -1], [0, 1, 2500, 1129, 3], [0, 2, 5333, 15818, 4], [0, 3, 2667, 0, 5], [0, 4, 2666, 0, -1],
  ];
  const lookup = new Array(8).fill(0xffff);
  lookup[0] = 0;
  lookup[5] = 1;
  const clips = m2Animations(model(records, lookup), { asWowExe: true });
  assert.deepEqual(clips.map((clip) => [clip.animationId, clip.variation, clip.frequency]),
    [[0, 0, 15818], [0, 1, 1129], [0, 2, 15818], [5, 0, 32767]]);
  // A chain cannot loop for ever on a broken file.
  const looped = model([[0, 0, 100, 16000, 1], [0, 1, 100, 16000, 0]], [0]);
  assert.equal(m2Animations(looped, { asWowExe: true }).length, 2);
  // The replay count comes along, and the head keeps its place even with no share.
  const replayed = model([[0, 0, 100, 0, 1, 3, 5], [0, 1, 100, 100, -1, 1, 2]], [0]);
  assert.deepEqual(m2Animations(replayed, { asWowExe: true }).map((clip) => [clip.variation, clip.replayMin, clip.replayMax]),
    [[0, 3, 5], [1, 1, 2]]);
});

test("only units turn over, in the tools and in the gateway alike", () => {
  for (const [path, namespace] of [
    ["Creature\\Wolf\\Wolf.m2", "visual-unit-v2"], ["character\\Human\\Male\\HumanMale.m2", "visual-unit-v2"],
    ["creature/wolf/wolf.M2", "visual-unit-v2"], ["World\\Tree.m2", "visual-v24"], ["Item\\Creature\\x.m2", "visual-v24"],
    ["Spells\\Fire.m2", "visual-spell-v2"], ["World\\Goober\\G_Chest.m2", "visual-goober-v1"], ["World\\wmo\\Inn.wmo", "visual-wmo-v27"],
  ]) {
    assert.equal(visualModelNamespace(path), namespace, path);
    assert.equal(visualModelCacheNamespace(path), namespace, `the gateway on ${path}`);
  }
  assert.equal(isUnitModelPath("Creature\\Wolf\\Wolf.m2"), true);
  assert.equal(isUnitModelPath("World\\Creature\\x.m2"), false);
});

const channel = () => ({ bone: 0, kind: 1, interpolation: 1, times: Uint32Array.of(0), values: Int16Array.of(0, 0, 0, 32767) });
const wireClip = (variation, frequency, replayMin, replayMax) => ({
  animationId: 16, duration: 1000 + variation, blendTime: 150, movingSpeed: 0, variationNext: -1, variationIndex: 12 + variation,
  variation, frequency, replayMin, replayMax, channels: [channel()],
});

test("a clip's variation, frequency and replays survive the artifact, both ways of reading it", () => {
  const data = encodeWvaAnimations(1, [wireClip(0, 16383, 0, 0), wireClip(1, 16384, 2, 4)]);
  const bytes = data.buffer.slice(data.byteOffset, data.byteOffset + data.length);
  const plain = decodeWvaAnimations(bytes.slice(0), 1);
  const packed = unpackWvaAnimations(wvaPacked(decodeWvaAnimationsPacked(bytes.slice(0), 1)));
  for (const clips of [plain, packed]) {
    assert.deepEqual(clips.map((clip) => [clip.animationId, clip.variation, clip.frequency, clip.replayMin, clip.replayMax, clip.variationIndex]),
      [[16, 0, 16383, 0, 0, 12], [16, 1, 16384, 2, 4, 13]]);
  }
  // An artifact with none says nothing, and the reader invents nothing.
  const { variation, frequency, replayMin, replayMax, ...old } = wireClip(0, 0, 0, 0);
  const oldData = encodeWvaAnimations(1, [old]);
  const oldBytes = oldData.buffer.slice(oldData.byteOffset, oldData.byteOffset + oldData.length);
  assert.equal(decodeWvaAnimations(oldBytes.slice(0), 1)[0].variation, undefined);
  assert.equal(unpackWvaAnimations(wvaPacked(decodeWvaAnimationsPacked(oldBytes.slice(0), 1)))[0].variation, undefined);
});

function wvaPacked({ clipTable, channelTable, keys, span }) {
  return { clipTable, channelTable, keys, span, digest: "test", cost: { typedBackingBytes: keys.byteLength, numericArrayElements: 0 } };
}

const skeletonClip = (animationId, variation, duration, frequency = 0, replayMin = 0, replayMax = 0) => ({
  animationId, variation, duration, frequency, replayMin, replayMax,
  channels: [{ bone: 0, kind: 1, times: Float32Array.of(0), values: Float32Array.of(0, 0, 0, 1) }],
});

function template(clips, extra = []) {
  const built = buildSkinnedTemplateFrom(new THREE.BufferGeometry(), {
    parents: Int16Array.of(-1), pivots: new Float32Array(3), flags: new Uint16Array(1), animations: [...new Set(clips.map((clip) => clip.animationId))], clips,
  }, 2);
  if (extra.length) addSkinnedClips(built, extra);
  return built;
}

test("6.39: a Stand the file lists with no keys is the rest pose, not the first clip looping for ever", () => {
  // The training dummy: Stand has no track at all, so the reader writes no clip for it; `animations` still names it.
  const dummy = buildSkinnedTemplateFrom(new THREE.BufferGeometry(), {
    parents: Int16Array.of(-1), pivots: new Float32Array(3), flags: new Uint16Array(1), animations: [0, 9, 10],
    clips: [skeletonClip(9, 0, 333), skeletonClip(10, 0, 1334)],
  }, 2);
  assert.deepEqual(chooseAnimation(dummy.clips, {}), { animation: 0, loop: true });
  assert.equal(dummy.clips.get(0).tracks.length, 0, "nothing moves");
  assert.ok(dummy.clips.get(0).duration > 0, "a mixer can run it");
  assert.equal(dummy.clips.get(9).tracks.length, 1, "the wounds are still there to be played");

  // With no Stand record at all nothing is invented: the old answer stands for the one model of that kind.
  const drums = buildSkinnedTemplateFrom(new THREE.BufferGeometry(), {
    parents: Int16Array.of(-1), pivots: new Float32Array(3), flags: new Uint16Array(1), animations: [4],
    clips: [skeletonClip(4, 0, 1000)],
  }, 2);
  assert.equal(drums.clips.has(0), false);
  assert.equal(chooseAnimation(drums.clips, {}).animation, 4);
});

test("6.39: the client's own training dummy stands still", async (t) => {
  let chain;
  try {
    const { clientDirectory } = await import("../tools/paths.mjs");
    const { clientArchives } = await import("../tools/mpq.mjs");
    chain = await clientArchives(clientDirectory());
  } catch {
    t.skip("no 3.3.5a client on this machine");
    return;
  }
  const data = await chain.read("Creature\\Object\\WoodenDummy.m2");
  if (!data) {
    t.skip("the client has no WoodenDummy.m2");
    return;
  }
  const model = Buffer.from(data);
  const skeleton = parseM2Skeleton(model, { asWowExe: true, animations: new Map() });
  assert.equal(skeleton.clips.some((clip) => clip.animationId === 0), false, "the reader writes no clip for its Stand");
  const dummy = buildSkinnedTemplateFrom(new THREE.BufferGeometry(), {
    parents: Int16Array.from(skeleton.bones.map((bone) => bone.parent)),
    pivots: Float32Array.from(skeleton.bones.flatMap((bone) => bone.pivot)),
    flags: new Uint16Array(skeleton.bones.length),
    animations: [...new Set(m2Animations(model, { asWowExe: true }).map((record) => record.animationId))],
    clips: skeleton.clips,
  }, 2);
  const chosen = chooseAnimation(dummy.clips, {});
  assert.equal(chosen.animation, 0, "Stand, not CombatWound");
  assert.equal(dummy.clips.get(chosen.animation).tracks.length, 0);
});

test("a template answers an id with its first clip and keeps the others beside it", () => {
  const built = template([skeletonClip(0, 0, 2.667, 15818), skeletonClip(0, 1, 2.5, 1129), skeletonClip(4, 0, 1, 32767)],
    [skeletonClip(16, 0, 1, 16383), skeletonClip(16, 1, 1.2, 16384, 2, 4)]);
  assert.equal(built.clips.get(0).duration, 2.667, "the second variation does not take the id over");
  assert.equal(built.clips.get(16).duration, 1, "not from the sidecar either");
  assert.deepEqual(built.variations.get(0).map((entry) => [entry.variation, entry.clip.duration, entry.frequency]),
    [[0, 2.667, 15818], [1, 2.5, 1129]]);
  assert.deepEqual(built.variations.get(16).map((entry) => [entry.variation, entry.replayMin, entry.replayMax]), [[0, 0, 0], [1, 2, 4]]);
  assert.equal(built.overlayClips.get(0), built.variations.get(0)[0].overlay);
  // An artifact with no variation fields makes no list and no draw.
  const old = template([{ animationId: 0, duration: 1, channels: skeletonClip(0, 0, 1).channels }]);
  assert.equal(old.variations, undefined);
  assert.equal(drawClipVariation(old, 0), undefined);
});

test("a draw lands by frequency, what the frequencies leave falls to the last, and a clip replays as authored", () => {
  const stand = [{ frequency: 15818 }, { frequency: 1129 }, { frequency: 15818 }];
  assert.equal(chooseClipVariation(stand, 0), stand[0]);
  assert.equal(chooseClipVariation(stand, 15817), stand[0]);
  assert.equal(chooseClipVariation(stand, 15818), stand[1]);
  assert.equal(chooseClipVariation(stand, 16946), stand[1]);
  assert.equal(chooseClipVariation(stand, 16947), stand[2]);
  assert.equal(chooseClipVariation(stand, 32767), stand[2], "the 2 of 32767 the file leaves");
  assert.equal(chooseClipVariation([{ frequency: 0 }, { frequency: 0 }], 5).frequency, 0);
  // 0x00826b00: the span scaled by rand, and at least once.
  assert.equal(clipReplays({ replayMin: 0, replayMax: 0 }, 20000), 1);
  assert.equal(clipReplays({ replayMin: 3, replayMax: 5 }, 0), 3);
  assert.equal(clipReplays({ replayMin: 3, replayMax: 5 }, 32767), 4, "the top of the span is never reached, as there");
  assert.equal(clipReplays({ replayMin: 0, replayMax: 2 }, 0), 1);
  // Over many starts the share comes out as authored, and the same run gives the same bones.
  const built = template([skeletonClip(0, 0, 2.667, 15818), skeletonClip(0, 1, 2.5, 1129), skeletonClip(0, 2, 5.333, 15818)]);
  let fidgets = 0;
  const count = 20000;
  for (let at = 0; at < count; at++) if (drawClipVariation(built, 0).clip === built.variations.get(0)[1].clip) fidgets++;
  assert.ok(Math.abs(fidgets / count - 1129 / 32767) < 0.006, `${fidgets} of ${count}`);
  // A pose moving between the layers stays the variation it is.
  const second = built.variations.get(0)[1];
  assert.equal(drawClipVariation(built, 0, second.clip).clip, second.clip);
  assert.equal(drawClipVariation(built, 0, second.overlay).clip, second.clip);
});

test("a replayed one-shot runs its times over and counts as a one-shot", () => {
  const mixer = new THREE.AnimationMixer(new THREE.Object3D());
  const action = mixer.clipAction(new THREE.AnimationClip("x", 2, []));
  assert.equal(playedSeconds(action), 2, "an action as it is made is a repeat for ever: one clip's length");
  action.setLoop(THREE.LoopOnce, Infinity);
  assert.equal(playedSeconds(action), 2);
  assert.equal(playsAs(action, THREE.LoopOnce), true);
  action.setLoop(THREE.LoopRepeat, 3);
  assert.equal(playedSeconds(action), 6);
  assert.equal(playsAs(action, THREE.LoopOnce), true, "wanted once, playing thrice");
  action.setLoop(THREE.LoopRepeat, Infinity);
  assert.equal(playedSeconds(action), 2);
  assert.equal(playsAs(action, THREE.LoopOnce), false);
  assert.equal(playsAs(action, THREE.LoopRepeat), true);
});

test("the client's own files: what the stand measured", withClient, async () => {
  const b = String.fromCharCode(92);
  const read = async (path) => {
    const m2 = Buffer.from(await archives.read(`${path}.m2`));
    const animations = new Map();
    for (const clip of m2Animations(m2, { asWowExe: true })) {
      if (clip.external && !animations.has(clip.external)) animations.set(clip.external, await archives.read(`${path}${clip.external}.anim`));
    }
    return { m2, skeleton: parseM2Skeleton(m2, { animations, asWowExe: true }) };
  };
  // m1: JumpStart hands over to Jump at 467 ms and is entered over 150, the second record of its id.
  const horse = await read(`Creature${b}RidingHorse${b}RidingHorse`);
  const jump = m2Animations(horse.m2, { asWowExe: true }).find((clip) => clip.animationId === 37);
  assert.deepEqual([jump.duration, jump.blendTime], [467, 150]);
  assert.deepEqual([m2Animations(horse.m2).find((clip) => clip.animationId === 37).duration], [833], "not what the first record says");
  // idle1: HumanMale's Stand, the fidget at 1129 of 32767 and the two with no share gone. The parser keeps a variation behind its
  // head and an id's clips together.
  const man = await read(`Character${b}Human${b}Male${b}HumanMale`);
  assert.deepEqual(man.skeleton.clips.filter((clip) => clip.animationId === 0).map((clip) => [clip.variation, clip.duration, clip.frequency]),
    [[0, 2667, 15818], [1, 2500, 1129], [2, 5333, 15818]]);
  let last = -1;
  for (const clip of man.skeleton.clips) {
    assert.ok(clip.animationId >= last, "in the order of their ids");
    last = clip.animationId;
  }
  // The same model without the option: variation 0 alone, as a visual-v24 artifact has it.
  const old = parseM2Skeleton(man.m2, { animations: new Map() });
  assert.equal(old.clips.some((clip) => clip.variation !== undefined), false);
});
