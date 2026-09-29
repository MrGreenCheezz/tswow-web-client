import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Renderer and widget residuals other lanes asked for (wave 5, lane RZ): the profession and auction
// GameTooltip setters, a FontString's vertex colour as its text colour, the implicit button label
// drawn over the button's own art, a button label justified by its state font, the FrameXML focus
// ring rule. Fixture corpora; no client needed.

const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { createFixtureProvider } = await import("../dist/code/browser/glue/GlueLoader.js");
const { FrameXmlDomRenderer } = await import("../dist/code/browser/ui/framexml_compat/FrameXmlDomRenderer.js");

/** A minimal DOM stub, enough for the renderer to build and style elements. */
function stubDocument() {
  const doc = {
    createElement(tag) {
      const attributes = new Map();
      const node = {
        ownerDocument: doc, tagName: tag.toUpperCase(), children: [], parentElement: null, hidden: false, textContent: "",
        style: { setProperty(name, value) { this[name] = value; }, removeProperty(name) { delete this[name]; } },
        dataset: {}, classList: { add() {} }, addEventListener() {},
        setAttribute(name, value) { attributes.set(name, String(value)); }, getAttribute(name) { return attributes.get(name) ?? null; },
        removeAttribute(name) { attributes.delete(name); },
        append(...children) { for (const child of children) { child.parentElement = node; node.children.push(child); } },
        remove() { if (node.parentElement) node.parentElement.children.splice(node.parentElement.children.indexOf(node), 1); },
      };
      return node;
    },
  };
  doc.createElementNS = (_namespace, tag) => doc.createElement(tag);
  return doc;
}

function runner(boot) {
  return (source, results = 0) => {
    const chunk = boot.vm.compileFunction(source, "@renderer-rz", []);
    assert.ok(chunk, `compiles: ${source}`);
    try { return boot.vm.call(chunk, [], results); } finally { boot.vm.release(chunk); }
  };
}

// ---------------------------------------------------------------------------------------------
// RZ1: GameTooltip:SetTradeSkillItem / SetAuctionItem / SetAuctionSellItem.

const TOOLTIP_FIXTURE = `
UIParent = CreateFrame("Frame", "UIParent")
UIParent:SetSize(1024, 768)
Owner = CreateFrame("Button", "Owner", UIParent)
Owner:SetSize(40, 20)
GameTooltip = CreateFrame("GameTooltip", "GameTooltip", UIParent)
SetItems = 0
GameTooltip:HookScript("OnTooltipSetItem", function() SetItems = SetItems + 1 end)
local hammer = "|cff1eff00|Hitem:6214:0:0:0:0:0:0:0:0|h[Тяжелая медная кувалда]|h|r"
local ingot = "|cffffffff|Hitem:2840:0:0:0:0:0:0:0:0|h[Медный слиток]|h|r"
local enchant = "|cffffd000|Henchant:7418|h[Чары для наручей - здоровье I]|h|r"
local ring = "|cffa335ee|Hitem:17063:0:0:0:0:0:0:0:60|h[Кольцо Аккурии]|h|r"
function GetTradeSkillItemLink(index) if index == 2 then return hammer end if index == 5 then return enchant end end
function GetTradeSkillReagentItemLink(index, reagent) if index == 2 and reagent == 1 then return ingot end end
function GetAuctionItemLink(kind, index) if kind == "list" and index == 1 then return ring end if kind == "owner" and index == 3 then return hammer end end
SellSlot = nil
function WebClientAuctionSellItemLink() return SellSlot end
`;
const ITEMS = new Map([
  [6214, { title: "Тяжелая медная кувалда", quality: 2 }],
  [2840, { title: "Медный слиток", quality: 1 }],
  [17063, { title: "Кольцо Аккурии", quality: 4 }],
]);
const SPELLS = new Map([[7418, { title: "Чары для наручей - здоровье I" }]]);

async function bootTooltip() {
  const boot = new FrameXmlBoot({
    provider: createFixtureProvider({
      "interface/framexml/framexml.toc": "Fonts.xml\nWidgets.lua",
      "interface/framexml/fonts.xml": `<Ui>
        <Font name="GameTooltipHeaderText" font="Fonts\\FRIZQT__.TTF"><FontHeight><AbsValue val="14"/></FontHeight></Font>
        <Font name="GameTooltipText" font="Fonts\\FRIZQT__.TTF"><FontHeight><AbsValue val="12"/></FontHeight></Font>
      </Ui>`,
      "interface/framexml/widgets.lua": TOOLTIP_FIXTURE,
    }),
    subset: ["Fonts.xml", "Widgets.lua"],
    exercise: false,
    gameTooltipAdapter: {
      inventoryItem: () => undefined,
      containerItem: () => undefined,
      item: (id) => ITEMS.get(id),
      spell: (id) => SPELLS.get(id),
    },
  });
  await boot.load();
  return { boot, run: runner(boot) };
}

test("the profession and auction tooltip setters show what their link queries name, as real widget methods", async () => {
  const { boot, run } = await bootTooltip();
  try {
    const items = [
      // Blizzard_TradeSkillUI: the recipe icon (one argument) and a reagent button (two).
      ["SetTradeSkillItem(2)", "Тяжелая медная кувалда"],
      ["SetTradeSkillItem(2, 1)", "Медный слиток"],
      // Blizzard_AuctionUI: a Browse row, an Auctions-tab row.
      [`SetAuctionItem("list", 1)`, "Кольцо Аккурии"],
      [`SetAuctionItem("owner", 3)`, "Тяжелая медная кувалда"],
    ];
    for (const [call, title] of items) {
      assert.deepEqual(run(`SetItems = 0 GameTooltip:SetOwner(Owner, "ANCHOR_RIGHT") local shown = GameTooltip:${call}
        local name, link = GameTooltip:GetItem()
        return shown, GameTooltip:IsShown() and 1 or 0, name, GameTooltipTextLeft1:GetText(), SetItems, link ~= nil and 1 or 0`, 6),
      [true, 1, title, title, 1, 1], call);
    }
    // A recipe that makes no item: the enchant, through the spell adapter, as SetHyperlink shows it.
    assert.deepEqual(run(`GameTooltip:SetOwner(Owner, "ANCHOR_RIGHT") local shown = GameTooltip:SetTradeSkillItem(5)
      return shown, GameTooltip:IsShown() and 1 or 0, (GameTooltip:GetSpell()), GameTooltipTextLeft1:GetText()`, 4),
    [true, 1, "Чары для наручей - здоровье I", "Чары для наручей - здоровье I"]);
    // The sell slot: its link while an item is in it; an empty slot, a reagent or a row with no answer
    // hides the tooltip instead of leaving the last rows up.
    assert.deepEqual(run(`SellSlot = "|cffa335ee|Hitem:17063:0:0:0:0:0:0:0:60|h[Кольцо Аккурии]|h|r"
      GameTooltip:SetOwner(Owner, "ANCHOR_RIGHT") GameTooltip:SetAuctionSellItem()
      return GameTooltip:IsShown() and 1 or 0, (GameTooltip:GetItem())`, 2), [1, "Кольцо Аккурии"]);
    for (const call of [`SetItems = 0 SellSlot = nil GameTooltip:SetAuctionSellItem()`, "GameTooltip:SetTradeSkillItem(2, 4)",
      `GameTooltip:SetAuctionItem("bidder", 1)`]) {
      assert.deepEqual(run(`GameTooltip:SetOwner(Owner, "ANCHOR_RIGHT") GameTooltipTextLeft1:SetText("stale") GameTooltip:Show()
        ${call} return GameTooltip:IsShown() and 1 or 0`, 1), [0], call);
    }
    // Real methods, not the binder's recorded no-op: nothing reaches the stub census (the auction
    // owner's interim Lua fallback, installed only over a stub, is gone).
    const stubbed = boot.binder.stubDiagnostics
      .filter((record) => record.widgetType === "GameTooltip"
        && ["SetTradeSkillItem", "SetAuctionItem", "SetAuctionSellItem"].includes(record.method));
    assert.deepEqual(stubbed, []);
    assert.deepEqual(boot.errors, []);
  } finally {
    boot.close();
  }
});

// ---------------------------------------------------------------------------------------------
// RZ2-RZ4: text colour, the implicit label's stacking, a label's justification.

const SHAPES = `<Ui>
  <Font name="GameFontNormal" font="Fonts\\FRIZQT__.TTF" virtual="true"><FontHeight><AbsValue val="12"/></FontHeight><Color r="1" g="0.82" b="0"/></Font>
  <Font name="GameFontHighlight" inherits="GameFontNormal" virtual="true"><Color r="1" g="1" b="1"/></Font>
  <Font name="GameFontDisable" inherits="GameFontNormal" virtual="true"><Color r="0.5" g="0.5" b="0.5"/></Font>
  <Font name="GameFontNormalLeft" inherits="GameFontNormal" justifyH="LEFT" virtual="true"/>
  <Font name="GameFontHighlightLeft" inherits="GameFontHighlight" justifyH="LEFT" virtual="true"/>
  <Font name="GameFontDisableLeft" inherits="GameFontDisable" justifyH="LEFT" virtual="true"/>
  <Font name="GameFontNormalTopRight" inherits="GameFontNormal" justifyH="RIGHT" justifyV="TOP" virtual="true"/>
  <Button name="SkillRowTemplate" virtual="true"><Size x="293" y="16"/>
    <NormalTexture file="Interface\\Buttons\\UI-MinusButton-UP"><Size x="16" y="16"/><Anchors><Anchor point="LEFT"/></Anchors></NormalTexture>
    <ButtonText name="$parentText"><Size x="270" y="13"/><Anchors><Anchor point="LEFT"><Offset x="21" y="1"/></Anchor></Anchors></ButtonText>
    <NormalFont style="GameFontNormalLeft"/><HighlightFont style="GameFontHighlightLeft"/><DisabledFont style="GameFontDisableLeft"/>
  </Button>
  <Button name="RightRowTemplate" virtual="true"><Size x="100" y="16"/>
    <ButtonText name="$parentText" justifyH="RIGHT"><Size x="90" y="13"/><Anchors><Anchor point="LEFT"/></Anchors></ButtonText>
    <NormalFont style="GameFontNormalLeft"/>
  </Button>
  <Button name="GrayButtonTemplate" virtual="true"><Size x="80" y="22"/>
    <NormalTexture file="Interface\\Buttons\\UI-Panel-Button-Up"/>
    <HighlightTexture file="Interface\\Buttons\\UI-Panel-Button-Highlight" alphaMode="ADD"/>
    <NormalFont style="GameFontNormal"/>
  </Button>
  <Frame name="Sheet"><Size x="400" y="300"/><Anchors><Anchor point="TOPLEFT"/></Anchors>
    <Layers><Layer level="ARTWORK">
      <FontString name="SheetName" inherits="GameFontNormal" text="Льняной материал"><Anchors><Anchor point="TOPLEFT"/></Anchors></FontString>
      <Texture name="SheetIcon" file="Interface\\Icons\\INV_Misc_Note_01"><Size x="16" y="16"/><Anchors><Anchor point="TOPLEFT"/></Anchors></Texture>
    </Layer></Layers>
    <Frames>
      <Button name="SkillRow1" inherits="SkillRowTemplate" text="Дробящее"><Anchors><Anchor point="TOPLEFT"/></Anchors></Button>
      <Button name="SkillRowOwn" inherits="SkillRowTemplate" text="Своё">
        <Anchors><Anchor point="TOPLEFT"><Offset x="0" y="-20"/></Anchor></Anchors>
        <ButtonText justifyH="RIGHT"/>
      </Button>
      <Button name="RightRow" inherits="RightRowTemplate" text="Справа"><Anchors><Anchor point="TOPLEFT"><Offset x="0" y="-40"/></Anchor></Anchors></Button>
      <Button name="DeleteButton" inherits="GrayButtonTemplate" text="Удалить"><Anchors><Anchor point="BOTTOMLEFT"/></Anchors></Button>
      <Button name="LooseButton" text="Без размера"><Anchors><Anchor point="BOTTOMRIGHT"/></Anchors>
        <NormalTexture file="Interface\\Buttons\\UI-Panel-Button-Up"/></Button>
    </Frames>
  </Frame>
</Ui>`;

async function bootShapes() {
  const boot = new FrameXmlBoot({
    provider: createFixtureProvider({ "interface/framexml/framexml.toc": "Shapes.xml", "interface/framexml/shapes.xml": SHAPES }),
    exercise: false,
  });
  await boot.load();
  const renderer = new FrameXmlDomRenderer(stubDocument().createElement("section"), { bridge: boot.bridge });
  renderer.mount(boot.roots);
  return { boot, renderer, run: runner(boot), element: (name) => renderer.elementFor(boot.bridge.getFrame(name)) };
}

test("a FontString's vertex colour is its text colour: drawn, answered by GetTextColor, the later setter winning", async () => {
  const { boot, renderer, run, element } = await bootShapes();
  try {
    const name = element("SheetName");
    assert.equal(name.style.color, "rgba(255, 209, 0, 1)", "GameFontNormal's gold");
    // LootFrame.lua:111 / Blizzard_AuctionUI.lua:819: a common item's name in ITEM_QUALITY_COLORS[1].
    run("SheetName:SetVertexColor(1, 1, 1)");
    assert.equal(name.style.color, "rgba(255, 255, 255, 1)");
    assert.deepEqual(run("return SheetName:GetTextColor()", 3), [1, 1, 1]);
    assert.deepEqual(run("return SheetName:GetVertexColor()", 3), [1, 1, 1]);
    run("SheetName:SetVertexColor(0.12, 1, 0)");
    assert.equal(name.style.color, "rgba(31, 255, 0, 1)", "uncommon green");
    // Either setter paints; the later call wins.
    run("SheetName:SetTextColor(1, 0, 0)");
    assert.equal(name.style.color, "rgba(255, 0, 0, 1)");
    run("SheetName:SetVertexColor(0.5, 0.5, 0.5)");
    assert.equal(name.style.color, "rgba(128, 128, 128, 1)");
    // A Texture's vertex colour stays a tint; it names no text colour.
    run("SheetIcon:SetVertexColor(1, 0, 0)");
    assert.equal(boot.bridge.getFrame("SheetIcon").textColor, undefined);
    assert.deepEqual(boot.errors, []);
  } finally {
    renderer.destroy();
    boot.close();
  }
});

test("a button's implicit label draws over its Normal texture and under its Highlight, sized or not", async () => {
  const { boot, renderer, element } = await bootShapes();
  try {
    const labelOf = (name) => element(name).children.find((child) => child.getAttribute("data-framexml-label") === "true");
    const texture = (button, state) => renderer.elementFor(boot.bridge.getFrame(button).stateTextures.get(state));
    for (const name of ["DeleteButton", "LooseButton"]) {
      const label = labelOf(name);
      assert.ok(label, name);
      assert.equal(label.textContent || label.children.map((child) => child.textContent).join(""), boot.bridge.getFrame(name).text);
      assert.equal(label.style.zIndex, "400", name);
      assert.ok(Number(label.style.zIndex) > Number(texture(name, "NORMAL").style.zIndex), `${name}: over the plate`);
    }
    assert.ok(Number(labelOf("DeleteButton").style.zIndex) < Number(texture("DeleteButton", "HIGHLIGHT").style.zIndex),
      "under the highlight");
    // A sized button spans its label across itself; an unsized one keeps it in flow, still stacked.
    assert.equal(labelOf("DeleteButton").style.position, "absolute");
    assert.equal(labelOf("LooseButton").style.position, "relative");
    // A button whose text is its <ButtonText> leaves the implicit span empty and unpositioned.
    assert.equal(labelOf("SkillRow1").style.zIndex, undefined);
    assert.equal(labelOf("SkillRow1").style.position, undefined);
    assert.deepEqual(boot.errors, []);
  } finally {
    renderer.destroy();
    boot.close();
  }
});

test("a button label is justified by its state font unless it has an alignment of its own", async () => {
  const { boot, renderer, run, element } = await bootShapes();
  try {
    // ClassTrainerSkillButtonTemplate's shape: a bare <ButtonText> over GameFontNormalLeft.
    assert.deepEqual(run("return SkillRow1Text:GetJustifyH(), SkillRow1:GetFontString():GetJustifyH()", 2), ["LEFT", "LEFT"]);
    assert.equal(element("SkillRow1Text").style.textAlign, "left");
    // Lua re-fonts the row (Blizzard_TradeSkillUI.lua:154): the label follows the font's alignment.
    run(`SkillRow1:SetNormalFontObject("GameFontNormal")`);
    assert.deepEqual(run("return SkillRow1Text:GetJustifyH(), SkillRow1Text:GetJustifyV()", 2), ["CENTER", "MIDDLE"]);
    assert.equal(element("SkillRow1Text").style.textAlign, "center");
    run(`SkillRow1:SetNormalFontObject("GameFontNormalTopRight")`);
    assert.deepEqual(run("return SkillRow1Text:GetJustifyH(), SkillRow1Text:GetJustifyV()", 2), ["RIGHT", "TOP"]);
    assert.equal(element("SkillRow1Text").style.textAlign, "right");
    run(`SkillRow1:SetNormalFontObject("GameFontHighlightLeft")`);
    assert.equal(element("SkillRow1Text").style.textAlign, "left");
    // The disabled state's font, likewise.
    run(`SkillRow1:SetDisabledFontObject("GameFontNormal") SkillRow1:Disable()`);
    assert.deepEqual(run("return SkillRow1Text:GetJustifyH()", 1), ["CENTER"]);
    run("SkillRow1:Enable()");
    assert.deepEqual(run("return SkillRow1Text:GetJustifyH()", 1), ["LEFT"]);
    // An alignment of its own wins over every font: the XML one (the template's <ButtonText> or the
    // instance's) and a Lua SetJustifyH.
    assert.deepEqual(run("return RightRowText:GetJustifyH()", 1), ["RIGHT"]);
    assert.equal(element("RightRowText").style.textAlign, "right");
    assert.deepEqual(run("return SkillRowOwnText:GetJustifyH()", 1), ["RIGHT"]);
    assert.equal(element("SkillRowOwnText").style.textAlign, "right");
    run(`SkillRowOwn:SetNormalFontObject("GameFontNormal")`);
    assert.deepEqual(run("return SkillRowOwnText:GetJustifyH()", 1), ["RIGHT"]);
    run(`SkillRow1Text:SetJustifyH("CENTER") SkillRow1:SetNormalFontObject("GameFontNormalLeft")`);
    assert.deepEqual(run("return SkillRow1Text:GetJustifyH()", 1), ["CENTER"]);
    assert.equal(element("SkillRow1Text").style.textAlign, "center");
    assert.deepEqual(boot.errors, []);
  } finally {
    renderer.destroy();
    boot.close();
  }
});

let clientDirectory;
try {
  clientDirectory = (await import("../tools/paths.mjs")).clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine" };

test("the glue realm list's names are justified by their GlueFontNormalLeft, as the client draws them", withClient, async () => {
  // RealmList.xml's RealmListRealmButtonTemplate: a bare 220-wide <ButtonText> over GlueFontNormalLeft
  // (justifyH="LEFT"). The same label rule as the profession rows; the realm names were centred
  // before it. Across the whole corpus it moves the 18 realm rows and DropDownList1Button1, nothing
  // else (w5-RZ-renderer-fix/glue-justify-*.json).
  const { GlueRuntime: Runtime } = await import("../dist/code/browser/glue/GlueRuntime.js");
  const { clientArchives } = await import("../tools/mpq.mjs");
  const chain = await clientArchives(clientDirectory);
  const errors = [];
  const runtime = new Runtime({
    provider: {
      async read(path) {
        const data = await chain.read(path.replaceAll("/", "\\"));
        return data ? new TextDecoder("utf-8").decode(data) : undefined;
      },
    },
    lua: { onError: (message) => errors.push(message) },
    api: { locale: "ruRU", screenWidth: 1024, screenHeight: 768 },
  });
  try {
    await runtime.load();
    for (let row = 1; row <= 18; row += 1) {
      const label = runtime.bridge.getFrame(`RealmListRealmButton${row}NormalText`);
      assert.equal(`${label?.justifyH}/${label?.justifyV}`, "LEFT/MIDDLE", `row ${row}`);
    }
    assert.equal(runtime.vm.execute("RZ_JUSTIFY = RealmListRealmButton1:GetFontString():GetJustifyH()", "rz-glue").ok, true);
    assert.equal(runtime.vm.getGlobal("RZ_JUSTIFY"), "LEFT");
    assert.deepEqual(errors, []);
  } finally {
    runtime.close();
  }
});

test("style.css keeps the page's focus ring off every drawn FrameXML widget", () => {
  const css = readFileSync(new URL("../src/browser/style.css", import.meta.url), "utf8");
  // Outranks the page-wide `:focus-visible` ring (one pseudo-class) by the host id.
  assert.match(css, /#framexml-world-host \[data-framexml-name\]:focus-visible\s*\{\s*outline:\s*none;\s*\}/);
  assert.match(css, /^:focus-visible \{ outline: 2px solid/m);
});

// ---------------------------------------------------------------------------------------------
// RZ6: DeclineName / GetNumDeclensionSets in the glue, and the DeclinedWord dictionary route.

const D = await import("../dist/code/browser/ui/framexml_compat/FrameXmlDeclension.js");
const { GlueRuntime } = await import("../dist/code/browser/glue/GlueRuntime.js");

test("the glue's DeclineName and GetNumDeclensionSets answer the client's rule engine, not constants", async () => {
  // GlueLocalizationPost.lua's DeclensionFrame_Update shape: the set count, then five forms of a set.
  const runtime = new GlueRuntime({
    provider: createFixtureProvider({
      "Interface/GlueXML/GlueXML.toc": "Declension.lua",
      "Interface/GlueXML/Declension.lua": `
        COUNT_F = GetNumDeclensionSets("Аэлинда", 3)
        COUNT_M = GetNumDeclensionSets("Николай", 2)
        local forms = { DeclineName("Аэлинда", 3, 1) }
        FORMS = table.concat(forms, ",")
        SECOND = table.concat({ DeclineName("Аэлинда", 3, 2) }, ",")
        NONE = select("#", DeclineName("Аэлинда", 3, 3)) .. ":" .. tostring((DeclineName("Аэлинда", 3, 3)))
        MALE = table.concat({ DeclineName("Николай", 2, 1) }, ",")
      `,
    }),
    lua: { onError: (message) => { throw new Error(`unhandled glue Lua error: ${message}`); } },
    api: { locale: "ruRU", screenWidth: 1024, screenHeight: 768 },
  });
  try {
    await runtime.load();
    const global = (name) => runtime.vm.getGlobal(name);
    assert.equal(global("COUNT_F"), 2, "rule 32's sets (44, 0, 71)");
    assert.equal(global("COUNT_M"), 2);
    assert.equal(global("FORMS"), "Аэлинды,Аэлинде,Аэлинду,Аэлиндой,Аэлинде");
    assert.equal(global("SECOND"), "Аэлинда,Аэлинда,Аэлинда,Аэлинда,Аэлинда", "set 2 is row 0: nothing declines");
    assert.equal(global("NONE"), "5:nil", "a set the rule lacks answers five nils");
    assert.equal(global("MALE"), "Николая,Николаю,Николая,Николаем,Николае");
    assert.ok(!runtime.api.stubbedGlobals.includes("DeclineName"));
    assert.ok(!runtime.api.stubbedGlobals.includes("GetNumDeclensionSets"));
  } finally {
    runtime.close();
  }
});

test("the host's dictionary load installs the client's DeclinedWord tables, and degrades to rules without them", async () => {
  D.setFrameXmlDeclensionSource(undefined);
  try {
    // A gateway built before the route: 404, nothing installed, case 6 kept as written; asked again.
    let asked = 0;
    const missing = async () => { asked += 1; return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }; };
    assert.equal(await D.loadFrameXmlDeclensionDictionary("http://127.0.0.1:8090", missing), false);
    assert.equal(D.expandFrameXmlDeclension("%d ед. |3-6(Огонь)"), "%d ед. Огонь");
    assert.equal(D.expandFrameXmlDeclension("|3-5(Аэлинда)"), "Аэлинде", "the rules still decline 1-5");
    assert.equal(await D.loadFrameXmlDeclensionDictionary("http://127.0.0.1:8090", missing), false);
    assert.equal(asked, 2, "a failure is not kept");
    // Another shape is refused whole.
    const garbage = async () => ({ ok: true, status: 200, arrayBuffer: async () => new Uint8Array([9, 9, 9, 9, 1, 2]).buffer });
    assert.equal(await D.loadFrameXmlDeclensionDictionary("http://127.0.0.1:8090", garbage), false);
    // The route's body: DeclinedWord.dbc's length, then the two files.
    const words = wdbc([[10, "Огонь"], [11, "Паладин"]]);
    const cases = wdbc([[1, 10, 1, "Огня"], [2, 10, 6, "урона от огня"], [3, 11, 6, "паладин"]]);
    const body = new Uint8Array(4 + words.byteLength + cases.byteLength);
    new DataView(body.buffer).setUint32(0, words.byteLength, true);
    body.set(words, 4);
    body.set(cases, 4 + words.byteLength);
    const requested = [];
    const served = async (url) => { requested.push(url); return { ok: true, status: 200, arrayBuffer: async () => body.buffer }; };
    assert.equal(await D.loadFrameXmlDeclensionDictionary("http://127.0.0.1:8090", served), true);
    assert.deepEqual(requested, ["http://127.0.0.1:8090/dbc/declined-words?v=1"]);
    assert.equal(D.expandFrameXmlDeclension("%d ед. |3-6(Огонь)"), "%d ед. урона от огня");
    assert.equal(D.expandFrameXmlDeclension("|3-6(Паладин)"), "паладин");
    // Once is enough per page.
    assert.equal(await D.loadFrameXmlDeclensionDictionary("http://127.0.0.1:8090", served), true);
    assert.equal(requested.length, 1);
  } finally {
    D.setFrameXmlDeclensionSource(undefined);
  }
});

/** The route's body for two WDBC tables. */
function declinedBody(words, cases) {
  const body = new Uint8Array(4 + words.byteLength + cases.byteLength);
  new DataView(body.buffer).setUint32(0, words.byteLength, true);
  body.set(words, 4);
  body.set(cases, 4 + words.byteLength);
  return body;
}

test("the page indexes the dictionary a slice at a time and installs it whole; a newer source cancels it", async () => {
  // 1,100 plain words, then «Огонь» listed twice (the first listing is the one kept) around a word
  // without rows. Built at once, the client's 29,426 words were one 26-32 ms task at world entry.
  const wordRows = [];
  const caseRows = [];
  for (let n = 1; n <= 1100; n += 1) {
    wordRows.push([n, `Слово${n}`]);
    caseRows.push([n, n, 6, `форма${n}`]);
  }
  wordRows.push([1101, "Огонь"], [1102, "Пустое"], [1103, "Огонь"]);
  caseRows.push([1101, 1101, 6, "первое"], [1102, 1103, 6, "второе"]);
  const words = wdbc(wordRows);
  const cases = wdbc(caseRows);
  const index = D.frameXmlDeclinedWordIndex(words, cases);
  // A deadline already past: one batch per step, 512 + 512 + 79 words.
  assert.equal(index.step(() => true), false);
  assert.equal(index.word("Слово512", 6), "форма512");
  assert.equal(index.word("Слово513", 6), undefined, "not indexed yet");
  assert.equal(index.step(() => true), false);
  assert.equal(index.step(() => true), true);
  assert.equal(index.step(() => true), true, "done stays done");
  assert.equal(index.word("Слово1100", 6), "форма1100");
  assert.equal(index.word("Слово1100", 2), null, "listed without the case");
  assert.equal(index.word("Огонь", 6), "первое", "the first listing");
  assert.equal(index.word("Пустое", 6), undefined, "a word without rows is not in the table");
  assert.equal(index.word("Слово", 6), undefined, "the exact bytes: a prefix is another word");
  assert.equal(index.word("Слово11000", 6), undefined, "and so is a longer one");

  // The loader: every look at the clock finds the slice spent, so each batch is its own task.
  D.setFrameXmlDeclensionSource(undefined);
  const body = declinedBody(words, cases);
  const served = async () => ({ ok: true, status: 200, arrayBuffer: async () => body.buffer });
  const realNow = performance.now;
  const realSetTimeout = globalThis.setTimeout;
  let clock = 0;
  let tasks = 0;
  let onTask = () => {};
  performance.now = () => (clock += 10);
  globalThis.setTimeout = (callback, ms, ...rest) => {
    tasks += 1;
    onTask();
    return realSetTimeout(callback, ms, ...rest);
  };
  try {
    const load = D.loadFrameXmlDeclensionDictionary("http://127.0.0.1:8090", served);
    onTask = () => assert.equal(D.expandFrameXmlDeclension("|3-6(Слово1)"), "Слово1", "nothing is installed mid-build");
    assert.equal(await load, true);
    assert.equal(tasks, 2, "three slices, a task between each two");
    assert.equal(D.expandFrameXmlDeclension("|3-6(Слово1100)"), "форма1100");
    // The host replaces the source while a build is under way: that build installs nothing.
    D.setFrameXmlDeclensionSource(undefined);
    tasks = 0;
    onTask = () => { if (tasks === 1) D.setFrameXmlDeclensionSource({}); };
    assert.equal(await D.loadFrameXmlDeclensionDictionary("http://127.0.0.1:8090", served), false);
    assert.equal(D.expandFrameXmlDeclension("|3-6(Слово1)"), "Слово1");
  } finally {
    performance.now = realNow;
    globalThis.setTimeout = realSetTimeout;
    D.setFrameXmlDeclensionSource(undefined);
  }
});

test("/dbc/declined-words follows a rebuilt dataset: new tables are a new body and a new validator", async () => {
  // The gateway's dataset watch (DatasetFingerprint) forgets every DatasetIndexes entry on a DBC
  // change, this route's among them; tswow rebuilds the dataset while the gateway runs.
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = mkdtempSync(join(tmpdir(), "rz-declined-"));
  const write = (caseRows) => {
    writeFileSync(join(directory, "DeclinedWord.dbc"), wdbc([[10, "Огонь"]]));
    writeFileSync(join(directory, "DeclinedWordCases.dbc"), wdbc(caseRows));
  };
  write([[1, 10, 6, "урона от огня"]]);
  const { startGateway } = await import("../dist/code/gateway/Gateway.js");
  const origin = "http://127.0.0.1:5173";
  const gateway = await startGateway({
    host: "127.0.0.1", port: 0,
    auth: { host: "127.0.0.1", port: 1 }, world: { host: "127.0.0.1", port: 1 },
    allowedOrigins: [origin], dbcDirectory: directory, datasetPollMs: 0,
  });
  const url = `http://127.0.0.1:${gateway.port}/dbc/declined-words?v=1`;
  try {
    const first = await fetch(url, { headers: { origin } });
    const etag = first.headers.get("etag");
    assert.equal(D.frameXmlDeclinedWordsFromBody(new Uint8Array(await first.arrayBuffer()))("Огонь", 6), "урона от огня");
    assert.equal((await fetch(url, { headers: { origin, "if-none-match": etag } })).status, 304);
    write([[1, 10, 2, "огню"], [2, 10, 6, "огненного урона"]]);
    const second = await fetch(url, { headers: { origin, "if-none-match": etag } });
    assert.equal(second.status, 200, "the old validator no longer matches");
    assert.notEqual(second.headers.get("etag"), etag);
    assert.equal(D.frameXmlDeclinedWordsFromBody(new Uint8Array(await second.arrayBuffer()))("Огонь", 6), "огненного урона");
  } finally {
    await gateway.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the world mount asks for the dictionary after the HUD is up and redraws what it declined", () => {
  const source = readFileSync(new URL("../src/browser/framexml/FrameXmlWorldMount.ts", import.meta.url), "utf8");
  assert.match(source, /loadFrameXmlDeclensionDictionary\(origin\)\.then\(\(installed\) => \{\s*if \(installed[^\n]*renderer\.refreshDeclinedText\(\)/);
  // RZ7: a settings change only refits the stage; the renderer's container observer follows it.
  assert.match(source, /resources\.settingsCleanup = watchSettingsApplied\(fit\);/);
});

/**
 * A DOM stub with the layout the anchor arithmetic reads (framexml-renderer-anchors-strata's, without
 * its focus and events): an element's offset box is its inline pixel geometry inside its parent,
 * `%` and `calc(P% ± Npx)` resolved against the parent's box; the container ends the chain.
 */
function layoutDocument() {
  const doc = { getElementById: () => null };
  const pixels = (value) => {
    const match = /^(-?\d+(?:\.\d+)?)px$/.exec(String(value ?? ""));
    return match ? Number(match[1]) : undefined;
  };
  const hiddenUp = (node) => {
    for (let current = node; current; current = current.parentElement) if (current.hidden) return true;
    return false;
  };
  const length = (value, base) => {
    const text = String(value ?? "").trim();
    if (!text) return undefined;
    const direct = pixels(text);
    if (direct !== undefined) return direct;
    const percent = /^(-?\d+(?:\.\d+)?)%$/.exec(text);
    if (percent) return base === undefined ? undefined : Number(percent[1]) * base / 100;
    const calc = /^calc\((-?\d+(?:\.\d+)?)% ([+-]) (-?\d+(?:\.\d+)?)px\)$/.exec(text);
    if (calc && base !== undefined) return Number(calc[1]) * base / 100 + (calc[2] === "+" ? 1 : -1) * Number(calc[3]);
    return undefined;
  };
  const parentSize = (node, axis) => {
    const parent = node.parentElement;
    return parent ? (axis === "width" ? parent.offsetWidth : parent.offsetHeight) : undefined;
  };
  const size = (node, start, end, axis) => {
    const declared = pixels(node.style[axis]);
    if (declared !== undefined) return declared;
    const base = parentSize(node, axis);
    const from = length(node.style[start], base);
    const to = length(node.style[end], base);
    return from !== undefined && to !== undefined && base !== undefined ? base - from - to : undefined;
  };
  const box = (node, start, end, axis) => {
    const base = parentSize(node, axis);
    const from = length(node.style[start], base);
    if (from !== undefined) return from;
    const to = length(node.style[end], base);
    const own = size(node, start, end, axis) ?? 0;
    return to !== undefined && base !== undefined ? base - to - own : undefined;
  };
  const make = (tag) => {
    const attributes = new Map();
    const node = {
      ownerDocument: doc, tagName: String(tag).toUpperCase(), children: [], parentElement: null, hidden: false,
      textContent: "", dataset: {}, className: "", container: false,
      style: {
        setProperty(name, value) { this[name] = value; },
        removeProperty(name) {
          delete this[name];
          delete this[name.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())];
        },
      },
      classList: { add() {} },
      addEventListener() {},
      removeEventListener() {},
      setAttribute(name, value) { attributes.set(name, String(value)); },
      getAttribute(name) { return attributes.get(name) ?? null; },
      removeAttribute(name) { attributes.delete(name); },
      append(...children) {
        for (const child of children) {
          child.remove();
          child.parentElement = node;
          node.children.push(child);
        }
      },
      insertBefore(child, before) {
        child.remove();
        child.parentElement = node;
        const index = node.children.indexOf(before);
        node.children.splice(index < 0 ? node.children.length : index, 0, child);
      },
      remove() {
        const parent = node.parentElement;
        if (!parent) return;
        parent.children.splice(parent.children.indexOf(node), 1);
        node.parentElement = null;
      },
      get offsetParent() { return node.container || hiddenUp(node) ? null : node.parentElement; },
      get offsetLeft() { return hiddenUp(node) ? 0 : box(node, "left", "right", "width") ?? 0; },
      get offsetTop() { return hiddenUp(node) ? 0 : box(node, "top", "bottom", "height") ?? 0; },
      get offsetWidth() { return hiddenUp(node) ? 0 : size(node, "left", "right", "width") ?? 0; },
      get offsetHeight() { return hiddenUp(node) ? 0 : size(node, "top", "bottom", "height") ?? 0; },
    };
    return node;
  };
  doc.createElement = make;
  doc.createElementNS = (_namespace, tag) => make(tag);
  doc.head = make("head");
  return doc;
}

// MultiBarBottomLeft's shape: a HIGH bar in a strata layer over a MEDIUM screen root, anchored to a
// bar the screen places by its right edge.
const SCALED = `<Ui>
  <Frame name="Screen" frameStrata="MEDIUM"><Anchors><Anchor point="TOPLEFT"/><Anchor point="BOTTOMRIGHT"/></Anchors><Frames>
    <Frame name="MainBar"><Size x="200" y="40"/><Anchors><Anchor point="BOTTOMRIGHT"/></Anchors></Frame>
    <Frame name="ExtraBar" frameStrata="HIGH"><Size x="100" y="20"/>
      <Anchors><Anchor point="BOTTOMLEFT" relativeTo="MainBar" relativePoint="TOPLEFT"/></Anchors></Frame>
  </Frames></Frame>
</Ui>`;

test("a UI-scale change re-places the screen through the stage's box alone: no sync, no structural pass", async () => {
  const { frameXmlViewport } = await import("../dist/code/browser/framexml/FrameXmlWorldPolicy.js");
  const boot = new FrameXmlBoot({
    provider: createFixtureProvider({ "interface/framexml/framexml.toc": "Scaled.xml", "interface/framexml/scaled.xml": SCALED }),
    exercise: false,
  });
  await boot.load();
  // The container's observer, driven by the test (the browser reports after layout).
  const observers = new Set();
  const doc = layoutDocument();
  doc.defaultView = {
    ResizeObserver: class {
      constructor(callback) { this.callback = callback; }
      observe(target) { this.target = target; observers.add(this); }
      disconnect() { observers.delete(this); }
    },
    addEventListener() {},
    removeEventListener() {},
  };
  const host = doc.createElement("section");
  host.container = true;
  // What the world mount's `fit` writes on the stage for a 1600x900 window at `uiScale` percent.
  const fit = (uiScale) => {
    const logical = frameXmlViewport(1600, 900, uiScale);
    host.style.width = `${logical.width}px`;
    host.style.height = `${logical.height}px`;
    return logical;
  };
  const start = fit(100);
  const renderer = new FrameXmlDomRenderer(host, { bridge: boot.bridge });
  renderer.mount(boot.roots);
  try {
    const bar = renderer.elementFor(boot.bridge.getFrame("ExtraBar"));
    const layer = bar.parentElement;
    assert.equal(layer.getAttribute("data-framexml-strata-layer"), "ExtraBar");
    assert.deepEqual([layer.style.width, bar.style.left], [`${start.width}px`, `${start.width - 200}px`]);
    const structure = boot.bridge.structureVersion;
    const mutation = boot.bridge.mutationVersion;
    let syncs = 0;
    const sync = renderer.sync.bind(renderer);
    renderer.sync = (...args) => { syncs += 1; return sync(...args); };
    for (const uiScale of [80, 64, 100]) {
      const logical = fit(uiScale);
      for (const observer of observers) observer.callback([{ target: observer.target }], observer);
      assert.deepEqual([layer.style.width, layer.style.height, bar.style.left],
        [`${logical.width}px`, `${logical.height}px`, `${logical.width - 200}px`], `uiScale ${uiScale}`);
    }
    assert.equal(syncs, 0, "no sync pass");
    assert.equal(boot.bridge.structureVersion, structure, "no structural pass");
    assert.equal(boot.bridge.mutationVersion, mutation, "nothing was mutated in Lua");
    assert.deepEqual(boot.errors, []);
  } finally {
    renderer.destroy();
    boot.close();
  }
});

const DATASET = "F:/tswowRoot/tswow-install/modules/default/datasets/dataset/dbc";
const { existsSync } = await import("node:fs");
test("/dbc/declined-words is origin-protected, versioned, gzipped, revalidated, and what the client installs", {
  skip: existsSync(`${DATASET}/DeclinedWordCases.dbc`) ? false : "no dataset DBC on this machine",
}, async () => {
  // In process, on an ephemeral port; the realm addresses point nowhere and are never dialled.
  const { startGateway } = await import("../dist/code/gateway/Gateway.js");
  const origin = "http://127.0.0.1:5173";
  const gateway = await startGateway({
    host: "127.0.0.1", port: 0,
    auth: { host: "127.0.0.1", port: 1 }, world: { host: "127.0.0.1", port: 1 },
    allowedOrigins: [origin], dbcDirectory: DATASET, datasetPollMs: 0,
  });
  const base = `http://127.0.0.1:${gateway.port}/dbc/declined-words`;
  D.setFrameXmlDeclensionSource(undefined);
  try {
    assert.equal((await fetch(`${base}?v=1`)).status, 403);
    assert.equal((await fetch(`${base}?v=2`, { headers: { origin } })).status, 400);
    const started = performance.now();
    const response = await fetch(`${base}?v=1`, { headers: { origin, "accept-encoding": "gzip" } });
    const firstMs = performance.now() - started;
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-encoding"), "gzip");
    assert.equal(response.headers.get("cache-control"), "public, max-age=0, must-revalidate");
    const etag = response.headers.get("etag");
    assert.match(etag, /^W\/"[0-9a-f]{40}"$/);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const wordsLength = new DataView(bytes.buffer).getUint32(0, true);
    const { statSync } = await import("node:fs");
    assert.equal(wordsLength, statSync(`${DATASET}/DeclinedWord.dbc`).size);
    assert.equal(bytes.byteLength, 4 + wordsLength + statSync(`${DATASET}/DeclinedWordCases.dbc`).size);
    // An unchanged dataset answers 304; a browser without gzip gets the same body plain.
    assert.equal((await fetch(`${base}?v=1`, { headers: { origin, "if-none-match": etag } })).status, 304);
    const plain = await fetch(`${base}?v=1`, { headers: { origin, "accept-encoding": "identity" } });
    assert.equal(plain.headers.get("content-encoding"), null);
    assert.equal((await plain.arrayBuffer()).byteLength, bytes.byteLength);
    // The browser half over the real route: the client's own special cases.
    assert.equal(await D.loadFrameXmlDeclensionDictionary(`http://127.0.0.1:${gateway.port}`,
      (url) => fetch(url, { headers: { origin } })), true);
    assert.equal(D.expandFrameXmlDeclension("%d ед. |3-6(Огонь)"), "%d ед. урона от огня");
    assert.equal(D.expandFrameXmlDeclension("|3-8(Штормград)"), "Штормград подвергается");
    assert.equal(D.expandFrameXmlDeclension("|3-1(Косматый молодой волк)"), "Косматого молодого волка");
    console.log(`[declined-words] ${bytes.byteLength} bytes, first answer ${Math.round(firstMs)} ms`);
  } finally {
    D.setFrameXmlDeclensionSource(undefined);
    await gateway.close();
  }
});

/** A WDBC file: `rows` of uint32/string fields, strings interned into the block. */
function wdbc(rows) {
  const fields = rows[0].length;
  const strings = [0];
  const offsets = new Map([["", 0]]);
  const encoder = new TextEncoder();
  const intern = (text) => {
    if (!offsets.has(text)) {
      offsets.set(text, strings.length);
      strings.push(...encoder.encode(text), 0);
    }
    return offsets.get(text);
  };
  const values = rows.map((row) => row.map((value) => (typeof value === "string" ? intern(value) : value)));
  const bytes = new Uint8Array(20 + rows.length * fields * 4 + strings.length);
  const view = new DataView(bytes.buffer);
  bytes.set([0x57, 0x44, 0x42, 0x43]);
  view.setUint32(4, rows.length, true);
  view.setUint32(8, fields, true);
  view.setUint32(12, fields * 4, true);
  view.setUint32(16, strings.length, true);
  values.forEach((row, r) => row.forEach((value, f) => view.setUint32(20 + (r * fields + f) * 4, value, true)));
  bytes.set(strings, 20 + rows.length * fields * 4);
  return bytes;
}
