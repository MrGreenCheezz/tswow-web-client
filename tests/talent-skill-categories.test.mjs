import assert from "node:assert/strict";
import test from "node:test";

let dbcDirectory;
try {
  dbcDirectory = (await import("../tools/paths.mjs")).dbcDirectory();
} catch {
  dbcDirectory = undefined;
}
const withDataset = { skip: dbcDirectory ? false : "no tswow dataset on this machine" };

test("SkillLineCategory is exposed from the real DBC, including Not Displayed", withDataset, async () => {
  const { openDbcFile } = await import("../tools/dbc.mjs");
  const { loadTalentData } = await import("../dist/code/gateway/TalentMetadata.js");
  const table = await openDbcFile(dbcDirectory, "SkillLineCategory");
  const data = await loadTalentData(dbcDirectory);

  assert.equal(table.records, 8);
  assert.equal(table.fields, 19);
  assert.equal(table.recordSize, 76);
  const expected = [...table.rows()].map((row) => ({
    id: table.id(row),
    name: table.locstring(row, "Name_lang"),
    orderIndex: table.int(row, "SortIndex"),
  })).sort((left, right) => left.orderIndex - right.orderIndex || left.id - right.id);
  assert.deepEqual(data.skillCategories, expected, "the route must not invent category labels/order");
  assert.deepEqual(data.skillCategories.map(({ id, orderIndex }) => [id, orderIndex]), [
    [5, 1], [7, 2], [11, 3], [9, 4], [6, 5], [8, 6], [10, 7], [12, 8],
  ]);
  assert.match(data.skillCategories.at(-1).name, /Displayed|отображается/i);

  // The category id is the bridge from SkillLine.CategoryID, not an array position.
  assert.equal(data.skillLines.find((line) => line.id === 164)?.categoryId, 11, "Blacksmithing is a profession");
  assert.equal(data.skillLines.find((line) => line.id === 43)?.categoryId, 6, "Swords are weapon skills");
  assert.equal(data.skillLines.find((line) => line.id === 98)?.categoryId, 10, "Common is a language");
});

test("TalentClient stays not-ready until categories arrive, then exposes an immutable revision", async () => {
  const { TalentClient } = await import("../dist/code/browser/TalentClient.js");
  const previousFetch = globalThis.fetch;
  const requests = [];
  const payload = {
    tabs: [],
    talents: [],
    glyphs: [],
    skillLines: [{ id: 164, name: "Кузнечное дело", categoryId: 11, iconId: 0 }],
    // Deliberately out of order: the client owns the stable DBC order, not transport order.
    skillCategories: [
      { id: 12, name: "Не отображается", orderIndex: 8 },
      { id: 11, name: "Профессии", orderIndex: 3 },
    ],
    spellSkill: {},
    petFamilies: {},
  };
  try {
    globalThis.fetch = async (url) => {
      requests.push(String(url));
      return { ok: true, json: async () => payload };
    };
    const client = new TalentClient("ws://gateway.test:8090");
    assert.equal(client.ready, false);
    assert.equal(client.revision, 0);
    assert.equal(client.skillCategory(11), undefined);
    assert.deepEqual(client.skillCategories(), []);

    let loaded;
    const loadedPromise = new Promise((resolve) => { loaded = resolve; });
    client.onLoaded = loaded;
    client.load();
    await loadedPromise;

    assert.equal(client.ready, true);
    assert.equal(client.revision, 1);
    assert.deepEqual(client.skillCategories().map(({ id, orderIndex }) => [id, orderIndex]), [[11, 3], [12, 8]]);
    assert.equal(client.skillCategory(11).name, "Профессии");
    assert.equal(Object.isFrozen(client.skillCategories()), true);
    assert.equal(Object.isFrozen(client.skillCategory(11)), true);
    assert.equal(requests.length, 1);
    client.load();
    assert.equal(requests.length, 1, "the metadata snapshot is session-owned and fetched once");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("9.05: TalentClient files a tab under every class bit of its mask, custom classes 12/13 included", async () => {
  const { TalentClient } = await import("../dist/code/browser/TalentClient.js");
  const previousFetch = globalThis.fetch;
  const tab = (id, classMask, orderIndex = 0) => ({ id, name: `tab${id}`, classMask, petTalentMask: 0, orderIndex });
  const payload = {
    tabs: [tab(1, 1 << 0), tab(2, 1 << 11), tab(3, 1 << 12, 1), tab(4, 1 << 12, 0), tab(5, (1 << 0) | (1 << 12)),
      tab(6, 1 << 30), tab(7, 0)],
    talents: [], glyphs: [], skillLines: [], skillCategories: [], spellSkill: {}, petFamilies: {},
  };
  try {
    globalThis.fetch = async () => ({ ok: true, json: async () => payload });
    const client = new TalentClient("ws://gateway.test:8090");
    const loaded = new Promise((resolve) => { client.onLoaded = resolve; });
    client.load();
    await loaded;
    const ids = (classId) => client.tabsForClass(classId).map((entry) => entry.id);
    assert.deepEqual(ids(1), [1, 5]);
    assert.deepEqual(ids(12), [2], "class 12 (custom) gets its tab");
    assert.deepEqual(ids(13), [4, 5, 3], "class 13 (HERO) gets its tabs in orderIndex order");
    assert.deepEqual(ids(31), [6], "the highest bit a 31-class mask can name");
    assert.deepEqual(ids(11), [], "no tab names druid here");
    assert.deepEqual(ids(32), [], "no class past 31");
  } finally {
    globalThis.fetch = previousFetch;
  }
});
