// 11.02 (04.11): the aim arc a steered siege engine shows (Wow.exe 0x006fda20, read from the disassembly): when it is up, how
// long it lingers, which spell it shows, and how the ribbon is laid out.
import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import {
  ARC_ALWAYS, ARC_MOUSE, ARC_PITCH, ARC_SPELL, ARC_TURN, VehicleArcOpacity, barSlotSpell, vehicleArcCause, vehicleArcPoints, vehicleArcSpell,
} from "../dist/code/browser/game/VehicleAimArc.js";
import { VehicleAimArcMesh, arcRibbonRow, arcScroll } from "../dist/code/browser/VehicleAimArcMesh.js";

const TURN = 1, PITCH = 2, MOUSE = 3;

test("what puts the arc up, by the vehicle's flags and the seat's", () => {
  assert.deepEqual(vehicleArcCause(ARC_ALWAYS, 0, false, false), { shown: true, cause: 0 });
  assert.deepEqual(vehicleArcCause(ARC_TURN, 0x100, false, false), { shown: true, cause: TURN });
  assert.equal(vehicleArcCause(ARC_TURN, 0x100 | 0x1, false, false).shown, false, "a usable seat does not count for the turn");
  assert.equal(vehicleArcCause(ARC_TURN, 0, false, false).shown, false);
  assert.deepEqual(vehicleArcCause(ARC_PITCH, 0x800, false, false), { shown: true, cause: PITCH }, "a seat with control: always");
  assert.deepEqual(vehicleArcCause(ARC_PITCH, 0, true, false), { shown: true, cause: PITCH }, "otherwise while the pitch moves");
  assert.equal(vehicleArcCause(ARC_PITCH, 0, false, false).shown, false);
  assert.deepEqual(vehicleArcCause(ARC_MOUSE, 0x200_0000, false, false), { shown: true, cause: MOUSE });
  assert.deepEqual(vehicleArcCause(ARC_SPELL, 0, false, true), { shown: true, cause: 0 });
  assert.equal(vehicleArcCause(ARC_SPELL, 0, false, false).shown, false);
  assert.equal(vehicleArcCause(0, 0xffff, true, true).shown, false, "no flag on the row: never");
});

test("a lingering arc holds, then fades over half its time, at most a second", () => {
  const opacity = new VehicleArcOpacity();
  const three = () => 3;
  assert.equal(opacity.step(1000, true, PITCH, three), 1);
  assert.equal(opacity.step(1100, false, 0, three), 1, "the 3 s begin when its cause goes");
  assert.equal(opacity.step(3000, false, 0, three), 1, "held for 3 less the fade");
  assert.ok(Math.abs(opacity.step(3600, false, 0, three) - 0.5) < 1e-9, "half way down the second's fade");
  assert.equal(opacity.step(4200, false, 0, three), 0);
  assert.equal(opacity.step(4300, false, 0, three), 0, "and stays gone");
  const short = new VehicleArcOpacity();
  short.step(0, true, TURN, () => 1);
  short.step(10, false, 0, () => 1);
  assert.equal(short.step(500, false, 0, () => 1), 1, "1 s: half of it held");
  assert.ok(Math.abs(short.step(760, false, 0, () => 1) - 0.5) < 1e-9, "and half of it fading");
  const always = new VehicleArcOpacity();
  always.step(0, true, 0, three);
  assert.equal(always.step(10, false, 0, three), 0, "nothing to linger on: gone at once");
});

test("the spell: the one in hand, the last shown, then the bar's first with a missile", () => {
  const missile = (id) => (id === 10 || id === 20 || id === 30 ? {} : undefined);
  const bar = [{ packed: (7 << 24) | 30 }, { packed: (1 << 24) | 99 }, { packed: (8 << 24) | 30 }];
  assert.equal(barSlotSpell((1 << 24) | 5), 5);
  assert.equal(barSlotSpell((0x11 << 24) | 5), 5);
  assert.equal(barSlotSpell((7 << 24) | 5), undefined, "a command");
  assert.equal(barSlotSpell((0x12 << 24) | 5), undefined);
  assert.deepEqual(vehicleArcSpell(10, 20, 30, bar, missile), { spellId: 10, armed: true }, "the cast first");
  assert.deepEqual(vehicleArcSpell(undefined, 20, 30, bar, missile), { spellId: 20, armed: true }, "the armed one");
  assert.deepEqual(vehicleArcSpell(5, undefined, 20, bar, missile), { spellId: 20, armed: false }, "a cast with no missile does not count");
  assert.deepEqual(vehicleArcSpell(undefined, undefined, undefined, bar, missile), { spellId: 30, armed: false }, "past a command and a spell with no missile");
  assert.equal(vehicleArcSpell(undefined, undefined, undefined, [], missile), undefined);
});

const MISSILE = { flags: 0, defaultPitchMin: 0.5, defaultPitchMax: 0.5, defaultSpeedMin: 10, defaultSpeedMax: 10, randomizeFacingMin: 0, randomizeFacingMax: 0, randomizePitchMin: 0, randomizePitchMax: 0, randomizeSpeedMin: 0, randomizeSpeedMax: 0, gravity: 10, maxDuration: 3, collisionRadius: 0 };
const ROW = { id: 1, flags: 0, pitchMin: 0.5, pitchMax: 0.5 };

test("the points run from the fire point to where the world stops the flight", () => {
  const fire = { x: 1, y: 2, z: 3 };
  const open = vehicleArcPoints(MISSILE, ROW, 0.5, 0.5, 0, fire, () => undefined);
  assert.deepEqual([...open.slice(0, 3)], [1, 2, 3]);
  assert.equal(open.length % 3, 0);
  assert.equal(open.length / 3, 1 + 30, "3 s at 0.1 s a step, and the fire point");
  const stopped = vehicleArcPoints(MISSILE, ROW, 0.5, 0.5, 0, fire, (from) => (from.x > 3 ? 0.5 : undefined));
  assert.ok(stopped.length < open.length);
  const lastX = stopped[stopped.length - 3];
  assert.ok(lastX > stopped[stopped.length - 6] && lastX < open[open.length - 3]);
});

const shape = (over = {}) => ({
  points: Float32Array.from([0, 0, 0, 5, 0, 1, 10, 0, 0]), facing: 0, opacity: 1, width: 2, endOpacity: 0.5, arcSpeed: 3, arcRepeat: 0.25,
  arcTexture: "a.blp", impactTexture: "b.blp", impactRadius: 4, ...over,
});

test("a row: across the facing, alpha falling to the end's, the first pair clear, U stepping by the repeat", () => {
  const first = arcRibbonRow(shape(), 0, 3, 0.75);
  assert.equal(first.alpha, 0);
  assert.equal(first.u, 0.75);
  assert.ok(Math.abs(first.sideX) < 1e-12);
  assert.equal(first.sideY, 1, "half the width to the left of north-facing east");
  const middle = arcRibbonRow(shape(), 1, 3, 0.75);
  assert.ok(Math.abs(middle.alpha - 0.75) < 1e-9);
  assert.equal(middle.u, 1);
  const last = arcRibbonRow(shape({ opacity: 0.5 }), 2, 3, 0);
  assert.ok(Math.abs(last.alpha - 0.25) < 1e-9, "the strength times the end's opacity");
  const north = arcRibbonRow(shape({ facing: Math.PI / 2 }), 1, 3, 0);
  assert.ok(Math.abs(north.sideX + 1) < 1e-9);
});

test("the scroll runs down from 1 and wraps", () => {
  assert.equal(arcScroll(0, 3), 1);
  assert.ok(Math.abs(arcScroll(0.1, 3) - 0.7) < 1e-9);
  assert.ok(Math.abs(arcScroll(0.4, 3) - 0.8) < 1e-9);
});

test("the mesh: in scene coordinates, on the ground, hidden when told", () => {
  const scene = new THREE.Scene();
  const loaded = [];
  const mesh = new VehicleAimArcMesh(scene, (path) => {
    loaded.push(path);
    return new THREE.Texture();
  });
  const group = scene.children[0];
  assert.equal(group.visible, false);
  mesh.update(shape(), 1000, () => 7);
  mesh.update(shape(), 1100, () => 7);
  assert.equal(group.visible, true);
  assert.deepEqual(loaded, ["a.blp", "b.blp"], "each texture once");
  const [ribbon, mark] = group.children;
  const at = ribbon.geometry.getAttribute("position");
  assert.deepEqual([at.getX(2), at.getY(2), at.getZ(2)], [5, 1, -1], "x, z up, −y");
  assert.equal(ribbon.geometry.drawRange.count, 12, "two quads for three points");
  assert.equal(ribbon.material.map.wrapS, THREE.RepeatWrapping);
  const ground = mark.geometry.getAttribute("position");
  assert.deepEqual([ground.getX(0), ground.getY(0), ground.getZ(0)], [6, 7, 4], "the impact's square on the ground");
  mesh.update(shape({ arcTexture: "", impactRadius: 0 }), 1200, undefined);
  assert.equal(ribbon.visible, false, "no arc texture on the row");
  assert.equal(mark.visible, false);
  mesh.hide();
  assert.equal(group.visible, false);
  mesh.dispose();
  assert.equal(scene.children.length, 0);
});
