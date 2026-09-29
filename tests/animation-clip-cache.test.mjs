import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import {
  addSkinnedClips, buildSkinnedTemplateFrom, mergeSkinnedClips, skinnedClipsBoneSpan,
} from "../dist/code/browser/AnimatedModel.js";

function clip(animationId, bone = 1, channels = true) {
  return {
    animationId, duration: 1,
    channels: channels ? [{
      bone, kind: 0,
      times: Float32Array.from([0, 1]),
      values: Float32Array.from([0, 0, 0, 1, 0, 0]),
    }] : [],
  };
}

function rig(pivot = 2) {
  return {
    parents: Int16Array.from([-1, 0]),
    flags: Uint16Array.from([0, 0]),
    pivots: Float32Array.from([0, 0, 0, pivot, 0, 0]),
    clips: [clip(0)],
    animations: [0, 10, 11, 12, 13],
    globalChannels: [],
  };
}

function template(skeleton) {
  const built = buildSkinnedTemplateFrom(new THREE.BufferGeometry(), skeleton, 2);
  assert.ok(built);
  return built;
}

test("appearance templates share compiled clips only for the exact decoded skeleton", () => {
  const skeleton = rig();
  const first = template(skeleton);
  const second = template(skeleton);
  assert.notStrictEqual(first.clips, second.clips);
  assert.notStrictEqual(first.overlayClips, second.overlayClips);
  assert.strictEqual(first.clips.get(0), second.clips.get(0));
  assert.strictEqual(first.overlayClips.get(0), second.overlayClips.get(0));
  first.clips.set(99, new THREE.AnimationClip("local", 1, []));
  assert.equal(second.clips.has(99), false);

  const differentRig = { ...skeleton, pivots: Float32Array.from([0, 0, 0, 5, 0, 0]) };
  const third = template(differentRig);
  assert.notStrictEqual(first.clips.get(0), third.clips.get(0));
  assert.equal(first.clips.get(0).tracks[0].values[0], 2);
  assert.equal(third.clips.get(0).tracks[0].values[0], 5);
});

test("incremental sidecar merge prioritizes wanted clips, counts empty entries, and reuses compilation", () => {
  const skeleton = rig();
  const first = template(skeleton);
  const second = template(skeleton);
  const sidecar = [clip(10), clip(11, 1, false), clip(12), clip(13)];
  const one = { maxClips: 1, milliseconds: Infinity };
  assert.deepEqual(mergeSkinnedClips(first, sidecar, { ...one, wanted: [13] }),
    { added: 1, complete: false });
  assert.equal(first.clips.has(13), true);
  assert.equal(first.clips.has(10), false);
  assert.deepEqual(mergeSkinnedClips(first, sidecar, one), { added: 1, complete: false });
  assert.deepEqual(mergeSkinnedClips(first, sidecar, one), { added: 0, complete: false });
  assert.deepEqual(mergeSkinnedClips(first, sidecar, one), { added: 1, complete: true });
  assert.equal(addSkinnedClips(first, sidecar), 0);

  assert.equal(addSkinnedClips(second, sidecar), 3);
  for (const id of [10, 12, 13]) {
    assert.strictEqual(first.clips.get(id), second.clips.get(id));
    assert.strictEqual(first.overlayClips.get(id), second.overlayClips.get(id));
  }
  assert.notStrictEqual(first.clips, second.clips);
});

test("incremental merge honors a soft time budget and resumes on the next call", () => {
  const built = template(rig());
  const sidecar = [clip(10), clip(12), clip(13)];
  skinnedClipsBoneSpan(sidecar);
  let tick = 0;
  const now = () => tick++;
  assert.deepEqual(mergeSkinnedClips(built, sidecar,
    { maxClips: 3, milliseconds: 1, now }), { added: 1, complete: false });
  assert.equal(built.clips.has(12), false);
  assert.deepEqual(mergeSkinnedClips(built, sidecar,
    { maxClips: 3, milliseconds: 1, now }), { added: 1, complete: false });
  assert.deepEqual(mergeSkinnedClips(built, sidecar,
    { maxClips: 3, milliseconds: 1, now }), { added: 1, complete: true });
});

test("validation reads a bounded part of a large channel list before compiling wanted clips", () => {
  const built = template(rig());
  let reads = 0;
  const channels = Array.from({ length: 400 }, () => ({
    get bone() { reads++; return 1; },
    kind: 1, times: Float32Array.from([0]), values: Float32Array.from([0, 0, 0, 1]),
  }));
  const sidecar = [{ animationId: 10, duration: 1, channels }, clip(13)];
  let tick = 0;
  let result = mergeSkinnedClips(built, sidecar, {
    wanted: [13], maxClips: 1, milliseconds: 3, now: () => tick++,
  });
  assert.deepEqual(result, { added: 0, complete: false });
  assert.ok(reads > 0 && reads <= 2, "indexing obeys the injected wall-clock budget");
  assert.equal(built.clips.has(10), false);
  assert.equal(built.clips.has(13), false);
  for (let call = 0; call < 20 && result.added === 0; call++) {
    const before = reads;
    result = mergeSkinnedClips(built, sidecar,
      { wanted: [13], maxClips: 1, milliseconds: Infinity });
    assert.ok(reads - before <= 64, "one call reads at most its bounded index step allowance");
    if (reads < channels.length) assert.equal(result.added, 0, "no clip is built before full validation");
  }
  assert.equal(reads, channels.length);
  assert.equal(result.added, 1);
  assert.equal(result.complete, false);
  assert.equal(built.clips.has(13), true, "wanted clip is first after validation");
  assert.equal(built.clips.has(10), false);
  assert.equal(addSkinnedClips(built, sidecar), 1, "full merge completes the remaining source");
});

test("a late wide channel rejects the whole sidecar before any valid clip is installed", () => {
  const built = template(rig());
  let reads = 0;
  const channels = Array.from({ length: 400 }, (_, at) => ({
    get bone() { reads++; return at === 399 ? 2 : 1; },
    kind: 1, times: Float32Array.from([0]), values: Float32Array.from([0, 0, 0, 1]),
  }));
  const sidecar = [clip(10), { animationId: 12, duration: 1, channels }];
  const warn = console.warn;
  let warnings = 0;
  console.warn = () => { warnings++; };
  try {
    let result;
    for (let call = 0; call < 20; call++) {
      const before = reads;
      result = mergeSkinnedClips(built, sidecar,
        { wanted: [10], maxClips: 1, milliseconds: Infinity });
      assert.ok(reads - before <= 64);
      assert.equal(built.clips.has(10), false);
      if (result.complete) break;
    }
    assert.deepEqual(result, { added: 0, complete: true });
    assert.equal(reads, channels.length);
    assert.equal(warnings, 1);
    assert.equal(skinnedClipsBoneSpan(sidecar), 3, "synchronous span API returns the full answer");
    assert.equal(addSkinnedClips(built, sidecar), 0);
  } finally {
    console.warn = warn;
  }
});