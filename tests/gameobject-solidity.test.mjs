import assert from "node:assert/strict";
import test from "node:test";

// 11.01 (owner's decision of 12.10): the other game objects are solid, as Wow.exe makes them. Every
// game object's model becomes a world entity when it is set up (0x00711a10 → 0x007110b0 → 0x00783500),
// owner-tagged with its guid; the movement query gathers the dynamic WMOs (0x007a55e0) and a game
// object's doodads (0x007a50c0, query flag 0x100000, always set by 0x0075e3d0) unless the entity's
// +0xc bit 0x100 is set — and that bit is set only for a destructible building's other states and
// hidden building (0x00710be0, 0x0070dfa0, 0x0070e750, 0x0070b6a0/0x0070b6e0) and by 0x00710460. No
// type or state gates it otherwise. Doors keep slice B's state rule (tests/door-collision.test.mjs);
// lifts are carried (tests/lift-carry.test.mjs); ships are the ride's.
import { decodeCollisionModel, encodeCollisionModel } from "../dist/code/world/CollisionFormat.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { DEFAULT_COLLISION_HEIGHT, newCharacterMotion, stepCharacter } from "../dist/code/browser/game/Physics.js";
import { TransportCollision } from "../dist/code/browser/game/TransportCollision.js";
import {
  COLLIDER_REACH, GO_STATE_ACTIVE, GO_STATE_READY, GO_TYPE_MO_TRANSPORT, GameObjectColliders, gameObjectSolid, setGameObjectColliders,
} from "../dist/code/browser/game/GameObjectColliders.js";
import { beginRideFrame, endRideFrame, setRideCarriers, stepRideSubstep } from "../dist/code/browser/input/MovementRide.js";

const SELF = 0x99n;
const PROP = 0xf110_0000_0000_0051n;
const SHIP = 0x1fc0_0000_0000_0007n;
const BYTES_1 = UPDATE_FIELDS.GAMEOBJECT_BYTES_1.offset;
const DISPLAY = UPDATE_FIELDS.GAMEOBJECT_DISPLAYID.offset;
const SLAB_DISPLAY = 5001;
const PLATFORM_DISPLAY = 5002;
const CRATE_DISPLAY = 5003;

/** A box in its own frame as one collision group. */
function boxModel([x0, x1, y0, y1, z0, z1]) {
  const vertices = Float32Array.from([
    x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0,
    x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1,
  ]);
  const indices = Uint32Array.from([
    0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6, 1, 2, 6, 1, 6, 5, 3, 0, 4, 3, 4, 7, 4, 5, 6, 4, 6, 7, 0, 2, 1, 0, 3, 2,
  ]);
  const group = { bounds: { minX: x0, minY: y0, minZ: z0, maxX: x1, maxY: y1, maxZ: z1 }, flags: 0x8, groupId: 1, vertices, indices };
  return decodeCollisionModel(encodeCollisionModel([group]).slice().buffer);
}

const MODELS = new Map([
  // A slab across a corridor: 4 long on x, half a yard thick, 5 high.
  [SLAB_DISPLAY, boxModel([0, 4, -0.25, 0.25, 0, 5])],
  // A platform a yard thick, 12 × 12.
  [PLATFORM_DISPLAY, boxModel([-6, 6, -6, 6, -1, 0])],
  // A crate, a yard and a half on a side.
  [CRATE_DISPLAY, boxModel([-0.75, 0.75, -0.75, 0.75, 0, 1.5])],
]);

function models() {
  const asked = [];
  const source = {
    revision: 0,
    model(id) {
      asked.push(id);
      return MODELS.get(id) ?? null;
    },
    requestGroups() {},
  };
  return { collision: new TransportCollision(source), asked };
}

function gameObject(guid, { type = 5, state = GO_STATE_READY, position, display = SLAB_DISPLAY, bytes, transport } = {}) {
  const fields = new Map();
  if (bytes !== null) fields.set(BYTES_1, bytes ?? ((type << 8) | state | (255 << 24)));
  fields.set(DISPLAY, display);
  fields.set(UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, 190_000);
  return { guid, typeId: 5, position: { ...position }, fields, transport, transportTime: undefined, transportTimeAt: undefined };
}

function input(overrides = {}) {
  return {
    forward: 0, strafe: 0, ascend: false, descend: false, pitch: 0,
    runSpeed: 7, runBackSpeed: 4.5, swimSpeed: 4.722222, swimBackSpeed: 2.5, flightSpeed: 7, flightBackSpeed: 4.5,
    stunned: false, collisionHeight: DEFAULT_COLLISION_HEIGHT, radius: 0.389,
    rooted: false, waterWalking: false, featherFall: false, hovering: false, hoverHeight: 0, canFly: false, gravityDisabled: false,
    ...overrides,
  };
}

const flat = (z = 0) => ({ ground: () => z, liquid: () => undefined, hole: () => false });

/** The slab at (100, 200) turned a quarter: it runs from (100, 200) to (100, 204), across y = 202. */
const SLAB_POSE = { x: 100, y: 200, z: 0, orientation: Math.PI / 2 };

function walkEast(colliders, objects, start = { x: 97, y: 202, z: 0, orientation: 0 }, seconds = 1, base = flat()) {
  const self = { guid: SELF, typeId: 4, position: { ...start }, fields: new Map() };
  const motion = newCharacterMotion();
  const step = 1 / 60;
  let used;
  for (let elapsed = 0; elapsed < seconds; elapsed += step) {
    used = colliders.frame(objects, self, base, motion, 1000 + elapsed * 1000);
    stepCharacter(self.position, motion, input({ forward: 1 }), used, step);
  }
  return { position: self.position, probe: used, base, colliders };
}

test("every game object with a collision model is solid, whatever its type and state", () => {
  // Chest, generic, spell focus, mailbox, goober, destructible building; READY and ACTIVE alike.
  for (const type of [3, 5, 8, 10, 19, 33]) {
    for (const state of [GO_STATE_READY, GO_STATE_ACTIVE]) {
      const { collision } = models();
      const colliders = new GameObjectColliders(collision, undefined);
      const objects = new Map([[PROP, gameObject(PROP, { type, state, position: SLAB_POSE })]]);
      const { position } = walkEast(colliders, objects);
      assert.ok(position.x < 100 - 0.25 && position.x > 99, `type ${type}, state ${state}: stopped at the slab (${position.x})`);
    }
  }
  assert.equal(gameObjectSolid(gameObject(PROP, { type: 5, position: SLAB_POSE }), undefined), true);
  assert.equal(gameObjectSolid(gameObject(PROP, { type: GO_TYPE_MO_TRANSPORT, position: SLAB_POSE }), undefined), false);
  assert.equal(gameObjectSolid(gameObject(PROP, { position: SLAB_POSE, bytes: null }), undefined), undefined);
});

test("a type not known yet and a model without a row are none", () => {
  for (const [name, object] of [
    ["no GAMEOBJECT_BYTES_1 yet", gameObject(PROP, { position: SLAB_POSE, bytes: null })],
    ["no .dtree row", gameObject(PROP, { position: SLAB_POSE, display: 4242 })],
  ]) {
    const { collision } = models();
    const colliders = new GameObjectColliders(collision, undefined);
    const { position, probe, base } = walkEast(colliders, new Map([[PROP, object]]));
    assert.equal(probe, base, `${name}: the world probe itself`);
    assert.ok(position.x > 103, `${name}: walked through (${position.x})`);
  }
});

test("a ship not ridden is a wall at its pose this frame", () => {
  const { collision } = models();
  const colliders = new GameObjectColliders(collision, undefined);
  const hull = gameObject(SHIP, { type: GO_TYPE_MO_TRANSPORT, position: SLAB_POSE });
  const objects = new Map([[SHIP, hull]]);
  const stopped = walkEast(colliders, objects);
  assert.ok(stopped.position.x < 100 - 0.25 && stopped.position.x > 99, `stopped at the hull (${stopped.position.x})`);
  hull.position.x = 120; // It sailed on: the wall went with it, without a rescan or a new model.
  assert.ok(walkEast(colliders, objects).position.x > 103, "the way is clear");
});

test("the hull is out of what boarding reads as the pier; other game objects stay in it", () => {
  const { collision } = models();
  const colliders = new GameObjectColliders(collision, undefined);
  const base = flat();
  const objects = new Map([[SHIP, gameObject(SHIP, { type: GO_TYPE_MO_TRANSPORT, position: SLAB_POSE })]]);
  const self = { guid: SELF, typeId: 4, position: { x: 99, y: 202, z: 0, orientation: 0 }, fields: new Map() };
  const probe = colliders.frame(objects, self, base, newCharacterMotion(), 0);
  assert.notEqual(probe, base, "the step asks it");
  assert.equal(colliders.withoutHulls(base), base, "nothing else near: the world itself");
  objects.set(PROP, gameObject(PROP, { position: SLAB_POSE }));
  const both = colliders.frame(objects, self, base, newCharacterMotion(), 2000);
  const pier = colliders.withoutHulls(base);
  assert.notEqual(pier, base);
  assert.notEqual(pier, both);
  assert.equal(pier.count, 1, "the prop");
  assert.equal(both.count, 2, "the prop and the hull");
  objects.delete(SHIP);
  const alone = colliders.frame(objects, self, base, newCharacterMotion(), 4000);
  assert.equal(colliders.withoutHulls(base), alone, "no hull: the same probe");
});

test("the ship being ridden is no wall: its deck is the ride's", () => {
  const { collision } = models();
  const colliders = new GameObjectColliders(collision, undefined);
  const base = flat();
  const objects = new Map([[SHIP, gameObject(SHIP, { type: GO_TYPE_MO_TRANSPORT, position: SLAB_POSE })]]);
  const self = {
    guid: SELF, typeId: 4, position: { x: 99, y: 202, z: 0, orientation: 0 }, fields: new Map(),
    transport: { guid: SHIP, x: 0, y: 0, z: 0, orientation: 0, seat: 0xff },
  };
  assert.equal(colliders.frame(objects, self, base, newCharacterMotion(), 0), base);
});

test("standing on a game object when it comes into view, the character stays on it (the door's passable rule is the door's)", () => {
  const { collision } = models();
  const colliders = new GameObjectColliders(collision, undefined);
  // A platform 10 yards over the ground; the character on its top, walking along it.
  const objects = new Map([[PROP, gameObject(PROP, { display: PLATFORM_DISPLAY, position: { x: 100, y: 200, z: 10, orientation: 0 } })]]);
  const { position } = walkEast(colliders, objects, { x: 97, y: 200, z: 10, orientation: 0 }, 0.5, flat(0));
  assert.ok(Math.abs(position.z - 10) < 0.05 && position.x > 99, `still on the platform (${position.x}, ${position.z})`);
});

test("a game object within the range but beyond reach is kept, not asked on every query", () => {
  const { collision } = models();
  const colliders = new GameObjectColliders(collision, undefined);
  const prop = gameObject(PROP, { position: { ...SLAB_POSE, x: 100 + 20 } });
  const objects = new Map([[PROP, prop]]);
  const self = { guid: SELF, typeId: 4, position: { x: 100, y: 202, z: 0, orientation: 0 }, fields: new Map() };
  const base = flat();
  assert.equal(colliders.frame(objects, self, base, newCharacterMotion(), 0), base, "20 yards off: the world probe");
  assert.equal(collision.size, 1, "its model is loaded and kept");
  self.position.x = 120 - COLLIDER_REACH + 1;
  assert.notEqual(colliders.frame(objects, self, base, newCharacterMotion(), 16), base);
  assert.equal(colliders.active, 1, "within reach: asked");
  // Far below it (a cave under a bridge): not asked; anywhere above its footprint (a fall onto it): asked.
  self.position.z = -(COLLIDER_REACH + 1);
  colliders.frame(objects, self, base, newCharacterMotion(), 32);
  assert.equal(colliders.active, 0);
  self.position.z = 300;
  colliders.frame(objects, self, base, newCharacterMotion(), 48);
  assert.equal(colliders.active, 1);
});

test("a destructible building is solid by the display id the core gives its state", () => {
  const { collision } = models();
  const colliders = new GameObjectColliders(collision, undefined);
  const building = gameObject(PROP, { type: 33, position: SLAB_POSE });
  const objects = new Map([[PROP, building]]);
  assert.ok(walkEast(colliders, objects).position.x < 100, "the intact model stands");
  // `SetDestructibleState` → `SetDisplayId` (a destroyed model with no collision here).
  building.fields.set(DISPLAY, 4242);
  assert.ok(walkEast(colliders, objects).position.x > 103, "its destroyed display has no collision: open");
});

// ---------------------------------------------------------------------------------------------
// Aboard the ship the character rides: the step runs in the ship's frame (MovementRide), so a game
// object aboard (a create block's UPDATEFLAG_POSITION seat, TransportPassengers.positionPassengerSeat)
// stands at its seat there, and is out of the world's probe — whose floor reads as a pier to the ride.

const SHIP_POSE = { x: 1000, y: 500, z: 20, orientation: 0.7 };
const CRATE_SEAT = { guid: SHIP, x: 3, y: 0, z: 0, orientation: 0.4, seat: 0xff };

function compose(pose, offset) {
  const cos = Math.cos(pose.orientation);
  const sin = Math.sin(pose.orientation);
  return { x: pose.x + offset.x * cos - offset.y * sin, y: pose.y + offset.x * sin + offset.y * cos, z: pose.z + offset.z,
    orientation: pose.orientation + offset.orientation };
}

function shipWorld() {
  const ship = gameObject(SHIP, { type: GO_TYPE_MO_TRANSPORT, position: SHIP_POSE, display: 1 });
  const crate = gameObject(PROP, { display: CRATE_DISPLAY, position: compose(SHIP_POSE, CRATE_SEAT), transport: { ...CRATE_SEAT } });
  return new Map([[SHIP, ship], [PROP, crate]]);
}

/** 06.11 (2.12): three yards in front of the crate's face, in the ship's frame, facing it. */
function crateFront() {
  const { x, y, orientation } = CRATE_SEAT;
  return { x: x - 3 * Math.cos(orientation), y: y - 3 * Math.sin(orientation), orientation };
}

/** How far from the crate's middle a point in the ship's frame stands, along the crate's facing. */
function crateAlong({ x, y }) {
  return (x - CRATE_SEAT.x) * Math.cos(CRATE_SEAT.orientation) + (y - CRATE_SEAT.y) * Math.sin(CRATE_SEAT.orientation);
}

/** The deck: flat at z = 0 of the ship's frame, as the ride's CarrierProbe answers it. */
const DECK = {
  ground: () => undefined, liquid: () => undefined, hole: () => true, loaded: () => true,
  floor: (x, y, from, min) => (from >= 0 && min <= 0 ? 0 : undefined), pushOut: (x, y) => ({ x, y }), ceiling: () => undefined,
};

test("a game object aboard the ridden ship stands at its seat in the ship's frame, and only there", () => {
  const { collision } = models();
  const colliders = new GameObjectColliders(collision, undefined);
  const objects = shipWorld();
  const self = {
    guid: SELF, typeId: 4, position: compose(SHIP_POSE, { x: 0, y: 0, z: 0, orientation: 0 }), fields: new Map(),
    transport: { guid: SHIP, x: 0, y: 0, z: 0, orientation: 0, seat: 0xff },
  };
  const base = flat(-50);
  assert.equal(colliders.frame(objects, self, base, newCharacterMotion(), 0), base, "not in the world's probe");
  assert.equal(colliders.aboard, 1);
  assert.equal(colliders.rideProbe(0x1234n, DECK), DECK, "another ship's step: the deck alone");
  const probe = colliders.rideProbe(SHIP, DECK);
  assert.notEqual(probe, DECK);
  assert.ok(Math.abs(probe.floor(3, 0, 5, -5) - 1.5) < 1e-4, "on the crate, in the ship's frame: its top");
  assert.equal(probe.floor(0, 0, 5, -5), 0, "beside it: the deck");
  // A walk square at its face, as the ride steps: stopped at the face. 06.11 (2.12): square, because one along the keel meets the
  // turned crate 23° off and slides past it, as in Wow.exe.
  const local = { ...crateFront(), z: 0 };
  const motion = newCharacterMotion();
  for (let frame = 0; frame < 60; frame++) stepCharacter(local, motion, input({ forward: 1 }), probe, 1 / 60);
  const short = crateAlong(local);
  assert.ok(short < -0.75 && short > -1.5, `stopped at the crate (${short} along its facing)`);

  // Off the ship (no seat): the crate is a world collider at its world pose, like any other.
  self.transport = undefined;
  assert.notEqual(colliders.frame(objects, self, base, newCharacterMotion(), 16), base);
  assert.equal(colliders.aboard, 0);
  assert.equal(colliders.active, 1);
});

test("riding: the ride's step on the deck runs into a crate aboard and stops at it", () => {
  // The page's order (Movement.advancePhysics): the colliders' frame, then the ride's frame and step.
  const { collision } = models();
  const colliders = new GameObjectColliders(collision, undefined);
  setGameObjectColliders(colliders);
  // The deck: the platform model as the ship's own collision, its top at z = 0 of the ship's frame.
  const deckSource = { revision: 0, model: (id) => (id === 1 ? MODELS.get(PLATFORM_DISPLAY) : null), requestGroups() {} };
  setRideCarriers(new TransportCollision(deckSource));
  try {
    const objects = shipWorld();
    const front = { ...crateFront(), z: 0 }; // 06.11 (2.12): square at the crate, as above
    const self = {
      guid: SELF, typeId: 4, position: compose(SHIP_POSE, front), fields: new Map(),
      transport: { guid: SHIP, ...front, seat: 0xff },
    };
    objects.set(SELF, self);
    const motion = newCharacterMotion();
    const base = flat(-50);
    const events = [];
    for (let frame = 0; frame < 60; frame++) {
      const now = frame * 16;
      const world = colliders.frame(objects, self, base, motion, now);
      const ride = { objects, self, world, motion, flying: false, elapsed: 1 / 60, now };
      assert.ok(beginRideFrame(ride), `frame ${frame}: riding`);
      stepRideSubstep(ride, motion, input({ forward: 1 }), 1 / 60, events);
      endRideFrame(ride);
    }
    assert.equal(self.transport?.guid, SHIP, "still aboard");
    const short = crateAlong(self.transport);
    assert.ok(short < -0.75 && short > -1.5, `stopped at the crate on the deck (${short} along its facing)`);
  } finally {
    setGameObjectColliders(undefined);
    setRideCarriers(undefined);
  }
});

test("a ship's hull as a wall does not stop anyone boarding it: its deck under the feet still boards", () => {
  const { collision } = models();
  const colliders = new GameObjectColliders(collision, undefined);
  setGameObjectColliders(colliders);
  setRideCarriers(new TransportCollision({ revision: 0, model: (id) => MODELS.get(id) ?? null, requestGroups() {} }));
  try {
    const ship = gameObject(SHIP, { type: GO_TYPE_MO_TRANSPORT, position: SHIP_POSE, display: PLATFORM_DISPLAY });
    const objects = new Map([[SHIP, ship]]);
    const self = { guid: SELF, typeId: 4, position: { x: SHIP_POSE.x, y: SHIP_POSE.y, z: SHIP_POSE.z + 0.1, orientation: 0 }, fields: new Map() };
    objects.set(SELF, self);
    const motion = newCharacterMotion();
    const base = flat(-50);
    const probe = colliders.frame(objects, self, base, motion, 0);
    assert.notEqual(probe, base, "the hull is near");
    const frame = (world) => ({ objects, self, world, motion, flying: false, elapsed: 1 / 60, now: 0 });
    assert.equal(beginRideFrame(frame(probe)), undefined, "asked with the hull in it, the deck ties with itself and the world wins");
    assert.ok(beginRideFrame(frame(colliders.withoutHulls(base))), "without it, the deck boards");
    assert.equal(self.transport?.guid, SHIP);
  } finally {
    setGameObjectColliders(undefined);
    setRideCarriers(undefined);
  }
});
