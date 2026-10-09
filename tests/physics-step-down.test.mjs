import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_COLLISION_HEIGHT, STEP_DOWN, STEP_DOWN_PER_YARD, newCharacterMotion, stepCharacter,
} from "../dist/code/browser/game/Physics.js";

// Lane L8 (WORK_PLAN 5.07, 04.10): how far the ground may fall away under a walking character before it
// falls. Wow.exe 3.3.5a 12340 (Ghidra read-only, .runtime/re-2026-10-02/a9-phys/p2.c, re-2026-10-04/
// l8-movement/g2.c): the frame's move (0x00762e00) hands the whole remaining distance to the ground sweep
// 0x007620f0, which after the horizontal sweep probes down param_4 × 1.8493990 (0x00a32830, tan 61.6°) and
// starts a fall (0x00988370(0)) when the probe finds nothing — the stickiness is proportional to the step,
// not a height. A character that does not move is not swept at all (0x00762e00 returns before the loop).
// L8-review (04.10): and the body that sweep moves stands on an upside-down pyramid of the same 1.8494, whose face
// rides an edge down — so kerbs and stairs are walked down at any frame rate (the pyramid-foot tests below).

function world(ground) {
  return { ground, liquid: () => undefined, hole: () => false };
}

function input(overrides = {}) {
  return {
    forward: 0, strafe: 0, ascend: false, descend: false, pitch: 0,
    runSpeed: 7, swimSpeed: 4.722222, flightSpeed: 7,
    collisionHeight: DEFAULT_COLLISION_HEIGHT, radius: 0.389,
    rooted: false, waterWalking: false, featherFall: false,
    hovering: false, hoverHeight: 0, canFly: false, gravityDisabled: false,
    ...overrides,
  };
}

function simulate(position, motion, characterInput, probe, seconds, step) {
  const events = [];
  for (let elapsed = 0; elapsed < seconds - 1e-9; elapsed += step) {
    events.push(...stepCharacter(position, motion, characterInput, probe, step));
  }
  return events;
}

test("the probe is Wow.exe's 1.8493990 a yard of step (0x00a32830); a standing character keeps the old 1.6", () => {
  assert.equal(STEP_DOWN_PER_YARD, 1.8493989706039429);
  assert.ok(Math.abs(Math.atan(STEP_DOWN_PER_YARD) * 180 / Math.PI - 61.6) < 0.01);
  assert.ok(Math.abs(STEP_DOWN - 1.6) < 0.001);
});

// L8-review 5.07: was «a kerb deeper than the step's probe is a short fall» (0.3 yard at 60 Hz). The probe is
// only half of Wow.exe's rule: the body it sweeps has a pyramid for a foot (below), whose face rests on the
// kerb's edge and slides down it, so a kerb is walked down; only a drop deeper than the foot is a fall.
test("a kerb deeper than the step's probe is walked down on the foot's face, a ledge deeper than the foot is a fall", () => {
  // At 60 frames a second a 7 yd/s run steps 0.1167 yards, so the probe alone reaches 0.2158 below the feet.
  const step = 1 / 60;
  const reach = 7 * step * STEP_DOWN_PER_YARD;
  const kerb = world((x) => (x > 1 ? -0.3 : 0));
  const walker = { x: 0, y: 0, z: 0, orientation: 0 };
  const walkEvents = simulate(walker, newCharacterMotion(), input({ forward: 1 }), kerb, 0.5, step);
  assert.ok(0.3 > reach);
  assert.deepEqual(walkEvents, [], "stepped down without a fall");
  assert.equal(walker.z, -0.3);

  // The foot is 0.389 yards from the centre to its side: its face reaches (0.389 + 0.1167) × 1.8494 = 0.935.
  const deep = world((x) => (x > 1 ? -1.2 : 0));
  const faller = { x: 0, y: 0, z: 0, orientation: 0 };
  const fallEvents = simulate(faller, newCharacterMotion(), input({ forward: 1 }), deep, 0.8, step);
  assert.deepEqual(fallEvents.filter((event) => event === "startFall" || event === "land"), ["startFall", "land"],
    fallEvents.join());
  assert.equal(faller.z, -1.2);
});

test("a downhill slope stays underfoot up to 61.6 degrees at any frame rate, and is a fall past it", () => {
  for (const step of [1 / 144, 1 / 60, 1 / 30]) {
    const gentle = world((x) => -Math.max(0, x) * Math.tan(58 * Math.PI / 180));
    const walker = { x: 0, y: 0, z: 0, orientation: 0 };
    const walkEvents = simulate(walker, newCharacterMotion(), input({ forward: 1 }), gentle, 0.5, step);
    assert.ok(!walkEvents.includes("startFall"), `58° at ${step}: ${walkEvents.join()}`);
    assert.ok(walker.x > 2, `ran down to ${walker.x}`);

    const steep = world((x) => -Math.max(0, x) * Math.tan(65 * Math.PI / 180));
    const faller = { x: 0, y: 0, z: 0, orientation: 0 };
    const fallEvents = simulate(faller, newCharacterMotion(), input({ forward: 1 }), steep, 0.5, step);
    assert.ok(fallEvents.includes("startFall"), `65° at ${step}: ${fallEvents.join()}`);
  }
});

// L8-review 5.07: was «a walk is slower, so it keeps less of a kerb» (a walker fell off a 0.1 kerb at 60 Hz).
test("a walk keeps a kerb as well as a run: the foot holds what the shorter probe does not", () => {
  const step = 1 / 60;
  const kerb = world((x) => (x > 0.5 ? -0.1 : 0));
  const walker = { x: 0, y: 0, z: 0, orientation: 0 };
  // 2.5 yd/s walking steps 0.0417 yards a frame: 0.0771 of probe, under the 0.1 kerb.
  const events = simulate(walker, newCharacterMotion(), input({ forward: 1, runSpeed: 2.5 }), kerb, 0.5, step);
  assert.deepEqual(events, []);
  assert.equal(walker.z, -0.1);
  const runner = { x: 0, y: 0, z: 0, orientation: 0 };
  assert.deepEqual(simulate(runner, newCharacterMotion(), input({ forward: 1 }), kerb, 0.3, step), []);
});

// ---- L8-review 5.07: the pyramid foot ------------------------------------------------------------------
// Wow.exe 3.3.5a 12340 (Ghidra read-only, .runtime/re-2026-10-04/l8-review/v1.c, re-2026-10-02/a9-phys/p1.c,
// a9-phys-review/r2.c): the ground sweep 0x0075f9d0 builds the body through 0x0075ca80, whose planes come from
// 0x0075c8f0 — four sides at ± the half-width (mover+0xc8), the top at the height, and four faces through the
// feet with normals (±0.8796, 0, -0.4756) and (0, ±0.8796, -0.4756), i.e. 61.6°; its corners are the feet and
// (x ± r, y ± r, z + r × 1.8494) (0x00a32830, the same constant as the probe). Off an edge a face rests on it
// and slides down 1.8494 per yard — exactly the probe's reach, so the probe keeps finding it.

/** Movement.advancePhysics's substeps, so the matrix below runs the frames the live loop runs. */
function frames(position, motion, characterInput, probe, seconds, rate) {
  const events = [];
  const dt = 1 / rate;
  for (let elapsed = 0; elapsed < seconds - 1e-9; elapsed += dt) {
    const fastest = characterInput.runSpeed + Math.abs(motion.velocityZ);
    const substeps = Math.max(1, Math.min(8, Math.ceil(fastest * dt / (characterInput.radius * 0.5))));
    characterInput.frameSubsteps = substeps;
    for (let index = 0; index < substeps; index++) {
      events.push(...stepCharacter(position, motion, characterInput, probe, dt / substeps));
    }
  }
  return events;
}

function stairs(riser, tread, count) {
  return (x) => (x <= 0 ? 0 : -riser * Math.min(count, Math.floor(x / tread) + 1));
}

test("stairs without a collision ramp are walked down, not fallen down, at 144, 60 and 30 frames a second", () => {
  for (const [riser, tread] of [[0.2, 0.4], [0.3, 0.45], [0.4, 0.3], [0.5, 0.5]]) {
    for (const speed of [2.5, 7, 14]) {
      for (const rate of [144, 60, 30]) {
        const flight = world(stairs(riser, tread, 8));
        const position = { x: -0.3, y: 0, z: 0, orientation: 0 };
        const motion = newCharacterMotion();
        const events = frames(position, motion, input({ forward: 1, runSpeed: speed }), flight, 8 * tread / speed + 0.5, rate);
        const label = `riser ${riser} tread ${tread} at ${speed} yd/s, ${rate} Hz`;
        assert.ok(!events.includes("startFall"), `${label}: ${events.join()}`);
        assert.equal(motion.mode, "ground", label);
        assert.ok(Math.abs(position.z + 8 * riser) < 1e-9, `${label}: ended at ${position.z}`);
      }
    }
  }
});

/**
 * A model of Wow.exe's rule, independent of the client's: the pyramid foot's support over a profile made
 * of flat and sloped pieces (the highest of g(p) − 1.8494·|p − c| over the foot, which is at the centre, at
 * the foot's ends or at a kink), the frame's horizontal move, then the probe of step × 1.8494 (with the
 * sweep's 1/720 skin, 0x00a37f14): nothing within it starts a fall, and a fall lands on the support.
 */
function wowFalls({ ground, kinks }, speed, rate, radius, seconds) {
  const support = (c) => {
    let best = Math.max(ground(c), ground(c - radius) - STEP_DOWN_PER_YARD * radius,
      ground(c + radius) - STEP_DOWN_PER_YARD * radius);
    for (const kink of kinks) {
      if (kink < c - radius || kink > c + radius) continue;
      const high = Math.max(ground(kink - 1e-9), ground(kink + 1e-9));
      best = Math.max(best, high - STEP_DOWN_PER_YARD * Math.abs(kink - c));
    }
    return best;
  };
  const dt = 1 / rate;
  let x = -0.3;
  let z = ground(x);
  let airborne = false;
  let velocity = 0;
  let falls = 0;
  for (let elapsed = 0; elapsed < seconds - 1e-9; elapsed += dt) {
    const d = speed * dt;
    x += d;
    const floor = support(x);
    if (!airborne) {
      if (floor >= z - d * STEP_DOWN_PER_YARD - 1 / 720) z = floor;
      else { airborne = true; velocity = 0; falls++; }
      continue;
    }
    velocity = Math.max(-60.148, velocity - 19.29110527 * dt);
    z += velocity * dt;
    if (z <= floor) { z = floor; airborne = false; }
  }
  return falls;
}

test("the client falls where a model of Wow.exe's foot falls, and only there (same half-width)", () => {
  const step = (height) => ({ ground: (x) => (x > 0 ? -height : 0), kinks: [0] });
  const slope = (degrees) => {
    const gradient = Math.tan(degrees * Math.PI / 180);
    return { ground: (x) => -Math.max(0, Math.min(x, 3)) * gradient, kinks: [0, 3] };
  };
  const bevel = (height, degrees) => {
    const run = height / Math.tan(degrees * Math.PI / 180);
    return { ground: (x) => (x <= 0 ? 0 : x >= run ? -height : -height * x / run), kinks: [0, run] };
  };
  const flight = (riser, tread) => ({ ground: stairs(riser, tread, 8), kinks: [0, 1, 2, 3, 4, 5, 6, 7].map((k) => k * tread) });
  // Drops between half-width × 1.8494 and (half-width + a frame) × 1.8494 are left out: whether Wow.exe falls
  // there depends on where the frames happen to fall around the edge; the client takes the larger reach (test below).
  const profiles = {
    "stairs 0.3/0.45": flight(0.3, 0.45), "stairs 0.4/0.3": flight(0.4, 0.3), "stairs 0.5/0.5": flight(0.5, 0.5),
    "kerb 0.1": step(0.1), "kerb 0.25": step(0.25), "ledge 2": step(2), "ledge 3": step(3),
    "bevel 0.3 at 75°": bevel(0.3, 75), "slope 30°": slope(30), "slope 58°": slope(58), "slope 65°": slope(65),
    "slope 80°": slope(80),
  };
  // Human male: CreatureModelData.CollisionWidth 0.6111 → mover+0xc8 = 0.3056 (0x006e9570).
  const radius = 0.6111 / 2;
  for (const [name, profile] of Object.entries(profiles)) {
    for (const speed of [2.5, 7, 14]) {
      for (const rate of [144, 60, 30]) {
        const seconds = 5 / speed + 0.8;
        const position = { x: -0.3, y: 0, z: 0, orientation: 0 };
        const events = frames(position, newCharacterMotion(), input({ forward: 1, runSpeed: speed, radius }),
          world(profile.ground), seconds, rate);
        const ours = events.filter((event) => event === "startFall").length;
        // Whether it falls; how often a walker re-falls down a slope steeper than the face differs (the point
        // lands on the slope, the pyramid on its corner above it).
        assert.equal(ours > 0, wowFalls(profile, speed, rate, radius, seconds) > 0, `${name} at ${speed} yd/s, ${rate} Hz`);
      }
    }
  }
});

test("the foot holds a drop up to (half-width + the frame's step) × 1.8494 and no deeper", () => {
  const radius = 0.389;
  const rate = 144;
  const d = 7 / rate;
  const hold = (radius + d) * STEP_DOWN_PER_YARD;
  for (const [height, falls] of [[hold - 0.02, false], [hold + 0.02, true]]) {
    const position = { x: -0.3, y: 0, z: 0, orientation: 0 };
    const events = frames(position, newCharacterMotion(), input({ forward: 1 }), world((x) => (x > 0 ? -height : 0)), 0.6, rate);
    assert.equal(events.includes("startFall"), falls, `${height}: ${events.join()}`);
    assert.ok(Math.abs(position.z + height) < 1e-9, `landed at ${position.z}`);
  }
});

test("a frame cut into substeps holds an edge by the frame's whole step (0x00762e00 hands 0x007620f0 the frame)", () => {
  // 30 Hz on a 14 yd/s mount: 0.467 yards a frame in four substeps of 0.117.
  const rate = 30;
  const dt = 1 / rate;
  const radius = 0.389;
  const height = (radius + 0.3) * STEP_DOWN_PER_YARD; // past the substep's reach, inside the frame's
  const run = (frameSubsteps) => {
    const position = { x: -0.05, y: 0, z: 0, orientation: 0 };
    const characterInput = input({ forward: 1, runSpeed: 14 });
    if (frameSubsteps !== undefined) characterInput.frameSubsteps = frameSubsteps;
    const events = [];
    for (let index = 0; index < 4; index++) events.push(...stepCharacter(position, newCharacterMotion(), characterInput,
      world((x) => (x > 0 ? -height : 0)), dt / 4));
    return events;
  };
  assert.ok(height > (radius + 14 * dt / 4) * STEP_DOWN_PER_YARD && height < (radius + 14 * dt) * STEP_DOWN_PER_YARD);
  assert.deepEqual(run(4), []);
  assert.ok(run(undefined).includes("startFall"), "without the frame's substeps the substep is the frame");
});

test("a hole under the foot does not hold it", () => {
  // The riser's foot of the step is a hole from 0.1 on: the look along the step finds it while the feet are
  // still short of it, and the fall starts at the edge.
  const holed = { ground: (x) => (x > 0 ? -0.3 : 0), liquid: () => undefined, hole: (x) => x > 0.1 && x < 2 };
  const position = { x: -0.3, y: 0, z: 0, orientation: 0 };
  const motion = newCharacterMotion();
  const characterInput = input({ forward: 1 });
  let fellAt;
  for (let elapsed = 0; elapsed < 0.2 && fellAt === undefined; elapsed += 1 / 144) {
    if (stepCharacter(position, motion, characterInput, holed, 1 / 144).includes("startFall")) fellAt = position.x;
  }
  assert.ok(fellAt !== undefined && fellAt > 0 && fellAt < 0.1, `fell at ${fellAt}`);
});

test("flat ground and slopes the probe reaches never ask the foot for more ground; an edge asks a few times", () => {
  // The foot looks along the step only when the floor fell away past the probe: walking costs nothing more.
  const asked = (ground) => {
    let calls = 0;
    const probe = { ground: (x) => { calls++; return ground(x); }, liquid: () => undefined, hole: () => false };
    const position = { x: 0, y: 0, z: 0, orientation: 0 };
    frames(position, newCharacterMotion(), input({ forward: 1 }), probe, 1, 144);
    return calls;
  };
  const flat = asked(() => 0);
  for (const degrees of [30, 58]) {
    const gradient = Math.tan(degrees * Math.PI / 180);
    assert.equal(asked((x) => -Math.max(0, x) * gradient), flat, `${degrees}°`);
  }
  // Eight risers crossed, at most eight looks each (FOOT_LOOKS).
  const extra = asked(stairs(0.3, 0.45, 8)) - flat;
  assert.ok(extra > 0 && extra <= 8 * 8, `${extra} more`);
});

test("standing still, a floor that settles lower is followed down as before (no sweep without a step)", () => {
  let floor = 0;
  const settling = world(() => floor);
  const stander = { x: 0, y: 0, z: 0, orientation: 0 };
  const motion = newCharacterMotion();
  floor = -1;
  const events = simulate(stander, motion, input(), settling, 0.1, 1 / 60);
  assert.deepEqual(events, []);
  assert.equal(stander.z, -1);
  assert.equal(motion.mode, "ground");
});

test("a step a wall stopped judges the floor as a standing body does (STEP_DOWN), not by the step it asked for", () => {
  // The wall puts the feet back where the step began: nothing was stepped over, so no edge can hold them.
  for (const [sink, falls] of [[1.0, false], [2.0, true]]) {
    let floor = 0;
    const walled = {
      ground: () => floor, liquid: () => undefined, hole: () => false,
      pushOut: (_x, _y) => ({ x: 0, y: 0 }),
    };
    const position = { x: 0, y: 0, z: 0, orientation: 0 };
    const motion = newCharacterMotion();
    const characterInput = input({ forward: 1 });
    stepCharacter(position, motion, characterInput, walled, 1 / 144);
    floor = -sink;
    const events = stepCharacter(position, motion, characterInput, walled, 1 / 144);
    assert.equal(events.includes("startFall"), falls, `${sink}: ${events.join()}`);
    assert.equal(position.x, 0);
  }
});

// L8-review 5.07: the live loop tells the physics how many substeps its frame has (Movement.advancePhysics).
test("the live loop hands the physics its frame's substeps: a 30 Hz mount keeps a ledge the frame's step reaches", async () => {
  const { game } = await import("../dist/code/browser/game/Context.js");
  const movement = await import("../dist/code/browser/input/Movement.js");
  const mover = { position: { x: -0.05, y: 0, z: 0, orientation: 0 }, fields: new Map() };
  const sent = [];
  movement.forgetMovementState();
  game.world = {
    mapId: 0, movementReady: true,
    state: { selfGuid: 1n, objects: new Map([[1n, mover]]) },
    movementState: {
      rooted: false, waterWalking: false, featherFall: false, hovering: false, canFly: false, gravityDisabled: false,
      collisionHeight: 0,
    },
    speeds: new Map([["run", 14]]),
    sendMovement: (...args) => { sent.push(args[0]); mover.position = { ...mover.position }; },
  };
  game.worldLoading = false;
  // 1.3 yards: past (0.389 + 14/30/3) × 1.8494 = 1.007, inside (0.389 + 14/30) × 1.8494 = 1.583.
  game.terrain = { heightAt: (_map, x) => (x > 0 ? -1.3 : 0), liquidAt: () => undefined, isHole: () => false };
  try {
    movement.beginHeld("moveForward");
    movement.advancePhysics(1 / 30);
    assert.equal(movement.lastPhysicsSubsteps(), 3);
    assert.equal(movement.characterMotion().mode, "ground");
    assert.ok(Math.abs(mover.position.z + 1.3) < 1e-9, `at ${mover.position.z}`);
  } finally {
    movement.releaseAllInput();
    movement.forgetMovementState();
    game.world = undefined;
    game.terrain = undefined;
  }
});
