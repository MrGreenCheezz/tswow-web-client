import assert from "node:assert/strict";
import test from "node:test";

// World cast events have two subscribers per attach: the player cast bar and the arena opponents' cast
// bars (FrameXmlArena.ts). The checks below are about duplicates on re-attach and a clean detach.
const CAST_SUBSCRIBERS = 2;

const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { WorldClient } = await import("../dist/code/world/WorldClient.js");
const { OPCODES } = await import("../dist/code/generated/opcodes.js");
const { PacketWriter } = await import("../dist/code/protocol/index.js");

class FakePacketEvents {
  #listeners = new Map();
  subscriptions = [];

  on(name, listener) {
    let listeners = this.#listeners.get(name);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(name, listeners);
    }
    listeners.add(listener);
    const unsubscribe = () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(name);
    };
    this.subscriptions.push({ name, unsubscribe });
    return unsubscribe;
  }

  emit(name, payload) {
    for (const listener of [...(this.#listeners.get(name) ?? [])]) listener(payload);
  }

  listenerCount(name) {
    return this.#listeners.get(name)?.size ?? 0;
  }
}

function fixture({ channel = false, castCount = 17, metadata = true } = {}) {
  const selfGuid = 0x10n;
  const events = new FakePacketEvents();
  const cast = {
    spellId: 42,
    startedAt: 900,
    duration: channel ? 4000 : 2500,
    channel,
    castCount,
  };
  const world = {
    state: { selfGuid },
    casts: new Map([[selfGuid, cast]]),
    events,
  };
  const fired = [];
  let pumpNow = 123.456;
  const pump = {
    fire: (event, ...args) => {
      fired.push([event, ...args]);
      return 1;
    },
    now: () => pumpNow,
  };
  const seam = new LiveWorldSeam({
    world: () => world,
    store: () => undefined,
    spell: (id) => metadata && id === 42 ? {
      id,
      name: "Test Spell",
      rank: "Rank 2",
      iconPath: "Interface\\Icons\\Spell_Test",
    } : undefined,
    monotonic: () => 1000,
    globalCooldownUntil: () => 0,
    castSpell: () => {},
  });
  return { events, world, cast, seam, pump, fired, selfGuid, setPumpNow: (value) => { pumpNow = value; } };
}

test("partial world money reads as zero without publishing a fabricated change", () => {
  const { seam, pump, fired } = fixture();

  assert.doesNotThrow(() => seam.attach(pump));
  assert.equal(seam.money(), 0);
  assert.deepEqual(fired.filter(([event]) => event === "PLAYER_MONEY"), []);
});

test("player cast tuple uses pump time axis and the expected metadata shape", () => {
  const { seam, pump } = fixture();
  seam.attach(pump);

  assert.deepEqual(seam.unitCastingInfo("player"), [
    "Test Spell", "Rank 2", "Test Spell", "Interface\\Icons\\Spell_Test",
    123356, 125856, false, 17, false,
  ]);
  assert.equal(seam.unitChannelInfo("player"), undefined);
  assert.equal(seam.unitCastingInfo("target"), undefined);
});

test("cast start, delayed, interrupted and stop events carry the player and cast identity", () => {
  const { events, world, cast, seam, pump, fired, selfGuid } = fixture();
  seam.attach(pump);
  fired.length = 0;

  events.emit("SPELL_CAST_START", { casterGuid: selfGuid, spellId: 42, castTime: 2500, channel: false });
  assert.deepEqual(fired, [["UNIT_SPELLCAST_START", "player", "Test Spell", "Rank 2", 17]]);

  fired.length = 0;
  events.emit("SPELL_CAST_DELAYED", { casterGuid: selfGuid, delay: 125 });
  assert.deepEqual(fired, [["UNIT_SPELLCAST_DELAYED", "player", "Test Spell", "Rank 2", 17]]);

  fired.length = 0;
  events.emit("SPELL_CAST_STOP", { casterGuid: selfGuid, spellId: 42, interrupted: true });
  assert.deepEqual(fired, [["UNIT_SPELLCAST_INTERRUPTED", "player", "Test Spell", "Rank 2", 17]]);
  world.casts.delete(selfGuid);
  assert.equal(seam.unitCastingInfo("player"), undefined);

  // A clean stop after a new start must use STOP, not the stale interrupted event.
  world.casts.set(selfGuid, cast);
  fired.length = 0;
  events.emit("SPELL_CAST_START", { casterGuid: selfGuid, spellId: 42, castTime: 2500, channel: false });
  events.emit("SPELL_CAST_STOP", { casterGuid: selfGuid, spellId: 42, interrupted: false });
  assert.deepEqual(fired, [
    ["UNIT_SPELLCAST_START", "player", "Test Spell", "Rank 2", 17],
    ["UNIT_SPELLCAST_STOP", "player", "Test Spell", "Rank 2", 17],
  ]);
});

test("channel start, update and stop preserve channel state after the world deletes the cast", () => {
  const { events, world, cast, seam, pump, fired, selfGuid } = fixture({ channel: true, castCount: undefined });
  seam.attach(pump);
  fired.length = 0;

  events.emit("SPELL_CAST_START", { casterGuid: selfGuid, spellId: 42, castTime: 4000, channel: true });
  assert.equal(seam.unitCastingInfo("player"), undefined);
  assert.deepEqual(seam.unitChannelInfo("player"), [
    "Test Spell", "Rank 2", "Test Spell", "Interface\\Icons\\Spell_Test",
    123356, 127356, false, false,
  ]);
  assert.deepEqual(fired, [["UNIT_SPELLCAST_CHANNEL_START", "player"]]);

  fired.length = 0;
  events.emit("SPELL_CHANNEL_UPDATE", { casterGuid: selfGuid, spellId: 42, remaining: 2100 });
  assert.deepEqual(fired, [["UNIT_SPELLCAST_CHANNEL_UPDATE", "player"]]);

  fired.length = 0;
  world.casts.delete(selfGuid);
  events.emit("SPELL_CAST_STOP", { casterGuid: selfGuid, spellId: 42, interrupted: false });
  assert.deepEqual(fired, [["UNIT_SPELLCAST_CHANNEL_STOP", "player"]]);
  assert.equal(seam.unitChannelInfo("player"), undefined);
  void cast;
});

test("attach seeds an active ordinary cast before its world stop edge", () => {
  const { events, world, seam, pump, fired, selfGuid } = fixture({ castCount: 31 });
  seam.attach(pump);
  fired.length = 0;
  world.casts.delete(selfGuid);
  events.emit("SPELL_CAST_STOP", { casterGuid: selfGuid, spellId: 42, interrupted: false });
  assert.deepEqual(fired, [["UNIT_SPELLCAST_STOP", "player", "Test Spell", "Rank 2", 31]]);

  // Reattaching reseeds the new active cast and still installs exactly one listener per event.
  world.casts.set(selfGuid, {
    spellId: 42, startedAt: 900, duration: 2500, channel: false, castCount: 32,
  });
  seam.attach(pump);
  assert.equal(events.listenerCount("SPELL_CAST_START"), CAST_SUBSCRIBERS);
  fired.length = 0;
  world.casts.delete(selfGuid);
  events.emit("SPELL_CAST_STOP", { casterGuid: selfGuid, spellId: 42, interrupted: true });
  assert.deepEqual(fired, [["UNIT_SPELLCAST_INTERRUPTED", "player", "Test Spell", "Rank 2", 32]]);
  seam.detach();
});

test("attach seeds an active channel so its deleted-world stop remains CHANNEL_STOP", () => {
  const { events, world, seam, pump, fired, selfGuid } = fixture({ channel: true });
  seam.attach(pump);
  fired.length = 0;
  assert.deepEqual(seam.unitChannelInfo("player"), [
    "Test Spell", "Rank 2", "Test Spell", "Interface\\Icons\\Spell_Test",
    123356, 127356, false, false,
  ]);
  world.casts.delete(selfGuid);
  events.emit("SPELL_CAST_STOP", { casterGuid: selfGuid, spellId: 42, interrupted: false });
  assert.deepEqual(fired, [["UNIT_SPELLCAST_CHANNEL_STOP", "player"]]);
  seam.detach();
});

test("cast stop reason maps failure, interruption and success without guessing", () => {
  const { events, world, seam, pump, fired, selfGuid } = fixture({ castCount: 41 });
  seam.attach(pump);
  fired.length = 0;

  events.emit("SPELL_CAST_START", { casterGuid: selfGuid, spellId: 42, castTime: 2500, channel: false });
  fired.length = 0;
  world.casts.delete(selfGuid);
  events.emit("SPELL_CAST_STOP", {
    casterGuid: selfGuid, spellId: 42, interrupted: true, reason: "failed",
  });
  assert.deepEqual(fired, [["UNIT_SPELLCAST_FAILED", "player", "Test Spell", "Rank 2", 41]]);

  world.casts.set(selfGuid, {
    spellId: 42, startedAt: 900, duration: 2500, channel: false, castCount: 42,
  });
  events.emit("SPELL_CAST_START", { casterGuid: selfGuid, spellId: 42, castTime: 2500, channel: false });
  fired.length = 0;
  world.casts.delete(selfGuid);
  events.emit("SPELL_CAST_STOP", {
    casterGuid: selfGuid, spellId: 42, interrupted: true, reason: "interrupted",
  });
  assert.deepEqual(fired, [["UNIT_SPELLCAST_INTERRUPTED", "player", "Test Spell", "Rank 2", 42]]);

  world.casts.set(selfGuid, {
    spellId: 42, startedAt: 900, duration: 2500, channel: false, castCount: 43,
  });
  events.emit("SPELL_CAST_START", { casterGuid: selfGuid, spellId: 42, castTime: 2500, channel: false });
  fired.length = 0;
  world.casts.delete(selfGuid);
  events.emit("SPELL_CAST_STOP", {
    casterGuid: selfGuid, spellId: 42, interrupted: false, reason: "success",
  });
  assert.deepEqual(fired, [["UNIT_SPELLCAST_STOP", "player", "Test Spell", "Rank 2", 43]]);
});

test("active cast uses a stable synchronous fallback when spell metadata is unavailable", () => {
  const { seam, pump } = fixture({ metadata: false, castCount: 51 });
  seam.attach(pump);
  assert.deepEqual(seam.unitCastingInfo("player"), [
    "Заклинание 42", "", "Заклинание 42", "",
    123356, 125856, false, 51, false,
  ]);
});

test("WorldClient packet edges preserve failure versus successful stop reason", async () => {
  const guid = 0x10n;
  const login = new PacketWriter().u32(1).f32(1).f32(2).f32(3).f32(0).toUint8Array();
  const spellStart = new PacketWriter()
    .packedGuid(guid).packedGuid(guid).u8(61).u32(42).u32(0).u32(2500)
    .toUint8Array();
  const spellFailure = new PacketWriter()
    .packedGuid(guid).u8(61).u32(42).u8(50)
    .toUint8Array();
  const interruptedFailure = new PacketWriter()
    .packedGuid(guid).u8(62).u32(42).u8(40)
    .toUint8Array();
  const spellGo = new PacketWriter()
    .packedGuid(guid).packedGuid(guid).u8(63).u32(42).u32(0).u32(100).u8(0).u8(0)
    .toUint8Array();
  const connection = {
    packets: [
      { opcode: OPCODES.SMSG_LOGIN_VERIFY_WORLD, payload: login },
      { opcode: OPCODES.SMSG_SPELL_START, payload: spellStart },
      { opcode: OPCODES.SMSG_SPELL_FAILURE, payload: spellFailure },
      { opcode: OPCODES.SMSG_SPELL_START, payload: new PacketWriter()
        .packedGuid(guid).packedGuid(guid).u8(62).u32(42).u32(0).u32(2500).toUint8Array() },
      { opcode: OPCODES.SMSG_SPELL_FAILURE, payload: interruptedFailure },
      { opcode: OPCODES.SMSG_SPELL_START, payload: new PacketWriter()
        .packedGuid(guid).packedGuid(guid).u8(63).u32(42).u32(0).u32(2500).toUint8Array() },
      { opcode: OPCODES.SMSG_SPELL_GO, payload: spellGo },
    ],
    send() {},
    read() { return this.packets.length ? Promise.resolve(this.packets.shift()) : new Promise(() => {}); },
    close() {},
  };
  const client = new WorldClient(connection);
  const stops = [];
  client.events.on("SPELL_CAST_STOP", (event) => stops.push(event));
  await client.loginCharacter(guid);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(stops.map(({ spellId, interrupted, reason }) => ({ spellId, interrupted, reason })), [
    { spellId: 42, interrupted: true, reason: "failed" },
    { spellId: 42, interrupted: true, reason: "interrupted" },
    { spellId: 42, interrupted: false, reason: "success" },
  ]);
  client.close();
});

test("non-self casts are ignored and detach removes every cast subscription", () => {
  const { events, seam, pump, fired, selfGuid } = fixture();
  seam.attach(pump);
  fired.length = 0;
  events.emit("SPELL_CAST_START", { casterGuid: 0x99n, spellId: 42, castTime: 2500, channel: false });
  events.emit("SPELL_CAST_STOP", { casterGuid: 0x99n, spellId: 42, interrupted: false });
  assert.deepEqual(fired, []);
  assert.equal(events.listenerCount("SPELL_CAST_START"), CAST_SUBSCRIBERS);
  assert.equal(events.listenerCount("SPELL_CAST_STOP"), CAST_SUBSCRIBERS);
  assert.equal(events.listenerCount("SPELL_CAST_DELAYED"), CAST_SUBSCRIBERS);
  assert.equal(events.listenerCount("SPELL_CHANNEL_UPDATE"), CAST_SUBSCRIBERS);

  seam.detach();
  assert.equal(events.listenerCount("SPELL_CAST_START"), 0);
  assert.equal(events.listenerCount("SPELL_CAST_STOP"), 0);
  assert.equal(events.listenerCount("SPELL_CAST_DELAYED"), 0);
  assert.equal(events.listenerCount("SPELL_CHANNEL_UPDATE"), 0);
  events.emit("SPELL_CAST_START", { casterGuid: selfGuid, spellId: 42, castTime: 2500, channel: false });
  assert.deepEqual(fired, []);
});
