import assert from "node:assert/strict";
import test from "node:test";

// widgets5 (15.11): widget methods Wow.exe 12340 registers that the client did not answer
// (GlueFrameMethodFills.ts), and a ScrollingMessageFrame's OnMessageScrollChanged (FrameXmlMessageScrollChanged.ts).
const { GlueLuaVm } = await import("../dist/code/browser/glue/GlueLua.js");
const { GlueWidgetBinder } = await import("../dist/code/browser/glue/GlueWidgets.js");
const { FrameXmlUiBridge } = await import("../dist/code/browser/ui/framexml_compat/FrameXmlRuntime.js");

function fixture() {
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
  const run = (source) => {
    const result = vm.execute(source, "@widgets5-test");
    assert.equal(result.ok, true, result.error ?? "chunk failed");
  };
  /** The message the chunk raised, through pcall. */
  const raised = (source) => {
    run(`__ok, __err = pcall(function() ${source} end)`);
    assert.equal(vm.getGlobal("__ok"), false, `raises: ${source}`);
    return String(vm.getGlobal("__err"));
  };
  return { vm, bridge, run, raised };
}

test("SetMinResize/SetMaxResize: numbers only, kept per pair, 0, 0 before any (0x004a0520, 0x00489980)", () => {
  const { vm, run, raised } = fixture();
  try {
    run(`F = CreateFrame("Frame", "ResizeFrame")
      a, b = F:GetMinResize() c, d = F:GetMaxResize()`);
    assert.deepEqual([vm.getGlobal("a"), vm.getGlobal("b"), vm.getGlobal("c"), vm.getGlobal("d")], [0, 0, 0, 0]);
    run(`F:SetMinResize(400, "200") F:SetMaxResize(0.1, 900)
      a, b = F:GetMinResize() c, d = F:GetMaxResize()`);
    assert.deepEqual([vm.getGlobal("a"), vm.getGlobal("b")], [400, 200]);
    assert.equal(vm.getGlobal("c"), Math.fround(0.1), "kept as a float");
    assert.equal(vm.getGlobal("d"), 900);
    assert.match(raised(`F:SetMinResize(400)`), /^Usage: ResizeFrame:SetMinResize\(minWidth, minHeight\)$/);
    assert.match(raised(`F:SetMaxResize("x", 2)`), /^Usage: ResizeFrame:SetMaxResize\(maxWidth, maxHeight\)$/);
    run(`a, b = F:GetMinResize()`);
    assert.deepEqual([vm.getGlobal("a"), vm.getGlobal("b")], [400, 200], "a refused call changes nothing");
  } finally {
    vm.close();
  }
});

test("Set/GetDontSavePosition and EnableJoystick: 0x00815500 with default 1, answers 1 or nil", () => {
  const { vm, run } = fixture();
  try {
    run(`F = CreateFrame("Frame")
      r1 = F:GetDontSavePosition() F:SetDontSavePosition() r2 = F:GetDontSavePosition()
      F:SetDontSavePosition(nil) r3 = F:GetDontSavePosition() F:SetDontSavePosition(2) r4 = F:GetDontSavePosition()
      j1 = F:IsJoystickEnabled() F:EnableJoystick() j2 = F:IsJoystickEnabled() F:EnableJoystick(false) j3 = F:IsJoystickEnabled()
      d1 = F:IsIgnoringDepth() F:IgnoreDepth(true) d2 = F:IsIgnoringDepth()`);
    assert.deepEqual(["r1", "r2", "r3", "r4"].map((n) => vm.getGlobal(n)), [undefined, 1, undefined, 1]);
    assert.deepEqual(["j1", "j2", "j3"].map((n) => vm.getGlobal(n)), [undefined, 1, undefined]);
    assert.deepEqual(["d1", "d2"].map((n) => vm.getGlobal(n)), [undefined, 1]);
  } finally {
    vm.close();
  }
});

test("GetRect answers left, bottom, width, height as GetLeft/GetBottom/GetWidth/GetHeight", () => {
  const { vm, run } = fixture();
  try {
    run(`F = CreateFrame("Frame") F:SetWidth(120) F:SetHeight(30)
      l, b, w, h = F:GetRect() L, B = F:GetLeft(), F:GetBottom()`);
    assert.equal(vm.getGlobal("l"), vm.getGlobal("L"));
    assert.equal(vm.getGlobal("b"), vm.getGlobal("B"));
    assert.equal(vm.getGlobal("w"), 120);
    assert.equal(vm.getGlobal("h"), 30);
  } finally {
    vm.close();
  }
});

test("a FontString made without a template raises «Font not set» until it has a font (0x0048d780, 0x0048d800)", () => {
  const { vm, run, raised } = fixture();
  try {
    run(`F = CreateFrame("Frame") S = F:CreateFontString("BareString", "OVERLAY") N = F:CreateFontString(nil, "OVERLAY")`);
    assert.equal(raised(`S:SetText("x")`), "BareString:SetText(): Font not set");
    assert.equal(raised(`S:SetFormattedText("%d", 1)`), "BareString:SetFormattedText(): Font not set");
    assert.equal(raised(`N:SetText("x")`), "<unnamed>:SetText(): Font not set");
    run(`r = S:GetText()`);
    assert.notEqual(vm.getGlobal("r"), "x", "the text is not set");
    run(`S:SetFontObject(nil)`);
    assert.equal(raised(`S:SetText("x")`), "BareString:SetText(): Font not set", "SetFontObject(nil) gives no face");
    run(`S:SetFont("Fonts\\\\FRIZQT__.TTF", 12) S:SetText("now") r = S:GetText()
      N:SetFontObject("GameFontNormal") N:SetFormattedText("%d", 7) n = N:GetText() f = S:GetFieldSize()`);
    assert.equal(vm.getGlobal("r"), "now");
    assert.equal(vm.getGlobal("n"), "7");
    assert.equal(vm.getGlobal("f"), 8191);
  } finally {
    vm.close();
  }
});

test("a Button gives its template-less FontString the state's font object: no «Font not set» (0x0096f4a0)", () => {
  // tests7 (15.11): SetFontString (0x009777c0 → 0x0096f7b0) and SetNormalFontObject (0x00977340) both end in
  // 0x0096f4a0, which hands the button's FontString the current state's font object through 0x00485160.
  // MSBTOptionsControls.lua:863-865 builds its option buttons so.
  const { vm, run, raised } = fixture();
  try {
    run(`B = CreateFrame("Button", "FontButton") L = B:CreateFontString("FontButtonLabel", "OVERLAY")
      B:SetFontString(L)`);
    assert.equal(raised(`L:SetText("x")`), "FontButtonLabel:SetText(): Font not set", "a button with no font gives none");
    run(`B:SetNormalFontObject("GameFontNormalSmall") L:SetText("label") r = L:GetText()`);
    assert.equal(vm.getGlobal("r"), "label", "SetNormalFontObject after SetFontString");
    run(`C = CreateFrame("Button") C:SetNormalFontObject("GameFontNormalSmall") M = C:CreateFontString(nil, "OVERLAY")
      C:SetFontString(M) M:SetFormattedText("%d", 3) m = M:GetText()`);
    assert.equal(vm.getGlobal("m"), "3", "SetFontString onto a button that has a font object");
    run(`D = CreateFrame("Button") D:SetText("plain") d = D:GetText()`);
    assert.equal(vm.getGlobal("d"), "plain", "Button:SetText itself never raises (0x00977960 → 0x0096f860)");
  } finally {
    vm.close();
  }
});

test("Texture: SetNonBlocking/GetNonBlocking, IsDesaturated, SetBlendMode checks the mode name", () => {
  const { vm, run, raised } = fixture();
  try {
    run(`F = CreateFrame("Frame") X = F:CreateTexture("Pic")
      n1 = X:GetNonBlocking() X:SetNonBlocking() n2 = X:GetNonBlocking() X:SetNonBlocking(nil) n3 = X:GetNonBlocking()
      s1 = X:IsDesaturated() ok = X:SetDesaturated() s2 = X:IsDesaturated() X:SetDesaturated(0) s3 = X:IsDesaturated()
      X:SetBlendMode("add") m = X:GetBlendMode()`);
    assert.deepEqual(["n1", "n2", "n3"].map((n) => vm.getGlobal(n)), [undefined, 1, undefined]);
    assert.deepEqual(["s1", "ok", "s2", "s3"].map((n) => vm.getGlobal(n)), [undefined, 1, 1, undefined]);
    assert.equal(vm.getGlobal("m"), "ADD");
    assert.equal(raised(`X:SetBlendMode("GLOW")`), `Usage: Pic:SetBlendMode("mode")`);
    run(`m = X:GetBlendMode()`);
    assert.equal(vm.getGlobal("m"), "ADD", "a refused mode leaves the last one");
  } finally {
    vm.close();
  }
});

test("batch 2: protection constants, GetEffectiveAlpha bytes, SetDepth/GetDepth (0x0049cad0…0x004a1cc0)", () => {
  const { vm, run, raised } = fixture();
  try {
    run(`P = CreateFrame("Frame", "DepthParent") C = CreateFrame("Frame", nil, P)
      p1, p2 = C:IsProtected() cps = C:CanChangeProtectedState() cca = C:CanChangeAttribute() C:AllowAttributeChanges()
      P:SetAlpha(0.5) C:SetAlpha(0.5) ea = C:GetEffectiveAlpha() P:SetAlpha(2) top = P:GetEffectiveAlpha()
      d0 = C:GetDepth() C:SetDepth(1.25) d1 = C:GetDepth()`);
    assert.deepEqual(["p1", "p2", "cps", "cca"].map((n) => vm.getGlobal(n)), [undefined, undefined, 1, 1]);
    // 0.5 × 255 = 127.5 → 128 (ties to even); 128 × 128 / 255 → 64.
    assert.equal(vm.getGlobal("ea"), 64 / 255);
    assert.equal(vm.getGlobal("top"), 1, "alpha is clamped before the byte");
    assert.deepEqual([vm.getGlobal("d0"), vm.getGlobal("d1")], [0, 1.25]);
    assert.equal(raised(`P:SetDepth("x")`), "Usage: DepthParent:SetDepth(additiveDepth)");
  } finally {
    vm.close();
  }
});

test("batch 2: EditBox multi-line, numeric, password flags and GetNumLetters (0x00975b30…0x009766a0)", () => {
  const { vm, run } = fixture();
  try {
    run(`E = CreateFrame("EditBox", "LettersBox")
      m1 = E:IsMultiLine() E:SetMultiLine() m2 = E:IsMultiLine() E:SetMultiLine(nil) m3 = E:IsMultiLine()
      n1 = E:IsNumeric() E:SetNumeric(true) n2 = E:IsNumeric() w1 = E:IsPassword()
      E:SetText("|cffff0000ab|r\\195\\169") l1 = E:GetNumLetters()
      E:SetPassword(true) w2 = E:IsPassword() l2 = E:GetNumLetters()
      u = strlenutf8("a\\195\\169b") ok, err = pcall(strlenutf8, nil)`);
    assert.deepEqual(["m1", "m2", "m3", "n1", "n2", "w1", "w2"].map((n) => vm.getGlobal(n)),
      [undefined, 1, undefined, undefined, 1, undefined, 1]);
    assert.equal(vm.getGlobal("l1"), 3, "shown characters: a, b, é");
    assert.equal(vm.getGlobal("l2"), 15, "a password box counts the raw text's UTF-8 characters");
    assert.equal(vm.getGlobal("u"), 3);
    assert.equal(vm.getGlobal("err"), "Usage: strlenutf8(string)");
  } finally {
    vm.close();
  }
});

test("batch 2: GetShapeshiftForm's walk, the item argument and the range bindings (0x0053d4b0, 0x0051c9c0)", async () => {
  const { frameXmlShapeshiftFormIndex, frameXmlItemArgument, frameXmlItemNamed, FRAMEXML_RANGE_QUERY_BINDINGS } =
    await import("../dist/code/browser/framexml/FrameXmlRangeQueries.js");
  assert.equal(frameXmlShapeshiftFormIndex([false, true, false], true, false), 2);
  assert.equal(frameXmlShapeshiftFormIndex([true, true], true, true), 2, "walked from the last entry");
  assert.equal(frameXmlShapeshiftFormIndex([false, false], true, false), 3, "a form off the bar: count + 1");
  assert.equal(frameXmlShapeshiftFormIndex([true], false, true), 0, "flag with no form byte: 0");
  assert.equal(frameXmlShapeshiftFormIndex([true], false, false), 1, "no flag: the walk still runs");
  assert.equal(frameXmlItemArgument("6948"), 6948);
  assert.equal(frameXmlItemArgument("Hearthstone"), "Hearthstone");
  assert.equal(frameXmlItemNamed("|Hitem:6948:0|h[x]|h", undefined), 6948);
  assert.equal(frameXmlItemNamed("hearthstone", new Map([[6948, { found: true, name: "Hearthstone" }]])), 6948);
  const calls = [];
  const seam = {
    itemInRange: (item, unit) => { calls.push([item, unit]); return 0; },
    itemFamily: () => 8, shapeshiftFormIndex: (flag) => (flag ? 1 : 2),
  };
  assert.deepEqual(FRAMEXML_RANGE_QUERY_BINDINGS.IsItemInRange(seam, [6948, "target"]), [0]);
  assert.deepEqual(FRAMEXML_RANGE_QUERY_BINDINGS.IsItemInRange(seam, [6948]), [], "no unit token: nothing");
  assert.deepEqual(calls, [[6948, "target"]]);
  assert.deepEqual(FRAMEXML_RANGE_QUERY_BINDINGS.GetItemFamily(seam, ["6948"]), [8]);
  assert.deepEqual(FRAMEXML_RANGE_QUERY_BINDINGS.GetShapeshiftForm(seam, [true]), [1]);
  assert.deepEqual(FRAMEXML_RANGE_QUERY_BINDINGS.GetShapeshiftForm(seam, []), [2]);
  assert.deepEqual(FRAMEXML_RANGE_QUERY_BINDINGS.IsWindowsClient(seam, []), [1]);
});

test("OnMessageScrollChanged: raised when the current line moves, not when it stays (0x00969fa0, 0x0096a9f0)", () => {
  const { vm, run } = fixture();
  try {
    run(`M = CreateFrame("ScrollingMessageFrame", "LogFrame") moves = 0
      M:SetScript("OnMessageScrollChanged", function(self, ...) moves = moves + 1 extra = select("#", ...) who = self end)
      M:AddMessage("one") after1 = moves
      M:AddMessage("two") M:AddMessage("three") after3 = moves
      M:ScrollUp() up = moves
      M:AddMessage("four") whileUp = moves
      M:ScrollToBottom() bottom = moves
      M:ScrollDown() atEnd = moves
      M:AddMessage("top", 1, 1, 1, nil, true) atTop = moves`);
    assert.equal(vm.getGlobal("after1"), 1, "the first line becomes current");
    assert.equal(vm.getGlobal("after3"), 3);
    assert.equal(vm.getGlobal("up"), 4);
    assert.equal(vm.getGlobal("whileUp"), 4, "a line added while scrolled up moves nothing");
    assert.equal(vm.getGlobal("bottom"), 5);
    assert.equal(vm.getGlobal("atEnd"), 5, "a scroll at the end leaves the current line");
    assert.equal(vm.getGlobal("atTop"), 5, "a line added at the top leaves the current line");
    assert.equal(vm.getGlobal("extra"), 0, "no arguments but self");
    run(`same = (who == M)`);
    assert.equal(vm.getGlobal("same"), true);
  } finally {
    vm.close();
  }
});
