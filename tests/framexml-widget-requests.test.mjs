import assert from "node:assert/strict";
import test from "node:test";

const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { createFixtureProvider } = await import("../dist/code/browser/glue/GlueLoader.js");
const { FrameXmlDomRenderer } = await import("../dist/code/browser/ui/framexml_compat/FrameXmlDomRenderer.js");

// Widget C-methods other wave-3 lanes asked the widget core for (scratchpad NEEDS-RC.md): the loot
// roll, mailbox and trade GameTooltip setters, and the global SetPortraitToTexture. A fixture
// corpus whose link queries answer like the lanes' seams; no client needed.
const FIXTURE = `
UIParent = CreateFrame("Frame", "UIParent")
UIParent:SetSize(1024, 768)
Owner = CreateFrame("Button", "Owner", UIParent)
Owner:SetSize(40, 20)
GameTooltip = CreateFrame("GameTooltip", "GameTooltip", UIParent)
local ring = "|cffa335ee|Hitem:17063:0:0:0:0:0:0:0:60|h[Кольцо Аккурии]|h|r"
local rune = "|cff1eff00|Hitem:12662:0:0:0:0:0:0:0:60|h[Демоническая руна]|h|r"
function GetLootRollItemLink(id) if id == 7 then return ring end end
function GetInboxItemLink(index, attachment) if index == 2 and attachment == 1 then return rune end if index == 2 and attachment == 3 then return ring end end
function GetSendMailItemLink(slot) if slot == 1 then return rune end end
function GetTradePlayerItemLink(id) if id == 7 then return ring end end
function GetTradeTargetItemLink(id) if id == 2 then return rune end end
`;
const ITEMS = new Map([
  [17063, { title: "Кольцо Аккурии", quality: 4 }],
  [12662, { title: "Демоническая руна", quality: 2 }],
]);

async function bootWidgets() {
  const boot = new FrameXmlBoot({
    provider: createFixtureProvider({
      "interface/framexml/framexml.toc": "Fonts.xml\nWidgets.lua\nPortrait.xml",
      "interface/framexml/fonts.xml": `<Ui>
        <Font name="GameTooltipHeaderText" font="Fonts\\FRIZQT__.TTF"><FontHeight><AbsValue val="14"/></FontHeight></Font>
        <Font name="GameTooltipText" font="Fonts\\FRIZQT__.TTF"><FontHeight><AbsValue val="12"/></FontHeight></Font>
      </Ui>`,
      "interface/framexml/widgets.lua": FIXTURE,
      "interface/framexml/portrait.xml": `<Ui><Frame name="Letter" parent="UIParent"><Size x="64" y="64"/>
        <Anchors><Anchor point="TOPLEFT"/></Anchors>
        <Layers><Layer level="BACKGROUND"><Texture name="LetterIcon" file="Interface\\Icons\\INV_Letter_15">
          <Size x="58" y="58"/><Anchors><Anchor point="TOPLEFT"/></Anchors></Texture></Layer></Layers></Frame></Ui>`,
    }),
    subset: ["Fonts.xml", "Widgets.lua", "Portrait.xml"],
    exercise: false,
    gameTooltipAdapter: {
      inventoryItem: () => undefined,
      containerItem: () => undefined,
      item: (id) => ITEMS.get(id),
      spell: () => undefined,
    },
  });
  await boot.load();
  const run = (source, results = 0) => {
    const chunk = boot.vm.compileFunction(source, "@widget-requests", []);
    assert.ok(chunk, `compiles: ${source}`);
    try { return boot.vm.call(chunk, [], results); } finally { boot.vm.release(chunk); }
  };
  return { boot, run };
}

test("the loot roll, mailbox and trade tooltip setters show the item their link query names", async () => {
  const { boot, run } = await bootWidgets();
  try {
    const cases = [
      ["SetLootRollItem(7)", "Кольцо Аккурии"],
      ["SetInboxItem(2)", "Демоническая руна"],
      ["SetInboxItem(2, 3)", "Кольцо Аккурии"],
      ["SetSendMailItem(1)", "Демоническая руна"],
      ["SetTradePlayerItem(7)", "Кольцо Аккурии"],
      ["SetTradeTargetItem(2)", "Демоническая руна"],
    ];
    for (const [call, title] of cases) {
      assert.deepEqual(run(`GameTooltip:SetOwner(Owner, "ANCHOR_RIGHT") local shown = GameTooltip:${call}
        local name = GameTooltip:GetItem() return shown, GameTooltip:IsShown() and 1 or 0, name, GameTooltipTextLeft1:GetText()`, 4),
      [true, 1, title, title], call);
    }
    // An empty slot answers no link: nothing is drawn and the tooltip is not left showing stale rows.
    assert.deepEqual(run(`GameTooltip:SetOwner(Owner, "ANCHOR_RIGHT") GameTooltip:SetTradeTargetItem(7)
      return GameTooltip:IsShown() and 1 or 0`, 1), [0]);
    assert.deepEqual(boot.errors, []);
  } finally {
    boot.close();
  }
});

test("SetPortraitToTexture draws a named texture's picture cropped round; a plain SetTexture undoes the crop", async () => {
  const { boot, run } = await bootWidgets();
  const elements = [];
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
      elements.push(node);
      return node;
    },
  };
  doc.createElementNS = (_namespace, tag) => doc.createElement(tag);
  const renderer = new FrameXmlDomRenderer(doc.createElement("section"), { bridge: boot.bridge });
  try {
    renderer.mount(boot.roots);
    const icon = boot.bridge.getFrame("LetterIcon");
    const element = renderer.elementFor(icon);
    assert.equal(element.style.borderRadius ?? "", "");
    // MailFrame.lua:227 passes the texture's *name*.
    run(`SetPortraitToTexture("LetterIcon", "Interface\\\\Icons\\\\INV_Misc_Note_01")`);
    assert.equal(icon.texture, "Interface\\Icons\\INV_Misc_Note_01");
    assert.equal(icon.portrait, true);
    assert.equal(element.style.borderRadius, "50%");
    assert.deepEqual(run(`return LetterIcon:GetTexture()`, 1), ["Interface\\Icons\\INV_Misc_Note_01"]);
    run(`SetPortraitToTexture(LetterIcon, "Interface\\\\Icons\\\\INV_Letter_15") LetterIcon:SetTexture("Interface\\\\Icons\\\\INV_Letter_15")`);
    assert.equal(icon.portrait, false);
    assert.equal(element.style.borderRadius, "");
    // A frame that is not a Texture, or no picture, is refused without an error.
    run(`SetPortraitToTexture("Letter", "Interface\\\\Icons\\\\INV_Misc_Note_01") SetPortraitToTexture("LetterIcon")`);
    assert.equal(boot.bridge.getFrame("Letter").portrait, false);
    assert.deepEqual(boot.errors, []);
  } finally {
    renderer.destroy();
    boot.close();
  }
});

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

const MAIL_SHAPES = `<Ui>
  <Font name="SmallFont" font="Fonts\FRIZQT__.TTF" virtual="true"><FontHeight><AbsValue val="10"/></FontHeight></Font>
  <Font name="ButtonFont" font="Fonts\FRIZQT__.TTF" virtual="true"><FontHeight><AbsValue val="12"/></FontHeight></Font>
  <Button name="PanelButtonTemplate" virtual="true"><Size x="80" y="22"/>
    <ButtonText name="$parentText"><Anchors><Anchor point="CENTER"/></Anchors></ButtonText>
    <NormalFont style="ButtonFont"/>
  </Button>
  <Frame name="Sheet"><Size x="300" y="300"/><Anchors><Anchor point="TOPLEFT"/></Anchors>
    <Layers><Layer level="ARTWORK">
      <FontString name="SheetCaption" inherits="SmallFont" text="Забрать приложения:"><Anchors><Anchor point="TOPLEFT"/></Anchors></FontString>
      <FontString name="SheetTwoLines" inherits="SmallFont" text="first|nsecond"><Anchors><Anchor point="TOPLEFT"/></Anchors></FontString>
      <FontString name="SheetEmpty" inherits="SmallFont"><Anchors><Anchor point="TOPLEFT"/></Anchors></FontString>
    </Layer></Layers>
    <Frames>
      <Button name="SheetTradeButton" inherits="PanelButtonTemplate" text="Обмен">
        <Anchors><Anchor point="BOTTOMRIGHT"/></Anchors>
        <ButtonText text="Обмен"><Anchors><Anchor point="CENTER"><Offset><AbsDimension x="2" y="-1"/></Offset></Anchor></Anchors></ButtonText>
      </Button>
      <EditBox name="SheetBody" multiLine="true" autoFocus="false"><Size x="270" y="200"/><Anchors><Anchor point="TOPLEFT"/></Anchors>
        <FontString inherits="SmallFont"/></EditBox>
      <EditBox name="SheetName" autoFocus="false"><Size x="100" y="20"/><Anchors><Anchor point="TOPLEFT"/></Anchors></EditBox>
    </Frames>
  </Frame>
</Ui>`;

test("an unsized string is as tall as its lines; a second <ButtonText> is the same label; a multi-line box is a textarea", async () => {
  const boot = new FrameXmlBoot({
    provider: createFixtureProvider({ "interface/framexml/framexml.toc": "Mail.xml", "interface/framexml/mail.xml": MAIL_SHAPES }),
    exercise: false,
  });
  await boot.load();
  const run = (source, results = 0) => {
    const chunk = boot.vm.compileFunction(source, "@widget-requests", []);
    assert.ok(chunk, `compiles: ${source}`);
    try { return boot.vm.call(chunk, [], results); } finally { boot.vm.release(chunk); }
  };
  const renderer = new FrameXmlDomRenderer(stubDocument().createElement("section"), { bridge: boot.bridge });
  try {
    // MailFrame.lua:612 stacks rows under `OpenMailAttachmentText:GetHeight()`: the text's height.
    assert.deepEqual(run(`return SheetCaption:GetHeight(), SheetTwoLines:GetHeight(), SheetEmpty:GetHeight(), SheetCaption:GetStringHeight()`, 4),
      [10, 20, 0, 10]);
    // One label, the template's named `$parentText`, with the instance's text and anchor.
    const button = boot.bridge.getFrame("SheetTradeButton");
    const labels = button.children.filter((child) => child.type === "FontString");
    assert.equal(labels.length, 1, labels.map((label) => label.name).join(", "));
    assert.equal(labels[0], boot.bridge.getFrame("SheetTradeButtonText"));
    assert.equal(labels[0].text, "Обмен");
    assert.deepEqual(run(`local p, _, rp, x, y = SheetTradeButtonText:GetPoint(1) return SheetTradeButtonText:GetNumPoints(), p, rp, x, y`, 5),
      [1, "CENTER", "CENTER", 2, -1]);
    renderer.mount(boot.roots);
    const field = (name) => renderer.elementFor(boot.bridge.getFrame(name)).children
      .find((child) => child.getAttribute("data-framexml-input") === "true");
    assert.equal(field("SheetBody").tagName, "TEXTAREA");
    assert.equal(field("SheetBody").getAttribute("type"), null);
    assert.equal(field("SheetBody").style.padding, "0");
    assert.equal(field("SheetName").tagName, "INPUT");
    assert.equal(field("SheetName").getAttribute("type"), "text");
    assert.deepEqual(boot.errors, []);
  } finally {
    renderer.destroy();
    boot.close();
  }
});
