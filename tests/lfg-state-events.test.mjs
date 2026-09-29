import assert from "node:assert/strict";
import test from "node:test";

// WorldClient keeps `onLfgChanged` for the native window and, beside it, emits typed
// LFG_STATE_CHANGED events a second owner (the stock LFD frames) can subscribe to.
const { WorldClient } = await import("../dist/code/world/WorldClient.js");
const { PacketWriter } = await import("../dist/code/protocol/PacketWriter.js");
const { OPCODES } = await import("../dist/code/generated/opcodes.js");
const { parseLfgUpdate } = await import("../dist/code/world/LfgProtocol.js");

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

async function world() {
  const transport = connection();
  const client = new WorldClient(transport);
  transport.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD, new PacketWriter().u32(0).f32(0).f32(0).f32(0).f32(0).toUint8Array());
  await client.loginCharacter(1n);
  const events = [];
  let native = 0;
  client.onLfgChanged = () => { native += 1; };
  client.events.on("LFG_STATE_CHANGED", (change) => events.push(change));
  return { transport, client, events, native: () => native };
}

test("each dungeon-finder packet keeps the native slot and emits one typed event", async () => {
  const { transport, client, events, native } = await world();
  try {
    // SMSG_LFG_UPDATE_PARTY: joined, queued, three needs bytes, one dungeon.
    transport.push(OPCODES.SMSG_LFG_UPDATE_PARTY, new PacketWriter().u8(6).u8(1).u8(1).u8(1).u8(0).u8(0)
      .u8(0).u8(0).u8(0).u8(1).u32(258 | (6 << 24)).cString("").toUint8Array());
    transport.push(OPCODES.SMSG_LFG_QUEUE_STATUS, new PacketWriter().u32(258 | (6 << 24)).i32(300).i32(240)
      .i32(60).i32(120).i32(600).u8(1).u8(0).u8(2).u32(95).toUint8Array());
    transport.push(OPCODES.SMSG_LFG_JOIN_RESULT, new PacketWriter().u32(5).u32(0).toUint8Array());
    transport.push(OPCODES.SMSG_LFG_ROLE_CHOSEN, new PacketWriter().u64(0x99n).u8(1).u32(0x0c).toUint8Array());
    transport.push(OPCODES.SMSG_LFG_OFFER_CONTINUE, new PacketWriter().u32(40 | (1 << 24)).toUint8Array());
    transport.push(OPCODES.SMSG_LFG_PLAYER_INFO, new PacketWriter().u8(0).u32(0).toUint8Array());
    await settle();
    assert.deepEqual(events.map((event) => event.kind), ["update", "queue", "joinResult", "roleChosen", "offerContinue", "playerInfo"]);
    assert.equal(client.lfgStatus.party, true, "SMSG_LFG_UPDATE_PARTY answers GetLFGInfoServer's inParty");
    assert.deepEqual(events[2], { kind: "joinResult", result: 5, message: "Вы не подходите под выбранные подземелья" });
    assert.deepEqual(events[3], { kind: "roleChosen", guid: 0x99n, roles: 0x0c });
    assert.deepEqual(events[4], { kind: "offerContinue", entry: 40 | (1 << 24) },
      "the event keeps the queue type the stored lfgOfferContinue id drops");
    assert.equal(client.lfgOfferContinue, 40);
    assert.equal(native(), 5, "the native window's single slot still hears the five it always heard");
  } finally {
    client.close();
  }
});

test("a player update carries no party flag, keeping the old parse shape", () => {
  const player = parseLfgUpdate(new Uint8Array([4, 0]), false);
  assert.deepEqual(player, { updateType: 4, joined: false, queued: false, dungeons: [], comment: "" });
  assert.equal(parseLfgUpdate(new Uint8Array([4, 0]), true).party, true);
});
