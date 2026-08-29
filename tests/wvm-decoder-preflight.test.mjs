import assert from "node:assert/strict";
import test from "node:test";

import { decodeWvaAnimations, decodeWvm9 } from "../dist/code/browser/Wvm.js";

const magic = (bytes, value) => bytes.set([...value].map((character) => character.charCodeAt(0)));

function wvm(length = 72) {
  const bytes = new Uint8Array(length);
  const view = new DataView(bytes.buffer);
  magic(bytes, "WVM9");
  view.setUint8(12, 2);
  view.setUint32(24, length, true);
  return { bytes, view };
}

function wva(length = 12, bones = 1, clips = 0) {
  const bytes = new Uint8Array(length);
  const view = new DataView(bytes.buffer);
  magic(bytes, "WVA1");
  view.setUint32(4, length, true);
  view.setUint16(8, bones, true);
  view.setUint16(10, clips, true);
  return { bytes, view };
}

function skeletonModel(length, clips = 0) {
  const artifact = wvm(length);
  artifact.view.setUint8(13, 1);
  artifact.view.setUint32(20, 72, true);
  artifact.view.setUint16(72, 1, true);
  artifact.view.setUint16(74, clips, true);
  if (length >= 78) artifact.view.setInt16(76, -1, true);
  return artifact;
}

test("minimal WVM9 bodies and skeleton clips remain valid", () => {
  const empty = decodeWvm9(wvm().bytes.buffer);
  assert.equal(empty.positions.length, 0);
  assert.equal(empty.skeleton, undefined);

  const { bytes, view } = skeletonModel(104, 1);
  view.setUint16(92, 7, true);
  view.setUint32(96, 1_000, true);
  view.setUint32(100, 0, true);
  const model = decodeWvm9(bytes.buffer);
  assert.equal(model.skeleton.parents.length, 1);
  assert.deepEqual(model.skeleton.clips.map((clip) => [clip.animationId, clip.duration, clip.channels.length]),
    [[7, 1, 0]]);
});

test("a minimal keyed WVA1 clip remains valid", () => {
  const { bytes, view } = wva(48, 1, 1);
  view.setUint16(12, 9, true);
  view.setUint32(16, 2_000, true);
  view.setUint32(20, 1, true);
  view.setUint16(24, 0, true);
  view.setUint8(26, 0);
  view.setUint32(28, 1, true);
  view.setUint32(32, 250, true);
  view.setFloat32(36, 1, true);
  view.setFloat32(40, 2, true);
  view.setFloat32(44, 3, true);

  const [clip] = decodeWvaAnimations(bytes.buffer, 1);
  assert.equal(clip.animationId, 9);
  assert.equal(clip.duration, 2);
  assert.deepEqual([...clip.channels[0].times], [0.25]);
  assert.deepEqual([...clip.channels[0].values], [1, 2, 3]);
});

test("WVM9 rejects truncated and impossible fixed-size tables before allocating them", () => {
  const header = new Uint8Array(4);
  magic(header, "WVM9");
  assert.throws(() => decodeWvm9(header.buffer), /header is truncated/);

  const vertices = wvm();
  vertices.view.setUint32(4, 4_000_000, true);
  assert.throws(() => decodeWvm9(vertices.bytes.buffer), /vertex streams runs past/);

  const indices = wvm();
  indices.view.setUint32(8, 0xffff_ffff, true);
  assert.throws(() => decodeWvm9(indices.bytes.buffer), /index stream runs past/);

  const submeshes = wvm();
  submeshes.view.setUint16(14, 0xffff, true);
  assert.throws(() => decodeWvm9(submeshes.bytes.buffer), /submesh table runs past/);
});

test("WVM9 validates variable table and skeleton offsets structurally", () => {
  const texture = wvm();
  texture.view.setUint16(18, 1, true);
  assert.throws(() => decodeWvm9(texture.bytes.buffer), /texture table headers runs past/);

  const badOffset = wvm();
  badOffset.view.setUint8(13, 1);
  badOffset.view.setUint32(20, 4, true);
  assert.throws(() => decodeWvm9(badOffset.bytes.buffer), /skeleton offset disagrees/);

  const bones = skeletonModel(76);
  bones.view.setUint16(72, 1024, true);
  assert.throws(() => decodeWvm9(bones.bytes.buffer), /bone table runs past/);
});

test("WVM9 skeleton clip counts cannot drive oversized header loops", () => {
  const clips = skeletonModel(92, 1024);
  assert.throws(() => decodeWvm9(clips.bytes.buffer), /clip headers runs past/);

  const channels = skeletonModel(104, 1);
  channels.view.setUint32(100, 0xffff_ffff, true);
  assert.throws(() => decodeWvm9(channels.bytes.buffer), /channel headers runs past/);
});

test("WVA1 rejects out-of-range headers and count-driven truncation", () => {
  const bones = wva(12, 1025);
  assert.throws(() => decodeWvaAnimations(bones.bytes.buffer, 1025), /bone count is out of range/);

  const clips = wva(12, 1, 1025);
  assert.throws(() => decodeWvaAnimations(clips.bytes.buffer, 1), /clip count is out of range/);

  const channels = wva(24, 1, 1);
  channels.view.setUint32(20, 0xffff_ffff, true);
  assert.throws(() => decodeWvaAnimations(channels.bytes.buffer, 1), /channel headers runs past/);
});

test("WVA1 rejects invalid channel kinds and impossible key payloads", () => {
  const kind = wva(32, 1, 1);
  kind.view.setUint32(20, 1, true);
  kind.view.setUint8(26, 3);
  assert.throws(() => decodeWvaAnimations(kind.bytes.buffer, 1), /channel kind is invalid/);

  const huge = wva(32, 1, 1);
  huge.view.setUint32(20, 1, true);
  huge.view.setUint8(26, 2);
  huge.view.setUint32(28, 0xffff_ffff, true);
  assert.throws(() => decodeWvaAnimations(huge.bytes.buffer, 1), /key times runs past/);

  const truncated = wva(36, 1, 1);
  truncated.view.setUint32(20, 1, true);
  truncated.view.setUint8(26, 0);
  truncated.view.setUint32(28, 1, true);
  assert.throws(() => decodeWvaAnimations(truncated.bytes.buffer, 1), /key values runs past/);
});
