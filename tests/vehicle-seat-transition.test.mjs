// 11.02 (26.10): a passenger's way into and out of its seat (Wow.exe VehiclePassenger_C 0x00749aa0, 0x0074a200,
// 0x00747d70, 0x0074a7f0): which seats arc, the pre-delay, the motion's duration and arc, the eased progress, and the
// renderer holding the node at the start, then carrying it along the arc to where the seat put it.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as THREE from "three";
import {
  SEAT_TRANSITION_FLAGS, VehicleSeatTransitions, seatTransitionArc, seatTransitionArcs, seatTransitionBlend,
  seatTransitionDelay, seatTransitionMotion,
} from "../dist/code/browser/VehicleSeatTransition.js";

const F = SEAT_TRANSITION_FLAGS;
// Seat 305 of the dataset: speed 7, gravity 19.29, 0.6…1 s, arc 1.5…4 yards.
const seat = (fields = {}) => ({
  flags: F.ENTER | F.EXIT_VOLUNTARY,
  enterPreDelay: 0, enterSpeed: 7, enterGravity: 19.29, enterMinDuration: 0.6, enterMaxDuration: 1,
  enterMinArcHeight: 1.5, enterMaxArcHeight: 4,
  exitPreDelay: 0, exitSpeed: 7, exitGravity: 19.29, exitMinDuration: 0.6, exitMaxDuration: 1,
  exitMinArcHeight: 1.5, exitMaxArcHeight: 4,
  ...fields,
});
const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-6, `${message} ${actual} vs ${expected}`);

test("which seats arc: Flags 0x1 with EnterSpeed in, Flags 0x8 or 0x8000 with ExitSpeed out", () => {
  assert.equal(seatTransitionArcs(seat(), "enter"), true);
  assert.equal(seatTransitionArcs(seat({ flags: 0 }), "enter"), false, "no Flags 0x1");
  assert.equal(seatTransitionArcs(seat({ enterSpeed: 0 }), "enter"), false, "no EnterSpeed");
  assert.equal(seatTransitionArcs(seat(), "exit"), true);
  assert.equal(seatTransitionArcs(seat({ flags: F.EXIT_FORCED }), "exit"), true);
  assert.equal(seatTransitionArcs(seat({ flags: F.ENTER }), "exit"), false);
  assert.equal(seatTransitionDelay(seat({ enterPreDelay: 30 }), "enter"), 10, "at most 10 s");
});

test("the motion: distance over speed held to Min…MaxDuration, the arc's top held to Min…MaxArcHeight", () => {
  const motion = seatTransitionMotion(seat(), "enter", 5);
  close(motion.total, 5 / 7, "5 yards at 7 a second");
  close(seatTransitionArc(motion, 0.5), 1.5, "the top raised to MinArcHeight");
  assert.equal(seatTransitionArc(motion, 0), 0);
  assert.equal(seatTransitionMotion(seat(), "enter", 1).total, 0.6, "MinDuration");
  assert.equal(seatTransitionMotion(seat(), "enter", 50).total, 1, "MaxDuration");
  assert.equal(seatTransitionMotion(seat({ enterMaxDuration: 0, enterMinDuration: 0 }), "enter", 50).total, 1.5, "MaxDuration 0 is 1.5 s");
  const flat = seatTransitionMotion(seat({ enterGravity: 0, enterMinArcHeight: 0, enterMaxArcHeight: 0 }), "enter", 5);
  assert.equal(seatTransitionArc(flat, 0.5), 0, "no gravity, no arc");
  const lifted = seatTransitionMotion(seat({ enterGravity: 0 }), "enter", 5);
  close(seatTransitionArc(lifted, 0.5), 1.5, "a gravity of 0 with a minimum arc is 0.1, scaled up to it");
});

test("the progress eases by the seat's flags", () => {
  assert.equal(seatTransitionBlend(seat(), "enter", 0.25, 1), 0.25, "linear");
  assert.equal(seatTransitionBlend(seat({ flags: F.ENTER_EASE_IN }), "enter", 0.5, 1), 0.25, "in: t²");
  assert.equal(seatTransitionBlend(seat({ flags: F.ENTER_EASE_OUT }), "enter", 0.5, 1), 0.75, "out");
  close(seatTransitionBlend(seat({ flags: F.ENTER_EASE_IN | F.ENTER_EASE_OUT }), "enter", 0.25, 1), 0.5 - Math.cos(Math.PI / 4) / 2, "both");
  assert.equal(seatTransitionBlend(seat({ flags: F.EXIT_EASE_IN }), "exit", 0.5, 1), 0.25, "out uses 0x80");
});

test("the renderer's node: held at the start through the pre-delay, along the arc, then left on the seat", () => {
  const transitions = new VehicleSeatTransitions();
  const node = new THREE.Object3D();
  node.position.set(0, 0, 0);
  node.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.5);
  const boarding = seat({ enterPreDelay: 0.5 });
  transitions.begin(1n, undefined, boarding, node, 1000);
  const place = () => { node.position.set(5, 0, 0); node.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), 1.5); return node; };
  transitions.apply(() => place(), 1200);
  assert.deepEqual(node.position.toArray(), [0, 0, 0], "the pre-delay holds it where it was");
  const total = 5 / 7;
  transitions.apply(() => place(), 1500 + total * 500);
  close(node.position.x, 2.5, "half way");
  close(node.position.y, 1.5, "at the top of the arc");
  close(new THREE.Euler().setFromQuaternion(node.quaternion, "YXZ").y, 1, "the facing half way too");
  transitions.apply(() => place(), 1500 + total * 1000 + 1);
  assert.deepEqual(node.position.toArray(), [5, 0, 0], "over: where the seat put it");
  assert.equal(transitions.size, 0);
  transitions.begin(1n, seat({ flags: 0 }), undefined, node, 3000);
  assert.equal(transitions.size, 0, "a seat without the exit flags lets go at once");
  transitions.begin(1n, undefined, boarding, node, 3000);
  transitions.apply(() => undefined, 3100);
  assert.equal(transitions.size, 0, "a unit no longer drawn ends it");
});

test("a start further than 60 yards is not a boarding", () => {
  const transitions = new VehicleSeatTransitions();
  const node = new THREE.Object3D();
  transitions.begin(1n, undefined, seat(), node, 0);
  transitions.apply(() => { node.position.set(100, 0, 0); return node; }, 10);
  assert.deepEqual(node.position.toArray(), [100, 0, 0]);
  assert.equal(transitions.size, 0);
});

test("the renderer starts a transition when a drawn unit's seat changes, and applies them after the seat pass", async () => {
  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  assert.match(source, /if \(unit\.seatTracked === true\) \{\s+this\.#seatTransitions\.begin\(object\.guid, unit\.seatedRow, seatNow, unit\.node, now\);[\s\S]{0,900}unit\.node\.position\.set\(position\.x, position\.z, -position\.y\);/);
  assert.match(source, /this\.#vehiclePassengers\.place\([^\n]*\n[^\n]*\n\s+this\.#seatTransitions\.apply\(this\.#seatTransitionNode, now\);/);
});

test("2.11: scenery emitters hang from its bones or its node, never from the world's origin", async () => {
  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  assert.match(source, /if \(rendered\.skinned\) entry\.posed = rendered;\s+else entry\.visual = rendered\.visual \?\? rendered\.node;/);
});

test("6.40: a ring in the air stays flat; near the ground it still follows it", async () => {
  const { buildSelectionRingGeometry, updateSelectionRing, SELECTION_RING_ALOFT } = await import("../dist/code/browser/WorldRenderer3D.js");
  const geometry = buildSelectionRingGeometry();
  const wavy = (x) => 100 + (x > 0 ? 1 : 0);
  const heights = () => {
    const position = geometry.getAttribute("position");
    const out = new Set();
    for (let index = 0; index < position.count; index++) if (position.getY(index) !== 0) out.add(position.getY(index).toFixed(1));
    return out;
  };
  updateSelectionRing(geometry, { x: 0.5, y: 0, z: 100 }, 2, wavy);
  assert.ok(heights().size > 1, "on the ground it lies on the ground");
  updateSelectionRing(geometry, { x: 0.5, y: 0, z: 101 + SELECTION_RING_ALOFT + 1 }, 2, wavy);
  assert.equal(heights().size, 1, "aloft it is flat");
});

test("the pose on the way: EnterAnimStart then EnterAnimLoop in, ExitAnimStart then ExitAnimLoop out, each a pose of its own", async () => {
  const { vehicleSeatTransitionPose, vehiclePassengerSeatPose, vehicleSeatTransition } = await import("../dist/code/browser/VehicleSeatPose.js");
  const row = {
    ...seat(), id: 305, rideAnimStart: -1, rideAnimLoop: 91, rideUpperAnimStart: -1, rideUpperAnimLoop: -1,
    enterAnimStart: 37, enterAnimLoop: 38, exitAnimStart: 39, exitAnimLoop: 40, flags: F.ENTER | F.EXIT_VOLUNTARY | 0x2,
  };
  const enter = vehicleSeatTransitionPose(row, "enter");
  assert.deepEqual([...enter.wanted], [38]);
  assert.equal(enter.start, 37);
  const exit = vehicleSeatTransitionPose(row, "exit");
  assert.deepEqual([...exit.wanted], [40]);
  assert.equal(exit.start, 39);
  const seated = vehiclePassengerSeatPose(row);
  assert.notEqual(enter.id, seated.id);
  assert.equal(vehicleSeatTransition(undefined, enter), 37, "boarding plays EnterAnimStart");
  assert.equal(vehicleSeatTransition(seated, exit), 39, "leaving plays ExitAnimStart");
  assert.deepEqual([...vehicleSeatTransitionPose({ ...row, flags: 0 }, "exit").wanted], [], "no exit flags: the ordinary pose");
  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  assert.match(source, /seatTransition !== undefined \? vehicleSeatTransitionPose\(seatTransition\.seat, seatTransition\.kind\)/);
});

test("a way out past a quarter turn leaves the node's facing to be written by its y alone (04.11, a catapult left the model turning backwards)", () => {
  const transitions = new VehicleSeatTransitions();
  const node = new THREE.Object3D();
  node.rotation.y = 2.7;
  transitions.begin(1n, seat(), undefined, node, 0);
  node.position.set(5, 0, 0);
  node.rotation.y = 2.7;
  transitions.apply(() => node, 100);
  assert.equal(transitions.size, 1);
  assert.equal(node.rotation.x, 0);
  assert.equal(node.rotation.z, 0);
  // The frame after it is over, as `#drawUnit` writes it.
  node.rotation.y = 1;
  const ahead = new THREE.Vector3(1, 0, 0).applyQuaternion(node.quaternion);
  assert.ok(Math.abs(Math.atan2(-ahead.z, ahead.x) - 1) < 1e-6, `faces ${Math.atan2(-ahead.z, ahead.x)}`);
});
