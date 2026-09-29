// What the stock FrameXML `GameTooltip` is fed: the item and spell content its C-methods paint.
//
// The FrameXML HUD reuses the native tooltip builders, so before this the stock tooltip showed the
// native panels' shape: an equipped chest compared with itself («Сейчас надето: —»), a bag item
// compared with what is worn (the original only compares in ShoppingTooltip1/2, on Shift), the
// school as a row of its own, «Если на персонаже: Заклинание 18055» with the spell's number where
// the original writes what the spell does, and a sell price as words. These pin the stock shape
// the adapter now asks for, and that the native builders keep theirs.

import assert from "node:assert/strict";
import test from "node:test";
import { installFakeUiDocument } from "./fixtures/fake-ui-document.mjs";

installFakeUiDocument();

const { game } = await import("../dist/code/browser/game/Context.js");
const ItemTooltip = await import("../dist/code/browser/ui/ItemTooltip.js");
const Spellbook = await import("../dist/code/browser/ui/Spellbook.js");
const { clearSpellNames } = await import("../dist/code/browser/ui/SpellNames.js");
const { createFrameXmlCharacterTooltipAdapter } = await import("../dist/code/browser/framexml/FrameXmlCharacterTooltip.js");
const { GLOBAL_STRING_DATA_AVAILABLE, GLOBAL_STRINGS } = await import("../dist/code/generated/globalStrings.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

const withGlobalStrings = { skip: GLOBAL_STRING_DATA_AVAILABLE ? false : "no locally generated GlobalStrings data" };
const settle = () => new Promise((resolve) => { setTimeout(resolve, 0); });
const textOf = (line) => typeof line === "string" ? line : line.text;
const texts = (content) => (content.lines ?? []).map(textOf);
const lineStarting = (content, prefix) => (content.lines ?? []).find((line) => textOf(line).startsWith(prefix));

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

function spell(id, name, rank, extra = {}) {
  return {
    id, name, rank, description: "", iconId: 0, iconPath: "", passive: false, hidden: false,
    powerType: 0, powerCost: 0, powerCostPercent: 0, recoveryTime: 0, categoryRecoveryTime: 0,
    startRecoveryTime: 0, cooldownStartedOnEvent: false, effectAura: [], effectMiscValue: [],
    effectBasePoints: [0, 0, 0], effectDieSides: [0, 0, 0], effectRadius: [0, 0, 0],
    spellLevel: 0, spellClassSet: 3, spellClassMask: [1, 0, 0], schoolMask: 0,
    rangeMin: 0, rangeMax: 0, rangeFlags: 0, castTime: 0, duration: 0, procChance: 0,
    ...extra,
  };
}

/** A player object wearing `worn` (equipment index → [guid, entry]), and a world that knows `templates`. */
function fakeWorld(templates, worn = []) {
  const fields = new Map();
  const objects = new Map();
  for (const [index, guid, entry] of worn) {
    const base = UPDATE_FIELDS.PLAYER_FIELD_INV_SLOT_HEAD.offset + index * 2;
    fields.set(base, Number(guid & 0xffffffffn));
    fields.set(base + 1, Number(guid >> 32n));
    objects.set(guid, { guid, typeId: 1, fields: new Map([[UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, entry]]) });
  }
  objects.set(1n, { guid: 1n, typeId: 4, fields });
  const handlers = new Set();
  return {
    state: { selfGuid: 1n, objects },
    itemTemplate: (entry) => templates.get(entry),
    events: {
      on(name, handler) {
        const entry = { name, handler };
        handlers.add(entry);
        return () => handlers.delete(entry);
      },
      emit(name, value) { for (const entry of [...handlers]) if (entry.name === name) entry.handler(value); },
      count: (name) => [...handlers].filter((entry) => entry.name === name).length,
    },
  };
}

function reset() {
  game.world = undefined;
  game.spellMetadataClient = undefined;
  game.spells = new Map();
  clearSpellNames();
}

// First in the file on purpose: the adapter's own import of the spellbook module lands once per
// process, and this is about the moment before it has.
test("a link to a spell whose row is cached names it before the spellbook module has landed", async () => {
  reset();
  game.world = fakeWorld(new Map());
  game.spells = new Map([[133, spell(133, "Огненный шар", "Уровень 1", { castTime: 1500, description: "Наносит урон." })]]);
  try {
    const adapter = createFrameXmlCharacterTooltipAdapter({ actionTooltip: () => undefined });
    const early = adapter.spell(133);
    assert.equal(early.title, "Огненный шар", "the name, not «Заклинание 133»");
    assert.equal(early.titleRight, "Уровень 1", "so GetSpell has the rank too");
    assert.ok(early.refresh, "and the full tooltip follows");
    const redraws = [];
    early.refresh.watch((next) => redraws.push(next));
    for (let turn = 0; turn < 20 && redraws.length === 0; turn++) await settle();
    assert.equal(redraws.length, 1);
    assert.deepEqual(redraws[0].lines, [{ text: "Применение: 1.5 сек." }, { text: "Наносит урон.", tone: "description", wrap: true }]);
  } finally {
    reset();
  }
});

test("the stock GameTooltip never carries a worn comparison, and a worn slot is marked worn", withGlobalStrings, () => {
  const templates = new Map([
    [1000, template(1000, { name: "Старая кираса", inventoryType: 5, itemLevel: 187 })],
    [1001, template(1001, { name: "Кираса претендента", inventoryType: 5, itemLevel: 200 })],
  ]);
  game.world = fakeWorld(templates, [[4, 0x100n, 1000]]);
  const seam = {
    inventoryItemTooltip: (unit, slot) => unit === "player" && slot === 5 ? { entry: 1000, enchantments: [0, 0, 0, 0, 0, 0, 0] } : undefined,
    containerItemTooltip: () => ({ entry: 1001, enchantments: [0, 0, 0, 0, 0, 0, 0] }),
    actionTooltip: () => undefined,
  };
  try {
    const adapter = createFrameXmlCharacterTooltipAdapter(seam);
    const worn = texts(adapter.inventoryItem("player", 5)).join("\n");
    const bag = texts(adapter.containerItem(0, 1)).join("\n");
    assert.doesNotMatch(worn, /Сейчас надето/, "an equipped chest is not compared with itself");
    assert.doesNotMatch(bag, /Сейчас надето/, "the original compares only in ShoppingTooltip1/2, on Shift");
    assert.doesNotMatch(texts(adapter.item(1001)).join("\n"), /Сейчас надето/, "nor for a link");
    // The native panels keep their comparison, and the explicit option turns it off.
    assert.match(texts(ItemTooltip.itemTooltipFor(1001)).join("\n"), /Сейчас надето: Старая кираса, ур\. предмета 187/);
    assert.doesNotMatch(texts(ItemTooltip.itemTooltipFor(1001, { compare: false })).join("\n"), /Сейчас надето/);
  } finally {
    reset();
  }
});

test("stock item rows are the 3.3.5 GameTooltip's pairs, colours and prose", withGlobalStrings, () => {
  const axe = template(19_019, {
    name: "Секира", quality: 4, itemClass: 2, subClass: 1, inventoryType: 17, bonding: 1,
    damage: [{ min: 100, max: 200, type: 0 }], delay: 3700,
    stats: [{ type: 4, value: 23 }, { type: 7, value: 22 }, { type: 32, value: 14 }],
    sockets: [{ color: 2, content: 0 }], socketBonus: 700, maxDurability: 120, requiredLevel: 80,
    itemLevel: 200, sellPrice: 18_991, stackable: 1,
    spells: [{ spellId: 18_055, trigger: 1, charges: 0, cooldown: -1, category: 0, categoryCooldown: -1 }],
  });
  const content = ItemTooltip.itemTooltipContent({ entry: 19_019, template: axe }, {
    layout: "stock", durability: 100, playerLevel: 80, enchantments: [0, 0, 0, 0, 0, 0, 0],
    subclassName: (itemClass, subClass) => itemClass === 2 && subClass === 1 ? "Топор" : undefined,
    enchantment: (id) => id === 700 ? { id, name: "+8 к силе", gemItemId: 0 } : undefined,
    spellName: () => "Сила заклинаний",
    spellDescription: (id) => id === 18_055 ? "Увеличивает силу заклинаний на 22." : undefined,
  });
  const all = texts(content);
  assert.deepEqual(lineStarting(content, GLOBAL_STRINGS.INVTYPE_2HWEAPON),
    { text: GLOBAL_STRINGS.INVTYPE_2HWEAPON, right: "Топор" }, "slot left, weapon type right");
  assert.deepEqual(lineStarting(content, "Урон:"), { text: "Урон: 100 - 200", right: "Скорость 3.70" });
  assert.ok(all.includes("+23 к силе") && all.includes("+22 к выносливости"), "each base stat on its own row");
  assert.equal(lineStarting(content, "+23 к силе").tone, undefined, "a base stat is white");
  const rating = lineStarting(content, "Если на персонаже: Рейтинг критического удара +14.");
  assert.ok(rating, all.join(" | "));
  assert.equal(rating.tone, "spell");
  assert.equal(rating.wrap, true);
  assert.deepEqual(lineStarting(content, GLOBAL_STRINGS.EMPTY_SOCKET_RED), { text: GLOBAL_STRINGS.EMPTY_SOCKET_RED, color: "#808080" });
  assert.deepEqual(lineStarting(content, "При соответствии цвета:"), { text: "При соответствии цвета: +8 к силе", color: "#808080" },
    "an unmatched socket bonus is grey");
  assert.ok(all.includes("Прочность: 100 / 120"));
  const level = all.indexOf("Требуется уровень: 80");
  const itemLevel = all.indexOf("Уровень предмета: 200");
  const spellLine = all.indexOf("Если на персонаже: Увеличивает силу заклинаний на 22.");
  assert.ok(level >= 0 && itemLevel > level && spellLine > itemLevel, "requirements, item level, then the green prose");
  assert.equal(lineStarting(content, "Если на персонаже: Увеличивает").wrap, true);
  assert.deepEqual(lineStarting(content, "Цена продажи"),
    { text: "Цена продажи: 1з 89с 91м", money: { copper: 18_991, label: "Цена продажи:" } });
  assert.doesNotMatch(all.join("\n"), /Сейчас надето|В стопке|Количество|Заклинание 18055/);
});

test("an «Использование:» line ends on the row's own cooldown, in the client's units", withGlobalStrings, () => {
  const spellLine = (cooldown, categoryCooldown, trigger = 0) => {
    const content = ItemTooltip.itemTooltipContent({ entry: 1, template: template(1, {
      name: "Зелье", spells: [{ spellId: 5, trigger, charges: 1, cooldown, category: 4, categoryCooldown }],
    }) }, { layout: "stock", spellDescription: () => "Восполняет 1000 ед. здоровья." });
    return textOf((content.lines ?? []).find((line) => textOf(line).includes("Восполняет")));
  };
  assert.equal(spellLine(-1, 60_000), "Использование: Восполняет 1000 ед. здоровья. (Восстановление: 1 мин.)",
    "the category's cooldown when the spell's own is left to the spell");
  assert.equal(spellLine(120_000, 60_000), "Использование: Восполняет 1000 ед. здоровья. (Восстановление: 2 мин.)",
    "the longer of the two");
  assert.equal(spellLine(90_000, -1), "Использование: Восполняет 1000 ед. здоровья. (Восстановление: 90 сек.)",
    "a cooldown that is not whole minutes stays seconds");
  assert.equal(spellLine(3_600_000, -1), "Использование: Восполняет 1000 ед. здоровья. (Восстановление: 1 час)");
  assert.equal(spellLine(172_800_000, -1), "Использование: Восполняет 1000 ед. здоровья. (Восстановление: 2 дня)");
  assert.equal(spellLine(-1, -1), "Использование: Восполняет 1000 ед. здоровья.", "a row that leaves both to the spell has no tail");
  assert.equal(spellLine(60_000, -1, 1), "Если на персонаже: Восполняет 1000 ед. здоровья.", "an Equip: line never has one");
});

test("an item's spell is its description once the row lands, and the waiting tooltip is redrawn", withGlobalStrings, async () => {
  reset();
  const ring = template(40_001, { name: "Кольцо", inventoryType: 11,
    spells: [{ spellId: 18_055, trigger: 1, charges: 0, cooldown: -1, category: 0, categoryCooldown: -1 }] });
  const templates = new Map();
  game.world = fakeWorld(templates);
  game.spellMetadataClient = {
    load: async (ids) => new Map(ids.map((id) => [id, spell(id, "Сила заклинаний", "", {
      description: "Увеличивает силу заклинаний на 22." })])),
  };
  try {
    // The row itself is late first: the query is on the wire and the tooltip says so.
    const first = ItemTooltip.itemTooltipFor(40_001, { layout: "stock", compare: false });
    assert.ok(first.refresh, "content built without its row asks to be redrawn");
    const redraws = [];
    first.refresh.watch((next) => redraws.push(next));
    templates.set(40_001, ring);
    game.world.events.emit("QUERY_CACHE_CHANGED", { kind: "item", id: 40_001 });
    assert.equal(redraws.length, 1, "the item row's arrival wakes the tooltip");
    assert.equal(redraws[0].title, "Кольцо");
    // The spell's own row is still on its way, and the stock layout writes nothing for it: the
    // «Если на персонаже: Заклинание 18055» that stood here was a placeholder drawn as the spell
    // (the recipe report's «Использование: Заклинание 483», `item-tooltip-recipe.test.mjs`).
    assert.equal(texts(redraws[0]).some((line) => line.startsWith("Если на персонаже")), false, texts(redraws[0]).join(" | "));
    assert.ok(redraws[0].refresh, "and so it waits again");

    redraws[0].refresh.watch((next) => redraws.push(next));
    await settle();
    assert.equal(redraws.length, 2, "the spell row's arrival wakes it once more");
    assert.ok(texts(redraws[1]).includes("Если на персонаже: Увеличивает силу заклинаний на 22."), texts(redraws[1]).join(" | "));
    assert.equal(redraws[1].refresh, undefined, "nothing left to wait for");
  } finally {
    reset();
  }
});

test("stock redraws belong to one world: a throwing one spares the rest, and another world lets go of the old", () => {
  reset();
  ItemTooltip.resetStockTooltipRedraws();
  const stock = { layout: "stock", compare: false };
  const old = fakeWorld(new Map());
  game.world = old;
  const ran = [];
  const warned = [];
  const warn = console.warn;
  try {
    // A redraw whose HUD is gone throws; the one after it in the same answer still runs.
    ItemTooltip.itemTooltipFor(50_001, stock).refresh.watch(() => { ran.push("closed HUD"); throw new Error("closed"); });
    ItemTooltip.itemTooltipFor(50_002, stock).refresh.watch(() => ran.push("open HUD"));
    assert.equal(old.events.count("QUERY_CACHE_CHANGED"), 1, "one subscription for the world");
    console.warn = (...args) => warned.push(args);
    old.events.emit("QUERY_CACHE_CHANGED", { kind: "item", id: 50_002 });
    console.warn = warn;
    assert.deepEqual(ran, ["closed HUD", "open HUD"]);
    assert.equal(warned.length, 1, "the throw is reported, not rethrown");

    // A new world: what the old one left waiting is not run, and its bus is let go.
    ItemTooltip.itemTooltipFor(50_003, stock).refresh.watch(() => ran.push("left behind"));
    game.world = fakeWorld(new Map());
    old.events.emit("QUERY_CACHE_CHANGED", { kind: "item", id: 50_003 });
    assert.deepEqual(ran, ["closed HUD", "open HUD"]);
    assert.equal(old.events.count("QUERY_CACHE_CHANGED"), 0);

    // Even when the old world never speaks again, the next item tooltip of any kind lets go of it.
    game.world = old;
    ItemTooltip.itemTooltipFor(50_004, stock).refresh.watch(() => ran.push("left behind"));
    assert.equal(old.events.count("QUERY_CACHE_CHANGED"), 1);
    game.world = fakeWorld(new Map());
    ItemTooltip.itemTooltipFor(50_005);
    assert.equal(old.events.count("QUERY_CACHE_CHANGED"), 0, "a native tooltip released it");
  } finally {
    console.warn = warn;
    ItemTooltip.resetStockTooltipRedraws();
    reset();
  }
});

test("the stock spell tooltip pairs its rows and drops the school; the native one keeps its shape", () => {
  reset();
  game.spells = new Map([
    [133, spell(133, "Огненный шар", "Уровень 1", {
      powerCostPercent: 8, schoolMask: 4, rangeMax: 35, castTime: 1500, recoveryTime: 8000,
      description: "Наносит 16 ед. урона от огня.",
    })],
    [78, spell(78, "Удар героя", "Уровень 1", { powerType: 1, powerCost: 150, rangeMax: 5, rangeFlags: 1 })],
    [12_042, spell(12_042, "Мощь тайной магии", "", { recoveryTime: 90_000, powerCostPercent: 5 })],
    [20_600, spell(20_600, "Восприятие", "", { passive: true, description: "Скрытность обнаружить." })],
  ]);
  try {
    const fireball = Spellbook.stockSpellTooltip(133);
    assert.equal(fireball.title, "Огненный шар");
    assert.equal(fireball.titleRight, "Уровень 1", "the rank sits right of the name");
    assert.deepEqual(fireball.lines, [
      { text: "Мана: 8%", right: "Радиус действия: 35 м" },
      { text: "Применение: 1.5 сек.", right: "Восстановление: 8 сек." },
      { text: "Наносит 16 ед. урона от огня.", tone: "description", wrap: true },
    ]);
    assert.equal(fireball.footer, undefined, "no native action hint");
    assert.deepEqual(Spellbook.stockSpellTooltip(78).lines,
      [{ text: "Ярость: 15", right: "Дистанция ближнего боя" }, { text: "Мгновенное действие" }]);
    assert.deepEqual(Spellbook.stockSpellTooltip(12_042).lines[1],
      { text: "Мгновенное действие", right: "Восстановление: 1.5 мин." }, "a cooldown from a minute up is minutes");
    assert.equal(Spellbook.stockSpellTooltip(12_042).titleRight, undefined, "no rank, nothing on the right");
    assert.deepEqual(Spellbook.stockSpellTooltip(20_600).lines,
      [{ text: "Скрытность обнаружить.", tone: "description", wrap: true }], "a passive has no cast row");
    // The native spellbook tooltip is unchanged.
    assert.ok(Spellbook.spellTooltip(133).lines.includes("Школа: огонь"));
    assert.ok(Spellbook.spellTooltip(133).lines.includes("Сотворение: 1,5 с"));
  } finally {
    reset();
  }
});

test("the adapter's spells: the stock layout, a rank on the right, and a link that waits for its row", async () => {
  reset();
  const templates = new Map();
  game.world = fakeWorld(templates);
  const asked = [];
  game.spellMetadataClient = {
    load: async (ids) => {
      asked.push(...ids);
      return new Map(ids.map((id) => [id, spell(id, "Огненный шар", "Уровень 3", { castTime: 2500,
        description: "Наносит урон." })]));
    },
  };
  const seam = { actionTooltip: (slot) => slot === 1 ? { kind: "spell", id: 145, name: "Огненный шар", rank: "Уровень 3" } : undefined };
  try {
    const adapter = createFrameXmlCharacterTooltipAdapter(seam);
    // An action whose row has not arrived falls back to what the action bar knows, in stock places.
    assert.deepEqual(adapter.action(1), { title: "Огненный шар", titleRight: "Уровень 3" });
    // A chat link to a spell nobody has asked for: kept up with a placeholder instead of hidden.
    const link = adapter.spell(145);
    assert.ok(link, "a link to a spell whose row is on its way is not hidden");
    assert.ok(link.refresh, "and asks to be redrawn");
    const redraws = [];
    link.refresh.watch((next) => redraws.push(next));
    for (let turn = 0; turn < 20 && redraws.length === 0; turn++) await settle();
    assert.deepEqual(asked, [145], "the row is asked for once");
    assert.equal(redraws.length, 1, "the row (and the spellbook module) landing redraws it");
    assert.equal(redraws[0].title, "Огненный шар");
    assert.equal(redraws[0].titleRight, "Уровень 3");
    assert.deepEqual(redraws[0].lines, [{ text: "Применение: 2.5 сек." }, { text: "Наносит урон.", tone: "description", wrap: true }]);
    assert.deepEqual(adapter.action(1).lines, redraws[0].lines, "the action bar reads the same stock rows");
  } finally {
    reset();
  }
});
