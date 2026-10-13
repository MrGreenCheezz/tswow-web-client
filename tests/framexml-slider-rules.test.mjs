import assert from "node:assert/strict";
import test from "node:test";

// 3.27 (13.10): a Slider's range, step and value as Wow.exe 3.3.5a 12340 keeps them (FrameXmlSlider.ts,
// GlueSliderMethods.ts): 32-bit floats, the step (0x0096bc10: half away from zero, then the ends), the XML
// loader's default step 0.001 (0x0096c500), the first SetValue signalling (0x0096c090), OnMinMaxChanged
// (0x0096bbb0), SetValueStep's floor and re-apply (0x0096c1b0), the «Usage» errors (0x00971df0, 0x00971f00,
// 0x00971fd0), and a bare CreateFrame slider (no loader: step 0, no range).
const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { createFixtureProvider } = await import("../dist/code/browser/glue/GlueLoader.js");

async function boot() {
  const instance = new FrameXmlBoot({
    exercise: false,
    provider: createFixtureProvider({
      "interface/framexml/framexml.toc": "Sliders.xml",
      "interface/framexml/sliders.xml": `<Ui>
        <Slider name="SeenSliderTemplate" virtual="true">
          <Scripts>
            <OnValueChanged>if SEEN then SEEN[#SEEN + 1] = "v" .. value end</OnValueChanged>
            <OnMinMaxChanged>if SEEN then SEEN[#SEEN + 1] = "r" .. min .. ":" .. max end</OnMinMaxChanged>
          </Scripts>
        </Slider>
        <Frame name="UIParent"><Frames>
          <Slider name="Plain" inherits="SeenSliderTemplate" minValue="0" maxValue="10"/>
          <Slider name="Stepped" inherits="SeenSliderTemplate" minValue="0" maxValue="10" valueStep="1"/>
          <Slider name="Threes" inherits="SeenSliderTemplate" minValue="0" maxValue="10" valueStep="3"/>
          <Slider name="Loose" inherits="SeenSliderTemplate"/>
        </Frames></Frame>
      </Ui>`,
    }),
  });
  await instance.load();
  return instance;
}

function call(instance, source, results = 1) {
  const fn = instance.vm.compileFunction(source, "sliders", []);
  assert.ok(fn, source);
  try { return instance.vm.call(fn, [], results); } finally { instance.vm.release(fn); }
}

/** Runs `source` and answers what the scripts signalled. */
function seen(instance, source) {
  return call(instance, `SEEN = {} ${source} return table.concat(SEEN, " ")`)[0];
}

function error(instance, source) {
  const result = instance.vm.execute(source, "@sliders");
  assert.equal(result.ok, false, source);
  return String(result.error);
}

test("floats, the loader's 0.001 step, half away from zero, the ends; the first write signals", async () => {
  const instance = await boot();
  try {
    assert.deepEqual(call(instance, "return Plain:GetValueStep(), Plain:GetValue()", 2), [Math.fround(0.001), 0]);
    assert.equal(seen(instance, "Plain:SetValue(0)"), "v0", "the first SetValue signals at the same value");
    assert.equal(seen(instance, "Plain:SetValue(0)"), "", "then only a move of 2^-22 does");
    call(instance, "Plain:SetValue(7)", 0);
    assert.deepEqual(call(instance, "return Plain:GetValue()"), [Math.fround(7000 * Math.fround(0.001))],
      "7 on the 0.001f step: 7000 × 0.001f, a float — 7.0000004768372");
    assert.deepEqual(call(instance, "Stepped:SetValue(7.4) local a = Stepped:GetValue() Stepped:SetValue(7.5) return a, Stepped:GetValue()", 2),
      [7, 8], "half away from zero");
    assert.deepEqual(call(instance, "Threes:SetValue(9) local a = Threes:GetValue() Threes:SetValue(1) local b = Threes:GetValue() Threes:SetValue(2) return a, b, Threes:GetValue()", 3),
      [10, 0, 3], "within a step of the maximum: the maximum; of the minimum: the minimum");
    assert.deepEqual(call(instance, "Stepped:SetValue(99) return Stepped:GetValue()"), [10]);
    call(instance, "Stepped:SetMinMaxValues(0.1, 0.3)", 0);
    assert.deepEqual(call(instance, "return Stepped:GetMinMaxValues()", 2),
      [Math.fround(0.1), Math.fround(Math.fround(Math.fround(0.3) - Math.fround(0.1)) + Math.fround(0.1))], "min, min + range, floats");
    // The range is the float max − min (+0x2a4) and the maximum read back min + range, not max itself.
    call(instance, "Stepped:SetMinMaxValues(8.24393687028191, 53.85724372721057)", 0);
    assert.deepEqual(call(instance, "local _, high = Stepped:GetMinMaxValues() return high"), [53.85723876953125]);
    assert.deepEqual(call(instance, "Threes:SetMinMaxValues(0, 2) Threes:SetValue(2) return Threes:GetValue()"), [0],
      "a range under one step: the maximum, then within a step of the minimum — the minimum");
  } finally {
    instance.close();
  }
});

test("OnMinMaxChanged on a new range only; a set value goes through SetValue again; SetValueStep's floor", async () => {
  const instance = await boot();
  try {
    assert.equal(seen(instance, "Loose:SetValue(5)"), "", "no range: SetValue does nothing (0x0096c090)");
    assert.equal(seen(instance, "Loose:SetMinMaxValues(0, 10)"), "r0:10", "a fresh range signals, no value to re-apply");
    assert.equal(seen(instance, "Loose:SetMinMaxValues(0, 10)"), "", "the same range: nothing");
    assert.equal(seen(instance, "Loose:SetValueStep(1) Loose:SetValue(7) Loose:SetMinMaxValues(0, 5)"), "v7 r0:5 v5");
    assert.equal(seen(instance, "Loose:SetMinMaxValues(0, 10) Loose:SetValue(7) Loose:SetValueStep(5)"), "r0:10 v7 v5",
      "a new step re-applies the value: (7 + 2.5) / 5 → 1 step");
    call(instance, "Loose:SetValueStep(0)", 0);
    assert.deepEqual(call(instance, "return Loose:GetValueStep()"), [1.1920928955078125e-7], "at least FLT_EPSILON");
  } finally {
    instance.close();
  }
});

test("the «Usage» errors; a bare CreateFrame slider has no step and no range", async () => {
  const instance = await boot();
  try {
    assert.match(error(instance, "Plain:SetMinMaxValues(5, 1)"), /Usage: Plain:SetMinMaxValues\(min, max\)/);
    assert.match(error(instance, `Plain:SetMinMaxValues("a", 1)`), /Usage: Plain:SetMinMaxValues\(min, max\)/);
    assert.match(error(instance, `Plain:SetValue("x")`), /Usage: Plain:SetValue\(value\)/);
    assert.match(error(instance, "Plain:SetValueStep()"), /Usage: Plain:SetValueStep\(value\)/);
    assert.match(error(instance, `CreateFrame("Slider"):SetMinMaxValues(2, 1)`), /Usage: <unnamed>:SetMinMaxValues/);
    assert.deepEqual(call(instance, `Plain:SetMinMaxValues("1", "4") return Plain:GetMinMaxValues()`, 2), [1, 4], "numeric strings are numbers");
    assert.deepEqual(call(instance, `
      local bare = CreateFrame("Slider")
      bare:SetValue(5)
      local before = bare:GetValue()
      bare:SetMinMaxValues(0, 10)
      bare:SetValue(2.5)
      return bare:GetValueStep(), before, bare:GetValue()`, 3), [0, 0, 2.5], "no loader: step 0; no range: SetValue does nothing");
  } finally {
    instance.close();
  }
});
