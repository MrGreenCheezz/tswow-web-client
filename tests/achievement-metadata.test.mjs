import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACHIEVEMENT_CATALOG_VERSION, ACHIEVEMENT_CATEGORY_LAYOUT, ACHIEVEMENT_CRITERIA_LAYOUT, ACHIEVEMENT_LAYOUT,
  loadAchievementCatalog,
} from "../dist/code/gateway/AchievementMetadata.js";
import { startGateway } from "../dist/code/gateway/Gateway.js";
import { dbcDirectory } from "../tools/paths.mjs";

// The /dbc/achievements catalog (src/gateway/AchievementMetadata.ts): the three tables read with
// fixed 12340 layouts checked against the file header, the ruRU column chosen, SpellIcon resolved,
// and the route served in-process with its origin check, version check and validator.

/** A WDBC file of `fieldCount` words per row; `rows` are sparse {word: value} maps, strings interned. */
function dbc(fieldCount, rows) {
  const strings = ["\0"];
  const offsetOf = new Map();
  const intern = (text) => {
    if (!offsetOf.has(text)) {
      offsetOf.set(text, Buffer.byteLength(strings.join(""), "utf8"));
      strings.push(`${text}\0`);
    }
    return offsetOf.get(text);
  };
  const block = rows.map((row) => Object.entries(row).map(([word, value]) => [Number(word), typeof value === "string" ? intern(value) : value]));
  const text = Buffer.from(strings.join(""), "utf8");
  const size = fieldCount * 4;
  const data = Buffer.alloc(20 + rows.length * size + text.length);
  data.write("WDBC");
  data.writeUInt32LE(rows.length, 4);
  data.writeUInt32LE(fieldCount, 8);
  data.writeUInt32LE(size, 12);
  data.writeUInt32LE(text.length, 16);
  block.forEach((row, index) => { for (const [word, value] of row) data.writeInt32LE(value, 20 + index * size + word * 4); });
  text.copy(data, 20 + rows.length * size);
  return data;
}

test("the three tables are read with their fixed 12340 layouts, ruRU first, icons resolved", async () => {
  const root = await mkdtemp(join(tmpdir(), "achievement-dbc-"));
  const A = ACHIEVEMENT_LAYOUT;
  const C = ACHIEVEMENT_CATEGORY_LAYOUT;
  const K = ACHIEVEMENT_CRITERIA_LAYOUT;
  try {
    await writeFile(join(root, "Achievement.dbc"), dbc(A.fieldCount, [
      { [A.id]: 7, [A.faction]: -1, [A.instance]: -1, [A.supercedes]: 6, [A.title + 8]: "20-й уровень", [A.title]: "Level 20",
        [A.description + 8]: "Достигните 20-го уровня.", [A.category]: 92, [A.points]: 10, [A.uiOrder]: 2, [A.flags]: 4,
        [A.icon]: 3269, [A.reward]: "Reward only in enUS", [A.minimumCriteria]: 0, [A.sharesCriteria]: 0 },
      { [A.id]: 0 },
    ]));
    await writeFile(join(root, "Achievement_Category.dbc"), dbc(C.fieldCount, [
      { [C.id]: 92, [C.parent]: -1, [C.name + 8]: "Общее", [C.uiOrder]: 1 },
    ]));
    await writeFile(join(root, "Achievement_Criteria.dbc"), dbc(K.fieldCount, [
      { [K.id]: 35, [K.achievement]: 7, [K.type]: 5, [K.asset]: 0, [K.quantity]: 20, [K.description + 8]: "Достигните 20-го уровня",
        [K.flags]: 2, [K.timerStartEvent]: 0, [K.timerAsset]: 0, [K.timerTime]: 0, [K.uiOrder]: 1 },
    ]));
    // No SpellIcon.dbc here: the icon is "" and the browser shows the question mark.
    assert.deepEqual(await loadAchievementCatalog(root, "ruRU"), {
      version: ACHIEVEMENT_CATALOG_VERSION,
      categories: [[92, -1, "Общее", 1]],
      achievements: [[7, -1, -1, 6, "20-й уровень", "Достигните 20-го уровня.", 92, 10, 2, 4, "", "Reward only in enUS", 0, 0]],
      criteria: [[35, 7, 5, 0, 20, "Достигните 20-го уровня", 2, 0, 0, 0, 1]],
    });
    // A table with another row width is refused, not misread.
    await writeFile(join(root, "Achievement_Category.dbc"), dbc(C.fieldCount + 1, [{ 0: 92 }]));
    await assert.rejects(loadAchievementCatalog(root, "ruRU"), /Achievement_Category: 21 fields of 84 bytes, expected 20 of 80/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the dataset's catalog: every table, measured", async () => {
  const catalog = await loadAchievementCatalog(dbcDirectory(), "ruRU");
  assert.equal(catalog.achievements.length, 1817);
  assert.equal(catalog.categories.length, 86);
  assert.equal(catalog.criteria.length, 7655);
  assert.deepEqual(catalog.achievements.find((row) => row[0] === 6),
    [6, -1, -1, 0, "10-й уровень", "Достигните 10-го уровня.", 92, 10, 1, 4, "Achievement_Level_10", "", 0, 0]);
  assert.deepEqual(catalog.categories.find((row) => row[0] === 1), [1, -1, "Статистика", 10]);
  assert.equal(catalog.achievements.filter((row) => row[10] === "").length, 87, "rows whose SpellIcon id has no row");
  console.log(`[achievements] catalog JSON ${Buffer.byteLength(JSON.stringify(catalog))} bytes`);
});

test("the /dbc/achievements route: origin, version, one build per dataset, 304 on its validator", async () => {
  const origin = "http://127.0.0.1:5173";
  const gateway = await startGateway({ host: "127.0.0.1", port: 0, auth: { host: "127.0.0.1", port: 1 },
    world: { host: "127.0.0.1", port: 1 }, allowedOrigins: [origin], dbcDirectory: dbcDirectory(), datasetPollMs: 0 });
  const url = `http://127.0.0.1:${gateway.port}/dbc/achievements`;
  try {
    assert.equal((await fetch(`${url}?v=1`)).status, 403);
    assert.equal((await fetch(`${url}?v=1`, { headers: { origin: "http://untrusted.invalid" } })).status, 403);
    assert.equal((await fetch(url, { headers: { origin } })).status, 400, "the shape version is required");
    assert.equal((await fetch(`${url}?v=2`, { headers: { origin } })).status, 400);
    const first = await fetch(`${url}?v=1`, { headers: { origin } });
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("access-control-allow-origin"), origin);
    assert.equal(first.headers.get("cache-control"), "public, max-age=0, must-revalidate");
    const body = await first.json();
    assert.equal(body.version, 1);
    assert.equal(body.achievements.length, 1817);
    const etag = first.headers.get("etag");
    const again = await fetch(`${url}?v=1`, { headers: { origin, "if-none-match": etag } });
    assert.equal(again.status, 304);
    assert.equal(again.headers.get("etag"), etag, "the same body: the index was built once");
  } finally {
    await gateway.close();
  }
});
