import assert from "node:assert/strict";
import test from "node:test";

// Plan item 3.27, review of 05.10: SetFormattedText whose arguments the formatter refuses. Wow.exe's
// widget formatter (0x00818070) raises through luaL_error (0x0084f280) before the text is set, so the
// widget keeps what it showed; since str_format is the client's (GlueLuaFormat.ts), `%s` with nil
// raises here too, and the widget then showed its raw format string ("%s: %d").
const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { createFixtureProvider } = await import("../dist/code/browser/glue/GlueLoader.js");

const FIXTURE = String.raw`
local frame = CreateFrame("Frame", "ProbeFrame", UIParent)
local text = frame:CreateFontString("ProbeText")
text:SetText("old")
`;

async function boot() {
  const instance = new FrameXmlBoot({
    provider: createFixtureProvider({
      "interface/framexml/framexml.toc": "Probe.lua",
      "interface/framexml/probe.lua": FIXTURE,
    }),
    exercise: false,
  });
  await instance.load();
  return instance;
}

test("a refused SetFormattedText leaves the text as it was and reports the error", async () => {
  const instance = await boot();
  try {
    instance.vm.execute('ProbeText:SetFormattedText("%s: %d", "a", 2)', "@probe");
    assert.equal(instance.bridge.getFrame("ProbeText")?.text, "a: 2");
    const before = instance.errorCount;
    instance.vm.execute('ProbeText:SetFormattedText("%s: %d", nil, 1)', "@probe");
    assert.equal(instance.bridge.getFrame("ProbeText")?.text, "a: 2", "the text is not replaced by the format string");
    assert.ok(instance.errorCount > before, "the formatter's error is reported");
    assert.ok(instance.errors.some((failure) => /string expected, got nil/.test(failure.message)),
      instance.errors.map((failure) => failure.message).join(" | "));
    instance.vm.execute('ProbeText:SetFormattedText("%d%%", 7.9)', "@probe");
    assert.equal(instance.bridge.getFrame("ProbeText")?.text, "7%");
  } finally {
    instance.close();
  }
});
