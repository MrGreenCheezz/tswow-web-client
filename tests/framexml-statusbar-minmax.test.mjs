import assert from "node:assert/strict";
import test from "node:test";

// 3.27 (11.11): StatusBar:SetMinMaxValues as Wow.exe 3.3.5a 12340 answers it (0x009713c0 → 0x00961800,
// GlueStatusBarMethods.ts): the «Usage», range and spread errors, a max below the min lowering the min, floats.
const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { createFixtureProvider } = await import("../dist/code/browser/glue/GlueLoader.js");

async function boot() {
  const instance = new FrameXmlBoot({
    exercise: false,
    provider: createFixtureProvider({
      "interface/framexml/framexml.toc": "Bars.xml",
      "interface/framexml/bars.xml": `<Ui>
        <Frame name="UIParent"><Frames>
          <StatusBar name="Bar" minValue="0" maxValue="100" defaultValue="50"/>
        </Frames></Frame>
      </Ui>`,
    }),
  });
  await instance.load();
  return instance;
}

function call(instance, source, results = 1) {
  const fn = instance.vm.compileFunction(source, "bars", []);
  assert.ok(fn, source);
  try { return instance.vm.call(fn, [], results); } finally { instance.vm.release(fn); }
}

function error(instance, source) {
  const result = instance.vm.execute(source, "@bars");
  assert.equal(result.ok, false, source);
  return String(result.error);
}

test("a max below the min lowers the min to it; the value is clamped again", async () => {
  const instance = await boot();
  try {
    call(instance, "Bar:SetMinMaxValues(0, 100); Bar:SetValue(50)", 0);
    assert.deepEqual(call(instance, "Bar:SetMinMaxValues(80, 20) return Bar:GetMinMaxValues()", 2), [20, 20]);
    assert.deepEqual(call(instance, "return Bar:GetValue()"), [20]);
    assert.deepEqual(call(instance, "Bar:SetMinMaxValues('0', '0.1') return Bar:GetMinMaxValues()", 2), [0, Math.fround(0.1)],
      "numeric strings, kept as floats");
  } finally {
    instance.close?.();
  }
});

test("the errors: usage, out of range, too far apart", async () => {
  const instance = await boot();
  try {
    assert.match(error(instance, "Bar:SetMinMaxValues(0)"), /Usage: Bar:SetMinMaxValues\(min, max\)/);
    assert.match(error(instance, "Bar:SetMinMaxValues(0, 'x')"), /Usage: Bar:SetMinMaxValues\(min, max\)/);
    assert.match(error(instance, "Bar:SetMinMaxValues(0, 2e12)"), /Min or Max out of range/);
    assert.match(error(instance, "Bar:SetMinMaxValues(0/0, 1)"), /Min or Max out of range/);
    assert.match(error(instance, "Bar:SetMinMaxValues(-9e11, 9e11)"), /Min and Max too far apart/);
    assert.deepEqual(call(instance, "return Bar:GetMinMaxValues()", 2), [0, 100], "a refused call changes nothing");
  } finally {
    instance.close?.();
  }
});
