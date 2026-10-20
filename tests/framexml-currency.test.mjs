import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

// Merged 2026-10-20 from 2 files; each block below is one former file,
// kept in its own scope so its helpers and module loads stay as they were.

// ── framexml-currency.test.mjs
{
// The currency C API behind stock Blizzard_TokenUI (FrameXmlCurrency.ts): the gateway's CurrencyTypes/
// CurrencyCategory catalog, the live snapshot of PLAYER_FIELD_KNOWN_CURRENCIES and the token slots, the
// exact stock tuples, the session view state (collapse, unused, backpack) and the held events.
const {
  FrameXmlCurrencyModel, FRAMEXML_CURRENCY_BINDINGS, parseFrameXmlCurrencyCatalog, frameXmlUnusedCurrencyCategory,
} = await import("../dist/code/browser/framexml/FrameXmlCurrency.js");
const { createCannedFrameXmlCurrency, FRAMEXML_CANNED_CURRENCY_CATALOG } =
  await import("../dist/code/browser/framexml/FrameXmlCurrencyCanned.js");
const { frameXmlCurrencySnapshot, createLiveFrameXmlCurrency, FrameXmlCurrencyCatalogClient } =
  await import("../dist/code/browser/framexml/FrameXmlCurrencyLive.js");
const { FRAMEXML_SEAM_BINDINGS, FRAMEXML_SEAM_NAMES } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { WorldState } = await import("../dist/code/world/WorldState.js");

const dataset = "F:/tswowRoot/tswow-install/modules/default/datasets/dataset/dbc";
const withDataset = { skip: existsSync(`${dataset}/CurrencyTypes.dbc`) ? false : "no dataset DBC on this machine" };

const call = (name, seam, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);

test("the catalog is the dataset's CurrencyTypes and CurrencyCategory, in record order", withDataset, async () => {
  const { loadCurrencyCatalog, parseCurrencyCatalog, CURRENCY_CATALOG_VERSION } =
    await import("../dist/code/gateway/CurrencyCatalog.js");
  const catalog = await loadCurrencyCatalog(dataset);
  assert.equal(catalog.version, CURRENCY_CATALOG_VERSION);
  // Measured on the tswow dataset (2026-09-26): 26 CurrencyTypes rows, 8 CurrencyCategory rows.
  assert.equal(catalog.types.length, 26);
  assert.equal(catalog.categories.length, 8);
  assert.deepEqual(catalog.categories.map((row) => row.id), [1, 2, 4, 21, 22, 23, 41, 3]);
  assert.deepEqual(catalog.categories.find((row) => row.id === 3), { id: 3, flags: 3, name: "Неактивно" });
  assert.equal(catalog.categories.find((row) => row.id === 22).name, "Подземелья и рейды");
  assert.deepEqual(catalog.types.find((row) => row.itemId === 43308), { id: 104, itemId: 43308, categoryId: 2, bitIndex: 13 });
  assert.deepEqual(catalog.types.find((row) => row.itemId === 43307), { id: 103, itemId: 43307, categoryId: 2, bitIndex: 12 });
  assert.deepEqual(catalog.types.find((row) => row.itemId === 40752), { id: 101, itemId: 40752, categoryId: 22, bitIndex: 10 });
  // Bits are unique: each is one PLAYER_FIELD_KNOWN_CURRENCIES flag.
  assert.equal(new Set(catalog.types.map((row) => row.bitIndex)).size, catalog.types.length);
  // The browser side accepts exactly what the gateway serializes, and the unused heading is «Неактивно».
  const parsed = parseFrameXmlCurrencyCatalog(JSON.parse(JSON.stringify(catalog)));
  assert.equal(parsed.types.length, 26);
  assert.equal(frameXmlUnusedCurrencyCategory(parsed), 3);
  // A wrong-sized table is refused, not half-read.
  assert.throws(() => parseCurrencyCatalog(readFileSync(`${dataset}/CurrencyCategory.dbc`), readFileSync(`${dataset}/CurrencyCategory.dbc`)), /CurrencyTypes/);
});

test("/dbc/currencies is origin-protected, versioned, uncached, and the browser client reads it", withDataset, async () => {
  // In process, on an ephemeral port; the realm addresses point nowhere and are never dialled.
  const { startGateway } = await import("../dist/code/gateway/Gateway.js");
  const origin = "http://127.0.0.1:5173";
  const gateway = await startGateway({
    host: "127.0.0.1", port: 0,
    auth: { host: "127.0.0.1", port: 1 }, world: { host: "127.0.0.1", port: 1 },
    allowedOrigins: [origin], dbcDirectory: dataset, datasetPollMs: 0,
  });
  const base = `http://127.0.0.1:${gateway.port}/dbc/currencies`;
  try {
    assert.equal((await fetch(`${base}?v=1`)).status, 403);
    assert.equal((await fetch(`${base}?v=2`, { headers: { origin } })).status, 400);
    const response = await fetch(`${base}?v=1`, { headers: { origin } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("access-control-allow-origin"), origin);
    void response.body?.cancel();
    const client = new FrameXmlCurrencyCatalogClient(`http://127.0.0.1:${gateway.port}`, (url) => fetch(url, { headers: { origin } }));
    let ready = 0;
    client.load(() => { ready += 1; });
    client.load(() => { ready += 1; });
    const catalog = await client.settled();
    assert.equal(ready, 1, "one fetch per mount");
    assert.equal(client.current, catalog);
    assert.equal(catalog.types.length, 26);
  } finally {
    await gateway.close();
  }
});

test("a gateway without the route (404) or a malformed body leaves the list without a catalog", async () => {
  const missing = new FrameXmlCurrencyCatalogClient("http://127.0.0.1:1", async () => new Response("", { status: 404 }));
  missing.load(() => assert.fail("no catalog"));
  assert.equal(await missing.settled(), undefined);
  assert.equal(missing.current, undefined);
  const hostile = new FrameXmlCurrencyCatalogClient("http://127.0.0.1:1", async () => Response.json({
    version: 1, categories: [{ id: 1, flags: 0 }], types: [],
  }));
  hostile.load(() => assert.fail("no catalog"));
  assert.equal(await hostile.settled(), undefined);
  assert.equal(parseFrameXmlCurrencyCatalog({ version: 2, categories: [], types: [] }), undefined);
});

test("the seam answers the six C functions with the stock tuples", () => {
  for (const name of ["GetCurrencyListSize", "GetCurrencyListInfo", "ExpandCurrencyList", "SetCurrencyUnused",
    "SetCurrencyBackpack", "GetBackpackCurrencyInfo"]) {
    assert.equal(typeof FRAMEXML_SEAM_BINDINGS[name], "function", name);
    assert.ok(FRAMEXML_SEAM_NAMES.includes(name), name);
  }
  // A seam without a model is a character with no currency.
  assert.deepEqual(call("GetCurrencyListSize", {}), [0]);
  assert.deepEqual(call("GetCurrencyListInfo", {}, 1), []);
  assert.deepEqual(call("GetBackpackCurrencyInfo", {}, 1), []);

  const seam = new CannedWorldSeam();
  // PvP heading, arena, honor; dungeon heading, heroism, valor. 37711 (bit 1) is not known.
  assert.deepEqual(call("GetCurrencyListSize", seam), [6]);
  assert.deepEqual(call("GetCurrencyListInfo", seam, 1), ["PvP", true, true, false, false]);
  assert.deepEqual(call("GetCurrencyListInfo", seam, 2), ["Очки арены", false, false, false, false, 0, 1, undefined, 43307]);
  assert.deepEqual(call("GetCurrencyListInfo", seam, 3), ["Очки чести", false, false, false, false, 1500, 2, undefined, 43308]);
  assert.deepEqual(call("GetCurrencyListInfo", seam, 4), ["Подземелья и рейды", true, true, false, false]);
  assert.deepEqual(call("GetCurrencyListInfo", seam, 5),
    ["Эмблема героизма", false, false, false, false, 12, 0, "Interface\\Icons\\Spell_Holy_ProclaimChampion", 40752]);
  assert.deepEqual(call("GetCurrencyListInfo", seam, 6)[5], 0, "a known currency with nothing held counts 0");
  assert.deepEqual(call("GetCurrencyListInfo", seam, 7), []);
  assert.deepEqual(call("GetCurrencyListInfo", seam, 0), []);
  assert.deepEqual(call("GetCurrencyListInfo", seam, "x"), []);
});

test("collapse, unused and backpack are the client's session view state", () => {
  const seam = new CannedWorldSeam();
  call("ExpandCurrencyList", seam, 1, 0);
  assert.deepEqual(call("GetCurrencyListSize", seam), [4], "the PvP heading hides its two rows");
  assert.deepEqual(call("GetCurrencyListInfo", seam, 1), ["PvP", true, false, false, false]);
  call("ExpandCurrencyList", seam, 3, 0);
  assert.deepEqual(call("GetCurrencyListSize", seam), [4], "a currency row is not a heading");
  call("ExpandCurrencyList", seam, 1, 1);
  assert.deepEqual(call("GetCurrencyListSize", seam), [6]);

  // Emblem of Valor → «Неактивно», which the table flags; it keeps its amount and leaves its heading.
  call("SetCurrencyUnused", seam, 6, 1);
  assert.deepEqual(call("GetCurrencyListSize", seam), [7]);
  assert.deepEqual(call("GetCurrencyListInfo", seam, 6), ["Неактивно", true, true, false, false]);
  assert.deepEqual(call("GetCurrencyListInfo", seam, 7).slice(0, 6), ["Эмблема доблести", false, false, true, false, 0]);
  call("SetCurrencyUnused", seam, 7, 0);
  assert.deepEqual(call("GetCurrencyListSize", seam), [6]);
  assert.deepEqual(call("GetCurrencyListInfo", seam, 6)[0], "Эмблема доблести");

  // The backpack: list order whatever the heading, and whatever order they were watched in.
  call("SetCurrencyBackpack", seam, 5, 1);
  call("SetCurrencyBackpack", seam, 3, 1);
  assert.deepEqual(call("GetCurrencyListInfo", seam, 3)[4], true);
  call("ExpandCurrencyList", seam, 1, 0);
  assert.deepEqual(call("GetBackpackCurrencyInfo", seam, 1), ["Очки чести", 1500, 2, undefined, 43308]);
  assert.deepEqual(call("GetBackpackCurrencyInfo", seam, 2),
    ["Эмблема героизма", 12, 0, "Interface\\Icons\\Spell_Holy_ProclaimChampion", 40752]);
  assert.deepEqual(call("GetBackpackCurrencyInfo", seam, 3), []);
  call("ExpandCurrencyList", seam, 1, 1);
  call("SetCurrencyBackpack", seam, 3, 0);
  assert.deepEqual(call("GetBackpackCurrencyInfo", seam, 1)[0], "Эмблема героизма");
  // Headings take neither flag.
  call("SetCurrencyBackpack", seam, 1, 1);
  call("SetCurrencyUnused", seam, 1, 1);
  assert.deepEqual(call("GetCurrencyListSize", seam), [6]);
  assert.deepEqual(call("GetBackpackCurrencyInfo", seam, 2), []);
});

test("a table without an unused heading refuses SetCurrencyUnused; an unnamed heading's currency is not listed", () => {
  const world = { knownMask: (1n << 9n) | (1n << 19n), honor: 0, arena: 0, held: new Map([[40752, 3]]) };
  const catalog = {
    version: 1,
    categories: [{ id: 22, flags: 0, name: "Подземелья и рейды" }],
    // 43949 names category 2089878896 in the dataset, which CurrencyCategory does not have.
    types: [{ id: 101, itemId: 40752, categoryId: 22, bitIndex: 10 }, { id: 141, itemId: 43949, categoryId: 2089878896, bitIndex: 20 }],
  };
  const model = new FrameXmlCurrencyModel({ catalog: () => catalog, snapshot: () => world, item: () => undefined });
  assert.equal(model.listSize(), 2);
  assert.deepEqual(model.listInfo(2), [undefined, false, false, false, false, 3, 0, undefined, 40752],
    "a name the item cache does not have yet is nil");
  model.setUnused(2, 1);
  assert.equal(model.listInfo(2)[3], false);
});

test("events wait for release, then follow the known set and the amounts", () => {
  const { model, world } = createCannedFrameXmlCurrency();
  const fired = [];
  let demanded = 0;
  model.onDemand = () => { demanded += 1; };
  model.attach({ fire: (event, ...args) => { fired.push([event, ...args]); return 1; } });
  model.tick();
  assert.deepEqual(fired, [], "held: MainMenuBar would call a TokenFrame_Update that is not loaded yet");
  assert.equal(demanded, 1, "a known currency asks for Blizzard_TokenUI");

  model.release();
  assert.deepEqual(fired, [["KNOWN_CURRENCY_TYPES_UPDATE"]]);
  model.tick();
  assert.equal(fired.length, 1, "nothing changed, nothing fires");
  world.held.set(40752, 13);
  model.tick();
  assert.deepEqual(fired.at(-1), ["CURRENCY_DISPLAY_UPDATE"]);
  world.honor = 1600;
  model.tick();
  assert.equal(fired.length, 3);
  // Bit 1 is 37711, whose heading «Разное» comes first: a new known type.
  world.knownMask |= 1n;
  model.tick();
  assert.deepEqual(fired.at(-1), ["KNOWN_CURRENCY_TYPES_UPDATE"]);
  assert.equal(model.listInfo(1)[0], "Разное");
  fired.length = 0;
  world.knownMask |= 1n << 5n;
  model.tick();
  assert.deepEqual(fired, [], "an unknown bit is no currency");
  // Moving a currency under «Неактивно» is not a new known type.
  model.setUnused(model.rows().findIndex((row) => row.type?.itemId === 40753) + 1, 1);
  model.tick();
  assert.deepEqual(fired, []);
  model.detach();
  world.held.set(40752, 20);
  model.tick();
  assert.deepEqual(fired, [], "detached: silent");
});

test("the live snapshot reads the known bits, the PvP totals and the 32 token slots", () => {
  const state = new WorldState();
  const object = (guid, typeId) => ({ guid, typeId, position: undefined, movementFlags: 0, updateFlags: 0,
    targetGuid: undefined, runSpeed: undefined, turnRate: undefined, motion: undefined, fields: new Map() });
  const setGuid = (fields, offset, value) => {
    fields.set(offset, Number(value & 0xffffffffn));
    fields.set(offset + 1, Number(value >> 32n));
  };
  assert.equal(frameXmlCurrencySnapshot(state), undefined, "no player, no list");
  const player = object(1n, 4);
  const first = object(10n, 1);
  const second = object(11n, 1);
  const pending = 12n;
  state.selfGuid = player.guid;
  for (const value of [player, first, second]) state.objects.set(value.guid, value);
  const slots = UPDATE_FIELDS.PLAYER_FIELD_CURRENCYTOKEN_SLOT_1.offset;
  setGuid(player.fields, slots, first.guid);
  setGuid(player.fields, slots + 31 * 2, second.guid);
  setGuid(player.fields, slots + 2, pending);
  first.fields.set(UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, 40752);
  first.fields.set(UPDATE_FIELDS.ITEM_FIELD_STACK_COUNT.offset, 25);
  second.fields.set(UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, 40752);
  // No ITEM_FIELD_STACK_COUNT: a single token.
  setGuid(player.fields, UPDATE_FIELDS.PLAYER_FIELD_KNOWN_CURRENCIES.offset, (1n << 9n) | (1n << 40n));
  player.fields.set(UPDATE_FIELDS.PLAYER_FIELD_HONOR_CURRENCY.offset, 4200);
  const snapshot = frameXmlCurrencySnapshot(state);
  assert.equal(snapshot.knownMask, (1n << 9n) | (1n << 40n));
  assert.equal(snapshot.honor, 4200);
  assert.equal(snapshot.arena, 0, "a field never sent on a present player is zero");
  assert.deepEqual([...snapshot.held], [[40752, 26]], "an item not arrived yet is not attributed");

  const model = createLiveFrameXmlCurrency({
    world: () => ({ state, itemTemplates: new Map([[40752, { name: "Эмблема героизма" }]]) }),
    itemTexture: (entry) => entry === 40752 ? "Interface\\Icons\\Spell_Holy_ProclaimChampion" : undefined,
  });
  model.catalogSource = { current: FRAMEXML_CANNED_CURRENCY_CATALOG, load: () => assert.fail("already here") };
  assert.deepEqual(model.listInfo(2), ["Эмблема героизма", false, false, false, false, 26, 0,
    "Interface\\Icons\\Spell_Holy_ProclaimChampion", 40752]);
});

test("the live catalog is fetched only once the player knows a currency; names are prefetched once", async () => {
  const state = new WorldState();
  const player = { guid: 1n, typeId: 4, fields: new Map() };
  state.selfGuid = 1n;
  state.objects.set(1n, player);
  const prefetched = [];
  let arrived;
  const model = createLiveFrameXmlCurrency({
    world: () => ({ state }),
    prefetchQuestMetadata: (items, spells, onChanged) => { prefetched.push([...items], [...spells]); arrived = onChanged; },
  });
  let loads = 0;
  let current;
  model.catalogSource = { get current() { return current; }, load: () => { loads += 1; } };
  model.tick();
  assert.equal(loads, 0, "a character with no currency fetches nothing");
  player.fields.set(UPDATE_FIELDS.PLAYER_FIELD_HONOR_CURRENCY.offset, 10);
  player.fields.set(UPDATE_FIELDS.PLAYER_FIELD_KNOWN_CURRENCIES.offset, 1 << 12);
  model.tick();
  assert.equal(loads, 1);
  current = FRAMEXML_CANNED_CURRENCY_CATALOG;
  model.tick();
  model.tick();
  assert.deepEqual(prefetched, [[43308], []], "one prefetch for the unnamed honor item");
  const fired = [];
  model.attach({ fire: (event) => { fired.push(event); return 1; } });
  model.release();
  arrived();
  model.tick();
  assert.deepEqual(fired, ["KNOWN_CURRENCY_TYPES_UPDATE", "CURRENCY_DISPLAY_UPDATE"], "the names' arrival repaints");
});
}

// ── framexml-currency-revision.test.mjs
{
// P1-17 (UI-7): the currency model rebuilds its list when its source's revision, its view state or its
// catalog moved, not on every tick and every C-API read; a source without a revision keeps the old
// rebuild-on-read behaviour. The live revision (CurrencyRevision) moves with the store's field edges.
const { FrameXmlCurrencyModel } = await import("../dist/code/browser/framexml/FrameXmlCurrency.js");
const { FRAMEXML_CANNED_CURRENCY_CATALOG, FRAMEXML_CANNED_CURRENCY_ITEMS, FRAMEXML_CANNED_CURRENCY_KNOWN } =
  await import("../dist/code/browser/framexml/FrameXmlCurrencyCanned.js");
const { CurrencyRevision, createLiveFrameXmlCurrency, FRAMEXML_CURRENCY_TOKEN_SLOTS } =
  await import("../dist/code/browser/framexml/FrameXmlCurrencyLive.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { WorldState } = await import("../dist/code/world/WorldState.js");
const { WorldStore } = await import("../dist/code/world/WorldStore.js");

/** A source over a plain world object, counting its reads; `revision` only when asked for. */
function countedSource({ withRevision = true, catalog = () => FRAMEXML_CANNED_CURRENCY_CATALOG } = {}) {
  const world = { knownMask: FRAMEXML_CANNED_CURRENCY_KNOWN, honor: 1500, arena: 0, held: new Map([[40752, 12]]) };
  const counts = { snapshot: 0, item: 0 };
  const state = { revision: 0 };
  const source = {
    catalog,
    snapshot: () => { counts.snapshot += 1; return { ...world, held: new Map(world.held) }; },
    item: (entry) => { counts.item += 1; return FRAMEXML_CANNED_CURRENCY_ITEMS.get(entry); },
    ...(withRevision ? { revision: () => state.revision } : {}),
  };
  return { source, world, counts, state };
}

function released(model) {
  const fired = [];
  model.attach({ fire: (event, ...args) => { fired.push([event, ...args]); return 1; } });
  model.release();
  return fired;
}

test("1000 ticks at one revision read the snapshot once; a moved revision rebuilds and fires", () => {
  const { source, world, counts, state } = countedSource();
  const model = new FrameXmlCurrencyModel(source);
  const fired = released(model);
  assert.deepEqual(fired, [["KNOWN_CURRENCY_TYPES_UPDATE"]]);
  counts.snapshot = 0;
  counts.item = 0;
  for (let index = 0; index < 1000; index++) model.tick();
  assert.equal(counts.snapshot, 0, "the release tick's build still stands");
  assert.equal(counts.item, 0);
  assert.equal(fired.length, 1);
  world.held.set(40752, 13);
  state.revision += 1;
  for (let index = 0; index < 1000; index++) model.tick();
  assert.equal(counts.snapshot, 1, "one rebuild for one edit");
  assert.deepEqual(fired.at(-1), ["CURRENCY_DISPLAY_UPDATE"]);
  assert.equal(fired.length, 2);
  assert.equal(model.listInfo(5)[5], 13);
});

test("20 GetCurrencyListInfo reads are one snapshot, not one per index", () => {
  const { source, counts, state } = countedSource();
  const model = new FrameXmlCurrencyModel(source);
  released(model);
  state.revision += 1;
  counts.snapshot = 0;
  const size = model.listSize();
  for (let index = 1; index <= 20; index++) model.listInfo(index);
  model.backpackInfo(1);
  assert.equal(model.hasCurrencies(), true);
  assert.equal(size, 6);
  assert.equal(counts.snapshot, 1);
});

test("ExpandCurrencyList, SetCurrencyUnused and SetCurrencyBackpack rebuild at an unchanged revision", () => {
  const { source } = countedSource();
  const reference = countedSource({ withRevision: false });
  const model = new FrameXmlCurrencyModel(source);
  const plain = new FrameXmlCurrencyModel(reference.source);
  const both = (name, ...args) => { model[name](...args); plain[name](...args); };
  released(model);
  assert.equal(model.listSize(), 6);
  both("expand", 1, 0);
  assert.equal(model.listSize(), 4, "collapse");
  assert.deepEqual(model.rows(), plain.rows());
  both("expand", 1, 1);
  both("setUnused", 6, 1);
  assert.equal(model.listSize(), 7, "unused heading");
  assert.deepEqual(model.rows(), plain.rows());
  both("setUnused", 7, 0);
  both("setBackpack", 5, 1);
  assert.equal(model.listInfo(5)[4], true, "watched");
  assert.deepEqual(model.backpackInfo(1), plain.backpackInfo(1));
  assert.deepEqual(model.rows(), plain.rows());
});

test("a catalog that arrives later is noticed without a revision change", () => {
  let catalog;
  const { source, counts } = countedSource({ catalog: undefined });
  delete source.catalog;
  const model = new FrameXmlCurrencyModel(source);
  let loads = 0;
  model.catalogSource = { get current() { return catalog; }, load: () => { loads += 1; } };
  const fired = released(model);
  assert.equal(loads, 1, "the player knows currencies: the one fetch starts");
  assert.equal(model.listSize(), 0);
  counts.snapshot = 0;
  for (let index = 0; index < 100; index++) model.tick();
  assert.equal(counts.snapshot, 0, "the catalog gate reads the kept snapshot");
  fired.length = 0;
  catalog = FRAMEXML_CANNED_CURRENCY_CATALOG;
  model.tick();
  assert.deepEqual(fired, [["KNOWN_CURRENCY_TYPES_UPDATE"]]);
  assert.equal(model.listSize(), 6);
});

test("a prefetch reporting names repaints with the new names at an unchanged revision", () => {
  const { source } = countedSource();
  const names = new Map();
  let report;
  source.item = (entry) => names.get(entry);
  source.prefetch = (_entries, onChanged) => { report = onChanged; };
  const model = new FrameXmlCurrencyModel(source);
  const fired = released(model);
  assert.equal(model.listInfo(5)[0], undefined);
  names.set(40752, { name: "Эмблема героизма" });
  report();
  model.tick();
  assert.deepEqual(fired.at(-1), ["CURRENCY_DISPLAY_UPDATE"]);
  assert.equal(model.listInfo(5)[0], "Эмблема героизма");
});

test("a source without revision rebuilds on every tick and read, as before", () => {
  const { source, counts } = countedSource({ withRevision: false });
  const model = new FrameXmlCurrencyModel(source);
  released(model);
  counts.snapshot = 0;
  for (let index = 0; index < 1000; index++) model.tick();
  assert.equal(counts.snapshot, 1000);
  counts.snapshot = 0;
  for (let index = 1; index <= 20; index++) model.listInfo(index);
  assert.equal(counts.snapshot, 20);
});

test("attach and release start the comparison again, so their first tick fires", () => {
  const { source } = countedSource();
  const model = new FrameXmlCurrencyModel(source);
  const fired = [];
  model.attach({ fire: (event, ...args) => { fired.push([event, ...args]); return 1; } });
  model.tick();
  model.tick();
  assert.deepEqual(fired, [], "held until release");
  model.release();
  assert.deepEqual(fired, [["KNOWN_CURRENCY_TYPES_UPDATE"]], "release fires though the build is the held one");
  model.tick();
  model.detach();
  const again = [];
  model.attach({ fire: (event) => { again.push(event); return 1; } });
  model.tick();
  assert.deepEqual(again, ["KNOWN_CURRENCY_TYPES_UPDATE"], "a reattached pump hears the known set");
  const direct = [];
  model.attach({ fire: (event) => { direct.push(event); return 1; } });
  model.tick();
  assert.deepEqual(direct, ["KNOWN_CURRENCY_TYPES_UPDATE"], "an attach without a detach before it, too");
  assert.equal(fired.length, 1);
});

test("rows() with the revision equal rows() without it over random edits", () => {
  const kept = countedSource();
  const plain = countedSource({ withRevision: false });
  const model = new FrameXmlCurrencyModel(kept.source);
  const reference = new FrameXmlCurrencyModel(plain.source);
  released(model);
  released(reference);
  let seed = 7;
  const random = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const bits = [0n, 9n, 10n, 11n, 12n];
  for (let step = 0; step < 300; step++) {
    const kind = random(6);
    const edit = (world) => {
      if (kind === 0) world.held.set(random(2) ? 40752 : 40753, random(50));
      else if (kind === 1) world.honor = random(5000);
      else if (kind === 2) world.arena = random(500);
      else if (kind === 3) world.knownMask ^= 1n << bits[random(bits.length)];
    };
    if (kind <= 3) {
      edit(kept.world);
      kept.state.revision += 1;
      // The same world on the reference side.
      Object.assign(plain.world, { ...kept.world, held: new Map(kept.world.held) });
    } else if (kind === 4) {
      const index = 1 + random(8);
      const flag = random(2);
      model.expand(index, flag);
      reference.expand(index, flag);
    } else {
      const index = 1 + random(8);
      const flag = random(2);
      const call = random(2) ? "setUnused" : "setBackpack";
      model[call](index, flag);
      reference[call](index, flag);
    }
    model.tick();
    reference.tick();
    assert.deepEqual(model.rows(), reference.rows(), `step ${step}`);
  }
});

// ---- the live revision -------------------------------------------------------------------

const ITEM = (n) => (0x4000n << 48n) | BigInt(n);
const lo = (guid) => Number(guid & 0xffffffffn);
const hi = (guid) => Number(guid >> 32n);

function liveWorld() {
  const state = new WorldState();
  const store = new WorldStore(state);
  state.selfGuid = 1n;
  const slot = UPDATE_FIELDS.PLAYER_FIELD_CURRENCYTOKEN_SLOT_1.offset;
  state.setField(1n, UPDATE_FIELDS.PLAYER_FIELD_KNOWN_CURRENCIES.offset, 1 << 9);
  state.setField(1n, slot, lo(ITEM(7)));
  state.setField(1n, slot + 1, hi(ITEM(7)));
  state.setField(ITEM(7), UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, 40752);
  state.setField(ITEM(7), UPDATE_FIELDS.ITEM_FIELD_STACK_COUNT.offset, 4);
  store.flush();
  // Count the subscriptions the revision holds on the store.
  const active = { count: 0 };
  for (const name of ["field", "fieldRange"]) {
    const original = store[name].bind(store);
    store[name] = (...args) => {
      const off = original(...args);
      active.count += 1;
      return () => { active.count -= 1; off(); };
    };
  }
  return { state, store, active, slot };
}

test("CurrencyRevision moves with the token slots, the known bits, honor, arena and the token items", () => {
  const live = liveWorld();
  const { state, store } = live;
  const clock = { now: 1_000 };
  const revision = new CurrencyRevision({ world: () => ({ state }), store: () => store, monotonic: () => clock.now });
  assert.equal(revision.revision(), undefined, "not attached: no revision");
  revision.attach();
  assert.equal(live.active.count, 0, "subscriptions are taken on the first read");
  let last = revision.revision();
  const held = live.active.count;
  assert.equal(typeof last, "number");
  assert.equal(revision.revision(), last, "nothing moved");
  const moved = (label, change) => {
    change();
    store.flush();
    const next = revision.revision();
    assert.notEqual(next, last, label);
    assert.ok(next > last, `${label}: monotonic`);
    last = next;
  };
  moved("token slot", () => state.setField(1n, live.slot + 2 * (FRAMEXML_CURRENCY_TOKEN_SLOTS - 1), 5));
  moved("known bits, high word", () => state.setField(1n, UPDATE_FIELDS.PLAYER_FIELD_KNOWN_CURRENCIES.offset + 1, 1));
  moved("honor", () => state.setField(1n, UPDATE_FIELDS.PLAYER_FIELD_HONOR_CURRENCY.offset, 900));
  moved("arena", () => state.setField(1n, UPDATE_FIELDS.PLAYER_FIELD_ARENA_CURRENCY.offset, 30));
  moved("token stack", () => state.setField(ITEM(7), UPDATE_FIELDS.ITEM_FIELD_STACK_COUNT.offset, 5));
  moved("a new item object", () => state.setField(ITEM(8), UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, 40753));
  state.setField(1n, UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 1234);
  store.flush();
  assert.equal(revision.revision(), last, "a field the list does not read");
  moved("the item cache's 60 ms poll", () => { clock.now += 60; });
  assert.ok(revision.subscriptions > 0);
  revision.detach();
  assert.equal(revision.revision(), undefined);
  assert.equal(revision.subscriptions, 0);
  assert.equal(live.active.count, held - 4, "the four currency subscriptions are gone");
});

test("with an item revision the clock does not move it; a store double without primitives has none", () => {
  const { state, store } = liveWorld();
  const clock = { now: 1_000 };
  let items = 3;
  const revision = new CurrencyRevision({
    world: () => ({ state }), store: () => store, monotonic: () => clock.now, itemRevision: () => items,
  });
  revision.attach();
  const first = revision.revision();
  clock.now += 10_000;
  assert.equal(revision.revision(), first);
  items += 1;
  assert.notEqual(revision.revision(), first);
  revision.detach();

  const double = { state, events: store.events };
  const none = new CurrencyRevision({ world: () => ({ state }), store: () => double, monotonic: () => clock.now });
  none.attach();
  assert.equal(none.revision(), undefined);
});

test("the live model keeps its rows between ticks and rebuilds on a flushed field edge", () => {
  const { state, store } = liveWorld();
  const clock = { now: 1_000 };
  const model = createLiveFrameXmlCurrency({
    world: () => ({ state }), store: () => store, monotonic: () => clock.now,
  });
  model.catalogSource = { current: FRAMEXML_CANNED_CURRENCY_CATALOG, load() {} };
  const fired = released(model);
  assert.deepEqual(fired, [["KNOWN_CURRENCY_TYPES_UPDATE"]]);
  const rows = model.rows();
  assert.equal(rows.find((row) => row.type?.itemId === 40752)?.count, 4);
  for (let index = 0; index < 50; index++) model.tick();
  assert.equal(model.rows(), rows, "the same build");
  state.setField(ITEM(7), UPDATE_FIELDS.ITEM_FIELD_STACK_COUNT.offset, 9);
  store.flush();
  model.tick();
  assert.deepEqual(fired.at(-1), ["CURRENCY_DISPLAY_UPDATE"]);
  assert.equal(model.rows().find((row) => row.type?.itemId === 40752)?.count, 9);
  model.detach();
});
}
