// Plan items 5.25 and 3.14 (L3): the battleground spirit guide's resurrection queue as Wow.exe 3.3.5a
// drives it (FrameXmlAreaSpiritHealer.ts): the guide in range (0x524010/0x523f80, 20 yards to take it,
// 22 to keep it), CMSG_AREA_SPIRIT_HEALER_QUERY when it changes (0x523eb0), SMSG_AREA_SPIRIT_HEALER_TIME
// → AREA_SPIRIT_HEALER_IN_RANGE (0x524b10), GetAreaSpiritHealerTime (0x516b90), AcceptAreaSpiritHeal
// → CMSG_AREA_SPIRIT_HEALER_QUEUE (0x5262d0 → 0x524b60), CancelAreaSpiritHeal → AREA_SPIRIT_HEALER_OUT_OF_RANGE
// and CMSG_CANCEL_AURA 2584 (0x522fa0 → 0x51f710 → 0x802f80).
import assert from "node:assert/strict";
import test from "node:test";

const {
  FrameXmlAreaSpiritHealerModel, FRAMEXML_AREA_SPIRIT_HEALER_BINDINGS, frameXmlAreaSpiritHealerLiveContext,
  FRAMEXML_WAITING_TO_RESURRECT_SPELL,
} = await import("../dist/code/browser/framexml/FrameXmlAreaSpiritHealer.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { REACTION_FRIENDLY, REACTION_HOSTILE } = await import("../dist/code/world/FactionRules.js");

const GUIDE = 0xf1300033bc000101n;
const OTHER = 0xf1300033bc000202n;

/** A world double: the timer map WorldClient keeps, and the three commands, recorded. */
function fakeWorld() {
  return {
    spiritHealerTimers: new Map(),
    sent: [],
    queryAreaSpiritHealer(guid) { this.sent.push(["query", guid]); },
    queueAreaSpiritHealer(guid) { this.sent.push(["queue", guid]); },
    cancelAura(spellId) { this.sent.push(["cancelAura", spellId]); },
  };
}

function fixture() {
  const world = fakeWorld();
  const clock = { now: 50_000 };
  const state = { ghost: true, owned: true, distances: new Map([[GUIDE, 10]]) };
  const model = new FrameXmlAreaSpiritHealerModel({
    world: () => world,
    now: () => clock.now,
    ghost: () => state.ghost,
    owned: () => state.owned,
    distanceSquared: (guid) => {
      const yards = state.distances.get(guid);
      return yards === undefined ? undefined : yards * yards;
    },
    findGuide: (limitSquared) => {
      for (const [guid, yards] of state.distances) if (yards * yards <= limitSquared) return guid;
      return undefined;
    },
  });
  const events = [];
  model.attach({ fire(event, ...args) { events.push([event, ...args]); return 1; }, now: () => clock.now / 1000 });
  const answer = (guid, milliseconds) => world.spiritHealerTimers.set(guid, { milliseconds, receivedAt: clock.now });
  const call = (name, ...args) => [...FRAMEXML_AREA_SPIRIT_HEALER_BINDINGS[name]({ areaSpiritHealer: model }, args)];
  return { world, clock, state, model, events, answer, call };
}

const names = (events) => events.map(([event]) => event);

test("a ghost near a friendly spirit guide asks once; the answer fires IN_RANGE and the clock counts whole seconds", () => {
  const { world, clock, model, events, answer, call } = fixture();
  assert.deepEqual(world.sent, [["query", GUIDE]], "attach scans at once: the guide in range is asked (0x523eb0)");
  model.tick();
  model.tick();
  assert.equal(world.sent.length, 1, "the same guide is not asked again");
  assert.deepEqual(call("GetAreaSpiritHealerTime"), [0], "no clock before the answer (0x516b90)");
  assert.deepEqual(events, []);

  answer(GUIDE, 25_000);
  model.tick();
  assert.deepEqual(names(events), ["AREA_SPIRIT_HEALER_IN_RANGE"], "0x524b10: the current guide's time");
  assert.deepEqual(call("GetAreaSpiritHealerTime"), [25]);
  clock.now += 1_500;
  assert.deepEqual(call("GetAreaSpiritHealerTime"), [23], "integer division of the remaining milliseconds");
  model.tick();
  assert.equal(events.length, 1, "one answer, one event");
  clock.now += 30_000;
  assert.deepEqual(call("GetAreaSpiritHealerTime"), [0], "never negative");

  answer(GUIDE, 0);
  model.tick();
  assert.equal(events.length, 1, "a zero time is no answer (0 < ms)");
  answer(GUIDE, 12_000);
  model.tick();
  assert.deepEqual(names(events), ["AREA_SPIRIT_HEALER_IN_RANGE", "AREA_SPIRIT_HEALER_IN_RANGE"],
    "every later answer for the same guide fires again (the gossip path answers too)");
  assert.deepEqual(call("GetAreaSpiritHealerTime"), [12]);
});

test("0x524b10 compares the time as a signed int: 2^31 ms and more is no answer (L3-review)", () => {
  const { model, events, answer, call } = fixture();
  answer(GUIDE, 0x80000000);
  model.tick();
  answer(GUIDE, 0xffffffff);
  model.tick();
  assert.deepEqual(events, []);
  assert.deepEqual(call("GetAreaSpiritHealerTime"), [0]);
  answer(GUIDE, 0x7fffffff);
  model.tick();
  assert.deepEqual(names(events), ["AREA_SPIRIT_HEALER_IN_RANGE"], "the largest positive int still counts");
});

test("an answer for another guide is not the current one's; an old answer of the next guide is not new", () => {
  const { world, state, model, events, answer } = fixture();
  answer(OTHER, 20_000);
  model.tick();
  assert.deepEqual(events, [], "0x524b10 compares the guid with the guide in range");
  state.distances = new Map([[OTHER, 5]]);
  model.tick();
  assert.deepEqual(world.sent, [["query", GUIDE], ["query", OTHER]], "the guide went away, the next one is asked");
  assert.deepEqual(events, [], "the answer that arrived before it was asked does not count");
  answer(OTHER, 18_000);
  model.tick();
  assert.deepEqual(names(events), ["AREA_SPIRIT_HEALER_IN_RANGE"]);
});

test("AcceptAreaSpiritHeal queues the guide in range, and nothing without one", () => {
  const { world, state, events, call } = fixture();
  assert.deepEqual(call("AcceptAreaSpiritHeal", "ignored"), []);
  assert.deepEqual(world.sent, [["query", GUIDE], ["queue", GUIDE]], "0x524b60: QUEUE with the healer's guid");
  state.distances = new Map();
  call("AcceptAreaSpiritHeal");
  assert.deepEqual(world.sent, [["query", GUIDE], ["queue", GUIDE]],
    "0x524b60 validates first: the guide is gone, nothing is sent");
  assert.deepEqual(events, [], "dropping a guide without a running clock says nothing");
});

test("CancelAreaSpiritHeal fires OUT_OF_RANGE and cancels aura 2584, keeping the guide and its clock", () => {
  const { world, events, answer, model, call } = fixture();
  answer(GUIDE, 25_000);
  model.tick();
  assert.equal(FRAMEXML_WAITING_TO_RESURRECT_SPELL, 2584);
  call("CancelAreaSpiritHeal");
  assert.deepEqual(names(events), ["AREA_SPIRIT_HEALER_IN_RANGE", "AREA_SPIRIT_HEALER_OUT_OF_RANGE"]);
  assert.deepEqual(world.sent.at(-1), ["cancelAura", 2584], "CMSG_CANCEL_AURA of Waiting to Resurrect");
  assert.deepEqual(call("GetAreaSpiritHealerTime"), [25], "0x51f710 leaves the clock running");
  model.tick();
  assert.equal(world.sent.filter(([kind]) => kind === "query").length, 1, "and the guide in place: no new query");
});

test("22 yards keep the guide, 20 take one; leaving or resurrecting drops it with OUT_OF_RANGE only under a clock", () => {
  const { world, state, model, events, answer } = fixture();
  answer(GUIDE, 25_000);
  model.tick();
  state.distances = new Map([[GUIDE, 21.9]]);
  model.tick();
  assert.equal(events.length, 1, "within 22 yards the guide stays (0xa02d1c, 484)");
  state.distances = new Map([[GUIDE, 22.1]]);
  model.tick();
  assert.deepEqual(names(events), ["AREA_SPIRIT_HEALER_IN_RANGE", "AREA_SPIRIT_HEALER_OUT_OF_RANGE"]);
  assert.deepEqual(world.sent.at(-1), ["cancelAura", 2584], "0x523eb0 → 0x51f710 when a clock was running");
  state.distances = new Map([[GUIDE, 20.5]]);
  model.tick();
  assert.equal(world.sent.filter(([kind]) => kind === "query").length, 1, "beyond 20 yards no guide is taken (0x9e898c, 400)");
  state.distances = new Map([[GUIDE, 19.5]]);
  model.tick();
  assert.equal(world.sent.filter(([kind]) => kind === "query").length, 2, "within 20 yards it is asked again");
  model.tick();
  assert.equal(events.length, 2, "the old answer of the same guide is not new");

  state.ghost = false;
  model.tick();
  assert.equal(events.length, 2, "no clock ran for the second query: resurrection drops it quietly");
  const sent = world.sent.length;
  model.tick();
  assert.equal(world.sent.length, sent, "a living player never scans");
});

test("resurrection under a running clock cancels the aura and hides the dialog (PLAYER_UNGHOST, 0x6df710)", () => {
  const { world, state, model, events, answer } = fixture();
  answer(GUIDE, 25_000);
  model.tick();
  state.ghost = false;
  model.tick();
  assert.deepEqual(names(events), ["AREA_SPIRIT_HEALER_IN_RANGE", "AREA_SPIRIT_HEALER_OUT_OF_RANGE"]);
  assert.deepEqual(world.sent.at(-1), ["cancelAura", 2584]);
});

test("nothing happens while stock does not own the popups; losing them forgets without a packet", () => {
  const { world, state, model, events, answer, call } = fixture();
  answer(GUIDE, 25_000);
  model.tick();
  state.owned = false;
  model.tick();
  assert.deepEqual(names(events), ["AREA_SPIRIT_HEALER_IN_RANGE"], "no event on giving up ownership");
  assert.equal(world.sent.some(([kind]) => kind === "cancelAura"), false, "and no packet");
  assert.deepEqual(call("GetAreaSpiritHealerTime"), [0]);
  call("AcceptAreaSpiritHeal");
  call("CancelAreaSpiritHeal");
  assert.equal(world.sent.length, 1, "commands are inert without ownership");
  state.owned = true;
  model.tick();
  assert.deepEqual(world.sent.at(-1), ["query", GUIDE], "ownership regained: the guide in range is asked anew");
  const sentBefore = world.sent.length; // L3-review: a detached model must not scan either
  model.detach();
  answer(GUIDE, 9_000);
  model.tick();
  assert.equal(events.length, 1, "a detached model fires nothing");
  assert.equal(world.sent.length, sentBefore, "and sends nothing (L3-review)");
});

test("the seams bind the three names; without a model the time is 0 and the commands are inert", () => {
  for (const name of ["GetAreaSpiritHealerTime", "AcceptAreaSpiritHeal", "CancelAreaSpiritHeal"]) {
    assert.equal(FRAMEXML_SEAM_BINDINGS[name], FRAMEXML_AREA_SPIRIT_HEALER_BINDINGS[name], `${name} is in the seam table`);
  }
  const seam = new CannedWorldSeam();
  assert.deepEqual([...FRAMEXML_SEAM_BINDINGS.GetAreaSpiritHealerTime(seam, [])], [0]);
  assert.deepEqual([...FRAMEXML_SEAM_BINDINGS.AcceptAreaSpiritHeal(seam, [])], []);
  assert.deepEqual([...FRAMEXML_SEAM_BINDINGS.CancelAreaSpiritHeal(seam, [])], []);
});

function unitObject(guid, { x = 0, y = 0, z = 0, npcFlags = 0, unitFlags = 0, playerFlags, typeId = 3, pvpBytes } = {}) {
  const fields = new Map([[UPDATE_FIELDS.UNIT_NPC_FLAGS.offset, npcFlags], [UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset, unitFlags]]);
  if (playerFlags !== undefined) fields.set(UPDATE_FIELDS.PLAYER_FLAGS.offset, playerFlags);
  if (pvpBytes !== undefined) fields.set(UPDATE_FIELDS.UNIT_FIELD_BYTES_2.offset, pvpBytes << 8); // L3-review: byte 1
  return { guid, typeId, position: { x, y, z, orientation: 0 }, fields };
}

test("live: a friendly unit with the spirit guide flag 0x8000 within the limit; the ghost flag is PLAYER_FLAGS 0x10", () => {
  const self = unitObject(1n, { typeId: 4, playerFlags: 0x10, unitFlags: 0x8 });
  const hostile = 0x10n;
  const objects = new Map([
    [1n, self],
    [2n, unitObject(2n, { x: 5, npcFlags: 0x4000 })], // a spirit healer, not a guide
    [hostile, unitObject(hostile, { x: 7, npcFlags: 0x8000 })],
    [5n, unitObject(5n, { x: 12, y: 16, npcFlags: 0x8001 })], // exactly 20 yards
    [6n, unitObject(6n, { x: 30, npcFlags: 0x8000 })],
  ]);
  const world = { ...fakeWorld(), state: { selfGuid: 1n, objects } };
  const context = frameXmlAreaSpiritHealerLiveContext({
    world: () => world,
    self: () => objects.get(1n),
    reaction: (_self, other) => (other.guid === hostile ? REACTION_HOSTILE : REACTION_FRIENDLY),
    owned: () => true,
    monotonic: () => 7,
  });
  assert.equal(context.ghost(), true);
  assert.equal(context.now(), 7);
  assert.equal(context.findGuide(400), 5n, "the friendly guide at exactly 20 yards; not 2, 3 or the hostile one");
  assert.equal(context.findGuide(399), undefined);
  assert.equal(context.distanceSquared(6n), 900);
  assert.equal(context.distanceSquared(99n), undefined, "a unit out of view has no distance");
  self.fields.set(UPDATE_FIELDS.PLAYER_FLAGS.offset, 0);
  assert.equal(context.ghost(), false);
  const neutral = frameXmlAreaSpiritHealerLiveContext({
    world: () => world, self: () => objects.get(1n), owned: () => true, monotonic: () => 0,
  });
  assert.equal(neutral.findGuide(10_000), undefined, "without a reaction resolver no guide is friendly");
});

// L3-review: 0x523f80 calls 0x7293d0 with ECX = the guide and the player as its argument (the
// listing at 0x523fbd-0x523fc5): the guide's "may assist" test of the player, TrinityCore's
// Unit::IsValidAssistTarget(guide, player). The flags it reads are the PLAYER's: not selectable
// (0x2000000), immune to NPCs (0x200; immune to PCs 0x100 only for a player-controlled guide, 0x8),
// and for a player-controlled target the FFA (0x04) and sanctuary (0x08) bits of UNIT_FIELD_BYTES_2
// byte 1 against the guide's.
test("live: 0x7293d0 reads the player's flags, not the guide's", () => {
  const guide = (fields = {}) => unitObject(2n, { x: 5, npcFlags: 0x8000, ...fields });
  const find = (selfFields, guideFields) => {
    const self = unitObject(1n, { typeId: 4, playerFlags: 0x10, unitFlags: 0x8, ...selfFields });
    const objects = new Map([[1n, self], [2n, guide(guideFields)]]);
    return frameXmlAreaSpiritHealerLiveContext({
      world: () => ({ ...fakeWorld(), state: { selfGuid: 1n, objects } }), self: () => self,
      reaction: () => REACTION_FRIENDLY, owned: () => true, monotonic: () => 0,
    }).findGuide(400);
  };
  assert.equal(find({}, { unitFlags: 0x2000000 }), 2n, "a guide flagged not selectable itself is still taken");
  assert.equal(find({ unitFlags: 0x8 | 0x2000000 }, {}), undefined, "a player flagged not selectable takes none");
  assert.equal(find({ unitFlags: 0x8 | 0x200 }, {}), undefined, "immune to NPCs, for a guide that is an NPC");
  assert.equal(find({ unitFlags: 0x8 | 0x100 }, {}), 2n, "immune to PCs does not matter for an NPC guide");
  assert.equal(find({ unitFlags: 0x8 | 0x100 }, { unitFlags: 0x8 }), undefined, "but does for a player-controlled one");
  assert.equal(find({ pvpBytes: 0x04 }, {}), undefined, "a player in free-for-all PvP, the guide not");
  assert.equal(find({ pvpBytes: 0x04 }, { pvpBytes: 0x04 }), 2n);
  assert.equal(find({ pvpBytes: 0x01 }, { pvpBytes: 0x08 }), undefined, "a sanctuary guide, a PvP-flagged player outside it");
  assert.equal(find({ pvpBytes: 0x00 }, { pvpBytes: 0x08 }), 2n, "not PvP-flagged: the sanctuary does not matter");
  assert.equal(find({ pvpBytes: 0x09 }, { pvpBytes: 0x08 }), 2n, "inside the sanctuary too");
  assert.equal(find({ unitFlags: 0, pvpBytes: 0x04 }, {}), 2n, "a target that is not player-controlled skips the PvP checks");
});

// ---- WorldClient: the two packets and the answer, through the live context -------------------
const { WorldClient } = await import("../dist/code/world/WorldClient.js");
const { PacketWriter } = await import("../dist/code/protocol/PacketWriter.js");
const { OPCODES } = await import("../dist/code/generated/opcodes.js");

function fakeConnection() {
  const queue = [];
  let wake;
  return {
    sent: [],
    push(opcode, payload = new Uint8Array()) {
      queue.push({ opcode, payload });
      if (wake) { const resume = wake; wake = undefined; resume(queue.shift()); }
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

test("WorldClient: QUERY and QUEUE are the bare u64 guid; the answer replaces the timer entry; the live path end to end", async () => {
  const SELF = 0x77n;
  const connection = fakeConnection();
  connection.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD, new PacketWriter().u32(489).f32(1).f32(2).f32(3).f32(0).toUint8Array());
  const client = new WorldClient(connection);
  await client.loginCharacter(SELF);
  await settle();
  client.state.selfGuid = SELF;
  client.state.move(SELF, { flags: 0, position: { x: 100, y: 100, z: 0, orientation: 0 } });
  const self = client.state.objects.get(SELF);
  self.typeId = 4;
  self.fields.set(UPDATE_FIELDS.PLAYER_FLAGS.offset, 0x10);
  client.state.move(GUIDE, { flags: 0, position: { x: 110, y: 100, z: 0, orientation: 0 } });
  const guide = client.state.objects.get(GUIDE);
  guide.typeId = 3;
  guide.fields.set(UPDATE_FIELDS.UNIT_NPC_FLAGS.offset, 0x8000);
  connection.sent.length = 0;
  const sent = (opcode) => connection.sent.filter((packet) => packet.opcode === opcode).map((packet) => [...packet.payload]);
  const guidBytes = [0x01, 0x01, 0x00, 0xbc, 0x33, 0x00, 0x30, 0xf1];

  const clock = { now: 1_000 };
  const model = new FrameXmlAreaSpiritHealerModel(frameXmlAreaSpiritHealerLiveContext({
    world: () => client, self: () => client.state.objects.get(SELF),
    reaction: () => REACTION_FRIENDLY, owned: () => true, monotonic: () => clock.now,
  }));
  const events = [];
  model.attach({ fire(event) { events.push(event); return 1; }, now: () => 0 });
  assert.deepEqual(sent(OPCODES.CMSG_AREA_SPIRIT_HEALER_QUERY), [guidBytes], "0x2E2, the guide's u64");
  assert.equal(OPCODES.CMSG_AREA_SPIRIT_HEALER_QUERY, 0x2e2);

  connection.push(OPCODES.SMSG_AREA_SPIRIT_HEALER_TIME, new PacketWriter().u64(GUIDE).u32(25_000).toUint8Array());
  await settle();
  const first = client.spiritHealerTimers.get(GUIDE);
  assert.equal(first?.milliseconds, 25_000);
  clock.now = first.receivedAt;
  model.tick();
  assert.deepEqual(events, ["AREA_SPIRIT_HEALER_IN_RANGE"]);
  assert.deepEqual([...FRAMEXML_AREA_SPIRIT_HEALER_BINDINGS.GetAreaSpiritHealerTime({ areaSpiritHealer: model }, [])], [25]);
  FRAMEXML_AREA_SPIRIT_HEALER_BINDINGS.AcceptAreaSpiritHeal({ areaSpiritHealer: model }, []);
  assert.deepEqual(sent(OPCODES.CMSG_AREA_SPIRIT_HEALER_QUEUE), [guidBytes], "0x2E3, the guide's u64");
  assert.equal(OPCODES.CMSG_AREA_SPIRIT_HEALER_QUEUE, 0x2e3);
  FRAMEXML_AREA_SPIRIT_HEALER_BINDINGS.CancelAreaSpiritHeal({ areaSpiritHealer: model }, []);
  assert.deepEqual(sent(OPCODES.CMSG_CANCEL_AURA), [[0x18, 0x0a, 0x00, 0x00]], "CMSG_CANCEL_AURA 2584");
  assert.deepEqual(events, ["AREA_SPIRIT_HEALER_IN_RANGE", "AREA_SPIRIT_HEALER_OUT_OF_RANGE"]);

  connection.push(OPCODES.SMSG_AREA_SPIRIT_HEALER_TIME, new PacketWriter().u64(GUIDE).u32(25_000).toUint8Array());
  await settle();
  assert.notEqual(client.spiritHealerTimers.get(GUIDE), first, "a new answer is a new entry, even with the same numbers");
  model.tick();
  assert.equal(events.filter((event) => event === "AREA_SPIRIT_HEALER_IN_RANGE").length, 2);

  client.queryAreaSpiritHealer(0n);
  client.queueAreaSpiritHealer(0n);
  assert.equal(sent(OPCODES.CMSG_AREA_SPIRIT_HEALER_QUERY).length + sent(OPCODES.CMSG_AREA_SPIRIT_HEALER_QUEUE).length, 2,
    "an empty guid is never sent");
  assert.equal(sent(OPCODES.CMSG_AREA_SPIRIT_HEALER_QUERY).length, 1, "nothing asked twice for the same guide");
});
