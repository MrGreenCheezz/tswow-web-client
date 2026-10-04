import assert from "node:assert/strict";
import { closeSync, existsSync, openSync, readFileSync, readSync } from "node:fs";
import test from "node:test";
import { PacketReader, PacketWriter } from "../dist/code/protocol/index.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { readMovementInfo } from "../dist/code/world/MovementProtocol.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import { buildCastSpell } from "../dist/code/world/SpellProtocol.js";
import { buildPetCastSpell } from "../dist/code/world/PetCastSpell.js";
import { packPetAction, REACT_DEFENSIVE, COMMAND_FOLLOW } from "../dist/code/world/PetProtocol.js";
import { writeSpellTargets } from "../dist/code/world/SpellTargets.js";
import {
  CAST_FLAG_TRAJECTORY, MISSILE_MAX_STEPS, buildCastSpellTrajectory, buildUpdateMissileTrajectory,
  buildUpdateProjectilePosition, coreTrajectoryHeight, flyMissile, missileAim, missileLaunch, missileMaxSteps,
  solveMissileShot, trajectoryTargets,
} from "../dist/code/world/MissileTrajectory.js";
import {
  MissileTrajectoryTracker, SPELL_FAILED_ERROR, SPELL_FAILED_SPELL_IN_PROGRESS, missileCastPlan, setMissileShotSource,
} from "../dist/code/world/MissileCast.js";
import {
  SPELL_MISSILE_CATALOG_VERSION, SpellMissileCatalog, spellMissileCatalogFrom, spellMissileEntry,
} from "../dist/code/world/SpellMissileDbc.js";

// 11.02-E: missile trajectories — siege engines, catapults, cannons. Wow.exe 3.3.5a 12340 (Ghidra, read-only,
// .runtime/re-2026-10-03/l1102e/r1-r5.c): the cast sender 0x0080ac90 (SpellMissile Flags bit 0 → the caster must be
// the active mover, cast flags 2, 0x00809f80 solves and writes SOURCE|DEST, then f32 elevation, f32 speed, u8 1,
// u32 MSG_MOVE_STOP, packed mover guid, MovementInfo), the solver 0x006fcd60 (elevation = the mover's pitch with
// ALLOW_PITCHING, clamped with CUSTOM_PITCH, else the missile's middle pitch; speed from the aim power with
// ADJUST_AIM_POWER, else the middle; 0.1 s steps, at most 200 or ftol(MaxDuration × 10)), the re-aim
// CMSG_UPDATE_MISSILE_TRAJECTORY 0x006fd6b0 once the cast time since the send is up (0x00806700 → 0x006fbe50,
// 0x006fe7e0), CMSG_UPDATE_PROJECTILE_POSITION 0x00703640. TrinityCore: SpellHandler.cpp:52-73,
// MiscHandler.cpp:1565-1601, SpellHandler.cpp:805-842, SpellInfo.cpp:136-145, Spell.cpp:1688-1775 and :927-937.

const G = 19.29;

function missile({ id = 1023, flags = 1, pitch = [-0.262, 1.047], speed = [65, 65], rf = [0, 0], rp = [0, 0], rs = [0, 0],
  gravity = 40, maxDuration = 0, radius = 0 } = {}) {
  return spellMissileEntry([id, flags, ...pitch, ...speed, ...rf, ...rp, ...rs, gravity, maxDuration, radius]);
}

/** A ray test against the plane z = `ground`: the fraction where a step crosses it. */
const plane = (ground) => (from, to) => {
  if (to.z > ground) return undefined;
  if (from.z <= ground) return 0;
  return (from.z - ground) / (from.z - to.z);
};

const f32 = Math.fround;

test("11.02-E: the route's tables — rows checked, bit 0 makes a trajectory spell", () => {
  assert.equal(spellMissileCatalogFrom({ version: SPELL_MISSILE_CATALOG_VERSION + 1, missiles: [], spells: [] }), undefined);
  assert.equal(spellMissileCatalogFrom({ version: SPELL_MISSILE_CATALOG_VERSION, missiles: [] }), undefined);
  const row = (id, flags) => [id, flags, 0.698, 0.873, 30, 40, 0, 0, 0, 0, 0, 0, G, 0, 0];
  const catalog = spellMissileCatalogFrom({
    version: SPELL_MISSILE_CATALOG_VERSION,
    missiles: [row(61, 1), row(1824, 3), row(1823, 0), [1, 2, 3], row(77, 1).map((v, i) => (i === 12 ? "x" : v)), row(-5, 1)],
    spells: [[44854, 61], [66218, 1824], [66223, 1823], [5, 77], [6, "x"], [0, 61]],
  });
  assert.equal(catalog.size, 3, "short rows, strings and bad ids are dropped");
  assert.equal(catalog.trajectoryMissile(44854)?.id, 61);
  assert.equal(catalog.trajectoryMissile(66218)?.id, 1824, "flags 3 has bit 0");
  assert.equal(catalog.trajectoryMissile(66223), undefined, "a row without bit 0 is not a trajectory (0x0080ac90)");
  assert.equal(catalog.missileOfSpell(66223)?.id, 1823);
  assert.equal(catalog.trajectoryMissile(5), undefined, "a dropped row");
  assert.equal(catalog.trajectoryMissile(133), undefined);
  assert.equal(catalog.missile(61).gravity, G);
});

test("11.02-E: targets — SOURCE_LOCATION (0x20) before DEST_LOCATION; without a source the bytes are as before", () => {
  const unit = 0xf130_0000_0000_0077n;
  const before = new PacketWriter().u32(0x42).packedGuid(unit).packedGuid(0n).f32(1).f32(2).f32(3).toUint8Array();
  const now = new PacketWriter();
  assert.equal(writeSpellTargets(now, { unit, destination: { x: 1, y: 2, z: 3 } }), true);
  assert.deepEqual([...now.toUint8Array()], [...before]);

  const both = new PacketWriter();
  writeSpellTargets(both, { unit, source: { x: 4, y: 5, z: 6 }, destination: { x: 1, y: 2, z: 3 } });
  const reader = new PacketReader(both.toUint8Array());
  assert.equal(reader.u32(), 0x62);
  assert.equal(reader.packedGuid(), unit);
  assert.equal(reader.packedGuid(), 0n, "world coordinates");
  assert.deepEqual([reader.f32(), reader.f32(), reader.f32()], [4, 5, 6], "the source first (Spell.cpp:157)");
  assert.equal(reader.packedGuid(), 0n);
  assert.deepEqual([reader.f32(), reader.f32(), reader.f32()], [1, 2, 3]);
  reader.assertFinished();
  assert.equal(writeSpellTargets(new PacketWriter(), { source: { x: Number.NaN, y: 0, z: 0 } }), false, "a point that is not finite is not sent");
});

test("11.02-E: the aim (0x006fcd60) — pitch with ALLOW_PITCHING, the band with CUSTOM_PITCH, power with ADJUST_AIM_POWER", () => {
  const row = missile({ pitch: [0.2, 0.6], speed: [10, 120] });
  assert.deepEqual(missileAim(row, undefined, 1.2, 0.9), { elevation: 0.4, speed: 65 }, "no kit: the missile's middles");
  assert.deepEqual(missileAim(row, { flags: 0x40, pitchMin: -1, pitchMax: 1 }, 0.9, 0.5), { elevation: 0.4, speed: 65 },
    "without ALLOW_PITCHING 0x10 the pitch is not read");
  assert.equal(missileAim(row, { flags: 0x10, pitchMin: -1, pitchMax: 0.5 }, 0.9, 0).elevation, 0.9, "no CUSTOM_PITCH: no band");
  assert.equal(missileAim(row, { flags: 0x50, pitchMin: -1, pitchMax: 0.5 }, 0.9, 0).elevation, 0.5, "CUSTOM_PITCH: the ceiling");
  assert.equal(missileAim(row, { flags: 0x50, pitchMin: -0.25, pitchMax: 0.5 }, -0.9, 0).elevation, -0.25, "and the floor");
  assert.equal(missileAim(row, { flags: 0x810, pitchMin: 0, pitchMax: 0 }, 0, 0).speed, 10, "power 0: DefaultSpeedMin");
  assert.equal(missileAim(row, { flags: 0x810, pitchMin: 0, pitchMax: 0 }, 0, 0.25).speed, 37.5);
  assert.equal(missileAim(row, { flags: 0x10, pitchMin: 0, pitchMax: 0 }, 0, 0.25).speed, 65, "without 0x800 the power is not read");
});

test("11.02-E: the launch — a cast draws pitch, speed, facing, then the jitter; the arc takes the middles", () => {
  const row = missile({ rf: [-0.2, 0.2], rp: [0.1, 0.3], rs: [-5, 5] });
  const draws = [0.25, 0.5, 0.75, 1, 0, 0.5, 1, 0];
  let next = 0;
  const launch = missileLaunch(row, { elevation: 0.5, speed: 50 }, 1, { x: 10, y: 20, z: 30 }, () => draws[next++]);
  assert.equal(next, 8, "eight draws");
  assert.ok(Math.abs(launch.elevation - (0.5 + 0.15 + 0.01)) < 1e-12, "pitch pair, then +0.01 at the top of the jitter");
  assert.ok(Math.abs(launch.speed - (50 + 0 - 0.01)) < 1e-12, "speed pair, then −0.01");
  assert.ok(Math.abs(launch.facing - (1 + 0.1)) < 1e-12, "facing pair");
  assert.deepEqual([launch.fire.x, launch.fire.y, launch.fire.z].map((v) => +v.toFixed(9)), [10, 20.1, 29.99]);
  const arc = missileLaunch(row, { elevation: 0.5, speed: 50 }, 1, { x: 10, y: 20, z: 30 });
  assert.deepEqual([arc.elevation, arc.speed, arc.facing].map((v) => +v.toFixed(9)), [0.7, 50, 1]);
  assert.deepEqual(arc.fire, { x: 10, y: 20, z: 30 });
});

test("11.02-E: the flight — 0.1 s steps on the gravity parabola, the first hit, 200 steps or MaxDuration × 10", () => {
  const ends = [];
  const recording = (from, to) => {
    ends.push({ ...to });
    return plane(-1e9)(from, to);
  };
  const e = 0.6;
  const s = 45;
  const flight = flyMissile({ elevation: e, speed: s, facing: 0, fire: { x: 0, y: 0, z: 0 } }, 30, 0, recording);
  assert.equal(ends.length, MISSILE_MAX_STEPS);
  assert.equal(flight.time, 20);
  for (const [index, end] of ends.entries()) {
    const t = (index + 1) * 0.1;
    assert.ok(Math.abs(end.x - s * Math.cos(e) * t) < 1e-9 && Math.abs(end.z - (s * Math.sin(e) * t - 15 * t * t)) < 1e-9,
      `step ${index + 1} lies on the parabola`);
  }
  assert.equal(missileMaxSteps(1.15), 11, "ftol(1.15 × 10)");
  assert.equal(missileMaxSteps(25), 200);
  assert.equal(missileMaxSteps(0.00005), 200);
  assert.equal(flyMissile({ elevation: e, speed: s, facing: 0, fire: { x: 0, y: 0, z: 0 } }, 30, 1.15, plane(-1e9)).time, 1.1);

  // Flat ground: the impact is where the parabola meets it (range v² sin 2e / g, time 2 v sin e / g).
  const level = flyMissile({ elevation: Math.PI / 4, speed: 30, facing: Math.PI / 2, fire: { x: 5, y: 5, z: 0 } }, G, 0, plane(0));
  const range = 900 / G;
  assert.ok(Math.abs(level.impact.y - 5 - range) < 0.1 && Math.abs(level.impact.x - 5) < 1e-9, `range ${level.impact.y - 5}`);
  assert.ok(Math.abs(level.time - 2 * 30 * Math.SQRT1_2 / G) < 0.01);
  assert.equal(level.impact.z, 0);

  const blocked = flyMissile({ elevation: 0, speed: 30, facing: 0, fire: { x: 0, y: 0, z: 1 } }, G, 0, () => 0.5);
  assert.ok(Math.abs(blocked.impact.x - 1.5) < 1e-9 && Math.abs(blocked.time - 0.05) < 1e-12, "a hit in the first step");
});

test("11.02-E: TrinityCore's arc (Spell.cpp:1709-1712) is this flight's parabola, and its delay is this flight's time", () => {
  for (const [e, s, g, ground] of [[0.5, 65, 40, -12], [1.2, 45, 30, 4], [0.1, 90, 30, -3], [0.785, 30, G, 0]]) {
    const flight = flyMissile({ elevation: e, speed: s, facing: 0.3, fire: { x: 0, y: 0, z: 0 } }, g, 0, plane(ground));
    const dist2d = Math.hypot(flight.impact.x, flight.impact.y);
    for (const share of [0.1, 0.35, 0.6, 0.9]) {
      const d = dist2d * share;
      const gravity = d * Math.tan(e) - (g * d * d) / (2 * s * s * Math.cos(e) ** 2);
      const core = coreTrajectoryHeight(e, dist2d, flight.impact.z, d);
      assert.ok(Math.abs(core - gravity) < 0.02 + 0.002 * dist2d, `e ${e}: core ${core} vs ${gravity} at ${d.toFixed(1)}`);
    }
    // Spell::CalculateDelayMomentForDst: dist2d / (speed · cos elevation) seconds.
    assert.ok(Math.abs(dist2d / (s * Math.cos(e)) - flight.time) < 0.01, `delay ${flight.time}`);
  }
  // An end above the launch line would bend the arc upwards: the core flattens `a` to 0 (Spell.cpp:1711-1712).
  assert.equal(coreTrajectoryHeight(0, 10, 5, 5), 0);
  assert.ok(Math.abs(coreTrajectoryHeight(0.5, 10, 0, 5) - 5 * ((0 - 10 * Math.tan(0.5)) / 100 * 5 + Math.tan(0.5))) < 1e-12);
});

test("11.02-E: the packets — UPDATE_MISSILE_TRAJECTORY, UPDATE_PROJECTILE_POSITION, CAST_SPELL with flag 2", () => {
  const caster = 0xf150_0074_9800_0102n;
  const shot = { elevation: 0.3, speed: 65.5, fire: { x: 1.5, y: 2.5, z: 3.5 }, impact: { x: 40.25, y: -7, z: 2 }, time: 1 };
  const movement = { opcode: OPCODES.MSG_MOVE_STOP, guid: caster,
    info: { flags: 0x20, flags2: 0x20, time: 77, position: { x: 1, y: 2, z: 3, orientation: 0.5 }, pitch: 0.3 } };
  const update = new PacketReader(buildUpdateMissileTrajectory(caster, 57609, shot, movement));
  assert.equal(update.u64(), caster);
  assert.equal(update.u32(), 57609);
  assert.deepEqual(Array.from({ length: 8 }, () => update.f32()), [0.3, 65.5, 1.5, 2.5, 3.5, 40.25, -7, 2].map(f32));
  assert.equal(update.u8(), 1, "moveStop");
  assert.equal(update.u32(), OPCODES.MSG_MOVE_STOP, "0xB7, as Wow.exe writes it (0x0071f060)");
  assert.equal(update.packedGuid(), caster);
  const info = readMovementInfo(update);
  assert.equal(info.position.x, 1);
  assert.equal(f32(info.pitch), f32(0.3));
  update.assertFinished();
  const bare = new PacketReader(buildUpdateMissileTrajectory(caster, 57609, shot));
  bare.u64(); bare.u32();
  for (let index = 0; index < 8; index++) bare.f32();
  assert.equal(bare.u8(), 0);
  bare.assertFinished();

  const hit = new PacketReader(buildUpdateProjectilePosition(caster, 62358, 0x105, { x: 1, y: 2, z: 3 }));
  assert.deepEqual([hit.u64(), hit.u32(), hit.u8(), hit.f32(), hit.f32(), hit.f32()], [caster, 62358, 5, 1, 2, 3]);
  hit.assertFinished();

  const self = 0x1234n;
  const enemy = 0xf130_0000_0000_0077n;
  const cast = new PacketReader(buildCastSpellTrajectory(6544, 9, trajectoryTargets(shot, enemy), shot,
    { ...movement, guid: self }));
  assert.deepEqual([cast.u8(), cast.u32(), cast.u8()], [9, 6544, CAST_FLAG_TRAJECTORY]);
  assert.equal(cast.u32(), 0x62, "UNIT | SOURCE_LOCATION | DEST_LOCATION");
  assert.equal(cast.packedGuid(), enemy);
  cast.packedGuid();
  assert.deepEqual([cast.f32(), cast.f32(), cast.f32()], [1.5, 2.5, 3.5]);
  cast.packedGuid();
  assert.deepEqual([cast.f32(), cast.f32(), cast.f32()], [40.25, -7, 2]);
  assert.deepEqual([cast.f32(), cast.f32()], [f32(0.3), 65.5]);
  assert.equal(cast.u8(), 1);
  assert.equal(cast.u32(), OPCODES.MSG_MOVE_STOP);
  assert.equal(cast.packedGuid(), self);
  readMovementInfo(cast);
  cast.assertFinished();
  const noUnit = new PacketReader(buildCastSpellTrajectory(6544, 9, trajectoryTargets(shot, 0n), shot));
  noUnit.u8(); noUnit.u32(); noUnit.u8();
  assert.equal(noUnit.u32(), 0x60);
});

test("11.02-E: the note between cast and re-aim (0x006fbe30/0x006fbe50/0x006fbeb0/0x006fe7e0/0x006fbe80)", () => {
  const armed = [];
  const timers = { set: (callback, delay) => { armed.push({ callback, delay, live: true }); return armed.length - 1; }, clear: (handle) => { armed[handle].live = false; } };
  const due = [];
  const tracker = new MissileTrajectoryTracker((guid, spellId) => due.push([guid, spellId]), timers);
  const unit = 0xf150n;
  tracker.cast(unit, 57609, 1000);
  assert.equal(tracker.inProgress(unit), false, "sent, not started: a second cast goes (0x006fbeb0 needs +0xf70)");
  assert.equal(tracker.spellStart(unit, 57606, 2000, 1100), false, "another spell");
  assert.equal(tracker.spellStart(0xf151n, 57609, 2000, 1100), false, "another unit");
  assert.equal(tracker.spellStart(unit, 57609, 0, 1100), false, "an instant cast is never re-aimed");
  assert.equal(armed.length, 0);
  assert.equal(tracker.spellStart(unit, 57609, 2000, 1100), true);
  assert.equal(armed.length, 1);
  assert.equal(armed[0].delay, 1900, "due castTime after the send, not after the start");
  assert.equal(tracker.inProgress(unit), true);
  assert.equal(tracker.isDue(2999), false);
  assert.equal(tracker.isDue(3000), true);
  armed[0].callback();
  assert.deepEqual(due, [[unit, 57609]]);
  assert.equal(tracker.inProgress(unit), false, "the note is cleared (0x006fbe80)");
  armed[0].callback();
  assert.equal(due.length, 1, "once");

  tracker.cast(unit, 57609, 1000);
  tracker.spellStart(unit, 57609, 50, 1200);
  assert.equal(armed[1].delay, 0, "a start arriving late is due at once");
  tracker.clear(1);
  assert.equal(armed[1].live, true, "another spell's clear leaves it");
  tracker.clear(57609);
  assert.equal(armed[1].live, false);
  tracker.cast(unit, 57609, 1000);
  tracker.spellStart(unit, 57609, 50, 1000);
  tracker.dispose();
  assert.equal(armed[2].live, false);
  assert.equal(tracker.inProgress(unit), false);
});

test("11.02-E: the plan (0x0080ac90 → 0x00809f80) — not a trajectory, not the mover, in progress, no shot", () => {
  const unit = 0xf150n;
  const shot = { elevation: 0.1, speed: 10, fire: { x: 0, y: 0, z: 0 }, impact: { x: 1, y: 0, z: 0 }, time: 0.1 };
  let solved = shot;
  const source = { trajectoryMissile: (spellId) => (spellId === 1 ? missile() : undefined), shot: () => solved };
  const tracker = new MissileTrajectoryTracker(() => {}, { set: () => 0, clear: () => {} });
  assert.equal(missileCastPlan(undefined, tracker, 1, unit, unit), undefined, "no source: as before");
  assert.equal(missileCastPlan(source, tracker, 2, unit, unit), undefined, "no row: as before");
  assert.deepEqual(missileCastPlan(source, tracker, 1, unit, 0x1234n), { refused: 0 }, "the caster must be the active mover");
  assert.deepEqual(missileCastPlan(source, tracker, 1, unit, unit), { shot });
  tracker.cast(unit, 1, 5);
  tracker.spellStart(unit, 1, 100, 6);
  assert.deepEqual(missileCastPlan(source, tracker, 1, unit, unit), { refused: SPELL_FAILED_SPELL_IN_PROGRESS });
  tracker.clear();
  solved = undefined;
  assert.deepEqual(missileCastPlan(source, tracker, 1, unit, unit), { refused: SPELL_FAILED_ERROR });
});

// ---- through WorldClient -----------------------------------------------------------------------------

const SELF = 0x1234n;
const VEHICLE = 0xf150_7d9a_0000_0042n;
const ENEMY = 0xf130_0000_0000_0077n;
const CANNON = 57609;
const FLAME = 62346;
const LEAP = 6544;
const STRIKE = 78;

function startPacket(caster, spellId, castTime, castId = 1) {
  return new PacketWriter().packedGuid(caster).packedGuid(caster).u8(castId).u32(spellId).u32(0).u32(castTime).u32(0).toUint8Array();
}

async function vehicleClient() {
  const login = new PacketWriter().u32(0).f32(0).f32(0).f32(0).f32(0).toUint8Array();
  const waiters = [];
  const connection = {
    packets: [{ opcode: OPCODES.SMSG_LOGIN_VERIFY_WORLD, payload: login }],
    sent: [],
    send(opcode, payload = new Uint8Array()) { this.sent.push({ opcode, payload }); },
    read() {
      if (this.packets.length) return Promise.resolve(this.packets.shift());
      return new Promise((resolve) => waiters.push(resolve));
    },
    close() {},
  };
  const client = new WorldClient(connection);
  client.state.selfGuid = SELF;
  client.state.move(SELF, { flags: 0, position: { x: 0, y: 0, z: 0, orientation: 0 } });
  client.state.move(VEHICLE, { flags: 0, position: { x: 3, y: 4, z: 5, orientation: 1 } });
  client.state.objects.get(VEHICLE).typeId = 3;
  await client.loginCharacter(SELF);
  await new Promise((resolve) => setImmediate(resolve));
  const bar = [packPetAction(CANNON, 8), packPetAction(FLAME, 9)].concat(Array(8).fill(0));
  client.petSpells = {
    guid: VEHICLE, closed: false, creatureFamily: 0, duration: 0, reactState: REACT_DEFENSIVE, commandState: COMMAND_FOLLOW,
    flags: 0, spells: [], cooldowns: [],
    bar: bar.map((packed, slot) => ({ slot, packed, action: packed & 0xffffff, type: packed >>> 24 })),
  };
  client.targetGuid = ENEMY;
  client.knownSpells = [{ id: LEAP, slot: 0 }, { id: STRIKE, slot: 1 }];
  connection.sent.length = 0;
  const statuses = [];
  client.onSpellStatus = (text, error) => statuses.push({ text, error });
  const deliver = async (opcode, payload) => {
    const waiter = waiters.shift();
    if (waiter) waiter({ opcode, payload });
    else connection.packets.push({ opcode, payload });
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { client, connection, deliver, statuses };
}

/** A page solver stand-in: trajectory rows for CANNON and LEAP; each shot a little higher than the last. */
function fakeSource() {
  const calls = [];
  const source = {
    primed: 0,
    prime() { this.primed++; },
    trajectoryMissile: (spellId) => (spellId === CANNON || spellId === LEAP ? missile() : undefined),
    shot(casterGuid, spellId) {
      calls.push([casterGuid, spellId]);
      return { elevation: 0.25 * calls.length, speed: 65, fire: { x: 3, y: 4, z: 5 }, impact: { x: 60, y: 4, z: 1 }, time: 1 };
    },
  };
  return { source, calls };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("11.02-E: no solver, no row — a vehicle's and the character's casts are the packets they were, byte for byte", async () => {
  const { client, connection } = await vehicleClient();
  client.controlledGuid = VEHICLE;
  setMissileShotSource(undefined);
  client.usePetSlot(0);
  const { source } = fakeSource();
  setMissileShotSource(source);
  client.usePetSlot(1);
  assert.deepEqual(connection.sent.map(({ opcode }) => opcode), [OPCODES.CMSG_PET_CAST_SPELL, OPCODES.CMSG_PET_CAST_SPELL]);
  const count = (packet) => packet.payload[8];
  assert.deepEqual([...connection.sent[0].payload], [...buildPetCastSpell(VEHICLE, count(connection.sent[0]), CANNON, 0, { unit: ENEMY })]);
  assert.deepEqual([...connection.sent[1].payload], [...buildPetCastSpell(VEHICLE, count(connection.sent[1]), FLAME, 0, { unit: ENEMY })],
    "a spell without a trajectory row");

  connection.sent.length = 0;
  client.controlledGuid = undefined;
  client.castSpell(STRIKE);
  assert.deepEqual(connection.sent.map(({ opcode }) => opcode), [OPCODES.CMSG_CAST_SPELL]);
  const castCount = connection.sent[0].payload[0];
  assert.deepEqual([...connection.sent[0].payload],
    [...buildCastSpell(STRIKE, castCount, client.state.objects.get(ENEMY)?.position ?? { x: 0, y: 0, z: 0, orientation: 0 })],
    "an ordinary spell of the character");
  setMissileShotSource(undefined);
  client.close();
});

/** The casts and re-aims among what the client sent (a mover change also sends CMSG_SET_ACTIVE_MOVER, M7-0). */
const CAST_OPCODES = new Set([OPCODES.CMSG_PET_CAST_SPELL, OPCODES.CMSG_CAST_SPELL, OPCODES.CMSG_UPDATE_MISSILE_TRAJECTORY]);
const castsOf = (connection) => connection.sent.filter(({ opcode }) => CAST_OPCODES.has(opcode));

test("11.02-E: the vehicle's shot — CMSG_PET_CAST_SPELL with flag 2, the points, the aim and MSG_MOVE_STOP", async () => {
  const { client, connection, deliver } = await vehicleClient();
  const { source, calls } = fakeSource();
  setMissileShotSource(source);
  client.controlledGuid = VEHICLE;
  client.usePetSlot(0);
  assert.deepEqual(castsOf(connection).map(({ opcode }) => opcode), [OPCODES.CMSG_PET_CAST_SPELL]);
  assert.deepEqual(calls, [[VEHICLE, CANNON]]);
  const reader = new PacketReader(castsOf(connection)[0].payload);
  assert.equal(reader.u64(), VEHICLE);
  reader.u8();
  assert.equal(reader.u32(), CANNON);
  assert.equal(reader.u8(), 2, "castFlags 2");
  assert.equal(reader.u32(), 0x62);
  assert.equal(reader.packedGuid(), ENEMY, "the press's unit stays; the core drops it (InitExplicitTargets)");
  reader.packedGuid();
  assert.deepEqual([reader.f32(), reader.f32(), reader.f32()], [3, 4, 5], "fire point");
  reader.packedGuid();
  assert.deepEqual([reader.f32(), reader.f32(), reader.f32()], [60, 4, 1], "impact point");
  assert.deepEqual([reader.f32(), reader.f32()], [0.25, 65]);
  assert.equal(reader.u8(), 1);
  assert.equal(reader.u32(), OPCODES.MSG_MOVE_STOP);
  assert.equal(reader.packedGuid(), VEHICLE, "the mover's movement, not the character's");
  assert.equal(readMovementInfo(reader).position.x, 3);
  reader.assertFinished();

  // Before SPELL_START nothing is in progress; the SPELL_START of another caster arms nothing.
  await deliver(OPCODES.SMSG_SPELL_START, startPacket(ENEMY, CANNON, 30));
  await wait(60);
  assert.equal(castsOf(connection).length, 1);
  // The vehicle's own: re-aimed once when the cast time since the send is up.
  await deliver(OPCODES.SMSG_SPELL_START, startPacket(VEHICLE, CANNON, 120));
  client.usePetSlot(0);
  assert.equal(castsOf(connection).length, 1, "a second shot while the first is started and not re-aimed: nothing (SPELL_IN_PROGRESS)");
  await wait(250);
  assert.deepEqual(castsOf(connection).map(({ opcode }) => opcode), [OPCODES.CMSG_PET_CAST_SPELL, OPCODES.CMSG_UPDATE_MISSILE_TRAJECTORY]);
  const update = new PacketReader(castsOf(connection)[1].payload);
  assert.equal(update.u64(), VEHICLE);
  assert.equal(update.u32(), CANNON);
  assert.equal(update.f32(), 0.5, "solved again with the aim as it is now");
  assert.equal(calls.length, 2);
  await wait(60);
  assert.equal(castsOf(connection).length, 2, "once");
  client.usePetSlot(0);
  assert.equal(castsOf(connection).length, 3, "the next shot goes again");
  setMissileShotSource(undefined);
  client.close();
});

test("11.02-E: the character — its trajectory spell with flag 2 when it is the mover, nothing while it drives", async () => {
  const { client, connection, deliver, statuses } = await vehicleClient();
  const { source } = fakeSource();
  setMissileShotSource(source);
  client.controlledGuid = VEHICLE;
  client.castSpell(LEAP);
  assert.equal(castsOf(connection).length, 0, "\"Missile trajectory does not have active mover caster\" (0x0080b3ad): dropped");
  client.controlledGuid = undefined;
  client.castSpell(LEAP);
  assert.deepEqual(castsOf(connection).map(({ opcode }) => opcode), [OPCODES.CMSG_CAST_SPELL]);
  const cast = new PacketReader(castsOf(connection)[0].payload);
  cast.u8();
  assert.equal(cast.u32(), LEAP);
  assert.equal(cast.u8(), 2);
  assert.equal(cast.u32(), 0x60, "no unit named");
  await deliver(OPCODES.SMSG_SPELL_START, startPacket(SELF, LEAP, 150));
  client.castSpell(LEAP);
  assert.equal(castsOf(connection).length, 1);
  assert.ok(statuses.some(({ text, error }) => error && /Выполняется другое действие|SPELL_IN_PROGRESS/.test(text)), JSON.stringify(statuses));
  client.close();
  await wait(250);
  assert.equal(castsOf(connection).length, 1, "no re-aim after close");
  setMissileShotSource(undefined);
});

test("11.02-E: a vehicle's bar arriving primes the page's tables; a pet's bar does not", async () => {
  const { client, deliver } = await vehicleClient();
  const { source } = fakeSource();
  setMissileShotSource(source);
  const barOf = (guid, words) => {
    const bar = new PacketWriter().u64(guid).u16(0).u32(0).u32(0x00000101);
    for (let slot = 0; slot < 10; slot++) bar.u32(words[slot] ?? 0);
    return bar.u8(0).u8(0).toUint8Array();
  };
  // A hunter's pet: commands, reactions and ACT_ENABLED spells (states 7, 6, 0xC1).
  await deliver(OPCODES.SMSG_PET_SPELLS, barOf(0xf140_0000_0000_0011n, [packPetAction(2, 7), packPetAction(1, 6), packPetAction(17253, 0xc1)]));
  assert.equal(source.primed, 0, "no missile tables for a pet");
  // VehicleSpellInitialize: every slot with state i + 8, empty ones included (Player.cpp:21469-21491).
  await deliver(OPCODES.SMSG_PET_SPELLS, barOf(VEHICLE, Array.from({ length: 8 }, (_, slot) => packPetAction(slot === 0 ? CANNON : 0, slot + 8))));
  assert.equal(client.petSpells?.guid, VEHICLE);
  assert.equal(source.primed, 1);
  await deliver(OPCODES.SMSG_PET_SPELLS, barOf(VEHICLE, [0, 0, packPetAction(0, 10)]));
  assert.equal(source.primed, 2, "an empty slot's state is enough");
  setMissileShotSource(undefined);
  client.close();
});

// ---- the dataset ---------------------------------------------------------------------------------

const DBC = "F:/tswowRoot/tswow-install/modules/default/datasets/dataset/dbc/";
const haveDataset = existsSync(`${DBC}SpellMissile.dbc`) && existsSync(`${DBC}Spell.dbc`) && existsSync(`${DBC}Vehicle.dbc`);

/** One column of the row with this id, by binary search on a sorted DBC (a few reads, not the whole file). */
function dbcColumn(file, id, column) {
  const fd = openSync(file, "r");
  try {
    const header = Buffer.alloc(20);
    readSync(fd, header, 0, 20, 0);
    const count = header.readUInt32LE(4);
    const size = header.readUInt32LE(12);
    const word = Buffer.alloc(4);
    const at = (row, col) => { readSync(fd, word, 0, 4, 20 + row * size + col * 4); return word; };
    let low = 0;
    let high = count - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const key = at(mid, 0).readUInt32LE(0);
      if (key === id) return at(mid, column);
      if (key < id) low = mid + 1;
      else high = mid - 1;
    }
    return undefined;
  } finally {
    closeSync(fd);
  }
}

test("11.02-E: the dataset's siege spells — trajectory rows, and their shots on TrinityCore's arc", { skip: !haveDataset && "no dataset" }, () => {
  const file = readFileSync(`${DBC}SpellMissile.dbc`);
  const rows = [];
  for (let index = 0; index < file.readUInt32LE(4); index++) {
    const offset = 20 + index * file.readUInt32LE(12);
    rows.push(spellMissileEntry(Array.from({ length: 15 }, (_, column) =>
      (column < 2 ? file.readUInt32LE(offset + column * 4) : file.readFloatLE(offset + column * 4)))));
  }
  assert.equal(rows.length, 105);
  // Wintergrasp: catapult's Plague Barrel 57606, siege turret's Fire Cannon 57609, demolisher's Hurl Boulder 57618;
  // Strand of the Ancients: 50896 Hurl Boulder, 51362 Fire Cannon.
  const spells = [57606, 57609, 57618, 50896, 51362];
  const catalog = new SpellMissileCatalog(rows, spells.map((id) => [id, dbcColumn(`${DBC}Spell.dbc`, id, 227).readUInt32LE(0)]));
  for (const id of spells) assert.ok(catalog.trajectoryMissile(id), `${id} is a trajectory spell`);
  assert.deepEqual([catalog.missileOfSpell(57609).id, catalog.missileOfSpell(57609).gravity], [1023, 40]);
  // The turret 116 the siege engine carries: ALLOW_PITCHING | CUSTOM_PITCH | ADJUST_AIM_ANGLE, PitchMin/Max.
  const turret = {
    flags: dbcColumn(`${DBC}Vehicle.dbc`, 116, 1).readUInt32LE(0),
    pitchMin: dbcColumn(`${DBC}Vehicle.dbc`, 116, 4).readFloatLE(0),
    pitchMax: dbcColumn(`${DBC}Vehicle.dbc`, 116, 5).readFloatLE(0),
  };
  assert.equal(turret.flags & 0x450, 0x450);
  for (const id of spells) {
    const row = catalog.trajectoryMissile(id);
    for (const pitch of [turret.pitchMin, 0, 0.3, turret.pitchMax, 2]) {
      const shot = solveMissileShot({ missile: row, vehicle: turret, moverPitch: pitch, power: 0, facing: 2, fire: { x: 100, y: 200, z: 30 } },
        plane(10));
      const clamped = Math.min(turret.pitchMax, Math.max(turret.pitchMin, pitch));
      assert.equal(shot.elevation, clamped);
      const dx = shot.impact.x - 100;
      const dy = shot.impact.y - 200;
      const dist2d = Math.hypot(dx, dy);
      assert.ok(Math.abs(Math.atan2(dy, dx) - 2) < 1e-9, "along the facing");
      const s = shot.speed;
      for (const share of [0.25, 0.5, 0.75]) {
        const d = dist2d * share;
        const physical = d * Math.tan(clamped) - (row.gravity * d * d) / (2 * s * s * Math.cos(clamped) ** 2);
        assert.ok(Math.abs(coreTrajectoryHeight(clamped, dist2d, shot.impact.z - 30, d) - physical) < 0.05 + 0.002 * dist2d,
          `${id} at ${clamped.toFixed(3)}: core arc`);
      }
      assert.ok(Math.abs(dist2d / (s * Math.cos(clamped)) - shot.time) < 0.01, `${id}: delay`);
    }
  }
});
