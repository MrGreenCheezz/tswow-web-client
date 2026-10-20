import assert from "node:assert/strict";
import test from "node:test";

// Merged 2026-10-20 from 3 files; each block below is one former file,
// kept in its own scope so its helpers and module loads stay as they were.

// ── framexml-itemtext-book-use.test.mjs
{
// Plan item 5.28, review of L6 (04.10): the live UseContainerItem path (FrameXmlGossipLive.ts) after the mail-copy
// branch — an ordinary book (template PageText, no ITEM_FIELD_FLAG_READABLE; TrinityCore sets that flag only on the
// copy HandleMailCreateTextItem makes, MailHandler.cpp:600) still reads by CMSG_READ_ITEM every time it is used, a
// plain item is left to the ordinary use, and only the letter copy reads its own text and closes on a second use.

const { FrameXmlItemTextModel } = await import("../dist/code/browser/framexml/FrameXmlItemText.js");
const { liveFrameXmlNpcUseContainerItem } = await import("../dist/code/browser/framexml/FrameXmlGossipLive.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

const BOOK = 0x4000000000000078n;
const LETTER = 0x4000000000000077n;
const SWORD = 0x4000000000000079n;
const MAIL_TEXT_MASK = 0x200 | 0x40000 | 0x80000;

function item(guid, entry, flags) {
  return { guid, typeId: 1, fields: new Map([[UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, entry], [UPDATE_FIELDS.ITEM_FIELD_FLAGS.offset, flags]]) };
}

function fixture() {
  const calls = [];
  const listeners = new Map();
  const objects = new Map([[BOOK, item(BOOK, 2794, 0x1)], [LETTER, item(LETTER, 8383, MAIL_TEXT_MASK)], [SWORD, item(SWORD, 25, 0x1)]]);
  const world = {
    events: { on(name, listener) { listeners.set(name, listener); return () => listeners.delete(name); } },
    state: { objects },
    itemTemplates: new Map([
      [2794, { found: true, name: "Летопись", pageText: 1131, pageMaterial: 1, startQuest: 0, spells: [] }],
      [8383, { found: true, name: "Простое письмо", pageText: 0, pageMaterial: 2, startQuest: 0, spells: [] }],
      [25, { found: true, name: "Меч", pageText: 0, pageMaterial: 0, startQuest: 0, spells: [] }],
    ]),
    gameObjectTemplates: new Map(),
    pageText: () => undefined,
    readItem: (bag, slot) => calls.push(["read", bag, slot]),
    itemText: () => undefined,
    requestItemText: (guid) => calls.push(["text", guid]),
  };
  const itemText = new FrameXmlItemTextModel({ world: () => world });
  itemText.attach({ fire: () => 1 });
  itemText.owned = true;
  const windows = { bank: { useContainerItem: () => false }, petition: { useItem: () => false }, itemText };
  const use = (guid, bag, slot) => liveFrameXmlNpcUseContainerItem(windows, world, bag, slot,
    { index: slot, item: objects.get(guid), guid, bag, slot });
  return { use, calls, itemText };
}

test("a book reads by CMSG_READ_ITEM on every use; a sword is left to the ordinary use", () => {
  const { use, calls, itemText } = fixture();
  assert.equal(use(BOOK, 255, 23), true);
  itemText.open({ kind: "item", guid: BOOK });
  assert.equal(use(BOOK, 255, 23), true, "the book is not closed by a second use here (the client's toggle is not modelled)");
  assert.deepEqual(calls, [["read", 255, 23], ["read", 255, 23]]);
  assert.equal(use(SWORD, 0, 1), false);
  assert.equal(calls.length, 2);
});

test("the letter copy: its own text asked, no CMSG_READ_ITEM; a second use closes it", () => {
  const { use, calls, itemText } = fixture();
  assert.equal(use(LETTER, 1, 2), true);
  assert.deepEqual(calls, [["text", LETTER]]);
  assert.equal(itemText.reading, true);
  assert.equal(use(LETTER, 1, 2), true);
  assert.equal(itemText.reading, false);
  assert.deepEqual(calls, [["text", LETTER]]);
});
}

// ── framexml-itemtext-mail.test.mjs
{
// Plan item 5.28 (04.10, L6): a mail copy in the stock ItemTextFrame, as Wow.exe 3.3.5a 12340 reads it — using
// an item with ITEM_FIELD_FLAG_READABLE (0x200) opens the reader without CMSG_READ_ITEM (0x708c20 → 0x58a1a0),
// the text comes from CMSG_ITEM_TEXT_QUERY, BEGIN and READY follow it (0x589e90), the sender is the item's
// creator (ItemTextGetCreator 0x58a480) and its late name raises BEGIN/READY again (0x58a450); using the open
// item again closes it. TrinityCore: HandleMailCreateTextItem (MailHandler.cpp:565-620), HandleItemTextQuery
// (ItemHandler.cpp:1261). Read 2026-10-04.

const { FrameXmlItemTextModel, FRAMEXML_ITEM_TEXT_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlItemText.js");
const { frameXmlItemIsMailText, frameXmlItemCreator, ITEM_FIELD_FLAG_READABLE } =
  await import("../dist/code/browser/framexml/FrameXmlItemTextMail.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

const LETTER = 0x4000000000000077n;
const BOOK = 0x4000000000000078n;
const SENDER = 0x2an;
/** ITEM_FLAG_MAIL_TEXT_MASK (ItemTemplate.h:151): READABLE | 0x40000 | 0x80000. */
const MAIL_TEXT_MASK = 0x200 | 0x40000 | 0x80000;

function item(entry, flags, creator = 0n) {
  return { fields: new Map([
    [UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, entry],
    [UPDATE_FIELDS.ITEM_FIELD_FLAGS.offset, flags],
    [UPDATE_FIELDS.ITEM_FIELD_CREATOR.offset, Number(creator & 0xffff_ffffn)],
    [UPDATE_FIELDS.ITEM_FIELD_CREATOR.offset + 1, Number(creator >> 32n)],
  ]) };
}

function fixture() {
  const listeners = new Map();
  const texts = new Map();
  const names = new Map();
  const calls = [];
  const world = {
    events: { on(name, listener) { listeners.set(name, listener); return () => listeners.delete(name); } },
    state: { objects: new Map([[LETTER, item(8383, MAIL_TEXT_MASK, SENDER)], [BOOK, item(2794, 0)]]) },
    itemTemplates: new Map([
      [8383, { found: true, name: "Простое письмо", pageText: 0, pageMaterial: 2, startQuest: 0, spells: [] }],
      [2794, { found: true, name: "Летопись", pageText: 1131, pageMaterial: 1, startQuest: 0, spells: [] }],
    ]),
    gameObjectTemplates: new Map(),
    pageText: () => undefined,
    readItem: (bag, slot) => calls.push(["read", bag, slot]),
    itemText: (guid) => texts.get(guid),
    requestItemText: (guid) => calls.push(["text", guid]),
    names: { get: (guid) => names.get(guid) },
    requestName: (guid) => calls.push(["name", guid]),
  };
  const model = new FrameXmlItemTextModel({ world: () => world });
  const fired = [];
  model.attach({ fire(event) { fired.push(event); return 1; } });
  model.owned = true;
  const call = (name) => [...FRAMEXML_ITEM_TEXT_BINDINGS[name]({ itemText: model }, [])];
  const answer = (guid, text) => { texts.set(guid, text); listeners.get("QUERY_CACHE_CHANGED")?.({ kind: "itemText", id: guid }); };
  return { world, model, fired, calls, names, call, answer };
}

test("the item's own flags: ITEM_FIELD_FLAG_READABLE and ITEM_FIELD_CREATOR", () => {
  assert.equal(ITEM_FIELD_FLAG_READABLE, 0x200);
  assert.equal(frameXmlItemIsMailText(item(8383, MAIL_TEXT_MASK)), true);
  assert.equal(frameXmlItemIsMailText(item(8383, 0x40000 | 0x80000)), false);
  assert.equal(frameXmlItemIsMailText(undefined), false);
  assert.equal(frameXmlItemCreator(item(8383, 0, 0x1_0000_002an)), 0x1_0000_002an);
  assert.equal(frameXmlItemCreator(item(8383, 0)), undefined);
});

test("using a mail copy: no CMSG_READ_ITEM, the text asked once, BEGIN and READY when it comes", () => {
  const { model, fired, calls, call, answer } = fixture();
  assert.equal(model.useItem(0, 23, undefined, LETTER), true, "handled, so no CMSG_USE_ITEM either");
  assert.deepEqual(calls, [["text", LETTER]]);
  assert.deepEqual(fired, [], "nothing until the text is cached (0x58a1a0 waits for the record)");
  answer(LETTER, "Дорогой друг!");
  assert.deepEqual(fired, ["ITEM_TEXT_BEGIN", "ITEM_TEXT_READY"]);
  assert.deepEqual(call("ItemTextGetItem"), ["Простое письмо"]);
  assert.deepEqual(call("ItemTextGetText"), ["Дорогой друг!"]);
  assert.deepEqual([call("ItemTextGetPage"), call("ItemTextHasNextPage")], [[1], [false]]);
  call("ItemTextNextPage");
  call("ItemTextPrevPage");
  assert.deepEqual(fired, ["ITEM_TEXT_BEGIN", "ITEM_TEXT_READY"], "a letter has one page");
  assert.equal(calls.filter(([kind]) => kind === "text").length, 1);
});

test("the sender: nil and asked while unknown; its name raises BEGIN and READY again", () => {
  const { model, fired, calls, names, call, answer } = fixture();
  model.useItem(0, 23, undefined, LETTER);
  answer(LETTER, "Привет");
  assert.deepEqual(call("ItemTextGetCreator"), []);
  assert.deepEqual(call("ItemTextGetCreator"), [], "asked once");
  assert.deepEqual(calls.filter(([kind]) => kind === "name"), [["name", SENDER]]);
  model.tick();
  assert.equal(fired.length, 2);
  names.set(SENDER, "Отправитель");
  model.tick();
  assert.deepEqual(fired, ["ITEM_TEXT_BEGIN", "ITEM_TEXT_READY", "ITEM_TEXT_BEGIN", "ITEM_TEXT_READY"]);
  assert.deepEqual(call("ItemTextGetCreator"), ["Отправитель"]);
  model.tick();
  assert.equal(fired.length, 4, "once");
});

test("using the open letter again closes it; an ordinary book still reads by CMSG_READ_ITEM", () => {
  const { model, fired, calls, answer, call } = fixture();
  model.useItem(0, 23, undefined, LETTER);
  answer(LETTER, "Привет");
  model.useItem(0, 23, undefined, LETTER);
  assert.deepEqual(fired.at(-1), "ITEM_TEXT_CLOSED");
  assert.deepEqual(call("ItemTextGetItem"), []);
  const book = { found: true, name: "Летопись", pageText: 1131, pageMaterial: 1, startQuest: 0, spells: [] };
  assert.equal(model.useItem(1, 4, book, BOOK), true);
  assert.deepEqual(calls.at(-1), ["read", 1, 4]);
  assert.deepEqual(call("ItemTextGetCreator"), [], "no reader open yet, no creator");
  const muted = fixture();
  muted.model.muted(() => muted.model.useItem(0, 23, undefined, LETTER));
  assert.deepEqual(muted.calls, [], "the gate's muted use sends nothing");
});
}

// ── framexml-itemtext-seam.test.mjs
{
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
}
