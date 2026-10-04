import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import test from "node:test";

// The gateway columns the 30.09 follow-ups wait for (docs/WORK_PLAN.ru.md 1.14, 1.15, 2.05, 10.08):
// ChrClasses.Flags/SpellClassSet on `/dbc/character-creation?v=4`, SpellItemEnchantment.Flags on
// `/dbc/item-enchantments?v=2`, the friendly range, implicit targets and attributes on
// `/dbc/spells?v=14`, and `/dbc/realm-categories?v=1`. Synthetic WDBC images only; nothing here talks
// to a running gateway.
const { loadCharacterCreation } = await import("../dist/code/gateway/CharacterCreation.js");
const { CATALOG_ROUTES, serveCatalogRoute } = await import("../dist/code/gateway/CatalogRoutes.js");
const { REALM_CATEGORIES_VERSION } = await import("../dist/code/gateway/RealmCategoryMetadata.js");
const { REALM_CATEGORIES_ROUTE_PATH, realmCategoryTableFrom } = await import("../dist/code/browser/RealmCategoryClient.js");

const ORIGIN = "http://127.0.0.1:5173";

/** A catalog-route server over `dbcDirectory`; `body` gets its base URL. */
async function withCatalogServer(dbcDirectory, body) {
  const cache = new Map();
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    void serveCatalogRoute(request, response, url, cache, { dbcDirectory, allowedOrigins: [ORIGIN] })
      .then((handled) => { if (!handled) response.writeHead(404).end(); });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await body(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/** A WDBC image: `rows` are arrays of 32-bit words (numbers; strings are placed in the block). */
export function wdbc(fieldCount, rows) {
  const strings = [Buffer.from([0])];
  let size = 1;
  const offsets = new Map();
  const offsetOf = (text) => {
    if (text === "") return 0;
    if (offsets.has(text)) return offsets.get(text);
    const bytes = Buffer.from(`${text}\0`, "utf8");
    offsets.set(text, size);
    strings.push(bytes);
    size += bytes.length;
    return offsets.get(text);
  };
  const records = Buffer.alloc(rows.length * fieldCount * 4);
  rows.forEach((row, index) => {
    for (let field = 0; field < fieldCount; field++) {
      const value = row[field] ?? 0;
      const at = (index * fieldCount + field) * 4;
      if (typeof value === "string") records.writeUInt32LE(offsetOf(value), at);
      else if (typeof value === "object" && value !== null && "float" in value) records.writeFloatLE(value.float, at);
      else records.writeUInt32LE(value >>> 0, at);
    }
  });
  const header = Buffer.alloc(20);
  header.write("WDBC", 0, "latin1");
  header.writeUInt32LE(rows.length, 4);
  header.writeUInt32LE(fieldCount, 8);
  header.writeUInt32LE(fieldCount * 4, 12);
  header.writeUInt32LE(size, 16);
  return Buffer.concat([header, records, ...strings]);
}

async function withDirectory(files, body) {
  const directory = await mkdtemp(join(tmpdir(), "webclient-followups-"));
  try {
    for (const [name, bytes] of Object.entries(files)) await writeFile(join(directory, name), bytes);
    return await body(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("1.15/1.14b: the creation route's class rows carry ChrClasses.Flags and SpellClassSet", async () => {
  // ChrClasses: 60 fields, Name_lang at 4 (ruRU slot 12), Filename 55, SpellClassSet 56, Flags 57.
  const classRow = (id, file, set, flags) => {
    const row = new Array(60).fill(0);
    row[0] = id; row[4] = file; row[12] = file; row[55] = file; row[56] = set; row[57] = flags;
    return row;
  };
  const races = new Array(69).fill(0);
  races[0] = 1;
  const base = Buffer.alloc(20 + 2 + 1);
  base.write("WDBC", 0, "latin1");
  base.writeUInt32LE(1, 4); base.writeUInt32LE(2, 8); base.writeUInt32LE(2, 12); base.writeUInt32LE(1, 16);
  base[20] = 1; base[21] = 13;
  const data = await withDirectory({
    "ChrClasses.dbc": wdbc(60, [classRow(1, "WARRIOR", 4, 0x32), classRow(13, "HERO", 10, 0x3a)]),
    "ChrRaces.dbc": wdbc(69, [races]),
    "CharBaseInfo.dbc": base,
  }, loadCharacterCreation);
  assert.deepEqual(data.classes.map((entry) => [entry.id, entry.flags, entry.spellClassSet]),
    [[1, 0x32, 4], [13, 0x3a, 10]]);
});

/**
 * A fetch standing in for the browser cache and the gateway: `?v=4` from its cache answers the old
 * shape (no class `flags`, as a gateway not yet restarted served it under the new key and
 * `max-age=3600` keeps it), a `cache: "reload"` request reaches the restarted gateway.
 */
function staleCreationFetch(asked, restarted = true) {
  const answer = (withFlags) => ({
    races: [{ id: 1, name: "Человек", clientFileString: "Human" }],
    classes: [{ id: 13, name: "Герой", fileName: "HERO", ...(withFlags ? { flags: 0x3a, spellClassSet: 10 } : {}) }],
  });
  return async (url, init) => {
    const text = String(url);
    asked.push([text, init?.cache ?? "default"]);
    if (!text.includes("/dbc/character-creation?v=4")) return new Response("", { status: 404 });
    return Response.json(answer(restarted && init?.cache === "reload"));
  };
}

test("1.15/1.14b review: a cached pre-restart ?v=4 answer without class flags is asked once more past the cache", async () => {
  const { ensureFrameXmlCreationNames } = await import("../dist/code/browser/framexml/FrameXmlCharacterStats.js");
  const { classFlags, classSpellFamily } = await import("../dist/code/browser/ui/UnitSnapshot.js");
  const asked = [];
  assert.equal(await ensureFrameXmlCreationNames("http://127.0.0.1:8090", staleCreationFetch(asked)), true);
  assert.deepEqual(asked.map(([, cache]) => cache), ["default", "reload"]);
  assert.equal(classFlags(13), 0x3a, "HERO's relic-slot flag from the restarted gateway");
  assert.equal(classSpellFamily(13), 10);

  const { GlueGatewayNames } = await import("../dist/code/browser/glue/GlueNames.js");
  const previousFetch = globalThis.fetch;
  const glueAsked = [];
  globalThis.fetch = staleCreationFetch(glueAsked);
  try {
    const names = new GlueGatewayNames("http://127.0.0.1:8090");
    await names.load();
    assert.deepEqual(glueAsked.filter(([url]) => url.includes("character-creation")).map(([, cache]) => cache),
      ["default", "reload"]);
    assert.equal(names.tables().classes[0].flags, 0x3a);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("1.15/1.14b review: against a gateway that really is old the reload is one request and the answer stands", async () => {
  const { GlueGatewayNames } = await import("../dist/code/browser/glue/GlueNames.js");
  const previousFetch = globalThis.fetch;
  const asked = [];
  globalThis.fetch = staleCreationFetch(asked, false);
  try {
    const names = new GlueGatewayNames("http://127.0.0.1:8090");
    await names.load();
    assert.deepEqual(asked.filter(([url]) => url.includes("character-creation")).map(([, cache]) => cache),
      ["default", "reload"]);
    assert.equal(names.className(13), "Герой", "the old shape still names the class");
    assert.equal(names.tables().classes[0].flags, undefined);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("10.08: /dbc/realm-categories?v=1 serves Cfg_Categories rows; 400 another ?v=, 403 a foreign Origin", async () => {
  assert.equal(REALM_CATEGORIES_ROUTE_PATH, `/dbc/realm-categories?v=${REALM_CATEGORIES_VERSION}`);
  assert.ok(CATALOG_ROUTES.some(({ pathname, version }) => pathname === "/dbc/realm-categories" && version === REALM_CATEGORIES_VERSION));
  // {ID, LocaleMask, Create_charset_mask, Flags, Name_lang[17]}: ruRU is slot 8 of the name.
  const row = (id, locales, charset, flags, ru, en = "") => {
    const words = new Array(21).fill(0);
    words[0] = id; words[1] = locales; words[2] = charset; words[3] = flags; words[4] = en; words[4 + 8] = ru;
    return words;
  };
  await withDirectory({
    "Cfg_Categories.dbc": wdbc(21, [row(1, 0, 0, 0, "Разработка"), row(12, 256, 4, 0, "Русский"), row(5, 1, 1, 1, "", "Tournament")]),
  }, (directory) => withCatalogServer(directory, async (base) => {
    const ok = await fetch(`${base}${REALM_CATEGORIES_ROUTE_PATH}`, { headers: { origin: ORIGIN } });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("cache-control"), "no-store");
    const body = await ok.json();
    assert.deepEqual(body, { version: 1, categories: [
      [1, 0, 0, 0, "Разработка"], [12, 256, 4, 0, "Русский"], [5, 1, 1, 1, "Tournament"],
    ] });
    assert.equal(realmCategoryTableFrom(body)?.get(12)?.name, "Русский");
    assert.equal((await fetch(`${base}/dbc/realm-categories?v=2`, { headers: { origin: ORIGIN } })).status, 400);
    assert.equal((await fetch(`${base}${REALM_CATEGORIES_ROUTE_PATH}`, { headers: { origin: "http://evil.test" } })).status, 403);
  }));
});

test("1.14b/2.05: /dbc/spells rows carry the friendly range, the raw target columns, the attributes and itemOrObject", async () => {
  const { parseSpellMetadata } = await import("../dist/code/gateway/SpellMetadata.js");
  const spell = (id, fill) => { const row = new Array(234).fill(0); row[0] = id; row[133] = 1; row[144] = `Заклинание ${id}`; fill(row); return row; };
  const rows = [
    // Pick Lock: OPEN_LOCK (33) with ImplicitTargetA 26, Targets 0, range row 159.
    spell(1804, (row) => { row[71] = 33; row[86] = 26; row[46] = 159; row[4] = 0x10; row[10] = 0x1000000; }),
    // Opening: OPEN_LOCK with target 23 (the object-click autocast) — no cursor.
    spell(3365, (row) => { row[71] = 33; row[86] = 23; row[16] = 0x4000; }),
    // A heal: A = 21 in effect 1, B = 22, Targets 0x100, TargetCreatureType 0x40.
    spell(2050, (row) => { row[72] = 10; row[87] = 21; row[90] = 22; row[16] = 0x100; row[17] = 0x40; row[46] = 167; }),
  ];
  const ranges = wdbc(40, [
    [159, { float: 0 }, { float: 0 }, { float: 40 }, { float: 100 }, 0],
    [167, { float: 40 }, { float: 0 }, { float: 150 }, { float: 150 }, 0],
  ]);
  const metadata = parseSpellMetadata(wdbc(234, rows), wdbc(2, [[1, "Interface\Icons\X"]]), undefined, undefined, undefined,
    undefined, ranges);
  const pick = metadata.get(1804);
  assert.equal(pick.itemOrObject, true);
  assert.deepEqual([pick.rangeMin, pick.rangeMax, pick.rangeMinFriendly, pick.rangeMaxFriendly], [0, 40, 0, 100]);
  assert.deepEqual(pick.implicitTargetA, [26, 0, 0]);
  assert.deepEqual(pick.attributes, [0x10, 0, 0, 0, 0, 0, 0x1000000, 0]);
  assert.equal(metadata.get(3365).itemOrObject, false);
  assert.equal(metadata.get(3365).targets, 0x4000);
  const heal = metadata.get(2050);
  assert.deepEqual([heal.targets, heal.targetCreatureType], [0x100, 0x40]);
  assert.deepEqual([heal.implicitTargetA, heal.implicitTargetB], [[0, 21, 0], [0, 22, 0]]);
  assert.deepEqual([heal.rangeMin, heal.rangeMinFriendly, heal.rangeMax, heal.rangeMaxFriendly], [40, 0, 150, 150]);
});

test("2.05: /dbc/item-enchantments rows carry SpellItemEnchantment.Flags (field 32)", async () => {
  const { readItemEnchantments } = await import("../dist/code/gateway/ItemEnchantments.js");
  const row = (id, flags) => { const words = new Array(38).fill(0); words[0] = id; words[14 + 8] = `Чары ${id}`; words[32] = flags; return words; };
  const rows = readItemEnchantments(wdbc(38, [row(1, 1), row(2, 0)]));
  assert.deepEqual(rows.map((entry) => [entry.id, entry.flags, entry.name]), [[1, 1, "Чары 1"], [2, 0, "Чары 2"]]);
});
