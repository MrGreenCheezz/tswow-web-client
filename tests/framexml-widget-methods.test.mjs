import assert from "node:assert/strict";
import test, { after, before } from "node:test";

// Plan item 3.21 over the stock corpus: ColorSelect keeps its colour and runs OnColorSelect on every
// SetColorRGB (Wow.exe 0x00971050/0x009710d0), ScrollingMessageFrame:UpdateColorByID recolours only
// the lines of that id (0x00973590), and an AnimationGroup's scripts stay on the group — the census
// no longer reaches Frame:Play from AnimTimerFrame.xml's group OnLoad.
let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine", concurrency: false };
const decoder = new TextDecoder("utf-8");
let chain;
let boot;
let inventory;

before(async () => {
  if (!clientDirectory) return;
  const { clientArchives } = await import("../tools/mpq.mjs");
  chain = await clientArchives(clientDirectory);
  const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
  const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
  const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
  boot = new FrameXmlBoot({
    provider: { async read(path) { const data = await chain.read(path); return data ? decoder.decode(data) : undefined; } },
    locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam: new CannedWorldSeam(),
    screen: () => ({ width: 1024, height: 768 }),
  });
  inventory = await boot.load();
});
after(() => { boot?.close?.(); chain?.close(); });

function lua(code, results = 1) {
  const fn = boot.vm.compileFunction(code, "widget-methods-test", []);
  assert.ok(fn, `compiles: ${code.slice(0, 60)}`);
  try { return boot.vm.call(fn, [], results); } finally { boot.vm.release(fn); }
}

const close = (actual, expected) => {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 1e-9, `${actual} ≈ ${expected}`));
};

test("the census no longer lists the three methods this slice answers", withClient, () => {
  const names = inventory.methods.map((record) => record.name);
  for (const name of ["ScrollingMessageFrame:UpdateColorByID", "Frame:Play", "ColorSelect:SetColorRGB",
    "ColorSelect:GetColorRGB", "Frame:SetColorRGB", "Frame:GetColorRGB"]) {
    assert.ok(!names.includes(name), `${name} is not a census stub`);
  }
});

test("ColorPickerFrame: SetColorRGB stores bytes, GetColorRGB answers them, OnColorSelect runs on every call", withClient, () => {
  const errors = boot.errorCount;
  lua(`__picked = {}
    ColorPickerFrame.func = function() local r, g, b = ColorPickerFrame:GetColorRGB() __picked[#__picked + 1] = { r, g, b } end`, 0);
  assert.equal(lua("return ColorPickerFrame:GetObjectType()")[0], "ColorSelect");
  lua("ColorPickerFrame:SetColorRGB(0.2, 0.4, 0.6)", 0);
  close(lua("return ColorPickerFrame:GetColorRGB()", 3), [51 / 255, 102 / 255, 153 / 255]);
  // The same colour again still runs the script (UIDropDownMenu.lua:995 relies on it).
  lua("ColorPickerFrame:SetColorRGB(0.2, 0.4, 0.6)", 0);
  assert.deepEqual(lua("return #__picked"), [2]);
  // Clamped to [0, 1]; x × 255 + 0.5, whole part: 0.5 → 128.
  lua("ColorPickerFrame:SetColorRGB(-1, 2, 0.5)", 0);
  close(lua("return ColorPickerFrame:GetColorRGB()", 3), [0, 1, 128 / 255]);
  close(lua("return unpack(__picked[3])", 3), [0, 1, 128 / 255]);
  // The channel reaches the packer as a float: 0.9 is 0.89999998 there, 229.49999 + 0.5 → 229.
  lua("ColorPickerFrame:SetColorRGB(0.9, 0.7, 0.1)", 0);
  close(lua("return ColorPickerFrame:GetColorRGB()", 3), [229 / 255, 178 / 255, 26 / 255]);
  // The swatch the stock OnColorSelect paints (ColorPickerFrame.xml:173-178).
  const swatch = boot.bridge.getFrame("ColorSwatch");
  assert.ok(swatch?.name, "ColorSwatch exists");
  assert.equal(boot.errorCount, errors);
});

test("UpdateColorByID recolours only the lines added with that id", withClient, () => {
  const errors = boot.errorCount;
  const frame = boot.bridge.getFrame("ChatFrame1");
  assert.equal(frame?.type, "ScrollingMessageFrame");
  lua(`ChatFrame1:Clear()
    ChatFrame1:AddMessage("seven", 1, 1, 1, 7)
    ChatFrame1:AddMessage("eight", 1, 1, 1, 8)
    ChatFrame1:AddMessage("plain", 1, 1, 1)
    ChatFrame1:AddMessage("seven again", 0.5, 0.5, 0.5, 7)`, 0);
  const colors = () => frame.messageFrame.messages.map((message) => [message.text, message.color.r, message.color.g, message.color.b]);
  lua("ChatFrame1:UpdateColorByID(7, 1, 0, 0)", 0);
  assert.deepEqual(colors(), [["seven", 1, 0, 0], ["eight", 1, 1, 1], ["plain", 1, 1, 1], ["seven again", 1, 0, 0]]);
  // id 0, a missing channel and a non-number change nothing; channels clamp.
  lua("ChatFrame1:UpdateColorByID(0, 0, 0, 1)", 0);
  lua("ChatFrame1:UpdateColorByID(8, 0, 0)", 0);
  lua("ChatFrame1:UpdateColorByID(8, 'x', 0, 0)", 0);
  assert.deepEqual(colors()[1], ["eight", 1, 1, 1]);
  lua("ChatFrame1:UpdateColorByID(8, 2, -1, 0.25)", 0);
  assert.deepEqual(colors()[1], ["eight", 1, 0, 0.25]);
  lua("ChatFrame1:Clear()", 0);
  assert.equal(boot.errorCount, errors);
});

test("an AnimationGroup's OnLoad runs on the group, not on the frame that owns it", withClient, () => {
  assert.deepEqual(lua(`return AnimTimerFrame:GetScript("OnLoad") == nil,
    AnimTimerFrameCountdownAnimGroup:GetObjectType(), AnimTimerFrameCountdownAnimGroup:IsPlaying()`, 3),
  [true, "AnimationGroup", true]);
});

// 05.10-3.21: the census of 05.10 (.runtime/re-2026-10-05/3.21) — FontString:SetAlphaGradient,
// Frame:IgnoreDepth, GameTooltip:SetSpellByID now have real entries (GlueWidgetMethodFills.ts).
test("the quest text types itself in: SetAlphaGradient answers 1 until start passes the last glyph", withClient, () => {
  const errors = boot.errorCount;
  assert.equal(lua("return type(rawget(getmetatable(QuestInfoDescriptionText).__index, 'SetAlphaGradient'))")[0], "function");
  lua(`QuestInfoFrame.acceptButton = QuestInfoFrame.acceptButton or QuestFrameAcceptButton
    QUEST_FADING_DISABLE = "0"
    QuestInfoDescriptionText:SetText("абвгдеж")
    QuestInfoDescriptionText:SetAlphaGradient(0, 0)
    QuestInfo_ShowFadingFrame()`, 0);
  assert.equal(lua("return QuestInfoFrame.acceptButton:IsEnabled()")[0] ? 1 : 0, 0, "Accept waits for the text");
  // 70 glyphs a second: 0.05 s → start 3 of 7, still fading.
  lua("QuestInfoFadingFrame_OnUpdate(QuestInfoFadingFrame, 0.05)", 0);
  assert.equal(lua("return QuestInfoFadingFrame.fading")[0], 1);
  // 0.1 s more → start 10, past the seventh glyph: done, Accept enabled.
  lua("QuestInfoFadingFrame_OnUpdate(QuestInfoFadingFrame, 0.1)", 0);
  assert.equal(lua("return QuestInfoFadingFrame.fading")[0], undefined);
  assert.equal(lua("return QuestInfoFrame.acceptButton:IsEnabled()")[0] ? 1 : 0, 1);
  assert.deepEqual(lua("return pcall(QuestInfoDescriptionText.SetAlphaGradient, QuestInfoDescriptionText, 'x', 1)", 2)
    .map((value, index) => index === 0 ? value : /Usage: QuestInfoDescriptionText:SetAlphaGradient\(start, length\)/.test(String(value))),
  [false, true]);
  assert.equal(boot.errorCount, errors);
});

test("IgnoreDepth takes a boolean; SetSpellByID refuses a non-number and answers nil for a spell not in the book", withClient, () => {
  const names = inventory.methods.map((record) => record.name);
  for (const name of ["Frame:IgnoreDepth", "FontString:SetAlphaGradient", "GameTooltip:SetSpellByID"]) {
    assert.ok(!names.includes(name), `${name} is not a census stub`);
  }
  assert.deepEqual(lua(`local f = CreateFrame("Frame", "IgnoreDepthProbe")
    local ok = pcall(f.IgnoreDepth, f, true)
    local bad, message = pcall(f.IgnoreDepth, f, 1)
    return ok, bad, message`, 3).map((value, index) => index < 2 ? value : /Usage: IgnoreDepthProbe:IgnoreDepth\(ignore\)/.test(String(value))),
  [true, false, true]);
  assert.deepEqual(lua(`local ok, message = pcall(GameTooltip.SetSpellByID, GameTooltip, "fire")
    return ok, message`, 2).map((value, index) => index === 0 ? value : /Invalid spell ID in GameTooltip:SetSpellByID/.test(String(value))),
  [false, true]);
  // The canned world's book holds nothing: nil, and the tooltip is left as it was.
  assert.deepEqual(lua(`GameTooltip:SetOwner(UIParent, "ANCHOR_NONE") GameTooltip:SetText("before")
    local answer = GameTooltip:SetSpellByID(133, false, true)
    return answer, GameTooltipTextLeft1:GetText()`, 2), [undefined, "before"]);
  lua("GameTooltip:Hide()", 0);
});
