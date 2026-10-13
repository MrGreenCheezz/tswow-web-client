// 13.10 (6.12): the rest of Missile_C (Wow.exe 0x007015d0 and its helpers; browser/MissileFlight.ts,
// SpellVisualAttach.ts, MissileGround.ts) — MissileDestinationAttachment, Impact offsets, the lead on a moving
// unit, the target-motion carry, ground following, trajectories, facing along the travel; the GO's
// CAST_FLAG_ADJUST_MISSILE words and the gateway's columns.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  flyMissileInstance, foldElevation, launchMissile, leadAim, missileSample, missileStateOf, stepMissile, trajectoryLaunch,
} from "../dist/code/browser/MissileFlight.js";
import {
  MISSILE_DEFAULT_GRAVITY, MISSILE_DESTINATION_ATTACHMENTS, followGroundOf, missileDestinationAttachment, visualOffset,
} from "../dist/code/browser/SpellVisualAttach.js";
import { missileGroundHit } from "../dist/code/browser/MissileGround.js";
import { MISSILE_TARGET_ATTACHMENT, planSpellVisual, setMissileGravitySource } from "../dist/code/browser/SpellVisuals.js";
import { parseSpellGo } from "../dist/code/world/SpellProtocol.js";
import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";

const near = (actual, expected, message, epsilon = 1e-4) =>
  assert.ok(Math.abs(actual - expected) <= epsilon, `${message}: ${actual} vs ${expected}`);

let dbcDirectory;
try {
  dbcDirectory = (await import("../tools/paths.mjs")).dbcDirectory();
} catch {
  dbcDirectory = undefined;
}
let visualFile;
try {
  visualFile = dbcDirectory ? await readFile(join(dbcDirectory, "SpellVisual.dbc")) : undefined;
} catch {
  visualFile = undefined;
}
const withDataset = { skip: visualFile ? false : "no SpellVisual.dbc in the tswow dataset on this machine" };

test("MissileDestinationAttachment is an index into 0x00adaa20 unless SpellVisual.Flags 0x200 makes it raw", () => {
  assert.equal(MISSILE_DESTINATION_ATTACHMENTS.length, 16);
  assert.equal(missileDestinationAttachment(1), 34, "1 (1,376 rows): the chest");
  assert.equal(missileDestinationAttachment(0), 20, "0: the head");
  assert.equal(missileDestinationAttachment(2), 19, "2: the ground under the feet");
  assert.equal(missileDestinationAttachment(4), 22, "4: the right spell hand");
  assert.equal(missileDestinationAttachment(13), 22);
  assert.equal(missileDestinationAttachment(19, true), 19, "Flags 0x200: the id itself (row 14149)");
  assert.equal(missileDestinationAttachment(1, true), 1);
  assert.equal(missileDestinationAttachment(19), 19, "past the table: raw");
  assert.equal(missileDestinationAttachment(undefined), 34);
  assert.deepEqual(visualOffset([1, 2, 3]), [1, -2, 3], "y negated on read (0x007fc5f0, 0x00732ff0)");
  assert.equal(visualOffset([0, 0, 0]), undefined);
});

test("MissileFollowGround: thousandths, height ≥ 0.25, drop ≥ 0.01, approach in [0, 1] (0x00732ff0)", () => {
  assert.deepEqual(followGroundOf({ height: 100, dropSpeed: 300, approach: 750, flags: 6 }),
    { height: 0.25, dropSpeed: 0.3, approach: 0.75, flags: 6 });
  assert.deepEqual(followGroundOf({ height: 1500, dropSpeed: 0, approach: 50000, flags: 7 }),
    { height: 1.5, dropSpeed: 0.01, approach: 1, flags: 7 });
  near(followGroundOf({ height: 0, dropSpeed: 300, approach: -5, flags: 2 }).approach, 0, "negative approach");
  assert.equal(followGroundOf(undefined), undefined);
});

test("the planner aims at the visual's destination attachment, moved by the impact offset, and carries FollowGround", () => {
  const plan = planSpellVisual({
    id: 9, missile: { path: "x.m2", scale: 1, attachment: 22, speed: 20, dest: 2, impactOffset: [1, 2, 3],
      followGround: { height: 1500, dropSpeed: 300, approach: 750, flags: 6 } },
  }, { caster: 1n, casterPoint: { x: 0, y: 0, z: 0 }, targets: [{ guid: 2n, point: { x: 20, y: 0, z: 0 } }] }, 0);
  const flight = plan.instances.find((one) => one.flight).flight;
  assert.deepEqual(flight.target, { guid: 2n, attachment: 19 });
  assert.deepEqual(flight.impactOffset, [1, -2, 3]);
  assert.deepEqual(flight.followGround, { height: 1.5, dropSpeed: 0.3, approach: 0.75, flags: 6 });
  const plain = planSpellVisual({ id: 9, missile: { path: "x.m2", scale: 1, attachment: 22, speed: 20 } },
    { caster: 1n, casterPoint: { x: 0, y: 0, z: 0 }, targets: [{ guid: 2n, point: { x: 20, y: 0, z: 0 } }] }, 0);
  assert.equal(plain.instances[0].flight.target.attachment, MISSILE_TARGET_ATTACHMENT, "no column: the chest");
});

test("the lead (0x006ff6d0): half the unit's velocity, the earliest positive intercept; none for a still target", () => {
  const here = { x: 0, y: 0, z: 0 };
  const still = { x: 20, y: 0, z: 0 };
  leadAim(still, here, { x: 0, y: 0, z: 0 }, 20);
  assert.deepEqual(still, { x: 20, y: 0, z: 0 });
  const aim = { x: 20, y: 0, z: 0 };
  leadAim(aim, here, { x: 0, y: 8, z: 0 }, 20);
  // v' = (0, 4, 0): (16 − 400) t² + 0 · t + 400 = 0 → t = √(400/384).
  const t = Math.sqrt(400 / 384);
  near(aim.y, 4 * t, "led by v/2 · t");
  near(Math.hypot(aim.x, aim.y), 20 * t, "the missile reaches the led point in t");
  const fast = { x: 20, y: 0, z: 0 };
  leadAim(fast, here, { x: 0, y: 100, z: 0 }, 20);
  assert.ok(Math.abs(fast.y) > 0 && Math.abs(fast.y) < 20, `a faster unit is shortened to the missile's speed first: ${fast.y}`);
});

test("an instance leads a moving unit and is carried by its motion; it still lands on it", () => {
  const unit = { x: 20, y: 0, z: 0 };
  const points = {
    point(guid, _attachment, out) { if (guid !== 2n) return false; out.x = unit.x; out.y = unit.y; out.z = unit.z + 1; return true; },
    origin(guid, out) { if (guid !== 2n) return false; Object.assign(out, unit); return true; },
  };
  const instance = { startedAt: 0, endsAt: 1000, flight: { from: { x: 0, y: 0, z: 1 }, to: { x: 20, y: 0, z: 1 }, target: { guid: 2n, attachment: 34 } } };
  const out = missileSample();
  let now = 0;
  let maxLead = 0;
  flyMissileInstance(instance, now, points, out);
  while (flyMissileInstance(instance, (now += 20), points, out) && now < 4000) {
    unit.y += 0.2; // 10 yd/s across
    maxLead = Math.max(maxLead, missileStateOf(instance).target.y - unit.y);
  }
  assert.ok(maxLead > 0.1, `the aim ran ahead of the unit: ${maxLead}`);
  near(out.position.y, unit.y, "landed on the unit", 0.6);
});

test("ground following (0x006fffc0): flies at Height over the ground, climbs a ridge, sinks by DropSpeed, bends at Approach", () => {
  // A ridge: up 3 yards over 2, a plateau, down again (a heightfield has slopes, not walls).
  const ground = (x) => (x < 10 ? 0 : x < 12 ? (x - 10) * 1.5 : x < 16 ? 3 : x < 18 ? 3 - (x - 16) * 1.5 : 0);
  const world = { ground: (from, to, hit) => missileGroundHit((x) => ground(x), from, to, hit) };
  const plan = { from: { x: 0, y: 0, z: 5 }, to: { x: 30, y: 0, z: 1 }, followGround: { height: 0.5, dropSpeed: 0.5, approach: 0.8, flags: 2 } };
  const state = launchMissile(plan, { x: 0, y: 0, z: 5 }, { x: 30, y: 0, z: 1 }, 0, 3000);
  const out = missileSample();
  const heights = [];
  let now = 0;
  while (stepMissile(state, { x: 30, y: 0, z: 1 }, (now += 50), out, { world }) && now < 10_000) heights.push([out.position.x, out.position.z]);
  const at = (x) => heights.find(([px]) => px >= x)[1];
  assert.ok(at(1) < 5, `it sinks towards ground + Height: ${at(1)}`);
  near(at(8), 0.5, "settled at Height above flat ground", 0.05);
  assert.ok(at(14) >= 3, `over the ridge: ${at(14)}`);
  assert.ok(at(22) < 3, "and down again after it");
  assert.ok(state.progressFlat > 0.8, "the approach share was passed");
  assert.equal(state.arrived, true);
  near(out.position.z, 1, "it arrives at the aim, not at the ground");
});

test("the ground test: the first crossing from above, nothing from below or off the map", () => {
  const hit = { x: 0, y: 0, z: 0 };
  const flat = () => 2;
  near(missileGroundHit(flat, { x: 0, y: 0, z: 5 }, { x: 0, y: 0, z: -5 }, hit), 0.3, "down through 2", 0.01);
  near(hit.z, 2, "hit point on the ground");
  assert.equal(missileGroundHit(flat, { x: 0, y: 0, z: 1 }, { x: 10, y: 0, z: 1 }, hit), undefined, "starting under it");
  assert.equal(missileGroundHit(() => undefined, { x: 0, y: 0, z: 5 }, { x: 0, y: 0, z: -5 }, hit), undefined);
  assert.equal(missileGroundHit(undefined, { x: 0, y: 0, z: 5 }, { x: 0, y: 0, z: -5 }, hit), undefined);
});

test("trajectories (0x0076c070, 0x00700880): the parabola through the aim under gravity, on a clock scaled to the delay", () => {
  const out = new Float64Array(4);
  const delta = { x: 30, y: 40, z: 5 };
  assert.equal(trajectoryLaunch(0.6, delta, 19.29, out), 2);
  const [time, vx, vy, vz] = out;
  near(vx * time, 30, "x at T");
  near(vy * time, 40, "y at T");
  near(vz * time - 19.29 * time * time / 2, 5, "z at T: the parabola ends at the aim");
  near(Math.atan2(vz, Math.hypot(vx, vy)), 0.6, "leaves at the elevation");
  assert.equal(trajectoryLaunch(-1.2, delta, 19.29, out), 0, "too low to reach");
  assert.equal(trajectoryLaunch(0.6, { x: 0, y: 0, z: 5 }, 19.29, out), 1, "straight up: degenerate");
  assert.equal(trajectoryLaunch(0.6, delta, 0, out), 1, "no gravity: degenerate");
  near(foldElevation(2), Math.PI - 2, "mirrored at π/2");
  near(foldElevation(-2), -Math.PI + 2, "and at −π/2");

  const plan = { from: { x: 0, y: 0, z: 0 }, to: { x: 40, y: 0, z: 0 }, trajectory: { elevation: Math.PI / 4, gravity: 19.29 } };
  const state = launchMissile(plan, { x: 0, y: 0, z: 0 }, { x: 40, y: 0, z: 0 }, 0, 2000);
  const sample = missileSample();
  stepMissile(state, { x: 40, y: 0, z: 0 }, 1000, sample);
  near(sample.position.x, 20, "half way at half the delay");
  assert.ok(sample.position.z > 5, `well above the line: ${sample.position.z}`);
  assert.equal(stepMissile(state, { x: 40, y: 0, z: 0 }, 1999, sample), true);
  assert.ok(sample.position.z < 0.5 && sample.position.x > 39.9, "about to land");
  assert.equal(stepMissile(state, { x: 40, y: 0, z: 0 }, 2000, sample), false, "lands at the delay");
  const flat = launchMissile({ ...plan, trajectory: { elevation: Math.PI / 2, gravity: 19.29 } },
    { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 10 }, 0, 1000);
  stepMissile(flat, { x: 0, y: 0, z: 10 }, 500, sample);
  near(sample.position.z, 5, "a degenerate shot flies the straight line on time");
});

test("the planner flies a trajectory to the destination with the spell's gravity, landing at the packet's delay", () => {
  setMissileGravitySource((id) => (id === 77 ? 30 : undefined));
  try {
    const cast = {
      caster: 1n, casterPoint: { x: 0, y: 0, z: 0 }, targets: [{ guid: 0n, point: { x: 40, y: 0, z: 0 } }],
      destination: { x: 40, y: 0, z: 0 }, trajectory: { elevation: 0.7, delayMs: 2500, source: { x: 1, y: 2, z: 3 } },
    };
    const visual = { id: 77, missile: { path: "x.m2", scale: 1, attachment: 22, speed: 0 } };
    const missile = planSpellVisual(visual, cast, 1000).instances.find((one) => one.flight);
    assert.equal(missile.endsAt, 3500);
    assert.deepEqual(missile.flight.trajectory, { elevation: 0.7, gravity: 30 });
    assert.deepEqual(missile.flight.from, { x: 1, y: 2, z: 3 }, "from the source location");
    assert.equal(missile.flight.launch, undefined, "not re-read from the hand");
    const other = planSpellVisual({ ...visual, id: 78 }, cast, 1000).instances.find((one) => one.flight);
    assert.equal(other.flight.trajectory.gravity, MISSILE_DEFAULT_GRAVITY, "no SpellMissile row: 19.29");
  } finally {
    setMissileGravitySource(undefined);
  }
});

test("a script or ground-following missile faces along its drawn travel (0x00701230 with 0x800); a plain one at its aim", () => {
  const motion = { id: 1, script: "transUp = progress * 10", count: 1 };
  const scripted = launchMissile({ from: { x: 0, y: 0, z: 0 }, to: { x: 10, y: 0, z: 0 }, motion },
    { x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, 0, 1000);
  const out = missileSample();
  stepMissile(scripted, { x: 10, y: 0, z: 0 }, 100, out);
  stepMissile(scripted, { x: 10, y: 0, z: 0 }, 200, out);
  // Each frame: 1 yard on and 1 yard up.
  near(out.direction.x, Math.SQRT1_2, "along the travel, x");
  near(out.direction.z, Math.SQRT1_2, "along the travel, up");
  const plain = launchMissile({ from: { x: 0, y: 0, z: 0 }, to: { x: 10, y: 0, z: 0 } }, { x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, 0, 1000);
  stepMissile(plain, { x: 10, y: 0, z: 0 }, 100, out);
  stepMissile(plain, { x: 10, y: 0, z: 0 }, 200, out);
  near(out.direction.x, 1, "at the aim");
});

test("SMSG_SPELL_GO: CAST_FLAG_ADJUST_MISSILE's elevation and delay after the power and rune words (0x0080e1b0)", () => {
  const writer = new PacketWriter().packedGuid(1n).packedGuid(1n).u8(0).u32(7).u32(0x20000 | 0x800 | 0x200000).u32(0)
    .u8(0).u8(0) // no hits, no misses
    .u32(0x40).packedGuid(0n).f32(10).f32(20).f32(30) // DEST_LOCATION
    .u32(55) // power left
    .u8(0b111).u8(0b001).u8(1).u8(2) // runes: two spent
    .f32(0.5).u32(1800);
  const go = parseSpellGo(writer.toUint8Array());
  near(go.adjustMissile.elevation, 0.5, "elevation");
  assert.equal(go.adjustMissile.delayMs, 1800);
  assert.deepEqual(go.targets.destination, { x: 10, y: 20, z: 30 });
  const plain = parseSpellGo(new PacketWriter().packedGuid(1n).packedGuid(1n).u8(0).u32(7).u32(0).u32(0).u8(0).u8(0).u32(0).toUint8Array());
  assert.equal(plain.adjustMissile, undefined);
});

test("dataset: the gateway carries FollowGround whenever a column says something, destRaw, and a beam visual's ends", withDataset, async () => {
  const { parseSpellVisuals } = await import("../dist/code/gateway/SpellVisual.js");
  const read = (name) => readFile(join(dbcDirectory, name));
  const visuals = parseSpellVisuals(await read("Spell.dbc"), visualFile, await read("SpellVisualKit.dbc"),
    await read("SpellVisualEffectName.dbc"), undefined, undefined, undefined, { spellChainEffects: await read("SpellChainEffects.dbc") });
  let withGround = 0;
  let heightZero = 0;
  let raw = 0;
  for (const visual of visuals.values()) {
    const ground = visual.missile?.followGround;
    if (ground) withGround++;
    if (ground && ground.height === 0 && (ground.flags & 2) !== 0) heightZero++;
    if (visual.missile?.destRaw) raw++;
  }
  assert.ok(heightZero > 0, `rows following the ground with Height 0 now travel: ${heightZero}`);
  assert.ok(withGround > heightZero);
  assert.ok(raw >= 1, "SpellVisual 14149's spells");
  assert.deepEqual(Object.keys(visuals.get(689).beamEnds).sort().slice(0, 2), ["attachment", "dest"], "Drain Life's beam ends");
});
