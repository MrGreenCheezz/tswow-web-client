import assert from "node:assert/strict";
import test from "node:test";
import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";
import { PacketReader } from "../dist/code/protocol/PacketReader.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import { defaultSettings, settingBoolean } from "../dist/code/browser/ui/SettingsModel.js";

/*
 * L18-review (04.10, 5.05): the autoRangedCombat controller (world/AutoRangedCombat.ts) is on by default
 * (Wow.exe registers the CVar with "1", 0x0051dbd3), so it now runs every hunter's right click. These are
 * scripted fights against a small stand-in realm that answers the way TrinityCore does, counting what the
 * client puts on the wire per second.
 *
 * The realm, from the core (read-only):
 * * CMSG_ATTACK_SWING: Unit::Attack → SMSG_ATTACK_START; a swing already running at that victim is a silent
 *   no-op (Unit.cpp:5958-5979). CMSG_ATTACK_STOP: Unit::AttackStop → SMSG_ATTACK_STOP only while attacking
 *   (CombatHandler.cpp:64-67, Unit.cpp:6043-6047).
 * * CMSG_CAST_SPELL of Auto Shot: the same spell at the same unit is dropped (SpellHandler.cpp:388-397);
 *   another target replaces the repeat, and the old one's InterruptSpell sends SMSG_CANCEL_AUTO_REPEAT
 *   (Unit::SetCurrentCastSpell → InterruptSpell, Unit.cpp:3293-3294, 3372-3375).
 * * CMSG_CANCEL_AUTO_REPEAT_SPELL: InterruptSpell(CURRENT_AUTOREPEAT_SPELL) → SMSG_CANCEL_AUTO_REPEAT while
 *   one runs (SpellHandler.cpp:525-530) — the echo of the client's own cancel.
 *
 * Wow.exe 3.3.5a 12340 (read-only; .runtime/re-2026-10-01/a9-combat/e2.c 0x006e2be0, a4-world/d4.c
 * 0x006e2610, l15-combat/g2.c 0x0080cce0): the controller has no hysteresis — melee reach strictly inside
 * max(5, reaches + 4/3), the dead zone `d² <= min²` (Auto Shot's SpellRange 114 has min 0, so min is that
 * same reach) — and runs every frame; steady states send nothing. Neither the swing (0x006e2610) nor the
 * shot (0x0080da40 → 0x0080cce0) turns the character, and a BAD_FACING answer only latches the error
 * (0x00756800 case 0x146 → 0x006cee70(2)).
 *
 * Found here (L18-review): the controller's swing went through `startAttack`, whose `faceTarget()` sent
 * MSG_MOVE_SET_FACING and turned the character to the unit at every melee entry — a hunter running from a mob
 * at his back was spun round into it, and so was every BAD_FACING answer. Now only the player's own attack
 * that starts the mode turns to the unit once (this client's convention for an attack); the controller's
 * switches and BAD_FACING while the mode runs turn nobody.
 */

function fakeConnection() {
  const queue = [];
  let wake;
  return {
    sent: [],
    push(opcode, payload = new Uint8Array()) {
      queue.push({ opcode, payload });
      if (wake) {
        const resume = wake;
        wake = undefined;
        resume(queue.shift());
      }
    },
    send(opcode, payload = new Uint8Array()) { this.sent.push({ opcode, payload }); },
    read() {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve) => { wake = resolve; });
    },
    close() {},
  };
}

async function settle() {
  for (let round = 0; round < 6; round++) await new Promise((resolve) => { setImmediate(resolve); });
}

const SELF = 0x1234n;
const A = 9n;
const B = 10n;
const AUTO_SHOT = 75;
const SHOOT = 5019;
const ATTACK = 6603;
/** Auto Shot in the dataset: SpellRange 114 (min 0, max 35, SPELL_RANGE_RANGED) — min is melee reach (5). */
const LIMITS = { min: 5, max: 35 };
const TICK_MS = 100;
const MOVE_FORWARD = 0x1;
const MOVE_BACKWARD = 0x2;

const NAMES = new Map(Object.entries(OPCODES).map(([name, opcode]) => [opcode, name]));
const label = ({ opcode, payload }) => (opcode === OPCODES.CMSG_SET_SHEATHED ? `SHEATH ${payload[0]}` : NAMES.get(opcode));

async function fighter({ spells = [AUTO_SHOT], controllerSpells = [AUTO_SHOT], settings = defaultSettings() } = {}) {
  const connection = fakeConnection();
  connection.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD, new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(0).toUint8Array());
  const client = new WorldClient(connection);
  await client.loginCharacter(SELF);
  await settle();
  client.state.selfGuid = SELF;
  client.state.move(SELF, { flags: 0, position: { x: 0, y: 0, z: 0, orientation: 0 } });
  client.state.objects.get(SELF).typeId = 4;
  client.state.setField(SELF, UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 100);
  client.state.setField(SELF, UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset, 0x8);
  for (const [guid, x] of [[A, 30], [B, 25]]) {
    client.state.move(guid, { flags: 0, position: { x, y: guid === B ? 4 : 0, z: 0, orientation: Math.PI } });
    client.state.objects.get(guid).typeId = 3;
    client.state.setField(guid, UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 100);
  }
  // The live client has the active mover by the time anyone fights: MSG_MOVE_SET_FACING can go out.
  client.movementReady = true;
  client.canAttackUnit = (object) => (object.guid === A || object.guid === B)
    && client.state.objects.get(object.guid)?.fields.get(UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset) > 0;
  client.knownSpells = spells.map((id, slot) => ({ id, slot }));
  client.setAutoRepeatSpellIds(spells.filter((id) => id === AUTO_SHOT || id === SHOOT));
  client.setAutoRangedCombatSpellIds(controllerSpells);
  client.autoRangedLimits = () => LIMITS;
  client.autoRangedCombat = () => settingBoolean(settings, "autoRangedCombat");
  const timer = { started: 0, stopped: 0 };
  client.autoRanged.schedule = { start: () => { timer.started++; return timer; }, stop: () => { timer.stopped++; } };
  await settle();
  connection.sent.length = 0;
  return { client, connection, timer };
}

/**
 * A TrinityCore stand-in: reads what the client sent since the last look and queues the core's answers,
 * delivered `latency` ticks later.
 */
function realm(client, connection, { latency = 1 } = {}) {
  let seen = 0;
  let swing;
  let repeat;
  const due = [];
  const packed = (guid) => new PacketWriter().packedGuid(guid);
  const later = (at, opcode, payload = new Uint8Array()) => due.push({ at, opcode, payload });
  return {
    get repeat() { return repeat; },
    get swing() { return swing; },
    kill(guid, at) {
      client.state.setField(guid, UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 0);
      if (swing === guid) {
        swing = undefined;
        later(at, OPCODES.SMSG_ATTACK_STOP, packed(SELF).packedGuid(guid).u32(1).toUint8Array());
      }
    },
    badFacing(at) { later(at, OPCODES.SMSG_ATTACK_SWING_BAD_FACING); },
    /** Unit::SetStunned → CastStop → InterruptSpell(CURRENT_AUTOREPEAT_SPELL) (Unit.cpp:12259, 1093-1097, 3372-3375). */
    stun(at) {
      if (repeat === undefined) return;
      repeat = undefined;
      later(at, OPCODES.SMSG_CANCEL_AUTO_REPEAT, packed(SELF).toUint8Array());
    },
    react(tick) {
      for (; seen < connection.sent.length; seen++) {
        const { opcode, payload } = connection.sent[seen];
        if (opcode === OPCODES.CMSG_ATTACK_SWING) {
          const victim = new PacketReader(payload).u64();
          if (swing === victim) continue;
          swing = victim;
          later(tick + latency, OPCODES.SMSG_ATTACK_START, new PacketWriter().u64(SELF).u64(victim).toUint8Array());
        } else if (opcode === OPCODES.CMSG_ATTACK_STOP) {
          if (swing === undefined) continue;
          later(tick + latency, OPCODES.SMSG_ATTACK_STOP, packed(SELF).packedGuid(swing).u32(0).toUint8Array());
          swing = undefined;
        } else if (opcode === OPCODES.CMSG_CAST_SPELL) {
          const reader = new PacketReader(payload);
          reader.u8();
          const spell = reader.u32();
          reader.u8();
          reader.u32();
          const target = reader.packedGuid();
          if (spell !== AUTO_SHOT && spell !== SHOOT) continue;
          if (repeat?.spell === spell && repeat.target === target) continue;
          if (repeat !== undefined) later(tick + latency, OPCODES.SMSG_CANCEL_AUTO_REPEAT, packed(SELF).toUint8Array());
          repeat = { spell, target };
        } else if (opcode === OPCODES.CMSG_CANCEL_AUTO_REPEAT_SPELL) {
          if (repeat === undefined) continue;
          repeat = undefined;
          later(tick + latency, OPCODES.SMSG_CANCEL_AUTO_REPEAT, packed(SELF).toUint8Array());
        }
      }
      for (let index = 0; index < due.length;) {
        if (due[index].at <= tick) {
          const { opcode, payload } = due.splice(index, 1)[0];
          connection.push(opcode, payload);
        } else index++;
      }
    },
  };
}

/**
 * Runs `seconds` of fight at the controller's 100 ms tick: `script(tick)` moves the world, the controller
 * ticks while registered, the realm answers. Returns every client packet with the tick it went out on.
 */
async function fight(client, connection, server, seconds, script) {
  const log = [];
  let logged = 0;
  for (let tick = 0; tick < seconds * 1000 / TICK_MS; tick++) {
    await script(tick);
    if (client.autoRanged.active) client.autoRanged.tick();
    server.react(tick);
    await settle();
    server.react(tick); // what the answers made the client send
    for (; logged < connection.sent.length; logged++) log.push({ tick, ...connection.sent[logged] });
  }
  return log;
}

/** The busiest second of the log: the most packets inside any 10-tick window. */
function busiestSecond(log) {
  let best = 0;
  for (const { tick } of log) best = Math.max(best, log.filter((entry) => entry.tick >= tick && entry.tick < tick + 10).length);
  return best;
}

const count = (log, opcode) => log.filter((entry) => entry.opcode === opcode).length;
const within = (log, from, to) => log.filter(({ tick }) => tick >= from && tick < to);
const place = (client, guid, x, y = 0) => {
  const position = client.state.objects.get(guid).position;
  client.state.objects.get(guid).position = { x, y, z: 0, orientation: position.orientation };
};
const distance = (client, guid) => {
  const self = client.state.objects.get(SELF).position;
  const other = client.state.objects.get(guid).position;
  return Math.hypot(other.x - self.x, other.y - self.y);
};

/**
 * A chasing mob as the core moves it (ChaseMovementGenerator): out of melee reach it runs at 7 yd/s to
 * 3.5 yd (contact distance) from where the realm last saw the player — `lag` ticks ago, the heartbeat and
 * the spline's trip both ways — as this client sees the spline.
 */
function chase(client, guid, { speed = 0.7, stop = 3.5, reach = 5, lag = 3 } = {}) {
  let chasing = false;
  const seen = [];
  return () => {
    const now = client.state.objects.get(SELF).position;
    seen.push({ x: now.x, y: now.y });
    const self = seen.length > lag ? seen[seen.length - 1 - lag] : seen[0];
    const mob = client.state.objects.get(guid).position;
    const dx = self.x - mob.x;
    const dy = self.y - mob.y;
    const gap = Math.hypot(dx, dy);
    if (gap > reach) chasing = true;
    if (!chasing) return;
    const step = Math.min(speed, gap - stop);
    if (step <= 0) {
      chasing = false;
      return;
    }
    place(client, guid, mob.x + dx / gap * step, mob.y + dy / gap * step);
  };
}

const labels = (log) => log.map(label);

test("L18-review: an ordinary hunter fight — silence in steady states, packets only on the switches", async () => {
  const { client, connection } = await fighter();
  const server = realm(client, connection);
  const self = client.state.objects.get(SELF);
  const mob = chase(client, A);
  client.selectTarget(A);
  const log = await fight(client, connection, server, 30, (tick) => {
    if (tick === 0) client.startAttack(); // the right click
    if (tick >= 5 && tick < 100) mob(); // aggro at 0.5 s, runs in, melee until 10 s
    if (tick >= 100 && tick < 120) { // backpedal 2 s at 4.5 yd/s, the mob chasing
      self.movementFlags = MOVE_BACKWARD;
      self.position = { ...self.position, x: self.position.x - 0.45 };
      mob();
    }
    if (tick === 120) self.movementFlags = 0;
    if (tick >= 120 && tick < 130) mob();
    if (tick === 130) self.position = { ...self.position, x: self.position.x - 15 }; // Disengage
    if (tick >= 140 && tick < 220) mob(); // back to melee
    if (tick === 220) server.kill(A, tick + 1); // dies in melee reach
  });
  assert.deepEqual(labels(within(log, 0, 1)), ["CMSG_SET_SELECTION", "MSG_MOVE_SET_FACING", "SHEATH 2", "CMSG_CAST_SPELL"],
    "the right click: the character faced once, as this client's attacks always have, and the shot");
  assert.deepEqual(labels(within(log, 1, 30)), [], "repeating at range: silence");
  assert.deepEqual(labels(within(log, 30, 60)), ["CMSG_CANCEL_AUTO_REPEAT_SPELL", "SHEATH 0", "SHEATH 1", "CMSG_ATTACK_SWING"],
    "the mob arrives: the swing cancels the shot (0x006e2610)");
  assert.deepEqual(labels(within(log, 60, 100)), [], "swinging in reach: silence");
  assert.deepEqual(labels(within(log, 100, 130)), ["CMSG_ATTACK_STOP", "SHEATH 1", "CMSG_ATTACK_SWING"],
    "the backpedal: out of reach the swing stops (no shot on the move), the mob catches up and it swings again");
  assert.deepEqual(labels(within(log, 130, 140)), ["CMSG_ATTACK_STOP", "SHEATH 2", "CMSG_CAST_SPELL"], "Disengage: the shot");
  assert.deepEqual(labels(within(log, 140, 300)), ["CMSG_CANCEL_AUTO_REPEAT_SPELL", "SHEATH 0", "SHEATH 1", "CMSG_ATTACK_SWING"],
    "back in reach: the swing; the kill in reach sends nothing");
  assert.equal(count(log, OPCODES.MSG_MOVE_SET_FACING), 1, "the controller's own switches never turn the character");
  assert.ok(busiestSecond(log) <= 4, `busiest second ${busiestSecond(log)}`);
  assert.equal(log.length, 18, "0.6 packets a second over the fight");
  assert.equal(client.autoRanged.active, true, "a unit that died in reach leaves the mode registered (Wow.exe's melee branch, too)");
  client.close();
});

test("L18-review: kiting — the mob catching up behind a running hunter is swung at; the run keeps its heading", async () => {
  const { client, connection } = await fighter();
  const server = realm(client, connection);
  const self = client.state.objects.get(SELF);
  place(client, A, 3.5);
  const mob = chase(client, A);
  client.selectTarget(A);
  const headings = new Set();
  const log = await fight(client, connection, server, 12, (tick) => {
    if (tick === 0) client.startAttack(); // in reach: the swing
    if (tick === 20) self.position = { ...self.position, orientation: Math.PI }; // turns its back on the mob
    if (tick >= 21 && tick < 100) { // runs forward (away), dazed every other second
      self.movementFlags = MOVE_FORWARD;
      const speed = tick % 20 < 10 ? 0.7 : 0.45;
      self.position = { ...self.position, x: self.position.x + Math.cos(self.position.orientation) * speed };
      mob();
      headings.add(self.position.orientation);
    }
    if (tick === 100) self.movementFlags = 0;
  });
  assert.deepEqual([...headings], [Math.PI], "no MSG_MOVE_SET_FACING turned the runner round to the mob");
  assert.equal(count(log, OPCODES.MSG_MOVE_SET_FACING), 1, "only the right click's");
  assert.equal(count(log, OPCODES.CMSG_CAST_SPELL), 0, "running forward: no shot (0x33)");
  // Each catch-up a swing (0x006e2610 sends it whatever the facing), each break-away its stop — alternating.
  const swings = log.filter(({ opcode }) => opcode === OPCODES.CMSG_ATTACK_SWING || opcode === OPCODES.CMSG_ATTACK_STOP).map(label);
  assert.ok(swings.length >= 4, swings.join());
  swings.forEach((name, index) => assert.equal(name, index % 2 === 0 ? "CMSG_ATTACK_SWING" : "CMSG_ATTACK_STOP", swings.join()));
  // Per catch-up SHEATH 1 + CMSG_ATTACK_SWING, per break-away CMSG_ATTACK_STOP (Wow.exe: the swing and the stop).
  const run = within(log, 21, 120);
  assert.ok(busiestSecond(run) <= 3, `busiest second ${busiestSecond(run)}`);
  assert.deepEqual([...new Set(labels(run))].sort(), ["CMSG_ATTACK_STOP", "CMSG_ATTACK_SWING", "SHEATH 1"]);
  client.close();
});

test("L18-review: the controller's own shot does not turn the character either (0x0080da40 → 0x0080cce0)", async () => {
  const { client, connection } = await fighter();
  const self = client.state.objects.get(SELF);
  self.movementFlags = MOVE_FORWARD;
  client.selectTarget(A);
  client.startAttack(); // on the run: wanted, not shot
  assert.equal(client.autoRanged.wantedSpellId, AUTO_SHOT);
  assert.equal(client.autoRepeatSpellId, undefined);
  connection.sent.length = 0;
  self.position = { ...self.position, orientation: Math.PI / 3 }; // the target 60° off the nose: in front (dot > 0)
  self.movementFlags = 0;
  client.autoRanged.tick();
  assert.deepEqual(labels(connection.sent), ["SHEATH 2", "CMSG_CAST_SPELL"]);
  assert.equal(self.position.orientation, Math.PI / 3);
  client.close();
});

test("L18-review: /startattack pressed again while the mode runs sends nothing (a macro spammed with a shot)", async () => {
  const { client, connection } = await fighter();
  const self = client.state.objects.get(SELF);
  client.selectTarget(A);
  client.startAttack();
  assert.equal(client.autoRepeatSpellId, AUTO_SHOT);
  connection.sent.length = 0;
  self.position = { ...self.position, orientation: 0.5 }; // strafing round, the target still in front
  for (let press = 0; press < 5; press++) client.startAttack();
  assert.deepEqual(labels(connection.sent), [], "no MSG_MOVE_SET_FACING per press, as the swing path never had");
  assert.equal(self.position.orientation, 0.5);
  client.close();
});

test("L18-review: BAD_FACING while the mode runs only latches the warning (0x00756800 case 0x146); without it, as before", async () => {
  {
    const { client, connection } = await fighter();
    const self = client.state.objects.get(SELF);
    place(client, A, 3.5);
    client.selectTarget(A);
    client.startAttack(); // the swing
    connection.push(OPCODES.SMSG_ATTACK_START, new PacketWriter().u64(SELF).u64(A).toUint8Array());
    await settle();
    self.position = { ...self.position, orientation: Math.PI }; // the player turns away
    connection.sent.length = 0;
    connection.push(OPCODES.SMSG_ATTACK_SWING_BAD_FACING);
    await settle();
    assert.deepEqual(labels(connection.sent), [], "no MSG_MOVE_SET_FACING");
    assert.equal(self.position.orientation, Math.PI);
    assert.equal(client.swingWarning, "Нужно повернуться к цели");
    client.close();
  }
  {
    // A warrior (no controller spell): this client's own convention stays — it turns to the target.
    const { client, connection } = await fighter({ spells: [ATTACK], controllerSpells: [] });
    const self = client.state.objects.get(SELF);
    place(client, A, 3.5);
    client.selectTarget(A);
    client.startAttack();
    connection.push(OPCODES.SMSG_ATTACK_START, new PacketWriter().u64(SELF).u64(A).toUint8Array());
    await settle();
    self.position = { ...self.position, orientation: Math.PI };
    connection.sent.length = 0;
    connection.push(OPCODES.SMSG_ATTACK_SWING_BAD_FACING);
    await settle();
    assert.deepEqual(labels(connection.sent), ["MSG_MOVE_SET_FACING"]);
    assert.equal(self.position.orientation, 0);
    client.close();
  }
});

test("L18-review: Tab while shooting — the realm's echo of the cancel costs one dropped re-cast, then silence", async () => {
  const { client, connection } = await fighter();
  const server = realm(client, connection, { latency: 2 });
  client.selectTarget(A);
  const log = await fight(client, connection, server, 3, (tick) => {
    if (tick === 0) client.startAttack();
    if (tick === 10) client.selectTarget(B);
  });
  const casts = log.filter(({ opcode }) => opcode === OPCODES.CMSG_CAST_SPELL).map(({ tick, payload }) => {
    const reader = new PacketReader(payload);
    reader.u8(); reader.u32(); reader.u8(); reader.u32();
    return `${tick}:${reader.packedGuid()}`;
  });
  // A at the click; B with the Tab (0x5241b0 → 0x006e1660 cancelled A); B again once SMSG_CANCEL_AUTO_REPEAT — the
  // echo of that cancel — cleared the repeat here; the realm drops it (same spell, same unit, SpellHandler.cpp:388-397).
  assert.deepEqual(casts, ["0:9", "10:10", "13:10"]);
  assert.deepEqual(labels(within(log, 14, 30)), [], "then silence");
  assert.deepEqual(server.repeat, { spell: AUTO_SHOT, target: B });
  assert.equal(client.autoRepeatSpellId, AUTO_SHOT);
  client.close();
});

test("L18-review: a stun cancels the repeat on the realm's side; the controller asks once and the realm holds it", async () => {
  const { client, connection } = await fighter();
  const server = realm(client, connection);
  client.selectTarget(A);
  const log = await fight(client, connection, server, 5, (tick) => {
    if (tick === 0) client.startAttack();
    if (tick === 10) server.stun(tick + 1);
  });
  // The stun's SMSG_CANCEL_AUTO_REPEAT clears the repeat here (and the handler puts the bow away); the next tick
  // asks again — the core keeps a refused Auto Shot (Spell.cpp:3251 `!IsAutoRepeat()`, Unit.cpp:3265-3270) — and
  // nothing follows.
  assert.deepEqual(labels(within(log, 1, 50)), ["SHEATH 0", "SHEATH 2", "CMSG_CAST_SPELL"]);
  assert.deepEqual(server.repeat, { spell: AUTO_SHOT, target: A });
  client.close();
});

test("L18-review: at the reach boundary the controller switches on each crossing and only then (0x006e2be0 has no hysteresis)", async () => {
  const { client, connection } = await fighter();
  const server = realm(client, connection);
  place(client, A, 5.4);
  client.selectTarget(A);
  const log = await fight(client, connection, server, 6, (tick) => {
    if (tick === 0) client.startAttack();
    // Half a second just inside reach, half a second just outside, wobbling on its side in between.
    const inside = Math.floor(tick / 5) % 2 === 1;
    const wobble = tick % 2 === 0 ? 0.3 : 0;
    place(client, A, inside ? 4.9 - wobble : 5.1 + wobble);
  });
  for (const { tick } of log) assert.equal(tick % 5, 0, `a packet at ${tick / 10} s, between crossings`);
  assert.deepEqual(labels(within(log, 5, 6)), ["CMSG_CANCEL_AUTO_REPEAT_SPELL", "SHEATH 0", "SHEATH 1", "CMSG_ATTACK_SWING"]);
  assert.deepEqual(labels(within(log, 10, 11)), ["CMSG_ATTACK_STOP", "SHEATH 2", "CMSG_CAST_SPELL"]);
  // A crossing each half second, the worst this boundary does: 7 packets a second (Wow.exe's own four — the
  // swing and the cancel in, the stop and the cast out — plus this client's CMSG_SET_SHEATHED each way).
  const crossings = within(log, 10, 60);
  assert.ok(busiestSecond(crossings) <= 7, `busiest second ${busiestSecond(crossings)}`);
  assert.equal(crossings.length, 35);
  client.close();
});

for (const [who, spells] of [["warrior", [ATTACK]], ["wand user", [ATTACK, SHOOT]]]) {
  test(`L18-review: a ${who}'s fight is byte for byte the same with «Ближний/дальний бой» on and off`, async () => {
    const runs = [];
    for (const settings of [defaultSettings(), { ...defaultSettings(), autoRangedCombat: false }]) {
      const { client, connection, timer } = await fighter({ spells, controllerSpells: [], settings });
      const server = realm(client, connection);
      const mob = chase(client, A);
      client.selectTarget(A);
      const log = await fight(client, connection, server, 15, (tick) => {
        if (tick === 0) client.startAttack();
        if (tick >= 5 && tick < 60) mob();
        if (tick === 60 && spells.includes(SHOOT)) client.castSpell(SHOOT);
        if (tick === 80) client.selectTarget(B);
        if (tick === 100) client.castSpell(ATTACK);
        if (tick === 110) client.castSpell(ATTACK);
        if (tick === 120) server.kill(B, tick + 1);
      });
      assert.equal(timer.started, 0, "no controller tick");
      assert.equal(client.autoRanged.wantedSpellId, undefined);
      // Movement packets carry the client's clock; the rest byte for byte.
      runs.push(log.map(({ tick, opcode, payload }) => `${tick} ${label({ opcode, payload })} ${
        opcode === OPCODES.MSG_MOVE_SET_FACING ? payload.length : Buffer.from(payload).toString("hex")}`));
      client.close();
    }
    assert.ok(runs[0].length > 0);
    assert.deepEqual(runs[0], runs[1]);
  });
}

