import assert from "node:assert/strict";
import test from "node:test";
import { GlueSession } from "../dist/code/browser/glue/GlueSession.js";
import {
  REALM_CATEGORIES_ROUTE_PATH, RealmCategoryClient, realmCategoryTableFrom,
} from "../dist/code/browser/RealmCategoryClient.js";
import { checkCharacterName } from "../dist/code/browser/glue/GlueNameRules.js";

/**
 * 10.08 and 1.19 — Cfg_Categories in the glue: the realm tabs' names (`GetRealmCategories`, Wow.exe
 * 0x4df110: the row's Name_lang, "UNKNOWN" without one) and the name check's alphabet mask (the
 * current realm's category row's Create_charset_mask, 0x4dab40 → 0x7e2250).
 */

function realm(id, timezone) {
  return { type: 0, locked: false, flags: 0, name: `Мир ${id}`, address: "127.0.0.1:8085", population: 0,
    characters: 0, timezone, id, build: undefined };
}

const TABLE = realmCategoryTableFrom({ version: 1, categories: [
  [1, 0, 0, 0, "Разработка"], [12, 256, 4, 0, "Русский"], [8, 205, 1, 0, "Английский"],
] });

function session(categories) {
  const value = new GlueSession({ fireEvent: () => {}, realmCategories: categories });
  value.beginSession({ username: "T", sessionKey: new Uint8Array(40), realms: [realm(1, 12), realm(2, 1), realm(3, 40)] });
  return value;
}

test("the realm tabs are named by Cfg_Categories, UNKNOWN without a row", () => {
  assert.deepEqual(session(() => TABLE).categories().map((category) => category.name), ["Разработка", "Русский", "UNKNOWN"]);
});

test("an old gateway (no table yet) keeps the numbers, as before the route", () => {
  assert.deepEqual(session(() => undefined).categories().map((category) => category.name), ["1", "12", "40"]);
  assert.deepEqual(session(undefined).categories().map((category) => category.name), ["1", "12", "40"]);
});

test("the chosen realm's category decides the name alphabets", () => {
  const glue = session(() => TABLE);
  assert.equal(glue.nameAlphabetMask(), 0, "no realm chosen: every alphabet");
  glue.selectCategory(2);
  glue.changeRealm(2, 1); // realm 1, category 12 «Русский»: Cyrillic only
  assert.equal(glue.selectedRealm?.id, 1);
  assert.equal(glue.nameAlphabetMask(), 4);
  // 0x7e18c0: no allowed alphabet holds the first letter — its code 5, 0x7e1e90 → CHAR_NAME_INVALID_CHARACTER.
  assert.equal(checkCharacterName("Arthas", { alphabetMask: glue.nameAlphabetMask() }), 92, "Latin refused");
  assert.equal(checkCharacterName("Артас", { alphabetMask: glue.nameAlphabetMask() }), 87);
  glue.changeRealm(1, 1); // realm 2, category 1 «Разработка» (TrinityCore's default): mask 0, as before
  assert.equal(glue.selectedRealm?.id, 2);
  assert.equal(glue.nameAlphabetMask(), 0);
  assert.equal(checkCharacterName("Arthas", { alphabetMask: glue.nameAlphabetMask() }), 87);
  assert.equal(checkCharacterName("Артас", { alphabetMask: glue.nameAlphabetMask() }), 87);
  glue.close();
  const unknown = session(() => TABLE);
  unknown.changeRealm(3, 1);
  assert.equal(unknown.nameAlphabetMask(), 0, "a category without a row: mask 0");
  unknown.close();
  const old = session(() => undefined);
  old.changeRealm(2, 1);
  assert.equal(old.nameAlphabetMask(), 0, "an old gateway: mask 0");
  old.close();
});

test("the route answer is validated and the client asks the versioned path", async () => {
  assert.equal(REALM_CATEGORIES_ROUTE_PATH, "/dbc/realm-categories?v=1");
  assert.equal(realmCategoryTableFrom({ version: 2, categories: [] }), undefined);
  assert.equal(realmCategoryTableFrom({ version: 1, categories: [[1, 0, 0, 0]] }), undefined);
  assert.equal(TABLE.get(12).createCharsetMask, 4);
  const asked = [];
  const client = new RealmCategoryClient("http://127.0.0.1:8090", {
    fetch: async (url) => { asked.push(String(url)); return new Response("", { status: 404 }); },
    clock: { setTimeout: () => 0, clearTimeout: () => {} },
  });
  assert.equal(client.table(), undefined);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(asked, ["http://127.0.0.1:8090/dbc/realm-categories?v=1"]);
});

