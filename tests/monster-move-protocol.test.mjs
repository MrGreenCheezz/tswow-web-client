// 5.03: SMSG_MONSTER_MOVE — parabola, fall, facing on arrival, orientation rules, animation tier
// (docs/implementation/line-A4.ru.md, 5.03 and М-A4-1).
//
// Packets come from `monsterMovePacket` (tests/fixtures/world-packets.mjs), written field by field
// after `PacketBuilder::WriteMonsterMove` (MovementPacketBuilder.cpp:44-145). Expected numbers come
// from `MoveSpline::ComputePosition`, `computeParabolicElevation` and `computeFallElevation`
// (MoveSpline.cpp:26-77, MovementUtil.cpp:57-80), worked by hand below.
import assert from "node:assert/strict";
import test from "node:test";
import { parseMonsterMove } from "../dist/code/world/MonsterMoveProtocol.js";
import { WorldState, splineAnimationTier } from "../dist/code/world/WorldState.js";
import { monsterMovePacket } from "./fixtures/world-packets.mjs";

const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

const GUID = 0xf130000000005003n;
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-3, `${message}: ${actual} vs ${expected}`);
const line = [{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }];

function launch(packet, { orientation = 0, at = 0, position = { x: 0, y: 0, z: 0 } } = {}) {
  const state = new WorldState();
  state.move(GUID, { flags: 0, position: { ...position, orientation } }, at);
  state.startSpline(parseMonsterMove(packet), at);
  return { state, unit: state.objects.get(GUID) };
}

test("a parabola lifts the path by (Tdur − Tpassed)·a/2·Tpassed, counted from its start", () => {
  const packet = monsterMovePacket({ guid: GUID, flags: 0x800, duration: 1000, parabolic: { acceleration: 40, startMs: 0 }, path: line });
  const move = parseMonsterMove(packet);
  assert.deepEqual(move.parabolic, { acceleration: 40, startMs: 0 });
  assert.equal(move.flags, 0x800);
  const { state, unit } = launch(packet);
  near(unit.position.z, 0, "on the ground at the start");
  state.updateMotions(500);
  near(unit.position.x, 5, "halfway along");
  near(unit.position.z, 5, "a·T²/8 = 40/8 at the top");
  state.updateMotions(1000);
  near(unit.position.z, 0, "on the ground at the end");
  assert.equal(unit.motion, undefined);

  // A late start shortens the arc: 400 ms into a 800 ms arc is its top, (0.8 − 0.4)·20·0.4 = 3.2.
  const late = launch(monsterMovePacket({
    guid: GUID, flags: 0x800, duration: 1000, parabolic: { acceleration: 40, startMs: 200 }, path: line,
  }));
  late.state.updateMotions(150);
  near(late.unit.position.z, 0, "nothing before the effect starts");
  late.state.updateMotions(600);
  near(late.unit.position.z, 3.2, "Tdur is counted from the effect start");
});

test("facing is applied on arrival — angle, spot, or a target in view — and not before", () => {
  const target = 0xf130000000009999n;
  const cases = [
    { type: 4, facing: { angle: 1 }, expected: 1 },
    { type: 2, facing: { x: 10, y: 10, z: 0 }, expected: Math.PI / 2 },
    { type: 3, facing: { guid: target }, expected: -Math.PI / 2 },
  ];
  for (const { type, facing, expected } of cases) {
    const packet = monsterMovePacket({ guid: GUID, type, facing, duration: 1000, path: line });
    if (type === 3) assert.deepEqual(parseMonsterMove(packet).facing, { kind: "target", guid: target }, "a raw u64");
    const { state, unit } = launch(packet, { orientation: 2 });
    state.move(target, { flags: 0, position: { x: 10, y: -5, z: 0, orientation: 0 } }, 0);
    state.updateMotions(500);
    near(unit.position.orientation, 0, `type ${type}: along the path while moving`);
    state.updateMotions(1000);
    near(unit.position.orientation, expected, `type ${type}: facing on arrival`);
  }

  // A target out of view: nothing to turn to, so the facing stays as the path left it.
  const { state, unit } = launch(monsterMovePacket({ guid: GUID, type: 3, facing: { guid: 0x1234n }, duration: 1000, path: line }));
  state.updateMotions(1000);
  near(unit.position.orientation, 0, "no target, no turn");
});

test("a facing-only spline turns the unit without a flash of north", () => {
  // `Creature::SetFacingTo` — two equal points and the one-millisecond minimum duration.
  const spot = [{ x: 5, y: 5, z: 0 }, { x: 5, y: 5, z: 0 }];
  const { state, unit } = launch(monsterMovePacket({ guid: GUID, type: 2, facing: { x: 5, y: 10, z: 0 }, duration: 1, path: spot }),
    { orientation: 2, position: { x: 5, y: 5, z: 0 } });
  near(unit.position.orientation, 2, "unchanged on the frame it starts");
  state.updateMotions(0.5);
  near(unit.position.orientation, 2, "unchanged half-way through its millisecond");
  state.updateMotions(1);
  near(unit.position.orientation, Math.PI / 2, "towards the spot on arrival");
  assert.equal(unit.motion, undefined);
});

test("OrientationFixed keeps the start facing; Backward turns the tangent round", () => {
  const fixed = launch(monsterMovePacket({ guid: GUID, flags: 0x4000, duration: 1000, path: line }), { orientation: 1.2 });
  fixed.state.updateMotions(500);
  near(fixed.unit.position.orientation, 1.2, "a knocked-back creature faces where it did");
  const free = launch(monsterMovePacket({ guid: GUID, duration: 1000, path: line }), { orientation: 1.2 });
  free.state.updateMotions(500);
  near(free.unit.position.orientation, 0, "otherwise along the path");
  const backward = launch(monsterMovePacket({ guid: GUID, flags: 0x8000000, duration: 1000, path: line }));
  backward.state.updateMotions(500);
  near(backward.unit.position.orientation, -Math.PI, "tangent minus π");
});

test("a falling spline drops by the fall formula and stops at the path's end height", () => {
  const drop = [{ x: 0, y: 0, z: 20 }, { x: 0, y: 0, z: 0 }];
  const { state, unit } = launch(monsterMovePacket({ guid: GUID, flags: 0x200, duration: 2000, path: drop }),
    { orientation: 0.7, position: { x: 0, y: 0, z: 20 } });
  state.updateMotions(1000);
  near(unit.position.z, 20 - 19.29110527038574 / 2, "g·t²/2 after one second, not the straight line");
  near(unit.position.orientation, 0.7, "a fall keeps the facing");
  const fallTime = Math.sqrt((2 * 20) / 19.29110527038574) * 1000; // ≈ 1440 ms
  state.updateMotions(fallTime - 40);
  assert.ok(unit.position.z > 0, "not on the ground before the fall time");
  state.updateMotions(fallTime + 100);
  near(unit.position.z, 0, "on the ground after it");
  state.updateMotions(1900);
  near(unit.position.z, 0, "never below it");
});

test("the animation tier takes over at its start and outlives the spline until BYTES_1 changes", () => {
  // Wow.exe: the effect sets the unit's own tier once, when its start has passed (0x0098CA00 →
  // 0x006E9C30 → 0x0073AF00), and nothing resets it on arrival; only a BYTES_1 update rewrites it
  // (0x007167C0 copies the field's tier byte over it when they differ).
  const bytes1 = UPDATE_FIELDS.UNIT_FIELD_BYTES_1.offset;
  const packet = monsterMovePacket({ guid: GUID, flags: 0x200000, animation: { tier: 3, startMs: 500 }, duration: 1000, path: line });
  assert.deepEqual(parseMonsterMove(packet).animation, { tier: 3, startMs: 500 });
  const { state, unit } = launch(packet);
  state.setField(GUID, bytes1, 0x01000000); // the byte says Hover
  assert.equal(splineAnimationTier(unit, 400), undefined);
  assert.equal(splineAnimationTier(unit, 600), 3);
  state.updateMotions(600);
  state.updateMotions(1000);
  assert.equal(unit.motion, undefined);
  assert.equal(splineAnimationTier(unit, 1000), 3, "a landed drake stays on the ground tier after arrival");
  state.startSpline(parseMonsterMove(monsterMovePacket({ guid: GUID, duration: 1000, path: line })), 2000);
  state.updateMotions(2500);
  assert.equal(splineAnimationTier(unit, 2500), 3, "a plain path after it does not reset the tier");
  state.setField(GUID, bytes1, 0x00000000);
  state.updateMotions(2600);
  assert.equal(splineAnimationTier(unit, 2600), undefined, "a changed byte answers again");
  state.setField(GUID, bytes1, 0x01000000);
  state.updateMotions(2700);
  assert.equal(splineAnimationTier(unit, 2700), undefined, "and keeps answering when it changes back");

  // A byte changed while the effect runs wins over it, as the field callback overwrites the tier.
  const running = launch(packet);
  running.state.setField(GUID, bytes1, 0x01000000);
  running.state.updateMotions(600);
  running.state.setField(GUID, bytes1, 0x02000000);
  running.state.updateMotions(700);
  assert.equal(splineAnimationTier(running.unit, 700), undefined, "the later field change wins");
  running.state.updateMotions(1000);
  assert.equal(splineAnimationTier(running.unit, 1000), undefined);
});

test("a cycle closes on c1, for the Catmull-Rom and the linear writer alike", () => {
  const square = [{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, { x: 10, y: 10, z: 0 }, { x: 0, y: 10, z: 0 }];
  // WriteCatmullRomCyclicPath: count N−1 and c1…c(N-1); the start is c0.
  const smooth = launch(monsterMovePacket({ guid: GUID, flags: 0x2000 | 0x80000 | 0x100000, duration: 4000, path: square }));
  smooth.state.updateMotions(4000);
  near(smooth.unit.position.x, 10, "one lap ends at c1");
  near(smooth.unit.position.y, 0, "one lap ends at c1");
  // WriteLinearPath over the cyclic layout ends its path on the closing point c1 itself.
  const linear = launch(monsterMovePacket({ guid: GUID, flags: 0x80000 | 0x100000, duration: 4000, path: [...square, square[1]] }));
  assert.equal(linear.unit.motion.points.length, 5, "c0 … c3 and the closing c1, not c1 twice");
  linear.state.updateMotions(4000);
  near(linear.unit.position.x, 10, "one lap ends at c1");
  near(linear.unit.position.y, 0, "one lap ends at c1");
});

test("a stop is still a stop", () => {
  const { state, unit } = launch(monsterMovePacket({ guid: GUID, duration: 1000, path: line }));
  state.startSpline(parseMonsterMove(monsterMovePacket({ guid: GUID, type: 1, path: [{ x: 4, y: 0, z: 0 }] })), 400);
  assert.equal(unit.motion, undefined);
  assert.deepEqual({ x: unit.position.x, y: unit.position.y, z: unit.position.z }, { x: 4, y: 0, z: 0 });
});
