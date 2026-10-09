import assert from "node:assert/strict";
import test from "node:test";
import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import { buildComplainMail, buildReportLag } from "../dist/code/world/TicketProtocol.js";
import { FrameXmlMailModel, FRAMEXML_MAIL_BINDINGS } from "../dist/code/browser/framexml/FrameXmlMail.js";
import { FrameXmlSupportModel, FRAMEXML_SUPPORT_BINDINGS } from "../dist/code/browser/framexml/FrameXmlSupport.js";
import { FRAMEXML_MECHANICS_PRELUDE } from "../dist/code/browser/framexml/FrameXmlMechanics.js";

/**
 * WORK_PLAN 5.25 (trade refusal, tutorial flags, the uninvite reason) and 8.17 (lag report, a
 * complaint about a letter), checked against TrinityCore and Wow.exe 3.3.5a
 * (`.runtime/re-2026-10-02/a3-mech/`, d1–d4, d6):
 * * HandleReportLag (TicketHandler.cpp:248) reads `u32 kind, u32 map, 3×f32`; Wow.exe GMReportLag
 *   (0x5ad020 → 0x5acf30) writes the Lua number minus one, STATIC_CONSTANTS (0x00acfac0) Loot = 1
 *   … Spell = 6.
 * * HandleComplainOpcode (MiscHandler.cpp:1190) reads `u8 0, u64, u32, u32 mailId, u32`; Wow.exe
 *   0x56faf0 sends it once per sender (0x6b3750 keeps 32), then CMSG_GET_MAIL_LIST, and fires
 *   CLOSE_INBOX_ITEM; a sender already reported only prints COMPLAINT_ADDED.
 * * TRADE_STATUS 1 (0x5873e0): ignored initiator → CMSG_IGNORE_TRADE; blockTrades → CMSG_BUSY_TRADE
 *   and ERR_TRADE_BLOCKED_S.
 * * FlagTutorial/IsTutorialFlagged (0x530750/0x5307a0): Lua id − 1, below 60; a set bit is not sent.
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
const bytes = (payload) => [...payload];

async function loggedIn() {
  const connection = fakeConnection();
  connection.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD,
    new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(0).toUint8Array());
  const client = new WorldClient(connection);
  await client.loginCharacter(SELF);
  await settle();
  client.state.selfGuid = SELF;
  client.state.move(SELF, { flags: 0, position: { x: 10.5, y: -20.25, z: 3, orientation: 0 } });
  client.state.objects.get(SELF).typeId = 4;
  connection.sent.length = 0;
  const lines = [];
  client.events.on("WORLD_MESSAGE", (message) => lines.push(message.text));
  const sent = (opcode) => connection.sent.filter((packet) => packet.opcode === opcode);
  return { client, connection, lines, sent };
}

// ---- 8.17: lag ---------------------------------------------------------------------------------

test("the lag report: Lua kind − 1, the map and the character's position", async () => {
  assert.deepEqual(bytes(buildReportLag(0, 571, 1, 2, 3)),
    bytes(new PacketWriter().u32(0).u32(571).f32(1).f32(2).f32(3).toUint8Array()));
  const { client, sent } = await loggedIn();
  client.mapId = 530;
  const support = new FrameXmlSupportModel(() => client);
  FRAMEXML_SUPPORT_BINDINGS.GMReportLag({ support }, [3]); // STATIC_CONSTANTS.Mail
  assert.deepEqual(sent(OPCODES.CMSG_GM_REPORT_LAG).map((packet) => bytes(packet.payload)),
    [bytes(new PacketWriter().u32(2).u32(530).f32(10.5).f32(-20.25).f32(3).toUint8Array())]);
  client.close();
});

test("STATIC_CONSTANTS gets the six kinds Wow.exe registers", () => {
  assert.match(FRAMEXML_MECHANICS_PRELUDE, /impl\.RegisterStaticConstants = function\(t\)/);
  assert.match(FRAMEXML_MECHANICS_PRELUDE, /t\.Loot, t\.AuctionHouse, t\.Mail, t\.Chat, t\.Movement, t\.Spell = 1, 2, 3, 4, 5, 6/);
});

// ---- 8.17: complaint about a letter --------------------------------------------------------------

const PLAYER = 0x0000000000000077n;
const letter = (overrides = {}) => ({
  mailId: 41, senderType: 0, senderGuid: PLAYER, altSenderId: 0, cod: 0, packageId: 0, stationeryId: 41,
  money: 0, flags: 0, daysLeft: 30, mailTemplateId: 0, subject: "Купи золото", body: "", attachments: [], ...overrides,
});

function mailModel(client) {
  const fired = [];
  const model = new FrameXmlMailModel({
    world: () => client, item: () => undefined, itemObject: () => undefined, cursorItem: () => undefined, clearCursor() {},
  });
  model.attach({ fire: (event, ...args) => { fired.push([event, ...args]); return 0; }, now: () => 0 });
  return { model, fired };
}

test("the complaint bytes are the core's mail form", () => {
  assert.deepEqual(bytes(buildComplainMail(PLAYER, 41)),
    bytes(new PacketWriter().u8(0).u64(PLAYER).u32(0).u32(41).u32(0).toUint8Array()));
});

test("CanComplainInboxItem: a player's letter only, not a returned one, not GM stationery, not a contact", async () => {
  const { client } = await loggedIn();
  client.mail = { totalCount: 5, mails: [
    letter(), letter({ senderType: 2, senderGuid: 0n }), letter({ flags: 0x02 }), letter({ stationeryId: 61 }),
    letter({ senderGuid: SELF }),
  ] };
  client.mailboxGuid = 0x5n;
  const { model } = mailModel(client);
  const can = (index) => FRAMEXML_MAIL_BINDINGS.CanComplainInboxItem({ mail: model }, [index]);
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(can), [[1], [], [], [], [], []]);
  client.contacts = { flags: 7, contacts: [{ guid: PLAYER, flags: 1, note: "", status: 0, areaId: 0, level: 0, classId: 0 }] };
  assert.deepEqual(can(1), [], "a friend's letter cannot be reported");
  client.close();
});

test("ComplainInboxItem: one complaint per sender, the list asked again, the letter closed", async () => {
  const { client, connection, lines, sent } = await loggedIn();
  client.mail = { totalCount: 2, mails: [letter(), letter({ mailId: 42 })] };
  client.mailboxGuid = 0x5n;
  const { model, fired } = mailModel(client);
  FRAMEXML_MAIL_BINDINGS.ComplainInboxItem({ mail: model }, [1]);
  assert.deepEqual(sent(OPCODES.CMSG_COMPLAIN), [], "the realm has not said complaints are on");
  connection.push(OPCODES.SMSG_FEATURE_SYSTEM_STATUS, new PacketWriter().u8(2).u8(0).toUint8Array());
  await settle();
  FRAMEXML_MAIL_BINDINGS.ComplainInboxItem({ mail: model }, [1]);
  assert.deepEqual(sent(OPCODES.CMSG_COMPLAIN).map((packet) => bytes(packet.payload)), [bytes(buildComplainMail(PLAYER, 41))]);
  assert.equal(sent(OPCODES.CMSG_GET_MAIL_LIST).length, 1);
  assert.deepEqual(fired.filter(([event]) => event === "CLOSE_INBOX_ITEM"), [["CLOSE_INBOX_ITEM", 1]]);
  FRAMEXML_MAIL_BINDINGS.ComplainInboxItem({ mail: model }, [2]);
  assert.equal(sent(OPCODES.CMSG_COMPLAIN).length, 1, "the same sender again: no second complaint");
  assert.deepEqual(lines, ["Жалоба зарегистрирована."]);
  connection.push(OPCODES.SMSG_COMPLAIN_RESULT, new PacketWriter().u8(1).toUint8Array());
  await settle();
  assert.equal(client.featureStatus.complaintStatus, 0, "result 1 turns the complaint system off");
  client.close();
});

// ---- 5.25: tutorials ---------------------------------------------------------------------------

test("FlagTutorial sends id − 1 once; IsTutorialFlagged reads the account's words", async () => {
  const { client, connection, sent } = await loggedIn();
  const support = new FrameXmlSupportModel(() => client);
  const host = { support };
  assert.deepEqual(FRAMEXML_SUPPORT_BINDINGS.IsTutorialFlagged(host, [38]), [], "nil before SMSG_TUTORIAL_FLAGS");
  const words = new PacketWriter();
  for (let word = 0; word < 8; word++) words.u32(word === 1 ? 1 << (36 - 32) : 0);
  connection.push(OPCODES.SMSG_TUTORIAL_FLAGS, words.toUint8Array());
  await settle();
  assert.deepEqual(FRAMEXML_SUPPORT_BINDINGS.IsTutorialFlagged(host, [37]), [1], "bit 36 is tutorial 37");
  assert.deepEqual(FRAMEXML_SUPPORT_BINDINGS.IsTutorialFlagged(host, [38]), []);
  FRAMEXML_SUPPORT_BINDINGS.FlagTutorial(host, [38]);
  FRAMEXML_SUPPORT_BINDINGS.FlagTutorial(host, [38]);
  FRAMEXML_SUPPORT_BINDINGS.FlagTutorial(host, [37]);
  FRAMEXML_SUPPORT_BINDINGS.FlagTutorial(host, [61]);
  assert.deepEqual(sent(OPCODES.CMSG_TUTORIAL_FLAG).map((packet) => bytes(packet.payload)),
    [bytes(new PacketWriter().u32(37).toUint8Array())], "38 once; 37 already seen; 61 out of the Lua range");
  assert.deepEqual(FRAMEXML_SUPPORT_BINDINGS.IsTutorialFlagged(host, [38]), [1]);
  client.close();
});

// ---- 5.25: trade refusal -----------------------------------------------------------------------

const TRADER = 0x0000000000000099n;
const beginTrade = () => new PacketWriter().u32(1).u64(TRADER).toUint8Array();

test("blockTrades answers an offer with CMSG_BUSY_TRADE and ERR_TRADE_BLOCKED_S, and opens nothing", async () => {
  const { client, connection, lines, sent } = await loggedIn();
  client.names.accept({ guid: TRADER, known: true, name: "Торговец", realm: "", race: 1, gender: 0, classId: 1, declined: [] });
  client.blockTrades = () => true;
  connection.push(OPCODES.SMSG_TRADE_STATUS, beginTrade());
  await settle();
  assert.equal(sent(OPCODES.CMSG_BUSY_TRADE).length, 1);
  assert.equal(sent(OPCODES.CMSG_BUSY_TRADE)[0].payload.length, 0, "an empty body");
  assert.equal(client.tradePending, false);
  assert.deepEqual(lines, ["Торговец предлагает вам обмен. Вы отказались."]);
  client.close();
});

test("an offer from an ignored player is answered CMSG_IGNORE_TRADE; an ordinary one waits for the player", async () => {
  const { client, connection, lines, sent } = await loggedIn();
  client.contacts = { flags: 7, contacts: [{ guid: TRADER, flags: 2, note: "", status: 0, areaId: 0, level: 0, classId: 0 }] };
  connection.push(OPCODES.SMSG_TRADE_STATUS, beginTrade());
  await settle();
  assert.equal(sent(OPCODES.CMSG_IGNORE_TRADE).length, 1);
  assert.equal(client.tradePending, false);
  assert.deepEqual(lines, [], "nothing said for the ignored");
  client.contacts = { flags: 7, contacts: [] };
  connection.push(OPCODES.SMSG_TRADE_STATUS, beginTrade());
  await settle();
  assert.equal(client.tradePending, true, "no option, no ignore: the request is shown");
  assert.equal(sent(OPCODES.CMSG_BUSY_TRADE).length + sent(OPCODES.CMSG_IGNORE_TRADE).length, 1);
  client.close();
});

// ---- 5.25: the uninvite reason -----------------------------------------------------------------

test("UninviteUnit sends the member's guid with the reason, cut to 64, as Wow.exe 0x51a7a0 does", async () => {
  const { installFrameXmlChatApi } = await import("../dist/code/browser/framexml/FrameXmlChatApi.js");
  const globals = new Map();
  const removed = [];
  const world = {
    group: { members: [{ name: "Голем", guid: 0x55n }] },
    removeFromGroup: (guid, reason) => removed.push([guid, reason]),
  };
  installFrameXmlChatApi({ registerGlobal: (name, binding) => globals.set(name, binding), execute: () => ({ ok: true }) },
    { world: () => world, notice() {}, cast() {}, use() {}, unitGuid: () => undefined });
  globals.get("UninviteUnit")(["голем", "x".repeat(70)]);
  globals.get("UninviteUnit")(["Голем"]);
  assert.deepEqual(removed, [[0x55n, "x".repeat(64)], [0x55n, ""]]);
});

test("the core's echo of a refused offer (TradeCancel sendback: BUSY) says nothing to the refuser", async () => {
  const { client, connection } = await loggedIn();
  client.blockTrades = () => true;
  const changes = [];
  client.events.on("TRADE_STATE_CHANGED", (change) => changes.push(change));
  connection.push(OPCODES.SMSG_TRADE_STATUS, beginTrade());
  connection.push(OPCODES.SMSG_TRADE_STATUS, new PacketWriter().u32(0).toUint8Array()); // TRADE_STATUS_BUSY
  await settle();
  assert.deepEqual(changes, []);
  assert.equal(client.tradeMessage, undefined);
  client.close();
});
