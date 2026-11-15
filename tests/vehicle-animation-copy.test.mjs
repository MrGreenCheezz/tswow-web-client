// 11.02 (15.11): VehicleSeat FlagsB 0x10000 — the passenger plays what its vehicle plays (Wow.exe 0x00748620, 0x007487e0,
// 0x00735820). Seat rows from the dataset's VehicleSeat.dbc: 2963 (Vehicle 332) has FlagsB 0x10000, 2903 (Vehicle 328)
// 0x10006, 3566 (Vehicle 370's first seat) none.
import assert from "node:assert/strict";
import test from "node:test";
import {
  SEAT_FLAG_B_COPIES_VEHICLE_ANIMATION, VehicleAnimationCopies, copiedVariation, seatCopiesVehicleAnimation, vehicleShownVariation,
} from "../dist/code/browser/VehicleAnimationCopy.js";

const SEAT_2963 = { id: 2963, flagsB: 0x10000 };
const SEAT_2903 = { id: 2903, flagsB: 0x10006 };
const SEAT_3566 = { id: 3566, flagsB: 0 };

test("which seats copy the vehicle's animations: FlagsB 0x10000 and a living passenger (0x007487e0)", () => {
  assert.equal(SEAT_FLAG_B_COPIES_VEHICLE_ANIMATION, 0x10000);
  assert.equal(seatCopiesVehicleAnimation(SEAT_2963, true), true);
  assert.equal(seatCopiesVehicleAnimation(SEAT_2903, true), true, "with other FlagsB bits beside it");
  assert.equal(seatCopiesVehicleAnimation(SEAT_3566, true), false);
  assert.equal(seatCopiesVehicleAnimation(SEAT_2963, false), false, "a dead passenger has its own pose again");
  assert.equal(seatCopiesVehicleAnimation(undefined, true), false);
});

const VEHICLE = 0x10n;
const PASSENGER = 0x20n;
const vehicleModel = {};
const passengerModel = {};
const shown = (animation, starts, loop = true, model = vehicleModel) => ({ animation, loop, model, starts });

test("taking the seat copies what the vehicle plays now; a new start of the vehicle's is copied once", () => {
  const copies = new VehicleAnimationCopies();
  // On reaching the seat (0x00748620): the vehicle's current animation, whatever it is.
  assert.deepEqual(copies.next(PASSENGER, VEHICLE, shown(0, 3), passengerModel), { animation: 0, loop: true });
  copies.given(PASSENGER, VEHICLE, shown(0, 3), passengerModel);
  assert.equal(copies.has(PASSENGER), true);
  assert.equal(copies.next(PASSENGER, VEHICLE, shown(0, 3), passengerModel), undefined, "the same start is not replayed");
  // The vehicle starts a one-shot (0x00735820): started on the passenger too, with its loop mode.
  assert.deepEqual(copies.next(PASSENGER, VEHICLE, shown(16, 4, false), passengerModel), { animation: 16, loop: false });
  copies.given(PASSENGER, VEHICLE, shown(16, 4, false), passengerModel);
  // The same animation started again on the vehicle is a new start.
  assert.deepEqual(copies.next(PASSENGER, VEHICLE, shown(16, 5, false), passengerModel), { animation: 16, loop: false });
});

test("a model load copies again (0x0073e840): the vehicle's or the passenger's", () => {
  const copies = new VehicleAnimationCopies();
  copies.given(PASSENGER, VEHICLE, shown(0, 1), passengerModel);
  assert.deepEqual(copies.next(PASSENGER, VEHICLE, shown(0, 1, true, {}), passengerModel), { animation: 0, loop: true }, "vehicle rebuilt");
  assert.deepEqual(copies.next(PASSENGER, VEHICLE, shown(0, 1), {}), { animation: 0, loop: true }, "passenger rebuilt");
  assert.deepEqual(copies.next(PASSENGER, 0x11n, shown(0, 1), passengerModel), { animation: 0, loop: true }, "another vehicle");
});

// 15.11 (vehicle8): 0x00735820 hands the passenger the vehicle's drawn variation (0x008266b0 +0x94) when the passenger's model
// has more variations of the animation than that index (0x008262f0), else −1 (the passenger draws its own).
test("the passenger plays the vehicle's variation when its model has that many, else its own draw", () => {
  const vehicleClips = ["v0", "v1", "v2"];
  const vehicle = vehicleClips.map((clip, variation) => ({ variation, clip, overlay: `${clip}-upper` }));
  assert.equal(vehicleShownVariation(vehicle, "v2"), 2);
  assert.equal(vehicleShownVariation(vehicle, "v1-upper"), 1, "the split cut of a variation is that variation");
  assert.equal(vehicleShownVariation(undefined, "anything"), 0, "a single sequence");
  assert.equal(vehicleShownVariation(vehicle, undefined), 0);
  const passenger = [{ variation: 0, clip: "p0" }, { variation: 1, clip: "p1" }];
  assert.equal(copiedVariation(1, passenger), "p1");
  assert.equal(copiedVariation(0, passenger), "p0");
  assert.equal(copiedVariation(2, passenger), undefined, "two variations, index 2: the passenger draws its own");
  assert.equal(copiedVariation(3, [{ variation: 0, clip: "p0" }, { variation: 3, clip: "p3" }]), undefined,
    "0x008262f0 counts them: two is not more than 3, whatever their numbers");
  assert.equal(copiedVariation(0, undefined), undefined, "one sequence: the plain start plays it");
  assert.equal(copiedVariation(1, undefined), undefined);
});

test("leaving the seat or the view forgets the copy; nothing to copy without an animation", () => {
  const copies = new VehicleAnimationCopies();
  assert.equal(copies.next(PASSENGER, VEHICLE, shown(undefined, 0), passengerModel), undefined);
  copies.given(PASSENGER, VEHICLE, shown(0, 1), passengerModel);
  copies.forget(PASSENGER);
  assert.equal(copies.has(PASSENGER), false);
  assert.deepEqual(copies.next(PASSENGER, VEHICLE, shown(0, 1), passengerModel), { animation: 0, loop: true });
  copies.given(PASSENGER, VEHICLE, shown(0, 1), passengerModel);
  copies.sweep((guid) => guid !== PASSENGER);
  assert.equal(copies.size, 0);
});
