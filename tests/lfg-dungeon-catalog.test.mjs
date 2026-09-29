import assert from "node:assert/strict";
import test from "node:test";

import {
  LFG_DUNGEON_CATALOG_VERSION,
  LfgDungeonClient,
  lfgStockCatalog,
  filterLfgDungeons,
  groupLfgDungeons,
  isSpecificLfgDungeon,
  lfgDungeonBackgroundPath,
  lfgDungeonEntry,
  lfgDungeonHeroic,
  lfgEntriesForSelection,
  parseManualDungeonIds,
  setVisibleLfgSelection,
} from "../dist/code/browser/LfgDungeons.js";

const catalog = Object.freeze([
  Object.freeze({ id: 258, name: "Наксрамас", minLevel: 80, maxLevel: 80, type: 6, difficulty: 1, expansion: 2, description: "" }),
  Object.freeze({ id: 259, name: "Окулус", minLevel: 80, maxLevel: 80, type: 1, difficulty: 0, expansion: 2, description: "" }),
]);

test("dungeon entries keep the queue type explicit for CMSG_LFG_JOIN", () => {
  assert.equal(lfgDungeonEntry({ id: 258, type: 6 }), 258 | (6 << 24));
  assert.equal(lfgDungeonEntry({ id: 259, type: 1 }), 259 | (1 << 24));
  // The server masks the slot before the DBC lookup, so the entry and the plain id agree.
  assert.equal(lfgDungeonEntry({ id: 258, type: 6 }) & 0x00ffffff, 258);
});

test("specific catalog selection drops random and unknown ids", () => {
  assert.deepEqual(lfgEntriesForSelection(catalog, new Set([259, 258])), [
    lfgDungeonEntry({ id: 259, type: 1 }),
  ]);
  assert.deepEqual(lfgEntriesForSelection(catalog, new Set([999999])), []);
  assert.deepEqual(lfgEntriesForSelection(catalog, new Set()), []);
});

test("heroic badge and banner path follow the stock DBC rules", () => {
  assert.equal(lfgDungeonHeroic({ type: 5, difficulty: 0 }), true);
  assert.equal(lfgDungeonHeroic({ type: 1, difficulty: 1 }), true);
  assert.equal(lfgDungeonHeroic({ type: 1, difficulty: 0 }), false);
  assert.equal(
    lfgDungeonBackgroundPath("DEADMINES"),
    "Interface\\LFGFrame\\UI-LFG-BACKGROUND-DEADMINES.blp",
  );
  assert.equal(lfgDungeonBackgroundPath(""), undefined);
  assert.equal(lfgDungeonBackgroundPath(undefined), undefined);
  assert.equal(lfgDungeonBackgroundPath("../escape"), undefined);
});

const mixed = Object.freeze([
  Object.freeze({ id: 10, name: "Deadmines", minLevel: 15, maxLevel: 21, type: 1, difficulty: 0, expansion: 0, description: "" }),
  Object.freeze({ id: 20, name: "Scarlet Monastery", minLevel: 26, maxLevel: 45, type: 1, difficulty: 0, expansion: 0, description: "" }),
  Object.freeze({ id: 30, name: "The Nexus", minLevel: 71, maxLevel: 73, type: 1, difficulty: 1, expansion: 2, description: "" }),
  Object.freeze({ id: 40, name: "Utgarde Pinnacle", minLevel: 75, maxLevel: 80, type: 1, difficulty: 0, expansion: 2, description: "" }),
]);
const base = { query: "", expansion: "all", heroicOnly: false, levelOnly: false, playerLevel: 40, sort: "name" };

test("specific pane admits normal and heroic dungeons, never zone, raid or random rows", () => {
  const rows = [
    { id: 58, name: "Элвиннский лес", minLevel: 1, maxLevel: 14, type: 4 },
    { id: 6, name: "Мертвые копи", minLevel: 15, maxLevel: 25, type: 1 },
    { id: 124, name: "Героический dungeon", minLevel: 70, maxLevel: 80, type: 5 },
    { id: 259, name: "Рейд", minLevel: 80, maxLevel: 80, type: 2 },
    { id: 258, name: "Случайное подземелье", minLevel: 15, maxLevel: 58, type: 6 },
  ].map((row) => ({ ...row, difficulty: 0, expansion: 0, description: "" }));
  assert.deepEqual(rows.filter(isSpecificLfgDungeon).map((row) => row.id), [6, 124]);
  assert.deepEqual(filterLfgDungeons(rows, { ...base, playerLevel: 5, levelOnly: true }), [],
    "a level-5 player has no specific dungeon; the matching level-1 zone is not a dungeon");
  assert.deepEqual(filterLfgDungeons(rows, { ...base, playerLevel: 80 }).map((row) => row.id), [124, 6]);
  assert.deepEqual(lfgEntriesForSelection(rows, new Set(rows.map((row) => row.id))), [
    lfgDungeonEntry(rows[1]), lfgDungeonEntry(rows[2]),
  ]);
});

test("the filter keeps the era, the heroic tier and a fitting level, and sorts deterministically", () => {
  assert.deepEqual(filterLfgDungeons(mixed, base).map((row) => row.id), [10, 20, 30, 40],
    "an unfiltered list is name-ordered");
  assert.deepEqual(filterLfgDungeons(mixed, { ...base, expansion: 2 }).map((row) => row.id), [30, 40]);
  assert.deepEqual(filterLfgDungeons(mixed, { ...base, heroicOnly: true }).map((row) => row.id), [30],
    "difficulty or type 5 is what heroic means");
  assert.deepEqual(filterLfgDungeons(mixed, { ...base, levelOnly: true }).map((row) => row.id), [20],
    "a level-40 character fits neither Northrend row and no longer fits Deadmines");
  assert.deepEqual(filterLfgDungeons(mixed, { ...base, query: "nex" }).map((row) => row.id), [30]);
  assert.deepEqual(filterLfgDungeons(mixed, { ...base, sort: "level" }).map((row) => row.id), [10, 20, 30, 40]);
  // The name stays the tiebreak when two rows share a level, and the id settles identical names.
  const tied = Object.freeze([
    Object.freeze({ ...mixed[0], id: 11, name: "B" , minLevel: 15 }),
    Object.freeze({ ...mixed[1], id: 12, name: "A", minLevel: 15 }),
  ]);
  assert.deepEqual(filterLfgDungeons(tied, { ...base, sort: "level" }).map((row) => row.id), [12, 11]);
});

test("grouping keeps the era order and select-visible acts on exactly the shown rows", () => {
  const groups = groupLfgDungeons(filterLfgDungeons(mixed, base));
  assert.deepEqual(groups.map((group) => group.name), ["Классика", "Wrath of the Lich King"]);
  assert.deepEqual(groups.map((group) => group.dungeons.length), [2, 2]);

  const selection = new Set([999]);
  setVisibleLfgSelection(selection, mixed.slice(0, 2), true);
  assert.deepEqual([...selection].sort((a, b) => a - b), [10, 20, 999]);
  setVisibleLfgSelection(selection, mixed, false);
  assert.deepEqual([...selection], [999], "clearing visible rows leaves selections outside the list alone");
});

test("manual ids stay a fallback: parsed, deduplicated, invalid parts dropped", () => {
  assert.deepEqual(parseManualDungeonIds("258, 259,258"), [258, 259]);
  assert.deepEqual(parseManualDungeonIds("  "), []);
  assert.deepEqual(parseManualDungeonIds("abc, -1, 0, 12.5"), []);
});

test("the dungeon client shares one request and freezes the catalog", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const urls = [];
  const requests = [];
  const body = { dungeons: [...catalog] };
  globalThis.fetch = async (url, init) => {
    urls.push(String(url));
    requests.push(init);
    return { ok: true, json: async () => body };
  };

  const client = new LfgDungeonClient("http://127.0.0.1:8090");
  const [first, second] = await Promise.all([client.load(), client.load()]);
  assert.equal(first, second);
  assert.equal(client.catalog, first);
  assert.equal(client.ready, true);
  // The catalog shape version rides as ?v= and every open revalidates against the gateway's ETag,
  // so a body cached from a version-1 gateway (max-age=3600) is never taken for version 2.
  assert.deepEqual(urls, [`http://127.0.0.1:8090/dbc/lfg-dungeons?v=${LFG_DUNGEON_CATALOG_VERSION}`]);
  assert.equal(LFG_DUNGEON_CATALOG_VERSION, 2);
  assert.equal(requests[0].cache, "no-cache");
  assert.equal(Object.isFrozen(first), true);
  assert.equal(client.stock, undefined, "a version-1 body carries no group headers: no stock catalog");
  assert.equal(await client.load(), first);
  assert.equal(urls.length, 1);
});

test("the dungeon client reports a malformed catalog once and does not hammer it", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { ok: true, json: async () => ({ dungeons: [{ id: 258 }] }) };
  };

  const statuses = [];
  const client = new LfgDungeonClient("http://127.0.0.1:8090");
  client.onStatus = (message, error) => statuses.push([message, error]);
  assert.equal(await client.load(), undefined);
  assert.equal(client.ready, false);
  assert.match(statuses[0][0], /malformed lfg dungeon/);
  assert.equal(statuses[0][1], true);
  assert.equal(await client.load(), undefined);
  assert.equal(calls, 1);
});

const v2Row = (id, groupId, type = 1) => ({
  id, name: `D${id}`, minLevel: 55, maxLevel: 65, type, difficulty: 0, expansion: 0, description: "",
  texture: "", mapId: 0, targetLevel: 60, targetLevelMin: 58, targetLevelMax: 62, groupId, flags: 3,
  faction: -1, orderIndex: 0, maxPlayers: 5,
});

test("a version-2 body carries group headers and every stock field; anything less is not stock-ready", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const groups = [{ id: 1, name: "Классические подземелья", orderIndex: 5, parentGroupId: 0, typeId: 1 }];
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ version: 2, dungeons: [v2Row(2, 1), v2Row(258, 1, 6)], groups }) });
  const client = new LfgDungeonClient("http://127.0.0.1:8090");
  await client.load();
  assert.deepEqual(client.groups, groups);
  assert.ok(Object.isFrozen(client.groups));
  assert.equal(client.stock?.dungeons, client.catalog);
  assert.equal(client.stock?.groups, client.groups);
  // One row without a version-2 field, or no headers, and the stock finder must not publish.
  const { groupId: _dropped, ...partial } = v2Row(40, 1);
  assert.equal(lfgStockCatalog([v2Row(2, 1), partial], groups), undefined);
  assert.equal(lfgStockCatalog([v2Row(2, 1)], []), undefined);
  assert.equal(lfgStockCatalog(undefined, groups), undefined);
  assert.ok(lfgStockCatalog([v2Row(2, 1)], groups));
});

test("malformed group headers read as none rather than half a list", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ dungeons: [v2Row(2, 1)],
    groups: [{ id: 1, name: "ok", orderIndex: 5, parentGroupId: 0, typeId: 1 }, { id: "x" }] }) });
  const client = new LfgDungeonClient("http://127.0.0.1:8090");
  await client.load();
  assert.equal(client.ready, true, "the version-1 rows still load for the native window");
  assert.deepEqual(client.groups, []);
  assert.equal(client.stock, undefined);
});
