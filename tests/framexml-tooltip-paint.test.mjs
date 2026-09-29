// How the stock `GameTooltip` paints the content its C-methods are handed (`setGameTooltipContent`):
// a pair as one `AddDoubleLine` row, a spell's rank right of its name in grey, the exact stock
// colours, prose wrapped, the sell price on the tooltip whose own `OnTooltipAddMoney` takes it, and
// a redraw when a late answer lands. Runs the real vertical FrameXML corpus out of the local 3.3.5a
// client, like `framexml-tooltip-style.test.mjs`.

import assert from "node:assert/strict";
import test from "node:test";

let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine" };

const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { CannedWorldSeam, CANNED_ACTION_BAR } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { GlueWidgetBinder } = await import("../dist/code/browser/glue/GlueWidgets.js");
const { installFrameXmlNativeItemTooltip } = await import("../dist/code/browser/framexml/FrameXmlNativeItemTooltip.js");
const { extendItemTooltip } = await import("../dist/code/browser/ui/ItemTooltipExtensions.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

const decoder = new TextDecoder("utf-8");
let provider;
async function corpus() {
  if (provider) return provider;
  const { clientArchives } = await import("../tools/mpq.mjs");
  const chain = await clientArchives(clientDirectory);
  provider = {
    async read(path) {
      const data = await chain.read(path);
      return data ? decoder.decode(data) : undefined;
    },
  };
  return provider;
}

function close(actual, expected, message) {
  assert.ok(actual, `${message}: no colour`);
  for (const channel of ["r", "g", "b"]) {
    assert.ok(Math.abs(actual[channel] - expected[channel]) < 0.01,
      `${message}: ${channel} ${actual[channel]} vs ${expected[channel]}`);
  }
}

/** The stock rows `ItemTooltip.stockItemTooltipContent` hands over for a two-handed axe. */
const AXE = {
  title: "Секира", quality: 4,
  lines: [
    { text: "Двуручное", right: "Топор" },
    { text: "Урон: 100 - 200", right: "Скорость 3.70" },
    { text: "+23 к силе" },
    { text: "красное гнездо", color: "#808080" },
    { text: "Если на персонаже: Увеличивает силу заклинаний на 22 и делает ещё что-нибудь длинное.", tone: "spell", wrap: true },
    { text: "Цена продажи: 1з 89с 91м", money: { copper: 18_991, label: "Цена продажи:" } },
  ],
};

async function bootWith(adapter) {
  const boot = new FrameXmlBoot({
    provider: await corpus(), locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC,
    seam: new CannedWorldSeam(CANNED_ACTION_BAR), screen: () => ({ width: 1024, height: 768 }), exercise: false,
    gameTooltipAdapter: { inventoryItem: () => undefined, containerItem: () => undefined, ...adapter },
  });
  await boot.load();
  const run = (source, results = 0) => {
    const chunk = boot.vm.compileFunction(source, "@tooltip-paint", []);
    assert.ok(chunk, `compiles: ${source}`);
    try { return boot.vm.call(chunk, [], results); } finally { boot.vm.release(chunk); }
  };
  const line = (side, index) => boot.bridge.getFrame(`GameTooltipText${side}${index}`);
  return { boot, run, line };
}

test("stock content paints as pairs, a grey rank, exact colours, wrapped prose and the stock money row", withClient, async () => {
  const { boot, run, line } = await bootWith({
    item: (entry) => entry === 900 ? AXE : undefined,
    spell: (id) => id === 133 ? {
      title: "Огненный шар", titleRight: "Уровень 1",
      lines: [{ text: "Мана: 30", right: "Радиус действия: 35 м" }, { text: "Наносит урон.", tone: "description", wrap: true }],
    } : undefined,
  });
  try {
    assert.deepEqual(run(`GameTooltip:SetOwner(UIParent, "ANCHOR_NONE") return GameTooltip:SetHyperlink("item:900")`, 1), [true]);
    assert.equal(line("Left", 2).text, "Двуручное");
    assert.equal(line("Right", 2).text, "Топор");
    assert.equal(line("Right", 2).visible, true, "the slot row is a double line");
    assert.equal(line("Left", 3).text, "Урон: 100 - 200");
    assert.equal(line("Right", 3).text, "Скорость 3.70");
    close(line("Left", 4).textColor, { r: 1, g: 1, b: 1 }, "a base stat is white");
    close(line("Left", 5).textColor, { r: 0.5, g: 0.5, b: 0.5 }, "an empty socket is grey");
    close(line("Left", 6).textColor, { r: 0.1, g: 1, b: 0.1 }, "an Equip: line is green");
    assert.equal(line("Left", 6).attributes.wordWrap, "true", "and wraps");
    assert.equal(line("Left", 3).attributes.wordWrap, "false", "a pair does not");
    // The price is the corpus' own `SetTooltipMoney`: a blank row with the stock money frame on it.
    assert.equal(line("Left", 7).text, " ", "the row under the coins is the one SetTooltipMoney opened");
    const money = boot.bridge.getFrame("GameTooltipMoneyFrame1");
    assert.ok(money, "SetTooltipMoney created the stock money frame");
    assert.equal(money.visible, true);
    assert.equal(boot.bridge.getFrame("GameTooltipMoneyFrame1PrefixText").text, "Цена продажи:");
    assert.deepEqual(run("return GameTooltip.hasMoney", 1), [1]);
    assert.deepEqual(run("return GameTooltip:NumLines()", 1), [7]);

    assert.deepEqual(run(`return GameTooltip:SetHyperlink("spell:133")`, 1), [true]);
    assert.equal(line("Left", 1).text, "Огненный шар");
    assert.equal(line("Right", 1).text, "Уровень 1", "the rank sits right of the name");
    close(line("Right", 1).textColor, { r: 0.5, g: 0.5, b: 0.5 }, "in grey");
    assert.equal(line("Left", 2).text, "Мана: 30");
    assert.equal(line("Right", 2).text, "Радиус действия: 35 м");
    close(line("Left", 3).textColor, { r: 1, g: 0.82, b: 0 }, "the description is gold");
    assert.equal(line("Right", 3).visible, false, "the item's second double line is gone");
    assert.equal(money.visible, false, "OnTooltipCleared takes the coins away with the rows");
    assert.deepEqual(boot.errors, []);
  } finally {
    boot.close();
  }
});

/**
 * The stock rows of 6328 «Рецепт: острозубый илистый луциан» (`item-tooltip-recipe.test.mjs`), with
 * the product made epic so its colour is told from the recipe's white.
 */
const RECIPE = {
  title: "Рецепт: острозубый илистый луциан", quality: 1,
  lines: [
    { text: "Требуется: Кулинария (50)" },
    { text: "Использование: Обучает приготовлению острозубого илистого луциана.", tone: "spell", wrap: true },
    { text: " " },
    { text: "Острозубый илистый луциан", color: "#a335ee" },
    { text: "Требуется уровень: 5" },
    // The food's one-second category cooldown gets no tail (ItemTooltip.ts MIN_COOLDOWN_TAIL_SECONDS).
    { text: "Использование: Восполнение 58 ед. здоровья за 21 сек. Действие эффекта прерывается, если персонаж встает с места.", tone: "spell", wrap: true },
    { text: "Требуется: Сырой острозубый илистый луциан" },
    { text: "Цена продажи: 1с", money: { copper: 100, label: "Цена продажи:" } },
  ],
};

test("a recipe's block paints a blank row, the product's name in its colour, and the recipe's coins last", withClient, async () => {
  const { boot, run, line } = await bootWith({ item: (entry) => entry === 6328 ? RECIPE : undefined });
  try {
    assert.deepEqual(run(`GameTooltip:SetOwner(UIParent, "ANCHOR_NONE") return GameTooltip:SetHyperlink("item:6328")`, 1), [true]);
    assert.equal(line("Left", 1).text, "Рецепт: острозубый илистый луциан");
    close(line("Left", 1).textColor, { r: 1, g: 1, b: 1 }, "a common recipe's name is white");
    assert.equal(line("Left", 2).text, "Требуется: Кулинария (50)");
    close(line("Left", 3).textColor, { r: 0.1, g: 1, b: 0.1 }, "what it teaches is a green Use line");
    assert.equal(line("Left", 3).attributes.wordWrap, "true");
    // `AddLine(" ")`: the separator is a row of its own, not a dropped empty string.
    assert.equal(line("Left", 4).text, " ");
    assert.equal(line("Left", 4).visible, true, "the blank row between the recipe and its product is painted");
    assert.equal(line("Left", 5).text, "Острозубый илистый луциан");
    close(line("Left", 5).textColor, { r: 0xa3 / 255, g: 0x35 / 255, b: 0xee / 255 }, "the product's name in its own quality's colour");
    assert.equal(line("Left", 6).text, "Требуется уровень: 5");
    close(line("Left", 6).textColor, { r: 1, g: 1, b: 1 }, "the product's requirement is white");
    close(line("Left", 7).textColor, { r: 0.1, g: 1, b: 0.1 }, "the product's Use line is green");
    assert.equal(line("Left", 7).attributes.wordWrap, "true");
    assert.equal(line("Left", 8).text, "Требуется: Сырой острозубый илистый луциан");
    close(line("Left", 8).textColor, { r: 1, g: 1, b: 1 }, "the reagents are white");
    assert.equal(line("Left", 9).text, " ", "the row SetTooltipMoney opened for the recipe's coins");
    assert.equal(boot.bridge.getFrame("GameTooltipMoneyFrame1").visible, true);
    assert.equal(boot.bridge.getFrame("GameTooltipMoneyFrame1PrefixText").text, "Цена продажи:");
    assert.deepEqual(run("return GameTooltip:NumLines()", 1), [9]);
    assert.deepEqual(boot.errors, []);
  } finally {
    boot.close();
  }
});

test("a late answer redraws the stock tooltip, keeps an add-on's rows and GetItem, and spares a tooltip that moved on", withClient, async () => {
  let redraw;
  const waiting = { title: "Предмет 900", footer: ["Описание загружается…"], refresh: { watch(next) { redraw = next; return () => {}; } } };
  const { boot, run, line } = await bootWith({ item: (entry) => entry === 900 ? waiting : undefined });
  try {
    assert.deepEqual(run(`GameTooltip:SetOwner(UIParent, "ANCHOR_NONE")
      local ok = GameTooltip:SetHyperlink("|cffa335ee|Hitem:900:0:0:0:0:0:0:0|h[Секира]|h|r")
      GameTooltip:AddDoubleLine("ItemID:", "900")
      return ok`, 1), [true]);
    assert.equal(typeof redraw, "function", "waiting content registers its redraw");
    assert.equal(line("Left", 3).text, "ItemID:", "the add-on's row sits under the placeholder");
    const [, linkBefore] = run("return GameTooltip:GetItem()", 2);
    redraw(AXE);
    assert.equal(line("Left", 1).text, "Секира");
    assert.equal(line("Right", 2).text, "Топор");
    assert.equal(line("Left", 8).text, "ItemID:", "the add-on's row is carried below the new rows");
    assert.equal(line("Right", 8).text, "900");
    const [name, link] = run("return GameTooltip:GetItem()", 2);
    assert.equal(link, linkBefore, "GetItem still answers the link the setter was given");
    assert.equal(typeof name, "string");

    // A tooltip that has moved on is not overwritten by a late answer for what it showed before.
    redraw = undefined;
    run(`GameTooltip:SetHyperlink("item:900")`);
    const stale = redraw;
    run(`GameTooltip:SetText("Другое")`);
    stale(AXE);
    assert.equal(line("Left", 1).text, "Другое");
    assert.equal(line("Left", 2).visible, false);
    assert.deepEqual(boot.errors, []);
  } finally {
    boot.close();
  }
});

test("a price goes where the client sends it: the tooltip's own OnTooltipAddMoney, or nowhere", withClient, async () => {
  const { boot, run, line } = await bootWith({ item: (entry) => entry === 900 ? AXE : undefined });
  const errorsSince = (from) => boot.errors.slice(from).map((error) => String(error.message ?? error));
  try {
    // No handler, no price: `ShoppingTooltipTemplate` has none, and neither has a tooltip made
    // without a template. The stock `SetTooltipMoney` on an unnamed one raised at `GetName()..`.
    let from = boot.errors.length;
    assert.deepEqual(run(`local tip = CreateFrame("GameTooltip") tip:SetOwner(WorldFrame, "ANCHOR_NONE")
      local ok = tip:SetHyperlink("item:900") return ok, tip:NumLines()`, 2), [true, 6]);
    assert.deepEqual(errorsSince(from), [], "an unnamed tooltip without a handler raises nothing");
    assert.deepEqual(run(`ShoppingTooltip1:SetOwner(UIParent, "ANCHOR_NONE") ShoppingTooltip1:SetHyperlink("item:900")
      return ShoppingTooltip1:NumLines(), ShoppingTooltip1.hasMoney`, 2), [6, undefined]);
    // WCollections' `DataRequestTooltip` is a named GameTooltip without the template: every hover
    // used to start a money frame nothing ever cleared.
    assert.deepEqual(run(`local tip = CreateFrame("GameTooltip", "PaintScanTooltip", UIParent)
      for i = 1, 50 do tip:SetOwner(UIParent, "ANCHOR_NONE") tip:SetHyperlink("item:900") end
      return PaintScanTooltipMoneyFrame1 == nil, tip.shownMoneyFrames, tip:NumLines()`, 3), [true, undefined, 6]);

    // An add-on's own handler is what runs, with the price.
    assert.deepEqual(run(`local tip = CreateFrame("GameTooltip", "PaintScriptTooltip", UIParent, "GameTooltipTemplate")
      local seen tip:SetScript("OnTooltipAddMoney", function(self, cost) seen = cost end)
      tip:SetOwner(UIParent, "ANCHOR_NONE") tip:SetHyperlink("item:900")
      return seen, tip.hasMoney, tip:NumLines()`, 3), [18_991, undefined, 6]);

    // The template's handler on an unnamed tooltip would raise in `SetTooltipMoney`; the price
    // stays words. (Its `GameTooltip_OnLoad` raises at creation already, as it does in the client.)
    run(`PaintUnnamedTooltip = CreateFrame("GameTooltip", nil, UIParent, "GameTooltipTemplate")`);
    from = boot.errors.length;
    assert.deepEqual(run(`local tip = PaintUnnamedTooltip tip:SetOwner(UIParent, "ANCHOR_NONE")
      local ok = tip:SetHyperlink("item:900") return ok, tip:NumLines(), tip.hasMoney`, 3), [true, 7, undefined]);
    assert.deepEqual(errorsSince(from), [], "the price is words rather than an error");

    // And the template on a named tooltip is the stock coin row, as before.
    assert.deepEqual(run(`GameTooltip:SetOwner(UIParent, "ANCHOR_NONE") GameTooltip:SetHyperlink("item:900")
      return GameTooltip.hasMoney, GameTooltip:NumLines()`, 2), [1, 7]);
    assert.equal(line("Left", 7).text, " ");
  } finally {
    boot.close();
  }
});

test("a late redraw names the tooltip by the answer, and one that outlived its HUD draws nothing", withClient, async () => {
  let redraw;
  const waiting = (title) => ({ title, footer: ["Описание загружается…"], refresh: { watch(next) { redraw = next; return () => {}; } } });
  const { boot, run, line } = await bootWith({
    item: (entry) => entry === 40_001 ? waiting("Предмет 40001") : undefined,
    spell: (id) => id === 133 ? waiting("Заклинание 133") : undefined,
  });
  let closed = false;
  try {
    run(`ItemRefTooltip:SetOwner(UIParent, "ANCHOR_PRESERVE") ItemRefTooltip:SetHyperlink("item:40001")`);
    redraw({ title: "Кольцо запоздалого ответа", quality: 3, lines: [{ text: "Палец" }] });
    assert.equal(boot.bridge.getFrame("ItemRefTooltipTextLeft1").text, "Кольцо запоздалого ответа");
    assert.deepEqual(run("return ItemRefTooltip:GetItem()", 2), ["Кольцо запоздалого ответа", "item:40001"],
      "GetItem answers the name the row brought, not the placeholder");

    run(`GameTooltip:SetOwner(UIParent, "ANCHOR_NONE") GameTooltip:SetHyperlink("spell:133")`);
    redraw({ title: "Огненный шар", titleRight: "Уровень 1", lines: [{ text: "Наносит урон.", tone: "description", wrap: true }] });
    assert.equal(line("Right", 1).text, "Уровень 1");
    assert.deepEqual(run("return GameTooltip:GetSpell()", 3), ["Огненный шар", "Уровень 1", 133]);

    // A chat link left up when the HUD closed: its answer lands on a closed Lua state.
    run(`ItemRefTooltip:SetHyperlink("item:40001")`);
    const stale = redraw;
    boot.close();
    closed = true;
    assert.doesNotThrow(() => stale({ title: "Кольцо запоздалого ответа", lines: [{ text: "Палец" }] }));
    assert.equal(boot.bridge.getFrame("ItemRefTooltipTextLeft1").text, "Предмет 40001", "and it draws nothing");
  } finally {
    if (!closed) boot.close();
  }
});

test("a binder without GetMinimumWidth keeps the price as words, and the rest of the stock rows, rather than raising", withClient, async () => {
  // `SetTooltipMoney` ends on `frame:GetMinimumWidth() < moneyFrameWidth`; with the method only a
  // recorded stub that compare is nil against a number, one Lua error per hovered price.
  const methods = GlueWidgetBinder.prototype.gameTooltipMethods;
  GlueWidgetBinder.prototype.gameTooltipMethods = function () {
    const { GetMinimumWidth: _answered, ...rest } = methods.call(this);
    return rest;
  };
  let boot;
  try {
    const booted = await bootWith({ item: (entry) => entry === 900 ? AXE : undefined });
    boot = booted.boot;
    assert.deepEqual(booted.run(`GameTooltip:SetOwner(UIParent, "ANCHOR_NONE") return GameTooltip:SetHyperlink("item:900")`, 1), [true]);
    assert.equal(booted.line("Left", 7).text, "Цена продажи: 1з 89с 91м");
    assert.equal(boot.bridge.getFrame("GameTooltipMoneyFrame1")?.name, undefined, "no money frame was started");
    assert.equal(booted.line("Right", 2).text, "Топор", "only the price falls back; the pairs still draw");
    assert.equal(booted.line("Right", 3).text, "Скорость 3.70");
    assert.deepEqual(boot.errors, []);
  } finally {
    GlueWidgetBinder.prototype.gameTooltipMethods = methods;
    boot?.close();
  }
});

test("the native item tooltip keeps an add-on's AddDoubleLine row, as one line", withClient, async () => {
  const { boot, run } = await bootWith({ inventoryItem: () => ({ title: "Шлем", lines: [] }) });
  let cleanup;
  try {
    run(`hooksecurefunc(GameTooltip, "SetInventoryItem", function(self)
      self:AddDoubleLine(NORMAL_FONT_COLOR_CODE .. "ItemID:" .. FONT_COLOR_CODE_CLOSE, "|cffffffff99001|r")
      self:AddLine(" ")
    end)`);
    cleanup = installFrameXmlNativeItemTooltip(boot);
    const item = { guid: 2n, fields: new Map([[UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, 99001]]) };
    const content = extendItemTooltip({ bag: 255, slot: 0, index: 0, guid: 2n, item }, { title: "Шлем", lines: [] });
    const added = (content.lines ?? []).filter((line) => typeof line !== "string");
    assert.equal(added.length, 1, "the double line is kept and the blank money opener is not");
    assert.equal(added[0].text, "ItemID:  99001");
    assert.deepEqual(boot.errors, []);
  } finally {
    cleanup?.();
    boot.close();
  }
});
