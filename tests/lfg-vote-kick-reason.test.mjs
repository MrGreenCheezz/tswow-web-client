import assert from "node:assert/strict";
import test from "node:test";

/**
 * The open question from the 5.25 review, settled in Wow.exe 3.3.5a 12340
 * (`.runtime/re-2026-10-02/a6-208/`, d1–d2):
 * * UninviteUnit 0x51a7a0's early branch — 0xd4139c set, 0xbd078c set and its +0x1250 word clear →
 *   0x513530(0, 1) — is the protected-call guard, not the dungeon finder's vote-kick. 0xd4139c is the
 *   Lua taint source, GameUI+0x1250 the "hardware event" word (0x5191c0 clears it; SetCurrentTitle
 *   0x522e30 and 0x51d960 run the same test), and 0x513530 fires ADDON_ACTION_BLOCKED (0x1ac) or
 *   MACRO_ACTION_BLOCKED (0x1ab). This client models no taint (FrameXmlSecureCalls.ts), so there is
 *   nothing to block.
 * * In a dungeon-finder group the client sends the same CMSG_GROUP_UNINVITE_GUID (0x6d43c0: opcode
 *   0x76, guid, reason) — no client-side branch. The core turns the kick into a vote
 *   (Player::CanUninviteFromGroup, Player.cpp:24760-24788; LFGScripts.cpp:190-197 InitBoot).
 * * VOTE_KICK_REASON_NEEDED (event 0x29a) is fired by the SMSG_PARTY_COMMAND_RESULT handler
 *   (0x6cbec0, result 0x1b = ERR_VOTE_KICK_REASON_NEEDED) with the packet's name; LFDFrame.lua shows
 *   VOTE_BOOT_REASON_REQUIRED, whose OK is UninviteUnit(name, reason).
 */

const { WorldClient } = await import("../dist/code/world/WorldClient.js");
const { PacketWriter } = await import("../dist/code/protocol/PacketWriter.js");
const { OPCODES } = await import("../dist/code/generated/opcodes.js");
const { ERR_VOTE_KICK_REASON_NEEDED, buildGroupUninvite } = await import("../dist/code/world/GroupProtocol.js");
const { createCannedFrameXmlLfd, FRAMEXML_CANNED_LFD_PLAYER_GUID } = await import("../dist/code/browser/framexml/FrameXmlLfdCanned.js");

const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(setImmediate); };

function connection() {
  const queue = [];
  let wake;
  return {
    sent: [], send(opcode, payload) { this.sent.push({ opcode, payload }); }, close() {},
    read() { return queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve) => { wake = resolve; }); },
    push(opcode, payload) {
      const packet = { opcode, payload };
      if (wake) { const callback = wake; wake = undefined; callback(packet); } else queue.push(packet);
    },
  };
}

const partyResult = (result, name) => new PacketWriter().u32(5).cString(name).u32(result).u32(0).toUint8Array();

test("party result 27 is the vote-kick reason request, with the name the packet carries", async () => {
  assert.equal(ERR_VOTE_KICK_REASON_NEEDED, 27);
  const transport = connection();
  const client = new WorldClient(transport);
  transport.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD, new PacketWriter().u32(0).f32(0).f32(0).f32(0).f32(0).toUint8Array());
  await client.loginCharacter(1n);
  const events = [];
  client.events.on("LFG_STATE_CHANGED", (change) => events.push(change));
  try {
    // 22, a vote already running: a plain refusal, not a request for a reason.
    transport.push(OPCODES.SMSG_PARTY_COMMAND_RESULT, partyResult(22, ""));
    transport.push(OPCODES.SMSG_PARTY_COMMAND_RESULT, partyResult(27, "Бот-танк"));
    await settle();
    assert.deepEqual(events, [{ kind: "voteKickReasonNeeded", name: "Бот-танк" }]);
  } finally {
    client.close();
  }
});

test("the stock LFD frames hear VOTE_KICK_REASON_NEEDED only while they own the prompts", () => {
  const { model, world } = createCannedFrameXmlLfd({
    playerLevel: () => 80, playerClassId: () => 1, playerName: () => "Игрок",
    playerGuid: () => FRAMEXML_CANNED_LFD_PLAYER_GUID, playerFaction: () => "Horde",
    partyMemberCount: () => 4, raidMemberCount: () => 0, isPartyLeader: () => false,
  });
  const fired = [];
  model.attach({ fire(event, ...args) { fired.push([event, ...args]); return 1; }, now: () => 0 });
  world.emit({ kind: "voteKickReasonNeeded", name: "Бот-танк" });
  assert.deepEqual(fired, [], "the native prompts own it until stock is published");
  model.popupsOwned = true;
  fired.length = 0;
  world.emit({ kind: "voteKickReasonNeeded", name: "Бот-танк" });
  assert.deepEqual(fired, [["VOTE_KICK_REASON_NEEDED", "Бот-танк"]]);
  model.detach();
});

test("UninviteUnit in a dungeon-finder group still sends CMSG_GROUP_UNINVITE_GUID: the vote is the core's", async () => {
  const { installFrameXmlChatApi } = await import("../dist/code/browser/framexml/FrameXmlChatApi.js");
  const globals = new Map();
  const removed = [];
  const world = {
    // A dungeon-finder party of bots; nothing the client checks before sending.
    group: { members: [{ name: "Бот-танк", guid: 0x77n }] },
    lfgStatus: { party: true },
    removeFromGroup: (guid, reason) => removed.push([guid, reason]),
  };
  installFrameXmlChatApi({ registerGlobal: (name, binding) => globals.set(name, binding), execute: () => ({ ok: true }) },
    { world: () => world, notice() {}, cast() {}, use() {}, unitGuid: () => undefined });
  // UnitPopup's VOTE_TO_KICK (UnitPopup.lua:1215-1216) passes no reason; the reason popup's OK does.
  globals.get("UninviteUnit")(["Бот-танк"]);
  globals.get("UninviteUnit")(["Бот-танк", "АФК"]);
  assert.deepEqual(removed, [[0x77n, ""], [0x77n, "АФК"]]);
  // HandleGroupUninviteGuidOpcode (GroupHandler.cpp:291-294): a full u64 and the reason string.
  assert.deepEqual([...buildGroupUninvite(0x77n, "")], [0x77, 0, 0, 0, 0, 0, 0, 0, 0]);
});
