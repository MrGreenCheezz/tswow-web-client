import assert from "node:assert/strict";
import test from "node:test";
import {
  CEILING_MARGIN, DEFAULT_COLLISION_HEIGHT, GRAVITY, JUMP_VELOCITY, LIQUID_RECALL_YARDS, LIQUID_UNKNOWN,
  LOAD_WAIT_MAX, MAX_WALKABLE_SLOPE_DEGREES, STEP_DOWN, STEP_HEIGHT, SWIM_SETTLE_SPEED, TERMINAL_VELOCITY,
  newCharacterMotion, stepCharacter, swimSurfaceOffset,
} from "../dist/code/browser/game/Physics.js";

/** A world made of a few functions, which is all the simulation is allowed to ask about. */
function world({ ground = () => 0, liquid = () => undefined, hole = () => false, floor, pushOut, ceiling, loaded } = {}) {
  const probe = { ground, liquid, hole };
  if (floor) probe.floor = floor;
  if (pushOut) probe.pushOut = pushOut;
  if (ceiling) probe.ceiling = ceiling;
  if (loaded) probe.loaded = loaded;
  return probe;
}

/** Everything the character is, with sensible dry-land defaults. */
function input(overrides = {}) {
  return {
    forward: 0, strafe: 0, ascend: false, descend: false, pitch: 0,
    runSpeed: 7, swimSpeed: 4.722222, flightSpeed: 7,
    collisionHeight: DEFAULT_COLLISION_HEIGHT,
    radius: 0.389,
    rooted: false, waterWalking: false, featherFall: false,
    hovering: false, hoverHeight: 0, canFly: false, gravityDisabled: false,
    ...overrides,
  };
}

const at = (x = 0, y = 0, z = 0, orientation = 0) => ({ x, y, z, orientation });

/** Runs the simulation at a fixed step and collects everything it reported. */
function simulate(position, motion, characterInput, probe, seconds, step = 1 / 60) {
  const events = [];
  for (let elapsed = 0; elapsed < seconds; elapsed += step) {
    events.push(...stepCharacter(position, motion, characterInput, probe, step));
  }
  return events;
}

test("the constants are the ones the server computes falls with", () => {
  // Not decoration: `Movement::gravity` and `terminalVelocity` are what `computeFallTime` uses,
  // and a client that falls at a different rate reports a fall the server did not see.
  assert.equal(GRAVITY, 19.29110527038574);
  assert.equal(TERMINAL_VELOCITY, 60.148003);
  assert.equal(DEFAULT_COLLISION_HEIGHT, 2.03128);
  // 5.07: Wow.exe's walkable test compares the normal with cos 50° (0x00a37f0c); the step-up budget
  // of a player-controlled mover is its scale ratio, max(1, scale) (0x006e9520 → mover+0xd0, set
  // by 0x006e9570 from 0x006d78c0/0x006cf350): one yard; the drop that starts a fall keeps 1.6.
  assert.equal(MAX_WALKABLE_SLOPE_DEGREES, 50);
  assert.equal(STEP_HEIGHT, 1.0);
  assert.ok(Math.abs(STEP_DOWN - 1.6) < 0.001, `step down is ${STEP_DOWN}`);
  // Wow.exe's jump takes -7.955547 (0x00aa33dc), positive up here.
  assert.equal(JUMP_VELOCITY, 7.955547);
});

test("a jump rises to the height the impulse and the gravity agree on, and comes back down", () => {
  const position = at(0, 0, 0);
  const motion = newCharacterMotion();
  const flat = world();

  const first = stepCharacter(position, motion, input({ ascend: true }), flat, 1 / 60);
  assert.deepEqual(first, ["jump"]);
  assert.equal(motion.mode, "air");
  assert.equal(motion.jump?.velocity, JUMP_VELOCITY);

  let apex = 0;
  const rest = simulate(position, motion, input(), flat, 2);
  assert.ok(rest.includes("land"), "the jump has to end on the ground");

  // Re-run it sampling the top, since the apex is what a player feels.
  const second = at(0, 0, 0);
  const secondMotion = newCharacterMotion();
  stepCharacter(second, secondMotion, input({ ascend: true }), flat, 1 / 60);
  for (let step = 0; step < 200 && secondMotion.mode === "air"; step++) {
    stepCharacter(second, secondMotion, input(), flat, 1 / 240);
    apex = Math.max(apex, second.z);
  }
  const expected = (JUMP_VELOCITY * JUMP_VELOCITY) / (2 * GRAVITY);
  assert.ok(Math.abs(apex - expected) < 0.05, `apex ${apex} against ${expected}`);
  assert.equal(second.z, 0, "and it lands exactly on the floor, not a little through it");
});

test("a fall is clocked in milliseconds, because that is what the server charges damage on", () => {
  const position = at(0, 0, 50);
  const motion = newCharacterMotion();
  const events = simulate(position, motion, input(), world(), 0.5);
  assert.deepEqual(events, ["startFall"], "one report, on the frame the ground went away");
  assert.equal(motion.mode, "air");
  // Half a second of gravity, give or take one step of integration.
  assert.ok(Math.abs(motion.fallTime - 500) < 20, `fall time ${motion.fallTime}`);
  assert.ok(motion.velocityZ < -9 && motion.velocityZ > -10.2, `velocity ${motion.velocityZ}`);
  // The block every airborne packet carries has to be there from the first frame of the fall.
  assert.equal(motion.jump?.velocity, 0, "a walked-off ledge is a fall with no impulse");
  assert.ok(motion.jump);
});

test("a fall stops accelerating at terminal velocity", () => {
  const position = at(0, 0, 5000);
  const motion = newCharacterMotion();
  simulate(position, motion, input(), world(), 20);
  assert.ok(Math.abs(motion.velocityZ + TERMINAL_VELOCITY) < 0.001, `velocity ${motion.velocityZ}`);
  // Feather Fall caps it far lower, which is the whole of what the aura does to a fall.
  const slow = at(0, 0, 5000);
  const slowMotion = newCharacterMotion();
  simulate(slow, slowMotion, input({ featherFall: true }), world(), 20);
  assert.ok(Math.abs(slowMotion.velocityZ + 7) < 0.001, `velocity ${slowMotion.velocityZ}`);
});

test("walking off a ledge falls rather than skating down it", () => {
  // A cliff: everything past x = 1 is thirty yards lower.
  const cliff = world({ ground: (x) => (x > 1 ? -30 : 0) });
  const position = at(0, 0, 0);
  const motion = newCharacterMotion();
  const events = simulate(position, motion, input({ forward: 1 }), cliff, 0.5);
  assert.ok(events.includes("startFall"));
  assert.ok(position.z < -1, `still at ${position.z}`);
  assert.ok(position.z > -30, "and not teleported to the bottom either");
});

test("a step is walked over and a wall is not", () => {
  // A stair riser. Vertical, and refused by any slope rule read literally — which is exactly why
  // the server's own navmesh has a second parameter for it.
  const step = world({ ground: (x) => (x > 1 ? 0.4 : 0) });
  const low = at(0, 0, 0);
  simulate(low, newCharacterMotion(), input({ forward: 1 }), step, 0.5);
  assert.ok(low.x > 1, "the character walked past the lip");
  assert.ok(Math.abs(low.z - 0.4) < 0.001, `stood at ${low.z}`);

  // A vertical face taller than a step is not climbed, and the character is not lifted onto it.
  const wall = world({ ground: (x) => (x > 1 ? 40 : 0) });
  const high = at(0, 0, 0);
  simulate(high, newCharacterMotion(), input({ forward: 1 }), wall, 0.5);
  assert.equal(high.z, 0, `lifted to ${high.z}`);
});

test("too steep to climb is slid along rather than stuck against", () => {
  // A hill rising in x alone, well past the walkable angle.
  const hill = world({ ground: (x) => Math.max(0, x) * 4 });
  const straightUp = at(0, 0, 0);
  simulate(straightUp, newCharacterMotion(), input({ forward: 1 }), hill, 0.5);
  assert.ok(straightUp.x < 0.05, `climbed to x ${straightUp.x}`);

  // Walking across the same hill is along its contour and has to be allowed: the gradient points
  // up x, and a move up y takes nothing away from it.
  const along = at(0, 0, 0, Math.PI / 2);
  simulate(along, newCharacterMotion(), input({ forward: 1 }), hill, 0.5);
  assert.ok(along.y > 3, `walked only ${along.y} along the contour`);

  // And downhill is never refused.
  const down = at(0, 0, 0, Math.PI);
  simulate(down, newCharacterMotion(), input({ forward: 1 }), hill, 0.5);
  assert.ok(down.x < -3, `walked only ${down.x} downhill`);
});

test("deep enough water is swum in, shallow water is waded through", () => {
  const lake = world({ ground: () => -10, liquid: () => ({ height: 0, type: 1 }) });
  const swimmer = at(0, 0, -10);
  const motion = newCharacterMotion();
  const events = stepCharacter(swimmer, motion, input(), lake, 1 / 60);
  assert.ok(events.includes("startSwim"));
  assert.equal(motion.mode, "swim");

  // Ankle deep: the surface is barely above the ground, so there is nothing to swim in.
  const puddle = world({ ground: () => 0, liquid: () => ({ height: 0.3, type: 1 }) });
  const wader = at(0, 0, 0);
  const waderMotion = newCharacterMotion();
  assert.deepEqual(stepCharacter(wader, waderMotion, input(), puddle, 1 / 60), []);
  assert.equal(waderMotion.mode, "ground");
});

test("a swimmer floats at the surface and cannot rise out of it", () => {
  const lake = world({ ground: () => -10, liquid: () => ({ height: 0, type: 1 }) });
  const position = at(0, 0, -5);
  const motion = newCharacterMotion();
  stepCharacter(position, motion, input(), lake, 1 / 60);
  assert.equal(motion.mode, "swim");

  const events = simulate(position, motion, input({ ascend: true }), lake, 3);
  // 5.06: the float line is under the surface — feet at it would be "walking on water" to the server.
  assert.ok(Math.abs(position.z + swimSurfaceOffset(DEFAULT_COLLISION_HEIGHT)) < 0.005,
    `the surface is a ceiling, not a launch pad: ${position.z}`);
  assert.ok(Math.abs(swimSurfaceOffset(DEFAULT_COLLISION_HEIGHT) - 1.45) < 0.005);
  // Rising is its own opcode, and it is sent once rather than every frame.
  assert.equal(events.filter((event) => event === "startAscend").length, 1);
});

test("a swimmer sinks to the bottom and no further", () => {
  const lake = world({ ground: () => -10, liquid: () => ({ height: 0, type: 1 }) });
  const position = at(0, 0, -1);
  const motion = newCharacterMotion();
  stepCharacter(position, motion, input(), lake, 1 / 60);
  simulate(position, motion, input({ descend: true }), lake, 10);
  assert.equal(position.z, -10);
  assert.equal(motion.vertical, -1);
});

test("swimming out over dry land falls rather than hanging in the air", () => {
  // Liquid only where x is negative: swimming forward leaves it.
  const shore = world({ ground: () => -20, liquid: (x) => (x < 0 ? { height: 0, type: 1 } : undefined) });
  const position = at(-1, 0, -2);
  const motion = newCharacterMotion();
  stepCharacter(position, motion, input(), shore, 1 / 60);
  assert.equal(motion.mode, "swim");
  const events = simulate(position, motion, input({ forward: 1 }), shore, 1);
  assert.ok(events.includes("stopSwim") && events.includes("startFall"));
});

test("a falling character that hits water swims instead of dying", () => {
  const lake = world({ ground: () => -30, liquid: () => ({ height: 0, type: 1 }) });
  const position = at(0, 0, 60);
  const motion = newCharacterMotion();
  const events = simulate(position, motion, input(), lake, 6);
  assert.ok(events.includes("startFall"));
  assert.ok(events.includes("startSwim"));
  assert.ok(!events.includes("land"), "the lake bed is thirty yards down and was never reached");
  assert.equal(motion.mode, "swim");
  assert.equal(motion.fallTime, 0, "and the fall clock is cleared, so no damage is claimed");
});

test("water walking makes the surface the floor", () => {
  const lake = world({ ground: () => -10, liquid: () => ({ height: 0, type: 1 }) });
  const position = at(0, 0, 0);
  const motion = newCharacterMotion();
  const events = simulate(position, motion, input({ forward: 1, waterWalking: true }), lake, 1);
  assert.deepEqual(events, []);
  assert.equal(motion.mode, "ground");
  assert.equal(position.z, 0, "walked across the top of it");
});

test("hovering holds the character its own height off the ground", () => {
  const position = at(0, 0, 0);
  const motion = newCharacterMotion();
  simulate(position, motion, input({ hovering: true, hoverHeight: 2.5 }), world(), 1);
  assert.equal(position.z, 2.5);
});

test("the liquid is asked at the character's own feet, not of the whole column", () => {
  // The server answers it for the floor under the feet (`Map::GetFullTerrainStatusForPosition`),
  // so a dry gallery can stand over a flooded cistern. A probe never told the height could only
  // answer for the column — which is how a dungeon's pools went unseen, or a cellar under a lake
  // was swum in.
  const asked = [];
  const cistern = world({
    ground: () => -10,
    floor: (_x, _y, fromZ, minZ) => (fromZ >= 0 && minZ <= 0 ? 0 : undefined),
    liquid: (_x, _y, z) => {
      asked.push(z);
      return z < 0 ? { height: -2, type: 13 } : undefined;
    },
  });
  const position = at(0, 0, 0);
  const motion = newCharacterMotion();
  const events = simulate(position, motion, input({ forward: 1 }), cistern, 0.5);
  assert.deepEqual(events, []);
  assert.equal(motion.mode, "ground");
  assert.ok(asked.length > 0 && asked.every((z) => z === 0), `asked at ${asked.slice(0, 4)}`);
});

test("an unknown liquid answer keeps a swimmer swimming at the surface it last knew", () => {
  // Streaming collision answers "not yet", not "dry". Read as dry, the swimmer would drop to the
  // bed for those frames and start swimming again after: a stop/start pair per tile that streams.
  let known = true;
  const lake = world({ ground: () => -10, liquid: () => (known ? { height: 0, type: 1 } : LIQUID_UNKNOWN) });
  const position = at(0, 0, -5);
  const motion = newCharacterMotion();
  stepCharacter(position, motion, input(), lake, 1 / 60);
  assert.equal(motion.mode, "swim");
  known = false;
  const events = simulate(position, motion, input({ ascend: true }), lake, 2);
  assert.equal(motion.mode, "swim");
  assert.ok(!events.includes("stopSwim") && !events.includes("startFall"), events.join());
  assert.ok(Math.abs(position.z + swimSurfaceOffset(DEFAULT_COLLISION_HEIGHT)) < 0.005,
    `and the remembered surface is still the ceiling: ${position.z}`);
});

test("an unknown liquid answer never starts a swim on its own", () => {
  const unknown = world({ ground: () => -10, liquid: () => LIQUID_UNKNOWN });
  const position = at(0, 0, -10);
  const motion = newCharacterMotion();
  const events = simulate(position, motion, input({ forward: 1 }), unknown, 1);
  assert.deepEqual(events, []);
  assert.equal(motion.mode, "ground");
});

test("an unknown liquid answer is the last one only near where that one was given", () => {
  // One liquid cell on, the remembered surface would be somebody else's water: a swimmer going on
  // through a gap that never closes comes out of the water rather than swimming on through the air.
  let known = true;
  const lake = world({ ground: () => -20, liquid: () => (known ? { height: 0, type: 1 } : LIQUID_UNKNOWN) });
  const position = at(0, 0, -2);
  const motion = newCharacterMotion();
  stepCharacter(position, motion, input(), lake, 1 / 60);
  assert.equal(motion.mode, "swim");
  known = false;
  let leftAt;
  for (let elapsed = 0; elapsed < 3 && leftAt === undefined; elapsed += 1 / 60) {
    if (stepCharacter(position, motion, input({ forward: 1 }), lake, 1 / 60).includes("stopSwim")) leftAt = position.x;
  }
  assert.ok(leftAt !== undefined, "it came out of the water");
  assert.ok(leftAt > LIQUID_RECALL_YARDS && leftAt < LIQUID_RECALL_YARDS + 0.1, `left at ${leftAt}`);
});

test("a water walker stays on the water through an unknown liquid answer", () => {
  let known = true;
  const lake = world({ ground: () => -10, liquid: () => (known ? { height: 0, type: 1 } : LIQUID_UNKNOWN) });
  const position = at(0, 0, 0);
  const motion = newCharacterMotion();
  simulate(position, motion, input({ waterWalking: true }), lake, 0.1);
  known = false;
  const events = simulate(position, motion, input({ waterWalking: true }), lake, 1);
  assert.deepEqual(events, [], "no fall onto the lake bed and no landing back on the water");
  assert.equal(position.z, 0);

  // And walks off it onto the bank: the slope probes ahead stand on the same remembered water, or
  // the half-yard bank would look like a ten-yard wall rising out of the lake bed.
  const shore = world({
    ground: (x) => (x > 0.5 ? 0.5 : -10),
    liquid: () => (known ? { height: 0, type: 1 } : LIQUID_UNKNOWN),
  });
  known = true;
  const walker = at(0, 0, 0);
  const walkerMotion = newCharacterMotion();
  simulate(walker, walkerMotion, input({ waterWalking: true }), shore, 0.1);
  known = false;
  assert.deepEqual(simulate(walker, walkerMotion, input({ forward: 1, waterWalking: true }), shore, 0.5), []);
  assert.ok(walker.x > 2, `stopped at ${walker.x}`);
  assert.equal(walker.z, 0.5);
});

test("a character the server has let fly does not fall", () => {
  const position = at(0, 0, 50);
  const motion = newCharacterMotion();
  const events = simulate(position, motion, input({ canFly: true }), world(), 2);
  assert.equal(position.z, 50, "gravity is off, so it hangs there");
  assert.deepEqual(events, ["startFall"], "it is airborne, and says so once");

  const rising = simulate(position, motion, input({ canFly: true, ascend: true }), world(), 1);
  assert.ok(position.z > 55, `rose only to ${position.z}`);
  assert.deepEqual(rising, ["startAscend"]);
});

test("a rooted character cannot walk but still falls", () => {
  const flat = at(0, 0, 0);
  simulate(flat, newCharacterMotion(), input({ forward: 1, rooted: true }), world(), 1);
  assert.equal(flat.x, 0);

  const dropping = at(0, 0, 40);
  const motion = newCharacterMotion();
  simulate(dropping, motion, input({ forward: 1, rooted: true }), world(), 1);
  assert.ok(dropping.z < 35, `root stopped gravity as well: ${dropping.z}`);
  assert.equal(dropping.x, 0);
});

test("a hole in the ground is fallen through", () => {
  const position = at(0, 0, 0);
  const motion = newCharacterMotion();
  const events = simulate(position, motion, input(), world({ hole: () => true }), 1);
  assert.ok(events.includes("startFall"));
  assert.ok(position.z < -5);
});

test("a tile that has not arrived is waited on, not fallen through", () => {
  // The one case that is not a hole and must never be treated as one: the terrain client answers
  // undefined for a tile still in flight, and a character that falls through those falls for the
  // whole of a zone crossing.
  const position = at(0, 0, 12);
  const motion = newCharacterMotion();
  const events = simulate(position, motion, input({ forward: 1 }), world({ ground: () => undefined }), 1);
  assert.deepEqual(events, []);
  assert.equal(position.z, 12);
  assert.equal(motion.mode, "ground");
});

test("a building's own floor is what is stood on, not the ground under the building", () => {
  // The tavern. The terrain says nothing about the first storey; the server's collision geometry
  // does, and without asking it the player stands in the grass beneath the building.
  const storeys = [0, 4.5];
  const building = world({
    ground: () => 0,
    floor: (_x, _y, fromZ, minZ) => {
      const found = storeys.filter((z) => z <= fromZ && z >= minZ);
      return found.length === 0 ? undefined : Math.max(...found);
    },
  });

  const upstairs = at(0, 0, 4.5);
  const motion = newCharacterMotion();
  const events = simulate(upstairs, motion, input({ forward: 1 }), building, 1);
  assert.deepEqual(events, [], "the upper floor holds, so there is nothing to report");
  assert.equal(upstairs.z, 4.5);

  // Downstairs the same query answers with the lower floor, because the upper one is overhead.
  const downstairs = at(0, 0, 0);
  simulate(downstairs, newCharacterMotion(), input({ forward: 1 }), building, 1);
  assert.equal(downstairs.z, 0);
});

test("walking under a bridge walks under it", () => {
  // The deck is five yards up, well over a step: it is not the floor from below, and it is from
  // above. Both answers come out of the same query.
  const bridge = world({
    ground: () => 0,
    floor: (_x, _y, fromZ, minZ) => (5 <= fromZ && 5 >= minZ ? 5 : undefined),
  });
  const under = at(0, 0, 0);
  simulate(under, newCharacterMotion(), input({ forward: 1 }), bridge, 1);
  assert.equal(under.z, 0, "lifted onto the bridge from underneath");

  const over = at(0, 0, 5);
  simulate(over, newCharacterMotion(), input({ forward: 1 }), bridge, 1);
  assert.equal(over.z, 5, "fell through the deck");
});

test("a wall stops the character where the collision world puts it", () => {
  // The probe is the whole of what the physics knows about walls: it moves, it is told where it
  // really ended up, and that is the position everything else is computed from.
  const walled = world({
    pushOut: (x, y) => ({ x: Math.min(x, 3), y }),
  });
  const position = at(0, 0, 0);
  simulate(position, newCharacterMotion(), input({ forward: 1 }), walled, 2);
  assert.ok(Math.abs(position.x - 3) < 1e-6, `walked through to ${position.x}`);
});

test("the push out happens before the floor is looked for, not after", () => {
  // Order matters. Past x = 3 the ground steps down half a yard — walkable, so nothing else stops
  // the character there — and a wall holds it at three. Asking what is underfoot at the refused
  // position rather than the real one would drop the character half a yard for a step it never took.
  const probe = world({
    ground: (x) => (x > 3.02 ? -0.5 : 0),
    pushOut: (x, y) => ({ x: Math.min(x, 3), y }),
  });
  const position = at(0, 0, 0);
  simulate(position, newCharacterMotion(), input({ forward: 1 }), probe, 2);
  assert.ok(Math.abs(position.x - 3) < 1e-6, `walked through to ${position.x}`);
  assert.equal(position.z, 0, "stood on the ground beyond the wall it never reached");
});

// ---- 5.07 thresholds -------------------------------------------------------------------------

test("5.07: a 0.9-yard riser is stepped onto, a 1.2-yard ledge is a wall on foot and is taken with a jump", () => {
  // Wow.exe lifts a player by up to one yard to get over what it walked into (0x00761b00).
  const riser = world({ ground: (x) => (x > 1 ? 0.9 : 0) });
  const stepper = at(0, 0, 0);
  simulate(stepper, newCharacterMotion(), input({ forward: 1 }), riser, 0.5);
  assert.ok(stepper.x > 1, `stopped at the riser at x ${stepper.x}`);
  assert.equal(stepper.z, 0.9);

  const ledge = world({ ground: (x) => (x > 1 ? 1.2 : 0) });
  const walker = at(0, 0, 0);
  simulate(walker, newCharacterMotion(), input({ forward: 1 }), ledge, 0.5);
  assert.ok(walker.x < 1, `walked onto the ledge at x ${walker.x}`);
  assert.equal(walker.z, 0);

  const jumper = at(0, 0, 0);
  const motion = newCharacterMotion();
  stepCharacter(jumper, motion, input({ forward: 1, ascend: true }), ledge, 1 / 60);
  simulate(jumper, motion, input({ forward: 1 }), ledge, 1);
  assert.ok(jumper.x > 1, `jumped only to x ${jumper.x}`);
  assert.equal(jumper.z, 1.2, "landed on top of the ledge");
  assert.equal(motion.mode, "ground");
});

test("5.07: 52 degrees is not climbed, 48 degrees is", () => {
  const steep = world({ ground: (x) => Math.max(0, x) * Math.tan(52 * Math.PI / 180) });
  const blocked = at(0, 0, 0);
  simulate(blocked, newCharacterMotion(), input({ forward: 1 }), steep, 1);
  assert.ok(blocked.x < 0.05, `climbed 52° to x ${blocked.x}`);

  const gentle = world({ ground: (x) => Math.max(0, x) * Math.tan(48 * Math.PI / 180) });
  const climber = at(0, 0, 0);
  simulate(climber, newCharacterMotion(), input({ forward: 1 }), gentle, 1);
  assert.ok(climber.x > 3, `stuck on 48° at x ${climber.x}`);
});

// L8 5.07: was «a one-yard drop is walked down» — Wow.exe probes down 1.8494 × the step (0x007620f0), so at a
// 7 yd/s run and 60 frames a second only 0.216 yard is walked down and the yard is a short fall that lands on
// it (tests/physics-step-down.test.mjs has the probe itself).
// L8-review 5.07: the probe alone is not the rule — the foot's face holds an edge down to (0.389 + 0.1167) × 1.8494 =
// 0.935 yard here (Physics.footHolds); the yard is still past it, so it still falls (physics-step-down has the foot).
test("5.07: a one-yard drop is a short fall that lands on it, a two-yard drop is a fall", () => {
  const kerb = world({ ground: (x) => (x > 1 ? -1.0 : 0) });
  const down = at(0, 0, 0);
  const downEvents = simulate(down, newCharacterMotion(), input({ forward: 1 }), kerb, 0.5);
  assert.deepEqual(downEvents, ["startFall", "land"], downEvents.join()); // L8 5.07: was «no startFall»
  assert.equal(down.z, -1.0);

  const drop = world({ ground: (x) => (x > 1 ? -2.0 : 0) });
  const off = at(0, 0, 0);
  const offEvents = simulate(off, newCharacterMotion(), input({ forward: 1 }), drop, 0.5);
  assert.ok(offEvents.includes("startFall"), offEvents.join());
});

// ---- 5.12 ceilings ---------------------------------------------------------------------------

const ceilingAt = (height) => (_x, _y, from, to) => (from <= height && to >= height ? height : undefined);

test("5.12: a jump under a low ceiling stops the head and still lands", () => {
  let asked = 0;
  const ceiling = ceilingAt(3);
  const room = world({ ceiling: (...args) => { asked++; return ceiling(...args); } });
  const position = at(0, 0, 0);
  const motion = newCharacterMotion();
  let top = 0;
  const events = [];
  for (let t = 0; t < 2; t += 1 / 60) {
    events.push(...stepCharacter(position, motion, input({ ascend: t === 0 }), room, 1 / 60));
    top = Math.max(top, position.z);
  }
  assert.ok(top <= 3 - DEFAULT_COLLISION_HEIGHT - CEILING_MARGIN + 1e-6, `head reached ${top + DEFAULT_COLLISION_HEIGHT}`);
  assert.ok(events.includes("land"), events.join());
  assert.equal(position.z, 0);
  asked = 0;
  simulate(position, motion, input({ forward: 1 }), room, 1);
  assert.equal(asked, 0, "walking never asks for a ceiling");
});

test("5.12: a flier rising and a swimmer surfacing stop under what is above them", () => {
  const position = at(0, 0, 0);
  const motion = newCharacterMotion();
  simulate(position, motion, input({ canFly: true, ascend: true }), world({ ceiling: ceilingAt(10) }), 3);
  assert.ok(position.z + DEFAULT_COLLISION_HEIGHT <= 10 + 1e-6, `flew through to ${position.z}`);
  assert.ok(position.z > 7, `stopped short at ${position.z}`);

  const dock = world({ ground: () => -10, liquid: () => ({ height: 0, type: 1 }), ceiling: ceilingAt(-3) });
  const swimmer = at(0, 0, -9);
  const swim = newCharacterMotion();
  stepCharacter(swimmer, swim, input(), dock, 1 / 60);
  simulate(swimmer, swim, input({ ascend: true }), dock, 3);
  assert.ok(swimmer.z + DEFAULT_COLLISION_HEIGHT <= -3 + 1e-6, `surfaced through the dock to ${swimmer.z}`);
});

// ---- 5.13 ground that has not arrived ---------------------------------------------------------

test("5.13: ground that has not arrived is waited at, then walked onto once it lands", () => {
  let ready = false;
  const streaming = world({ ground: (x) => (x > 0.5 && !ready ? undefined : 0), loaded: (x) => x <= 0.5 || ready });
  const position = at(0, 0, 0);
  const motion = newCharacterMotion();
  const events = simulate(position, motion, input({ forward: 1 }), streaming, 1);
  assert.ok(position.x <= 0.5, `walked onto missing ground to x ${position.x}`);
  assert.deepEqual(events, []);
  ready = true;
  simulate(position, motion, input({ forward: 1 }), streaming, 0.5);
  assert.ok(position.x > 2, `did not move on after the tile came: ${position.x}`);
});

test("5.13: a fall over ground that has not arrived waits, and the wait runs out", () => {
  const nothing = world({ ground: () => undefined, loaded: () => false });
  const position = at(0, 0, 50);
  const motion = newCharacterMotion();
  motion.mode = "air";
  simulate(position, motion, input(), nothing, 1);
  assert.equal(position.z, 50);
  assert.equal(motion.fallTime, 0);
  simulate(position, motion, input(), nothing, LOAD_WAIT_MAX / 1000 + 1);
  assert.ok(position.z < 50, "a tile that never comes must not hold the character for good");
});

// ---- 5.06 floating ----------------------------------------------------------------------------

test("5.06: the float line stays IN_WATER for any height", () => {
  for (const height of [1.2, 2.03128, 3.0]) {
    const lake = world({ ground: () => -20, liquid: () => ({ height: 0, type: 1 }) });
    const position = at(0, 0, -6);
    const motion = newCharacterMotion();
    stepCharacter(position, motion, input({ collisionHeight: height }), lake, 1 / 60);
    simulate(position, motion, input({ collisionHeight: height, ascend: true }), lake, 3);
    const delta = 0 - position.z;
    assert.ok(delta > 0 && delta < height, `height ${height}: surface - feet ${delta}`);
  }
});

test("5.06: entering waist deep sinks to the float line instead of jumping to it", () => {
  const lake = world({ ground: () => -20, liquid: () => ({ height: 0, type: 1 }) });
  const position = at(0, 0, -1.1);
  const motion = newCharacterMotion();
  stepCharacter(position, motion, input(), lake, 1 / 60);
  assert.equal(motion.mode, "swim");
  let last = position.z;
  for (let i = 0; i < 60; i++) {
    stepCharacter(position, motion, input(), lake, 1 / 60);
    assert.ok(last - position.z <= SWIM_SETTLE_SPEED / 60 + 1e-9, `a ${last - position.z} jump`);
    last = position.z;
  }
  assert.ok(Math.abs(position.z + swimSurfaceOffset(DEFAULT_COLLISION_HEIGHT)) < 0.005, `settled at ${position.z}`);
});

// ---- 5.08 backward rates ----------------------------------------------------------------------

test("5.08: backwards goes at the backward rate, sideways at the forward one", () => {
  const back = at(0, 0, 0);
  simulate(back, newCharacterMotion(), input({ forward: -1, runBackSpeed: 4.5 }), world(), 1);
  assert.ok(Math.abs(back.x + 4.5) < 0.1, `ran back ${back.x}`);
  const side = at(0, 0, 0);
  simulate(side, newCharacterMotion(), input({ strafe: 1, runBackSpeed: 4.5 }), world(), 1);
  assert.ok(Math.abs(side.y - 7) < 0.1, `strafed ${side.y}`);

  const lake = world({ ground: () => -20, liquid: () => ({ height: 0, type: 1 }) });
  const swimmer = at(0, 0, -5);
  const swim = newCharacterMotion();
  stepCharacter(swimmer, swim, input(), lake, 1 / 60);
  simulate(swimmer, swim, input({ forward: -1, swimBackSpeed: 2.5 }), lake, 1);
  assert.ok(Math.abs(swimmer.x + 2.5) < 0.1, `swam back ${swimmer.x}`);

  const flier = at(0, 0, 50);
  const fly = newCharacterMotion();
  fly.mode = "air";
  simulate(flier, fly, input({ canFly: true, forward: -1, flightSpeed: 7, flightBackSpeed: 4.5 }), world(), 1);
  assert.ok(Math.abs(flier.x + 4.5) < 0.1, `flew back ${flier.x}`);
});

// ---- 5.11 control -----------------------------------------------------------------------------

test("5.11: no jump under root, no step or jump under a stun, no rise in water under root", () => {
  const rooted = at(0, 0, 0);
  const motion = newCharacterMotion();
  assert.deepEqual(stepCharacter(rooted, motion, input({ ascend: true, rooted: true }), world(), 1 / 60), []);
  assert.equal(motion.mode, "ground");

  const stunned = at(0, 0, 0);
  const stun = newCharacterMotion();
  const events = simulate(stunned, stun, input({ forward: 1, ascend: true, stunned: true }), world(), 1);
  assert.deepEqual(events, []);
  assert.equal(stunned.x, 0);

  const lake = world({ ground: () => -20, liquid: () => ({ height: 0, type: 1 }) });
  const swimmer = at(0, 0, -10);
  const swim = newCharacterMotion();
  stepCharacter(swimmer, swim, input(), lake, 1 / 60);
  simulate(swimmer, swim, input({ ascend: true, rooted: true }), lake, 1);
  assert.equal(swimmer.z, -10);
});

// ---- 5.09 flight ------------------------------------------------------------------------------

test("5.09: on the ground with flight allowed the run rate applies", () => {
  const position = at(0, 0, 0);
  simulate(position, newCharacterMotion(), input({ canFly: true, forward: 1, runSpeed: 7, flightSpeed: 21 }), world(), 1);
  assert.ok(Math.abs(position.x - 7) < 0.1, `ran ${position.x}`);
});

test("5.09: flying forward follows the pitch, and the rate is live", () => {
  const position = at(0, 0, 100);
  const motion = newCharacterMotion();
  motion.mode = "air";
  stepCharacter(position, motion, input({ canFly: true, forward: 1, pitch: Math.PI / 6, flightSpeed: 21 }), world(), 1 / 60);
  assert.ok(Math.abs(motion.velocityZ - 10.5) < 0.01, `vertical ${motion.velocityZ}`);
  const x0 = position.x;
  stepCharacter(position, motion, input({ canFly: true, forward: 1, pitch: Math.PI / 6, flightSpeed: 21 }), world(), 1);
  assert.ok(Math.abs(position.x - x0 - 21 * Math.cos(Math.PI / 6)) < 0.01, `horizontal ${position.x - x0}`);
  const x1 = position.x;
  stepCharacter(position, motion, input({ canFly: true, forward: 1, pitch: 0, flightSpeed: 28 }), world(), 1);
  assert.ok(Math.abs(position.x - x1 - 28) < 0.01, `a faster rate waited for landing: ${position.x - x1}`);
});

test("5.09: losing flight in the air falls at the run rate", () => {
  const position = at(0, 0, 100);
  const motion = newCharacterMotion();
  motion.mode = "air";
  stepCharacter(position, motion, input({ canFly: true, forward: 1, flightSpeed: 28 }), world(), 1 / 60);
  stepCharacter(position, motion, input({ forward: 1, runSpeed: 7 }), world(), 1 / 60);
  const x0 = position.x;
  stepCharacter(position, motion, input({ forward: 1, runSpeed: 7 }), world(), 0.5);
  assert.ok(Math.abs(position.x - x0 - 3.5) < 0.01, `fell forward ${position.x - x0}`);
  assert.equal(motion.jump?.speed, 7);
  assert.ok(motion.velocityZ < 0);
});
