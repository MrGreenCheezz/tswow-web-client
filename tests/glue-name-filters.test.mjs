import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { checkCharacterName } from "../dist/code/browser/glue/GlueNameRules.js";
import {
  GlueNameFilterClient, NAME_FILTERS_ROUTE_PATH, glueNameFilterCatalogFrom, glueNameFilterRegExp, glueNameFiltered,
  glueNameFiltersActive, setGlueWorldNameFilters,
} from "../dist/code/browser/glue/GlueNameFilters.js";
import { frameXmlPetNameError, frameXmlPetNameReason } from "../dist/code/browser/framexml/FrameXmlPetDeclension.js";
import { GlueSession } from "../dist/code/browser/glue/GlueSession.js";
import { realmCategoryTableFrom } from "../dist/code/browser/RealmCategoryClient.js";
import { parseFixed } from "../dist/code/gateway/DbcFixed.js";
import { NAME_FILTER_LAYOUT, loadNameFilters, nameFilterCatalog } from "../dist/code/gateway/NameFilterMetadata.js";
import { CATALOG_ROUTES } from "../dist/code/gateway/CatalogRoutes.js";
import { dbcDirectory } from "../tools/paths.mjs";

/**
 * 1.19 (11.11): the name filters of the client's own name check, as Wow.exe 12340 applies them
 * (.runtime/re-2026-11-11/glue): NamesProfanity, ChatProfanity and NamesReserved rows of the client locale and of
 * -1 (0x7e2250), compiled by the bundled PCRE whose escape table makes `\<` and `\>` a word boundary, matched
 * ASCII-caseless anywhere in the name; a hit is code 8 → CHAR_NAME_RESERVED (95), judged before the length limit.
 */

const SUCCESS = 87;
const TOO_LONG = 91;
const RESERVED = 95;

function tables({ profane = [], chat = [], reserved = [] }) {
  const compile = (list) => list.map((pattern) => glueNameFilterRegExp(pattern));
  return { profane: compile(profane), chat: compile(chat), reserved: compile(reserved) };
}

test("\\< and \\> are a word boundary over ASCII word characters; ASCII letters fold, others do not", () => {
  const focus = glueNameFilterRegExp("\\<focus\\>");
  assert.ok(focus);
  assert.equal(glueNameFiltered("Focus", { profane: [], chat: [], reserved: [focus] }), true, "ASCII-caseless");
  assert.equal(glueNameFiltered("Focuser", { profane: [], chat: [], reserved: [focus] }), false, "\\> ends a word");
  // A Cyrillic letter is no word character to PCRE of this build: the boundary never stands before it.
  const rogue = tables({ profane: ["\\<Разбойник\\>"] });
  assert.equal(glueNameFiltered("Разбойник", rogue), false);
  // Only ASCII folds: the lower-case pattern finds the letters inside a name, not a capital first letter.
  const swear = tables({ profane: ["бляд"] });
  assert.equal(glueNameFiltered("Аблядь", swear), true);
  assert.equal(glueNameFiltered("Блядь", swear), false);
  const upper = tables({ reserved: ["\\<CON\\>"] });
  assert.equal(glueNameFiltered("con", upper), true, "an upper-case pattern matches either case");
});

test("a pattern a RegExp would misread is skipped, not misapplied", () => {
  for (const pattern of ["\\Afoo", "foo\\Z", "a++", "(?>ab)", "[[:alpha:]]", "\\p{Lu}", "("]) {
    assert.equal(glueNameFilterRegExp(pattern), undefined, pattern);
  }
  assert.ok(glueNameFilterRegExp("муд[аио]"));
});

test("a hit in any list is CHAR_NAME_RESERVED, before the length limit; no lists, no step", () => {
  const filters = tables({ profane: ["\\<Homo\\>"], chat: ["tranny"], reserved: ["\\<focus\\>"] });
  assert.equal(checkCharacterName("Focus", { nameFilters: filters }), RESERVED);
  assert.equal(checkCharacterName("Homo", { nameFilters: filters }), RESERVED, "NamesProfanity answers RESERVED too");
  assert.equal(checkCharacterName("Trannyx", { nameFilters: filters }), RESERVED, "ChatProfanity is consulted");
  assert.equal(checkCharacterName("Trannyxxyyzzab", { nameFilters: filters }), RESERVED, "before TOO_LONG");
  assert.equal(checkCharacterName("Trannyxxyyzzab"), TOO_LONG);
  assert.equal(checkCharacterName("Focus"), SUCCESS);
  assert.equal(checkCharacterName("Thrall", { nameFilters: filters }), SUCCESS);
});

test("the pet's name check (0x7e1f00) reads the lists the glue built: a hit is reason 8, ERR_NAME_RESERVED", () => {
  const filters = tables({ reserved: ["\\<focus\\>"] });
  assert.equal(frameXmlPetNameReason("Focus", filters), 8);
  assert.equal(frameXmlPetNameError(frameXmlPetNameReason("Focus", filters)), "ERR_NAME_RESERVED");
  assert.equal(frameXmlPetNameReason("Focus", undefined), 0);
  setGlueWorldNameFilters(filters);
  try {
    assert.equal(frameXmlPetNameReason("Focus"), 8, "the default is what the glue handed over");
  } finally {
    setGlueWorldNameFilters(undefined);
  }
});

test("the lists apply when the realm category's LocaleMask holds the client locale (0 — every locale)", () => {
  assert.equal(glueNameFiltersActive(undefined, 8), true, "no row: the client locale's own bit");
  assert.equal(glueNameFiltersActive(0, 8), true);
  assert.equal(glueNameFiltersActive(256, 8), true);
  assert.equal(glueNameFiltersActive(205, 8), false, "an English category does not build ruRU's lists");
  assert.equal(glueNameFiltersActive(1, 0), true);
  const table = realmCategoryTableFrom({ version: 1, categories: [[1, 0, 0, 0, "Разработка"], [8, 205, 1, 0, "Английский"]] });
  const session = new GlueSession({ fireEvent: () => {}, realmCategories: () => table });
  const realm = (id, timezone) => ({ type: 0, locked: false, flags: 0, name: `Мир ${id}`, address: "127.0.0.1:8085",
    population: 0, characters: 0, timezone, id, build: undefined });
  session.beginSession({ username: "T", sessionKey: new Uint8Array(40), realms: [realm(1, 8), realm(2, 1)] });
  assert.equal(session.nameFilterLocaleMask(), undefined, "no realm chosen");
  session.changeRealm(2, 1); // category 8 «Английский»
  assert.equal(session.nameFilterLocaleMask(), 205);
  assert.equal(glueNameFiltersActive(session.nameFilterLocaleMask(), 8), false);
  session.close();
});

test("the route answer is validated and compiled; the client asks the versioned path", async () => {
  assert.equal(NAME_FILTERS_ROUTE_PATH, "/dbc/name-filters?v=1");
  assert.equal(glueNameFilterCatalogFrom({ version: 2, locale: 8, profane: [], chat: [], reserved: [] }), undefined);
  assert.equal(glueNameFilterCatalogFrom({ version: 1, locale: 8, profane: [1], chat: [], reserved: [] }), undefined);
  const catalog = glueNameFilterCatalogFrom({ version: 1, locale: 8, profane: ["a++", "x"], chat: [], reserved: ["\\<none\\>"] });
  assert.equal(catalog.locale, 8);
  assert.equal(catalog.tables.profane.length, 1, "the misread pattern is dropped");
  assert.equal(CATALOG_ROUTES.some((route) => route.pathname === "/dbc/name-filters" && route.version === 1), true);
  const asked = [];
  const client = new GlueNameFilterClient("http://127.0.0.1:8090", {
    fetch: async (url) => { asked.push(String(url)); return new Response("", { status: 404 }); },
    clock: { setTimeout: () => 0, clearTimeout: () => {} },
  });
  assert.equal(client.catalog(), undefined);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(asked, ["http://127.0.0.1:8090/dbc/name-filters?v=1"]);
});

/** A WDBC image of `{ID, Name, Language}` rows. */
function filterDbc(rows) {
  const strings = [""];
  const offsets = rows.map(([, text]) => { const at = Buffer.byteLength(strings.join("\0"), "utf8") + 1; strings.push(text); return at; });
  const block = Buffer.from(`${strings.join("\0")}\0`, "utf8");
  const data = Buffer.alloc(20 + rows.length * 12);
  data.write("WDBC", 0, "latin1");
  data.writeUInt32LE(rows.length, 4);
  data.writeUInt32LE(3, 8);
  data.writeUInt32LE(12, 12);
  data.writeUInt32LE(block.byteLength, 16);
  rows.forEach(([id, , language], index) => {
    data.writeInt32LE(id, 20 + index * 12);
    data.writeUInt32LE(offsets[index], 24 + index * 12);
    data.writeInt32LE(language, 28 + index * 12);
  });
  return Buffer.concat([data, block]);
}

test("the gateway serves the client locale's rows and the -1 rows of each table, in file order", () => {
  const rows = (list) => parseFixed("T", filterDbc(list), NAME_FILTER_LAYOUT);
  const catalog = nameFilterCatalog({
    profane: rows([[1, "x", 0], [2, "\\<Homo\\>", -1], [3, "бляд", 8]]),
    chat: rows([[1, "씨", 1], [2, "tranny", -1]]),
    reserved: rows([[1, "\\<focus\\>", -1], [2, "\\<Неизвестно\\>", 8], [3, "callist", 0]]),
  }, "ruRU");
  assert.deepEqual(catalog, {
    version: 1, locale: 8, profane: ["\\<Homo\\>", "бляд"], chat: ["tranny"], reserved: ["\\<focus\\>", "\\<Неизвестно\\>"],
  });
});

const dbc = dbcDirectory();
test("the dataset's ruRU lists load and compile", { skip: existsSync(join(dbc, "NamesReserved.dbc")) ? false : "no dataset DBC" }, async () => {
  const catalog = await loadNameFilters(dbc);
  assert.equal(catalog.locale, 8);
  assert.ok(catalog.profane.length > 0 && catalog.reserved.length > 0 && catalog.chat.length > 0);
  const compiled = glueNameFilterCatalogFrom(catalog);
  assert.equal(compiled.tables.profane.length, catalog.profane.length, "every ruRU pattern carries over");
  assert.equal(compiled.tables.reserved.length, catalog.reserved.length);
  assert.equal(compiled.tables.chat.length, catalog.chat.length);
  assert.equal(checkCharacterName("Focus", { nameFilters: compiled.tables }), RESERVED);
  assert.equal(checkCharacterName("Аларин", { nameFilters: compiled.tables }), SUCCESS);
});
