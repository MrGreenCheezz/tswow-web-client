// 13.10 (6.13): chain beams as Wow.exe's CLightning draws them (browser/LightningBeam.ts), which segments a kit
// draws and when (browser/ChainBeamPlan.ts), the Combo rows and the persistent/fan flags (gateway
// SpellKitExtras.ts) and the GxBlend materials (browser/ChainBeam.ts).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import * as THREE from "three";
import { chainComboIds, decodeChainComboId, kitChains, parseSpellChainEffects } from "../dist/code/gateway/SpellKitExtras.js";
import { LightningBeam, lightningAlphaReference } from "../dist/code/browser/LightningBeam.js";
import { beamAnchors, planChainBeams } from "../dist/code/browser/ChainBeamPlan.js";
import { applyBeamBlend } from "../dist/code/browser/ChainBeam.js";

const near = (actual, expected, message, epsilon = 1e-4) =>
  assert.ok(Math.abs(actual - expected) <= epsilon, `${message}: ${actual} vs ${expected}`);

let dbcDirectory;
try {
  dbcDirectory = (await import("../tools/paths.mjs")).dbcDirectory();
} catch {
  dbcDirectory = undefined;
}
let chainFile;
try {
  chainFile = dbcDirectory ? await readFile(join(dbcDirectory, "SpellChainEffects.dbc")) : undefined;
} catch {
  chainFile = undefined;
}
const withDataset = { skip: chainFile ? false : "no SpellChainEffects.dbc in the tswow dataset on this machine" };

const row = (extra = {}) => ({
  id: 1, texture: "T.blp", width: 0.5, avgSegLen: 2, noiseScale: 0, texCoordScale: 0, textureLength: 2, segDuration: 1000,
  segDelay: 0, flags: 0, jointCount: 0, color: [128, 255, 255, 255], blendMode: 3, renderLayer: 0,
  jointOffsetRadius: 0, jointsPerMinorJoint: 0, minorJointsPerMajorJoint: 0, minorJointScale: 0, majorJointScale: 0,
  jointMoveSpeed: 0, jointSmoothness: 0, minDurationBetweenJoints: 0, maxDurationBetweenJoints: 0, waveHeight: 0,
  waveFreq: 0, waveSpeed: 0, minWaveAngle: 0, maxWaveAngle: 0, minWaveSpin: 0, maxWaveSpin: 0, arcHeight: 0,
  minArcAngle: 0, maxArcAngle: 0, minArcSpin: 0, maxArcSpin: 0, delayBetweenEffects: 0, minFlickerOnDuration: 0,
  maxFlickerOnDuration: 0, minFlickerOffDuration: 0, maxFlickerOffDuration: 0, pulseSpeed: 0, pulseOnLength: 0,
  pulseFadeLength: 0, wavePhase: 0, combo: [], ...extra,
});

/** A deterministic random: 0.5 always (signed draws are 0, ranges their middle). */
const half = () => 0.5;

function draw(beam, from, to, eye = { x: 5, y: 0, z: 10 }) {
  const positions = new Float32Array(4000 * 3);
  const uvs = new Float32Array(4000 * 2);
  const alphas = new Float32Array(4000);
  const vertices = beam.build(from, to, eye, positions, uvs, alphas);
  return { vertices, positions, uvs, alphas };
}

test("Combo ids: four bytes each, decoded by 0x009a8ce0; Drain Life's 719 names 720 and 731…735", withDataset, () => {
  assert.equal(decodeChainComboId(0x03010351), 720);
  assert.deepEqual(chainComboIds(Buffer.from([0x69, 3, 1, 0x13])), [745]);
  assert.deepEqual(chainComboIds(Buffer.from([0, 0, 0, 0, 0x69, 3, 1, 0x13])), [], "stops at a zero id");
  const rows = parseSpellChainEffects(chainFile);
  assert.deepEqual(rows.get(719).combo, [720, 731, 732, 733, 734, 735]);
  assert.deepEqual(rows.get(743).combo, [], "Chain Lightning has none");
  const chains = kitChains({ procs: [0, -1, -1, -1], param0: [719, 0, 0, 0], param1: [1, 0, 0, 0], param2: [1, 0, 0, 0], param3: [0, 0, 0, 0] }, rows);
  assert.equal(chains[0].persistent, true, "CharParamTwo");
  assert.equal(chains[0].fan, undefined, "CharParamThree 0: a chain");
  const fan = kitChains({ procs: [0], param0: [719], param1: [0], param2: [0], param3: [1] }, rows)[0];
  assert.deepEqual([fan.persistent, fan.fan], [undefined, true], "CharParamThree alone: a fan");
  assert.deepEqual(chains[0].combos.map((one) => one.id), [720, 731, 732, 733, 734, 735]);
  near(rows.get(743).arcHeight, 0.5, "the whole row travels");
  assert.equal(rows.get(743).jointsPerMinorJoint, 3);
});

test("kitChains: the walk stops at a combo naming no row, and a record set is at most twelve", () => {
  const rows = new Map([[1, row({ id: 1, combo: [2, 99, 3] })], [2, row({ id: 2 })], [3, row({ id: 3 })],
    [4, row({ id: 4, combo: Array.from({ length: 12 }, () => 5) })], [5, row({ id: 5 })]]);
  assert.deepEqual(kitChains({ procs: [0], param0: [1], param1: [0] }, rows)[0].combos.map((one) => one.id), [2]);
  assert.equal(kitChains({ procs: [0], param0: [4], param1: [0] }, rows)[0].combos.length, 11);
  assert.equal(kitChains({ procs: [0], param0: [2], param1: [0] }, rows)[0].combos, undefined);
});

test("the plan (0x007fa4d0): targets in reverse packet order, windows SegDelay + i · DelayBetweenEffects, fans, combos", () => {
  const kit = { startAnimation: -1, animation: -1, effects: [], sound: 0,
    chains: [{ slot: 0, proc: 0, param1: 0, effect: row({ id: 7, segDelay: 100, segDuration: 400, delayBetweenEffects: 250.4 }),
      combos: [row({ id: 8, segDelay: 0, segDuration: 50 })] }] };
  const targets = [{ guid: 2n, point: { x: 1, y: 0, z: 0 } }, { guid: 3n, point: { x: 2, y: 0, z: 0 } }];
  const beams = planChainBeams(kit, beamAnchors(undefined), 1n, { x: 0, y: 0, z: 0 }, targets, 1000, 5000);
  assert.deepEqual(beams.map((beam) => [beam.effect.id, beam.from.guid, beam.to.guid, beam.startedAt, beam.endsAt]), [
    [7, 1n, 3n, 1100, 1500], [7, 3n, 2n, 1350, 1750], [8, 1n, 3n, 1000, 1050], [8, 3n, 2n, 1000, 1050],
  ]);
  assert.equal(beams[0].from.attachment, -1, "no visual: the caster's 0.75 height");
  assert.equal(beams[0].to.attachment, 34, "and the targets' chests");
  const fan = planChainBeams({ ...kit, chains: [{ ...kit.chains[0], combos: undefined, fan: true, persistent: true }] },
    beamAnchors(undefined), 1n, { x: 0, y: 0, z: 0 }, targets, 1000, 5000);
  assert.deepEqual(fan.map((beam) => [beam.from.guid, beam.to.guid, beam.startedAt, beam.endsAt, beam.persistent]),
    [[1n, 3n, 1000, 5000, true], [1n, 2n, 1000, 5000, true]], "fan: all from the caster; persistent: the kit's time");
});

test("beam anchors: MissileAttachment and MissileDestinationAttachment through 0x00adaa20, offsets (x, −y, z)", () => {
  assert.deepEqual(beamAnchors({ attachment: 4, dest: 1, castOffset: [1, 2, 3], impactOffset: [0, 0, 2] }), {
    from: { attachment: 22, offset: [1, -2, 3] }, to: { attachment: 34, offset: [0, -0, 2] },
  });
  assert.deepEqual(beamAnchors({ attachment: -1, dest: 19, destRaw: true }), { from: { attachment: -1 }, to: { attachment: 19 } });
});

test("joints (0x009ab2e0): round(L / AvgSegLen) + 3, JointCount + 1 with Flags 0x1, at least 2", () => {
  const beam = new LightningBeam(row({ avgSegLen: 2 }), half);
  beam.update(0, { x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 });
  assert.equal(beam.joints.length, 8, "round(5) + 2 + 1");
  beam.update(0, { x: 0, y: 0, z: 0 }, { x: 11, y: 0, z: 0 });
  assert.equal(beam.joints.length, 9, "5.5 rounds to 6 (x87, to even), + 3");
  beam.update(0, { x: 0, y: 0, z: 0 }, { x: 13, y: 0, z: 0 });
  assert.equal(beam.joints.length, 9, "6.5 rounds to 6 as well, + 3");
  const fixed = new LightningBeam(row({ flags: 0x1, jointCount: 27 }), half);
  fixed.update(0, { x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 });
  assert.equal(fixed.joints.length, 28);
  const tiny = new LightningBeam(row({ flags: 0x1, jointCount: 0 }), half);
  tiny.update(0, { x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 });
  assert.equal(tiny.joints.length, 2);
});

test("the band (0x009aa210): pinched ends, ±Width facing the eye, u = i/(n−1)·S − (phase + scroll), row alpha", () => {
  const beam = new LightningBeam(row({ width: 0.5, avgSegLen: 5 }), half);
  beam.update(0, { x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 });
  const { vertices, positions, uvs, alphas } = draw(beam, { x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 });
  assert.equal(vertices, beam.joints.length * 2);
  assert.deepEqual([...positions.slice(0, 6)], [0, 0, 0, 0, 0, 0], "the first pair pinched to the start");
  const last = (vertices - 2) * 3;
  assert.deepEqual([...positions.slice(last, last + 6)], [10, 0, 0, 10, 0, 0], "the last pair to the end");
  // A middle pair: the eye is above (+z), so the side runs along y, ±Width.
  near(positions[2 * 3 + 1] - positions[3 * 3 + 1], 1, "full width 2 · 0.5");
  near(uvs[0 * 2 + 1], 0.5, "v ½ at the pinched end");
  near(uvs[2 * 2 + 1], 0, "v 0 / 1 between");
  near(uvs[3 * 2 + 1], 1, "v 1");
  near(uvs[2 * 2] + 0.5, 1 / (beam.joints.length - 1), "u = i/(n−1) − phase (½)");
  assert.ok([...alphas.slice(0, vertices)].every((alpha) => Math.abs(alpha - 128 / 255) < 1e-6), "the row's alpha everywhere");
});

test("texture: TextureLength repeats only with Flags 0x100; the scroll is subtracted (−2: the drain beams flow back)", () => {
  const repeat = new LightningBeam(row({ flags: 0x100, textureLength: 2, avgSegLen: 5 }), half);
  repeat.update(0, { x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 });
  const a = draw(repeat, { x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 });
  near(a.uvs[(a.vertices - 2) * 2] + 0.5, 5, "10 yards / 2 = 5 repeats");
  const drain = new LightningBeam(row({ texCoordScale: -2, avgSegLen: 5 }), half);
  drain.update(0, { x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 });
  const before = draw(drain, { x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }).uvs[0];
  drain.update(0.1, { x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 });
  const after = draw(drain, { x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }).uvs[0];
  near(after - before, 0.2, "u' = u − (phase + scroll), scroll −0.2 after 0.1 s");
  near(drain.scroll, -0.2, "fmod keeps the sign");
});

test("the pulse (0x009a9490): a window fading in and out along the beam, nothing ahead of it", () => {
  const beam = new LightningBeam(row({ flags: 0x20 | 0x40, avgSegLen: 1, pulseSpeed: 10, pulseOnLength: 2, pulseFadeLength: 1 }), half);
  beam.update(0, { x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 });
  beam.update(0.6, { x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 });
  near(beam.pulse, 6, "PulseSpeed · t");
  const { alphas } = draw(beam, { x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 });
  const step = 10 / (beam.joints.length - 1);
  const alphaAt = (d) => alphas[Math.round(d / step) * 2];
  const full = 128 / 255;
  near(alphaAt(0), 0, "behind the window");
  near(alphaAt(4), full, "on");
  assert.ok(alphaAt(5.5) > 0 && alphaAt(5.5) < full, "fading out");
  near(alphaAt(8), 0, "ahead of the pulse");
  beam.update(1, { x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 });
  near(beam.pulse, 0, "past the end with 0x40: a new cycle");
});

test("flicker (Flags 0x10): on for rand(MinOn, MaxOn), then off for rand(MinOff, MaxOff), drawing nothing", () => {
  const beam = new LightningBeam(row({ flags: 0x10, minFlickerOnDuration: 0.2, maxFlickerOnDuration: 0.2,
    minFlickerOffDuration: 0.3, maxFlickerOffDuration: 0.3 }), half);
  const from = { x: 0, y: 0, z: 0 };
  const to = { x: 10, y: 0, z: 0 };
  assert.equal(beam.update(0.1, from, to), true);
  assert.equal(beam.update(0.15, from, to), false, "on ran out: off");
  assert.equal(draw(beam, from, to).vertices, 0);
  assert.equal(beam.update(0.2, from, to), false, "still off");
  assert.equal(beam.update(0.15, from, to), true, "off ran out: a new cycle, on again");
});

test("waves and arcs: zero at both ends, the arc's full height half way (bell 1 − 4(t − ½)²)", () => {
  // 10 yards over AvgSegLen 10/6: 6 + 3 = 9 joints, eight segments.
  const beam = new LightningBeam(row({ arcHeight: 2, avgSegLen: 10 / 6, minArcAngle: Math.PI / 2, maxArcAngle: Math.PI / 2 }), half);
  beam.update(0, { x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 });
  assert.equal(beam.joints.length, 9);
  const { positions } = draw(beam, { x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, { x: 5, y: -20, z: 0 });
  const lift = (pair) => (positions[pair * 6 + 2] + positions[pair * 6 + 5]) / 2;
  near(lift(4), 2, "the arc lifts the middle by ArcHeight along up (angle π/2)");
  near(lift(2), 2 * 0.75, "bell 1 − 4(¼ − ½)² = ¾ a quarter of the way");
  assert.equal(lift(0), 0, "the start stays");
  assert.equal(lift(8), 0, "and the end");
});

test("majors and minors (Flags 0x2): every JointsPerMinor·MinorsPerMajor joint placed first at MajorJointScale", () => {
  const draws = [0.75, 0.5]; // across +0.5, up 0 for every new joint
  let i = 0;
  const random = () => draws[i++ % 2];
  const beam = new LightningBeam(row({ flags: 0x1 | 0x2, jointCount: 12, jointsPerMinorJoint: 2, minorJointsPerMajorJoint: 3,
    majorJointScale: 4, minorJointScale: 2, jointOffsetRadius: 1 }), random);
  beam.update(0, { x: 0, y: 0, z: 0 }, { x: 12, y: 0, z: 0 });
  const side = { x: 0, y: 0, z: 0 };
  const up = { x: 0, y: 0, z: 0 };
  beam.place({ x: 0, y: 0, z: 0 }, { x: 12, y: 0, z: 0 }, side, up);
  const p = beam.positions;
  const offset = beam.joints[6].sx;
  near(p[6 * 3], 12 * 6 / 12, "the major at 6 on the line");
  near(p[6 * 3 + 1], side.y * offset * 4, "moved across by its offset · MajorJointScale");
  assert.equal(beam.joints.length, 13);
});

test("GxBlend: 2 alpha, 3 add, 4 mod, 5 mod2x, 6 modAdd; alpha reference 224 for 1, 1 for 2…6 (0x00ad8b7c)", () => {
  const material = new THREE.MeshBasicMaterial();
  applyBeamBlend(material, 3);
  assert.equal(material.blending, THREE.AdditiveBlending);
  near(material.alphaTest, 1 / 255, "alpha test 1");
  applyBeamBlend(material, 4);
  assert.deepEqual([material.blending, material.blendSrc, material.blendDst], [THREE.CustomBlending, THREE.DstColorFactor, THREE.ZeroFactor]);
  applyBeamBlend(material, 5);
  assert.deepEqual([material.blendSrc, material.blendDst], [THREE.DstColorFactor, THREE.SrcColorFactor]);
  applyBeamBlend(material, 6);
  assert.deepEqual([material.blendSrc, material.blendDst], [THREE.DstColorFactor, THREE.OneFactor]);
  applyBeamBlend(material, 2);
  assert.equal(material.blending, THREE.NormalBlending);
  assert.equal(lightningAlphaReference(1), 224);
  assert.equal(lightningAlphaReference(0), 0);
});
