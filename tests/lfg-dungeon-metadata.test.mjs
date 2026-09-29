import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LFG_DUNGEON_CATALOG_VERSION, LFG_DUNGEON_GROUP_LAYOUT, loadLfgDungeonGroups, loadLfgDungeonMetadata,
} from "../dist/code/gateway/LfgDungeonMetadata.js";
import { startGateway } from "../dist/code/gateway/Gateway.js";
import { DBC_LAYOUTS } from "../dist/code/generated/dbcLayouts.js";
import { dbcDirectory } from "../tools/paths.mjs";

test("LFG names, levels and wire types follow the named 12340 DBC layout", async () => {
  const root = await mkdtemp(join(tmpdir(), "lfg-dbc-"));
  try {
    const layout = DBC_LAYOUTS.LFGDungeons;
    const strings = Buffer.from("\0Synthetic Dungeon\0Synthetic description\0", "utf8");
    const data = Buffer.alloc(20 + layout.recordSize * 3 + strings.length);
    data.write("WDBC"); data.writeUInt32LE(3, 4); data.writeUInt32LE(layout.fieldCount, 8);
    data.writeUInt32LE(layout.recordSize, 12); data.writeUInt32LE(strings.length, 16);
    const put = (row, name, value) => data.writeInt32LE(value, 20 + row * layout.recordSize + layout.fields[name].byteOffset);
    put(0, "ID", 258); put(0, "Name_lang", 1); put(0, "Description_lang", 19);
    put(0, "MinLevel", 70); put(0, "MaxLevel", 80); put(0, "TypeID", 6);
    put(0, "Difficulty", 1); put(0, "ExpansionLevel", 2);
    put(0, "Target_level", 80); put(0, "Target_level_min", 79); put(0, "Target_level_max", 81);
    put(0, "Group_ID", 5); put(0, "Flags", 3); put(0, "Faction", -1); put(0, "Order_index", 4);
    put(1, "ID", 0x01000000); put(1, "TypeID", 1);
    put(2, "ID", 14); put(2, "TypeID", 256);
    strings.copy(data, 20 + layout.recordSize * 3);
    await writeFile(join(root, "LFGDungeons.dbc"), data);
    // No LFGDungeonGroup.dbc or Map.dbc here: the catalog still loads, with no headers and no sizes.
    assert.deepEqual(await loadLfgDungeonMetadata(root), { version: 2, groups: [], dungeons: [{ id: 258,
      name: "Synthetic Dungeon", minLevel: 70, maxLevel: 80, type: 6, difficulty: 1, expansion: 2,
      description: "Synthetic description", texture: "", mapId: 0, targetLevel: 80, targetLevelMin: 79,
      targetLevelMax: 81, groupId: 5, flags: 3, faction: -1, orderIndex: 4, maxPlayers: 0 }] });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("LFG catalog reads the local dataset without exporting DBC files", async () => {
  const { dungeons } = await loadLfgDungeonMetadata(dbcDirectory());
  assert.ok(dungeons.length > 20);
  assert.ok(dungeons.every(entry => entry.id > 0 && entry.id <= 0xffffff && typeof entry.name === "string"));
  assert.ok(dungeons.some(entry => entry.name && entry.type === 6));
  assert.equal(new Set(dungeons.map(entry => entry.id)).size, dungeons.length);
});

test("LFG catalog HTTP route rejects other origins and caches metadata per gateway", async () => {
  const origin = "http://127.0.0.1:5173";
  const gateway = await startGateway({ host: "127.0.0.1", port: 0, auth: { host: "127.0.0.1", port: 1 },
    world: { host: "127.0.0.1", port: 1 }, allowedOrigins: [origin], dbcDirectory: dbcDirectory(), datasetPollMs: 0 });
  const url = `http://127.0.0.1:${gateway.port}/dbc/lfg-dungeons`;
  try {
    assert.equal((await fetch(url)).status, 403);
    assert.equal((await fetch(url, { headers: { origin: "http://untrusted.invalid" } })).status, 403);
    const first = await fetch(url, { headers: { origin } });
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("access-control-allow-origin"), origin);
    // Version 2 changed the body under the same path: revalidate every time, answer 304 when unchanged.
    assert.equal(first.headers.get("cache-control"), "public, max-age=0, must-revalidate");
    const etag = first.headers.get("etag");
    assert.match(etag ?? "", /^"[0-9a-f]{40}"$/);
    const body = await first.json();
    assert.equal(body.version, LFG_DUNGEON_CATALOG_VERSION);
    assert.ok(body.dungeons.length > 20);
    assert.ok(body.groups.length > 0);
    assert.deepEqual(await (await fetch(`${url}?v=2`, { headers: { origin } })).json(), body,
      "the client's ?v= key reaches the same route");
    const revalidated = await fetch(url, { headers: { origin, "if-none-match": etag } });
    assert.equal(revalidated.status, 304);
    assert.equal(revalidated.headers.get("etag"), etag);
  } finally { await gateway.close(); }
});

test("LFGDungeonGroup follows the hand-written 12340 definition and the dataset header", async () => {
  const { loadDbdLayout } = await import("../tools/dbd.mjs");
  const { WOTLK_BUILD } = await import("../tools/dbc.mjs");
  const layout = await loadDbdLayout("LFGDungeonGroup", WOTLK_BUILD);
  assert.equal(layout.fieldCount, LFG_DUNGEON_GROUP_LAYOUT.fieldCount);
  assert.equal(layout.recordSize, LFG_DUNGEON_GROUP_LAYOUT.recordSize);
  const offsets = Object.values(layout.fields).map((field) => [field.byteOffset, field.type]);
  assert.deepEqual(offsets, [[0, "int"], [4, "locstring"], [72, "int"], [76, "int"], [80, "int"]]);
  const groups = await loadLfgDungeonGroups(dbcDirectory());
  // Measured on this dataset: ten headers, Wrath heroic first and world events last.
  assert.deepEqual(groups.map((group) => [group.id, group.orderIndex, group.typeId]), [
    [5, 1, 5], [4, 2, 1], [3, 3, 5], [2, 4, 1], [1, 5, 1], [9, 17, 2], [8, 18, 2], [7, 19, 2], [6, 20, 2], [11, 21, 0],
  ]);
  assert.equal(groups.find((group) => group.id === 1)?.name, "Классические подземелья");
});

test("the dataset catalog carries the stock fields: 195 rows, the measured Group_ID histogram, map sizes", async () => {
  const { dungeons, groups, version } = await loadLfgDungeonMetadata(dbcDirectory());
  assert.equal(version, 2);
  assert.equal(dungeons.length, 195);
  const histogram = {};
  for (const row of dungeons) histogram[row.groupId] = (histogram[row.groupId] ?? 0) + 1;
  assert.deepEqual(histogram, { 0: 59, 1: 29, 2: 17, 3: 17, 4: 17, 5: 17, 6: 6, 7: 9, 8: 10, 9: 10, 11: 4 });
  assert.equal(groups.length, 10);
  const deadmines = dungeons.find((row) => row.id === 6);
  assert.deepEqual([deadmines.targetLevel, deadmines.targetLevelMin, deadmines.targetLevelMax, deadmines.groupId,
    deadmines.maxPlayers, deadmines.faction], [19, 17, 20, 1, 10, -1],
    "Map.dbc gives the Deadmines (map 36) the classic 10-player cap");
  assert.equal(dungeons.find((row) => row.id === 4).faction, 0, "Ragefire Chasm is the Horde's");
  assert.equal(dungeons.find((row) => row.id === 12).faction, 1, "the Stockade is the Alliance's");
  assert.equal(dungeons.filter((row) => (row.flags & 4) !== 0).length, 4, "four seasonal world-event bosses");
  // Map.MaxPlayers verbatim, measured: Wrath raids read 0 or 5 there (their sizes are per-difficulty
  // MapDifficulty rows); the stock LFD list never reads maxPlayers, only the absent raid browser would.
  const sizes = {};
  for (const row of dungeons) sizes[`${row.type}:${row.maxPlayers}`] = (sizes[`${row.type}:${row.maxPlayers}`] ?? 0) + 1;
  assert.deepEqual(sizes, { "1:10": 22, "1:5": 37, "1:0": 5, "2:40": 5, "2:25": 9, "2:20": 2, "2:10": 3, "2:5": 4,
    "2:0": 12, "4:0": 59, "5:5": 27, "5:0": 5, "6:0": 5 });
});
