// The data the stock FrameXML tooltips were missing: `ItemSubClass` words for the slot row's right
// half, Spell.dbc's aura text and the on-next-swing/channelled bits for the cast row — served by
// the gateway, read by the browser with a clean fallback for a gateway process that predates them —
// and the unmount that lets go of redraws a closed HUD left waiting.

import assert from "node:assert/strict";
import test from "node:test";
import { installFakeUiDocument } from "./fixtures/fake-ui-document.mjs";

installFakeUiDocument();

let dbcDirectory;
try {
  dbcDirectory = (await import("../tools/paths.mjs")).dbcDirectory();
} catch {
  dbcDirectory = undefined;
}
const withDataset = { skip: dbcDirectory ? false : "no 3.3.5a DBC dataset on this machine" };

const { loadItemSubclassNames } = await import("../dist/code/gateway/ItemMetadata.js");
const { startGateway } = await import("../dist/code/gateway/Gateway.js");
const { ItemMetadataClient } = await import("../dist/code/browser/ItemMetadata.js");
const { SpellMetadataClient } = await import("../dist/code/browser/SpellMetadata.js");
const { game } = await import("../dist/code/browser/game/Context.js");
const ItemTooltip = await import("../dist/code/browser/ui/ItemTooltip.js");
const Spellbook = await import("../dist/code/browser/ui/Spellbook.js");
const { clearSpellNames } = await import("../dist/code/browser/ui/SpellNames.js");
const { createFrameXmlCharacterTooltipAdapter } = await import("../dist/code/browser/framexml/FrameXmlCharacterTooltip.js");
const { unmountFrameXmlVertical } = await import("../dist/code/browser/framexml/FrameXmlWorldMount.js");
const { GLOBAL_STRING_DATA_AVAILABLE } = await import("../dist/code/generated/globalStrings.js");

const withGlobalStrings = { skip: GLOBAL_STRING_DATA_AVAILABLE ? false : "no locally generated GlobalStrings data" };
const settle = async (turns = 6) => { for (let turn = 0; turn < turns; turn++) await new Promise((resolve) => setTimeout(resolve, 0)); };
const textOf = (line) => typeof line === "string" ? line : line.text;

/** The dataset's own rows for the four this file leans on (measured with the parser below). */
const SUBCLASS_ROWS = [
  { itemClass: 2, subClass: 1, name: "Топор", verboseName: "Двуручные топоры", displayFlags: 0 },
  { itemClass: 4, subClass: 0, name: "Разное", verboseName: "", displayFlags: 1 },
  { itemClass: 4, subClass: 4, name: "Латы", verboseName: "Латные", displayFlags: 0 },
  { itemClass: 4, subClass: 1, name: "Ткань", verboseName: "Тканевые", displayFlags: 0 },
];

function withFetch(handler, run) {
  const previous = globalThis.fetch;
  globalThis.fetch = handler;
  return Promise.resolve().then(run).finally(() => { globalThis.fetch = previous; });
}

const json = (value, ok = true, status = 200) => ({ ok, status, json: async () => value });

function spell(id, name, rank, extra = {}) {
  return {
    id, name, rank, description: "", iconId: 0, iconPath: "", passive: false, hidden: false,
    powerType: 1, powerCost: 150, powerCostPercent: 0, recoveryTime: 0, categoryRecoveryTime: 0,
    startRecoveryTime: 0, cooldownStartedOnEvent: false, effectAura: [], effectMiscValue: [],
    effectBasePoints: [0, 0, 0], effectDieSides: [0, 0, 0], effectRadius: [0, 0, 0], effectPeriod: [0, 0, 0],
    spellLevel: 0, spellClassSet: 4, spellClassMask: [1, 0, 0], schoolMask: 1,
    rangeMin: 0, rangeMax: 0, rangeFlags: 0, castTime: 0, duration: 0, procChance: 0,
    autoRepeat: false, displayInStanceBar: false, stanceBarOrder: 0,
    ...extra,
  };
}

function template(entry, overrides = {}) {
  return {
    found: true, entry, name: `Предмет ${entry}`, quality: 2, itemClass: 4, subClass: 0, inventoryType: 0,
    itemLevel: 0, flags: 0, maxCount: 0, bonding: 0, containerSlots: 0, block: 0,
    damage: [{ min: 0, max: 0, type: 0 }], delay: 0, resistances: [0, 0, 0, 0, 0, 0, 0], stats: [],
    requiredLevel: 1, maxDurability: 0, spells: [], requiredSkill: 0, requiredSkillRank: 0,
    requiredReputationFaction: 0, requiredReputationRank: 0, allowableClass: 0, allowableRace: 0,
    sockets: [], socketBonus: 0, gemProperties: 0, startQuest: 0, description: "",
    sellPrice: 0, stackable: 1, ...overrides,
  };
}

function fakeWorld(templates = new Map()) {
  const handlers = new Set();
  return {
    state: { selfGuid: 1n, objects: new Map([[1n, { guid: 1n, typeId: 4, fields: new Map() }]]) },
    itemTemplate: (entry) => templates.get(entry),
    events: {
      on(name, handler) { const entry = { name, handler }; handlers.add(entry); return () => handlers.delete(entry); },
      emit(name, value) { for (const entry of [...handlers]) if (entry.name === name) entry.handler(value); },
    },
  };
}

function reset() {
  game.world = undefined;
  game.itemMetadata = undefined;
  game.spellMetadataClient = undefined;
  game.spells = new Map();
  clearSpellNames();
}

// ---------------------------------------------------------------- the gateway, in process

test("the dataset's ItemSubClass words, served whole by /dbc/item-subclasses", withDataset, async () => {
  const rows = await loadItemSubclassNames(dbcDirectory);
  assert.equal(rows.length, 119);
  const find = (itemClass, subClass) => rows.find((row) => row.itemClass === itemClass && row.subClass === subClass);
  for (const expected of SUBCLASS_ROWS) assert.deepEqual(find(expected.itemClass, expected.subClass), expected);
  // Bit 0 of DisplayFlags is set on every word the client leaves off the slot row and clear on
  // every armour and weapon type it prints.
  assert.deepEqual(rows.filter((row) => row.itemClass === 4 && (row.displayFlags & 1) === 0).map((row) => row.name),
    ["Ткань", "Кожа", "Кольчуга", "Латы", "Кулачный щит(НЕ ИСП.)_", "Щит", "Манускрипт", "Идол", "Тотем", "Печати"]);

  const gateway = await startGateway({
    host: "127.0.0.1", port: 0, auth: { host: "127.0.0.1", port: 1 }, world: { host: "127.0.0.1", port: 1 },
    allowedOrigins: ["http://127.0.0.1:5173"], dbcDirectory,
  });
  try {
    const headers = { origin: "http://127.0.0.1:5173" };
    const response = await fetch(`http://127.0.0.1:${gateway.port}/dbc/item-subclasses?v=1`, { headers });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-cache");
    assert.deepEqual(await response.json(), rows);
    assert.equal((await fetch(`http://127.0.0.1:${gateway.port}/dbc/item-subclasses`)).status, 403,
      "the same origin rule as every /dbc route");

    const spells = await fetch(`http://127.0.0.1:${gateway.port}/dbc/spells?ids=78,5143,6673,133&v=14`, { headers });
    assert.equal(spells.status, 200);
    const byId = new Map((await spells.json()).map((row) => [row.id, row]));
    assert.equal(byId.get(78).onNextSwing, true, "«Удар героя» replaces the next swing");
    assert.equal(byId.get(78).channeled, false);
    assert.equal(byId.get(5143).channeled, true, "«Чародейские стрелы» channel with a cast time of 0");
    assert.equal(byId.get(5143).castTime, 0);
    assert.equal(byId.get(6673).auraDescription, "Сила атаки увеличена на $s1.");
    assert.equal(byId.get(133).onNextSwing, false);
    assert.equal(byId.get(133).channeled, false);
  } finally {
    await gateway.close();
  }
});

// ---------------------------------------------------------------- the browser clients

test("the subclass word is asked once, answers after it lands, and a 404 is retried only after its wait", async () => {
  let now = 1_000;
  const requests = [];
  let answer = json(undefined, false, 404);
  await withFetch(async (url) => { requests.push(String(url)); return answer; }, async () => {
    const client = new ItemMetadataClient("ws://127.0.0.1:8090/auth", () => now);
    assert.equal(client.tooltipSubclassName(2, 1), undefined, "a gateway older than the route: the slot alone");
    await settle();
    assert.deepEqual(requests, ["http://127.0.0.1:8090/dbc/item-subclasses?v=1"]);
    assert.equal(client.tooltipSubclassName(2, 1), undefined);
    await settle();
    assert.equal(requests.length, 1, "no second ask inside the five-second wait");

    now += 5_000;
    answer = json(SUBCLASS_ROWS);
    assert.equal(client.tooltipSubclassName(2, 1), undefined);
    await settle();
    assert.equal(requests.length, 2, "the restarted gateway is asked again after the wait");
    assert.equal(client.tooltipSubclassName(2, 1), "Топор");
    assert.equal(client.tooltipSubclassName(4, 4), "Латы");
    assert.equal(client.tooltipSubclassName(4, 0), undefined, "armour «Разное» (rings, necks, trinkets) prints nothing");
    assert.equal(client.tooltipSubclassName(9, 9), undefined);
    assert.equal(requests.length, 2, "one table per session");
    client.dispose();
  });
});

test("v=14 spell rows: the new fields are optional, and an old-shape batch is asked once more past the cache", async () => {
  const base = spell(78, "Удар героя", "Уровень 1", { spellLevel: 1 });
  const calls = [];
  let rows = [base];
  const fetcher = async (url, init) => { calls.push([String(url), init?.cache]); return json(rows); };
  const client = new SpellMetadataClient("ws://127.0.0.1:8090/auth", fetcher);
  const first = await client.load([78]);
  assert.equal(first.get(78).name, "Удар героя", "an old gateway's rows are still the book");
  assert.deepEqual(calls, [
    ["http://127.0.0.1:8090/dbc/spells?ids=78&v=17", undefined], // L13: v=17
    ["http://127.0.0.1:8090/dbc/spells?ids=78&v=17", "reload"],
  ], "the old shape, once more past the browser cache");
  await client.load([79]);
  assert.equal(calls.length, 3, "the gateway itself answered the old shape: no more second asks");

  const fresh = new SpellMetadataClient("ws://127.0.0.1:8090/auth", fetcher);
  calls.length = 0;
  rows = [{ ...base, id: 80, auraDescription: "", onNextSwing: true, channeled: false, rangeMaxFriendly: 5, dispelType: 0, preventionType: 0,
    startRecoveryCategory: 0 }]; // L13: the v=17 marker
  assert.equal((await fresh.load([80])).get(80).onNextSwing, true);
  assert.equal(calls.length, 1, "a v=17 answer is taken as it is");
  // A v=13 gateway (aura text, no friendly range) is still an older gateway for the v=17 key.
  const midway = new SpellMetadataClient("ws://127.0.0.1:8090/auth", fetcher);
  calls.length = 0;
  rows = [{ ...base, id: 82, auraDescription: "", onNextSwing: false, channeled: false }];
  await midway.load([82]);
  assert.equal(calls.length, 2, "the v=13 shape is asked once more past the cache");
  rows = [{ ...base, id: 81, onNextSwing: "yes" }];
  await assert.rejects(fresh.load([81]), /invalid data/, "a present field must be what it says");
});

// ---------------------------------------------------------------- the stock tooltips

test("the stock cast row says «Следующая атака» and «Потоковое», and a buff shows its aura text", () => {
  reset();
  game.spells = new Map([
    [78, spell(78, "Удар героя", "Уровень 1", { onNextSwing: true, description: "Мощная атака." })],
    [5143, spell(5143, "Чародейские стрелы", "Уровень 1", { channeled: true, powerType: 0, powerCost: 85 })],
    [6673, spell(6673, "Боевой крик", "Уровень 1", {
      description: "Воин издает боевой крик.", auraDescription: "Сила атаки увеличена на 15.",
    })],
    [133, spell(133, "Огненный шар", "Уровень 1", { castTime: 1500, description: "Наносит урон." })],
    [999, spell(999, "Старый шаблон", "", { description: "Описание." })],
  ]);
  try {
    const castRow = (id) => textOf(Spellbook.stockSpellTooltip(id).lines[1]);
    assert.equal(castRow(78), "Следующая атака");
    assert.equal(castRow(5143), "Потоковое");
    assert.equal(castRow(133), "Применение: 1.5 сек.");
    assert.equal(castRow(999), "Мгновенное действие", "a row from an older gateway keeps today's words");
    const prose = (content) => content.lines.filter((line) => line.tone === "description").map(textOf);
    assert.deepEqual(prose(Spellbook.stockSpellTooltip(6673)), ["Воин издает боевой крик."]);
    assert.deepEqual(prose(Spellbook.stockSpellTooltip(6673, { aura: true })), ["Сила атаки увеличена на 15."]);
    assert.deepEqual(prose(Spellbook.stockSpellTooltip(133, { aura: true })), ["Наносит урон."],
      "no aura text: the description, as before");
  } finally {
    reset();
  }
});

test("the FrameXML adapter draws the slot row's right half and a buff's aura text", withGlobalStrings, async () => {
  reset();
  const axe = template(19_019, {
    name: "Секира", itemClass: 2, subClass: 1, inventoryType: 17, damage: [{ min: 100, max: 200, type: 0 }], delay: 3700,
  });
  const ring = template(19_020, { name: "Кольцо", itemClass: 4, subClass: 0, inventoryType: 11 });
  await withFetch(async () => json(SUBCLASS_ROWS), async () => {
    game.itemMetadata = new ItemMetadataClient("ws://127.0.0.1:8090/auth");
    const seam = {
      inventoryItemTooltip: (_unit, slot) => ({ 16: { entry: 19_019, template: axe }, 11: { entry: 19_020, template: ring } })[slot],
      containerItemTooltip: () => undefined,
      actionTooltip: () => undefined,
    };
    const adapter = createFrameXmlCharacterTooltipAdapter(seam);
    const slotRow = (content) => content.lines.find((line) => typeof line !== "string"
      && (line.text === "Двуручное" || line.text === "Палец"));
    assert.deepEqual(slotRow(adapter.inventoryItem("player", 16)), { text: "Двуручное" },
      "before the table has landed, today's slot-only row");
    await settle();
    assert.deepEqual(slotRow(adapter.inventoryItem("player", 16)), { text: "Двуручное", right: "Топор" });
    assert.deepEqual(slotRow(adapter.inventoryItem("player", 11)), { text: "Палец" }, "a ring has no right half");

    game.world = fakeWorld();
    game.spells = new Map([[6673, spell(6673, "Боевой крик", "Уровень 1", {
      description: "Воин издает боевой крик.", auraDescription: "Сила атаки увеличена на 15.",
    })]]);
    const waiting = adapter.aura(6673);
    let drawn = waiting.refresh ? undefined : waiting;
    waiting.refresh?.watch((next) => { drawn = next; });
    for (let turn = 0; turn < 40 && !drawn; turn++) await settle(1);
    assert.deepEqual(drawn.lines.filter((line) => line.tone === "description").map(textOf), ["Сила атаки увеличена на 15."]);
    assert.deepEqual(adapter.spell(6673).lines.filter((line) => line.tone === "description").map(textOf),
      ["Воин издает боевой крик."], "a link to the same spell keeps its cast description");
    game.itemMetadata.dispose();
  }).finally(reset);
});

test("unmounting the HUD drops the stock tooltips still waiting on a late row", () => {
  reset();
  ItemTooltip.resetStockTooltipRedraws();
  const world = fakeWorld();
  game.world = world;
  const ran = [];
  try {
    ItemTooltip.itemTooltipFor(50_101, { layout: "stock", compare: false }).refresh.watch(() => ran.push("redrawn"));
    unmountFrameXmlVertical();
    world.events.emit("QUERY_CACHE_CHANGED", { kind: "item", id: 50_101 });
    assert.deepEqual(ran, [], "the closed HUD's redraw never runs");
  } finally {
    ItemTooltip.resetStockTooltipRedraws();
    reset();
  }
});
