import assert from "node:assert/strict";
import test from "node:test";

// 11.01, L16: a replay capture draws somebody aboard a ship where the live frame draws them. Since
// 11.01-E a passenger's packet glides it on the deck (WorldState's carrier glide, TransportPassengers.ts)
// rather than between two world points; the capture used to know only the world-point glide, so a
// ship's passenger in a captured scene stood at the end of its glide — up to 180 ms ahead of the
// live picture. The capture samples the carrier glide at the capture moment, on the carrier's pose
// it has just materialized, and leaves the live state alone.
import { canonicalWorldReplayJson, captureWorldReplaySnapshot } from "../dist/code/browser/BenchmarkReplay.js";
import { WorldState } from "../dist/code/world/WorldState.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";

const SELF = 2n;
const SHIP = 0x1fc0_0000_0000_0009n;
const RIDER = 3n;
const camera = { frameIndex: 0, yaw: 0.1, pitch: -0.2, distance: 21.31, view: 20, viewPitch: -0.2, zoom: 21.31,
  wallView: 50, terrainView: 50, pivotHeight: 1.7, eyeHeight: 1.4 };
const metadata = () => ({
  scenarioId: "fixture", mapId: 0, selfGuid: SELF, targetGuid: undefined, focusGuid: undefined, halfMinute: 1440,
  weather: { state: 0, intensity: 0, abrupt: false }, rngSeed: 123, frameStepMs: 100,
  expectations: { scene: "exterior", indoors: false, underwater: false, precipitation: false, rainIntensity: 0 },
});

function compose(pose, seat) {
  const cos = Math.cos(pose.orientation);
  const sin = Math.sin(pose.orientation);
  return { x: pose.x + seat.x * cos - seat.y * sin, y: pose.y + seat.x * sin + seat.y * cos, z: pose.z + seat.z };
}

/** A ship facing world +y and somebody aboard whose second packet moved them two yards along the deck. */
function world() {
  const state = new WorldState();
  state.selfGuid = SELF;
  state.move(SELF, { flags: 0, position: { x: 0, y: 0, z: 0, orientation: 0 } }, 0);
  const ship = { x: 100, y: 200, z: 5, orientation: Math.PI / 2 };
  state.move(SHIP, { flags: 0, position: { ...ship } }, 0);
  const carrier = state.objects.get(SHIP);
  carrier.typeId = 5;
  carrier.fields.set(UPDATE_FIELDS.GAMEOBJECT_BYTES_1.offset, 15 << 8);
  const seat = (x) => ({ guid: SHIP, x, y: 0, z: 2, orientation: 0, seat: 0xff });
  state.move(RIDER, { flags: 0, position: { ...compose(ship, seat(1)), orientation: ship.orientation }, transport: seat(1) }, 0);
  state.move(RIDER, { flags: 0, position: { ...compose(ship, seat(3)), orientation: ship.orientation }, transport: seat(3) }, 0);
  return { state, ship, seat };
}

const near = (a, b) => Math.abs(a - b) < 1e-9;

test("a ship's passenger is captured halfway through its glide on the deck, as the live frame draws it", () => {
  const { state, ship } = world();
  assert.ok(state.carrierGlide(RIDER), "the packet started a glide on the deck");
  const live = { ...state.objects.get(RIDER).position };
  const captured = captureWorldReplaySnapshot(state, 90, metadata(), [camera]);
  const rider = captured.objects.find((value) => value.guid === RIDER.toString(10));
  const half = compose(ship, { x: 2, y: 0, z: 2 });
  assert.ok(near(rider.position.x, half.x) && near(rider.position.y, half.y) && near(rider.position.z, half.z),
    `halfway along the deck: ${JSON.stringify(rider.position)} vs ${JSON.stringify(half)}`);
  // The live world is the capture's to read, not to move.
  assert.deepEqual(state.objects.get(RIDER).position, live);
  assert.ok(state.carrierGlide(RIDER));
  // Deterministic, and the same frame the live state would draw at that moment.
  assert.equal(canonicalWorldReplayJson(captureWorldReplaySnapshot(state, 90, metadata(), [camera])),
    canonicalWorldReplayJson(captured));
  state.updateMotions(90);
  const drawn = state.objects.get(RIDER).position;
  assert.ok(near(drawn.x, rider.position.x) && near(drawn.y, rider.position.y), "what the live frame draws");
});

test("once the glide is over the capture stands the passenger on its seat, and a seat on something else is left alone", () => {
  const { state, ship } = world();
  const after = captureWorldReplaySnapshot(state, 400, metadata(), [camera]);
  const rider = after.objects.find((value) => value.guid === RIDER.toString(10));
  const end = compose(ship, { x: 3, y: 0, z: 2 });
  assert.ok(near(rider.position.x, end.x) && near(rider.position.y, end.y), "on the packet's seat");
  // A glide whose carrier is no longer the seat's (the seat moved to another transport): not sampled.
  state.objects.get(RIDER).transport = { guid: SELF, x: 0, y: 0, z: 0, orientation: 0, seat: 0xff };
  const other = captureWorldReplaySnapshot(state, 90, metadata(), [camera]);
  const moved = other.objects.find((value) => value.guid === RIDER.toString(10));
  assert.ok(near(moved.position.x, 0) && near(moved.position.y, 0), `composed on the new carrier only: ${JSON.stringify(moved.position)}`);
});
