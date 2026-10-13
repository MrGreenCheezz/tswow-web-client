import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  indexCreatures, indexGmCatalog, indexItems, indexSpells, loadGmCatalog, matchRank, normalise, parseGmCatalog,
  searchIndex,
} from "../dist/code/gateway/GmSearch.js";
import {
  GM_QUICK_GROUPS, GM_TARGET_ACTIONS, GmFavorites, GmHistory, gmRowActions, goToCommand, itemCount, normaliseCommand,
} from "../dist/code/browser/ui/GmCommands.js";

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => void values.set(key, value), values };
}

const items = new Map([
  [25, { entry: 25, name: "Потрёпанный меч", displayId: 220, quality: 1, inventoryType: 13, stackable: 1, iconId: 7 }],
  [2000, { entry: 2000, name: "Меч", displayId: 221, quality: 2, inventoryType: 13, stackable: 1, iconId: 0 }],
  [3000, { entry: 3000, name: "Меч тьмы", displayId: 222, quality: 4, inventoryType: 17, stackable: 1, iconId: 0 }],
  [4000, { entry: 4000, name: "Тёмный меч тьмы", displayId: 223, quality: 3, inventoryType: 17, stackable: 1, iconId: 0 }],
  [252, { entry: 252, name: "Камень 25", displayId: 1, quality: 0, inventoryType: 0, stackable: 20, iconId: 0 }],
]);

test("normalise: case, ё and spacing do not matter", () => {
  assert.equal(normalise("  Тёмный   МЕЧ "), "темный меч");
});

test("matchRank orders whole name, prefix, word start, anywhere; every word must appear", () => {
  const words = (query) => query.split(" ");
  assert.equal(matchRank("меч", "меч", words("меч")), 0);
  assert.equal(matchRank("меч тьмы", "меч", words("меч")), 1);
  assert.equal(matchRank("потрепанный меч", "меч", words("меч")), 2);
  assert.equal(matchRank("мечта", "ечт", words("ечт")), 3);
  assert.equal(matchRank("меч", "меч тьмы", words("меч тьмы")), undefined);
});

test("item search: best match first, all words required, ё folded, digits also mean an id", () => {
  const list = indexItems(items);
  const byName = searchIndex(list, "меч", 10);
  assert.equal(byName.total, 4);
  assert.deepEqual(byName.rows.map((row) => row.id), [2000, 3000, 25, 4000]);
  assert.deepEqual(searchIndex(list, "МЕЧ ТЬМЫ", 10).rows.map((row) => row.id), [3000, 4000]);
  assert.deepEqual(searchIndex(list, "потрепанный", 10).rows.map((row) => row.id), [25], "ё in the table, е typed");
  const byId = searchIndex(list, "25", 10);
  assert.deepEqual(byId.rows.map((row) => row.id), [25, 252], "the id first, then names containing the digits");
  assert.deepEqual(byId.rows[0], { id: 25, name: "Потрёпанный меч", quality: 1, iconId: 7, displayId: 220, inventoryType: 13, stackable: 1 });
  assert.deepEqual(searchIndex(list, "   ", 10), { total: 0, rows: [] }, "an empty query lists nothing");
});

test("paging: limit is capped at a hundred and offset pages through the same order", () => {
  const many = new Map(Array.from({ length: 250 }, (_, index) => [index + 1, {
    entry: index + 1, name: `Камень ${index + 1}`, displayId: 1, quality: 0, inventoryType: 0, stackable: 1, iconId: 0,
  }]));
  const list = indexItems(many);
  const first = searchIndex(list, "камень", 1000);
  assert.equal(first.total, 250);
  assert.equal(first.rows.length, 100);
  const second = searchIndex(list, "камень", 100, 100);
  assert.notEqual(second.rows[0].id, first.rows[0].id);
  assert.equal(new Set([...first.rows, ...second.rows].map((row) => row.id)).size, 200);
});

test("creatures and spells carry what the console prints", () => {
  const creatures = indexCreatures(new Map([[123, { entry: 123, name: "Лесной волк", subname: "", type: 1, family: 1, rank: 0 }]]));
  assert.deepEqual(searchIndex(creatures, "волк", 5).rows, [{ id: 123, name: "Лесной волк", subname: "", type: 1, family: 1, rank: 0 }]);
  const spells = indexSpells(new Map([[133, {
    id: 133, name: "Огненный шар", rank: "Уровень 1", description: "x".repeat(300), auraDescription: "", iconId: 185,
    iconPath: "", passive: false, hidden: false, autoRepeat: false, displayInStanceBar: false, stanceBarOrder: 0,
  }]]));
  const [fireball] = searchIndex(spells, "огненный", 5).rows;
  assert.equal(fireball.id, 133);
  assert.equal(fireball.rank, "Уровень 1");
  assert.equal(fireball.iconId, 185);
  assert.equal(fireball.description.length, 240, "long descriptions are clipped for the list");
});

test("gm-catalog.json: parsed, searched, missing is undefined, malformed throws", async () => {
  const file = { version: 1, locale: "ruRU",
    quests: [[783, "Угроза изнутри", 1, 1]],
    teleports: [[1, "Stormwind", 0, -8833.38, 628.62, 94.0]],
    gameobjects: [[1731, "Медная жила", 3, 310]] };
  const index = indexGmCatalog(parseGmCatalog(file));
  assert.deepEqual(searchIndex(index.quest, "угроза", 5).rows, [{ id: 783, name: "Угроза изнутри", level: 1, minLevel: 1 }]);
  assert.deepEqual(searchIndex(index.tele, "storm", 5).rows, [{ id: 1, name: "Stormwind", map: 0, x: -8833.38, y: 628.62, z: 94 }]);
  assert.equal(searchIndex(index.gameobject, "жила", 5).rows[0].id, 1731);
  assert.throws(() => parseGmCatalog({ ...file, version: 2 }));
  assert.throws(() => parseGmCatalog({ ...file, quests: [[1, 2, 3, 4]] }));
  const directory = await mkdtemp(join(tmpdir(), "gm-catalog-"));
  try {
    assert.equal(await loadGmCatalog(join(directory, "absent.json")), undefined);
    await writeFile(join(directory, "gm-catalog.json"), JSON.stringify(file));
    assert.equal((await loadGmCatalog(join(directory, "gm-catalog.json"))).quests.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("row commands: the TrinityCore syntax of each handler, temporary spawns by default", () => {
  const commands = (kind, row, options) => gmRowActions(kind, row, options).map((action) => action.command);
  assert.deepEqual(commands("item", { id: 25, name: "Меч" }, { count: 20 }), [".additem 25 20"]);
  assert.deepEqual(commands("item", { id: 25, name: "Меч" }), [".additem 25 1"]);
  assert.deepEqual(commands("creature", { id: 123, name: "Волк" }),
    [".npc add temp loot 123", ".go creature id 123", ".npc add 123"]);
  const permanent = gmRowActions("creature", { id: 123, name: "Волк" }).at(-1);
  assert.match(permanent.confirm, /world-БД/, "the world-DB write asks first");
  assert.deepEqual(commands("spell", { id: 133, name: "Огненный шар" }),
    [".learn 133", ".unlearn 133", ".aura 133", ".unaura 133", ".cast 133", ".cast self 133"]);
  assert.deepEqual(commands("quest", { id: 783, name: "q" }),
    [".quest add 783", ".quest complete 783", ".quest reward 783", ".quest remove 783"]);
  assert.deepEqual(commands("tele", { id: 1, name: "Stormwind", map: 0, x: -8833.3812, y: 628.625, z: 94 }),
    [".go xyz -8833.38 628.63 94 0"]);
  assert.deepEqual(commands("gameobject", { id: 1731, name: "Жила" }), [".gobject add temp 1731", ".go gameobject id 1731"]);
});

test("every fixed button is a dot command; only the world-DB writes confirm", () => {
  const all = [...GM_QUICK_GROUPS.flatMap((group) => group.actions ?? []), ...GM_TARGET_ACTIONS];
  for (const action of all) assert.match(action.command, /^\.[a-z]/, action.label);
  for (const toggle of GM_QUICK_GROUPS.flatMap((group) => group.toggles ?? [])) {
    assert.match(toggle.on, /^\.[a-z]/, toggle.label);
    assert.match(toggle.off, /^\.[a-z]/, toggle.label);
    assert.notEqual(toggle.on, toggle.off, toggle.label);
  }
  assert.deepEqual(all.filter((action) => action.confirm).map((action) => action.command), [".npc delete"]);
});

test("itemCount, goToCommand and normaliseCommand", () => {
  assert.equal(itemCount(""), 1);
  assert.equal(itemCount("abc"), 1);
  assert.equal(itemCount("0"), 1);
  assert.equal(itemCount("7.9"), 7);
  assert.equal(itemCount(1e9), 10_000);
  assert.equal(goToCommand({ map: 1, x: 1.005, y: -2, z: 3 }), ".go xyz 1 -2 3 1");
  assert.equal(normaliseCommand("  gps "), ".gps");
  assert.equal(normaliseCommand(".gps"), ".gps");
  assert.equal(normaliseCommand("!gps"), ".gps");
  assert.equal(normaliseCommand("/who"), "/who");
  assert.equal(normaliseCommand(" . "), undefined);
  assert.equal(normaliseCommand(""), undefined);
});

test("history: no repeats in a row, capped, persisted; a broken store is ignored", () => {
  const storage = memoryStorage();
  const history = new GmHistory(storage);
  history.add(".gps");
  history.add(".gps");
  history.add(".revive");
  assert.deepEqual(history.lines, [".gps", ".revive"]);
  assert.deepEqual(new GmHistory(storage).lines, [".gps", ".revive"]);
  for (let index = 0; index < 150; index++) history.add(`.levelup ${index}`);
  assert.equal(history.lines.length, GmHistory.LIMIT);
  assert.deepEqual(new GmHistory(memoryStorage({ [GmHistory.KEY]: "{oops" })).lines, []);
  assert.deepEqual(new GmHistory({ getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); } }).lines, []);
});

test("favorites: per kind, toggled, remembered places are tele rows with a negative id", () => {
  const storage = memoryStorage();
  const favorites = new GmFavorites(storage);
  assert.equal(favorites.toggle("item", { id: 25, name: "Меч" }), true);
  assert.equal(favorites.has("item", 25), true);
  assert.equal(favorites.has("spell", 25), false, "kinds are separate");
  const place = favorites.rememberPlace("Дом", { map: 1, x: 10, y: 20, z: 30 }, 1234);
  assert.equal(place.id, -1234);
  const reloaded = new GmFavorites(storage);
  assert.deepEqual(reloaded.list("item"), [{ id: 25, name: "Меч" }]);
  assert.deepEqual(reloaded.list("tele"), [{ id: -1234, name: "Дом", map: 1, x: 10, y: 20, z: 30 }]);
  assert.equal(reloaded.toggle("item", { id: 25, name: "Меч" }), false);
  assert.deepEqual(new GmFavorites(storage).list("item"), []);
  assert.deepEqual(new GmFavorites(memoryStorage({ [GmFavorites.KEY]: JSON.stringify([{ kind: "nope", row: { id: 1, name: "x" } }]) })).list("item"), []);
});
