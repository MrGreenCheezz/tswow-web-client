import assert from "node:assert/strict";
import test from "node:test";

// L5b-review (04.10, plan 3.27 / the options vertical): a Slider's SetMinMaxValues fires
// OnValueChanged only for a value that has been set. Wow.exe 3.3.5a (12340), notes
// .runtime/re-2026-10-04/l5b-review/s1.c and .runtime/re-2026-10-03/l334/r3.c: Slider:SetMinMaxValues
// (table entry 0x00b2ce48 → 0x00971df0) calls CSimpleSlider::SetMinMaxValues 0x0096c470, which stores
// the range and re-applies the value (SetValue 0x0096c090, the only caller of OnValueChanged) only when
// the slider's "value set" flag (bit 4 of +0x29c) is up; SetValue does nothing at all until a range is
// set (bit 2), and the XML loader 0x0096c500 sets the range from minValue+maxValue and the value only
// from defaultValue. The stock OptionsSliderTemplate (OptionsPanelTemplates.xml:76) has neither, so
// BlizzardOptionsPanel_OnEvent's SetMinMaxValues(90, 270) (OptionsPanelTemplates.lua:349) raised the
// fresh 0 to 90 and its OnValueChanged wrote SetCVar — since 5.14 the camera and mouse settings.
const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { createFixtureProvider } = await import("../dist/code/browser/glue/GlueLoader.js");

async function boot() {
  const instance = new FrameXmlBoot({
    exercise: false,
    provider: createFixtureProvider({
      "interface/framexml/framexml.toc": "Sliders.xml",
      "interface/framexml/sliders.xml": `<Ui>
        <Slider name="SeenSliderTemplate" virtual="true">
          <Scripts><OnValueChanged>if SEEN then SEEN[#SEEN + 1] = self:GetName() .. "=" .. value end</OnValueChanged></Scripts>
        </Slider>
        <Frame name="UIParent"><Frames>
          <Slider name="Fresh" inherits="SeenSliderTemplate"/>
          <Slider name="Ranged" inherits="SeenSliderTemplate" minValue="0" maxValue="10"/>
          <Slider name="Defaulted" inherits="SeenSliderTemplate" minValue="0" maxValue="10" defaultValue="4"/>
          <Slider name="Early" inherits="SeenSliderTemplate"/>
          <Slider name="RangedValue" inherits="SeenSliderTemplate" minValue="0" maxValue="10"/>
        </Frames></Frame>
      </Ui>`,
    }),
  });
  await instance.load();
  return instance;
}

function run(instance, source) {
  const result = instance.vm.execute(`SEEN = {} ${source} __SEEN = table.concat(SEEN, " ")`, "@sliders");
  assert.equal(result.ok, true, result.error);
  return instance.vm.getGlobal("__SEEN");
}

function value(instance, name) {
  const result = instance.vm.execute(`__VALUE = ${name}:GetValue()`, "@value");
  assert.equal(result.ok, true, result.error);
  return instance.vm.getGlobal("__VALUE");
}

test("a slider whose value was never set takes a range silently and keeps 0 until its first SetValue", async () => {
  const instance = await boot();
  try {
    assert.equal(run(instance, "Fresh:SetMinMaxValues(90, 270)"), "", "no OnValueChanged for the fresh 0");
    assert.equal(value(instance, "Fresh"), 0);
    assert.equal(run(instance, "Fresh:SetValue(180)"), "Fresh=180");
    assert.equal(run(instance, "Fresh:SetMinMaxValues(200, 270)"), "Fresh=200", "a set value is clamped to the new range");
    assert.equal(value(instance, "Fresh"), 200);
    // An XML range without defaultValue sets no value either; defaultValue does.
    assert.equal(run(instance, "Ranged:SetMinMaxValues(5, 8)"), "");
    assert.equal(run(instance, "RangedValue:SetValue(7) RangedValue:SetMinMaxValues(0, 5)"), "RangedValue=7 RangedValue=5",
      "a SetValue on the XML range is a value");
    assert.equal(run(instance, "Defaulted:SetMinMaxValues(5, 8)"), "Defaulted=5");
    // SetValue before any range is not a value (0x0096c090 does nothing without one).
    assert.equal(run(instance, "Early:SetValue(5) Early:SetMinMaxValues(90, 270)"), "");
  } finally {
    instance.close();
  }
});
