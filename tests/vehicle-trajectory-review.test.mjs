import assert from "node:assert/strict";
import test from "node:test";
import { PacketWriter } from "../dist/code/protocol/index.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import { packPetAction, REACT_DEFENSIVE, COMMAND_FOLLOW } from "../dist/code/world/PetProtocol.js";
import {
  MissileTrajectoryTracker, SPELL_FAILED_ERROR, SPELL_FAILED_SPELL_IN_PROGRESS, missileCastPlan, setMissileShotSource,
} from "../dist/code/world/MissileCast.js";
import { SPELL_MISSILE_CATALOG_VERSION, spellMissileEntry } from "../dist/code/world/SpellMissileDbc.js";
import { game } from "../dist/code/browser/game/Context.js";
import { pageMissileShotSource } from "../dist/code/browser/game/MissileShot.js";
import { forgetSpellMissileClient, spellMissileClient } from "../dist/code/browser/SpellMissileClient.js";

// 11.02-E-review: the adversarial review of the siege-aiming slice. Every cast goes through the trajectory plan now
// (WorldClient castSpell / castSpellAt / #castAsControlledUnit), so the ordinary casts are pinned byte for byte with the
// page's real source and real tables loaded, also while a trajectory cast is in progress; and the review's findings in
// Wow.exe 3.3.5a 12340 (read-only; .runtime/re-2026-10-03/l1102e and the E8-caller scan of this review):
// - 0x007fecc0 (a cast's failure, from the SMSG_CAST_FAILED / SPELL_FAILURE / SPELL_FAILED_OTHER handlers) ends the
//   unit's current cast through 0x007fec00, whose last call (0x007fecb6) is 0x006fbe80(unit, spell): the note is cleared,
//   so the next shot is not SPELL_IN_PROGRESS and no re-aim follows;
// - the per-frame re-aim 0x006fe7e0 is called by the world frame 0x004fa5f0 for the active mover only (DAT_00ca1238): a
//   note left on a unit that is no longer the mover sends nothing;
// - a shot that is not finite is "Could not compute missile trajectory" (SPELL_FAILED_ERROR), not a cast tracked as sent.

const SELF = 0x1234n;
const VEHICLE = 0xf150_7d9a_0000_0042n;
const ENEMY = 0xf130_0000_0000_0077n;
const CANNON = 57609;   // a vehicle trajectory spell (SpellMissile 1023, Flags 1)
const LEAP = 6544;      // a trajectory spell of the character (the same row)
const STRIKE = 78;      // no SpellMissileID
const NOBIT = 7001;     // a SpellMissile row without bit 0
const MISSING = 66223;  // names a SpellMissile id with no row (the dataset's one such spell)
const ORDINARY = [STRIKE, NOBIT, MISSING];
const BAR = [CANNON, STRIKE, NOBIT, MISSING];
const SLOT = new Map(BAR.map((spellId, slot) => [spellId, slot]));

const row = (id, flags) => [id, flags, -0.262, 1.047, 65, 65, 0, 0, 0, 0, 0, 0, 40, 0, 0];
const TABLES = {
  version: SPELL_MISSILE_CATALOG_VERSION,
  missiles: [row(1023, 1), row(2000, 0x10)],
  spells: [[CANNON, 1023], [LEAP, 1023], [NOBIT, 2000], [MISSING, 1823]],
};

function startPacket(caster, spellId, castTime, castId) {
  return new PacketWriter().packedGuid(caster).packedGuid(caster).u8(castId).u32(spellId).u32(0).u32(castTime).u32(0).toUint8Array();
}

function failurePacket(caster, castCount, spellId, result = 40) {
  return new PacketWriter().packedGuid(caster).u8(castCount).u32(spellId).u8(result).toUint8Array();
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
  client.state.move(ENEMY, { flags: 0, position: { x: 30, y: 40, z: 2, orientation: 0 } });
  client.state.objects.get(ENEMY).typeId = 3;
  await client.loginCharacter(SELF);
  await new Promise((resolve) => setImmediate(resolve));
  const bar = BAR.map((spellId, slot) => packPetAction(spellId, slot + 8)).concat(Array(10 - BAR.length).fill(0));
  client.petSpells = {
    guid: VEHICLE, closed: false, creatureFamily: 0, duration: 0, reactState: REACT_DEFENSIVE, commandState: COMMAND_FOLLOW,
    flags: 0, spells: [], cooldowns: [],
    bar: bar.map((packed, slot) => ({ slot, packed, action: packed & 0xffffff, type: packed >>> 24 })),
  };
  client.targetGuid = ENEMY;
  client.knownSpells = [LEAP, ...ORDINARY].map((id, slot) => ({ id, slot }));
  connection.sent.length = 0;
  const statuses = [];
  client.onSpellStatus = (text, error) => statuses.push({ text, error });
  const sentEvents = [];
  client.events.on("SPELL_CAST_SENT", (event) => sentEvents.push({ ...event }));
  const deliver = async (opcode, payload) => {
    const waiter = waiters.shift();
    if (waiter) waiter({ opcode, payload });
    else connection.packets.push({ opcode, payload });
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { client, connection, deliver, statuses, sentEvents };
}

/** Every way a press reaches the cast plan, for each ordinary spell: the character's two and the driven vehicle's two. */
function pressOrdinary(client) {
  for (const spellId of ORDINARY) {
    client.controlledGuid = undefined;
    client.castSpell(spellId);
    client.castSpell(spellId, 0, false, ENEMY);
    client.castSpellAt(spellId, { x: 11, y: 12, z: 13 });
    client.castSpellAt(spellId, { x: 11, y: 12, z: 13 }, 0, false, ENEMY);
    client.controlledGuid = VEHICLE;
    client.usePetSlot(SLOT.get(spellId));
    client.castPetSpell(spellId, SLOT.get(spellId) + 8, ENEMY);
  }
  client.controlledGuid = undefined;
}

const bytes = (sent) => sent.map(({ opcode, payload }) => [opcode, Buffer.from(payload).toString("hex")]);
const CAST_OPCODES = new Set([OPCODES.CMSG_PET_CAST_SPELL, OPCODES.CMSG_CAST_SPELL, OPCODES.CMSG_UPDATE_MISSILE_TRAJECTORY]);
const castsOf = (connection) => connection.sent.filter(({ opcode }) => CAST_OPCODES.has(opcode));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const PAGE = "http://127.0.0.31:28091";

/** The page's own source over the real tables client, with its shots counted. */
async function pageSourceWithTables() {
  forgetSpellMissileClient();
  const tables = spellMissileClient(PAGE, { fetch: async () => new Response(JSON.stringify(TABLES), { status: 200 }) });
  await tables.load();
  game.gatewayOrigin = PAGE;
  const shots = [];
  const source = {
    prime: () => pageMissileShotSource.prime(),
    trajectoryMissile: (spellId) => pageMissileShotSource.trajectoryMissile(spellId),
    shot(casterGuid, spellId) {
      shots.push(spellId);
      return pageMissileShotSource.shot(casterGuid, spellId);
    },
  };
  return { source, shots };
}

function restorePage() {
  setMissileShotSource(pageMissileShotSource);
  game.gatewayOrigin = undefined;
  game.world = undefined;
  forgetSpellMissileClient();
}

test("11.02-E-review: ordinary spells with the page's tables present are the packets they were, byte for byte (table-driven)", async () => {
  try {
    // A: no source at all — the client before slice E.
    setMissileShotSource(undefined);
    const before = await vehicleClient();
    pressOrdinary(before.client);
    // B: the page's real source over the loaded tables.
    const { source, shots } = await pageSourceWithTables();
    setMissileShotSource(source);
    const after = await vehicleClient();
    game.world = after.client;
    assert.equal(source.trajectoryMissile(CANNON)?.id, 1023, "the tables are here");
    assert.equal(source.trajectoryMissile(NOBIT), undefined, "a row without bit 0 is no trajectory (0x0080ac90)");
    pressOrdinary(after.client);
    assert.equal(before.connection.sent.length, ORDINARY.length * 6, "every press sent one packet");
    assert.deepEqual(bytes(after.connection.sent), bytes(before.connection.sent));
    assert.deepEqual(after.statuses, before.statuses);
    assert.deepEqual(after.sentEvents, before.sentEvents);
    assert.deepEqual(shots, [], "no shot is solved for an ordinary spell");
    before.client.close();
    after.client.close();
  } finally {
    restorePage();
  }
});

test("11.02-E-review: a trajectory cast in progress never refuses or changes an ordinary spell (SPELL_IN_PROGRESS is the trajectory's own)", async () => {
  try {
    setMissileShotSource(undefined);
    const before = await vehicleClient();
    const { source, shots } = await pageSourceWithTables();
    setMissileShotSource(source);
    const after = await vehicleClient();
    game.world = after.client;
    for (const side of [before, after]) {
      // The source is the page's, read at each press: none for the client before slice E.
      setMissileShotSource(side === before ? undefined : source);
      // The character's trajectory cast, started with a long cast time; then the vehicle's.
      side.client.castSpell(LEAP);
      await side.deliver(OPCODES.SMSG_SPELL_START, startPacket(SELF, LEAP, 5_000, side.connection.sent.at(-1).payload[0]));
      side.client.controlledGuid = VEHICLE;
      side.client.usePetSlot(SLOT.get(CANNON));
      await side.deliver(OPCODES.SMSG_SPELL_START, startPacket(VEHICLE, CANNON, 5_000, side.connection.sent.at(-1).payload[8]));
      side.client.controlledGuid = undefined;
    }
    assert.deepEqual(shots, [LEAP, CANNON], "both went out as trajectories on the page's side");
    const mark = after.connection.sent.length;
    assert.equal(mark, before.connection.sent.length);
    setMissileShotSource(undefined);
    pressOrdinary(before.client);
    setMissileShotSource(source);
    pressOrdinary(after.client);
    assert.deepEqual(bytes(after.connection.sent.slice(mark)), bytes(before.connection.sent.slice(mark)));
    assert.equal(after.connection.sent.length - mark, ORDINARY.length * 6);
    assert.ok(!after.statuses.some(({ error }) => error), JSON.stringify(after.statuses));
    // The trajectory spell itself is the one refused while its note is started (the vehicle's, the last noted).
    after.client.controlledGuid = VEHICLE;
    after.client.usePetSlot(SLOT.get(CANNON));
    after.client.controlledGuid = undefined;
    assert.equal(after.connection.sent.length - mark, ORDINARY.length * 6);
    assert.ok(after.statuses.some(({ error }) => error), "SPELL_IN_PROGRESS said");
    before.client.close();
    after.client.close();
  } finally {
    restorePage();
  }
});

/** A stand-in solver: CANNON and LEAP are trajectory spells; `impact` decides the shot. */
function fakeSource(impact = { x: 60, y: 4, z: 1 }) {
  return {
    trajectoryMissile: (spellId) => (spellId === CANNON || spellId === LEAP ? spellMissileEntry(row(1023, 1)) : undefined),
    shot: () => ({ elevation: 0.25, speed: 65, fire: { x: 3, y: 4, z: 5 }, impact, time: 1 }),
  };
}

test("11.02-E-review: a failed or interrupted shot clears the note (0x007fecc0 → 0x007fec00 → 0x006fbe80): the next goes, no re-aim", async () => {
  const { client, connection, deliver, statuses } = await vehicleClient();
  try {
    setMissileShotSource(fakeSource());
    client.controlledGuid = VEHICLE;
    client.usePetSlot(SLOT.get(CANNON));
    const castCount = castsOf(connection)[0].payload[8];
    await deliver(OPCODES.SMSG_SPELL_START, startPacket(VEHICLE, CANNON, 120, castCount));
    // Spell::SendInterrupted: SPELL_FAILURE and SPELL_FAILED_OTHER, both naming the vehicle's cast.
    await deliver(OPCODES.SMSG_SPELL_FAILURE, failurePacket(VEHICLE, castCount, CANNON));
    await deliver(OPCODES.SMSG_SPELL_FAILED_OTHER, failurePacket(VEHICLE, castCount, CANNON));
    client.usePetSlot(SLOT.get(CANNON));
    assert.deepEqual(castsOf(connection).map(({ opcode }) => opcode), [OPCODES.CMSG_PET_CAST_SPELL, OPCODES.CMSG_PET_CAST_SPELL],
      "the next shot is not refused as SPELL_IN_PROGRESS");
    assert.ok(!statuses.some(({ error }) => error), JSON.stringify(statuses));

    // That one starts and is interrupted in turn, with nothing cast after it: no re-aim when its time is up.
    const second = castsOf(connection)[1].payload[8];
    await deliver(OPCODES.SMSG_SPELL_START, startPacket(VEHICLE, CANNON, 120, second));
    await deliver(OPCODES.SMSG_SPELL_FAILURE, failurePacket(VEHICLE, second, CANNON));
    await deliver(OPCODES.SMSG_SPELL_FAILED_OTHER, failurePacket(VEHICLE, second, CANNON));
    await wait(250);
    assert.equal(castsOf(connection).length, 2, "the failed cast is not re-aimed");

    // Another unit's failure, or another spell's, leaves the note.
    client.usePetSlot(SLOT.get(CANNON));
    const third = castsOf(connection)[2].payload[8];
    await deliver(OPCODES.SMSG_SPELL_START, startPacket(VEHICLE, CANNON, 400, third));
    await deliver(OPCODES.SMSG_SPELL_FAILURE, failurePacket(ENEMY, third, CANNON));
    await deliver(OPCODES.SMSG_SPELL_FAILURE, failurePacket(VEHICLE, third, STRIKE));
    client.usePetSlot(SLOT.get(CANNON));
    assert.equal(castsOf(connection).length, 3, "still in progress");
    await wait(500);
    assert.deepEqual(castsOf(connection).map(({ opcode }) => opcode).slice(3), [OPCODES.CMSG_UPDATE_MISSILE_TRAJECTORY], "re-aimed once");
  } finally {
    client.close();
    setMissileShotSource(pageMissileShotSource);
  }
});

test("11.02-E-review: the re-aim is the active mover's (0x004fa5f0 → 0x006fe7e0): a vehicle left before the cast time is up sends nothing", async () => {
  const { client, connection, deliver } = await vehicleClient();
  try {
    setMissileShotSource(fakeSource());
    client.controlledGuid = VEHICLE;
    client.usePetSlot(SLOT.get(CANNON));
    await deliver(OPCODES.SMSG_SPELL_START, startPacket(VEHICLE, CANNON, 120, castsOf(connection)[0].payload[8]));
    client.controlledGuid = undefined;
    await wait(250);
    assert.deepEqual(castsOf(connection).map(({ opcode }) => opcode), [OPCODES.CMSG_PET_CAST_SPELL], "no CMSG_UPDATE_MISSILE_TRAJECTORY with `u8 0`");
    // Back at the wheel: the next shot goes (the note is gone, not waiting for the mover's return).
    client.controlledGuid = VEHICLE;
    client.usePetSlot(SLOT.get(CANNON));
    assert.equal(castsOf(connection).length, 2);
    // That one started too; out of the seat at once: the started note is the vehicle's (0x006fbeb0 is the unit's own),
    // so the character's trajectory spell goes.
    await deliver(OPCODES.SMSG_SPELL_START, startPacket(VEHICLE, CANNON, 5_000, castsOf(connection)[1].payload[8]));
    client.controlledGuid = undefined;
    client.castSpell(LEAP);
    assert.deepEqual(castsOf(connection).map(({ opcode }) => opcode).at(-1), OPCODES.CMSG_CAST_SPELL);
    assert.equal(castsOf(connection).length, 3);
  } finally {
    client.close();
    setMissileShotSource(pageMissileShotSource);
  }
});

test("11.02-E-review: a shot that is not finite is SPELL_FAILED_ERROR — nothing sent, nothing tracked, the cast count kept", async () => {
  const tracker = new MissileTrajectoryTracker(() => {}, { set: () => 0, clear: () => {} });
  for (const impact of [{ x: Number.NaN, y: 0, z: 0 }, { x: 0, y: Number.POSITIVE_INFINITY, z: 0 }]) {
    assert.deepEqual(missileCastPlan(fakeSource(impact), tracker, CANNON, VEHICLE, VEHICLE), { refused: SPELL_FAILED_ERROR });
  }
  const odd = { ...fakeSource(), shot: () => ({ elevation: Number.NaN, speed: 65, fire: { x: 0, y: 0, z: 0 }, impact: { x: 1, y: 0, z: 0 }, time: 0 }) };
  assert.deepEqual(missileCastPlan(odd, tracker, CANNON, VEHICLE, VEHICLE), { refused: SPELL_FAILED_ERROR });
  assert.equal(SPELL_FAILED_SPELL_IN_PROGRESS, 105);

  const { client, connection, statuses, sentEvents } = await vehicleClient();
  try {
    setMissileShotSource(fakeSource({ x: Number.NaN, y: 0, z: 0 }));
    client.castSpell(STRIKE);
    const count = connection.sent.at(-1).payload[0];
    const said = statuses.length;
    client.castSpell(LEAP);
    client.castSpellAt(LEAP, { x: 1, y: 2, z: 3 });
    assert.equal(castsOf(connection).length, 1, "nothing goes out");
    assert.deepEqual(sentEvents.map(({ spellId }) => spellId), [STRIKE], "no UNIT_SPELLCAST_SENT for a cast never sent");
    assert.deepEqual(statuses.slice(said).map(({ error }) => error), [true, true], `the refusal, never «sent»: ${JSON.stringify(statuses)}`);
    client.castSpell(STRIKE);
    assert.equal(connection.sent.at(-1).payload[0], (count + 1) & 0xff, "the refused casts drew no count");
    client.controlledGuid = VEHICLE;
    client.usePetSlot(SLOT.get(CANNON));
    assert.equal(castsOf(connection).length, 2, "the vehicle's shot is not sent either");
  } finally {
    client.close();
    setMissileShotSource(pageMissileShotSource);
  }
});

test("11.02-E-review: the page's source against an old gateway — casts never start a new cycle, a vehicle bar does", async () => {
  const old = "http://127.0.0.32:28091";
  let asked = 0;
  try {
    forgetSpellMissileClient();
    const client = spellMissileClient(old, {
      fetch: async () => { asked++; return new Response("", { status: 404 }); }, maxAttempts: 1,
      clock: { setTimeout: () => 0, clearTimeout: () => {} },
    });
    game.gatewayOrigin = old;
    assert.equal(pageMissileShotSource.trajectoryMissile(CANNON), undefined, "the first cast asks");
    await client.load();
    assert.equal(client.state, "failed");
    for (let press = 0; press < 5; press++) assert.equal(pageMissileShotSource.trajectoryMissile(CANNON), undefined);
    await client.load();
    assert.equal(asked, 1, "a cast after the failed cycle asks nothing");
    pageMissileShotSource.prime();
    await client.load();
    assert.equal(asked, 2, "a vehicle bar arriving starts a new cycle");
  } finally {
    restorePage();
  }
});
