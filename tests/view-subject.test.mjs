import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { game } from "../dist/code/browser/game/Context.js";
import {
  ViewSubjectTracker, farSightHoldsBody, viewIsOut, viewSubject, viewSubjectIn, viewSubjectPosition,
} from "../dist/code/browser/game/ViewSubject.js";
import { FarSightLatch, FarSightLink, buildFarSight, farSightGuid } from "../dist/code/world/FarSight.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import {
  CAMERA_DEFAULT_DISTANCE, CAMERA_DEFAULT_EYE_HEIGHT, CAMERA_DEFAULT_PITCH, CAMERA_DEFAULT_PIVOT_HEIGHT,
  SimpleScene, createCamera, projectPoint,
} from "../dist/code/browser/SimpleScene.js";
import { advanceCameraFrame } from "../dist/code/browser/game/CameraRig.js";
import { CollisionMesh, CollisionWorld } from "../dist/code/browser/game/Collision.js";
import { inSightFromCamera } from "../dist/code/browser/game/Targeting.js";
import { resolveGroundTarget } from "../dist/code/browser/game/GroundTarget.js";
import {
  advancePhysics, beginHeld, forgetMovementState, movementBlocked, releaseAllInput, turnCharacterBy,
} from "../dist/code/browser/input/Movement.js";

// 11.02-I: the camera, the clicks, the reticle and the plates are built from the view subject — the
// object PLAYER_FARSIGHT names once it is in view (a possessed unit, a far sight eye), else the
// character — and CMSG_FAR_SIGHT is voted as Wow.exe 0x006e2880 votes it.

const SELF = 0x1n;
const PET = 0xf140_7d9a_0000_0042n;
const EYE = 0xf100_0004_d200_0077n;
const OTHER = 0x0000_0000_0000_0009n;
const MOB = 0xf130_0000_0000_0055n;
const FARSIGHT = UPDATE_FIELDS.PLAYER_FARSIGHT.offset;

const low = (guid) => Number(guid & 0xffff_ffffn);
const high = (guid) => Number(guid >> 32n);

/** An object of the shape `WorldState` keeps; `typeId` 3 a creature, 4 a player, 6 a DynamicObject. */
function object(guid, typeId, x = 0, y = 0, orientation = 0) {
  return { guid, typeId, movementFlags: 0, position: { x, y, z: 0, orientation }, fields: new Map() };
}

function setFarSight(character, guid) {
  if (guid === undefined) {
    character.fields.delete(FARSIGHT);
    character.fields.delete(FARSIGHT + 1);
    return;
  }
  character.fields.set(FARSIGHT, low(guid));
  character.fields.set(FARSIGHT + 1, high(guid));
}

function world(objects, { farsight, controlled } = {}) {
  const map = new Map(objects.map((entry) => [entry.guid, entry]));
  const character = map.get(SELF);
  if (character) setFarSight(character, farsight);
  return { state: { selfGuid: SELF, objects: map }, controlledGuid: controlled };
}

test("11.02-I: the subject is the PLAYER_FARSIGHT object once it is in view, else the character", () => {
  const self = object(SELF, 4);
  const pet = object(PET, 3, 200, 0, 1);
  assert.equal(viewSubject(world([self, pet]))?.guid, SELF, "no far sight: the character");
  assert.equal(viewSubject(world([self, pet], { farsight: PET, controlled: PET }))?.guid, PET, "possession");
  assert.equal(viewSubjectPosition(world([self, pet], { farsight: PET }))?.x, 200);
  assert.equal(viewSubjectIn(world([self, pet], { farsight: PET }).state)?.guid, PET, "from the state alone");
  assert.equal(viewSubject(world([self], { farsight: PET }))?.guid, SELF, "not in view: home, never the origin");
  const placeless = { ...object(PET, 3), position: undefined };
  assert.equal(viewSubject(world([self, placeless], { farsight: PET }))?.guid, SELF, "no position is not in view");
  assert.equal(viewSubject(world([self], { farsight: SELF }))?.guid, SELF, "the field naming the character itself");
  // Wow.exe moves the camera's target only when far sight engages (0x006e2880 → 0x006066e0):
  // control that arrived before the field leaves the camera at home for that moment.
  assert.equal(viewSubject(world([self, pet], { controlled: PET }))?.guid, SELF);
  // Any object type: a shaman's far sight is a DynamicObject (0x004d4db0 with type mask 1).
  assert.equal(viewSubject(world([self, object(EYE, 6, 80, 0)], { farsight: EYE }))?.guid, EYE);
  assert.equal(viewSubject(undefined), undefined);
  assert.equal(viewSubject({ state: { selfGuid: undefined, objects: new Map() } }), undefined);
  assert.equal(viewSubject({ state: { selfGuid: SELF, objects: new Map() } }), undefined, "the character not in view");
});

test("11.02-I: a held far sight is read every frame without building a bigint", () => {
  const RealBigInt = globalThis.BigInt;
  let built = 0;
  globalThis.BigInt = new Proxy(RealBigInt, {
    apply(target, receiver, args) {
      built += 1;
      return Reflect.apply(target, receiver, args);
    },
  });
  try {
    const self = object(SELF, 4);
    const eye = object(0xf100_0004_d200_0abcn, 6, 50, 0);
    const live = world([self, eye], { farsight: eye.guid });
    assert.equal(farSightGuid(self), eye.guid, "the first read of a new value builds it");
    const first = built;
    assert.ok(first > 0);
    for (let frame = 0; frame < 1000; frame++) {
      if (farSightGuid(self) !== eye.guid || viewSubject(live) !== eye || viewIsOut(live) !== true) {
        assert.fail("the held value changed");
      }
    }
    assert.equal(built, first, "a held value is answered from memory");
    setFarSight(self, undefined);
    for (let frame = 0; frame < 100; frame++) viewSubject(live);
    assert.equal(farSightGuid(self), undefined);
    assert.equal(built, first, "an empty field builds nothing either");
  } finally {
    globalThis.BigInt = RealBigInt;
  }
});

test("11.02-I: the mouse turns the body only while the camera is on the mover; far sight proper holds it", () => {
  // A character of its own per case: the far sight field is written on it.
  const self = () => object(SELF, 4);
  const pet = object(PET, 3, 200, 0);
  const eye = object(EYE, 6, 60, 0);
  const priestTarget = object(OTHER, 4, 40, 0);
  const cases = [
    // name, world → viewIsOut (0x005fa6b0), farSightHoldsBody (0x005fa060)
    ["normal play", world([self()]), false, false],
    ["possession: the field names the mover", world([self(), pet], { farsight: PET, controlled: PET }), false, false],
    ["control before the field", world([self(), pet], { controlled: PET }), true, false],
    ["far sight DynamicObject", world([self(), eye], { farsight: EYE }), true, true],
    ["mind vision on a player", world([self(), priestTarget], { farsight: OTHER }), true, true],
    ["far sight object out of view", world([self()], { farsight: EYE }), false, false],
    ["a vehicle's driving seat", world([self(), pet], { farsight: PET, controlled: PET }), false, false],
  ];
  for (const [name, live, out, held] of cases) {
    assert.equal(viewIsOut(live), out, `${name}: viewIsOut`);
    assert.equal(farSightHoldsBody(live), held, `${name}: farSightHoldsBody`);
  }
  assert.equal(viewIsOut(undefined), false);
  assert.equal(farSightHoldsBody(undefined), false);
});

test("11.02-I: a new subject clears the eased limits once; another world or a load starts over", () => {
  const rig = { wallView: 3, terrainView: 4 };
  const tracker = new ViewSubjectTracker();
  const realm = {};
  assert.equal(tracker.settle(rig, SELF, realm, false), false, "the first subject is only recorded");
  assert.deepEqual(rig, { wallView: 3, terrainView: 4 });
  assert.equal(tracker.settle(rig, SELF, realm, false), false);
  assert.equal(tracker.settle(rig, PET, realm, false), true, "possession begins");
  assert.deepEqual(rig, { wallView: Infinity, terrainView: Infinity });
  rig.wallView = 2;
  rig.terrainView = 2;
  assert.equal(tracker.settle(rig, PET, realm, false), false, "and only once");
  assert.deepEqual(rig, { wallView: 2, terrainView: 2 });
  assert.equal(tracker.settle(rig, SELF, realm, false), true, "and ends");

  // Another world (a relog) and a loading screen (a transfer): the next subject is only recorded.
  rig.wallView = 5;
  assert.equal(tracker.settle(rig, PET, {}, false), false, "a different world");
  assert.equal(rig.wallView, 5);
  assert.equal(tracker.settle(rig, SELF, realm, true), false, "loading");
  assert.equal(tracker.settle(rig, PET, realm, false), false, "the first frame after the curtain");
  assert.equal(rig.wallView, 5);
  assert.equal(tracker.settle(rig, undefined, realm, false), false, "no character in view");
  assert.equal(tracker.settle(rig, SELF, realm, false), false, "is a start over too");

  // Nothing is shared between two loops (or two tests).
  const other = new ViewSubjectTracker();
  assert.equal(other.settle(rig, PET, realm, false), false);
  tracker.reset();
  assert.equal(tracker.settle(rig, OTHER, realm, false), false, "reset forgets");
  assert.equal(rig.wallView, 5);
});

test("11.02-I: CMSG_FAR_SIGHT votes 1 when the object is in view and 0 only for an empty field (0x006e2880)", () => {
  const latch = new FarSightLatch();
  assert.equal(latch.observe(undefined, false), undefined, "nothing set, nothing owed");
  assert.equal(latch.observe(PET, false), undefined, "the field before its object: no vote yet");
  assert.equal(latch.observe(PET, true), true, "the object arrives: 1");
  assert.equal(latch.engaged, true);
  assert.equal(latch.observe(PET, true), undefined, "once");
  assert.equal(latch.observe(EYE, true), undefined, "another object while engaged: the camera moves, no vote");
  assert.equal(latch.observe(EYE, false), undefined, "its object gone, the field still set: never a 0");
  assert.equal(latch.engaged, true, "and the latch is kept");
  assert.equal(latch.observe(undefined, false), false, "the field cleared: 0");
  assert.equal(latch.observe(undefined, false), undefined, "once");
  assert.equal(latch.engaged, false);
  assert.equal(latch.observe(PET, true), true);
  latch.reset();
  assert.equal(latch.observe(undefined, false), undefined, "after a reset nothing is owed");
  assert.deepEqual([...buildFarSight(true)], [1]);
  assert.deepEqual([...buildFarSight(false)], [0]);
});

test("11.02-I: the link votes through the world once a frame and starts over on a load or another world", () => {
  const self = object(SELF, 4);
  const pet = object(PET, 3, 30, 0);
  const votes = [];
  const live = { state: { selfGuid: SELF, objects: new Map([[SELF, self]]) }, sendFarSight: (apply) => votes.push(apply) };
  const link = new FarSightLink();
  link.update(live, false);
  assert.deepEqual(votes, []);
  setFarSight(self, PET);
  link.update(live, false);
  assert.deepEqual(votes, [], "the field alone");
  live.state.objects.set(PET, pet);
  link.update(live, false);
  link.update(live, false);
  assert.deepEqual(votes, [true]);
  setFarSight(self, undefined);
  link.update(live, false);
  assert.deepEqual(votes, [true, false]);

  // Engaged, then a transfer: no 0 for a view the server has already taken home.
  setFarSight(self, PET);
  link.update(live, false);
  assert.deepEqual(votes, [true, false, true]);
  link.update(live, true);
  setFarSight(self, undefined);
  link.update(live, false);
  assert.deepEqual(votes, [true, false, true], "the loading screen reset the latch");

  // Engaged, then another world (a relog): the new world owes nothing.
  setFarSight(self, PET);
  link.update(live, false);
  const next = { state: { selfGuid: SELF, objects: new Map([[SELF, object(SELF, 4)]]) }, sendFarSight: (apply) => votes.push(apply) };
  link.update(next, false);
  assert.deepEqual(votes, [true, false, true, true]);
  link.update(undefined, false);
  assert.deepEqual(votes, [true, false, true, true]);
});

// 11.02-I review: the cases the review walked through (TrinityCore Player::SetClientControl,
// Player.cpp:24573-24607; Unit::SetFeared, Unit.cpp:12343-12373; Unit::RemoveCharmedBy, :12634-12645).
test("11.02-I review: no character in view casts no vote and keeps the latch", () => {
  assert.equal(farSightGuid(undefined), undefined, "nobody to read the field from");
  const self = object(SELF, 4);
  const pet = object(PET, 3, 30, 0);
  setFarSight(self, PET);
  const votes = [];
  const live = { state: { selfGuid: SELF, objects: new Map([[SELF, self], [PET, pet]]) }, sendFarSight: (apply) => votes.push(apply) };
  const link = new FarSightLink();
  link.update(live, false);
  assert.deepEqual(votes, [true]);
  // The character's object is not there to say what the field holds: not a cleared field.
  live.state.objects.delete(SELF);
  link.update(live, false);
  assert.deepEqual(votes, [true], "no 0 for a field nobody can read");
  assert.equal(link.latch.engaged, true);
  setFarSight(self, undefined);
  live.state.objects.set(SELF, self);
  link.update(live, false);
  assert.deepEqual(votes, [true, false], "the field read empty again: the 0 Wow.exe owes");
});

test("11.02-I review: the windows between control and the field hold or free the body as Wow.exe's latch does", () => {
  const self = object(SELF, 4);
  const pet = object(PET, 3, 200, 0);
  // Possession or a vehicle's driving seat ends: SMSG_CLIENT_CONTROL_UPDATE (unit, 0) then
  // (character, 1) go out at once, the cleared PLAYER_FARSIGHT with the next update. In between the
  // character is the mover with its view still out: held (0x005fa060: the active player is the
  // mover and the latch is set), the mouse on the camera.
  const ending = world([self, pet], { farsight: PET, controlled: SELF });
  assert.equal(farSightHoldsBody(ending), true);
  assert.equal(viewIsOut(ending), true);
  setFarSight(self, undefined);
  assert.equal(farSightHoldsBody(ending), false, "the field cleared: the body is the player's again");
  assert.equal(viewIsOut(ending), false);
  // The possessed unit is feared: (unit, 0) refuses it and leaves no mover here (WorldClient
  // `refusalTakesControl`), the field still names it (Player::SetClientControl changes no viewpoint
  // for the unit it already is). Nothing walks: not the far creature, not the character's own body.
  const feared = world([object(SELF, 4), pet], { farsight: PET, controlled: undefined });
  assert.equal(farSightHoldsBody(feared), true);
  assert.equal(viewIsOut(feared), true);
  // The character itself not in view: no camera and nothing to hold, whatever is controlled.
  const away = world([pet], { farsight: PET, controlled: PET });
  assert.equal(viewSubject(away), undefined);
  assert.equal(viewIsOut(away), false);
  assert.equal(farSightHoldsBody(away), false);
  assert.equal(viewIsOut(world([pet], { controlled: PET })), false);
});

test("11.02-I: WorldClient.sendFarSight sends CMSG_FAR_SIGHT with one byte", () => {
  const connection = {
    sent: [],
    send(opcode, payload = new Uint8Array()) { this.sent.push({ opcode, payload }); },
    read() { return new Promise(() => {}); },
    close() {},
  };
  const client = new WorldClient(connection);
  try {
    client.sendFarSight(true);
    client.sendFarSight(false);
    assert.deepEqual(connection.sent.filter((packet) => packet.opcode === OPCODES.CMSG_FAR_SIGHT)
      .map((packet) => [...packet.payload]), [[1], [0]]);
    assert.equal(OPCODES.CMSG_FAR_SIGHT, 0x27a, "the opcode Wow.exe pushes at 0x006e298e and 0x006e2a70");
  } finally {
    client.close();
  }
});

test("11.02-I: under possession the camera stands behind the possessed unit and turns with it", () => {
  const self = object(SELF, 4, 0, 0, 0);
  const pet = object(PET, 3, 200, 50, 0);
  const live = world([self, pet], { farsight: PET, controlled: PET });
  const rig = {
    yaw: 0, pitch: CAMERA_DEFAULT_PITCH, distance: CAMERA_DEFAULT_DISTANCE, view: CAMERA_DEFAULT_DISTANCE,
    viewPitch: CAMERA_DEFAULT_PITCH, zoom: CAMERA_DEFAULT_DISTANCE, wallView: Infinity, terrainView: Infinity,
    pivotHeight: CAMERA_DEFAULT_PIVOT_HEIGHT, eyeHeight: CAMERA_DEFAULT_EYE_HEIGHT,
  };
  const frame = () => {
    const subject = viewSubject(live);
    advanceCameraFrame(rig, subject.position, rig.pivotHeight, { heightAt: () => 0 }, 1 / 60);
    return createCamera(subject.position, rig.yaw, rig.viewPitch, rig.view, { pivotHeight: rig.pivotHeight });
  };
  let camera = frame();
  const behind = Math.hypot(camera.position.x - 200, camera.position.y - 50);
  assert.ok(behind < CAMERA_DEFAULT_DISTANCE + 1, `the boom hangs off the possessed unit, ${behind} yards`);
  assert.ok(camera.position.x < 200 && Math.abs(camera.position.y - 50) < 1e-6, "behind it, along its facing");
  assert.ok(Math.hypot(camera.position.x, camera.position.y) > 150, "nowhere near the character");
  // The keys turn the possessed unit (Mover.ts); the camera turns with it.
  pet.position.orientation = Math.PI / 2;
  camera = frame();
  assert.ok(Math.abs(camera.forward.x) < 1e-9 && camera.forward.y > 0, "now looking along +y");
  assert.ok(camera.position.y < 50 && Math.abs(camera.position.x - 200) < 1e-6);
  // The character's own facing has no say.
  self.position.orientation = 2;
  const again = frame();
  assert.ok(Math.abs(again.forward.x - camera.forward.x) < 1e-12 && Math.abs(again.forward.y - camera.forward.y) < 1e-12);
});

// ---- the consumers ---------------------------------------------------------------------------

function quad(a, b, c, d) {
  return Float32Array.of(...a, ...b, ...c, ...a, ...c, ...d);
}

/** A wall standing in the plane x = at. */
function wall(at) {
  return quad([at, -40, -20], [at, 40, -20], [at, 40, 20], [at, -40, 20]);
}

function withGame(live, extra, body) {
  const previous = {
    world: game.world, collision: game.collision, renderer: game.renderer, terrain: game.terrain,
    camera: { ...game.camera },
  };
  game.world = live;
  game.collision = extra.collision;
  game.terrain = extra.terrain;
  game.renderer = undefined;
  Object.assign(game.camera, {
    yaw: 0, pitch: CAMERA_DEFAULT_PITCH, viewPitch: CAMERA_DEFAULT_PITCH, distance: CAMERA_DEFAULT_DISTANCE,
    view: CAMERA_DEFAULT_DISTANCE, pivotHeight: CAMERA_DEFAULT_PIVOT_HEIGHT, eyeHeight: CAMERA_DEFAULT_EYE_HEIGHT,
  });
  try {
    body();
  } finally {
    game.world = previous.world;
    game.collision = previous.collision;
    game.renderer = previous.renderer;
    game.terrain = previous.terrain;
    Object.assign(game.camera, previous.camera);
  }
}

test("11.02-I: a click is sighted from the camera on the possessed unit, not from the character", () => {
  const live = world([object(SELF, 4), object(PET, 3, 200, 0), object(MOB, 3, 220, 0)], { farsight: PET, controlled: PET });
  const between = new CollisionWorld();
  between.set(1, new CollisionMesh(wall(100)));
  withGame(live, { collision: { world: between } }, () => {
    assert.equal(inSightFromCamera(MOB), true, "the wall stands between the character and the mob only");
  });
  const home = world([object(SELF, 4), object(PET, 3, 200, 0), object(MOB, 3, 220, 0)], { controlled: PET });
  withGame(home, { collision: { world: between } }, () => {
    assert.equal(inSightFromCamera(MOB), false, "from the character's camera the same wall is in the way");
  });
  const near = new CollisionWorld();
  near.set(1, new CollisionMesh(wall(210)));
  withGame(live, { collision: { world: near } }, () => {
    assert.equal(inSightFromCamera(MOB), false, "a wall in front of the possessed unit still takes the click");
  });
});

test("11.02-I: the ground reticle is cast from the camera on the possessed unit", () => {
  const live = { mapId: 0, ...world([object(SELF, 4), object(PET, 3, 200, 0)], { farsight: PET, controlled: PET }) };
  const terrain = { heightAt: () => 0, isHole: () => false, liquidAt: () => undefined };
  withGame(live, { terrain }, () => {
    const point = resolveGroundTarget(640, 360, 1280, 720, 30);
    assert.ok(point !== undefined, "the centre of the screen meets the ground");
    assert.ok(point.x > 150 && point.x < 260 && Math.abs(point.y) < 1, `around the possessed unit: ${point.x}, ${point.y}`);
    // The same click once the field is cleared lands in front of the character.
    setFarSight(live.state.objects.get(SELF), undefined);
    const home = resolveGroundTarget(640, 360, 1280, 720, 30);
    assert.ok(home !== undefined && home.x > 0 && home.x < 60, `in front of the character: ${home?.x}`);
  });
});

test("11.02-I: click boxes and plates are laid out around the view subject", () => {
  const WIDTH = 1280;
  const HEIGHT = 720;
  const context = new Proxy({
    createLinearGradient: () => ({ addColorStop() {} }),
    measureText: (text) => ({ width: text.length * 6 }),
  }, { get: (target, property) => target[property] ?? (() => {}) });
  const canvas = { width: 0, height: 0, getContext: () => context, getBoundingClientRect: () => ({ width: WIDTH, height: HEIGHT }) };
  const self = object(SELF, 4);
  const pet = object(PET, 3, 200, 0);
  const mob = object(MOB, 3, 220, 0);
  const state = { selfGuid: SELF, objects: new Map([[SELF, self], [PET, pet], [MOB, mob]]) };
  const previous = globalThis.window;
  globalThis.window = { devicePixelRatio: 1 };
  try {
    const scene = new SimpleScene(canvas, false);
    setFarSight(self, PET);
    scene.draw(state, () => 0, undefined, [], undefined, 0, undefined, undefined, () => 2, () => undefined,
      undefined, CAMERA_DEFAULT_PIVOT_HEIGHT);
    const camera = createCamera(pet.position, 0, CAMERA_DEFAULT_PITCH, CAMERA_DEFAULT_DISTANCE,
      { pivotHeight: CAMERA_DEFAULT_PIVOT_HEIGHT });
    const point = projectPoint({ x: 220, y: 0, z: 1 }, camera, WIDTH, HEIGHT);
    assert.ok(point !== undefined);
    assert.equal(scene.pick(point.x, point.y), MOB, "the mob 220 yards from the character is clickable");
    // Without far sight the frame is the character's, as before.
    setFarSight(self, undefined);
    scene.draw(state, () => 0, undefined, [], undefined, 0, undefined, undefined, () => 2, () => undefined,
      undefined, CAMERA_DEFAULT_PIVOT_HEIGHT);
    assert.equal(scene.pick(point.x, point.y), undefined);
  } finally {
    globalThis.window = previous;
  }
});

// ---- the body under far sight (Movement.ts) ----------------------------------------------------

const toggles = () => ({
  rooted: false, waterWalking: false, featherFall: false, hovering: false,
  canFly: false, gravityDisabled: false, collisionHeight: 0,
});

function moverWorld(objects, { farsight, controlled = SELF } = {}) {
  const sent = [];
  const live = world(objects, { farsight, controlled });
  Object.assign(live, {
    mapId: 0,
    movementReady: true,
    movementState: toggles(),
    speeds: new Map(),
    movementStateOf: (guid) => (guid === SELF ? live.movementState : toggles()),
    speedsOf: (guid) => (guid === SELF ? live.speeds : new Map()),
    sendMovement: (opcode) => {
      sent.push({ guid: SELF, opcode });
      const self = live.state.objects.get(SELF);
      self.position = { ...self.position };
    },
    sendMovementAs: (guid, opcode, flags, position) => {
      sent.push({ guid, opcode });
      live.state.objects.get(guid).position = { ...position };
    },
  });
  return { live, sent };
}

function withMover(live, body) {
  forgetMovementState();
  const previous = { world: game.world, terrain: game.terrain, loading: game.worldLoading };
  game.world = live;
  game.worldLoading = false;
  game.terrain = { heightAt: () => 0, liquidAt: () => undefined, isHole: () => false };
  try {
    body();
  } finally {
    releaseAllInput();
    forgetMovementState();
    game.world = previous.world;
    game.terrain = previous.terrain;
    game.worldLoading = previous.loading;
  }
}

test("11.02-I: far sight proper holds the character's body; the mouse turns the camera alone", () => {
  const { live, sent } = moverWorld([object(SELF, 4), object(EYE, 6, 60, 0)], { farsight: EYE });
  const self = live.state.objects.get(SELF);
  withMover(live, () => {
    assert.equal(movementBlocked(), "stun", "0x005fa060: the active player is the mover and its view is out");
    beginHeld("moveForward");
    advancePhysics(0.1);
    assert.deepEqual(sent.filter((packet) => packet.opcode === OPCODES.MSG_MOVE_START_FORWARD), [], "no walk goes out");
    assert.equal(self.position.x, 0, "and the body stays");
    assert.equal(turnCharacterBy(0.5), false, "the mouse turns the camera instead");
    assert.equal(self.position.orientation, 0);
  });
});

test("11.02-I: possession turns the possessed unit with the mouse; control before the field turns nothing", () => {
  const pet = () => object(PET, 3, 200, 0);
  let { live, sent } = moverWorld([object(SELF, 4), pet()], { farsight: PET, controlled: PET });
  withMover(live, () => {
    assert.equal(movementBlocked(), undefined, "a possessed mover is never held by far sight");
    assert.equal(turnCharacterBy(0.5), true);
    assert.equal(live.state.objects.get(PET).position.orientation, 0.5);
    assert.equal(live.state.objects.get(SELF).position.orientation, 0);
  });

  ({ live, sent } = moverWorld([object(SELF, 4), pet()], { controlled: PET }));
  withMover(live, () => {
    assert.equal(turnCharacterBy(0.5), false, "0x005fa6b0: the camera is not on the mover yet");
    assert.equal(live.state.objects.get(PET).position.orientation, 0);
    beginHeld("moveForward");
    assert.deepEqual(sent.filter((packet) => packet.opcode === OPCODES.MSG_MOVE_START_FORWARD).map((packet) => packet.guid),
      [PET], "the keys still drive it");
  });

  ({ live } = moverWorld([object(SELF, 4)]));
  withMover(live, () => {
    assert.equal(movementBlocked(), undefined);
    assert.equal(turnCharacterBy(0.5), true, "normal play is untouched");
    assert.equal(live.state.objects.get(SELF).position.orientation, 0.5);
  });
});

// ---- the hook lines --------------------------------------------------------------------------

test("11.02-I: the frame, the reticle and the overlay build their cameras from the view subject", async () => {
  const loop = await readFile(new URL("../src/browser/game/Loop.ts", import.meta.url), "utf8");
  assert.match(loop, /const subject = viewSubject\(world\) \?\? player;/);
  assert.match(loop, /const position = subject\.position \?\? player\.position \?\?/,
    "everything built around the camera reads the subject's position");
  assert.match(loop, /unitPivotHeight\(subject\.guid\)/);
  assert.match(loop, /unitEyeHeight\(subject\.guid\)/);
  assert.match(loop, /viewTracker\.settle\(game\.camera, subject\.guid, world, game\.worldLoading\);/);
  // DEC-review 3.11: DEC-B added `&& !cameraViews.gliding` (the follow waits for a camera view's glide); the
  // 11.02-I half — no follow while the view is out — is the same (was `/if \(!viewIsOut\(world\)\) advance…/`).
  assert.match(loop, /if \(!viewIsOut\(world\) && !cameraViews\.gliding\) advanceCameraAutoFollow\(elapsed\);/);
  assert.match(loop, /advanceCameraView\(position, world\.mapId, elapsed, subject\);/);
  assert.match(loop, /farSightLink\.update\(world, game\.worldLoading\);\n\s*if \(!world \|\| game\.worldLoading\) viewTracker\.reset\(\);/,
    "outside the drawn block, so a transfer without a position still starts the subject over");
  const helper = loop.slice(loop.indexOf("function updateTerrainActiveTiles"), loop.indexOf("function frame("));
  assert.match(helper, /const player = viewSubject\(world\);/, "the terrain ring follows the subject");

  const overlay = await readFile(new URL("../src/browser/ui/HeadOverlay.ts", import.meta.url), "utf8");
  assert.match(overlay, /const player = viewSubjectPosition\(world\);/, "the bubbles hang off the same camera");
  // The world pass resolves the subject from the state it is handed (the plates' pass is tested above).
  const renderer = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const draw = renderer.slice(renderer.indexOf("  draw(\n"), renderer.indexOf("\n  #resetFrameCounters(): void {"));
  assert.match(draw, /const player = viewSubjectIn\(state\);\n\s*if \(!player\?\.position\) \{/);
  assert.match(draw, /this\.#updateCamera\(player\.position, cameraYaw/);
});
