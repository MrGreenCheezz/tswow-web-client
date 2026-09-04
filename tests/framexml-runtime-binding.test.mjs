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
      normalText:SetParent(button)
      DynamicReturnedParentKeyType = type(button.normalText)
      DynamicClearedNewParentKeyType = type(secondParent.normalText)
    `, "@dynamic-parent-key");
    assert.equal(result.ok, true, result.error ?? "dynamic template script failed");
    assert.equal(vm.getGlobal("DynamicButtonType"), "table");
    assert.equal(vm.getGlobal("DynamicButtonText"), "Ready");
    assert.equal(vm.getGlobal("DynamicNormalTextType"), "table");
    assert.equal(vm.getGlobal("DynamicNormalText"), "Ready");
    assert.equal(vm.getGlobal("DynamicOldParentKeyType"), "nil");
    assert.equal(vm.getGlobal("DynamicNewParentKeyType"), "table");
    assert.equal(vm.getGlobal("DynamicReturnedParentKeyType"), "table");
    assert.equal(vm.getGlobal("DynamicClearedNewParentKeyType"), "nil");
  } finally {
    vm.close();
  }
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
