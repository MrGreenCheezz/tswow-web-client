import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

// 5.28 (15.11, lane misc8): GetInboxText's body as Wow.exe 0x00570bd0 gives it (FrameXmlMailText.ts): nil for an
// auction letter or an empty one, a MailTemplate row's body through the quest text parser, the quest text parser for
// a non-player sender, and for a player's letter the profanity filter 0x00509a50 — CVar profanityFilter, the chat
// list, each matched byte masked by the next of "!@#$%^&*", a match inside a |c colour left alone (0x004fcf40).
const { frameXmlMailBody, frameXmlMailProfanityFiltered, resetFrameXmlMailProfanityCycle } =
  await import("../dist/code/browser/framexml/FrameXmlMailText.js");
const { glueNameFilterRegExp } = await import("../dist/code/browser/glue/GlueNameFilters.js");
const { MAIL_TEMPLATES_VERSION, MAIL_TEMPLATE_LAYOUT, mailTemplateCatalog, loadMailTemplates } =
  await import("../dist/code/gateway/MailTemplateMetadata.js");
const { MAIL_TEMPLATES_ROUTE_VERSION, MAIL_TEMPLATES_ROUTE_PATH, mailTemplateTableFrom } =
  await import("../dist/code/browser/MailTemplateClient.js");
const { parseFixed } = await import("../dist/code/gateway/DbcFixed.js");
const { CATALOG_ROUTES } = await import("../dist/code/gateway/CatalogRoutes.js");

const NORMAL = 0;
const AUCTION = 2;
const CREATURE = 3;
const CALENDAR = 5;
const letter = (senderType, body, mailTemplateId = 0) => ({ senderType, body, mailTemplateId });
const source = (extra = {}) => ({ questText: (text) => text.replaceAll("$N", "Артас"), ...extra });

test("the body by the letter's type, an empty body by its template (0x00570bd0)", () => {
  assert.equal(frameXmlMailBody(letter(AUCTION, "1234:0:2:77:1"), source()), undefined, "an auction letter's body is nil");
  assert.equal(frameXmlMailBody(letter(NORMAL, ""), source()), undefined, "no body, no template: nil");
  assert.equal(frameXmlMailBody(letter(CREATURE, "Привет, $N!"), source()), "Привет, Артас!", "a creature's letter is parsed");
  assert.equal(frameXmlMailBody(letter(NORMAL, "Привет, $N!"), source()), "Привет, $N!", "a player's letter is not");
  assert.equal(frameXmlMailBody(letter(CALENDAR, "Событие"), source()), "Событие");
  const templates = new Map([[84, "Спасибо, $N."]]);
  const withTemplates = source({ templateBody: (id) => templates.get(id) });
  assert.equal(frameXmlMailBody(letter(CREATURE, "", 84), withTemplates), "Спасибо, Артас.", "the template's body, parsed");
  assert.equal(frameXmlMailBody(letter(AUCTION, "", 84), withTemplates), "Спасибо, Артас.", "an empty body asks the template first");
  assert.equal(frameXmlMailBody(letter(CREATURE, "", 85), withTemplates), undefined, "no row: nil");
});

test("the profanity filter: on by the CVar, each matched byte masked, the cycle kept across calls", () => {
  const chat = [glueNameFilterRegExp("брань"), glueNameFilterRegExp("\\<bad\\>")];
  resetFrameXmlMailProfanityCycle();
  // Cyrillic letters are two bytes each: «брань» is ten symbols.
  assert.equal(frameXmlMailProfanityFiltered("одна брань и ещё брань", chat), "одна !@#$%^&*!@ и ещё #$%^&*!@#$");
  assert.equal(frameXmlMailProfanityFiltered("BAD badge Bad", chat), "%^& badge *!@", "ASCII caseless, \\< \\> word bounds; the cycle went on");
  resetFrameXmlMailProfanityCycle();
  const on = source({ profanity: () => ({ enabled: true, chat }) });
  const off = source({ profanity: () => ({ enabled: false, chat }) });
  assert.equal(frameXmlMailBody(letter(NORMAL, "bad"), off), "bad", "profanityFilter 0: untouched");
  assert.equal(frameXmlMailBody(letter(NORMAL, "bad"), on), "!@#");
  assert.equal(frameXmlMailBody(letter(CREATURE, "bad"), on), "bad", "only a player's letter is filtered");
});

test("a match inside a |c colour is left, and that pattern given up (0x004fcf40)", () => {
  const chat = [glueNameFilterRegExp("bad")];
  resetFrameXmlMailProfanityCycle();
  assert.equal(frameXmlMailProfanityFiltered("|cffff0000bad|r bad", chat), "|cffff0000bad|r bad");
  // The walk starts at the text's beginning for as many bytes as the match lies past the search position (15): it
  // ends inside the |c, so the second «bad», though past the |r, is left — as Wow.exe passes the two arguments.
  assert.equal(frameXmlMailProfanityFiltered("bad |cffff0000x|r bad", chat), "!@# |cffff0000x|r bad");
  assert.equal(frameXmlMailProfanityFiltered("bad bad", chat), "$%^ &*!", "past no colour, both (the cycle at 3)");
});

test("isTakeable as 0x00570bd0 answers it: an auction invoice can be copied, a copied or empty one cannot", async () => {
  const { frameXmlMailTakeable } = await import("../dist/code/browser/framexml/FrameXmlMailText.js");
  const base = { senderType: NORMAL, body: "текст", mailTemplateId: 0, flags: 0, stationeryId: 41 };
  assert.equal(frameXmlMailTakeable(base, false), true);
  assert.equal(frameXmlMailTakeable({ ...base, body: "" }, false), false, "no body, no template");
  assert.equal(frameXmlMailTakeable({ ...base, body: "", mailTemplateId: 84 }, false), true, "a template's text");
  assert.equal(frameXmlMailTakeable({ ...base, flags: 0x04 }, false), false, "already copied");
  assert.equal(frameXmlMailTakeable({ ...base, stationeryId: 61 }, false), false, "GM stationery");
  assert.equal(frameXmlMailTakeable({ ...base, senderType: CALENDAR }, false), false);
  assert.equal(frameXmlMailTakeable({ ...base, senderType: AUCTION }, true), true, "an invoice");
  assert.equal(frameXmlMailTakeable({ ...base, senderType: AUCTION }, false), false, "an auction letter without one");
});

test("the live filter reads profanityFilter by the stock CVar path: the slot's line, else the registered \"1\"", async () => {
  const { frameXmlLiveMailTextSource } = await import("../dist/code/browser/framexml/FrameXmlMailTextLive.js");
  const { setStockCVarSlots } = await import("../dist/code/browser/ui/StockCVarSlots.js");
  const { setGlueWorldNameFilters } = await import("../dist/code/browser/glue/GlueNameFilters.js");
  const { noteFrameXmlStockCVarWrite, setFrameXmlStockCVarSaved, clearFrameXmlStockCVarWrites } =
    await import("../dist/code/browser/framexml/FrameXmlStockCVarValues.js");
  const chat = [glueNameFilterRegExp("bad")];
  setGlueWorldNameFilters({ profane: [], chat, reserved: [] });
  let rows = [];
  setStockCVarSlots({ rows: () => rows, note: () => true, subscribe: () => () => {} });
  setFrameXmlStockCVarSaved([]);
  const live = frameXmlLiveMailTextSource((text) => text, () => undefined);
  try {
    resetFrameXmlMailProfanityCycle();
    assert.equal(frameXmlMailBody(letter(NORMAL, "bad"), live), "!@#", "no slot line: the registered \"1\"");
    rows = [["profanityFilter", "0"]];
    assert.equal(frameXmlMailBody(letter(NORMAL, "bad"), live), "bad", "Wow.exe turned it off: the slot says 0");
    noteFrameXmlStockCVarWrite("profanityFilter", "1");
    assert.equal(frameXmlMailBody(letter(NORMAL, "bad"), live), "$%^", "a SetCVar since wins until the slots answer again");
    clearFrameXmlStockCVarWrites();
    assert.equal(frameXmlMailBody(letter(NORMAL, "bad"), live), "bad");
  } finally {
    setStockCVarSlots(undefined);
    setGlueWorldNameFilters(undefined);
  }
});

/** A WDBC image of MailTemplate rows `{id, subject: {slot: text}, body: {slot: text}}`, 35 fields. */
function dbc(rows) {
  const strings = [Buffer.from([0])];
  let size = 1;
  const offsetOf = (text) => { const bytes = Buffer.from(`${text}\0`, "utf8"); const at = size; strings.push(bytes); size += bytes.length; return at; };
  const records = Buffer.alloc(rows.length * 140);
  rows.forEach((row, index) => {
    const at = index * 140;
    records.writeInt32LE(row.id, at);
    for (const [slot, text] of Object.entries(row.subject ?? {})) records.writeUInt32LE(offsetOf(text), at + (1 + Number(slot)) * 4);
    for (const [slot, text] of Object.entries(row.body ?? {})) records.writeUInt32LE(offsetOf(text), at + (18 + Number(slot)) * 4);
  });
  const header = Buffer.alloc(20);
  header.write("WDBC", 0, "latin1");
  header.writeUInt32LE(rows.length, 4);
  header.writeUInt32LE(35, 8);
  header.writeUInt32LE(140, 12);
  header.writeUInt32LE(size, 16);
  return Buffer.concat([header, records, ...strings]);
}

test("the route: [id, subject, body] in the client locale, one row in CATALOG_ROUTES at the version the browser asks", () => {
  const rows = parseFixed("MailTemplate", dbc([
    { id: 83, body: { 8: "Это тест." } },
    { id: 84, subject: { 0: "Thanks" }, body: { 0: "Thank you, $N.", 8: "Спасибо, $N." } },
  ]), MAIL_TEMPLATE_LAYOUT);
  const catalog = mailTemplateCatalog(rows, "ruRU");
  assert.deepEqual(catalog, { version: MAIL_TEMPLATES_VERSION, templates: [[83, "", "Это тест."], [84, "Thanks", "Спасибо, $N."]] });
  const table = mailTemplateTableFrom(JSON.parse(JSON.stringify(catalog)));
  assert.equal(table.get(84).body, "Спасибо, $N.");
  assert.equal(mailTemplateTableFrom({ version: 2, templates: [] }), undefined);
  assert.equal(mailTemplateTableFrom({ version: 1, templates: [[1, "a"]] }), undefined);
  assert.equal(MAIL_TEMPLATES_ROUTE_VERSION, MAIL_TEMPLATES_VERSION);
  assert.equal(MAIL_TEMPLATES_ROUTE_PATH, `/dbc/mail-templates?v=${MAIL_TEMPLATES_VERSION}`);
  assert.equal(CATALOG_ROUTES.find(({ pathname }) => pathname === "/dbc/mail-templates")?.version, MAIL_TEMPLATES_VERSION);
});

let dbcDirectory;
try { dbcDirectory = (await import("../tools/paths.mjs")).dbcDirectory(); } catch { dbcDirectory = undefined; }

test("this dataset's MailTemplate: 207 rows; 84 thanks the player with a gender choice", {
  skip: dbcDirectory && existsSync(`${dbcDirectory}/MailTemplate.dbc`) ? false : "no dataset DBCs on this machine",
}, async () => {
  const catalog = await loadMailTemplates(dbcDirectory);
  assert.equal(catalog.templates.length, 207);
  const row = catalog.templates.find(([id]) => id === 84);
  assert.match(row[2], /\$gнавестил:навестила; меня \$N/);
});
