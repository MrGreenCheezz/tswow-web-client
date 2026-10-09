import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { zoomedDistance } from "../dist/code/browser/game/CameraRig.js";
import {
  SEAT_CAMERA_FLAGS_B, VEHICLE_FLAG_CAMERA_FADE, VEHICLE_ZOOM_DISTANCE, VehicleCameraTracker, seatZoomTarget, vehicleCamera,
  vehicleCameraParams,
} from "../dist/code/browser/game/VehicleCamera.js";
import {
  VEHICLE_CATALOG_VERSION, VEHICLE_COLUMN, VEHICLE_FORMAT, VEHICLE_SEAT_COLUMN, VEHICLE_SEAT_FORMAT, vehicleCatalogFrom,
} from "../dist/code/world/VehicleDbc.js";
import { VEHICLE_SEAT_FLAGS } from "../dist/code/world/VehicleSeatModel.js";

// 11.02-G: the vehicle seat's camera (browser/game/VehicleCamera.ts). Wow.exe 3.3.5a
// (.runtime/re-2026-10-03/l1102gf3): 0x0074c0e0 switches to the vehicle distance for a seat with
// ENABLE_VEHICLE_ZOOM (0x00600590: `cameraSavedVehicleDistance`, -1 → 50 yards; the other mode's
// distance written first, 0x005ff320), applies a FlagsB 0x400 seat's own zoom, and is timed by
// VehicleCamera_C 0x0075aac0 (delays, durations); the wheel's ceiling is 50 in vehicle mode (0x006000e0).

const B = SEAT_CAMERA_FLAGS_B;
const S = VEHICLE_SEAT_FLAGS;
const SELF = 0x1n;
const ENGINE = 0xf150_7d9a_0000_0042n;
const SHIP = 0x1fc0_0000_0000_0007n;
const CREATURE = 0xf130_0000_0000_0009n;

const SIEGE = 9101;
const ZOOMY = 3101;   // ENABLE_VEHICLE_ZOOM, timed by its row's EnterPreDelay / EnterMaxDuration
const GUNNER = 3102;  // ENABLE_VEHICLE_ZOOM too, camera timing of its own (FlagsB 0x40 | 0x80)
const PLAIN = 3103;   // no camera flags at all
const CUSTOM = 3104;  // FlagsB 0x400: entering zoom 12 inside a floor of 8 and a ceiling of 20

function vehicleRow({ id, flags = 0, seats = [], yaw = 0, pitch = 0, fadeMin = 0, fadeMax = 0 }) {
  const row = [...VEHICLE_FORMAT].map((kind) => (kind === "s" ? "" : 0));
  row[VEHICLE_COLUMN.ID] = id;
  row[VEHICLE_COLUMN.Flags] = flags >>> 0;
  seats.forEach((seat, slot) => { row[VEHICLE_COLUMN.SeatID + slot] = seat; });
  row[VEHICLE_COLUMN.CameraYawOffset] = yaw;
  row[VEHICLE_COLUMN.CameraPitchOffset] = pitch;
  row[VEHICLE_COLUMN.CameraFadeDistScalarMin] = fadeMin;
  row[VEHICLE_COLUMN.CameraFadeDistScalarMax] = fadeMax;
  return row;
}

function seatRow({ id, flags = 0, flagsB = 0, enterPre = 0, enterMax = 0, exitPre = 0, exitMax = 0, camera = {} }) {
  const row = [...VEHICLE_SEAT_FORMAT].map(() => 0);
  const C = VEHICLE_SEAT_COLUMN;
  row[C.ID] = id;
  row[C.Flags] = flags >>> 0;
  row[C.FlagsB] = flagsB >>> 0;
  row[C.EnterPreDelay] = enterPre;
  row[C.EnterMaxDuration] = enterMax;
  row[C.ExitPreDelay] = exitPre;
  row[C.ExitMaxDuration] = exitMax;
  for (const [name, value] of Object.entries(camera)) row[C[name]] = value;
  return row;
}

const ANSWER = {
  version: VEHICLE_CATALOG_VERSION,
  vehicles: [vehicleRow({
    id: SIEGE, flags: VEHICLE_FLAG_CAMERA_FADE, seats: [ZOOMY, GUNNER, PLAIN, CUSTOM], yaw: 0.05, pitch: 0.25, fadeMin: 1, fadeMax: 1.5,
  })],
  seats: [
    seatRow({ id: ZOOMY, flags: S.CAN_CONTROL | S.ENABLE_VEHICLE_ZOOM, enterPre: 0.5, enterMax: 1.2, exitPre: 0, exitMax: 0 }),
    seatRow({
      id: GUNNER, flags: S.ENABLE_VEHICLE_ZOOM, flagsB: B.ENTER_TIMING | B.EXIT_TIMING, enterPre: 9, enterMax: 9, exitMax: 9,
      camera: { CameraEnteringDelay: 0.2, CameraEnteringDuration: 1, CameraExitingDelay: 0.1, CameraExitingDuration: 0.3 },
    }),
    seatRow({ id: PLAIN, enterMax: 5, exitMax: 0.1 }),
    seatRow({
      id: CUSTOM, flagsB: B.SEAT_ZOOM | B.ENTERING_ZOOM | B.ZOOM_MIN | B.ZOOM_MAX, enterMax: 1, exitMax: 2,
      camera: { CameraEnteringZoom: 12, CameraSeatZoomMin: 8, CameraSeatZoomMax: 20 },
    }),
  ],
  indicators: [],
  indicatorSeats: [],
};
const catalog = vehicleCatalogFrom(ANSWER);

/** The character, on foot or in slot `slot` of the engine (or on a ship). */
function world({ slot, carrier = ENGINE } = {}) {
  const character = { guid: SELF, typeId: 4, fields: new Map(), position: { x: 0, y: 0, z: 0, orientation: 0 } };
  if (slot !== undefined) character.transport = { guid: carrier, x: 0, y: 0, z: 0, orientation: 0, time: 0, seat: slot };
  const engine = { guid: ENGINE, typeId: 3, fields: new Map(), vehicleId: SIEGE, position: { x: 0, y: 0, z: 0, orientation: 0 } };
  const ship = { guid: SHIP, typeId: 5, fields: new Map(), position: { x: 0, y: 0, z: 0, orientation: 0 } };
  // A carrier of HighGuid::Unit with a kit: not a vehicle to the client (0x0074b8b0 wants 0xF150 or a player).
  const creature = { guid: CREATURE, typeId: 3, fields: new Map(), vehicleId: SIEGE, position: { x: 0, y: 0, z: 0, orientation: 0 } };
  return { selfGuid: SELF, objects: new Map([[SELF, character], [ENGINE, engine], [SHIP, ship], [CREATURE, creature]]) };
}

const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-6, `${message ?? ""} ${actual} vs ${expected}`);

test("11.02-G: the seat's and the vehicle's rows as the camera reads them", () => {
  const siege = catalog.vehicle(SIEGE);
  const zoomy = vehicleCameraParams(siege, catalog.seat(ZOOMY));
  assert.equal(zoomy.vehicleZoom, true);
  assert.equal(zoomy.seatZoom, undefined);
  close(zoomy.yawOffset, 0.05, "CameraYawOffset");
  close(zoomy.pitchOffset, 0.25, "CameraPitchOffset");
  assert.deepEqual(zoomy.fade, { near: 1, far: 1.5 }, "Vehicle Flags 0x80000");
  // No FlagsB 0x40/0x80: EnterPreDelay, EnterMaxDuration/ExitMaxDuration clamped to 0.5…3 s (0x0075aac0).
  close(zoomy.enterDelay, 0.5);
  close(zoomy.enterSeconds, 1.2);
  assert.equal(zoomy.exitDelay, 0);
  assert.equal(zoomy.exitSeconds, 0.5, "ExitMaxDuration 0 → 0.5");
  assert.equal(vehicleCameraParams(siege, catalog.seat(PLAIN)).enterSeconds, 3, "EnterMaxDuration 5 → 3");
  const gunner = vehicleCameraParams(siege, catalog.seat(GUNNER));
  close(gunner.enterDelay, 0.2, "FlagsB 0x40: CameraEnteringDelay");
  assert.equal(gunner.enterSeconds, 1);
  close(gunner.exitDelay, 0.1, "FlagsB 0x80: CameraExitingDelay");
  close(gunner.exitSeconds, 0.3, "…and CameraExitingDuration, unclamped");
  const custom = vehicleCameraParams(siege, catalog.seat(CUSTOM));
  assert.equal(custom.vehicleZoom, false);
  assert.deepEqual(custom.seatZoom, { min: 8, max: 20, entering: 12, enteringOut: true, enteringIn: true });
  assert.equal(vehicleCameraParams(undefined, catalog.seat(PLAIN)).fade, undefined);
  assert.equal(vehicleCameraParams({ ...siege, flags: 0 }, catalog.seat(PLAIN)).fade, undefined, "no Flags 0x80000: no fade");
  assert.equal(vehicleCameraParams(siege, catalog.seat(PLAIN)).seatZoom, undefined, "no FlagsB 0x400");
  // ENABLE_VEHICLE_ZOOM wins over the seat zoom (0x0074c0e0 tests it first).
  const both = vehicleCatalogFrom({
    ...ANSWER, seats: [seatRow({ id: 1, flags: S.ENABLE_VEHICLE_ZOOM, flagsB: B.SEAT_ZOOM | B.ZOOM_MAX, camera: { CameraSeatZoomMax: 5 } })],
  });
  assert.equal(vehicleCameraParams(undefined, both.seat(1)).seatZoom, undefined);
});

test("11.02-G: a seat's own zoom — the entering zoom, its two forbidden directions, the floor and the ceiling", () => {
  const zoom = (fields) => ({ min: undefined, max: undefined, entering: undefined, enteringOut: true, enteringIn: true, ...fields });
  assert.deepEqual(seatZoomTarget(zoom({ entering: 12 }), 25), { distance: 12, floor: undefined, ceiling: undefined });
  assert.deepEqual(seatZoomTarget(zoom({ entering: 12 }), 5), { distance: 12, floor: undefined, ceiling: undefined });
  assert.equal(seatZoomTarget(zoom({ entering: 12, enteringOut: false }), 5).distance, 5, "0x1000: never out to it");
  assert.equal(seatZoomTarget(zoom({ entering: 12, enteringIn: false }), 25).distance, 25, "0x2000: never in to it");
  assert.deepEqual(seatZoomTarget(zoom({ min: 8, max: 20 }), 25), { distance: 20, floor: 8, ceiling: 20 });
  assert.deepEqual(seatZoomTarget(zoom({ min: 8, max: 20 }), 3), { distance: 8, floor: 8, ceiling: 20 });
  // A ceiling past 50 yards comes from the entering zoom when the seat names none.
  assert.deepEqual(seatZoomTarget(zoom({ entering: 60 }), 10), { distance: 60, floor: undefined, ceiling: 60 });
  assert.deepEqual(seatZoomTarget(zoom({ entering: 0, max: 0 }), 15), { distance: 0, floor: undefined, ceiling: 0 }, "a first-person seat");
});

test("11.02-G: a seat with ENABLE_VEHICLE_ZOOM — after its delay the camera glides out to 50 yards and the wheel may follow", () => {
  const tracker = new VehicleCameraTracker();
  const rig = { distance: 12 };
  tracker.update(world(), catalog, rig, 0);
  assert.equal(rig.distance, 12);
  tracker.update(world({ slot: 0 }), catalog, rig, 1000);
  tracker.update(world({ slot: 0 }), catalog, rig, 1400);
  assert.equal(rig.distance, 12, "EnterPreDelay 0.5 s");
  assert.equal(tracker.vehicleMode, false);
  tracker.update(world({ slot: 0 }), catalog, rig, 1500);
  assert.equal(tracker.vehicleMode, true);
  close(rig.distance, 12);
  tracker.update(world({ slot: 0 }), catalog, rig, 2100);
  close(rig.distance, 31, "half of 1.2 s: half of the way, linear");
  tracker.update(world({ slot: 0 }), catalog, rig, 2700);
  assert.equal(rig.distance, VEHICLE_ZOOM_DISTANCE, "cameraSavedVehicleDistance -1 means 50 yards");
  // The wheel: 50 yards whatever the player's own ceiling (30 here) says (0x006000e0).
  assert.equal(tracker.zoom(50, 400, 30), 50);
  close(tracker.zoom(40, 100, 30), zoomedDistance(40, 100, 50));
  assert.equal(zoomedDistance(40, 100, 30), 30, "outside a vehicle it would stop at 30");
});

test("11.02-G: leaving gives the ordinary distance back and remembers the vehicle's; re-entering returns to it", () => {
  const tracker = new VehicleCameraTracker();
  const rig = { distance: 12 };
  tracker.update(world({ slot: 0 }), catalog, rig, 0);
  tracker.update(world({ slot: 0 }), catalog, rig, 500);
  tracker.update(world({ slot: 0 }), catalog, rig, 5000);
  assert.equal(rig.distance, 50);
  rig.distance = tracker.zoom(rig.distance, -300, 30);
  const inVehicle = rig.distance;
  assert.ok(inVehicle < 50 && inVehicle > 25, `the wheel in the vehicle: ${inVehicle}`);
  tracker.update(world({ slot: 0 }), catalog, rig, 5100);
  assert.equal(rig.distance, inVehicle, "the finished glide leaves the wheel alone");
  tracker.update(world(), catalog, rig, 6000);
  assert.equal(tracker.vehicleMode, false, "ExitPreDelay 0: at once");
  tracker.update(world(), catalog, rig, 6250);
  close(rig.distance, inVehicle + (12 - inVehicle) / 2, "ExitMaxDuration 0 → 0.5 s");
  tracker.update(world(), catalog, rig, 6500);
  assert.equal(rig.distance, 12, "cameraSavedDistance");
  close(tracker.savedVehicleDistance, inVehicle, "cameraSavedVehicleDistance kept");
  tracker.update(world({ slot: 0 }), catalog, rig, 7000);
  tracker.update(world({ slot: 0 }), catalog, rig, 7500);
  tracker.update(world({ slot: 0 }), catalog, rig, 9000);
  close(rig.distance, inVehicle, "back to the vehicle's own distance");
});

test("11.02-G: the wheel during a glide takes over; a seat switch between two zoom seats moves nothing", () => {
  const tracker = new VehicleCameraTracker();
  const rig = { distance: 10 };
  tracker.update(world({ slot: 0 }), catalog, rig, 0);
  tracker.update(world({ slot: 0 }), catalog, rig, 500);
  tracker.update(world({ slot: 0 }), catalog, rig, 800);
  assert.ok(rig.distance > 10 && rig.distance < 50);
  // Review: the vehicle distance's glide is not locked (0x00600590 calls 0x005ffa60 itself): the wheel answers.
  assert.equal(tracker.zoom(rig.distance, -300, 30), zoomedDistance(rig.distance, -300, 50));
  rig.distance = 18;
  tracker.update(world({ slot: 0 }), catalog, rig, 900);
  tracker.update(world({ slot: 0 }), catalog, rig, 3000);
  assert.equal(rig.distance, 18, "the player's number stays");
  tracker.update(world({ slot: 1 }), catalog, rig, 4000);
  // Review: GUNNER has FlagsB 0x40, so even a switch waits its CameraEnteringDelay of 0.2 s (0x0075aac0).
  tracker.update(world({ slot: 1 }), catalog, rig, 4200);
  assert.equal(tracker.appliedSeat?.seatId, GUNNER, "a switch waits only for a FlagsB 0x40 seat's CameraEnteringDelay");
  tracker.update(world({ slot: 1 }), catalog, rig, 6000);
  assert.equal(rig.distance, 18, "still the vehicle distance: no switch, no glide");
  // Leaving the gunner's seat: CameraExitingDelay 0.1 s, then CameraExitingDuration 0.3 s — but the
  // distance switch never takes less than 0.5 s (0x00600590).
  tracker.update(world(), catalog, rig, 7000);
  assert.equal(tracker.vehicleMode, true, "the exit delay first");
  tracker.update(world(), catalog, rig, 7100);
  tracker.update(world(), catalog, rig, 7350);
  close(rig.distance, 14, "half of 0.5 s from 18 back to 10");
  tracker.update(world(), catalog, rig, 7600);
  assert.equal(rig.distance, 10);
});

test("11.02-G: a seat's own zoom — glides to the entering zoom, bounds the wheel, and gives the old distance back", () => {
  const tracker = new VehicleCameraTracker();
  const rig = { distance: 25 };
  tracker.update(world({ slot: 3 }), catalog, rig, 0);
  tracker.update(world({ slot: 3 }), catalog, rig, 500);
  close(rig.distance, 18.5, "half of EnterMaxDuration 1 s from 25 to 12");
  tracker.update(world({ slot: 3 }), catalog, rig, 2000);
  assert.equal(rig.distance, 12);
  assert.equal(tracker.zoom(12, -3000, 30), 8, "FlagsB 0x4000: the floor");
  assert.equal(tracker.zoom(12, 3000, 30), 20, "FlagsB 0x8000: the ceiling");
  tracker.update(world(), catalog, rig, 3000);
  tracker.update(world(), catalog, rig, 4000);
  close(rig.distance, 18.5, "half of ExitMaxDuration 2 s on the way back");
  tracker.update(world(), catalog, rig, 6000);
  assert.equal(rig.distance, 25, "camera+0x2d0 given back");
  for (const step of [-3000, -120, 120, 3000]) assert.equal(tracker.zoom(16, step, 30), zoomedDistance(16, step, 30));
});

// ---- review of 11.02-G/F3 (03.10) ----------------------------------------------------------------

test("11.02-G review: a seat switch waits for CameraEnteringDelay only into a FlagsB 0x40 seat (0x0075aac0)", () => {
  // 0x0075aac0: FlagsB 0x40 takes CameraEnteringDelay for every entering passenger state (1 from no seat,
  // 2 a switch); without it state 1 waits EnterPreDelay and state 2 nothing.
  const tracker = new VehicleCameraTracker();
  const rig = { distance: 10 };
  tracker.update(world({ slot: 0 }), catalog, rig, 0);
  tracker.update(world({ slot: 0 }), catalog, rig, 500);
  assert.equal(tracker.appliedSeat?.seatId, ZOOMY, "EnterPreDelay 0.5 s from no seat");
  tracker.update(world({ slot: 1 }), catalog, rig, 1000);
  assert.equal(tracker.appliedSeat?.seatId, ZOOMY, "GUNNER: FlagsB 0x40 — CameraEnteringDelay 0.2 s on a switch too");
  tracker.update(world({ slot: 1 }), catalog, rig, 1199);
  assert.equal(tracker.appliedSeat?.seatId, ZOOMY);
  tracker.update(world({ slot: 1 }), catalog, rig, 1200);
  assert.equal(tracker.appliedSeat?.seatId, GUNNER);
  tracker.update(world({ slot: 0 }), catalog, rig, 1500);
  assert.equal(tracker.appliedSeat?.seatId, ZOOMY, "back to a seat without 0x40: no EnterPreDelay on a switch");
});

test("11.02-G review: a seat's own zoom and its give-back hold the wheel until they end (0x005ffb70 lock)", () => {
  // 0x0074c0e0 starts both glides with 0x005ffb70(…, 1), which sets camera+0x9c bit 0x40; the zoom motions
  // 0x005ff950/0x005ffa60 — what Lua CameraZoomIn/CameraZoomOut (0x006017e0/0x00601840) call — return at
  // once while it is set, and 0x006000e0 clears it when the motion ends. The vehicle distance's glide
  // (0x00600590 → 0x005ffa60 directly) sets no lock: see "the wheel during a glide takes over".
  const tracker = new VehicleCameraTracker();
  const rig = { distance: 25 };
  tracker.update(world({ slot: 3 }), catalog, rig, 0);
  tracker.update(world({ slot: 3 }), catalog, rig, 500);
  close(rig.distance, 18.5);
  for (const step of [-3000, -120, 120, 3000]) assert.equal(tracker.zoom(rig.distance, step, 30), rig.distance, `entering, ${step}`);
  tracker.update(world({ slot: 3 }), catalog, rig, 1000);
  assert.equal(rig.distance, 12);
  assert.equal(tracker.zoom(12, 3000, 30), 20, "the glide over: the wheel again, inside the seat's bounds");
  tracker.update(world(), catalog, rig, 2000);
  tracker.update(world(), catalog, rig, 3000);
  close(rig.distance, 18.5, "half of ExitMaxDuration 2 s");
  for (const step of [-3000, 3000]) assert.equal(tracker.zoom(rig.distance, step, 30), rig.distance, `the give-back, ${step}`);
  tracker.update(world(), catalog, rig, 4000);
  assert.equal(rig.distance, 25);
  assert.equal(tracker.zoom(25, -120, 30), zoomedDistance(25, -120, 30), "and free once it ends");
});

test("11.02-G review: from a seat's own zoom to the vehicle distance and out — camera+0x2d0 is the distance saved (0x005ff320)", () => {
  // 0x005ff320 writes camera+0x2d0 while 0x9c bit 0x20 holds a seat's prior distance, into the CVar of the
  // mode being left; the ENABLE_VEHICLE_ZOOM branch of 0x0074c0e0 leaves that bit set, so leaving the vehicle
  // writes it into cameraSavedVehicleDistance as well, switches without a glide and glides back to it.
  const tracker = new VehicleCameraTracker();
  const rig = { distance: 25 };
  tracker.update(world({ slot: 3 }), catalog, rig, 0);
  tracker.update(world({ slot: 3 }), catalog, rig, 2000);
  assert.equal(rig.distance, 12, "the seat's entering zoom");
  tracker.update(world({ slot: 0 }), catalog, rig, 3000);
  assert.equal(tracker.vehicleMode, true, "a switch: at once");
  tracker.update(world({ slot: 0 }), catalog, rig, 3600);
  close(rig.distance, 31, "12 → 50 over 1.2 s");
  tracker.update(world({ slot: 0 }), catalog, rig, 5000);
  assert.equal(rig.distance, 50);
  tracker.update(world(), catalog, rig, 6000);
  assert.equal(tracker.vehicleMode, false);
  close(tracker.savedVehicleDistance, 25, "camera+0x2d0, not the 50 yards the camera stood at");
  tracker.update(world(), catalog, rig, 6250);
  close(rig.distance, 37.5, "the give-back over ExitMaxDuration 0 → 0.5 s");
  tracker.update(world(), catalog, rig, 7000);
  assert.equal(rig.distance, 25);
  tracker.update(world({ slot: 0 }), catalog, rig, 8000);
  tracker.update(world({ slot: 0 }), catalog, rig, 8500);
  tracker.update(world({ slot: 0 }), catalog, rig, 9000);
  assert.equal(tracker.vehicleMode, true);
  assert.equal(rig.distance, 25, "cameraSavedVehicleDistance 25: nowhere to glide");
});

test("11.02-G: no tables, no seat, a ship, a seat without camera flags — the camera is not touched", () => {
  for (const [label, state, tables] of [
    ["no tables", world({ slot: 0 }), undefined],
    ["on foot", world(), catalog],
    ["on a ship", world({ slot: 0, carrier: SHIP }), catalog],
    ["on a creature's kit", world({ slot: 0, carrier: CREATURE }), catalog],
    ["a plain seat", world({ slot: 2 }), catalog],
  ]) {
    const tracker = new VehicleCameraTracker();
    const rig = { distance: 17.5 };
    for (let frame = 0; frame <= 100; frame++) tracker.update(state, tables, rig, frame * 100);
    assert.equal(rig.distance, 17.5, label);
    assert.equal(tracker.vehicleMode, false, label);
    for (const step of [-3000, -120, 0, 120, 3000]) {
      for (const distance of [0, 3.5, 17.5, 30]) {
        assert.equal(tracker.zoom(distance, step, 30), zoomedDistance(distance, step, 30), `${label}: ${distance} ${step}`);
      }
    }
  }
});

test("11.02-G: the seat is looked up when the transport block changes, not every frame", () => {
  let lookups = 0;
  const counting = new Proxy(catalog, {
    get(target, name) {
      const value = Reflect.get(target, name, target);
      if (name !== "seatInSlot") return typeof value === "function" ? value.bind(target) : value;
      return (...args) => {
        lookups++;
        return value.apply(target, args);
      };
    },
  });
  const tracker = new VehicleCameraTracker();
  const rig = { distance: 12 };
  const seated = world({ slot: 0 });
  for (let frame = 0; frame < 200; frame++) {
    // WorldState replaces the transport block's object with every movement update: the values decide.
    seated.objects.get(SELF).transport = { ...seated.objects.get(SELF).transport };
    tracker.update(seated, counting, rig, frame * 16);
  }
  assert.equal(lookups, 1);
  const first = tracker.appliedSeat;
  tracker.update(seated, counting, rig, 5000);
  assert.equal(tracker.appliedSeat, first, "the same params object");
  tracker.update(world({ slot: 1 }), counting, rig, 5100);
  assert.equal(lookups, 2, "a new seat byte is looked up once more");
});

test("11.02-G: the hooks — Loop.ts updates the page's tracker before the boom, Controls.ts asks it about the wheel", () => {
  const loop = readFileSync(new URL("../src/browser/game/Loop.ts", import.meta.url), "utf8");
  const controls = readFileSync(new URL("../src/browser/input/Controls.ts", import.meta.url), "utf8");
  const update = loop.indexOf("vehicleCamera.update(world.state, vehicleCatalog(), game.camera, now)");
  assert.ok(update > 0, "Loop.ts updates it");
  assert.ok(loop.lastIndexOf("11.02-GF3", update) > loop.lastIndexOf("\n", update - 200), "marked");
  assert.ok(update < loop.indexOf("advanceCameraView(position, world.mapId, elapsed, subject)"), "before the boom is scanned");
  const zoom = controls.slice(controls.indexOf("function zoomCamera("), controls.indexOf("function zoomCamera(") + 400);
  assert.ok(zoom.includes("vehicleCamera.zoom(game.camera.distance, step, cameraMaxDistance())"), "the wheel asks it");
  assert.ok(vehicleCamera instanceof VehicleCameraTracker);
});

// ---- the real dataset ----------------------------------------------------------------------------

const DATASET_DBC = "F:/tswowRoot/tswow-install/modules/default/datasets/dataset/dbc";
const haveDataset = existsSync(`${DATASET_DBC}/Vehicle.dbc`) && existsSync(`${DATASET_DBC}/VehicleSeat.dbc`);

test("11.02-G: the dataset — the siege engine's seats zoom out to the vehicle distance, six seats zoom on their own", { skip: !haveDataset && "no dataset DBCs on this machine" }, async () => {
  const { loadVehicles } = await import("../dist/code/gateway/VehicleMetadata.js");
  const answer = await loadVehicles(DATASET_DBC);
  const real = vehicleCatalogFrom(JSON.parse(JSON.stringify(answer)));
  const engine = real.vehicle(117);
  const driver = vehicleCameraParams(engine, real.seat(1648));
  assert.equal(driver.vehicleZoom, true, "the Siege Engine's driver: ENABLE_VEHICLE_ZOOM");
  assert.deepEqual([driver.yawOffset, driver.pitchOffset], [0, 0]);
  assert.equal(driver.enterSeconds, 1.5, "EnterMaxDuration 1.5");
  assert.equal(driver.exitSeconds, 1, "ExitMaxDuration 1");
  assert.equal(vehicleCameraParams(real.vehicle(116), real.seat(1643)).vehicleZoom, true, "its gunner too");
  const turret = vehicleCameraParams(real.vehicle(116), real.seat(1643));
  assert.ok(Math.abs(turret.yawOffset - 0.0524) < 1e-4, "the turret's CameraYawOffset");
  assert.ok(Math.abs(turret.pitchOffset - 0.2618) < 1e-4, "…and CameraPitchOffset");
  assert.deepEqual(turret.fade, { near: 1, far: 1.5 });
  const C = VEHICLE_SEAT_COLUMN;
  let zooming = 0;
  const own = [];
  for (const row of answer.seats) {
    const params = vehicleCameraParams(undefined, real.seat(row[C.ID]));
    if (params.vehicleZoom) zooming++;
    if (params.seatZoom) own.push(row[C.ID]);
  }
  assert.equal(zooming, 100, "seats with ENABLE_VEHICLE_ZOOM");
  assert.deepEqual(own.sort((a, b) => a - b), [1723, 2229, 2238, 2325, 2363, 7727], "FlagsB 0x400");
  assert.deepEqual(seatZoomTarget(vehicleCameraParams(undefined, real.seat(2229)).seatZoom, 15), { distance: 4, floor: 4, ceiling: undefined });
  assert.deepEqual(seatZoomTarget(vehicleCameraParams(undefined, real.seat(7727)).seatZoom, 15), { distance: 0, floor: undefined, ceiling: 0 },
    "a first-person seat");
  assert.equal(seatZoomTarget(vehicleCameraParams(undefined, real.seat(2325)).seatZoom, 15).distance, 15, "0x2000: not in to 5");
  const timed = vehicleCameraParams(undefined, real.seat(1723));
  assert.deepEqual([timed.enterDelay, timed.enterSeconds, timed.exitSeconds], [0, 2, 1.3], "FlagsB 0x40 without 0x80");
});
