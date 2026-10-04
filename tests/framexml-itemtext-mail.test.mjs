// Plan item 5.28 (04.10, L6): a mail copy in the stock ItemTextFrame, as Wow.exe 3.3.5a 12340 reads it — using
// an item with ITEM_FIELD_FLAG_READABLE (0x200) opens the reader without CMSG_READ_ITEM (0x708c20 → 0x58a1a0),
// the text comes from CMSG_ITEM_TEXT_QUERY, BEGIN and READY follow it (0x589e90), the sender is the item's
// creator (ItemTextGetCreator 0x58a480) and its late name raises BEGIN/READY again (0x58a450); using the open
// item again closes it. TrinityCore: HandleMailCreateTextItem (MailHandler.cpp:565-620), HandleItemTextQuery
// (ItemHandler.cpp:1261). Read 2026-10-04.
import assert from "node:assert/strict";
import test from "node:test";

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
