import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { deflateSync } from "node:zlib";
import test from "node:test";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { PacketWriter } from "../dist/code/protocol/index.js";
import { ByteQueue } from "../dist/code/transport/ByteQueue.js";
import {
  buildCharacterGuid,
  buildCreateCharacter,
  parseCharacterList,
  parseLoginVerifyWorld,
} from "../dist/code/world/CharacterProtocol.js";
import { WorldConnection } from "../dist/code/world/WorldConnection.js";
import { WorldCrypt } from "../dist/code/world/WorldCrypt.js";
import { decompressObjectUpdate, isWorldObjectDead, WorldState } from "../dist/code/world/WorldState.js";
import { WorldStore } from "../dist/code/world/WorldStore.js";
import {
  MOVEMENT_FLAGS, buildMovementPacket, parseMovementPacket, writeMovementInfoBody,
} from "../dist/code/world/MovementProtocol.js";
import { SPLINE_MOVE_STATES } from "../dist/code/world/SplineStateProtocol.js";
import { isUnitMoving, MOVEMENT_FLAG_TRANSLATING, poseAnimation } from "../dist/code/browser/AnimatedModel.js";
import { ANIMATION_IDS } from "../dist/code/generated/animations.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import {
  SHEATH_MELEE,
  buildCombatGuid,
  buildSetSheathed,
  parseAttackStart,
  parseAttackStop,
  parseHealthUpdate,
} from "../dist/code/world/CombatProtocol.js";
import { parseMonsterMove } from "../dist/code/world/MonsterMoveProtocol.js";
import {
  TARGET_FLAG_DEST_LOCATION,
  TARGET_FLAG_NONE,
  TARGET_FLAG_UNIT,
  buildCastSpell,
  parseCastFailure,
  parseClearCooldown,
  parseCooldownEvent,
  parseInitialSpells,
  parseSpellCastHeader,
  parseSpellCooldown,
} from "../dist/code/world/SpellProtocol.js";
import { buildUseItem } from "../dist/code/world/ItemProtocol.js";
import { PacketReader } from "../dist/code/protocol/PacketReader.js";
import { AURA_FLAGS, applyAuraUpdate, parseAuraUpdate } from "../dist/code/world/AuraProtocol.js";
import {
  buildGossipHello,
  buildGossipSelect,
  buildNpcTextQuery,
  buildQuestAccept,
  buildQuestAction,
  buildQuestChooseReward,
  buildQuestGiverHello,
  buildQuestQuery,
  parseGossipMessage,
  parseNpcText,
  parseQuestDetails,
  parseQuestList,
  parseQuestOfferReward,
  parseQuestRequestItems,
} from "../dist/code/world/NpcProtocol.js";

const SERVER_ENCRYPTION_KEY = Uint8Array.of(
  0xcc, 0x98, 0xae, 0x04, 0xe8, 0x97, 0xea, 0xca, 0x12, 0xdd, 0xc0, 0x93, 0x42, 0x91, 0x53, 0x57,
);
const SERVER_DECRYPTION_KEY = Uint8Array.of(
  0xc2, 0xb3, 0x72, 0x3c, 0xc6, 0xae, 0xd9, 0xb5, 0x34, 0x3c, 0x53, 0xee, 0x2f, 0x43, 0x67, 0xce,
);

function rc4(key, input) {
  const state = Uint8Array.from({ length: 256 }, (_, index) => index);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + state[i] + key[i % key.length]) & 0xff;
    [state[i], state[j]] = [state[j], state[i]];
  }

  let i = 0;
  j = 0;
  const process = (bytes) => Uint8Array.from(bytes, (byte) => {
    i = (i + 1) & 0xff;
    j = (j + state[i]) & 0xff;
    [state[i], state[j]] = [state[j], state[i]];
    return byte ^ state[(state[i] + state[j]) & 0xff];
  });
  process(new Uint8Array(1024));
  return process(input);
}

function hmac(key, data) {
  return new Uint8Array(createHmac("sha1", key).update(data).digest());
}

class MemoryStream {
  queue = new ByteQueue();
  sent = [];
  closed = false;

  constructor(input = new Uint8Array()) {
    this.queue.push(input);
  }

  send(bytes) {
    this.sent.push(bytes);
  }

  readExactly(length) {
    return Promise.resolve(this.queue.read(length));
  }

  close() {
    this.closed = true;
  }
}

function writeUpdateFields(writer, entries) {
  const sorted = entries.toSorted(([left], [right]) => left - right);
  const blockCount = Math.floor(sorted.at(-1)[0] / 32) + 1;
  const masks = Array.from({ length: blockCount }, () => 0);
  for (const [index] of sorted) masks[Math.floor(index / 32)] |= 1 << (index % 32);
  writer.u8(blockCount);
  for (const mask of masks) writer.u32(mask);
  for (const [, value] of sorted) writer.u32(value);
}

test("world RC4 header keys match TrinityCore HMAC and drop1024", async () => {
  const sessionKey = Uint8Array.from({ length: 40 }, (_, index) => index + 1);
  const crypt = await WorldCrypt.create(sessionKey);
  const clientHeader = Uint8Array.of(0, 4, 0x37, 0, 0, 0);
  const serverHeader = Uint8Array.of(0, 3, 0xee, 1);

  assert.deepEqual(
    crypt.encryptClientHeader(clientHeader),
    rc4(hmac(SERVER_DECRYPTION_KEY, sessionKey), clientHeader),
  );
  const encryptedServerHeader = rc4(hmac(SERVER_ENCRYPTION_KEY, sessionKey), serverHeader);
  assert.deepEqual(crypt.decryptServerHeader(encryptedServerHeader), serverHeader);
});

test("world connection reads server framing and writes client framing", async () => {
  const serverPacket = Uint8Array.of(0, 4, 0xec, 1, 0xaa, 0xbb);
  const stream = new MemoryStream(serverPacket);
  const connection = new WorldConnection(stream);

  assert.deepEqual(await connection.read(), { opcode: 0x1ec, payload: Uint8Array.of(0xaa, 0xbb) });
  connection.send(0x1ed, Uint8Array.of(1, 2));
  assert.deepEqual([...stream.sent[0]], [0, 6, 0xed, 1, 0, 0, 1, 2]);
  connection.close();
  assert.equal(stream.closed, true);
});

test("character list parser consumes all 23 equipment and bag slots", () => {
  const writer = new PacketWriter()
    .u8(1)
    .u64(0x1234n)
    .cString("Webhero")
    .u8(1)
    .u8(1)
    .u8(0)
    .u8(2)
    .u8(3)
    .u8(4)
    .u8(5)
    .u8(6)
    .u8(80)
    .u32(12)
    .u32(0)
    .f32(1)
    .f32(2)
    .f32(3)
    .u32(0)
    .u32(0)
    .u32(0)
    .u8(1)
    .u32(0)
    .u32(0)
    .u32(0);
  for (let slot = 0; slot < 23; slot++) writer.u32(slot + 100).u8(slot).u32(slot + 200);

  const [character] = parseCharacterList(writer.toUint8Array());
  assert.equal(character.name, "Webhero");
  assert.equal(character.guid, 0x1234n);
  assert.equal(character.equipment.length, 23);
  assert.deepEqual(character.equipment[22], { displayId: 122, inventoryType: 22, enchantVisual: 222 });
});

test("character requests and login location match TrinityCore layouts", () => {
  assert.deepEqual([...buildCharacterGuid(0x0102030405060708n)], [8, 7, 6, 5, 4, 3, 2, 1]);
  assert.deepEqual(
    [...buildCreateCharacter({ name: "Hero", race: 1, classId: 2, gender: 0 })],
    [72, 101, 114, 111, 0, 1, 2, 0, 0, 0, 0, 0, 0, 0],
  );

  const payload = new PacketWriter().u32(571).f32(1).f32(2).f32(3).f32(4).toUint8Array();
  assert.deepEqual(parseLoginVerifyWorld(payload), { map: 571, x: 1, y: 2, z: 3, orientation: 4 });
});

test("world state applies create, values and out-of-range object updates", () => {
  const guid = 0xf130000000001234n;
  const create = new PacketWriter()
    .u32(1)
    .u8(2)
    .packedGuid(guid)
    .u8(3)
    .u16(0x31)
    .u32(0)
    .u16(0)
    .u32(123)
    .f32(1)
    .f32(2)
    .f32(3)
    .f32(4)
    .u32(0);
  for (let speed = 0; speed < 9; speed++) create.f32(speed + 1);
  create.u32(0x0b);
  writeUpdateFields(create, [
    [UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, 42],
    [UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 500],
    [UPDATE_FIELDS.UNIT_FIELD_MAXHEALTH.offset, 600],
    [UPDATE_FIELDS.UNIT_FIELD_LEVEL.offset, 12],
  ]);

  const state = new WorldState();
  state.applyUpdate(create.toUint8Array());
  const object = state.objects.get(guid);
  assert.equal(state.selfGuid, guid);
  assert.equal(object.typeId, 3);
  assert.deepEqual(object.position, { x: 1, y: 2, z: 3, orientation: 4 });
  assert.equal(object.fields.get(UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset), 500);

  const values = new PacketWriter().u32(1).u8(0).packedGuid(guid);
  writeUpdateFields(values, [[UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 450]]);
  state.applyUpdate(values.toUint8Array());
  assert.equal(object.fields.get(UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset), 450);

  const retired = state.applyUpdate(new PacketWriter().u32(1).u8(4).u32(1).packedGuid(guid).toUint8Array());
  assert.deepEqual(retired, [guid]);
  assert.equal(state.objects.has(guid), false);

  // Object blocks cannot refresh packet-owned aura/cast state. A live replacement survives,
  // but the old incarnation's state is still retired before its separate initial aura packet.
  const replacement = create.toUint8Array();
  const removeAndRecreate = new PacketWriter()
    .u32(2).u8(4).u32(1).packedGuid(guid).bytes(replacement.subarray(4)).toUint8Array();
  const recreated = new WorldState();
  recreated.applyUpdate(replacement);
  assert.deepEqual(recreated.applyUpdate(removeAndRecreate), [guid]);
  assert.equal(recreated.objects.has(guid), true);
});

test("compressed object updates use the TrinityCore zlib envelope", async () => {
  const update = new PacketWriter().u32(0).toUint8Array();
  const compressed = new Uint8Array(deflateSync(update));
  const payload = new PacketWriter().u32(update.byteLength).bytes(compressed).toUint8Array();
  assert.deepEqual(await decompressObjectUpdate(payload), update);
});

test("movement packet matches the packed GUID and MovementInfo layout", () => {
  const position = { x: 1.5, y: -2.5, z: 3.5, orientation: 0.75 };
  const payload = buildMovementPacket(0x0102n, 0x11, position, 1234);
  // The wire format is unchanged; the reader now keeps the fall time it always read and threw
  // away, because an acknowledgement has to echo the mover's whole state back.
  assert.equal(payload.byteLength, 33);
  assert.deepEqual(parseMovementPacket(payload), {
    guid: 0x0102n,
    flags: 0x11,
    flags2: 0,
    time: 1234,
    position,
    fallTime: 0,
  });
});

test("aura updates decode TrinityCore slots, durations and removals", () => {
  const guid = 0x010203n;
  const payload = new PacketWriter()
    .packedGuid(guid)
    .u8(3).u32(123).u8(AURA_FLAGS.positive | AURA_FLAGS.duration).u8(80).u8(2).packedGuid(0x99n).u32(120_000).u32(90_000)
    .u8(4).u32(456).u8(AURA_FLAGS.negative | AURA_FLAGS.caster).u8(70).u8(1)
    .u8(5).u32(0)
    .toUint8Array();
  const update = parseAuraUpdate(payload, true);
  assert.equal(update.guid, guid);
  assert.equal(update.slots[0].aura.casterGuid, 0x99n);
  assert.equal(update.slots[0].aura.duration, 90_000);
  assert.equal(update.slots[1].aura.casterGuid, undefined);

  const active = applyAuraUpdate(undefined, update, 1_000);
  assert.equal(active.get(3).expiresAt, 91_000);
  assert.equal(active.get(4).spellId, 456);
  const removed = applyAuraUpdate(active, parseAuraUpdate(new PacketWriter().packedGuid(guid).u8(3).u32(0).toUint8Array(), false), 2_000);
  assert.equal(removed.has(3), false);
  assert.equal(removed.has(4), true);
});

test("gossip messages preserve options, quests and localized NPC text", () => {
  const guid = 0xf130000000001234n;
  const message = new PacketWriter()
    .u64(guid).u32(7).u32(55).u32(1)
    .u32(3).u8(1).u8(0).u32(25).cString("Покажи товары").cString("Купить?")
    .u32(1).u32(42).u32(2).i32(12).u32(0x80).u8(0).cString("Первое поручение")
    .toUint8Array();
  assert.deepEqual(parseGossipMessage(message), {
    guid,
    menuId: 7,
    textId: 55,
    options: [{ id: 3, icon: 1, coded: false, money: 25, text: "Покажи товары", boxText: "Купить?" }],
    quests: [{ id: 42, icon: 2, level: 12, flags: 0x80, repeatable: false, title: "Первое поручение" }],
  });
  assert.deepEqual(buildGossipHello(guid), new PacketWriter().u64(guid).toUint8Array());
  assert.deepEqual(buildGossipSelect(guid, 7, 3), new PacketWriter().u64(guid).u32(7).u32(3).toUint8Array());
  assert.deepEqual(buildNpcTextQuery(55, guid), new PacketWriter().u32(55).u64(guid).toUint8Array());

  const text = new PacketWriter().u32(55);
  for (let index = 0; index < 8; index++) {
    text.f32(index === 0 ? 1 : 0).cString(index === 0 ? "Привет, $N" : "").cString("").u32(0);
    for (let emote = 0; emote < 3; emote++) text.u32(0).u32(0);
  }
  assert.equal(parseNpcText(text.toUint8Array()).options[0].male, "Привет, $N");
});

test("quest interaction packets decode details, requirements and rewards", () => {
  const guid = 0xf130000000001234n;
  const list = new PacketWriter().u64(guid).cString("Чем могу помочь?").u32(0).u32(0).u8(1)
    .u32(42).u32(8).i32(12).u32(0).u8(0).cString("Первое поручение").toUint8Array();
  assert.equal(parseQuestList(list).quests[0].title, "Первое поручение");

  const details = new PacketWriter().u64(guid).u64(0n).u32(42).cString("Первое поручение").cString("Подробности").cString("Цели")
    .u8(1).u32(0).u32(1).u8(0);
  writeQuestRewards(details, false);
  details.i32(0);
  assert.deepEqual(parseQuestDetails(details.toUint8Array()).rewards.choices, [{ id: 25, count: 1, displayId: 1542 }]);

  const request = new PacketWriter().u64(guid).u32(42).cString("Первое поручение").cString("Принеси меч")
    .u32(0).u32(0).u32(0).u32(0).u32(1).u32(0).u32(1).u32(25).u32(1).u32(1542).u32(3).u32(4).u32(8).u32(16);
  const required = parseQuestRequestItems(request.toUint8Array());
  assert.equal(required.canComplete, true);
  assert.deepEqual(required.items, [{ id: 25, count: 1, displayId: 1542 }]);

  const offer = new PacketWriter().u64(guid).u32(42).cString("Первое поручение").cString("Спасибо").u8(1).u32(0).u32(1).u32(0);
  writeQuestRewards(offer, true);
  assert.equal(parseQuestOfferReward(offer.toUint8Array()).rewards.money, 100);

  // Quest::BuildQuestRewards keeps a signed RewOrReqMoney, serialized as a uint32 word.
  // A negative value is the turn-in cost, not a multi-billion-copper reward.
  const paidOffer = new PacketWriter().u64(guid).u32(43).cString("Платное поручение").cString("Спасибо")
    .u8(1).u32(0).u32(1).u32(0);
  writeQuestRewards(paidOffer, true, -125);
  const paidRewards = parseQuestOfferReward(paidOffer.toUint8Array()).rewards;
  assert.deepEqual(
    [paidRewards.money, paidRewards.requiredMoney],
    [0, 125],
  );

  assert.deepEqual(buildQuestGiverHello(guid), new PacketWriter().u64(guid).toUint8Array());
  assert.deepEqual(buildQuestQuery(guid, 42), new PacketWriter().u64(guid).u32(42).u8(0).toUint8Array());
  assert.deepEqual(buildQuestAccept(guid, 42), new PacketWriter().u64(guid).u32(42).u32(0).toUint8Array());
  assert.deepEqual(buildQuestAction(guid, 42), new PacketWriter().u64(guid).u32(42).toUint8Array());
  assert.deepEqual(buildQuestChooseReward(guid, 42, 2), new PacketWriter().u64(guid).u32(42).u32(2).toUint8Array());
});

function writeQuestRewards(writer, offer, money = 100) {
  writer.u32(1).u32(25).u32(1).u32(1542).u32(1).u32(117).u32(2).u32(2473)
    .i32(money).u32(3).u32(4).f32(0);
  if (offer) writer.u32(0);
  writer.u32(0).i32(0).u32(0).u32(0).u32(0).u32(0);
  for (let index = 0; index < 15; index++) writer.u32(0);
  return writer;
}

test("world client activates the player mover before movement", async () => {
  const guid = 0x1234n;
  const login = new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(4).toUint8Array();
  const create = new PacketWriter()
    .u32(1)
    .u8(2)
    .packedGuid(guid)
    .u8(4)
    .u16(0x41)
    .f32(1)
    .f32(2)
    .f32(3)
    .f32(4)
    .u8(0)
    .toUint8Array();
  const connection = {
    sent: [],
    packets: [
      { opcode: OPCODES.SMSG_LOGIN_VERIFY_WORLD, payload: login },
      { opcode: OPCODES.SMSG_UPDATE_OBJECT, payload: create },
    ],
    send(opcode, payload = new Uint8Array()) {
      this.sent.push({ opcode, payload });
    },
    read() {
      return this.packets.length ? Promise.resolve(this.packets.shift()) : new Promise(() => {});
    },
    close() {},
  };
  const client = new WorldClient(connection);
  await client.loginCharacter(guid);
  await Promise.resolve();
  const activeMover = connection.sent.find(({ opcode }) => opcode === OPCODES.CMSG_SET_ACTIVE_MOVER);
  assert.deepEqual(activeMover?.payload, new PacketWriter().u64(guid).toUint8Array());
  assert.equal(client.movementReady, true);

  const victim = 0x5678n;
  client.state.move(victim, { flags: 0, position: { x: 2, y: 3, z: 4, orientation: 0 } });
  client.selectTarget(victim);
  client.startAttack();
  client.stopAttack();
  client.knownSpells = [{ id: 133, slot: 0 }];
  client.castSpell(133);
  client.startLocalCooldown(133, 1500);
  assert.deepEqual(connection.sent.find(({ opcode }) => opcode === OPCODES.CMSG_SET_SELECTION)?.payload, buildCombatGuid(victim));
  assert.deepEqual(connection.sent.find(({ opcode }) => opcode === OPCODES.CMSG_ATTACK_SWING)?.payload, buildCombatGuid(victim));
  assert.equal(connection.sent.some(({ opcode, payload }) => opcode === OPCODES.CMSG_ATTACK_STOP && payload.byteLength === 0), true);
  // The cast names no unit and the selection's own position: the server picks the target, and a
  // ground spell still lands on it rather than at the caster's feet.
  assert.deepEqual(
    connection.sent.find(({ opcode }) => opcode === OPCODES.CMSG_CAST_SPELL)?.payload,
    buildCastSpell(133, 1, { x: 2, y: 3, z: 4 }),
  );
  assert.equal(client.cooldownRemaining(133), 0, "a request is not a cooldown before the server accepts it");
  client.close();
});

test("mount auto-dispel precedes an ordinary spell without predicting server state", () => {
  const guid = 0x1234n;
  const connection = {
    sent: [],
    send(opcode, payload = new Uint8Array()) { this.sent.push({ opcode, payload }); },
    read() { return new Promise(() => {}); },
    close() {},
  };
  const client = new WorldClient(connection);
  client.state.selfGuid = guid;
  client.state.move(guid, { flags: 0, position: { x: 1, y: 2, z: 3, orientation: 0 } });
  const player = client.state.objects.get(guid);
  player.fields.set(UPDATE_FIELDS.UNIT_FIELD_MOUNTDISPLAYID.offset, 2404);
  client.knownSpells = [{ id: 133, slot: 0 }];

  client.castSpell(133);

  assert.deepEqual(
    connection.sent.map(({ opcode, payload }) => [opcode, payload.byteLength]),
    [
      [OPCODES.CMSG_CANCEL_MOUNT_AURA, 0],
      [OPCODES.CMSG_CAST_SPELL, 23],
    ],
    "the realm must see the dismount request before the cast",
  );
  assert.equal(
    player.fields.get(UPDATE_FIELDS.UNIT_FIELD_MOUNTDISPLAYID.offset),
    2404,
    "the field remains server-authoritative until the update arrives",
  );
  client.close();
});

function mountCastHarness({ flags = 0, mountDisplayId = 0, knownSpells = [{ id: 133, slot: 0 }], mountSpellIds = [], activeAuras = [] } = {}) {
  const guid = 0x1234n;
  const connection = {
    sent: [],
    send(opcode, payload = new Uint8Array()) { this.sent.push({ opcode, payload }); },
    read() { return new Promise(() => {}); },
    close() {},
  };
  const client = new WorldClient(connection);
  client.state.selfGuid = guid;
  client.state.move(guid, { flags: 0, position: { x: 1, y: 2, z: 3, orientation: 0 } });
  const player = client.state.objects.get(guid);
  player.fields.set(UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset, flags);
  player.fields.set(UPDATE_FIELDS.UNIT_FIELD_MOUNTDISPLAYID.offset, mountDisplayId);
  client.knownSpells = knownSpells;
  client.setMountSpellIds(mountSpellIds);
  if (activeAuras.length > 0) {
    client.auras.set(guid, new Map(activeAuras.map((spellId, slot) => [slot, {
      slot, spellId, flags: 0, casterLevel: 80, applications: 1,
    }])));
  }
  return { client, connection, player };
}

test("the spellbook Attack action toggles the melee swing protocol instead of casting spell 6603", () => {
  const { client, connection } = mountCastHarness({ knownSpells: [] });
  const victim = 0x5678n;
  client.state.move(victim, { flags: 0, position: { x: 5, y: 2, z: 3, orientation: 0 } });
  client.selectTarget(victim);
  connection.sent.length = 0;

  client.castSpell(6603);
  client.castSpell(6603);

  assert.deepEqual(connection.sent.map(({ opcode }) => opcode), [
    OPCODES.CMSG_SET_SHEATHED,
    OPCODES.CMSG_ATTACK_SWING,
    OPCODES.CMSG_ATTACK_STOP,
    OPCODES.CMSG_SET_SHEATHED,
  ]);
  assert.equal(connection.sent.some(({ opcode }) => opcode === OPCODES.CMSG_CAST_SPELL), false);
  client.close();
});

test("Auto Shot is one unit-targeted repeat request; pressing it again cancels instead of recasting", () => {
  const { client, connection } = mountCastHarness({ knownSpells: [{ id: 75, slot: 0 }] });
  assert.equal(typeof client.setAutoRepeatSpellIds, "function");
  const victim = 0x5678n;
  client.state.move(victim, { flags: 0, position: { x: 20, y: 2, z: 3, orientation: 0 } });
  client.selectTarget(victim);
  client.setAutoRepeatSpellIds([75]);
  connection.sent.length = 0;

  client.castSpell(75);
  client.castSpell(75);

  assert.deepEqual(connection.sent.map(({ opcode }) => opcode), [
    OPCODES.CMSG_SET_SHEATHED,
    OPCODES.CMSG_CAST_SPELL,
    OPCODES.CMSG_CANCEL_AUTO_REPEAT_SPELL,
    OPCODES.CMSG_SET_SHEATHED,
  ]);
  const cast = connection.sent.find(({ opcode }) => opcode === OPCODES.CMSG_CAST_SPELL)?.payload;
  const expected = new PacketWriter().u8(1).u32(75).u8(0).u32(TARGET_FLAG_UNIT).packedGuid(victim).toUint8Array();
  assert.deepEqual(cast, expected, "the repeat guard in TrinityCore compares this explicit unit guid");
  assert.equal(client.autoRepeatSpellId, undefined);
  client.close();
});

test("melee and ranged auto-combat switch modes with explicit wire cancellation", () => {
  const { client, connection } = mountCastHarness({ knownSpells: [{ id: 75, slot: 0 }] });
  const victim = 0x5678n;
  client.state.move(victim, { flags: 0, position: { x: 5, y: 2, z: 3, orientation: 0 } });
  client.state.objects.get(victim).typeId = 3;
  client.state.setField(victim, UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 100);
  client.selectTarget(victim);
  client.setAutoRepeatSpellIds([75]);
  client.startAttack();
  connection.sent.length = 0;

  client.castSpell(75);
  assert.deepEqual(connection.sent.map(({ opcode }) => opcode), [
    OPCODES.CMSG_ATTACK_STOP,
    OPCODES.CMSG_SET_SHEATHED,
    OPCODES.CMSG_SET_SHEATHED,
    OPCODES.CMSG_CAST_SPELL,
  ]);
  assert.equal(client.attacking, false);
  assert.equal(client.autoRepeatSpellId, 75);

  connection.sent.length = 0;
  client.startAttack();
  assert.deepEqual(connection.sent.map(({ opcode }) => opcode), [
    OPCODES.CMSG_CANCEL_AUTO_REPEAT_SPELL,
    OPCODES.CMSG_SET_SHEATHED,
    OPCODES.CMSG_SET_SHEATHED,
    OPCODES.CMSG_ATTACK_SWING,
  ]);
  assert.equal(client.autoRepeatSpellId, undefined);
  assert.equal(client.attacking, true);
  client.close();
});

test("Auto Shot refuses a dead or stale selected target before sending a repeat request", () => {
  for (const stale of [false, true]) {
    const { client, connection } = mountCastHarness({ knownSpells: [{ id: 75, slot: 0 }] });
    const victim = 0x5678n;
    client.state.move(victim, { flags: 0, position: { x: 5, y: 2, z: 3, orientation: 0 } });
    client.state.objects.get(victim).typeId = 3;
    client.state.setField(victim, UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, stale ? 100 : 0);
    client.selectTarget(victim);
    if (stale) client.state.objects.delete(victim);
    client.setAutoRepeatSpellIds([75]);
    connection.sent.length = 0;

    client.castSpell(75);

    assert.deepEqual(connection.sent, [], stale ? "removed target" : "dead target");
    assert.equal(client.autoRepeatSpellId, undefined);
    client.close();
  }
});

test("UNIT_FLAG_MOUNT dismounts even when MOUNTDISPLAYID is zero", () => {
  const { client, connection, player } = mountCastHarness({ flags: 0x08000000 });
  client.castSpell(133);
  assert.deepEqual(connection.sent.map(({ opcode }) => opcode), [
    OPCODES.CMSG_CANCEL_MOUNT_AURA,
    OPCODES.CMSG_CAST_SPELL,
  ]);
  assert.equal(player.fields.get(UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset), 0x08000000,
    "the client waits for the server to clear the mounted bit");
  client.close();
});

test("reapplying the active mount toggles it off without allocating a cast", () => {
  const mountSpell = 23214;
  const { client, connection } = mountCastHarness({
    mountDisplayId: 2404,
    knownSpells: [{ id: mountSpell, slot: 0 }, { id: 133, slot: 1 }],
    mountSpellIds: [mountSpell],
    activeAuras: [mountSpell],
  });
  client.castSpell(mountSpell, 10_000);
  assert.deepEqual(connection.sent.map(({ opcode, payload }) => [opcode, payload.byteLength]), [
    [OPCODES.CMSG_CANCEL_MOUNT_AURA, 0],
  ]);
  assert.equal(client.auras.get(0x1234n)?.get(0)?.spellId, mountSpell,
    "the client does not predict the aura removal");
  // The toggle did not consume a cast count: the next spell starts at one after the server update
  // eventually clears the mounted fields (the test simulates only that authoritative field change).
  client.state.setField(0x1234n, UPDATE_FIELDS.UNIT_FIELD_MOUNTDISPLAYID.offset, 0);
  client.state.setField(0x1234n, UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset, 0);
  client.castSpell(133);
  assert.deepEqual(connection.sent.at(-1).payload, buildCastSpell(133, 1, { x: 1, y: 2, z: 3 }));
  client.close();
});

test("an active non-mount aura does not suppress the ordinary cast", () => {
  const ordinarySpell = 133;
  const { client, connection } = mountCastHarness({
    mountDisplayId: 2404,
    knownSpells: [{ id: ordinarySpell, slot: 0 }],
    mountSpellIds: [23214],
    activeAuras: [ordinarySpell],
  });
  client.castSpell(ordinarySpell);
  assert.deepEqual(connection.sent.map(({ opcode }) => opcode), [
    OPCODES.CMSG_CANCEL_MOUNT_AURA,
    OPCODES.CMSG_CAST_SPELL,
  ]);
  client.close();
});

test("opening a lock also dismounts before its direct spell cast", () => {
  const objectGuid = 0x9999n;
  const { client, connection } = mountCastHarness({ mountDisplayId: 2404 });
  client.state.move(objectGuid, { flags: 0, position: { x: 4, y: 5, z: 6, orientation: 0 } });
  client.state.objects.get(objectGuid).typeId = 5;
  client.openLock(objectGuid, 133);
  assert.deepEqual(connection.sent.map(({ opcode }) => opcode), [
    OPCODES.CMSG_CANCEL_MOUNT_AURA,
    OPCODES.CMSG_CAST_SPELL,
  ]);
  client.close();
});

test("a different mount dismounts and then casts", () => {
  const activeMount = 23214;
  const nextMount = 75207;
  const { client, connection } = mountCastHarness({
    mountDisplayId: 2404,
    knownSpells: [{ id: activeMount, slot: 0 }, { id: nextMount, slot: 1 }],
    mountSpellIds: [activeMount, nextMount],
    activeAuras: [activeMount],
  });
  client.castSpell(nextMount);
  assert.deepEqual(connection.sent.map(({ opcode }) => opcode), [
    OPCODES.CMSG_CANCEL_MOUNT_AURA,
    OPCODES.CMSG_CAST_SPELL,
  ]);
  client.close();
});

test("an unmounted active mount spell remains a normal cast", () => {
  const mountSpell = 23214;
  const { client, connection } = mountCastHarness({
    knownSpells: [{ id: mountSpell, slot: 0 }],
    mountSpellIds: [mountSpell],
    activeAuras: [mountSpell],
  });
  client.castSpell(mountSpell);
  assert.deepEqual(connection.sent.map(({ opcode }) => opcode), [OPCODES.CMSG_CAST_SPELL]);
  client.close();
});

test("an unknown spell does not dismount the player", () => {
  const { client, connection } = mountCastHarness({ mountDisplayId: 2404 });
  client.castSpell(999_999);
  assert.deepEqual(connection.sent, []);
  client.close();
});

test("Ж0 CMSG_CAST_SPELL names no unit, so the server may choose one", () => {
  // «лечение и баффы не применяются, когда в цели враг»: the client wrote TARGET_FLAG_UNIT and the
  // selected guid unconditionally, and an explicit target the server cannot use is a failed cast,
  // not a redirected one. With no unit flag `Spell.cpp:687-707` takes the server's own selection,
  // `CheckExplicitTarget` (`:695`) judges it, and `:703-704` puts the caster there when it refuses.
  const packet = buildCastSpell(2050, 1);
  assert.equal(packet.byteLength, 10, "castCount, spellId, castFlags and a four byte target mask");
  const reader = new PacketReader(packet);
  assert.equal(reader.u8(), 1, "castCount");
  assert.equal(reader.u32(), 2050, "spellId");
  assert.equal(reader.u8(), 0, "castFlags");
  assert.equal(reader.u32(), TARGET_FLAG_NONE, "an empty mask, and nothing at all after it");
  reader.assertFinished();

  // The working example that was already in this repository, in the file next door: a bandage and
  // a potion have always gone out with a bare zero mask, and they have always worked with an enemy
  // selected. Bag, slot, castCount, spellId, item guid, glyph index, cast flags, target mask.
  const use = buildUseItem(255, 23, 7, 33969, 0x0102_0304_0506_0708n);
  assert.equal(use.byteLength, 24);
  const item = new PacketReader(use);
  assert.deepEqual([item.u8(), item.u8(), item.u8(), item.u32()], [255, 23, 7, 33969]);
  assert.equal(item.u64(), 0x0102_0304_0506_0708n);
  assert.equal(item.u32(), 0, "glyph index");
  assert.equal(item.u8(), 0, "cast flags");
  assert.equal(item.u32(), TARGET_FLAG_NONE, "the mask this slice copied");
  item.assertFinished();
});

test("Ж0 CMSG_CAST_SPELL still names the point, so a ground spell keeps its target", () => {
  // The review's blocker on the empty block. Dropping the unit guid is what lets the server pick
  // the target; dropping the *point* with it moved every area spell to the caster's own feet.
  // `SpellCastTargets::Read` returns on `Spell.cpp:148-149` when the mask is zero, so
  // `InitExplicitTargets` arrives with neither a point nor an object and takes the last branch it
  // has: `:718` would have used the object the old client named, `:721` uses the caster. Measured
  // on this dataset's `Spell.dbc` — 1,148 of 49,842 rows carry `Targets & TARGET_FLAG_DEST_LOCATION`
  // and none of them names a unit flag in the same column, so the server's own selection branch
  // (`:687-707`) never runs for them; 86 of them — 23 distinct names — are learnable through
  // `SkillLineAbility` and not passive: Blizzard, Flamestrike, Rain of Fire, Volley, Hurricane,
  // Typhoon, Death and Decay, Mass Dispel and the rest of the ground-targeted kit.
  const packet = buildCastSpell(10, 3, { x: -8913.5, y: 554.75, z: 93.5 });
  assert.equal(packet.byteLength, 23, "ten bytes, a packed transport guid and three floats");
  const reader = new PacketReader(packet);
  assert.equal(reader.u8(), 3, "castCount");
  assert.equal(reader.u32(), 10, "spellId");
  assert.equal(reader.u8(), 0, "castFlags");
  const mask = reader.u32();
  assert.equal(mask, TARGET_FLAG_DEST_LOCATION, "a point and only a point");
  assert.equal(mask & TARGET_FLAG_UNIT, 0, "the unit the whole slice was about is still not named");
  assert.equal(reader.packedGuid(), 0n, "the transport WotLK writes before every location: none");
  assert.deepEqual([reader.f32(), reader.f32(), reader.f32()], [-8913.5, 554.75, 93.5]);
  reader.assertFinished();
});

test("Ж0 the point a cast names is the selection's, and the caster's own with nothing selected", async () => {
  const guid = 0x1234n;
  const victim = 0x5678n;
  const login = new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(0).toUint8Array();
  const connection = {
    sent: [],
    packets: [{ opcode: OPCODES.SMSG_LOGIN_VERIFY_WORLD, payload: login }],
    send(opcode, payload = new Uint8Array()) { this.sent.push({ opcode, payload }); },
    read() { return this.packets.length ? Promise.resolve(this.packets.shift()) : new Promise(() => {}); },
    close() {},
  };
  const client = new WorldClient(connection);
  await client.loginCharacter(guid);
  await Promise.resolve();
  client.knownSpells = [{ id: 10, slot: 0 }];
  client.state.selfGuid = guid;
  client.state.move(guid, { flags: 0, position: { x: 10, y: 20, z: 30, orientation: 0 } });
  client.state.move(victim, { flags: 0, position: { x: -40, y: 50, z: -60, orientation: 0 } });

  // Nothing selected: the caster's own position, which is what the server would have used anyway.
  client.castSpell(10);
  const casts = () => connection.sent.filter(({ opcode }) => opcode === OPCODES.CMSG_CAST_SPELL);
  assert.deepEqual(casts().at(-1).payload, buildCastSpell(10, 1, { x: 10, y: 20, z: 30 }));

  // Selected: the target's, so Blizzard lands on the boar and not on the mage.
  client.selectTarget(victim);
  client.castSpell(10);
  assert.deepEqual(casts().at(-1).payload, buildCastSpell(10, 2, { x: -40, y: 50, z: -60 }));
  const reader = new PacketReader(casts().at(-1).payload);
  reader.u8(); reader.u32(); reader.u8();
  assert.equal(reader.u32(), TARGET_FLAG_DEST_LOCATION);
  reader.packedGuid();
  assert.deepEqual([reader.f32(), reader.f32(), reader.f32()], [-40, 50, -60],
    "the selection's position, not the caster's");
  client.close();
});

test("spell cooldowns wait for an accepted cast and reject failures", async () => {
  const guid = 0x1234n;
  let wake;
  const connection = {
    sent: [],
    packets: [{ opcode: OPCODES.SMSG_LOGIN_VERIFY_WORLD, payload: new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(0).toUint8Array() }],
    send(opcode, payload = new Uint8Array()) { this.sent.push({ opcode, payload }); },
    read() {
      if (this.packets.length) return Promise.resolve(this.packets.shift());
      return new Promise((resolve) => { wake = resolve; });
    },
    enqueue(packet) {
      if (wake) {
        const resolve = wake;
        wake = undefined;
        resolve(packet);
      } else this.packets.push(packet);
    },
    close() {},
  };
  const client = new WorldClient(connection);
  await client.loginCharacter(guid);
  client.state.selfGuid = guid;
  client.knownSpells = [{ id: 133, slot: 0 }, { id: 168, slot: 1 }];
  const accepted = [];
  client.events.on("SPELL_CAST_ACCEPTED", (event) => accepted.push(event));

  client.castSpell(133, 1500);
  assert.equal(client.cooldownRemaining(133), 0);
  connection.enqueue({
    opcode: OPCODES.SMSG_CAST_FAILED,
    payload: new PacketWriter().u8(1).u32(133).u8(42).toUint8Array(),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.cooldownRemaining(133), 0, "failed casts do not retain a pending timer");
  assert.equal(accepted.length, 0);

  client.castSpell(168, 3000);
  connection.enqueue({
    opcode: OPCODES.SMSG_SPELL_FAILURE,
    payload: new PacketWriter().packedGuid(guid).u8(2).u32(168).u8(42).toUint8Array(),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.cooldownRemaining(168), 0, "SMSG_SPELL_FAILURE also rejects the pending timer");

  client.castSpell(133, 1500);
  connection.enqueue({
    opcode: OPCODES.SMSG_SPELL_START,
    payload: new PacketWriter().packedGuid(guid).packedGuid(guid).u8(3).u32(133).u32(0).u32(1500).toUint8Array(),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(accepted.length, 1, "START accepts the request once");
  assert.equal(accepted[0].source, "start");
  assert.equal(client.cooldownRemaining(133), 0, "START does not arm spell recovery");
  connection.enqueue({
    opcode: OPCODES.SMSG_SPELL_GO,
    payload: new PacketWriter().packedGuid(guid).packedGuid(guid).u8(3).u32(133).u32(0).u32(1500).u8(0).u8(0).toUint8Array(),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(accepted.length, 1, "GO is deduplicated against START");
  assert.ok(client.cooldownRemaining(133) > 1400, "successful GO arms the supplied recovery");

  // The cooldown announcement can beat the visual GO on the wire. It must arm recovery now but
  // leave the request available for the later exact GO to emit the one acceptance event.
  client.onCooldownEvent = (spellId) => client.startLocalCooldown(spellId, 1200);
  client.castSpell(168); // cast count 4; server metadata arrives through the event callback
  connection.enqueue({
    opcode: OPCODES.SMSG_COOLDOWN_EVENT,
    payload: new PacketWriter().u32(168).u64(guid).toUint8Array(),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(accepted.length, 1, "a cooldown packet alone does not invent acceptance");
  assert.ok(client.cooldownRemaining(168) > 1100, "authoritative cooldown applies before GO");
  const authoritativeEnd = client.cooldownState(168)?.endsAt;
  connection.enqueue({
    opcode: OPCODES.SMSG_SPELL_GO,
    payload: new PacketWriter().packedGuid(guid).packedGuid(guid).u8(4).u32(168).u32(0).u32(0).u8(0).u8(0).toUint8Array(),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(accepted.map(({ castId }) => castId), [3, 4], "the later GO accepts exactly once");
  assert.equal(client.cooldownState(168)?.endsAt, authoritativeEnd, "GO does not restart an authoritative timer");

  client.castSpell(168, 1800); // cast count 5
  connection.enqueue({
    opcode: OPCODES.SMSG_SPELL_COOLDOWN,
    payload: new PacketWriter().u64(guid).u8(0).u32(168).u32(1800).toUint8Array(),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(accepted.length, 2, "SPELL_COOLDOWN alone does not invent acceptance");
  const packetEnd = client.cooldownState(168)?.endsAt;
  assert.ok(client.cooldownRemaining(168) > 1700, "SPELL_COOLDOWN applies before GO");
  connection.enqueue({
    opcode: OPCODES.SMSG_SPELL_GO,
    payload: new PacketWriter().packedGuid(guid).packedGuid(guid).u8(5).u32(168).u32(0).u32(0).u8(0).u8(0).toUint8Array(),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(accepted.map(({ castId }) => castId), [3, 4, 5], "SPELL_COOLDOWN GO accepts exactly once");
  assert.equal(client.cooldownState(168)?.endsAt, packetEnd, "GO does not restart SPELL_COOLDOWN");

  // Two same-spell requests can be in flight around a cast-count wrap. A failure/GO for the older
  // one must not consume the newer pending request.
  client.castSpell(133, 2000); // cast count 6
  client.castSpell(133, 4000); // cast count 7
  connection.enqueue({
    opcode: OPCODES.SMSG_CAST_FAILED,
    payload: new PacketWriter().u8(6).u32(133).u8(42).toUint8Array(),
  });
  await new Promise((resolve) => setImmediate(resolve));
  connection.enqueue({
    opcode: OPCODES.SMSG_SPELL_GO,
    payload: new PacketWriter().packedGuid(guid).packedGuid(guid).u8(6).u32(133).u32(0).u32(0).u8(0).u8(0).toUint8Array(),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(accepted.map(({ castId }) => castId), [3, 4, 5], "a stale GO cannot consume cast 7");
  assert.equal(client.cooldownState(133)?.duration, 1500, "a stale GO cannot replace cast 6 state");
  connection.enqueue({
    opcode: OPCODES.SMSG_SPELL_GO,
    payload: new PacketWriter().packedGuid(guid).packedGuid(guid).u8(7).u32(133).u32(0).u32(0).u8(0).u8(0).toUint8Array(),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(accepted.map(({ castId }) => castId), [3, 4, 5, 7], "the failed older request never accepts");
  assert.equal(client.cooldownState(133)?.duration, 4000, "the newer request kept its own duration");

  // CAST_FAILED for a second request must not cancel the active bar from an earlier cast of the
  // same spell; the caster-specific SPELL_FAILURE is the packet that ends that bar.
  client.castSpell(133); // cast count 8
  connection.enqueue({
    opcode: OPCODES.SMSG_SPELL_START,
    payload: new PacketWriter().packedGuid(guid).packedGuid(guid).u8(8).u32(133).u32(0).u32(3000).toUint8Array(),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.casts.get(guid)?.spellId, 133);
  client.castSpell(133); // cast count 9, refused while cast 8 is active
  connection.enqueue({
    opcode: OPCODES.SMSG_CAST_FAILED,
    payload: new PacketWriter().u8(9).u32(133).u8(42).toUint8Array(),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.casts.get(guid)?.spellId, 133, "CAST_FAILED does not stop another active cast");
  connection.enqueue({
    opcode: OPCODES.SMSG_SPELL_FAILURE,
    payload: new PacketWriter().packedGuid(guid).u8(9).u32(133).u8(42).toUint8Array(),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.casts.get(guid)?.castCount, 8, "mismatched SPELL_FAILURE does not stop the active cast");
  connection.enqueue({
    opcode: OPCODES.SMSG_SPELL_FAILURE,
    payload: new PacketWriter().packedGuid(guid).u8(8).u32(133).u8(42).toUint8Array(),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.casts.has(guid), false, "the matching SPELL_FAILURE ends the active bar");

  // CLEAR_COOLDOWN resets an existing timer; it is not correlated with a newer request. The
  // successful GO must still be allowed to arm that request's own recovery.
  client.castSpell(168, 2100); // cast count 10
  connection.enqueue({
    opcode: OPCODES.SMSG_CLEAR_COOLDOWN,
    payload: new PacketWriter().u32(168).u64(guid).toUint8Array(),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.cooldownRemaining(168), 0, "CLEAR_COOLDOWN clears the current timer");
  connection.enqueue({
    opcode: OPCODES.SMSG_SPELL_GO,
    payload: new PacketWriter().packedGuid(guid).packedGuid(guid).u8(10).u32(168).u32(0).u32(0).u8(0).u8(0).toUint8Array(),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(client.cooldownRemaining(168) > 1900, "CLEAR_COOLDOWN does not suppress a later successful GO");
  assert.equal(client.cooldownState(168)?.duration, 2100);

  // DBC `SPELL_ATTR0_DISABLED_WHILE_ACTIVE` / category flag spells accept their GO without arming
  // own recovery. The event that follows the GO starts it once, using the metadata duration.
  connection.enqueue({
    opcode: OPCODES.SMSG_CLEAR_COOLDOWN,
    payload: new PacketWriter().u32(168).u64(guid).toUint8Array(),
  });
  await new Promise((resolve) => setImmediate(resolve));
  client.onCooldownEvent = (spellId) => client.startLocalCooldown(spellId, 2600);
  client.castSpell(168, 2600, true); // cast count 11, starts on the later event
  connection.enqueue({
    opcode: OPCODES.SMSG_SPELL_GO,
    payload: new PacketWriter().packedGuid(guid).packedGuid(guid).u8(11).u32(168).u32(0).u32(0).u8(0).u8(0).toUint8Array(),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.cooldownRemaining(168), 0, "on-event GO does not arm own recovery");
  connection.enqueue({
    opcode: OPCODES.SMSG_COOLDOWN_EVENT,
    payload: new PacketWriter().u32(168).u64(guid).toUint8Array(),
  });
  await new Promise((resolve) => setImmediate(resolve));
  const onEventEnd = client.cooldownState(168)?.endsAt;
  assert.equal(client.cooldownState(168)?.duration, 2600, "the event uses the metadata duration");
  connection.enqueue({
    opcode: OPCODES.SMSG_COOLDOWN_EVENT,
    payload: new PacketWriter().u32(168).u64(guid).toUint8Array(),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.cooldownState(168)?.endsAt, onEventEnd, "duplicate event does not restart recovery");

  // The event can precede GO. It starts the timer immediately and the exact GO only emits the
  // acceptance/GCD signal; it must not replace the authoritative snapshot.
  connection.enqueue({
    opcode: OPCODES.SMSG_CLEAR_COOLDOWN,
    payload: new PacketWriter().u32(133).u64(guid).toUint8Array(),
  });
  await new Promise((resolve) => setImmediate(resolve));
  client.castSpell(133, 3100, true); // cast count 12
  connection.enqueue({
    opcode: OPCODES.SMSG_COOLDOWN_EVENT,
    payload: new PacketWriter().u32(133).u64(guid).toUint8Array(),
  });
  await new Promise((resolve) => setImmediate(resolve));
  const eventBeforeGoEnd = client.cooldownState(133)?.endsAt;
  assert.equal(client.cooldownState(133)?.duration, 3100, "event-before-GO uses the pending metadata");
  connection.enqueue({
    opcode: OPCODES.SMSG_SPELL_GO,
    payload: new PacketWriter().packedGuid(guid).packedGuid(guid).u8(12).u32(133).u32(0).u32(0).u8(0).u8(0).toUint8Array(),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.cooldownState(133)?.endsAt, eventBeforeGoEnd, "GO does not replace event-before-GO recovery");
  client.close();
});

test("spell acceptance deduplication survives the 8-bit cast-count wrap", async () => {
  const guid = 0x1234n;
  let wake;
  const connection = {
    sent: [],
    packets: [{ opcode: OPCODES.SMSG_LOGIN_VERIFY_WORLD, payload: new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(0).toUint8Array() }],
    send(opcode, payload = new Uint8Array()) { this.sent.push({ opcode, payload }); },
    read() {
      if (this.packets.length) return Promise.resolve(this.packets.shift());
      return new Promise((resolve) => { wake = resolve; });
    },
    enqueue(packet) {
      if (wake) {
        const resolve = wake;
        wake = undefined;
        resolve(packet);
      } else this.packets.push(packet);
    },
    close() {},
  };
  const client = new WorldClient(connection);
  await client.loginCharacter(guid);
  client.state.selfGuid = guid;
  client.knownSpells = [{ id: 133, slot: 0 }, { id: 168, slot: 1 }];
  const accepted = [];
  client.events.on("SPELL_CAST_ACCEPTED", (event) => accepted.push(event));

  client.castSpell(133); // count 1; this accepted request remains pending without a GO
  connection.enqueue({
    opcode: OPCODES.SMSG_SPELL_START,
    payload: new PacketWriter().packedGuid(guid).packedGuid(guid).u8(1).u32(133).u32(0).u32(1500).toUint8Array(),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(accepted.map(({ castId }) => castId), [1]);

  // 255 requests advance 1 -> 0; the next request wraps to count 1 again.
  for (let index = 0; index < 255; index++) client.castSpell(168);
  client.castSpell(133); // new request, also count 1
  connection.enqueue({
    opcode: OPCODES.SMSG_SPELL_START,
    payload: new PacketWriter().packedGuid(guid).packedGuid(guid).u8(1).u32(133).u32(0).u32(1500).toUint8Array(),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(accepted.map(({ castId }) => castId), [1, 1], "wrapped request is not suppressed by the old one");

  connection.enqueue({
    opcode: OPCODES.SMSG_SPELL_GO,
    payload: new PacketWriter().packedGuid(guid).packedGuid(guid).u8(1).u32(133).u32(0).u32(0).u8(0).u8(0).toUint8Array(),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(accepted.map(({ castId }) => castId), [1, 1], "GO for the new request stays exact-once");
  client.close();
});

test("world travel notifies only for the own mover, with NEW_WORLD once", async () => {
  const guid = 0x1234n;
  const stranger = 0x5678n;
  const pet = 0x9abcn;
  const transport = 0xdef0n;
  const gameObject = 0x1357n;
  const login = new PacketWriter().u32(1).f32(1).f32(2).f32(3).f32(0).toUint8Array();
  const create = new PacketWriter()
    .u32(1).u8(2).packedGuid(guid).u8(4).u16(0x41)
    .f32(1).f32(2).f32(3).f32(0).u8(0);
  const movement = (x, y, z) => ({
    flags: 0, flags2: 0, time: 10,
    position: { x, y, z, orientation: 0 }, fallTime: 0,
  });
  const ownAck = new PacketWriter().packedGuid(guid).u32(7);
  writeMovementInfoBody(ownAck, movement(11, 12, 13));
  const foreignAck = new PacketWriter().packedGuid(stranger).u32(8);
  writeMovementInfoBody(foreignAck, movement(21, 22, 23));
  const connection = {
    sent: [],
    packets: [
      { opcode: OPCODES.SMSG_LOGIN_VERIFY_WORLD, payload: login },
      { opcode: OPCODES.SMSG_UPDATE_OBJECT, payload: create.toUint8Array() },
      { opcode: OPCODES.SMSG_NEW_WORLD, payload: new PacketWriter().u32(571).f32(4).f32(5).f32(6).f32(0).toUint8Array() },
      { opcode: OPCODES.MSG_MOVE_TELEPORT_ACK, payload: ownAck.toUint8Array() },
      { opcode: OPCODES.MSG_MOVE_TELEPORT_ACK, payload: foreignAck.toUint8Array() },
      { opcode: OPCODES.MSG_MOVE_TELEPORT, payload: buildMovementPacket(guid, 0, { x: 31, y: 32, z: 33, orientation: 0 }, 11) },
      { opcode: OPCODES.MSG_MOVE_TELEPORT, payload: buildMovementPacket(stranger, 0, { x: 41, y: 42, z: 43, orientation: 0 }, 12) },
    ],
    send(opcode, payload = new Uint8Array()) { this.sent.push({ opcode, payload }); },
    read() { return this.packets.length ? Promise.resolve(this.packets.shift()) : new Promise(() => {}); },
    close() {},
  };
  const client = new WorldClient(connection);
  const store = new WorldStore(client.state);
  const destroyed = [];
  const auraChanges = [];
  for (const stale of [pet, transport, gameObject]) {
    client.state.move(stale, { flags: 0, position: { x: 0, y: 0, z: 0, orientation: 0 } });
  }
  client.auras.set(pet, new Map([[3, { slot: 3, spellId: 7, flags: 0, casterLevel: 1, applications: 1 }]]));
  store.flush();
  store.events.on("OBJECT_DESTROYED", ({ guid: destroyedGuid }) => destroyed.push(destroyedGuid));
  client.events.on("AURA_CHANGED", (change) => auraChanges.push(change));
  const arrivals = [];
  client.onWorldChanged = (mapId, position) => arrivals.push({
    mapId, position, self: client.state.objects.get(guid)?.position,
  });
  await client.loginCharacter(guid);
  await new Promise((resolve) => setImmediate(resolve));
  store.flush();
  assert.deepEqual(arrivals.map(({ mapId }) => mapId), [571, 571, 571]);
  assert.deepEqual(arrivals.map(({ position }) => position.z), [6, 13, 33]);
  assert.deepEqual(arrivals[0].self, { x: 4, y: 5, z: 6, orientation: 0 });
  assert.deepEqual(destroyed.toSorted((left, right) => Number(left - right)), [pet, transport, gameObject].toSorted((left, right) => Number(left - right)));
  assert.deepEqual(auraChanges.map((change) => change.guid), [pet]);
  assert.equal(client.auras.has(pet), false);
  assert.equal(client.state.objects.has(pet), false);
  assert.equal(client.state.objects.has(transport), false);
  assert.equal(client.state.objects.has(gameObject), false);
  assert.equal(client.state.objects.has(stranger), true, "new-map updates still create normally");
  store.detach();
  client.close();
});

test("initial spells and spell casts match TrinityCore layouts", () => {
  const payload = new PacketWriter()
    .u8(0)
    .u16(2)
    .u32(133)
    .u16(0)
    .u32(168)
    .u16(0)
    .u16(1)
    .u32(133)
    .u16(0)
    .u16(35)
    .u32(1200)
    .u32(0)
    .toUint8Array();
  assert.deepEqual(parseInitialSpells(payload), {
    spells: [{ id: 133, slot: 0 }, { id: 168, slot: 0 }],
    cooldowns: [{ spellId: 133, itemId: 0, categoryId: 35, cooldown: 1200, categoryCooldown: 0 }],
  });

  // Ten bytes when the caller knows no position at all, and the last four are the empty target
  // block Ж0 replaced the guid with: castCount, spellId little-endian, castFlags, mask. It used to
  // be thirteen — mask 2 (`TARGET_FLAG_UNIT`) and the packed guid `3, 2, 1` — and that explicit
  // target is what stopped a heal landing while an enemy was selected. `WorldClient.castSpell`
  // does know one and sends the twenty-three byte form; see the two Ж0 tests above.
  assert.deepEqual(
    [...buildCastSpell(133, 7)],
    [7, 133, 0, 0, 0, 0, 0, 0, 0, 0],
  );
  assert.deepEqual(
    parseCastFailure(new PacketWriter().u8(7).u32(133).u8(42).u32(999).toUint8Array()),
    { castCount: 7, spellId: 133, result: 42 },
  );
  assert.deepEqual(
    parseSpellCooldown(new PacketWriter().u64(0x1234n).u8(1).u32(133).u32(8000).u32(168).u32(1500).toUint8Array()),
    { guid: 0x1234n, flags: 1, cooldowns: [{ spellId: 133, duration: 8000 }, { spellId: 168, duration: 1500 }] },
  );
  const event = new PacketWriter().u32(133).u64(0x1234n).toUint8Array();
  assert.deepEqual(parseCooldownEvent(event), { spellId: 133, guid: 0x1234n });
  assert.deepEqual(parseClearCooldown(event), { spellId: 133, guid: 0x1234n });
});

test("a superseded rank whose old spell is unknown is added, and a known one is replaced", async () => {
  const queue = []; let wake;
  const connection = {
    sent: [],
    push(opcode, payload) {
      if (wake) { const resume = wake; wake = undefined; resume({ opcode, payload }); }
      else queue.push({ opcode, payload });
    },
    send(opcode, payload = new Uint8Array()) { this.sent.push({ opcode, payload }); },
    read() { return queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve) => { wake = resolve; }); },
    close() {},
  };
  const client = new WorldClient(connection);
  try {
    connection.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD,
      new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(0).toUint8Array());
    await client.loginCharacter(1n);
    for (let index = 0; index < 6; index++) await new Promise(setImmediate);
    client.knownSpells = [{ id: 133, slot: 0 }];
    const changes = [];
    client.onSpellsChanged = (spells) => changes.push(spells.map((spell) => spell.id));
    // The core sends no `SMSG_LEARNED_SPELL` for a new rank: this packet replaces the old one.
    // With the old rank missing it must still add the spell instead of renaming nothing.
    connection.push(OPCODES.SMSG_SUPERCEDED_SPELL, new PacketWriter().u32(143).u32(116).toUint8Array());
    for (let index = 0; index < 6; index++) await new Promise(setImmediate);
    assert.deepEqual(client.knownSpells.map((spell) => spell.id), [133, 116]);
    assert.deepEqual(changes.at(-1), [133, 116]);
    // A replacement still replaces in place.
    connection.push(OPCODES.SMSG_SUPERCEDED_SPELL, new PacketWriter().u32(116).u32(126).toUint8Array());
    for (let index = 0; index < 6; index++) await new Promise(setImmediate);
    assert.deepEqual(client.knownSpells.map((spell) => spell.id), [133, 126]);
  } finally {
    client.close();
  }
});

test("spell-go header exposes the confirmed caster and spell", () => {
  const payload = new PacketWriter()
    .packedGuid(0x11n)
    .packedGuid(0x22n)
    .u8(3)
    .u32(133)
    .u32(0x20)
    .u32(1500)
    .u32(0)
    .toUint8Array();
  assert.deepEqual(parseSpellCastHeader(payload), {
    casterGuid: 0x11n,
    casterUnit: 0x22n,
    castId: 3,
    spellId: 133,
    castFlags: 0x20,
    castTime: 1500,
  });
});

test("world packet events expose complete GO, channel updates and aura diffs", async () => {
  const guid = 0x1234n;
  const neighbour = 0x5678n;
  const login = new PacketWriter().u32(1).f32(1).f32(2).f32(3).f32(0).toUint8Array();
  const neighbourCreate = new PacketWriter()
    .u32(1).u8(2).packedGuid(neighbour).u8(3).u16(0x30)
    .u32(0).u16(0).u32(123).f32(1).f32(2).f32(3).f32(0).u32(0);
  for (let speed = 0; speed < 9; speed++) neighbourCreate.f32(speed + 1);
  neighbourCreate.u32(0x0b);
  writeUpdateFields(neighbourCreate, [[UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, 42]]);
  const spellGo = new PacketWriter()
    .packedGuid(guid).packedGuid(guid).u8(1).u32(133).u32(0).u32(100)
    .u8(1).u64(0x55n).u8(0).u32(0)
    .toUint8Array();
  const spellStart = new PacketWriter()
    .packedGuid(guid).packedGuid(guid).u8(1).u32(133).u32(0).u32(1500)
    .toUint8Array();
  const auraAdd = new PacketWriter()
    .packedGuid(neighbour).u8(3).u32(123).u8(AURA_FLAGS.positive | AURA_FLAGS.duration).u8(80).u8(2)
    .packedGuid(0x99n).u32(120_000).u32(90_000).toUint8Array();
  const auraRefresh = new PacketWriter()
    .packedGuid(neighbour).u8(3).u32(123).u8(AURA_FLAGS.positive | AURA_FLAGS.duration).u8(81).u8(3)
    .packedGuid(0x99n).u32(120_000).u32(80_000).toUint8Array();
  const auraReplaceAll = new PacketWriter()
    .packedGuid(neighbour).u8(4).u32(456).u8(AURA_FLAGS.positive).u8(82).u8(1)
    .packedGuid(0x77n).toUint8Array();
  const outOfRange = new PacketWriter().u32(1).u8(4).u32(1).packedGuid(neighbour).toUint8Array();
  const connection = {
    sent: [],
    packets: [
      { opcode: OPCODES.SMSG_LOGIN_VERIFY_WORLD, payload: login },
      { opcode: OPCODES.SMSG_UPDATE_OBJECT, payload: neighbourCreate.toUint8Array() },
      { opcode: OPCODES.SMSG_SPELL_START, payload: spellStart },
      { opcode: OPCODES.SMSG_SPELL_GO, payload: spellGo },
      { opcode: OPCODES.MSG_CHANNEL_START, payload: new PacketWriter().packedGuid(guid).u32(5143).u32(5000).toUint8Array() },
      { opcode: OPCODES.MSG_CHANNEL_UPDATE, payload: new PacketWriter().packedGuid(guid).u32(3200).toUint8Array() },
      { opcode: OPCODES.MSG_CHANNEL_UPDATE, payload: new PacketWriter().packedGuid(guid).u32(0).toUint8Array() },
      { opcode: OPCODES.SMSG_AURA_UPDATE_ALL, payload: auraAdd },
      { opcode: OPCODES.SMSG_AURA_UPDATE, payload: auraRefresh },
      { opcode: OPCODES.SMSG_AURA_UPDATE_ALL, payload: auraReplaceAll },
      { opcode: OPCODES.SMSG_UPDATE_OBJECT, payload: outOfRange },
    ],
    send(opcode, payload = new Uint8Array()) { this.sent.push({ opcode, payload }); },
    read() { return this.packets.length ? Promise.resolve(this.packets.shift()) : new Promise(() => {}); },
    close() {},
  };
  const client = new WorldClient(connection);
  const gos = [];
  const channels = [];
  const stops = [];
  const order = [];
  const auras = [];
  client.events.on("SPELL_GO", (cast) => gos.push(cast));
  client.events.on("SPELL_CAST_START", (cast) => order.push(`start:${cast.spellId}`));
  client.events.on("SPELL_CHANNEL_UPDATE", (update) => {
    channels.push(update);
    order.push(`channel:${update.remaining}`);
  });
  client.events.on("SPELL_CAST_STOP", (stop) => {
    stops.push(stop);
    order.push("stop");
  });
  client.events.on("AURA_CHANGED", (change) => auras.push(change));
  await client.loginCharacter(guid);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(gos.length, 1);
  assert.deepEqual(gos[0].hits, [0x55n]);
  assert.deepEqual(channels.map((update) => update.remaining), [3200, 0]);
  assert.deepEqual(channels.map((update) => update.spellId), [5143, 5143]);
  assert.deepEqual(order, ["start:133", "stop", "start:5143", "channel:3200", "channel:0", "stop"]);
  assert.equal(client.casts.has(guid), false, "successful GO removes the matching non-channel cast");
  assert.equal(stops.at(-1).spellId, 5143);
  assert.equal(auras.length, 4);
  assert.deepEqual(auras[0].added.map((aura) => aura.spellId), [123]);
  assert.deepEqual(auras[0].removed, []);
  assert.deepEqual(auras[1].updated.map(({ before, after }) => [before.applications, after.applications]), [[2, 3]]);
  assert.deepEqual(auras[1].removed, []);
  assert.deepEqual(auras[2].removed.map((aura) => aura.spellId), [123]);
  assert.deepEqual(auras[2].added.map((aura) => aura.spellId), [456]);
  assert.deepEqual(auras[3].removed.map((aura) => aura.spellId), [456]);
  assert.equal(client.state.objects.has(neighbour), false);
  assert.equal(client.auras.has(neighbour), false);
  client.close();
});

test("compressed out-of-range retires packet-owned aura state in packet order", async () => {
  const self = 0x1234n;
  const neighbour = 0x5678n;
  const login = new PacketWriter().u32(1).f32(1).f32(2).f32(3).f32(0).toUint8Array();
  const create = new PacketWriter()
    .u32(1).u8(2).packedGuid(neighbour).u8(3).u16(0x30)
    .u32(0).u16(0).u32(123).f32(1).f32(2).f32(3).f32(0).u32(0);
  for (let speed = 0; speed < 9; speed++) create.f32(speed + 1);
  create.u32(0x0b);
  writeUpdateFields(create, [[UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, 42]]);
  const aura = new PacketWriter()
    .packedGuid(neighbour).u8(3).u32(456).u8(AURA_FLAGS.positive).u8(80).u8(1)
    .packedGuid(self).toUint8Array();
  const castStart = new PacketWriter()
    .packedGuid(neighbour).packedGuid(neighbour).u8(1).u32(133).u32(0).u32(1500).toUint8Array();
  const outOfRange = new PacketWriter().u32(1).u8(4).u32(1).packedGuid(neighbour).toUint8Array();
  const compressedOutOfRange = new PacketWriter()
    .u32(outOfRange.byteLength).bytes(new Uint8Array(deflateSync(outOfRange))).toUint8Array();
  const connection = {
    sent: [],
    packets: [
      { opcode: OPCODES.SMSG_LOGIN_VERIFY_WORLD, payload: login },
      { opcode: OPCODES.SMSG_UPDATE_OBJECT, payload: create.toUint8Array() },
      { opcode: OPCODES.SMSG_AURA_UPDATE_ALL, payload: aura },
      { opcode: OPCODES.SMSG_SPELL_START, payload: castStart },
      { opcode: OPCODES.SMSG_COMPRESSED_UPDATE_OBJECT, payload: compressedOutOfRange },
    ],
    send(opcode, payload = new Uint8Array()) { this.sent.push({ opcode, payload }); },
    read() { return this.packets.length ? Promise.resolve(this.packets.shift()) : new Promise(() => {}); },
    close() {},
  };
  const client = new WorldClient(connection);
  const changes = [];
  const stops = [];
  client.events.on("AURA_CHANGED", (change) => changes.push(change));
  client.events.on("SPELL_CAST_STOP", (stop) => stops.push(stop));
  await client.loginCharacter(self);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(changes.map((change) => [change.guid, change.added.length, change.removed.length]), [
    [neighbour, 1, 0], [neighbour, 0, 1],
  ]);
  assert.deepEqual(stops.map((stop) => [stop.casterGuid, stop.spellId, stop.reason]), [
    [neighbour, 133, "interrupted"],
  ]);
  assert.equal(client.state.objects.has(neighbour), false);
  assert.equal(client.auras.has(neighbour), false);
  assert.equal(client.casts.has(neighbour), false);
  client.close();
});

test("out-of-range retires an aura that arrived before its object create", async () => {
  const self = 0x1234n;
  const unseen = 0x5678n;
  const login = new PacketWriter().u32(1).f32(1).f32(2).f32(3).f32(0).toUint8Array();
  const aura = new PacketWriter()
    .packedGuid(unseen).u8(3).u32(456).u8(AURA_FLAGS.positive).u8(80).u8(1)
    .packedGuid(self).toUint8Array();
  const outOfRange = new PacketWriter().u32(1).u8(4).u32(1).packedGuid(unseen).toUint8Array();
  const connection = {
    sent: [],
    packets: [
      { opcode: OPCODES.SMSG_LOGIN_VERIFY_WORLD, payload: login },
      { opcode: OPCODES.SMSG_AURA_UPDATE_ALL, payload: aura },
      { opcode: OPCODES.SMSG_UPDATE_OBJECT, payload: outOfRange },
    ],
    send(opcode, payload = new Uint8Array()) { this.sent.push({ opcode, payload }); },
    read() { return this.packets.length ? Promise.resolve(this.packets.shift()) : new Promise(() => {}); },
    close() {},
  };
  const client = new WorldClient(connection);
  const changes = [];
  client.events.on("AURA_CHANGED", (change) => changes.push(change));
  await client.loginCharacter(self);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(changes.map((change) => [change.guid, change.added.length, change.removed.length]), [
    [unseen, 1, 0], [unseen, 0, 1],
  ]);
  assert.equal(client.auras.has(unseen), false);
  client.close();
});

test("NEW_WORLD retires packet-only GUIDs and preserves self state", async () => {
  const self = 0x1234n, unseen = 0x5678n, taxi = 0x901n, healer = 0x902n, quest = 0x903n;
  const login = new PacketWriter().u32(1).f32(1).f32(2).f32(3).f32(0).toUint8Array();
  const aura = guid => new PacketWriter().packedGuid(guid).u8(3).u32(456)
    .u8(AURA_FLAGS.positive).u8(80).u8(1).packedGuid(self).toUint8Array();
  const castStart = new PacketWriter().packedGuid(unseen).packedGuid(unseen)
    .u8(1).u32(133).u32(0).u32(1500).toUint8Array();
  const transfer = new PacketWriter().u32(571).f32(4).f32(5).f32(6).f32(0).toUint8Array();
  const connection = {
    packets: [
      { opcode: OPCODES.SMSG_LOGIN_VERIFY_WORLD, payload: login },
      { opcode: OPCODES.SMSG_AURA_UPDATE_ALL, payload: aura(self) },
      { opcode: OPCODES.SMSG_AURA_UPDATE_ALL, payload: aura(unseen) },
      { opcode: OPCODES.SMSG_SPELL_START, payload: castStart },
      { opcode: OPCODES.SMSG_NEW_WORLD, payload: transfer },
    ],
    send() {}, read() { return this.packets.length ? Promise.resolve(this.packets.shift()) : new Promise(() => {}); }, close() {},
  };
  const client = new WorldClient(connection);
  client.state.selfGuid = self;
  client.taxiNodeStatus.set(taxi, true);
  client.spiritHealerTimers.set(healer, { milliseconds: 10, receivedAt: 0 });
  client.questGiverStatus.set(quest, 1);
  const removed = [], stops = [];
  client.events.on("AURA_CHANGED", e => { if (e.removed.length) removed.push(e.guid); });
  client.events.on("SPELL_CAST_STOP", e => stops.push(e.casterGuid));
  await client.loginCharacter(self);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(removed, [unseen]);
  assert.deepEqual(stops, [unseen]);
  assert.equal(client.auras.has(unseen), false);
  assert.equal(client.auras.get(self)?.get(3)?.spellId, 456);
  assert.equal(client.casts.size, 0);
  assert.equal(client.taxiNodeStatus.size + client.spiritHealerTimers.size + client.questGiverStatus.size, 0);
  assert.deepEqual(client.state.objects.get(self)?.position, { x: 4, y: 5, z: 6, orientation: 0 });
  client.close();
});

test("combat responses decode TrinityCore GUID layouts", () => {
  assert.deepEqual(
    parseAttackStart(new PacketWriter().u64(1n).u64(2n).toUint8Array()),
    { attacker: 1n, victim: 2n },
  );
  assert.deepEqual(
    parseAttackStop(new PacketWriter().packedGuid(1n).packedGuid(2n).u32(1).toUint8Array()),
    { attacker: 1n, victim: 2n, victimDied: true },
  );
  assert.deepEqual(
    parseHealthUpdate(new PacketWriter().packedGuid(2n).u32(123).toUint8Array()),
    { guid: 2n, health: 123 },
  );
});

test("monster spline movement decodes and advances creatures", () => {
  const guid = 0x99n;
  const payload = new PacketWriter()
    .packedGuid(guid)
    .u8(0)
    .f32(0)
    .f32(0)
    .f32(0)
    .u32(7)
    .u8(0)
    .u32(0)
    .u32(1000)
    .u32(2)
    .f32(10)
    .f32(0)
    .f32(0)
    .u32(4)
    .toUint8Array();
  const move = parseMonsterMove(payload);
  assert.deepEqual(move.points, [{ x: 0, y: 0, z: 0 }, { x: 4, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }]);

  const state = new WorldState();
  state.move(guid, { flags: 0, position: { x: 0, y: 0, z: 0, orientation: 0 } });
  state.startSpline(move, 0);
  state.updateMotions(500);
  assert.ok(Math.abs(state.objects.get(guid).position.x - 5) < 0.0001);
  state.updateMotions(1000);
  assert.equal(state.objects.get(guid).position.x, 10);
  state.objects.get(guid).typeId = 3;
  state.setField(guid, UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 0);
  assert.equal(isWorldObjectDead(state.objects.get(guid)), true);
});

const SPLINE_SCRUB_MASK = 0x0cc0300f; // MOVEMENTFLAG_MASK_MOVING | MOVEMENTFLAG_SPLINE_ENABLED

/**
 * A create block with UPDATEFLAG_LIVING, which is the only shape in which this core ever states a
 * creature's movement flags. `Object::BuildMovementUpdateBlock`, the sole writer of
 * UPDATETYPE_MOVEMENT, has no caller anywhere in the source — a definition and a declaration and
 * nothing else — and the block below is what `Player::UpdateVisibilityOf` sends the moment a
 * creature comes into range.
 */
function livingCreateBlock(guid, typeId, movementFlags) {
  const writer = new PacketWriter()
    .u32(1)
    .u8(2) // UPDATETYPE_CREATE_OBJECT
    .packedGuid(guid)
    .u8(typeId)
    .u16(0x0020) // UPDATEFLAG_LIVING
    .u32(movementFlags)
    .u16(0)
    .u32(0)
    .f32(0).f32(0).f32(0).f32(0)
    .u32(0); // fall time
  if (movementFlags & MOVEMENT_FLAGS.falling) writer.f32(0).f32(0).f32(0).f32(0);
  for (let speed = 0; speed < 9; speed++) writer.f32(speed + 1);
  // The spline the block carries, which `skipSpline` reads past and throws away.
  if (movementFlags & MOVEMENT_FLAGS.splineEnabled) {
    writer.u32(0).u32(0).u32(0).u32(0).f32(0).f32(0).f32(0).u32(0).u32(0).u8(0).f32(0).f32(0).f32(0);
  }
  return writer.u8(0).toUint8Array(); // no update-field blocks
}

function monsterSpline(guid, yards, milliseconds) {
  return parseMonsterMove(new PacketWriter()
    .packedGuid(guid).u8(0)
    .f32(0).f32(0).f32(0)
    .u32(7).u8(0) // spline id, MonsterMoveNormal
    .u32(0).u32(milliseconds).u32(1)
    .f32(yards).f32(0).f32(0)
    .toUint8Array());
}

/** `MoveSplineInit::Stop`, which is what `Unit::StopMoving` writes. */
function monsterStop(guid, x) {
  return parseMonsterMove(new PacketWriter()
    .packedGuid(guid).u8(0).f32(x).f32(0).f32(0).u32(8).u8(1)
    .toUint8Array());
}

/** The pose the renderer builds from a unit, `WorldRenderer3D.#animateUnit`. */
function unitPose(object) {
  return {
    dead: false,
    movementFlags: object.movementFlags,
    spline: object.motion !== undefined,
    flight: object.motion?.flying === true,
    ...(object.motion && object.motion.duration > 0
      ? { speed: object.motion.totalLength / (object.motion.duration / 1000) }
      : {}),
    standState: 0,
  };
}

test("a creature whose create block caught it walking is drawn standing", () => {
  // The create block's spline is read past unused, so the creature is drawn where the block put
  // it — but its flags used to go on saying FORWARD for ever, because nothing on the wire can take
  // them off: measured on `dist/code`, a creature created with 0x08000001 still read 0x08000001
  // after all sixteen SMSG_SPLINE_MOVE_*, whose flags come to 0x71200d00 between them.
  const guid = 0xf130000000004321n;
  const state = new WorldState();
  state.applyUpdate(livingCreateBlock(guid, 3, MOVEMENT_FLAGS.splineEnabled | MOVEMENT_FLAGS.forward));
  const creature = state.objects.get(guid);
  assert.equal(creature.movementFlags & SPLINE_SCRUB_MASK, 0);
  assert.equal(isUnitMoving(creature.movementFlags, creature.motion !== undefined), false);
  assert.equal(poseAnimation(unitPose(creature)).wanted[0], ANIMATION_IDS.Stand);

  // `MotionMaster::MoveFall` sets FALLING (`MotionMaster.cpp:975`) and
  // `Creature::UpdateMovementFlags` clears it locally and silently (`Creature.cpp:3021-3022`), so
  // a creature created in the air played the jump loop until it left sight.
  const airborne = new WorldState();
  airborne.applyUpdate(livingCreateBlock(guid, 3, MOVEMENT_FLAGS.falling));
  assert.equal(poseAnimation(unitPose(airborne.objects.get(guid))).wanted[0], ANIMATION_IDS.Stand);

  // Players are exempt, and that is the whole reason the scrub asks for TYPEID_UNIT: a character's
  // own word is what `WorldClient.#currentMovement()` sends back to the server.
  const player = new WorldState();
  player.applyUpdate(livingCreateBlock(guid, 4, MOVEMENT_FLAGS.forward));
  const self = player.objects.get(guid);
  assert.equal(self.movementFlags & MOVEMENT_FLAGS.forward, MOVEMENT_FLAGS.forward);
  assert.equal(poseAnimation(unitPose(self)).wanted[0], ANIMATION_IDS.Run);
});

test("the three ways a creature's spline ends, and the flags each one leaves", () => {
  const guid = 0xf130000000004322n;
  // A charmed creature relays MSG_MOVE_* under its own guid, which is how a creature's flags come
  // to be set anywhere but a create block.
  const walking = (state) => state.move(guid, {
    flags: MOVEMENT_FLAGS.splineEnabled | MOVEMENT_FLAGS.forward,
    position: { x: 0, y: 0, z: 0, orientation: 0 },
  }, 0);

  // Arrival. `Unit::UpdateSplineMovement` calls `DisableSpline` and writes nothing at all.
  const arriving = new WorldState();
  arriving.applyUpdate(livingCreateBlock(guid, 3, 0));
  walking(arriving);
  const creature = arriving.objects.get(guid);
  arriving.startSpline(monsterSpline(guid, 10, 4000), 0);
  assert.equal(poseAnimation(unitPose(creature)).wanted[0], ANIMATION_IDS.Walk, "10 yards over 4 s is 2.5 yd/s");
  arriving.updateMotions(4100);
  assert.equal(creature.movementFlags & SPLINE_SCRUB_MASK, 0);
  assert.equal(poseAnimation(unitPose(creature)).wanted[0], ANIMATION_IDS.Stand);

  // A stop packet. This one the server does send, and it removes the same flags as it writes it.
  const halting = new WorldState();
  halting.applyUpdate(livingCreateBlock(guid, 3, 0));
  walking(halting);
  const stopped = halting.objects.get(guid);
  halting.startSpline(monsterSpline(guid, 10, 4000), 0);
  halting.startSpline(monsterStop(guid, 4), 2000);
  assert.equal(stopped.motion, undefined);
  assert.equal(stopped.movementFlags & SPLINE_SCRUB_MASK, 0);
  assert.equal(poseAnimation(unitPose(stopped)).wanted[0], ANIMATION_IDS.Stand);

  // A spline on a transport nobody can see. Nothing ends a cyclic path, so the creature used to
  // pace its old route for as long as it stayed in view.
  const boarding = new WorldState();
  boarding.applyUpdate(livingCreateBlock(guid, 3, 0));
  walking(boarding);
  const rider = boarding.objects.get(guid);
  const loop = monsterSpline(guid, 10, 4000);
  loop.cyclic = true;
  boarding.startSpline(loop, 0);
  const aboard = monsterSpline(guid, 10, 4000);
  aboard.transportGuid = 0x4000n;
  boarding.startSpline(aboard, 5000);
  boarding.updateMotions(60000);
  assert.equal(rider.motion, undefined);
  assert.equal(poseAnimation(unitPose(rider)).wanted[0], ANIMATION_IDS.Stand);
});

test("SMSG_SPLINE_MOVE_ROOT carries the removal the core made before sending it", () => {
  // `Unit::SetRooted(true)` clears MOVEMENTFLAG_MASK_MOVING, raises ROOT and calls StopMoving()
  // before this packet goes out, and the comment at `Unit.cpp:12299` says a 3.3.5a client freezes
  // when the two are set together. Or-ing the one bit kept the rest.
  const guid = 0xf130000000004323n;
  const state = new WorldState();
  state.applyUpdate(livingCreateBlock(guid, 3, 0));
  const creature = state.objects.get(guid);
  state.move(guid, {
    flags: MOVEMENT_FLAGS.splineEnabled | MOVEMENT_FLAGS.forward,
    position: { x: 0, y: 0, z: 0, orientation: 0 },
  }, 0);
  state.applyMovementFlag(guid, MOVEMENT_FLAGS.root, true);
  assert.equal(creature.movementFlags & MOVEMENT_FLAGS.forward, 0);
  assert.equal(creature.movementFlags & MOVEMENT_FLAGS.root, MOVEMENT_FLAGS.root);
  assert.equal(poseAnimation(unitPose(creature)).wanted[0], ANIMATION_IDS.Stand);

  // Unroot says nothing about going anywhere, so it clears one bit and no more. SPLINE_ENABLED
  // survives both, exactly as it does in the core: `MoveSplineInit.cpp:103-104` drops MASK_MOVING
  // for a rooted unit and keeps the spline bit.
  state.applyMovementFlag(guid, MOVEMENT_FLAGS.walking, true);
  state.applyMovementFlag(guid, MOVEMENT_FLAGS.root, false);
  assert.equal(creature.movementFlags & MOVEMENT_FLAGS.root, 0);
  assert.equal(creature.movementFlags & MOVEMENT_FLAGS.walking, MOVEMENT_FLAGS.walking);
  assert.equal(creature.movementFlags & MOVEMENT_FLAGS.splineEnabled, MOVEMENT_FLAGS.splineEnabled);

  // And the sixteen state opcodes on their own still cannot reach a translation bit: taken from
  // the table, their flags come to 0x71200d00, which meets 0xf in nothing.
  let union = 0;
  for (const entry of SPLINE_MOVE_STATES) union |= entry.flag;
  assert.equal(union >>> 0, 0x71200d00);
  assert.equal(union & 0xf, 0);
});

test("what a unit's flags word actually reads while its spline is running", () => {
  // The five numbers `isUnitMoving` quotes, so the comment cannot drift away from the code again.
  // A creature is given exactly one flags word — the one its create block brought — and
  // `#applyMovement` scrubs it, so FORWARD cannot survive into a live spline no matter what the
  // block said. `SMSG_MONSTER_MOVE` adds none of its own: it has no flags field at all.
  const guid = 0xf130000000004324n;
  const walking = MOVEMENT_FLAGS.splineEnabled | MOVEMENT_FLAGS.forward;
  const running = (prepare) => {
    const state = new WorldState();
    prepare(state);
    state.startSpline(monsterSpline(guid, 10, 4000), 0);
    state.updateMotions(1000);
    const object = state.objects.get(guid);
    assert.equal(object.motion !== undefined, true, "the spline is live");
    return object.movementFlags >>> 0;
  };

  const plain = running((state) => state.applyUpdate(livingCreateBlock(guid, 3, walking)));
  assert.equal(plain, 0x00000000);
  // The two bits a creature can still be wearing come from `SMSG_SPLINE_MOVE_*`, and neither is in
  // the scrub mask: START_SWIM is 0x00200000 and GRAVITY_DISABLE is 0x00000400.
  const swimming = running((state) => {
    state.applyUpdate(livingCreateBlock(guid, 3, walking));
    state.applyMovementFlag(guid, MOVEMENT_FLAGS.swimming, true);
  });
  assert.equal(swimming, 0x00200000);
  const flying = running((state) => {
    state.applyUpdate(livingCreateBlock(guid, 3, walking));
    state.applyMovementFlag(guid, MOVEMENT_FLAGS.disableGravity, true);
  });
  assert.equal(flying, 0x00000400);
  for (const flags of [plain, swimming, flying]) assert.equal(flags & MOVEMENT_FLAG_TRANSLATING, 0);

  // And the half of the union that the flags do answer for: a unit whose word arrives by
  // `MSG_MOVE_*` keeps it, because nothing may overwrite what a player says about themselves.
  // A charmed creature relays under its own guid, and a taxi puts a player on a spline outright.
  const position = { x: 0, y: 0, z: 0, orientation: 0 };
  const charmed = running((state) => {
    state.applyUpdate(livingCreateBlock(guid, 3, 0));
    state.move(guid, { flags: walking, position }, 0);
  });
  assert.equal(charmed, 0x08000001);
  const player = running((state) => state.applyUpdate(livingCreateBlock(guid, 4, walking)));
  assert.equal(player, 0x08000001);
  for (const flags of [charmed, player]) assert.equal(isUnitMoving(flags, true), true);
});

test("monster flight spline keeps FLAG_FLYING for the renderer", () => {
  const guid = 0x9an;
  const payload = new PacketWriter()
    .packedGuid(guid)
    .u8(0)
    .f32(0).f32(0).f32(10)
    .u32(7)
    .u8(0)
    .u32(0x00002000) // MonsterMove FLAG_FLYING
    .u32(1000)
    .u32(1)
    .f32(10).f32(0).f32(20)
    .toUint8Array();
  const move = parseMonsterMove(payload);
  assert.equal(move.flying, true);

  const state = new WorldState();
  state.move(guid, { flags: 0, position: { x: 0, y: 0, z: 10, orientation: 0 } });
  state.startSpline(move, 0);
  assert.equal(state.objects.get(guid).motion.flying, true);
});

test("a packet that lands during the login handshake is kept, not thrown away", async () => {
  // The server does real work before it writes SMSG_LOGIN_VERIFY_WORLD: `Player::LoadFromDB` and
  // `SendDungeonDifficulty` both run first. The wait that owns the socket until then used to run
  // each packet through the utility handler and drop whatever did not match — 85 opcodes of the
  // 514 live ones are named there — so a character entering on heroic read as normal.
  const guid = 0x1234n;
  const login = new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(0).toUint8Array();
  const difficulty = new PacketWriter().u32(2).u32(1).u32(0).toUint8Array();
  const connection = {
    sent: [],
    packets: [
      // Before the handshake completes, exactly where the core sends it.
      { opcode: OPCODES.MSG_SET_DUNGEON_DIFFICULTY, payload: difficulty },
      { opcode: OPCODES.SMSG_LOGIN_VERIFY_WORLD, payload: login },
    ],
    send(opcode, payload = new Uint8Array()) { this.sent.push({ opcode, payload }); },
    read() { return this.packets.length ? Promise.resolve(this.packets.shift()) : new Promise(() => {}); },
    close() {},
  };
  const client = new WorldClient(connection);
  await client.loginCharacter(guid);
  // The world loop drains what the handshake held before it reads anything new.
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(client.dungeonDifficulty, 2, "the difficulty the server stated, not the initialiser");
  // And it is not recorded as a packet nobody could route.
  assert.equal(client.unhandledOpcodes.entries.has(OPCODES.MSG_SET_DUNGEON_DIFFICULTY), false);
  assert.equal(client.unhandledOpcodes.missingHandlerCount, 0);
});

/**
 * A create block for a creature, carrying update fields.
 *
 * The same shape as `livingCreateBlock` above, but with real values on the end: this is what
 * `Player::UpdateVisibilityOf` sends the moment anything comes into range.
 */
function creatureCreateBlock(guid, entries) {
  const writer = new PacketWriter()
    .u32(1)
    .u8(2) // UPDATETYPE_CREATE_OBJECT
    .packedGuid(guid)
    .u8(3) // TYPEID_UNIT
    .u16(0x0020) // UPDATEFLAG_LIVING
    .u32(0)
    .u16(0)
    .u32(0)
    .f32(0).f32(0).f32(0).f32(0)
    .u32(0); // fall time
  for (let speed = 0; speed < 9; speed++) writer.f32(speed + 1);
  writeUpdateFields(writer, entries);
  return writer.toUint8Array();
}

test("Л1 a creature already dead when it came into view is a body, with no health slot to say so", () => {
  // `Object::BuildValuesUpdate` puts a mask bit in a CREATE block only where the word is non-zero —
  // `updateType == UPDATETYPE_VALUES ? _changesMask.GetBit(index) : m_uint32Values[index]`,
  // `Object.cpp:490` — so a body whose health is zero arrives with **no** UNIT_FIELD_HEALTH at all,
  // and `readValues` writes only the slots the mask named. Comparing a missing slot against zero
  // said «alive», and everything downstream believed it: no bag under the cursor, no dot on the
  // minimap, no «Обыскать» on the target frame, and Tab offering the body ahead of real corpses.
  // It is the state after login, after a teleport, and on walking up to somebody else's camp.
  const guid = 0xf130000000009911n;
  const state = new WorldState();
  state.applyUpdate(creatureCreateBlock(guid, [
    [UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, 299],
    [UPDATE_FIELDS.UNIT_FIELD_MAXHEALTH.offset, 4200],
    // 0x21 — DEAD | LOOTABLE, which is what a body the player may loot carries.
    [UPDATE_FIELDS.UNIT_DYNAMIC_FLAGS.offset, 0x21],
  ]));
  const body = state.objects.get(guid);
  assert.equal(body.fields.has(UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset), false,
    "the block has to be the shape the core actually writes, or this test proves nothing");
  assert.equal(isWorldObjectDead(body), true);

  // DEAD on its own is enough: the loot may already have been taken by whoever killed it.
  const emptied = new WorldState();
  emptied.applyUpdate(creatureCreateBlock(0xf130000000009912n, [
    [UPDATE_FIELDS.UNIT_FIELD_MAXHEALTH.offset, 4200],
    [UPDATE_FIELDS.UNIT_DYNAMIC_FLAGS.offset, 0x20],
  ]));
  assert.equal(isWorldObjectDead(emptied.objects.get(0xf130000000009912n)), true);

  // And a creature standing there alive is not talked into being a corpse by a missing slot: its
  // health is non-zero, so the CREATE block carries it and the flags are never consulted.
  const alive = new WorldState();
  alive.applyUpdate(creatureCreateBlock(0xf130000000009913n, [
    [UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 4200],
    [UPDATE_FIELDS.UNIT_FIELD_MAXHEALTH.offset, 4200],
    [UPDATE_FIELDS.UNIT_DYNAMIC_FLAGS.offset, 0x01],
  ]));
  assert.equal(isWorldObjectDead(alive.objects.get(0xf130000000009913n)), false,
    "a health slot that arrived is the answer, whatever the bits say");

  // A unit nothing has been said about at all is alive, which is the safe default: a body arrives
  // with the flags on it, and nothing else does.
  const silent = new WorldState();
  silent.applyUpdate(creatureCreateBlock(0xf130000000009914n, [
    [UPDATE_FIELDS.UNIT_FIELD_MAXHEALTH.offset, 4200],
  ]));
  assert.equal(isWorldObjectDead(silent.objects.get(0xf130000000009914n)), false);
});

test("П1 the three mount packets are announced instead of being parsed and dropped", async () => {
  // All three were read to the last byte and the result thrown on the floor. None of them is the
  // cause of anything — dismounting arrives a second time as MOUNTDISPLAYID going to zero — but
  // they are the only *moments* in the whole of mounting: the field is a level and these are edges,
  // and the mount-special animation has no field behind it at all.
  const guid = 0x1234n;
  const rider = 0x9abcn;
  const login = new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(0).toUint8Array();
  const connection = {
    sent: [],
    packets: [
      { opcode: OPCODES.SMSG_LOGIN_VERIFY_WORLD, payload: login },
      // `Unit::Dismount` (`Unit.cpp:8759-8761`) packs the guid; `HandleMountSpecialAnimOpcode`
      // (`MovementHandler.cpp:603-609`) writes a full one. Both broadcast to everyone in sight,
      // so both may name somebody other than this player.
      { opcode: OPCODES.SMSG_DISMOUNT, payload: new PacketWriter().packedGuid(rider).toUint8Array() },
      { opcode: OPCODES.SMSG_MOUNTSPECIAL_ANIM, payload: new PacketWriter().u64(rider).toUint8Array() },
      // 8 is `MountResult::Shapeshifted` (`SharedDefines.h:3813-3826`). Success is 10 and is never
      // sent — `Spell::SendMountResult` (`Spell.cpp:4391-4394`) returns before writing on `Ok` —
      // so zero here would be `InvalidMountee`, not «fine».
      { opcode: OPCODES.SMSG_MOUNT_RESULT, payload: new PacketWriter().i32(8).toUint8Array() },
    ],
    send(opcode, payload = new Uint8Array()) { this.sent.push({ opcode, payload }); },
    read() { return this.packets.length ? Promise.resolve(this.packets.shift()) : new Promise(() => {}); },
    close() {},
  };
  const client = new WorldClient(connection);
  const seen = [];
  client.events.on("UNIT_DISMOUNTED", (event) => seen.push(["dismounted", event.guid]));
  client.events.on("MOUNT_SPECIAL", (event) => seen.push(["special", event.guid]));
  client.events.on("MOUNT_RESULT", (event) => seen.push(["result", event.result]));
  await client.loginCharacter(guid);
  for (let round = 0; round < 6; round++) await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(seen, [["dismounted", rider], ["special", rider], ["result", 8]]);
  // And still routed, so none of the three lands in the unhandled ledger.
  assert.equal(client.unhandledOpcodes.missingHandlerCount, 0);
  client.close();
});

test("text-emote audio edge is distinct from the animation-only SMSG_EMOTE edge", async () => {
  const guid = 0x1234n;
  const login = new PacketWriter().u32(1).f32(1).f32(2).f32(3).f32(0).toUint8Array();
  const connection = {
    sent: [],
    packets: [
      { opcode: OPCODES.SMSG_LOGIN_VERIFY_WORLD, payload: login },
      { opcode: OPCODES.SMSG_EMOTE, payload: new PacketWriter().u32(3).u64(guid).toUint8Array() },
      { opcode: OPCODES.SMSG_TEXT_EMOTE, payload: new PacketWriter()
        .u64(guid).u32(101).u32(0).u32(0).toUint8Array() },
    ],
    send(opcode, payload = new Uint8Array()) { this.sent.push({ opcode, payload }); },
    read() { return this.packets.length ? Promise.resolve(this.packets.shift()) : new Promise(() => {}); },
    close() {},
  };
  const client = new WorldClient(connection);
  const textEvents = [];
  const animationEvents = [];
  client.events.on("TEXT_EMOTE", (event) => textEvents.push(event));
  client.onEmote = (source, emoteId) => animationEvents.push({ source, emoteId });
  await client.loginCharacter(guid);
  for (let round = 0; round < 6; round++) await new Promise((resolve) => setImmediate(resolve));

  assert.equal(textEvents.length, 1, "only SMSG_TEXT_EMOTE produces the audio-bearing event");
  assert.deepEqual(textEvents[0], { guid, textEmoteId: 101, emoteNumber: 0, targetName: "" });
  assert.deepEqual(animationEvents, [{ source: guid, emoteId: 3 }],
    "SMSG_EMOTE remains a separate animation callback and cannot double-play sound");
  client.close();
});

test("SMSG_CANCEL_AUTO_REPEAT consumes a packed guid, restores sheath, and does not echo cancel", async () => {
  const guid = 3n;
  const login = new PacketWriter().u32(1).f32(1).f32(2).f32(3).f32(0).toUint8Array();
  const connection = {
    sent: [],
    packets: [
      { opcode: OPCODES.SMSG_LOGIN_VERIFY_WORLD, payload: login },
      // Captured live body: packed-guid mask 0x01 followed by guid byte 0x03.
      { opcode: OPCODES.SMSG_CANCEL_AUTO_REPEAT, payload: Uint8Array.of(0x01, 0x03) },
    ],
    send(opcode, payload = new Uint8Array()) { this.sent.push({ opcode, payload }); },
    read() { return this.packets.length ? Promise.resolve(this.packets.shift()) : new Promise(() => {}); },
    close() {},
  };
  const client = new WorldClient(connection);
  const stopped = [];
  const errors = [];
  client.attacking = true;
  client.autoRepeatSpellId = 75;
  client.state.selfGuid = guid;
  client.events.on("STOP_AUTOREPEAT_SPELL", (event) => stopped.push(event.guid));
  client.onPacketError = (opcode, error) => errors.push([opcode, error.message]);

  await client.loginCharacter(guid);
  for (let round = 0; round < 4; round++) await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(stopped, [guid]);
  assert.equal(client.attacking, true, "a defensive inconsistent-state recovery does not stop melee");
  assert.equal(client.autoRepeatSpellId, undefined);
  assert.equal(connection.sent.some(({ opcode }) => opcode === OPCODES.CMSG_CANCEL_AUTO_REPEAT_SPELL), false,
    "the server already performed the cancellation");
  assert.deepEqual(connection.sent.filter(({ opcode }) => opcode === OPCODES.CMSG_SET_SHEATHED).at(-1)?.payload,
    buildSetSheathed(SHEATH_MELEE));
  assert.deepEqual(errors, []);
  assert.equal(client.unhandledOpcodes.entries.has(OPCODES.SMSG_CANCEL_AUTO_REPEAT), false);
  client.close();
});
