import assert from "node:assert/strict";
import test from "node:test";

// 11.01 slice B, doors. The core keeps a game object's model in the map's dynamic tree and enables
// it while the object is GO_STATE_READY (1, a closed door) — `AddToWorld` (GameObject.cpp:236-243)
// and `SetGoState` → `EnableCollision` (:2687-2705); ACTIVE (0) and DESTROYED (2, the 3.3.5
// ACTIVE_ALTERNATIVE, `SwitchDoorOrButton(…, alternative)`, :1650) leave it off. The model stands at
// `pos + scale · Rz(o) · v` (GameObjectModel.cpp:124-137). The state is byte 0 of
// GAMEOBJECT_BYTES_1, the type byte 1 (`SetGoState`, `SetGoType`, GameObject.h:177).
import { decodeCollisionModel, encodeCollisionModel } from "../dist/code/world/CollisionFormat.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { DEFAULT_COLLISION_HEIGHT, newCharacterMotion, stepCharacter } from "../dist/code/browser/game/Physics.js";
import { TransportCollision } from "../dist/code/browser/game/TransportCollision.js";
import { DynamicColliderProbe } from "../dist/code/browser/game/DynamicColliderProbe.js";
import { CollisionMesh, CollisionWorld } from "../dist/code/browser/game/Collision.js";
import {
  COLLIDER_RANGE, GO_STATE_ACTIVE, GO_STATE_DESTROYED, GO_STATE_READY, GO_TYPE_DOOR, GameObjectColliders, doorSolid,
} from "../dist/code/browser/game/GameObjectColliders.js";

const DOOR = 0xf110_0000_0000_0042n;
const DOOR_DISPLAY = 411;
const SELF = 0x99n;
const BYTES_1 = UPDATE_FIELDS.GAMEOBJECT_BYTES_1.offset;
const DISPLAY = UPDATE_FIELDS.GAMEOBJECT_DISPLAYID.offset;

/** A door slab in its own frame: hinge at the origin, 4 long along x, 0.5 thick (by default), 5 high. */
function doorModel(thickness = 0.5) {
  const [x0, x1, y0, y1, z0, z1] = [0, 4, -thickness / 2, thickness / 2, 0, 5];
  const vertices = Float32Array.from([
    x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0,
    x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1,
  ]);
  const indices = Uint32Array.from([
    0, 1, 5, 0, 5, 4, // y0 face
    2, 3, 7, 2, 7, 6, // y1 face
    1, 2, 6, 1, 6, 5, // x1 face
    3, 0, 4, 3, 4, 7, // x0 face
    4, 5, 6, 4, 6, 7, // top
    0, 2, 1, 0, 3, 2, // bottom
  ]);
  const group = {
    bounds: { minX: x0, minY: y0, minZ: z0, maxX: x1, maxY: y1, maxZ: z1 }, flags: 0x8, groupId: 1, vertices, indices,
  };
  return decodeCollisionModel(encodeCollisionModel([group]).slice().buffer);
}

/** The page's model source: `null` (no `.dtree` row), undefined (loading) or the slab. */
function models(answer = "door", thickness = 0.5) {
  const model = doorModel(thickness);
  const asked = [];
  const source = {
    revision: 0,
    model(id) {
      asked.push(id);
      if (answer === "loading") return undefined;
      return answer === "door" && id === DOOR_DISPLAY ? model : null;
    },
    requestGroups() {},
  };
  return { collision: new TransportCollision(source), asked };
}

const DOOR_ENTRY = 186_000;
const START_OPEN_ENTRY = 186_001;
const UNKNOWN_ENTRY = 186_002;
/** `door.startOpen` is data0 (GameObjectData.h:59). */
const CLOSED_DOOR = { type: GO_TYPE_DOOR, data: [0, 0, 0, 0, 0, 0, 0, 0] };
const START_OPEN_DOOR = { type: GO_TYPE_DOOR, data: [1, 0, 0, 0, 0, 0, 0, 0] };
/** `WorldClient.gameObjectTemplate`: undefined until the query answers. */
const templates = (entry) => (entry === DOOR_ENTRY ? CLOSED_DOOR : entry === START_OPEN_ENTRY ? START_OPEN_DOOR : undefined);

function gameObject(guid, { type = GO_TYPE_DOOR, state = GO_STATE_READY, position, display = DOOR_DISPLAY, bytes, entry = DOOR_ENTRY } = {}) {
  const fields = new Map();
  if (bytes !== null) fields.set(BYTES_1, bytes ?? ((type << 8) | state | (255 << 24)));
  fields.set(DISPLAY, display);
  fields.set(UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, entry);
  return { guid, typeId: 5, position: { ...position }, fields, transport: undefined, transportTime: undefined, transportTimeAt: undefined };
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

/** Flat ground at z = 0, nothing else: the static world. */
const flat = () => ({ ground: () => 0, liquid: () => undefined, hole: () => false });

/**
 * The door at (100, 200) turned a quarter (o = π/2): its slab runs from (100, 200) to (100, 204),
 * across the path of a character walking east at y = 202 from x = 97.
 */
const DOOR_POSE = { x: 100, y: 200, z: 0, orientation: Math.PI / 2 };

/** Walks the character east for a second through the colliders' frame; returns where it ended. */
function walkEast(colliders, objects, start = { x: 97, y: 202, z: 0, orientation: 0 }, seconds = 1) {
  const self = { guid: SELF, typeId: 4, position: { ...start }, fields: new Map() };
  const motion = newCharacterMotion();
  const base = flat();
  const step = 1 / 60;
  let used;
  for (let elapsed = 0; elapsed < seconds; elapsed += step) {
    used = colliders.frame(objects, self, base, motion, 1000 + elapsed * 1000);
    stepCharacter(self.position, motion, input({ forward: 1 }), used, step);
  }
  return { position: self.position, probe: used, base };
}

test("a closed door blocks the corridor; open and ACTIVE_ALTERNATIVE do not", () => {
  for (const [state, blocks] of [[GO_STATE_READY, true], [GO_STATE_ACTIVE, false], [GO_STATE_DESTROYED, false]]) {
    const { collision } = models();
    const colliders = new GameObjectColliders(collision, undefined, templates);
    const objects = new Map([[DOOR, gameObject(DOOR, { state, position: DOOR_POSE })]]);
    const { position } = walkEast(colliders, objects);
    if (blocks) {
      assert.ok(position.x < 100 - 0.25, `state ${state}: stopped before the slab, at x = ${position.x}`);
      assert.ok(position.x > 99, `state ${state}: and against it (${position.x})`);
    } else assert.ok(position.x > 103, `state ${state}: walked through, at x = ${position.x}`);
  }
  assert.equal(doorSolid(gameObject(DOOR, { state: GO_STATE_READY, position: DOOR_POSE }), CLOSED_DOOR), true);
  assert.equal(doorSolid(gameObject(DOOR, { state: GO_STATE_ACTIVE, position: DOOR_POSE }), CLOSED_DOOR), false);
  assert.equal(doorSolid(gameObject(DOOR, { state: GO_STATE_DESTROYED, position: DOOR_POSE }), CLOSED_DOOR), false);
});

test("the door follows its state byte: closing makes it solid, opening clears it, without a reload", () => {
  const { collision } = models();
  const colliders = new GameObjectColliders(collision, undefined, templates);
  const door = gameObject(DOOR, { state: GO_STATE_ACTIVE, position: DOOR_POSE });
  const objects = new Map([[DOOR, door]]);
  const self = { guid: SELF, typeId: 4, position: { x: 99.7, y: 202, z: 0, orientation: 0 }, fields: new Map() };
  const motion = newCharacterMotion();
  const base = flat();

  let probe = colliders.frame(objects, self, base, motion, 0);
  assert.equal(probe, base, "open: the world probe itself, as before this slice");
  // The model is asked while the door is open, so it is there the moment it closes.
  const world = collision.forObject(door);
  assert.ok(world instanceof CollisionWorld);

  door.fields.set(BYTES_1, (GO_TYPE_DOOR << 8) | GO_STATE_READY);
  probe = colliders.frame(objects, self, base, motion, 16);
  assert.notEqual(probe, base);
  assert.equal(colliders.active, 1);
  const pushed = probe.pushOut(99.7, 202, 0, 0.389, DEFAULT_COLLISION_HEIGHT);
  assert.ok(pushed.x < 99.75 - 0.3, `closed: pushed back out of the slab (${pushed.x})`);
  assert.equal(collision.forObject(door), world, "the same mesh: nothing rebuilt by the state change");

  door.fields.set(BYTES_1, (GO_TYPE_DOOR << 8) | GO_STATE_ACTIVE);
  probe = colliders.frame(objects, self, base, motion, 32);
  assert.equal(probe, base, "open again: nothing in the way");
  assert.equal(colliders.active, 0);
});

test("the collider stands in the core's frame, pos + Rz(o)·v, not turned half a turn", () => {
  const { collision } = models();
  const colliders = new GameObjectColliders(collision, undefined, templates);
  const objects = new Map([[DOOR, gameObject(DOOR, { position: DOOR_POSE })]]);
  // At y = 198 the core's slab (y 200..204) is not in the way; a slab turned by π (y 196..200) would be.
  const clear = walkEast(colliders, objects, { x: 97, y: 198, z: 0, orientation: 0 });
  assert.ok(clear.position.x > 103, `walked past the hinge side (${clear.position.x})`);
  const blocked = walkEast(colliders, objects, { x: 97, y: 203.5, z: 0, orientation: 0 });
  assert.ok(blocked.position.x < 100, `the slab's far end blocks (${blocked.position.x})`);

  // The probe's answers equal a world-placed copy of the slab at the same spot.
  const probe = new DynamicColliderProbe(flat());
  const local = collision.forObject(objects.get(DOOR));
  probe.colliders[0] = { guid: DOOR, world: local, pose: DOOR_POSE };
  probe.count = 1;
  assert.equal(probe.floor(101, 202, 10, -10), undefined, "beside the slab: no floor but the ground's");
  assert.ok(Math.abs(probe.floor(100, 202, 10, -10) - 5) < 1e-4, "on top of it: its top, five up");
  assert.ok(Math.abs(probe.ceiling(100, 203, -1, 10) - 0) < 1e-4, "under it: its bottom");
  assert.equal(probe.floor(100, 198, 10, -10), undefined, "where a half-turned slab would stand: nothing");
});

test("a door that closes on the character does not hold it inside; once clear of it, the door is solid", () => {
  // A gate two yards thick (world x 99..101 across the corridor): a body of radius 0.389 standing in
  // its middle touches neither face, and a two-sided push would only ever push it back inwards.
  const { collision } = models("door", 2);
  const colliders = new GameObjectColliders(collision, undefined, templates);
  const door = gameObject(DOOR, { state: GO_STATE_ACTIVE, position: DOOR_POSE });
  const objects = new Map([[DOOR, door]]);
  const self = { guid: SELF, typeId: 4, position: { x: 100, y: 202, z: 0, orientation: 0 }, fields: new Map() };
  const motion = newCharacterMotion();
  const base = flat();
  colliders.frame(objects, self, base, motion, 0);
  door.fields.set(BYTES_1, (GO_TYPE_DOOR << 8) | GO_STATE_READY);
  const step = 1 / 60;
  let now = 16;
  for (let frame = 0; frame < 90; frame++, now += 16) {
    const used = colliders.frame(objects, self, base, motion, now);
    stepCharacter(self.position, motion, input({ forward: 1 }), used, step);
  }
  assert.ok(self.position.x > 101.3, `walked out of the gate it stood in (${self.position.x})`);
  assert.equal(colliders.active, 1, "and the closed gate is a collider again");
  // Back towards it from the far side: stopped at its face like any closed door.
  self.position.orientation = Math.PI;
  for (let frame = 0; frame < 90; frame++, now += 16) {
    const used = colliders.frame(objects, self, base, motion, now);
    stepCharacter(self.position, motion, input({ forward: 1 }), used, step);
  }
  assert.ok(self.position.x > 101.3 && self.position.x < 101.5, `held at the far face (${self.position.x})`);
});

test("an unknown state, an unknown type or a missing model makes no collider, exactly as before", () => {
  const cases = [
    ["no GAMEOBJECT_BYTES_1 yet", gameObject(DOOR, { position: DOOR_POSE, bytes: null }), "door"],
    ["a state byte the core never writes", gameObject(DOOR, { position: DOOR_POSE, bytes: (GO_TYPE_DOOR << 8) | 3 }), "door"],
    ["a chest, not a door", gameObject(DOOR, { type: 3, position: DOOR_POSE }), "door"],
    ["no .dtree row (the core has no collision for it)", gameObject(DOOR, { position: DOOR_POSE }), "none"],
    ["the model still loading (an old gateway answers 404)", gameObject(DOOR, { position: DOOR_POSE }), "loading"],
    ["the template not answered yet", gameObject(DOOR, { position: DOOR_POSE, entry: UNKNOWN_ENTRY }), "door"],
    // GameObjectData.h:59: the client reads startOpen to tell what READY means; the core ignores it
    // (GameObject.cpp:2700). Where they may disagree, nothing is solid.
    ["a startOpen door at READY", gameObject(DOOR, { position: DOOR_POSE, entry: START_OPEN_ENTRY }), "door"],
  ];
  for (const [name, door, answer] of cases) {
    const { collision } = models(answer);
    const colliders = new GameObjectColliders(collision, undefined, templates);
    const { position, probe, base } = walkEast(colliders, new Map([[DOOR, door]]));
    assert.equal(probe, base, `${name}: the world probe itself`);
    assert.ok(position.x > 103, `${name}: walked through (${position.x})`);
  }
  assert.equal(doorSolid(gameObject(DOOR, { position: DOOR_POSE, bytes: null }), CLOSED_DOOR), undefined);
  assert.equal(doorSolid(gameObject(DOOR, { position: DOOR_POSE }), undefined), undefined);
  assert.equal(doorSolid(gameObject(DOOR, { position: DOOR_POSE }), START_OPEN_DOOR), undefined);
  assert.equal(doorSolid(gameObject(DOOR, { state: GO_STATE_ACTIVE, position: DOOR_POSE }), START_OPEN_DOOR), false);
  assert.equal(doorSolid(gameObject(DOOR, { position: DOOR_POSE, bytes: (GO_TYPE_DOOR << 8) | 3 }), CLOSED_DOOR), undefined);
});

test("doors out of range are not asked for and their meshes are let go", () => {
  const { collision, asked } = models();
  const colliders = new GameObjectColliders(collision, undefined, templates);
  const far = gameObject(DOOR, { position: { ...DOOR_POSE, x: 100 + COLLIDER_RANGE + 5 } });
  const objects = new Map([[DOOR, far]]);
  const self = { guid: SELF, typeId: 4, position: { x: 100, y: 202, z: 0, orientation: 0 }, fields: new Map() };
  const base = flat();
  assert.equal(colliders.frame(objects, self, base, newCharacterMotion(), 0), base);
  assert.equal(asked.length, 0, "no model asked for a door beyond the range");

  far.position.x = 101;
  colliders.frame(objects, self, base, newCharacterMotion(), 16);
  assert.equal(collision.size, 1);
  far.position.x = 100 + COLLIDER_RANGE + 5;
  colliders.frame(objects, self, base, newCharacterMotion(), 32);
  assert.equal(collision.size, 0, "the mesh of a door left behind is released");
});

test("the static world still answers first: its floor, its wall push, its readiness", () => {
  const wall = new CollisionWorld();
  // A floor at z = 2 under x ∈ [0, 10] from the static world, and the door's slab beside it.
  const floor = new CollisionMesh(Float32Array.from([0, 0, 2, 10, 0, 2, 10, 10, 2, 0, 0, 2, 10, 10, 2, 0, 10, 2]), [
    { first: 0, flags: 0x8, groupIndex: 0, groupId: 1 },
  ]);
  wall.set(1, floor);
  const base = {
    ground: () => 0, liquid: () => undefined, hole: () => false, loaded: () => false,
    floor: (x, y, from, min) => wall.floorUnder(x, y, from, min),
    pushOut: (x, y) => ({ x: x + 1, y }),
  };
  const probe = new DynamicColliderProbe(base);
  assert.deepEqual(probe.pushOut(3, 4, 0, 0.4, 2), { x: 4, y: 4 }, "the world's wall push");
  assert.equal(probe.loaded(5, 5), false, "the world's readiness, not the door's");
  assert.ok(Math.abs(probe.floor(5, 5, 10, -10) - 2) < 1e-4, "no colliders: the world's floor");
  const { collision } = models();
  probe.colliders[0] = { guid: DOOR, world: collision.forObject(gameObject(DOOR, { position: DOOR_POSE }), CLOSED_DOOR), pose: { x: 5, y: 5, z: 0, orientation: 0 } };
  probe.count = 1;
  assert.ok(Math.abs(probe.floor(6, 5, 10, -10) - 5) < 1e-4, "the higher of the two wins");
  assert.ok(Math.abs(probe.floor(2, 5, 10, -10) - 2) < 1e-4, "off the slab: the world's floor still");
});
