import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_COLLISION_HEIGHT, GRAVITY, JUMP_VELOCITY, MAX_WALKABLE_SLOPE_DEGREES, STEP_HEIGHT,
  TERMINAL_VELOCITY, newCharacterMotion, stepCharacter,
} from "../dist/code/browser/game/Physics.js";

/** A world made of a few functions, which is all the simulation is allowed to ask about. */
function world({ ground = () => 0, liquid = () => undefined, hole = () => false, floor, pushOut } = {}) {
  const probe = { ground, liquid, hole };
  if (floor) probe.floor = floor;
  if (pushOut) probe.pushOut = pushOut;
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
  assert.equal(MAX_WALKABLE_SLOPE_DEGREES, 55);
  // Six navmesh cells of 0.2666666, which is the height the server's own generator says is a step.
  assert.ok(Math.abs(STEP_HEIGHT - 1.6) < 0.001, `step height is ${STEP_HEIGHT}`);
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
  assert.equal(position.z, 0, "the surface is a ceiling, not a launch pad");
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
