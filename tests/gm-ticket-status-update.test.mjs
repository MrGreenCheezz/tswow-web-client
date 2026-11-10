import assert from "node:assert/strict";
import test from "node:test";

// Plan item 3.24 (11.11): SMSG_GM_TICKET_STATUS_UPDATE (0x328) as Wow.exe 0x005ad240 reads it (jump table 0x005ad5ec,
// .runtime/re-2026-11-11/pvpui/r2.lst): one u32 — 1 and 4 send CMSG_GMTICKET_GETTICKET, 2 forgets the ticket and
// the GM response and raises UPDATE_TICKET(), 3 does the same with GMSURVEY_DISPLAY (out of the plan: UPDATE_TICKET()),
// anything else nothing. TrinityCore never sends it (STATUS_NEVER).
const { WorldClient } = await import("../dist/code/world/WorldClient.js");
const { OPCODES } = await import("../dist/code/generated/opcodes.js");
const { PacketWriter } = await import("../dist/code/protocol/PacketWriter.js");
const { parseGmTicketStatusUpdate } = await import("../dist/code/world/TicketProtocol.js");
const { FrameXmlHelpModel } = await import("../dist/code/browser/framexml/FrameXmlHelp.js");

function connection() {
  const queue = []; let wake;
  return {
    sent: [], send(opcode, payload) { this.sent.push({ opcode, payload }); }, close() {},
    read() { return queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve) => { wake = resolve; }); },
    push(opcode, payload) { const packet = { opcode, payload }; if (wake) { const done = wake; wake = undefined; done(packet); } else queue.push(packet); },
  };
}
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(setImmediate); };
const word = (value) => new PacketWriter().u32(value).toUint8Array();
const ticket = () => new PacketWriter().u32(6).u32(42).cString("Помогите").u8(0).f32(0).f32(0).f32(0).u8(0).u8(0).toUint8Array();
const response = () => {
  const writer = new PacketWriter().u32(1).u32(42).cString("Помогите").cString("Ответ ГМ");
  for (let chunk = 1; chunk < 4; chunk++) writer.cString("");
  return writer.toUint8Array();
};

test("the parser: the four statuses and the rest", () => {
  assert.deepEqual([1, 2, 3, 4, 0, 5].map((value) => parseGmTicketStatusUpdate(word(value))),
    ["refresh", "closed", "survey", "refresh", "none", "none"]);
});

test("WorldClient and the help frame: 1/4 ask the ticket, 2/3 forget it with UPDATE_TICKET(), 5 nothing", async () => {
  const transport = connection();
  const world = new WorldClient(transport);
  transport.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD, new PacketWriter().u32(1).f32(10).f32(20).f32(30).f32(0).toUint8Array());
  await world.loginCharacter(1n);
  const fired = [];
  const help = new FrameXmlHelpModel({ world: () => world, uiError: (key) => fired.push(["error", key]) });
  help.attach({ fire: (event, ...args) => { fired.push([event, ...args]); return 1; } });
  try {
    const asks = () => transport.sent.filter((packet) => packet.opcode === OPCODES.CMSG_GMTICKET_GETTICKET).length;
    for (const status of [1, 4]) {
      const before = asks();
      transport.push(OPCODES.SMSG_GM_TICKET_STATUS_UPDATE, word(status));
      await settle();
      assert.equal(asks(), before + 1, `status ${status} asks the ticket`);
    }
    for (const status of [2, 3]) {
      transport.push(OPCODES.SMSG_GMTICKET_GETTICKET, ticket());
      transport.push(OPCODES.SMSG_GMRESPONSE_RECEIVED, response());
      await settle();
      assert.equal(world.gmTicket?.ticketId, 42);
      assert.equal(world.gmResponse?.response, "Ответ ГМ");
      fired.length = 0;
      transport.push(OPCODES.SMSG_GM_TICKET_STATUS_UPDATE, word(status));
      await settle();
      assert.equal(world.gmTicket, undefined, `status ${status} forgets the ticket`);
      assert.equal(world.gmResponse, undefined, `status ${status} forgets the response`);
      assert.equal(world.ticketSurveyPending, status === 3);
      assert.deepEqual(fired, [["UPDATE_TICKET"]]);
    }
    transport.push(OPCODES.SMSG_GMTICKET_GETTICKET, ticket());
    await settle();
    fired.length = 0;
    const before = asks();
    transport.push(OPCODES.SMSG_GM_TICKET_STATUS_UPDATE, word(5));
    await settle();
    assert.equal(world.gmTicket?.ticketId, 42, "another value changes nothing");
    assert.equal(asks(), before);
    assert.deepEqual(fired, []);
  } finally {
    help.detach();
    world.close();
  }
});
