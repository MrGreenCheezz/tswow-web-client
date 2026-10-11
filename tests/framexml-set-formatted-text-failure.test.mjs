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
    // 3.38: the chunk's runner reports it, as a handler dispatch does (the method raises in its caller).
    instance.vm.executeReported('ProbeText:SetFormattedText("%s: %d", nil, 1)', "@probe");
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

test("3.38: the refusal is raised in the caller — its pcall sees it, and the rest of the chunk does not run", async () => {
  const instance = await boot();
  try {
    instance.vm.execute(String.raw`
      ProbeOk, ProbeMessage = pcall(ProbeText.SetFormattedText, ProbeText, "%d", nil)
      ProbeOkMethod, ProbeMessageMethod = pcall(function() ProbeText:SetFormattedText("%s: %d", nil, 1) end)
      ProbeFine = pcall(ProbeText.SetFormattedText, ProbeText, "%d", 5)
    `, "@probe");
    assert.equal(instance.vm.getGlobal("ProbeOk"), false, "pcall returns false, as over Wow.exe's 0x0048d800");
    assert.equal(instance.vm.getGlobal("ProbeMessage"), "bad argument #2 to 'SetFormattedText' (number expected, got nil)",
      "the formatter's own words, no binding name in front");
    assert.equal(instance.vm.getGlobal("ProbeOkMethod"), false);
    assert.equal(instance.vm.getGlobal("ProbeMessageMethod"), "bad argument #2 to 'SetFormattedText' (string expected, got nil)");
    assert.equal(instance.vm.getGlobal("ProbeFine"), true);
    assert.equal(instance.bridge.getFrame("ProbeText")?.text, "5", "the accepted call set its text");

    // Outside a pcall the error stops the chunk where it stands and reaches the handler once.
    const before = instance.errorCount;
    instance.vm.executeReported('ProbeAfter = 0; ProbeText:SetFormattedText("%d", nil); ProbeAfter = 1', "@probe");
    assert.equal(instance.vm.getGlobal("ProbeAfter"), 0, "the statement after the refused call never runs");
    assert.equal(instance.errorCount, before + 1);
    assert.equal(instance.bridge.getFrame("ProbeText")?.text, "5", "and the text stays");
  } finally {
    instance.close();
  }
});
