// Plan item 5.28, review of L6 (04.10): the live UseContainerItem path (FrameXmlGossipLive.ts) after the mail-copy
// branch — an ordinary book (template PageText, no ITEM_FIELD_FLAG_READABLE; TrinityCore sets that flag only on the
// copy HandleMailCreateTextItem makes, MailHandler.cpp:600) still reads by CMSG_READ_ITEM every time it is used, a
// plain item is left to the ordinary use, and only the letter copy reads its own text and closes on a second use.
import assert from "node:assert/strict";
import test from "node:test";

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
