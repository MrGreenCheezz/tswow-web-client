// A recipe as the 3.3.5 GameTooltip draws it, against the report «рецепты неправильно работают».
//
// The screenshot was 6328 «Рецепт: острозубый илистый луциан» reading «Использование: Заклинание
// 483» and «Использование: Заклинание 7753» over «Обучает приготовлению…» in quotes: the two lines
// were the placeholders for spell rows still on their way, and once they had landed the name
// fallback wrote «Использование: Изучение» — a line the original never draws. The original writes
// an on-use line only for a spell with a description; a recipe's description is its green
// «Использование:» line; and under it, after a blank row, comes what the recipe makes — the
// product's name in its quality colour and its own rows — then what it takes, «Требуется: …»,
// and the recipe's own price. Every number here is the live world DB's and the gateway's
// (`/dbc/spells?ids=483,7753,434,439`): 7753 makes 4592 out of one 6289.

import assert from "node:assert/strict";
import test from "node:test";
import { game } from "../dist/code/browser/game/Context.js";
import { itemTooltipContent, itemTooltipFor, resetStockTooltipRedraws } from "../dist/code/browser/ui/ItemTooltip.js";
import { clearSpellNames } from "../dist/code/browser/ui/SpellNames.js";
import { formatSpellDescription } from "../dist/code/browser/ui/SpellText.js";
import { GLOBAL_STRING_DATA_AVAILABLE } from "../dist/code/generated/globalStrings.js";

const withGlobalStrings = { skip: GLOBAL_STRING_DATA_AVAILABLE ? false : "no locally generated GlobalStrings data" };
const settle = () => new Promise((resolve) => { setTimeout(resolve, 0); });
const textOf = (line) => typeof line === "string" ? line : line.text;
const texts = (content) => (content.lines ?? []).map(textOf);
const lineStarting = (content, prefix) => (content.lines ?? []).find((line) => textOf(line).startsWith(prefix));

function template(entry, overrides = {}) {
  return {
    found: true, entry, name: `Предмет ${entry}`, quality: 1, itemClass: 0, subClass: 0, inventoryType: 0,
    itemLevel: 0, flags: 0, maxCount: 0, bonding: 0, containerSlots: 0, block: 0,
    damage: [{ min: 0, max: 0, type: 0 }], delay: 0, resistances: [0, 0, 0, 0, 0, 0, 0], stats: [],
    requiredLevel: 1, maxDurability: 0, spells: [], requiredSkill: 0, requiredSkillRank: 0,
    requiredReputationFaction: 0, requiredReputationRank: 0, allowableClass: 0xffff_ffff, allowableRace: 0xffff_ffff,
    sockets: [], socketBonus: 0, gemProperties: 0, startQuest: 0, description: "",
    sellPrice: 0, stackable: 1, ...overrides,
  };
}

/** An item spell slot as `parseItemQueryResponse` returns it; −1 leaves a cooldown to the spell. */
const itemSpell = (spellId, trigger, cooldown = -1, category = 0, categoryCooldown = -1) =>
  ({ spellId, trigger, charges: 0, cooldown, category, categoryCooldown });

/** A spell row with the columns the description formatter and the recipe block read. */
function spell(id, name, extra = {}) {
  return {
    id, name, rank: "", description: "", iconId: 0, iconPath: "", passive: false, hidden: false,
    effects: [0, 0, 0], effectItemType: [0, 0, 0], reagents: [],
    effectBasePoints: [0, 0, 0], effectDieSides: [0, 0, 0], effectPeriod: [0, 0, 0], effectRadius: [0, 0, 0],
    effectChainTargets: [0, 0, 0], duration: 0, maxDuration: 0, procChance: 100,
    powerType: 0, powerCost: 0, powerCostPercent: 0, recoveryTime: 0, categoryRecoveryTime: 0,
    startRecoveryTime: 0, cooldownStartedOnEvent: false, spellLevel: 0, spellClassSet: 0, spellClassMask: [0, 0, 0],
    schoolMask: 1, rangeMin: 0, rangeMax: 0, rangeFlags: 0, castTime: 0, autoRepeat: false,
    displayInStanceBar: false, stanceBarOrder: 0, ...extra,
  };
}

// ---------------------------------------------------------------- the rows, as the realm has them

/** 6328: class 9 (recipe), Cooking 50, sells for a silver; 483 on use, 7753 on learn. */
const recipe = () => template(6328, {
  name: "Рецепт: острозубый илистый луциан", itemClass: 9, subClass: 5, flags: 64, itemLevel: 15, requiredLevel: 0,
  requiredSkill: 185, requiredSkillRank: 50, sellPrice: 100,
  description: "Обучает приготовлению острозубого илистого луциана.",
  spells: [itemSpell(483, 0), itemSpell(7753, 6)],
});
/** 4592, what it makes: food, level 5, a copper, on use 434 with the food category's second. */
const snapper = () => template(4592, {
  name: "Острозубый илистый луциан", itemClass: 0, subClass: 5, itemLevel: 15, requiredLevel: 5, stackable: 20,
  sellPrice: 1, spells: [itemSpell(434, 0, 0, 11, 1000)],
});
/** 6289, what it takes. */
const rawSnapper = () => template(6289, {
  name: "Сырой острозубый илистый луциан", itemClass: 7, subClass: 8, itemLevel: 15, requiredLevel: 5, stackable: 20,
  sellPrice: 1, spells: [itemSpell(433, 0, 0, 11, 1000)],
});
/** 118 «Крохотный флакон с лечебным зельем»: on use 439, a minute's category cooldown. */
const potion = () => template(118, {
  name: "Крохотный флакон с лечебным зельем", itemClass: 0, subClass: 1, itemLevel: 5, stackable: 20, sellPrice: 5,
  spells: [itemSpell(439, 0, 0, 4, 60_000)],
});

const spells = () => new Map([
  [483, spell(483, "Изучение", { effects: [36, 0, 0], castTime: 3000 })],
  [7753, spell(7753, "Острозубый илистый луциан", {
    tradeSkill: true, effects: [24, 0, 0], effectItemType: [4592, 0, 0], reagents: [{ itemId: 6289, count: 1 }], castTime: 2000,
  })],
  [434, spell(434, "Пища", {
    description: "Восполнение $o1 ед. здоровья за $d. Действие эффекта прерывается, если персонаж встает с места.",
    effects: [6, 0, 0], effectBasePoints: [57, 0, 0], effectDieSides: [1, 0, 0], duration: 21_000, maxDuration: 21_000,
  })],
  [439, spell(439, "Лечебное зелье", {
    description: "Восполнение $s1 ед. здоровья.", effects: [10, 0, 0], effectBasePoints: [69, 0, 0], effectDieSides: [21, 0, 0],
  })],
]);

/** The context `itemTooltipFor` wires live, over fixed rows: the builder alone, no world. */
function stockContext(rows, items, extra = {}) {
  const describe = (id) => {
    const row = rows.get(id);
    return row?.description ? formatSpellDescription(row.description, row, { spells: rows, values: {} }) || undefined : undefined;
  };
  return {
    layout: "stock", compare: false, playerLevel: 10,
    skillName: (id) => id === 185 ? "Кулинария" : undefined,
    spellDescription: describe,
    spellRow: (id) => rows.get(id),
    item: (entry) => ({ entry, template: items.get(entry) }),
    ...extra,
  };
}

/** The stock rows of 6328 once everything it names has landed. */
const RECIPE_STOCK_LINES = [
  "Требуется: Кулинария (50)",
  "Использование: Обучает приготовлению острозубого илистого луциана.",
  " ",
  "Острозубый илистый луциан",
  "Требуется уровень: 5",
  // The tail is `useCooldownText`'s reading of the row's one-second food category, as on the
  // food's own tooltip; the block reuses the same builder.
  // The food's one-second category cooldown gets no tail: the original never writes it under a meal.
  "Использование: Восполнение 58 ед. здоровья за 21 сек. Действие эффекта прерывается, если персонаж встает с места.",
  "Требуется: Сырой острозубый илистый луциан",
  "Цена продажи: 1с",
];

test("a recipe reads as the original draws it: what it teaches, what that makes, what that takes", withGlobalStrings, () => {
  const items = new Map([[4592, snapper()], [6289, rawSnapper()]]);
  const content = itemTooltipContent({ entry: 6328, template: recipe() }, stockContext(spells(), items));
  assert.equal(content.title, "Рецепт: острозубый илистый луциан");
  assert.equal(content.quality, 1);
  assert.deepEqual(texts(content), RECIPE_STOCK_LINES);
  const all = texts(content).join("\n");
  assert.doesNotMatch(all, /Изучение|Заклинание/, "a spell with nothing to say has no line, and no placeholder stands for it");
  assert.doesNotMatch(all, /«/, "the description is the Use line, not a quotation");
  assert.deepEqual(lineStarting(content, "Использование: Обучает"),
    { text: "Использование: Обучает приготовлению острозубого илистого луциана.", tone: "spell", wrap: true }, "green prose");
  assert.deepEqual(content.lines[2], { text: " " }, "`AddLine(\" \")`: the blank row the stock writer keeps");
  assert.deepEqual(content.lines[3], { text: "Острозубый илистый луциан", color: "#ffffff" }, "the product's name in its quality's colour");
  assert.equal(lineStarting(content, "Использование: Восполнение").tone, "spell");
  assert.deepEqual(lineStarting(content, "Цена продажи"), { text: "Цена продажи: 1с", money: { copper: 100, label: "Цена продажи:" } },
    "the recipe's price, once: the product's copper and its flavour text are not drawn");
  assert.deepEqual(content.footer, []);

  // An epic product is named in purple; the block never inherits the recipe's own quality.
  const epic = itemTooltipContent({ entry: 6328, template: recipe() },
    stockContext(spells(), new Map([[4592, { ...snapper(), quality: 4 }], [6289, rawSnapper()]])));
  assert.deepEqual(epic.lines[3], { text: "Острозубый илистый луциан", color: "#a335ee" });
});

test("an enchanting formula makes nothing: no block, still the reagents with their counts", withGlobalStrings, () => {
  const rows = new Map([[13_538, spell(13_538, "Чары для нагрудника - слабое здоровье", {
    tradeSkill: true, effects: [53, 0, 0], reagents: [{ itemId: 10_940, count: 2 }, { itemId: 10_938, count: 1 }],
  })]]);
  const items = new Map([
    [10_940, template(10_940, { name: "Странная пыль" })],
    [10_938, template(10_938, { name: "Малая магическая субстанция" })],
  ]);
  const formula = template(6342, {
    name: "Формула: чары для нагрудника - слабое здоровье", itemClass: 9, subClass: 8, requiredSkill: 333, requiredSkillRank: 15,
    description: "Обучает зачаровыванию нагрудника.", sellPrice: 25, spells: [itemSpell(483, 0), itemSpell(13_538, 6)],
  });
  const content = itemTooltipContent({ entry: 6342, template: formula },
    stockContext(rows, items, { skillName: (id) => id === 333 ? "Наложение чар" : undefined }));
  assert.deepEqual(texts(content), [
    "Требуется: Наложение чар (15)",
    "Использование: Обучает зачаровыванию нагрудника.",
    "Требуется: Странная пыль (2), Малая магическая субстанция",
    "Цена продажи: 25м",
  ]);
});

test("a consumable keeps its Use line; a spell with an empty description, or none yet, gives none", withGlobalStrings, () => {
  const rows = spells();
  const healing = itemTooltipContent({ entry: 118, template: potion() }, stockContext(rows, new Map()));
  assert.deepEqual(texts(healing), [
    "Использование: Восполнение 70–90 ед. здоровья. (Восстановление: 1 мин.)",
    "Цена продажи: 5м",
  ]);

  // 483 «Изучение» on a plain item: cached, and with nothing to say.
  const silent = itemTooltipContent({ entry: 1, template: template(1, { spells: [itemSpell(483, 0)] }) },
    stockContext(rows, new Map()));
  assert.deepEqual(texts(silent), []);

  // A row still on its way: nothing, not «Использование: Заклинание 439». The redraw draws it.
  const early = itemTooltipContent({ entry: 118, template: potion() },
    stockContext(rows, new Map(), { spellDescription: () => undefined, spellName: () => "Лечебное зелье" }));
  assert.deepEqual(texts(early), ["Цена продажи: 5м"]);

  // The native layout is the same call: its line is the spell's name, and no name is no line.
  const native = itemTooltipContent({ entry: 118, template: potion() }, { spellName: () => undefined });
  assert.equal(texts(native).some((line) => line.startsWith("Использование")), false, texts(native).join(" | "));
  assert.ok(texts(itemTooltipContent({ entry: 118, template: potion() }, { spellName: () => "Лечебное зелье" }))
    .includes("Использование: Лечебное зелье"));
  const nativeRecipe = itemTooltipContent({ entry: 6328, template: recipe() }, { spellName: () => undefined });
  assert.ok(texts(nativeRecipe).includes("Использование: Обучает приготовлению острозубого илистого луциана."));
  assert.doesNotMatch(texts(nativeRecipe).join("\n"), /«|Изучение|Заклинание/);
});

test("the block waits for what it names, and says «Предмет N» only for a row the server has not got", withGlobalStrings, () => {
  const rows = spells();
  // The learn spell's row not yet cached: the recipe's own rows, and nothing it cannot know yet.
  const early = itemTooltipContent({ entry: 6328, template: recipe() },
    stockContext(rows, new Map(), { spellRow: () => undefined }));
  assert.deepEqual(texts(early), [
    "Требуется: Кулинария (50)",
    "Использование: Обучает приготовлению острозубого илистого луциана.",
    "Цена продажи: 1с",
  ]);

  // The row cached, the product's and the reagent's on their way: the same three rows.
  const pending = itemTooltipContent({ entry: 6328, template: recipe() }, stockContext(rows, new Map()));
  assert.deepEqual(texts(pending), texts(early));

  // The reagent named, the product still on its way: the reagents line, and no block yet.
  const reagentOnly = itemTooltipContent({ entry: 6328, template: recipe() },
    stockContext(rows, new Map([[6289, rawSnapper()]])));
  assert.deepEqual(texts(reagentOnly), [
    "Требуется: Кулинария (50)",
    "Использование: Обучает приготовлению острозубого илистого луциана.",
    "Требуется: Сырой острозубый илистый луциан",
    "Цена продажи: 1с",
  ]);

  // The gateway's name is a name too, before the wire has answered.
  const named = itemTooltipContent({ entry: 6328, template: recipe() }, stockContext(rows, new Map(), {
    item: (entry) => entry === 6289
      ? { entry, metadata: { entry, name: "Сырой острозубый илистый луциан", displayId: 0, quality: 1, inventoryType: 0, stackable: 20, iconId: 0 } }
      : { entry },
  }));
  assert.ok(texts(named).includes("Требуется: Сырой острозубый илистый луциан"));

  // A reagent the server says it has no row for is the one case that prints a number.
  const refused = itemTooltipContent({ entry: 6328, template: recipe() }, stockContext(rows, new Map(), {
    item: (entry) => ({ entry, template: entry === 6289 ? { ...template(6289), found: false, name: "" } : undefined }),
  }));
  assert.ok(texts(refused).includes("Требуется: Предмет 6289"), texts(refused).join(" | "));
});

test("live: the learn spell's row wakes the tooltip, which then asks for the product and the reagent", withGlobalStrings, async () => {
  clearSpellNames();
  game.spells.clear();
  resetStockTooltipRedraws();
  const rows = spells();
  const templates = new Map([[6328, recipe()]]);
  const asked = new Set();
  const handlers = new Set();
  const world = {
    state: { selfGuid: undefined, objects: new Map() },
    itemTemplate: (entry) => {
      if (!templates.has(entry)) asked.add(entry);
      return templates.get(entry);
    },
    events: {
      on(name, handler) {
        const listener = { name, handler };
        handlers.add(listener);
        return () => handlers.delete(listener);
      },
      emit(name, value) { for (const listener of [...handlers]) if (listener.name === name) listener.handler(value); },
    },
  };
  game.world = world;
  const requested = [];
  game.spellMetadataClient = {
    load: async (ids) => {
      requested.push([...ids]);
      return new Map(ids.map((id) => [id, rows.get(id)]).filter(([, row]) => row));
    },
  };
  const context = { layout: "stock", compare: false, playerLevel: 10, skillName: (id) => id === 185 ? "Кулинария" : undefined };
  try {
    const first = itemTooltipFor(6328, context);
    assert.deepEqual(texts(first), [
      "Требуется: Кулинария (50)",
      "Использование: Обучает приготовлению острозубого илистого луциана.",
      "Цена продажи: 1с",
    ], "before the spell rows: no placeholder, no block");
    assert.ok(first.refresh, "and it asks to be drawn again");
    const redraws = [];
    first.refresh.watch((next) => redraws.push(next));
    await settle();
    assert.deepEqual(requested, [[483, 7753]], "both of the recipe's rows are asked for, the learn spell's among them");
    assert.equal(redraws.length, 1, "their arrival wakes the tooltip");
    assert.deepEqual([...asked].sort((a, b) => a - b), [4592, 6289], "which now knows what to ask for: the product and the reagent");
    assert.deepEqual(texts(redraws[0]), texts(first), "nothing new to draw yet");
    assert.ok(redraws[0].refresh, "so it waits again");

    // The wire answers both; the item cache's change wakes it once more. The product's rows are
    // drawn, all but its own «Использование:» — its spell's row is one answer further, and
    // nothing else in the client would ever ask for it.
    redraws[0].refresh.watch((next) => redraws.push(next));
    templates.set(4592, snapper());
    templates.set(6289, rawSnapper());
    world.events.emit("QUERY_CACHE_CHANGED", { kind: "item", id: 6289 });
    assert.equal(redraws.length, 2);
    assert.deepEqual(texts(redraws[1]), RECIPE_STOCK_LINES.filter((line) => !line.startsWith("Использование: Восполнение")));
    assert.ok(redraws[1].refresh, "the product's spell is still on its way");
    redraws[1].refresh.watch((next) => redraws.push(next));
    await settle();
    assert.deepEqual(requested, [[483, 7753], [434]], "the product's spell is asked for once the product is known");
    assert.equal(redraws.length, 3, "and its arrival wakes the tooltip a last time");
    assert.deepEqual(texts(redraws[2]), RECIPE_STOCK_LINES);
    assert.equal(redraws[2].refresh, undefined, "nothing left to wait for");

    // The native panels' tooltip of the same recipe: its description as the Use line, and no
    // line for «Изучение» — a row with nothing to say is named by neither layout.
    const native = texts(itemTooltipFor(6328));
    assert.ok(native.includes("Использование: Обучает приготовлению острозубого илистого луциана."), native.join(" | "));
    assert.doesNotMatch(native.join("\n"), /Изучение|Заклинание|«/);
  } finally {
    resetStockTooltipRedraws();
    game.world = undefined;
    game.spellMetadataClient = undefined;
    game.spells.clear();
    clearSpellNames();
  }
});
