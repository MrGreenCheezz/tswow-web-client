import assert from "node:assert/strict";
import test from "node:test";

const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { GlueLuaVm } = await import("../dist/code/browser/glue/GlueLua.js");
const { GlueWidgetBinder } = await import("../dist/code/browser/glue/GlueWidgets.js");
const { createFixtureProvider } = await import("../dist/code/browser/glue/GlueLoader.js");
const { FrameXmlUiBridge } =
  await import("../dist/code/browser/ui/framexml_compat/FrameXmlRuntime.js");
const { parseFrameXml } = await import("../dist/code/browser/ui/framexml_compat/FrameXmlParser.js");

function templateElement() {
  const parsed = parseFrameXml(`<Ui>
    <Button name="DynamicButtonTemplate" virtual="true">
      <ButtonText name="$parentNormalText" parentKey="normalText" />
    </Button>
  </Ui>`);
  assert.equal(parsed.ok, true, parsed.diagnostics.join(" | "));
  assert.ok(parsed.root?.children[0]);
  return parsed.root.children[0];
}

test("runtime binds parentKey children before dynamic Button template setup", () => {
  const vm = new GlueLuaVm();
  const bridge = new FrameXmlUiBridge();
  const binder = new GlueWidgetBinder(vm, bridge);
  bridge.setRuntime(binder);
  vm.registerGlobal("CreateFrame", (args) => [bridge.CreateFrame(
    String(args[0] ?? "Frame"),
    args[1] === undefined ? undefined : String(args[1]),
    args[2],
    args[3] === undefined ? undefined : String(args[3]),
  )]);
  try {
    assert.equal(bridge.registerTemplateElement(templateElement()), true);

    const result = vm.execute(`
      local parent = CreateFrame("Frame", "DynamicParent")
      local button = CreateFrame("Button", "DynamicButton", parent, "DynamicButtonTemplate")
      button:SetText("Ready")
      DynamicButtonType = type(button)
      DynamicButtonText = button:GetText()
      DynamicNormalTextType = type(button.normalText)
      DynamicNormalText = button.normalText:GetText()
      local normalText = button.normalText
      local secondParent = CreateFrame("Frame", "DynamicSecondParent")
      normalText:SetParent(secondParent)
      DynamicOldParentKeyType = type(button.normalText)
      DynamicNewParentKeyType = type(secondParent.normalText)
      DynamicMovedParentName = normalText:GetParent():GetName()
      normalText:SetParent(button)
      DynamicReturnedParentKeyType = type(button.normalText)
      DynamicClearedNewParentKeyType = type(secondParent.normalText)
    `, "@dynamic-parent-key");
    assert.equal(result.ok, true, result.error ?? "dynamic template script failed");
    assert.equal(vm.getGlobal("DynamicButtonType"), "table");
    assert.equal(vm.getGlobal("DynamicButtonText"), "Ready");
    assert.equal(vm.getGlobal("DynamicNormalTextType"), "table");
    assert.equal(vm.getGlobal("DynamicNormalText"), "Ready");
    assert.equal(vm.getGlobal("DynamicOldParentKeyType"), "table");
    assert.equal(vm.getGlobal("DynamicNewParentKeyType"), "nil");
    assert.equal(vm.getGlobal("DynamicMovedParentName"), "DynamicSecondParent");
    assert.equal(vm.getGlobal("DynamicReturnedParentKeyType"), "table");
    assert.equal(vm.getGlobal("DynamicClearedNewParentKeyType"), "nil");
  } finally {
    vm.close();
  }
});

function widgetRuntime(xml) {
  const vm = new GlueLuaVm();
  const bridge = new FrameXmlUiBridge();
  const binder = new GlueWidgetBinder(vm, bridge);
  bridge.setRuntime(binder);
  const loaded = bridge.loadAddon(xml);
  assert.equal(loaded.ok, true, loaded.diagnostics.map((entry) => entry.message).join("\n"));
  bridge.registerFontObjects();
  const lua = (source, results = 0) => {
    const chunk = vm.compileFunction(source, "@runtime-binding", []);
    assert.ok(chunk, `compiles: ${source}`);
    try { return vm.call(chunk, [], results); } finally { vm.release(chunk); }
  };
  return { vm, bridge, loaded, lua };
}

test("a parentless frame is placed on the logical screen, not measured against itself", () => {
  const { vm, bridge, lua } = widgetRuntime(`<Ui>
    <Frame name="UIParent" setAllPoints="true"/>
    <Button name="TopButton" parent="UIParent" width="100" height="20">
      <Anchors><Anchor point="TOPLEFT" relativeTo="UIParent"><Offset x="100" y="-10"/></Anchor></Anchors>
    </Button>
    <Button name="ListLike" toplevel="true" hidden="true" width="150" height="60"/>
    <Frame name="Scaled" parent="UIParent" scale="0.5" width="80" height="40">
      <Anchors><Anchor point="TOPLEFT" relativeTo="UIParent"><Offset x="100" y="-100"/></Anchor></Anchors>
    </Frame>
  </Ui>`);
  // What the world mount answers for UIParent: the 768-unit logical screen.
  bridge.setMeasure((frame) => frame.name === "UIParent" ? { width: 1024, height: 768 } : undefined);
  try {
    const list = bridge.getFrame("ListLike");
    assert.equal(list.parent, undefined, "DropDownList1/2 are parentless in UIDropDownMenu.xml");
    lua(`ListLike:SetPoint("TOPLEFT", TopButton, "BOTTOMLEFT", 0, 0)`);
    // TopButton spans y 10..30 from the top, so the list's top is 768 - 30 = 738.
    assert.deepEqual(lua(`local x, y = ListLike:GetCenter() return ListLike:GetTop(), ListLike:GetBottom(), x, y`, 4),
      [738, 678, 175, 708], "UIDropDownMenu's off-screen test reads a positive centre");
    // Scale 0.5: 100 own units right and down are 50 on the screen; GetLeft/GetTop answer in the
    // frame's own coordinates, which is the screen position divided by the effective scale.
    assert.deepEqual(lua(`return Scaled:GetLeft(), Scaled:GetTop(), Scaled:GetRight(), Scaled:GetBottom(), Scaled:GetEffectiveScale()`, 5),
      [100, (768 - 50) / 0.5, 180, (768 - 70) / 0.5, 0.5]);
  } finally { vm.close(); }
});

test("IsEnabled answers 1 or 0 as 3.3.5 does, for buttons and sliders", () => {
  const { vm, lua } = widgetRuntime(`<Ui><Button name="Plain"/><Slider name="Bar"/></Ui>`);
  try {
    assert.deepEqual(lua(`local a = Plain:IsEnabled() Plain:Disable() local b = Plain:IsEnabled()
      Bar:Disable() local c = Bar:IsEnabled() Bar:Enable() return a, b, c, Bar:IsEnabled()`, 4), [1, 0, 0, 1]);
    // The two shapes stock code writes: `== 1` (UIPanelButtonTemplate) and `== 0` (micro buttons).
    assert.deepEqual(lua(`return Plain:IsEnabled() == 0, Plain:IsEnabled() == 1`, 2), [true, false]);
  } finally { vm.close(); }
});

test("a ButtonText with no font of its own draws in its button's state fonts", () => {
  const { vm, bridge, lua } = widgetRuntime(String.raw`<Ui>
    <Font name="TestFontNormal" font="Fonts\FRIZQT__.TTF"><FontHeight><AbsValue val="10"/></FontHeight>
      <Color r="1" g="0.82" b="0"/></Font>
    <Font name="TestFontHighlight" font="Fonts\FRIZQT__.TTF"><FontHeight><AbsValue val="10"/></FontHeight>
      <Color r="1" g="1" b="1"/></Font>
    <Font name="TestFontOwn" font="Fonts\ARIALN.TTF"><FontHeight><AbsValue val="16"/></FontHeight></Font>
    <Button name="TabLikeTemplate" virtual="true" text="Персонаж">
      <ButtonText name="$parentText"><Anchors><Anchor point="CENTER"/></Anchors></ButtonText>
      <NormalFont style="TestFontNormal"/>
      <HighlightFont style="TestFontHighlight"/>
      <DisabledFont style="TestFontHighlight"/>
    </Button>
    <Button name="TabLike1" inherits="TabLikeTemplate"/>
    <Button name="OwnFont" text="Свой">
      <ButtonText name="$parentText" inherits="TestFontOwn"/>
      <NormalFont style="TestFontNormal"/>
      <DisabledFont style="TestFontHighlight"/>
    </Button>
  </Ui>`);
  try {
    const label = bridge.getFrame("TabLike1Text");
    assert.equal(label.inheritsButtonFont, true);
    assert.equal(label.fontObject, "TestFontNormal", "the NormalFont declared after the ButtonText still reaches it");
    assert.deepEqual(lua(`return TabLike1Text:GetFont()`, 2), ["Fonts\\FRIZQT__.TTF", 10]);
    lua(`TabLike1:Disable()`);
    assert.equal(label.fontObject, "TestFontHighlight", "PanelTemplates_SelectTab's disabled tab turns white");
    lua(`TabLike1:SetDisabledFontObject("TestFontNormal")`);
    assert.equal(label.fontObject, "TestFontNormal", "a font setter re-dresses the label in its current state");
    lua(`TabLike1:Enable() TabLike1:SetNormalFontObject("TestFontHighlight")`);
    assert.equal(label.fontObject, "TestFontHighlight");
    const own = bridge.getFrame("OwnFontText");
    assert.equal(own.inheritsButtonFont, false, "a label that inherits a font keeps it");
    lua(`OwnFont:Disable()`);
    assert.equal(own.fontObject, "TestFontOwn");
  } finally { vm.close(); }
});

test("IsMouseOver reads the host's rectangle, with the edge offsets FCF_OnUpdate passes", () => {
  const { vm, bridge, lua } = widgetRuntime(`<Ui>
    <Frame name="UIParent" setAllPoints="true"/>
    <Frame name="ChatLike" parent="UIParent" width="400" height="120">
      <Anchors><Anchor point="BOTTOMLEFT" relativeTo="UIParent"><Offset x="20" y="100"/></Anchor></Anchors>
    </Frame>
    <Frame name="HiddenLike" parent="UIParent" hidden="true" width="1024" height="768"/>
  </Ui>`);
  const reads = [];
  bridge.setScreenRectSource((frame) => {
    reads.push(frame.name);
    return frame.name === "ChatLike"
      ? { left: 20, right: 420, bottom: 100, top: 220, width: 400, height: 120 } : undefined;
  });
  const over = (x, y, offsets = "") => {
    bridge.setMousePosition(x, y);
    return lua(`return ChatLike:IsMouseOver(${offsets})`, 1)[0];
  };
  try {
    assert.equal(over(200, 150), 1);
    assert.equal(over(200, 250), undefined, "30 units above the frame is outside it");
    assert.equal(over(200, 250, "45, -10, -5, 5"), 1, "…and inside the 45-unit band above it the chat fade asks about");
    assert.equal(over(200, 95, "45, -10, -5, 5"), 1, "the bottom edge moves down by 10");
    assert.equal(over(17, 150, "45, -10, -5, 5"), 1, "the left edge moves out by 5");
    assert.equal(over(426, 150, "45, -10, -5, 5"), undefined);
    assert.ok(reads.every((name) => name === "ChatLike"));
    bridge.setMousePosition(10, 10);
    assert.deepEqual(lua(`return HiddenLike:IsMouseOver()`, 1), [undefined], "a hidden frame is never under the cursor");
  } finally { vm.close(); }
});

test("Boot exposes the same dynamic Button text contract", async () => {
  const boot = new FrameXmlBoot({
    provider: createFixtureProvider({ "interface/framexml/framexml.toc": "" }),
    exercise: false,
  });
  try {
    await boot.load();
    const result = boot.vm.execute(`
      local button = CreateFrame("Button", "BootDynamicButton")
      button:SetText("Boot Ready")
      BootDynamicButtonText = button:GetText()
    `, "@boot-dynamic-button-text");
    assert.equal(result.ok, true, result.error ?? "Boot dynamic button script failed");
    assert.equal(boot.vm.getGlobal("BootDynamicButtonText"), "Boot Ready");
  } finally {
    boot.close();
  }
});
