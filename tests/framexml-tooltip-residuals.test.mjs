import assert from "node:assert/strict";
import test from "node:test";

const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { createFixtureProvider } = await import("../dist/code/browser/glue/GlueLoader.js");
const { FRAME_XML_SCRIPT_PARAMETERS } = await import("../dist/code/browser/ui/framexml_compat/FrameXmlRuntime.js");
const { plainFrameXmlText } = await import("../dist/code/browser/ui/framexml_compat/FrameXmlText.js");

// The GameTooltip setters' residuals after the stock spell layout moved a spell's rank to the right of
// its name (`titleRight`): the spell link's and the spellbook slot's identity and rows, the aura row
// that says how long is left and the aura's own words, late redraws that go with the tooltip, the
// handler arguments the XML bodies are compiled with, and the PreClick/PostClick wrappers around a
// click. A fixture corpus, no client needed.
const FIXTURE = `
UIParent = CreateFrame("Frame", "UIParent")
UIParent:SetSize(1024, 768)
Owner = CreateFrame("Button", "Owner", UIParent)
Owner:SetSize(40, 20)
GameTooltip = CreateFrame("GameTooltip", "GameTooltip", UIParent)
Events = {}
GameTooltip:SetScript("OnTooltipSetSpell", function(self) Events[#Events + 1] = "spell" end)
SPELL_TIME_REMAINING_DAYS = "Осталось: %d |4день:дня:дней;"
SPELL_TIME_REMAINING_HOURS = "Осталось: %d |4час:часа:часов;"
SPELL_TIME_REMAINING_MIN = "Осталось: %d |4минута:минуты:минут;"
SPELL_TIME_REMAINING_SEC = "Осталось: %d |4секунда:секунды:секунд;"
function GetSpellName(slot, book)
  if slot == 3 then return "Огненный шар", "Уровень 1" elseif slot == 4 then return "Молния", "Уровень 2" end
end
function GetSpellLink(slot, book) if slot == 3 then return "|cff71d5ff|Hspell:133|h[Огненный шар]|h|r" end end
Auras = {}
function UnitAura(unit, index, filter)
  local a = Auras[index]
  if a then return a[1], "", "", 0, nil, a[2], a[3], "player", nil, nil, a[4] end
end
function SetTooltipMoney() SetTooltipMoneyCalls = (SetTooltipMoneyCalls or 0) + 1 end
Clicks = {}
`;

/** The stock spell rows `Spellbook.stockSpellTooltip` hands over, with the rank on the right. */
const FIREBALL = {
  title: "Огненный шар", titleRight: "Уровень 1",
  lines: [
    { text: "Мана: 30", right: "Радиус действия: 35 м" },
    { text: "Применение: 1.5 сек." },
    { text: "Наносит урон от огня.", tone: "description", wrap: true },
  ],
};
const AXE = {
  title: "Секира", quality: 4,
  lines: [{ text: "Цена продажи: 1з 89с 91м", money: { copper: 18_991, label: "Цена продажи:" } }],
};

async function bootTooltip(adapter) {
  const boot = new FrameXmlBoot({
    provider: createFixtureProvider({
      "interface/framexml/framexml.toc": "TooltipFonts.xml\nTooltip.lua\nMoneyTip.xml\nClickWrap.xml",
      "interface/framexml/tooltipfonts.xml": `<Ui>
        <Font name="GameTooltipHeaderText" font="Fonts\\FRIZQT__.TTF"><FontHeight><AbsValue val="14"/></FontHeight></Font>
        <Font name="GameTooltipText" font="Fonts\\FRIZQT__.TTF"><FontHeight><AbsValue val="12"/></FontHeight></Font>
      </Ui>`,
      "interface/framexml/tooltip.lua": FIXTURE,
      // A named tooltip whose own XML body takes the price, as GameTooltipTemplate's does.
      "interface/framexml/moneytip.xml": `<Ui><GameTooltip name="MoneyTip" parent="UIParent" hidden="true"><Scripts>
        <OnTooltipAddMoney>MoneyArgs = { cost = cost, maxcost = maxcost }</OnTooltipAddMoney>
      </Scripts></GameTooltip></Ui>`,
      // SpellButtonTemplate's and ActionButtonTemplate's click wrappers, in their own words.
      "interface/framexml/clickwrap.xml": `<Ui><CheckButton name="WrapButton" parent="UIParent"><Size x="36" y="36"/><Scripts>
        <PreClick>Clicks[#Clicks + 1] = "pre " .. button .. " " .. tostring(down) .. " " .. tostring(self:GetChecked()) self:SetChecked(0)</PreClick>
        <OnClick>Clicks[#Clicks + 1] = "click " .. button .. " " .. tostring(self:GetChecked())</OnClick>
        <PostClick>Clicks[#Clicks + 1] = "post " .. button .. " " .. tostring(down)</PostClick>
      </Scripts></CheckButton></Ui>`,
    }),
    subset: ["TooltipFonts.xml", "Tooltip.lua", "MoneyTip.xml", "ClickWrap.xml"],
    exercise: false,
    gameTooltipAdapter: {
      inventoryItem: () => undefined,
      containerItem: () => undefined,
      item: () => undefined,
      spell: () => undefined,
      ...adapter,
    },
  });
  await boot.load();
  const run = (source, results = 0) => {
    const chunk = boot.vm.compileFunction(source, "@tooltip-residuals", []);
    assert.ok(chunk, `compiles: ${source}`);
    try { return boot.vm.call(chunk, [], results); } finally { boot.vm.release(chunk); }
  };
  const line = (side, index, tooltip = "GameTooltip") => boot.bridge.getFrame(`${tooltip}Text${side}${index}`);
  return { boot, run, line };
}

/** Content still waiting on a late answer, counting the redraws it was asked for and their cancels. */
function waiting(title) {
  const record = { redraw: undefined, watches: 0, cancels: 0 };
  record.content = {
    title, footer: ["Описание загружается…"],
    refresh: { watch(redraw) { record.redraw = redraw; record.watches += 1; return () => { record.cancels += 1; }; } },
  };
  return record;
}

test("GetSpell answers the rank of a spell link drawn in the stock layout", async () => {
  const { boot, run, line } = await bootTooltip({ spell: (id) => id === 133 ? FIREBALL : undefined });
  try {
    assert.deepEqual(run(`GameTooltip:SetOwner(Owner, "ANCHOR_RIGHT") return GameTooltip:SetHyperlink("spell:133")`, 1), [true]);
    assert.equal(line("Right", 1).text, "Уровень 1");
    assert.deepEqual(run(`return GameTooltip:GetSpell()`, 3), ["Огненный шар", "Уровень 1", 133],
      "the rank right of the name is the rank GetSpell answers");
    assert.deepEqual(boot.errors, []);
  } finally { boot.close(); }
});

test("SetSpell draws the spellbook slot's spell in the stock layout, or its name and rank without a link", async () => {
  const { boot, run, line } = await bootTooltip({ spell: (id) => id === 133 ? FIREBALL : undefined });
  try {
    const events = () => run(`local copy = Events Events = {} return table.concat(copy, ",")`, 1)[0];
    run(`GameTooltip:SetOwner(Owner, "ANCHOR_RIGHT")`);
    events();
    assert.deepEqual(run(`return GameTooltip:SetSpell(3, "spell")`, 1), [true]);
    assert.equal(line("Left", 1).text, "Огненный шар");
    assert.equal(line("Right", 1).text, "Уровень 1", "the rank sits right of the name");
    assert.ok(Math.abs(line("Right", 1).textColor.r - 0.5) < 0.01, "in grey");
    assert.equal(line("Left", 2).text, "Мана: 30");
    assert.equal(line("Right", 2).text, "Радиус действия: 35 м", "cost | range, as on the action bar");
    assert.equal(line("Left", 4).text, "Наносит урон от огня.");
    assert.ok(Math.abs(line("Left", 4).textColor.g - 0.82) < 0.01, "the description is gold");
    assert.deepEqual(run(`return GameTooltip:GetSpell()`, 3), ["Огненный шар", "Уровень 1", 133]);
    assert.equal(events(), "spell");

    // No link for the slot (a seam without GetSpellLink): the spellbook's own name and rank.
    assert.deepEqual(run(`return GameTooltip:SetSpell(4, "spell")`, 1), [true]);
    assert.equal(line("Left", 1).text, "Молния");
    assert.equal(line("Right", 1).text, "Уровень 2");
    assert.deepEqual(run(`return GameTooltip:NumLines()`, 1), [1]);
    assert.deepEqual(run(`return GameTooltip:GetSpell()`, 3), ["Молния", "Уровень 2", undefined]);
    assert.equal(events(), "spell");
    assert.deepEqual(boot.errors, []);
  } finally { boot.close(); }
});

test("a timed aura says how long it has left; a permanent one is redrawn when its words land", async () => {
  const pending = waiting("Аура благочестия");
  const { boot, run, line } = await bootTooltip({
    // Spell 6673 has both texts, as its DBC row does: the book's cast description and the buff's own.
    spell: (id) => id === 6673 ? { title: "Боевой крик", lines: [{ text: "Воин издает боевой крик.", tone: "description", wrap: true }] }
      : id === 465 ? pending.content : undefined,
    aura: (id) => id === 6673 ? { title: "Боевой крик", lines: [{ text: "Сила атаки увеличена на 15.", tone: "description", wrap: true }] }
      : undefined,
  });
  try {
    run(`function GetTime() return 1000 end
      Auras[1] = { "Боевой крик", 120, 1075, 6673 }
      Auras[2] = { "Аура благочестия", 0, 0, 465 }
      Auras[3] = { "Длинный бафф", 7200, 1000 + 3 * 3600 + 5 * 60, 6673 }
      Auras[4] = { "Короткий", 30, 1021.4, 6673 }`);
    run(`GameTooltip:SetOwner(Owner, "ANCHOR_BOTTOMLEFT")`);
    assert.deepEqual(run(`return GameTooltip:SetUnitAura("player", 1, "HELPFUL")`, 1), [true]);
    assert.equal(line("Left", 1).text, "Боевой крик");
    assert.equal(line("Left", 2).text, "Сила атаки увеличена на 15.", "the buff's own words, not the spellbook's");
    assert.equal(plainFrameXmlText(line("Left", 3).text), "Осталось: 2 минуты",
      "75 s left: whole minutes, rounded up like the buff button, in the client's plural");
    assert.ok(Math.abs(line("Left", 3).textColor.g - 0.82) < 0.01);
    assert.equal(line("Left", 3).attributes.wordWrap, "false");
    run(`GameTooltip:SetUnitAura("player", 3, "HELPFUL")`);
    assert.equal(plainFrameXmlText(line("Left", 3).text), "Осталось: 4 часа");
    run(`GameTooltip:SetUnitAura("player", 4, "HELPFUL")`);
    assert.equal(plainFrameXmlText(line("Left", 3).text), "Осталось: 21 секунда");

    // A permanent aura: no time row, and the late description reaches the tooltip. The adapter has no
    // aura text for it, so the spell's content (and its redraw) stands in.
    assert.deepEqual(run(`return GameTooltip:SetUnitAura("player", 2, "HELPFUL")`, 1), [true]);
    assert.equal(line("Left", 1).text, "Аура благочестия");
    assert.deepEqual(run(`return GameTooltip:NumLines()`, 1), [1], "no description yet and no time row");
    assert.equal(typeof pending.redraw, "function", "the aura passed its spell's late redraw on");
    pending.redraw({ title: "Аура благочестия", lines: [{ text: "Уменьшает получаемый урон.", tone: "description", wrap: true }] });
    assert.equal(line("Left", 1).text, "Аура благочестия", "still the aura's name");
    assert.equal(line("Left", 2).text, "Уменьшает получаемый урон.");
    assert.deepEqual(run(`return GameTooltip:NumLines()`, 1), [2]);
    assert.deepEqual(boot.errors, []);
  } finally { boot.close(); }
});

test("a pending redraw goes with its rows or its tooltip, and a closed VM says so itself", async () => {
  const link = waiting("Предмет 40001");
  const { boot, run, line } = await bootTooltip({ item: (entry) => entry === 40_001 ? link.content : undefined });
  let closed = false;
  try {
    run(`GameTooltip:SetOwner(Owner, "ANCHOR_RIGHT")`);
    run(`GameTooltip:SetHyperlink("item:40001")`);
    assert.deepEqual([link.watches, link.cancels], [1, 0]);
    run(`GameTooltip:SetText("Другое")`);
    assert.equal(link.cancels, 1, "new rows withdraw the redraw the old ones waited on");

    run(`GameTooltip:SetHyperlink("item:40001")`);
    run(`GameTooltip:Hide()`);
    assert.deepEqual([link.watches, link.cancels], [2, 2], "hiding the tooltip withdraws it too");

    // A redraw that lands draws, and what it drew waits again on a redraw of its own.
    run(`GameTooltip:SetOwner(Owner, "ANCHOR_RIGHT") GameTooltip:SetHyperlink("item:40001")`);
    const next = waiting("Предмет 40001");
    link.redraw({ ...next.content, title: "Кольцо", lines: [{ text: "Палец" }] });
    assert.equal(line("Left", 1).text, "Кольцо");
    assert.deepEqual([link.cancels, next.watches, next.cancels], [2, 1, 0], "the spent redraw is not cancelled again");
    run(`GameTooltip:ClearLines()`);
    assert.equal(next.cancels, 1, "the redraw the new rows wait on is the one withdrawn");

    assert.equal(boot.vm.closed, false);
    run(`GameTooltip:SetHyperlink("item:40001")`);
    const stale = link.redraw;
    boot.close();
    closed = true;
    assert.equal(boot.vm.closed, true, "the VM answers whether it is closed");
    assert.doesNotThrow(() => stale({ title: "Кольцо", lines: [{ text: "Палец" }] }));
    assert.equal(line("Left", 1).text, "Предмет 40001", "and the redraw drew nothing on a closed state");
  } finally {
    if (!closed) boot.close();
  }
});

test("SetTextInsets and SetHitRectInsets write the frame model the renderer draws, and read back", async () => {
  const { boot, run } = await bootTooltip({});
  try {
    // ChatEdit_UpdateHeader's own call (ChatFrame.lua:3627) with «Сказать: » 49 units wide.
    assert.deepEqual(run(`local box = CreateFrame("EditBox", "InsetBox", UIParent)
      box:SetTextInsets(15 + 49, 13, 0, 0)
      return box:GetTextInsets()`, 4), [64, 13, 0, 0]);
    const box = boot.bridge.getFrame("InsetBox");
    assert.deepEqual(box.textInsets, { left: 64, right: 13, top: 0, bottom: 0 });
    assert.equal(box.justifyH, "LEFT", "a created EditBox starts its text at the left too");
    assert.deepEqual(run(`Owner:SetHitRectInsets(0, 30, 0, 45) return Owner:GetHitRectInsets()`, 4), [0, 30, 0, 45]);
    assert.deepEqual(boot.bridge.getFrame("Owner").hitRectInsets, { left: 0, right: 30, top: 0, bottom: 45 });
    assert.deepEqual(boot.binder.stubDiagnostics.filter((item) => /Insets/.test(item.method)), [], "neither is a recorded stub");
    assert.deepEqual(boot.errors, []);
  } finally { boot.close(); }
});

test("XML handler bodies get their 3.3.5 arguments, and a tooltip's own OnTooltipAddMoney takes its price", async () => {
  assert.deepEqual(FRAME_XML_SCRIPT_PARAMETERS.OnTooltipAddMoney, ["self", "cost", "maxcost"]);
  for (const name of ["OnTooltipSetDefaultAnchor", "OnTooltipCleared", "OnTooltipSetItem", "OnTooltipSetSpell", "OnTooltipSetUnit"]) {
    assert.deepEqual(FRAME_XML_SCRIPT_PARAMETERS[name], ["self"], name);
  }
  assert.deepEqual(FRAME_XML_SCRIPT_PARAMETERS.OnAttributeChanged, ["self", "name", "value"]);
  assert.deepEqual(FRAME_XML_SCRIPT_PARAMETERS.OnCursorChanged, ["self", "x", "y", "w", "h"]);
  const { boot, run } = await bootTooltip({ item: (entry) => entry === 900 ? AXE : undefined });
  try {
    run(`MoneyTip:HookScript("OnTooltipAddMoney", function(self, cost, maxcost) HookedCost = cost end)`);
    assert.deepEqual(run(`MoneyTip:SetOwner(UIParent, "ANCHOR_NONE") return MoneyTip:SetHyperlink("item:900")`, 1), [true]);
    assert.deepEqual(run(`return MoneyArgs and MoneyArgs.cost, MoneyArgs and MoneyArgs.maxcost, HookedCost, SetTooltipMoneyCalls`, 4),
      [18_991, undefined, 18_991, undefined], "the body and its hook get the price; nothing calls around them");
    assert.deepEqual(boot.errors, []);
  } finally { boot.close(); }
});

test("a click runs PreClick, OnClick and PostClick with its button, after a CheckButton flips", async () => {
  const { boot, run } = await bootTooltip({});
  try {
    const clicks = () => run(`local copy = Clicks Clicks = {} return table.concat(copy, " | ")`, 1)[0];
    run(`WrapButton:HookScript("PostClick", function(self, button, down) Clicks[#Clicks + 1] = "hook " .. button end)`);
    run(`WrapButton:Click("RightButton", true)`);
    // The flip lands before PreClick (it reads 1), PreClick takes it back (OnClick reads nil), and
    // PostClick and its hook come last with the same arguments.
    assert.equal(clicks(), "pre RightButton true 1 | click RightButton nil | post RightButton true | hook RightButton");
    assert.deepEqual(run(`return WrapButton:GetChecked()`, 1), [undefined], "SpellButtonTemplate's PreClick leaves it unchecked");
    run(`WrapButton:Disable() WrapButton:Click()`);
    assert.equal(clicks(), "", "a disabled button runs none of the three");
    assert.deepEqual(boot.errors, []);
  } finally { boot.close(); }
});
