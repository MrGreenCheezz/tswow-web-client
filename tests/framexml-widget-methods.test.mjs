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
