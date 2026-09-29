import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import { buildPetitionBuy } from "../dist/code/world/PetitionProtocol.js";
import { PacketReader } from "../dist/code/protocol/PacketReader.js";

// M3: buying the charter is the attainable half of arena teams — CREATE is Handle_NULL,
// the charter vendor is not.

function fakeConnection() {
  return {
    sent: [],
    send(opcode, payload = new Uint8Array()) { this.sent.push({ opcode, payload }); },
    read() { return new Promise(() => {}); },
    close() {},
  };
}

test("the buy packet follows the handler's read order, zeros included", () => {
  // PetitionsHandler.cpp:HandlePetitionBuyOpcode: guid, u32, u64, name, string, 7×u32, u16,
  // 3×u32, 10×string, clientIndex, u32.
  const body = buildPetitionBuy(0xabcdn, "Гладиаторы", 2);
  const reader = new PacketReader(body);
  assert.equal(reader.u64(), 0xabcdn);
  assert.equal(reader.u32(), 0);
  assert.equal(reader.u64(), 0n);
  assert.equal(reader.cString(), "Гладиаторы");
  assert.equal(reader.cString(), "");
  for (let index = 0; index < 7; index++) assert.equal(reader.u32(), 0);
  assert.equal(reader.u16(), 0);
  for (let index = 0; index < 3; index++) assert.equal(reader.u32(), 0);
  for (let index = 0; index < 10; index++) assert.equal(reader.cString(), "");
  assert.equal(reader.u32(), 2, "the offer index rides last: 1 guild/2v2, 2 3v3, 3 5v5");
  assert.equal(reader.u32(), 0);
  reader.assertFinished();
});

test("buyPetition reaches the wire for a named offer and nothing else", () => {
  const connection = fakeConnection();
  const world = new WorldClient(connection);
  world.buyPetition(0xabcdn, "Гладиаторы", 2);
  assert.equal(connection.sent.length, 1);
  assert.equal(connection.sent[0].opcode, OPCODES.CMSG_PETITION_BUY);
  world.buyPetition(0n, "Гладиаторы", 2);
  world.buyPetition(0xabcdn, "", 2);
  world.buyPetition(0xabcdn, "Гладиаторы", 1.5);
  assert.equal(connection.sent.length, 1, "guidless, nameless and non-integer offers stay silent");
  world.close();
  world.buyPetition(0xabcdn, "Гладиаторы", 2);
  assert.equal(connection.sent.length, 1, "a closed client stays silent");
});

test("the petitioner opens the vendor and the window sells its offers", async () => {
  const [npc, petition] = await Promise.all([
    readFile(new URL("../src/browser/ui/Npc.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/browser/ui/Petition.ts", import.meta.url), "utf8"),
  ]);
  assert.match(npc, /NPC_FLAG_PETITIONER = 0x40000/, "the flag the core documents for petitioners");
  assert.match(npc, /requestPetitionVendor\(guid\)/, "a petitioner click asks for the offer list");
  assert.match(petition, /world\.buyPetition\(vendorGuid, name, offer\.index\)/,
    "each offer buys by its own listed index");
  assert.match(petition, /confirmPanel\(buy/, "money leaves only through a confirmation");
});
