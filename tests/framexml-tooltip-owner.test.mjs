import assert from "node:assert/strict";
import test from "node:test";

const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { createFixtureProvider } = await import("../dist/code/browser/glue/GlueLoader.js");

// The GameTooltip C methods the stock corpus leans on, against a fixture corpus: the owner's
// lifecycle (UnitFrame_OnLeave's FadeOut, BuffFrame's IsOwned refresh), the 3.3.5 anchor table
// (BuffFrame.xml's ANCHOR_BOTTOMLEFT, PaperDollFrame's offsets) and what each setter answers and
// raises (GetItem/GetSpell, OnTooltipSetItem/OnTooltipSetSpell, SetInventoryItem's three values).
const FIXTURE = `
UIParent = CreateFrame("Frame", "UIParent")
UIParent:SetSize(1024, 768)
Owner = CreateFrame("Button", "Owner", UIParent)
Owner:SetSize(40, 20)
Owner:SetPoint("CENTER", UIParent, "CENTER", 0, 0)
Other = CreateFrame("Button", "Other", UIParent)
GameTooltip = CreateFrame("GameTooltip", "GameTooltip", UIParent)
Events = {}
GameTooltip:SetScript("OnTooltipSetItem", function(self) Events[#Events + 1] = "item" end)
GameTooltip:SetScript("OnTooltipSetSpell", function(self) Events[#Events + 1] = "spell" end)
local ITEM = "|cffa335ee|Hitem:19019:0:0:0:0:0:0:0|h[Громовая Ярость]|h|r"
local STONE = "|cffffffff|Hitem:6948:0:0:0:0:0:0:0|h[Камень возвращения]|h|r"
function GetInventoryItemLink(unit, slot) if slot == 16 then return ITEM end end
function GetInventoryItemCooldown(unit, slot) return 0, 0, 1 end
function GetContainerItemLink(bag, slot) return STONE end
function GetContainerItemCooldown(bag, slot) return 100, 30, 1 end
function GetActionInfo(slot) if slot == 1 then return "spell", 133 elseif slot == 2 then return "item", 6948 end end
function GetItemInfo(id) if id == 6948 then return "Камень возвращения", STONE end end
function GetSpellName(slot, book) if slot == 3 then return "Огненный шар", "Уровень 1" end end
function GetSpellLink(slot, book) if slot == 3 then return "|cff71d5ff|Hspell:133|h[Огненный шар]|h|r" end end
function UnitExists(unit) return unit == "player" end
function UnitName(unit) if unit == "player" then return "Игрок" end end
function UnitIsUnit(a, b) return a == b end
function UnitIsPlayer() return true end
function UnitLevel() return 80 end
function GameTooltip_UnitColor() return 1, 1, 1 end
`;

async function bootTooltip() {
  const boot = new FrameXmlBoot({
    provider: createFixtureProvider({
      "interface/framexml/framexml.toc": "TooltipFonts.xml\nTooltip.lua",
      "interface/framexml/tooltipfonts.xml": `<Ui>
        <Font name="GameTooltipHeaderText" font="Fonts\\FRIZQT__.TTF"><FontHeight><AbsValue val="14"/></FontHeight></Font>
        <Font name="GameTooltipText" font="Fonts\\FRIZQT__.TTF"><FontHeight><AbsValue val="12"/></FontHeight></Font>
      </Ui>`,
      "interface/framexml/tooltip.lua": FIXTURE,
    }),
    subset: ["TooltipFonts.xml", "Tooltip.lua"],
    exercise: false,
    gameTooltipAdapter: {
      inventoryItem: (_unit, slot) => slot === 16 ? { title: "Громовая Ярость", quality: 4 } : undefined,
      containerItem: () => ({ title: "Камень возвращения", quality: 1 }),
      action: (slot) => slot === 1 ? { title: "Огненный шар", lines: ["Уровень 1"] }
        : slot === 2 ? { title: "Камень возвращения", quality: 1 } : undefined,
      item: () => undefined,
      spell: () => undefined,
    },
  });
  await boot.load();
  const run = (source, results = 0) => {
    const chunk = boot.vm.compileFunction(source, "@tooltip-owner", []);
    assert.ok(chunk, `compiles: ${source}`);
    try { return boot.vm.call(chunk, [], results); } finally { boot.vm.release(chunk); }
  };
  return { boot, run, tooltip: boot.bridge.getFrame("GameTooltip") };
}

test("SetOwner implements every 3.3.5 anchor with its offsets", async () => {
  const { boot, run, tooltip } = await bootTooltip();
  try {
    const expected = {
      ANCHOR_RIGHT: ["BOTTOMLEFT", "TOPRIGHT"],
      ANCHOR_LEFT: ["BOTTOMRIGHT", "TOPLEFT"],
      ANCHOR_TOP: ["BOTTOM", "TOP"],
      ANCHOR_BOTTOM: ["TOP", "BOTTOM"],
      ANCHOR_TOPRIGHT: ["BOTTOMRIGHT", "TOPRIGHT"],
      ANCHOR_TOPLEFT: ["BOTTOMLEFT", "TOPLEFT"],
      ANCHOR_BOTTOMRIGHT: ["TOPLEFT", "BOTTOMRIGHT"],
      ANCHOR_BOTTOMLEFT: ["TOPRIGHT", "BOTTOMLEFT"],
      // A name the table does not know is ANCHOR_RIGHT, never «no points» at the screen corner.
      ANCHOR_SOMEWHERE: ["BOTTOMLEFT", "TOPRIGHT"],
    };
    for (const [anchor, [point, relativePoint]] of Object.entries(expected)) {
      const [numPoints, p, relative, rp, x, y] = run(`GameTooltip:SetOwner(Owner, "${anchor}", 6, -26)
        local p, r, rp, x, y = GameTooltip:GetPoint(1)
        return GameTooltip:GetNumPoints(), p, r and r:GetName(), rp, x, y`, 6);
      assert.deepEqual([numPoints, p, relative, rp, x, y], [1, point, "Owner", relativePoint, 6, -26], anchor);
    }
    run(`GameTooltip:ClearAllPoints() GameTooltip:SetPoint("CENTER", UIParent, "CENTER", 7, 8)
      GameTooltip:SetOwner(Owner, "ANCHOR_PRESERVE")`);
    assert.deepEqual(run(`local p, r, rp, x, y = GameTooltip:GetPoint(1) return p, r:GetName(), x, y`, 4),
      ["CENTER", "UIParent", 7, 8], "ANCHOR_PRESERVE keeps the points it had");
    assert.deepEqual(run(`GameTooltip:SetOwner(Owner, "ANCHOR_NONE") return GameTooltip:GetNumPoints(), GameTooltip:GetAnchorType()`, 2),
      [0, "ANCHOR_NONE"], "ANCHOR_NONE leaves placement to the caller");
    run(`GameTooltip:SetOwner(Owner, "ANCHOR_CURSOR", 4, 6)`);
    assert.deepEqual(tooltip.tooltipCursorAnchor, { x: 4, y: 6 }, "ANCHOR_CURSOR follows the pointer");
    assert.equal(tooltip.points.length, 0);
    run(`GameTooltip:SetOwner(Owner, "ANCHOR_RIGHT") GameTooltip:SetAnchorType("ANCHOR_LEFT", -30, 0)`);
    assert.deepEqual(run(`local p, r, rp, x = GameTooltip:GetPoint(1) return p, rp, x, GameTooltip:GetAnchorType()`, 4),
      ["BOTTOMRIGHT", "TOPLEFT", -30, "ANCHOR_LEFT"], "SetAnchorType re-places against the same owner");
    assert.equal(tooltip.tooltipCursorAnchor, undefined);
    assert.deepEqual(boot.errors, []);
  } finally { boot.close(); }
});

test("a hidden tooltip has no owner, however it was hidden", async () => {
  const { boot, run, tooltip } = await bootTooltip();
  try {
    const owned = () => run(`return GameTooltip:IsOwned(Owner), GameTooltip:GetOwner() == Owner, GameTooltip:GetAnchorType()`, 3);
    run(`GameTooltip:SetOwner(Owner, "ANCHOR_RIGHT") GameTooltip:SetText("Боевой крик") GameTooltip:Show()`);
    assert.deepEqual(owned(), [true, true, "ANCHOR_RIGHT"]);
    run(`GameTooltip:Hide()`);
    assert.deepEqual(owned(), [false, false, undefined], "Hide releases the owner BuffFrame's IsOwned refresh tests");

    run(`GameTooltip:SetOwner(Owner, "ANCHOR_CURSOR") GameTooltip:SetText("Игрок") GameTooltip:Show()`);
    assert.ok(tooltip.tooltipCursorAnchor);
    run(`GameTooltip:FadeOut()`);
    assert.equal(tooltip.visible, false, "FadeOut hides, as UnitFrame_OnLeave expects");
    assert.deepEqual(owned(), [false, false, undefined]);
    assert.equal(tooltip.tooltipCursorAnchor, undefined, "and stops following the cursor");

    run(`GameTooltip:SetOwner(Owner, "ANCHOR_RIGHT") GameTooltip:SetText("Игрок") GameTooltip:Show()`);
    run(`UIParent:Hide()`);
    assert.deepEqual(owned(), [false, false, undefined], "a hidden ancestor releases it too");
    run(`UIParent:Show()`);
    assert.deepEqual(boot.errors, []);
  } finally { boot.close(); }
});

test("a failed setter keeps the owner; Hide lets go of it even when already hidden", async () => {
  const { boot, run, tooltip } = await bootTooltip();
  try {
    const owner = (name) => run(`return GameTooltip:IsOwned(${name}), GameTooltip:GetOwner() == ${name}`, 2);
    // PaperDollItemSlotButton_OnEnter re-run while its tooltip is up (MODIFIER_STATE_CHANGED):
    // SetOwner, an empty slot, then SetText(slot name) on the tooltip it still owns.
    run(`GameTooltip:SetOwner(Other, "ANCHOR_RIGHT") GameTooltip:SetText("x") GameTooltip:Show()`);
    assert.equal(tooltip.visible, true);
    assert.deepEqual(run(`GameTooltip:SetOwner(Owner, "ANCHOR_RIGHT") return GameTooltip:SetInventoryItem("player", 5)`, 1), [false]);
    assert.equal(tooltip.visible, false, "nothing in the slot: the setter hides the tooltip");
    assert.deepEqual(owner("Owner"), [true, true], "but the owner stays for the SetText that follows");
    run(`GameTooltip:SetText("Грудь")`);
    assert.equal(tooltip.visible, true);
    assert.deepEqual(owner("Owner"), [true, true]);
    assert.deepEqual(run(`return GameTooltip:GetAnchorType()`, 1), ["ANCHOR_RIGHT"]);

    // ActionButton over an empty slot: SetAction already hid it, then OnLeave's Hide() fires no
    // OnHide — the owner must go anyway, or ActionButton_Update's GetOwner() == self re-shows it.
    run(`GameTooltip:Hide() GameTooltip:SetOwner(Owner, "ANCHOR_RIGHT")`);
    assert.deepEqual(run(`return GameTooltip:SetAction(13)`, 1), [false]);
    assert.equal(tooltip.visible, false);
    assert.deepEqual(owner("Owner"), [true, true], "still hovered: a slot filled now shows at once");
    run(`GameTooltip:Hide()`);
    assert.deepEqual(owner("Owner"), [false, false], "Hide of a hidden tooltip releases the owner");
    assert.deepEqual(run(`return GameTooltip:GetAnchorType()`, 1), [undefined]);

    run(`GameTooltip:SetOwner(Owner, "ANCHOR_CURSOR")`);
    assert.equal(tooltip.visible, false);
    run(`GameTooltip:FadeOut()`);
    assert.deepEqual(owner("Owner"), [false, false], "and so does FadeOut");
    assert.equal(tooltip.tooltipCursorAnchor, undefined);
    assert.deepEqual(boot.errors, []);
  } finally { boot.close(); }
});

test("SetTracking lists the active trackers, or the client's «none» line", async () => {
  const { boot, run, tooltip } = await bootTooltip();
  try {
    run(`MINIMAP_TRACKING_TOOLTIP_NONE = "Выбор объекта слежения"
      Trackers = { { "Поиск трав", "Interface\\\\Icons\\\\INV_Misc_Flower_02", nil, "spell" },
                   { "Поиск минералов", "Interface\\\\Icons\\\\Spell_Nature_Earthquake", nil, "spell" } }
      function GetNumTrackingTypes() return #Trackers end
      function GetTrackingInfo(id) local t = Trackers[id] if t then return t[1], t[2], t[3], t[4] end end`);
    // MiniMapTrackingButton's OnEnter (Minimap.xml:495-497), verbatim.
    const enter = () => run(`GameTooltip:SetOwner(Owner, "ANCHOR_RIGHT") GameTooltip:SetTracking()
      return GameTooltip:NumLines(), GameTooltipTextLeft1:GetText(), GameTooltipTextLeft2 and GameTooltipTextLeft2:IsShown() and GameTooltipTextLeft2:GetText() or false`, 3);
    assert.deepEqual(enter(), [1, "Выбор объекта слежения", false]);
    assert.equal(tooltip.visible, true);
    assert.deepEqual(run(`return GameTooltip:IsOwned(Owner)`, 1), [true]);
    run(`Trackers[2][3] = 1`);
    assert.deepEqual(enter(), [1, "Поиск минералов", false]);
    run(`Trackers[1][3] = 1`);
    assert.deepEqual(enter(), [2, "Поиск трав", "Поиск минералов"]);
    assert.deepEqual(boot.errors, []);
  } finally { boot.close(); }
});

test("SetOwner starts the tooltip empty for its new owner", async () => {
  const { boot, run } = await bootTooltip();
  try {
    run(`GameTooltip:SetOwner(Other, "ANCHOR_LEFT") GameTooltip:AddLine("Мои спутники")
      GameTooltip:AddLine("ПКМ: меню") GameTooltip:Show()`);
    // Minimap_SetTooltip's shape: SetOwner, then AddLine alone.
    assert.deepEqual(run(`GameTooltip:SetOwner(Owner, "ANCHOR_LEFT") GameTooltip:AddLine("Элвиннский лес")
      return GameTooltip:NumLines(), GameTooltipTextLeft1:GetText(), GameTooltipTextLeft2 and GameTooltipTextLeft2:IsShown()`, 3),
    [1, "Элвиннский лес", false]);
    run(`GameTooltip:SetMinimumWidth(250)`);
    assert.deepEqual(run(`return GameTooltip:GetMinimumWidth()`, 1), [250], "SetTooltipMoney compares against it");
    assert.deepEqual(boot.errors, []);
  } finally { boot.close(); }
});

test("each setter answers GetItem/GetSpell/IsUnit and raises its OnTooltipSet event", async () => {
  const { boot, run } = await bootTooltip();
  try {
    const events = () => run(`local copy = Events Events = {} return table.concat(copy, ",")`, 1)[0];
    run(`GameTooltip:SetOwner(Owner, "ANCHOR_RIGHT")`);
    events();

    assert.deepEqual(run(`return GameTooltip:SetInventoryItem("player", 16)`, 3), [true, undefined, 0],
      "hasItem, hasCooldown, repairCost for PaperDollItemSlotButton_OnEnter");
    assert.equal(events(), "item");
    const [itemName, itemLink] = run(`return GameTooltip:GetItem()`, 2);
    assert.equal(itemName, "Громовая Ярость");
    assert.match(itemLink, /item:19019/);
    assert.deepEqual(run(`return GameTooltip:IsEquippedItem()`, 1), [1]);

    assert.deepEqual(run(`return GameTooltip:SetBagItem(0, 1)`, 2), [1, 0], "hasCooldown, repairCost");
    assert.equal(events(), "item");
    assert.match(run(`return select(2, GameTooltip:GetItem())`, 1)[0], /item:6948/);
    assert.deepEqual(run(`return GameTooltip:IsEquippedItem()`, 1), [undefined]);

    assert.deepEqual(run(`return GameTooltip:SetAction(1)`, 1), [true]);
    assert.equal(events(), "spell");
    assert.deepEqual(run(`return GameTooltip:GetSpell()`, 3), ["Огненный шар", "Уровень 1", 133]);
    assert.deepEqual(run(`return GameTooltip:GetItem()`, 1), [undefined], "a new setter drops the old identity");

    assert.deepEqual(run(`return GameTooltip:SetAction(2)`, 1), [true]);
    assert.equal(events(), "item");
    assert.match(run(`return select(2, GameTooltip:GetItem())`, 1)[0], /item:6948/);

    assert.deepEqual(run(`return GameTooltip:SetSpell(3, "spell")`, 1), [true]);
    assert.equal(events(), "spell");
    assert.deepEqual(run(`return GameTooltip:GetSpell()`, 3), ["Огненный шар", "Уровень 1", 133]);

    assert.deepEqual(run(`return GameTooltip:SetUnit("player")`, 1), [true]);
    assert.deepEqual(run(`return GameTooltip:IsUnit("player"), GameTooltip:IsUnit("target")`, 2), [1, undefined]);
    assert.deepEqual(run(`return GameTooltip:GetSpell()`, 1), [undefined]);
    assert.deepEqual(boot.errors, []);
  } finally { boot.close(); }
});
