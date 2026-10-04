import assert from "node:assert/strict";
import test from "node:test";
import { installFakeUiDocument } from "./fixtures/fake-ui-document.mjs";

// 11.02-B: a seat by click. `CMSG_SPELLCLICK` is a full u64 (SpellHandler.cpp:589-603), and
// `CMSG_PLAYER_VEHICLE_ENTER` a full u64 for another player's vehicle (VehicleHandler.cpp:130-148).
// Wow.exe's unit interaction (0x006ddbb0) tries every NPC service first — gossip, a quest giver with
// something to show (0x006d1de0: status above 1), flight master, vendor, trainer, spirit healer and
// guide, innkeeper, banker, petitioner, tabard designer, battlemaster, auctioneer, stable master,
// guild banker — then spell click (0x0071c570: `UNIT_NPC_FLAG_SPELLCLICK`, no
// `UNIT_FLAG2_PREVENT_SPELL_CLICK`, sent by 0x006d2740), then a player's vehicle (0x00723050, sent
// by 0x006d27c0), then the mailbox.

installFakeUiDocument();
globalThis.MutationObserver = class { observe() {} disconnect() {} };

const { OPCODES } = await import("../dist/code/generated/opcodes.js");
const { PacketReader, PacketWriter } = await import("../dist/code/protocol/index.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { WorldClient } = await import("../dist/code/world/WorldClient.js");
const { buildSpellClick, buildPlayerVehicleEnter } = await import("../dist/code/world/VehicleProtocol.js");
const { vehicleClickOf, SPELL_CLICK_REPEAT_MS } = await import("../dist/code/world/VehicleClick.js");
const { game } = await import("../dist/code/browser/game/Context.js");
const npc = await import("../dist/code/browser/ui/Npc.js");

const NPC_FLAGS = UPDATE_FIELDS.UNIT_NPC_FLAGS.offset;
const FLAGS_2 = UPDATE_FIELDS.UNIT_FIELD_FLAGS_2.offset;
const SELF = 0x1n;
const CAR = 0xf150_7d9a_0000_0042n;
const FRIEND = 0x7n;

const GOSSIP = 0x1;
const QUESTGIVER = 0x2;
const SPELLCLICK = 0x01000000;
const PLAYER_VEHICLE = 0x02000000;
const MAILBOX = 0x04000000;
const PREVENT_SPELL_CLICK = 0x2000;

const creature = (guid, npcFlags, flags2 = 0) => ({
  guid, typeId: 3, position: { x: 2, y: 0, z: 0, orientation: 0 },
  fields: new Map([[NPC_FLAGS, npcFlags], [FLAGS_2, flags2]]),
});
const player = (guid, npcFlags, transport) => ({
  guid, typeId: 4, position: { x: 2, y: 0, z: 0, orientation: 0 }, transport,
  fields: new Map([[NPC_FLAGS, npcFlags]]),
});
const view = ({ quest, group = [], seat } = {}) => ({
  selfGuid: SELF,
  selfSeatGuid: seat,
  questGiverStatus: (guid) => quest?.get(guid),
  inGroup: (guid) => group.includes(guid),
});

test("11.02-B: CMSG_SPELLCLICK is opcode 0x3F8 and a whole eight-byte guid", () => {
  assert.equal(OPCODES.CMSG_SPELLCLICK, 0x3f8);
  const body = new PacketReader(buildSpellClick(CAR));
  assert.equal(body.u64(), CAR);
  body.assertFinished();
  assert.equal(OPCODES.CMSG_PLAYER_VEHICLE_ENTER, 0x4a8);
  const enter = new PacketReader(buildPlayerVehicleEnter(FRIEND));
  assert.equal(enter.u64(), FRIEND);
  enter.assertFinished();
});

test("11.02-B: spell click comes after every NPC service, as Wow.exe 0x006ddbb0 orders it", () => {
  assert.equal(vehicleClickOf(creature(CAR, SPELLCLICK), view()), "spellclick");
  assert.equal(vehicleClickOf(creature(CAR, SPELLCLICK | GOSSIP), view()), undefined, "gossip is asked first");
  for (const service of [0x10, 0x80, 0x2000, 0x4000, 0x8000, 0x10000, 0x20000, 0x40000, 0x80000, 0x100000,
    0x200000, 0x400000, 0x800000]) {
    assert.equal(vehicleClickOf(creature(CAR, SPELLCLICK | service), view()), undefined, `service 0x${service.toString(16)}`);
  }
  // 0x006d1de0: the quest branch needs a status with something in it (above DIALOG_STATUS_UNAVAILABLE).
  assert.equal(vehicleClickOf(creature(CAR, SPELLCLICK | QUESTGIVER), view()), "spellclick");
  assert.equal(vehicleClickOf(creature(CAR, SPELLCLICK | QUESTGIVER), view({ quest: new Map([[CAR, 1]]) })), "spellclick");
  assert.equal(vehicleClickOf(creature(CAR, SPELLCLICK | QUESTGIVER), view({ quest: new Map([[CAR, 8]]) })), undefined);
  // The mailbox is asked after spell click.
  assert.equal(vehicleClickOf(creature(CAR, SPELLCLICK | MAILBOX), view()), "spellclick");
  assert.equal(vehicleClickOf(creature(CAR, SPELLCLICK, PREVENT_SPELL_CLICK), view()), undefined,
    "UNIT_FLAG2_PREVENT_SPELL_CLICK (0x0071c570)");
  assert.equal(vehicleClickOf(creature(CAR, 0), view()), undefined);
});

test("11.02-B: another player's vehicle — flagged, in the group, not already ridden", () => {
  assert.equal(vehicleClickOf(player(FRIEND, PLAYER_VEHICLE), view({ group: [FRIEND] })), "player-vehicle");
  assert.equal(vehicleClickOf(player(FRIEND, PLAYER_VEHICLE), view()), undefined, "outside the group (0x00723050)");
  assert.equal(vehicleClickOf(player(FRIEND, PLAYER_VEHICLE), view({ group: [FRIEND], seat: FRIEND })), undefined,
    "already seated on it");
  assert.equal(vehicleClickOf(player(FRIEND, 0), view({ group: [FRIEND] })), undefined);
  assert.equal(vehicleClickOf(player(FRIEND, SPELLCLICK), view({ group: [FRIEND] })), undefined,
    "a player is never spell-clicked: the core finds only creatures (ObjectAccessor::GetCreatureOrPetOrVehicle)");
  assert.equal(vehicleClickOf(creature(CAR, PLAYER_VEHICLE), view({ group: [CAR] })), undefined, "a creature is no player vehicle");
});

/** A WorldClient over a fake connection, logged in as SELF. */
async function clickClient() {
  const login = new PacketWriter().u32(0).f32(0).f32(0).f32(0).f32(0).toUint8Array();
  const connection = {
    packets: [{ opcode: OPCODES.SMSG_LOGIN_VERIFY_WORLD, payload: login }],
    sent: [],
    send(opcode, payload = new Uint8Array()) { this.sent.push({ opcode, payload }); },
    read() { return this.packets.length ? Promise.resolve(this.packets.shift()) : new Promise(() => {}); },
    close() {},
  };
  const client = new WorldClient(connection);
  client.state.selfGuid = SELF;
  client.state.move(SELF, { flags: 0, position: { x: 0, y: 0, z: 0, orientation: 0 } });
  await client.loginCharacter(SELF);
  await new Promise((resolve) => setImmediate(resolve));
  connection.sent.length = 0;
  return { client, connection };
}
const sentOf = (connection, opcode) => connection.sent.filter((packet) => packet.opcode === opcode);

test("11.02-B: one click per guid a second — a double click is one spell click", async () => {
  const { client, connection } = await clickClient();
  client.spellClick(CAR, 1000);
  client.spellClick(CAR, 1000 + SPELL_CLICK_REPEAT_MS - 1);
  assert.equal(sentOf(connection, OPCODES.CMSG_SPELLCLICK).length, 1);
  client.spellClick(0xf150_7d9a_0000_0043n, 1500);
  assert.equal(sentOf(connection, OPCODES.CMSG_SPELLCLICK).length, 2, "another vehicle is its own click");
  client.spellClick(CAR, 1000 + SPELL_CLICK_REPEAT_MS);
  const clicks = sentOf(connection, OPCODES.CMSG_SPELLCLICK);
  assert.equal(clicks.length, 3, "after the second has passed the same vehicle may be asked again");
  assert.equal(new PacketReader(clicks[2].payload).u64(), CAR);
  client.spellClick(0n, 9000);
  assert.equal(sentOf(connection, OPCODES.CMSG_SPELLCLICK).length, 3, "never for nobody");
  client.close();
});

test("11.02-B: a right click on a vehicle seats through interactWithGuid, services keep their order", async () => {
  const { client, connection } = await clickClient();
  const gossip = [];
  const mail = [];
  client.openGossip = (guid) => { gossip.push(guid); };
  client.openMailbox = (guid) => { mail.push(guid); };
  game.world = client;
  try {
    client.state.objects.set(CAR, creature(CAR, SPELLCLICK));
    npc.interactWithGuid(CAR);
    assert.equal(sentOf(connection, OPCODES.CMSG_SPELLCLICK).length, 1);
    assert.equal(new PacketReader(sentOf(connection, OPCODES.CMSG_SPELLCLICK)[0].payload).u64(), CAR);

    const talker = 0xf130_0000_0000_0050n;
    client.state.objects.set(talker, creature(talker, SPELLCLICK | GOSSIP));
    npc.interactWithGuid(talker);
    assert.deepEqual(gossip, [talker], "gossip first");
    assert.equal(sentOf(connection, OPCODES.CMSG_SPELLCLICK).length, 1, "and no spell click with it");

    const box = 0xf130_0000_0000_0051n;
    client.state.objects.set(box, creature(box, SPELLCLICK | MAILBOX));
    npc.interactWithGuid(box);
    assert.equal(sentOf(connection, OPCODES.CMSG_SPELLCLICK).length, 2, "spell click before the mailbox");
    assert.deepEqual(mail, []);

    client.state.objects.set(FRIEND, player(FRIEND, PLAYER_VEHICLE));
    client.group = { members: [{ guid: FRIEND }] };
    npc.interactWithGuid(FRIEND);
    const enter = sentOf(connection, OPCODES.CMSG_PLAYER_VEHICLE_ENTER);
    assert.equal(enter.length, 1);
    assert.equal(new PacketReader(enter[0].payload).u64(), FRIEND);
  } finally {
    npc.closeNpcServiceWindow(); // the gossip click armed the NPC wait timer
    game.world = undefined;
    client.close();
  }
});

// 11.02-BCD review. Wow.exe 0x006d1de0 answers the quest branch for a cached status that is neither
// 0 nor 1 (the status sits at +0x90 of the unit, the value SMSG_QUESTGIVER_STATUS carries), so every
// status from DIALOG_STATUS_LOW_LEVEL_AVAILABLE (2, QuestDef.h:121) up keeps the quest window.
test("11.02-BCD review: every quest status above 1 keeps the quest branch, 0 and 1 do not", () => {
  for (const status of [2, 5, 10]) {
    assert.equal(vehicleClickOf(creature(CAR, SPELLCLICK | QUESTGIVER), view({ quest: new Map([[CAR, status]]) })), undefined,
      `status ${status}`);
  }
  assert.equal(vehicleClickOf(creature(CAR, SPELLCLICK | QUESTGIVER), view({ quest: new Map([[CAR, 0]]) })), "spellclick");
});

test("11.02-BCD review: the click reads the live world — the group, the character's seat, the cached quest status", async () => {
  const { client, connection } = await clickClient();
  const quests = [];
  client.openQuestList = (guid) => { quests.push(guid); };
  game.world = client;
  try {
    client.state.objects.set(FRIEND, player(FRIEND, PLAYER_VEHICLE));
    client.group = { members: [] };
    npc.interactWithGuid(FRIEND);
    assert.equal(sentOf(connection, OPCODES.CMSG_PLAYER_VEHICLE_ENTER).length, 0, "not in the group (0x0052c8c0 / 0x00573200)");
    client.group = { members: [{ guid: FRIEND }] };
    client.state.objects.get(SELF).transport = { guid: FRIEND, x: 0, y: 0, z: 1, orientation: 0, seat: 1 };
    npc.interactWithGuid(FRIEND);
    assert.equal(sentOf(connection, OPCODES.CMSG_PLAYER_VEHICLE_ENTER).length, 0, "already riding it (0x00723050)");
    client.state.objects.get(SELF).transport = undefined;
    npc.interactWithGuid(FRIEND);
    assert.equal(sentOf(connection, OPCODES.CMSG_PLAYER_VEHICLE_ENTER).length, 1);

    const giver = 0xf130_0000_0000_0060n;
    client.state.objects.set(giver, creature(giver, SPELLCLICK | QUESTGIVER));
    client.questGiverStatus.set(giver, 2);
    npc.interactWithGuid(giver);
    assert.deepEqual(quests, [giver], "a quest to show: the quest window, as before");
    assert.equal(sentOf(connection, OPCODES.CMSG_SPELLCLICK).length, 0);
    client.questGiverStatus.set(giver, 1);
    npc.interactWithGuid(giver);
    assert.deepEqual(quests, [giver]);
    assert.equal(sentOf(connection, OPCODES.CMSG_SPELLCLICK).length, 1, "nothing to show: the seat");
  } finally {
    npc.closeNpcServiceWindow(); // the quest click armed the NPC wait timer
    game.world = undefined;
    client.close();
  }
});

// The hook sits after the corpse and attack branches of `interactWithGuid`: a body is still looted and
// a hostile unit still fought (Wow.exe 0x00731260: a dead unit takes the loot branch; 0x00729530 sends
// a unit to 0x006ddbb0 only with NPC flags and both reactions neutral or better), while a neutral unit
// whose one flag is spell click is clicked into rather than fought (5.05: a neutral unit with a flag
// is not attacked).
test("11.02-BCD review: a dead vehicle is looted, a hostile one fought, a neutral one clicked into", async () => {
  const { client, connection } = await clickClient();
  const attacks = [];
  const loots = [];
  client.startAttack = () => { attacks.push(client.targetGuid); };
  client.openLoot = (guid) => { loots.push(guid); };
  const previousFactions = game.factions;
  // Template 2 hostile, 3 neutral, 4 friendly to template 1 (as input-right-click-targeting).
  game.factions = { ready: true, reaction: (_mine, theirs) => (theirs === 2 ? -1 : theirs === 4 ? 1 : 0), factionOf: (t) => t * 10 };
  game.world = client;
  const HEALTH = UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset;
  const FACTION = UPDATE_FIELDS.UNIT_FIELD_FACTIONTEMPLATE.offset;
  const self = client.state.objects.get(SELF);
  self.typeId = 4;
  for (const [field, value] of [[HEALTH, 100], [FACTION, 1], [UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset, 0x8]]) self.fields.set(field, value);
  const unit = (guid, template, health) => {
    const object = creature(guid, SPELLCLICK);
    object.fields.set(HEALTH, health);
    object.fields.set(FACTION, template);
    return object;
  };
  try {
    const hostile = 0xf130_0000_0000_0070n;
    client.state.objects.set(hostile, unit(hostile, 2, 100));
    npc.interactWithGuid(hostile);
    assert.deepEqual(attacks, [hostile]);
    const body = 0xf130_0000_0000_0071n;
    client.state.objects.set(body, unit(body, 4, 0));
    npc.interactWithGuid(body);
    assert.deepEqual(loots, [body]);
    assert.equal(sentOf(connection, OPCODES.CMSG_SPELLCLICK).length, 0);
    const neutral = 0xf130_0000_0000_0072n;
    client.state.objects.set(neutral, unit(neutral, 3, 100));
    npc.interactWithGuid(neutral);
    assert.deepEqual(attacks, [hostile], "a neutral vehicle is not fought");
    assert.equal(new PacketReader(sentOf(connection, OPCODES.CMSG_SPELLCLICK)[0].payload).u64(), neutral);
  } finally {
    game.factions = previousFactions;
    game.world = undefined;
    client.close();
  }
});
