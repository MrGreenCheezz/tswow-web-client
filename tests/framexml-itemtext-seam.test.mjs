import assert from "node:assert/strict";
import test from "node:test";

// The stock ItemTextFrame's C API: the reader's BEGIN/READY/CLOSED edges over the canned book and
// plaque, page turning, what a readable item is, and WorldClient's side of it — CMSG_READ_ITEM as
// TrinityCore reads it and ITEM_TEXT_OPENED from SMSG_READ_ITEM_OK / SMSG_GAMEOBJECT_PAGETEXT.
// MPQ-free; ItemTextFrame.lua runs in framexml-itemtext-vertical.test.mjs.
const { PacketWriter } = await import("../dist/code/protocol/PacketWriter.js");
const { PacketReader } = await import("../dist/code/protocol/PacketReader.js");
const { OPCODES } = await import("../dist/code/generated/opcodes.js");
const { WorldClient } = await import("../dist/code/world/WorldClient.js");
const {
  FRAMEXML_ITEM_TEXT_BINDINGS, FRAMEXML_PAGE_MATERIALS, frameXmlItemIsReadable,
} = await import("../dist/code/browser/framexml/FrameXmlItemText.js");
const { createCannedFrameXmlItemText } = await import("../dist/code/browser/framexml/FrameXmlItemTextCanned.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");

async function flush() {
  for (let round = 0; round < 3; round += 1) await Promise.resolve();
}

function fixture({ owned = true } = {}) {
  const { model, world } = createCannedFrameXmlItemText();
  const fired = [];
  model.attach({ fire(event, ...args) { fired.push([event, ...args]); return 1; } });
  model.owned = owned;
  const call = (name, ...args) => FRAMEXML_ITEM_TEXT_BINDINGS[name]({ itemText: model }, args);
  return { model, world, fired, call };
}

const names = (fired) => fired.map(([event]) => event);

test("a book: BEGIN at once, READY when its page arrives, READY again per turned page, CLOSED on close", async () => {
  const { world, fired, call } = fixture();
  world.open("item");
  assert.deepEqual(names(fired), ["ITEM_TEXT_BEGIN"], "the title is known; the page is being queried");
  assert.deepEqual(call("ItemTextGetItem"), ["Летопись каменщиков"]);
  assert.deepEqual(world.calls, [{ kind: "page", pageId: 1131 }]);
  await flush();
  assert.deepEqual(names(fired), ["ITEM_TEXT_BEGIN", "ITEM_TEXT_READY"]);
  assert.deepEqual([call("ItemTextGetPage"), call("ItemTextHasNextPage"), call("ItemTextGetMaterial")],
    [[1], [true], ["Parchment"]]);
  assert.match(call("ItemTextGetText")[0], /^Давным-давно/);
  call("ItemTextNextPage");
  assert.deepEqual(names(fired).at(-1), "ITEM_TEXT_READY", "page 2 came with the chain: no second query");
  assert.equal(world.calls.length, 1);
  assert.deepEqual([call("ItemTextGetPage"), call("ItemTextHasNextPage")], [[2], [false]]);
  call("ItemTextNextPage");
  assert.equal(fired.length, 3, "no page after the last");
  call("ItemTextPrevPage");
  assert.deepEqual([call("ItemTextGetPage"), fired.length], [[1], 4]);
  call("CloseItemText");
  assert.deepEqual(names(fired).at(-1), "ITEM_TEXT_CLOSED");
  assert.deepEqual(call("ItemTextGetItem"), []);
});

test("a goober's page: data[7] and its stone paper (data[9]); unpublished readers raise nothing", async () => {
  const { world, fired, call } = fixture();
  world.open("object");
  await flush();
  assert.deepEqual(names(fired), ["ITEM_TEXT_BEGIN", "ITEM_TEXT_READY"]);
  assert.deepEqual([call("ItemTextGetItem"), call("ItemTextGetMaterial"), call("ItemTextHasNextPage")],
    [["Памятная плита"], ["Stone"], [false]]);
  const quiet = fixture({ owned: false });
  quiet.world.open("item");
  await flush();
  assert.deepEqual(quiet.fired, []);
});

test("a reader whose template is still in flight begins when it lands", async () => {
  const { world, fired } = fixture();
  const template = world.itemTemplates.get(2794);
  world.itemTemplates.delete(2794);
  world.open("item");
  assert.deepEqual(fired, []);
  world.itemTemplates.set(2794, template);
  world.events.emit("QUERY_CACHE_CHANGED", { kind: "page", id: 0 });
  await flush();
  assert.deepEqual(names(fired), ["ITEM_TEXT_BEGIN", "ITEM_TEXT_READY"]);
});

test("readable: a page and nothing the server would run instead; the materials are PageTextMaterial.dbc's", () => {
  const base = { found: true, name: "", pageText: 10, pageMaterial: 0, startQuest: 0, spells: [] };
  assert.equal(frameXmlItemIsReadable(base), true);
  assert.equal(frameXmlItemIsReadable({ ...base, pageText: 0 }), false);
  assert.equal(frameXmlItemIsReadable({ ...base, startQuest: 7 }), false, "a quest starter opens the quest");
  assert.equal(frameXmlItemIsReadable({ ...base, spells: [{ spellId: 483, trigger: 0 }] }), false, "an on-use spell is used");
  assert.equal(frameXmlItemIsReadable({ ...base, spells: [{ spellId: 483, trigger: 1 }] }), true, "an on-equip spell is not");
  assert.equal(frameXmlItemIsReadable({ ...base, found: false }), false);
  assert.deepEqual(Object.values(FRAMEXML_PAGE_MATERIALS),
    ["Parchment", "Stone", "Marble", "Silver", "Bronze", "Valentine", "Illidan"]);
  const { model, world } = fixture();
  assert.equal(model.useItem(255, 23, base), true);
  assert.deepEqual(world.calls, [{ kind: "read", bag: 255, slot: 23 }]);
  assert.equal(model.useItem(255, 23, { ...base, pageText: 0 }), false);
  model.owned = false;
  assert.equal(model.useItem(255, 23, base), false, "nothing could show it: the ordinary use");
  for (const name of Object.keys(FRAMEXML_ITEM_TEXT_BINDINGS)) assert.ok(FRAMEXML_SEAM_BINDINGS[name], name);
});

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

test("WorldClient: CMSG_READ_ITEM is u8 bag, u8 slot; READ_ITEM_OK and GAMEOBJECT_PAGETEXT open a reader", async () => {
  const connection = fakeConnection();
  connection.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD, new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(0).toUint8Array());
  const client = new WorldClient(connection);
  await client.loginCharacter(0x1234n);
  await settle();
  connection.sent.length = 0;
  client.readItem(255, 25);
  const read = connection.sent.find(({ opcode }) => opcode === OPCODES.CMSG_READ_ITEM);
  assert.ok(read, "CMSG_READ_ITEM is sent");
  const reader = new PacketReader(read.payload);
  assert.deepEqual([reader.u8(), reader.u8(), reader.remaining], [255, 25, 0], "WorldSession::HandleReadItem: recvData >> bag >> slot");
  const opened = [];
  client.events.on("ITEM_TEXT_OPENED", (event) => opened.push(event));
  connection.push(OPCODES.SMSG_READ_ITEM_OK, new PacketWriter().u64(0x4000000000000901n).toUint8Array());
  connection.push(OPCODES.SMSG_READ_ITEM_FAILED, new PacketWriter().u64(0x4000000000000902n).toUint8Array());
  connection.push(OPCODES.SMSG_GAMEOBJECT_PAGETEXT, new PacketWriter().u64(0xF110000180000902n).toUint8Array());
  await settle();
  assert.deepEqual(opened, [
    { kind: "item", guid: 0x4000000000000901n },
    { kind: "object", guid: 0xF110000180000902n },
  ], "a refusal opens nothing");
});
