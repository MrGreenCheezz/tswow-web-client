import assert from "node:assert/strict";
import test from "node:test";

// 3.35 (03.10, 3.35-bounds): `GetBoundsRect` as Wow.exe answers it — 0x0049e700 asks the frame's virtual
// +0x64, CSimpleFrame's 0x004913c0 (kept by CSimpleHTML's vtable 0x00aa07a0): the frame's own box, its
// shown regions and shown child frames; a SimpleHTML's blocks are regions of it (0x0096cc90, 0x0096c9e0).
// GlueDialog_Show sizes its HTML box from it (GlueDialog.lua:608), so the glue opens HTML refusals in
// their *_HTML dialog as FUN_004d80c0 does. Notes: .runtime/re-2026-10-03/stock-small/g1.c, l334/r3.c, r4.c.

const { frameXmlSimpleHtmlExtent, frameXmlSimpleHtmlLineCount } =
  await import("../dist/code/browser/ui/framexml_compat/FrameXmlSimpleHtmlBounds.js");
const { parseFrameXmlSimpleHtml } = await import("../dist/code/browser/ui/framexml_compat/FrameXmlSimpleHtml.js");
const { FrameXmlUiBridge } = await import("../dist/code/browser/ui/framexml_compat/FrameXmlRuntime.js");
const { GlueLuaVm } = await import("../dist/code/browser/glue/GlueLua.js");
const { GlueWidgetBinder } = await import("../dist/code/browser/glue/GlueWidgets.js");
const { showStatusMessage } = await import("../dist/code/browser/glue/GlueMessages.js");

/** Every character 6 units wide: lines are countable by hand. */
const CHAR = 6;
const measure = (text) => [...text].length * CHAR;

test("lines: |n starts one, a line wraps at a space, a word longer than the line is cut", () => {
  assert.equal(frameXmlSimpleHtmlLineCount("", 60, measure), 1);
  assert.equal(frameXmlSimpleHtmlLineCount("aaaa bbbb", 60, measure), 1, "9 characters, 54 units");
  assert.equal(frameXmlSimpleHtmlLineCount("aaaa bbbb cc", 60, measure), 2);
  assert.equal(frameXmlSimpleHtmlLineCount("a\nb\nc", 60, measure), 3);
  assert.equal(frameXmlSimpleHtmlLineCount("x".repeat(25), 60, measure), 3, "10 + 10 + 5");
  assert.equal(frameXmlSimpleHtmlLineCount(`aa ${"x".repeat(12)} bb`, 60, measure), 3, "aa | xxxxxxxxxx | xx bb");
});

test("the page's extent: paragraphs stacked with their spacing, headers in their font, pictures in the flow", () => {
  const fonts = { 0: { height: 12, spacing: 2 }, 1: { height: 18, spacing: 4 }, 2: { height: 12, spacing: 2 }, 3: { height: 12, spacing: 2 } };
  const metrics = { font: (level) => fonts[level], textWidth: (_level, text) => measure(text) };
  const page = (body) => parseFrameXmlSimpleHtml(`<html><body>${body}</body></html>`);
  assert.equal(frameXmlSimpleHtmlExtent([], 100, metrics), undefined);
  // One line of 12, then (gap 2) two lines of 12 with 2 between: 12 + 2 + 26.
  assert.deepEqual(frameXmlSimpleHtmlExtent(page(`<p>one</p><p>${"w ".repeat(8).trim()}</p>`), 60, metrics),
    { top: 0, bottom: 40, left: 0, right: 60 });
  // A header: 18, its gap 4, then the paragraph.
  assert.equal(frameXmlSimpleHtmlExtent(page("<h1>T</h1><p>p</p>"), 60, metrics).bottom, 18 + 4 + 12);
  // A picture in the flow lowers what follows by its height; a pinned one (explicit LEFT/RIGHT) does not.
  assert.equal(frameXmlSimpleHtmlExtent(page("<p>a</p><img src='x' width='10' height='30'/><p>b</p>"), 60, metrics).bottom,
    12 + 2 + 30 + 12);
  const pinned = frameXmlSimpleHtmlExtent(page("<p>a</p><img src='x' align='RIGHT' width='80' height='30'/><p>b</p>"), 60, metrics);
  assert.deepEqual(pinned, { top: 0, bottom: 12 + 2 + 30, left: -20, right: 60 },
    "the next paragraph starts beside it; the picture, pinned TOPRIGHT, reaches below and past the left edge");
  // Before any text block a picture sits at the top, and so does the first paragraph after it: both are
  // anchored on the widget's TOPLEFT (+0x2c8 is still empty), the paragraph drawn over the picture.
  assert.equal(frameXmlSimpleHtmlExtent(page("<img src='x' width='10' height='30'/><p>b</p>"), 60, metrics).bottom, 30);
  // `<BR/>` in BODY: a paragraph of "\n" in the page font, taken as one line.
  assert.equal(frameXmlSimpleHtmlExtent(page("<p>a</p><br/><p>b</p>"), 60, metrics).bottom, 12 + 2 + 12 + 2 + 12);
  // Not HTML: one paragraph as written.
  assert.equal(frameXmlSimpleHtmlExtent(parseFrameXmlSimpleHtml("plain"), 60, metrics).bottom, 12);
});

function runtime() {
  const vm = new GlueLuaVm();
  const bridge = new FrameXmlUiBridge();
  const binder = new GlueWidgetBinder(vm, bridge);
  bridge.setRuntime(binder);
  const loaded = bridge.loadAddon(String.raw`<Ui>
    <Font name="PageFont" font="Fonts\\FRIZQT__.TTF" spacing="1"><FontHeight><AbsValue val="12"/></FontHeight></Font>
    <Font name="HeaderFont" font="Fonts\\MORPHEUS.TTF"><FontHeight><AbsValue val="18"/></FontHeight></Font>
    <Frame name="Dialog" hidden="true" width="400" height="200">
      <Anchors><Anchor point="CENTER"/></Anchors>
      <Frames>
        <SimpleHTML name="Page" width="300" height="30">
          <Anchors><Anchor point="TOP"><Offset><AbsDimension x="0" y="-16"/></Offset></Anchor></Anchors>
          <FontString inherits="PageFont" spacing="2"/>
          <FontStringHeader1 inherits="HeaderFont" spacing="4"/>
        </SimpleHTML>
      </Frames>
    </Frame>
    <Frame name="Box" width="100" height="50">
      <Anchors><Anchor point="BOTTOMLEFT"><Offset><AbsDimension x="200" y="100"/></Offset></Anchor></Anchors>
      <Layers><Layer level="ARTWORK">
        <Texture name="$parentAbove"><Size><AbsDimension x="20" y="20"/></Size>
          <Anchors><Anchor point="BOTTOM" relativePoint="TOP"/></Anchors></Texture>
        <Texture name="$parentHidden" hidden="true"><Size><AbsDimension x="20" y="20"/></Size>
          <Anchors><Anchor point="LEFT" relativePoint="RIGHT"><Offset><AbsDimension x="50" y="0"/></Offset></Anchor></Anchors></Texture>
      </Layer></Layers>
      <Frames>
        <Frame name="$parentChild" width="10" height="10">
          <Anchors><Anchor point="TOPRIGHT" relativePoint="BOTTOMRIGHT"/></Anchors>
        </Frame>
      </Frames>
    </Frame>
    <Frame name="Empty"><Anchors><Anchor point="CENTER"/></Anchors></Frame>
    <ScrollFrame name="Scroller" width="50" height="50">
      <Anchors><Anchor point="BOTTOMLEFT"><Offset><AbsDimension x="400" y="100"/></Offset></Anchor></Anchors>
      <ScrollChild><Frame name="ScrollerContent" width="200" height="200"/></ScrollChild>
    </ScrollFrame>
  </Ui>`);
  assert.equal(loaded.ok, true, loaded.diagnostics.map((entry) => entry.message).join("\n"));
  bridge.registerFontObjects();
  bridge.setTextMeasure((_frame, text) => measure(text));
  const lua = (code) => {
    const result = vm.execute(code, "@glue-html-bounds");
    assert.equal(result.ok, true, result.error);
  };
  const bounds = (name) => {
    lua(`BoundsResult = { ${name}:GetBoundsRect() }`);
    lua("BoundsCount = #BoundsResult");
    const count = vm.getGlobal("BoundsCount");
    const values = [];
    for (let index = 1; index <= count; index += 1) {
      lua(`BoundsValue = BoundsResult[${index}]`);
      values.push(vm.getGlobal("BoundsValue"));
    }
    return values;
  };
  return { vm, bridge, lua, bounds, close() { vm.close(); } };
}

test("a SimpleHTML's bounds take in its page, while its dialog is still hidden", () => {
  const { lua, bounds, bridge, close } = runtime();
  try {
    // 300 units hold 50 characters a line: 120 characters are three lines of 12 with 2 between.
    lua(`Page:SetText("<html><body><p align='CENTER'>${"слово ".repeat(20).trim()}</p></body></html>")`);
    assert.equal(bridge.getFrame("Dialog").visible, false, "GlueDialog_Show asks before Show");
    const [left, bottom, width, height] = bounds("Page");
    assert.equal(height, 3 * 12 + 2 * 2, "the page, not the declared 30");
    assert.equal(width, 300);
    const page = bridge.geometry(bridge.getFrame("Page"));
    assert.deepEqual([left, bottom], [page.left, page.top - height], "anchored at the widget's top");
    // A header in its own font and spacing, then the paragraph 4 lower.
    lua(`Page:SetText("<html><body><h1>Заголовок</h1><p>Строка</p></body></html>")`);
    assert.equal(bounds("Page")[3], 18 + 4 + 12);
    // A short page leaves the widget's own box: one line of 12 inside 30.
    lua(`Page:SetText("<html><body><p>Да</p></body></html>")`);
    assert.equal(bounds("Page")[3], 30);
  } finally { close(); }
});

test("a frame's bounds: its box, shown regions and shown child frames; an empty box returns nothing", () => {
  const { bounds, close } = runtime();
  try {
    // Box 100x50 at (200,100); a 20x20 texture on its top edge; a hidden one 50 to the right is left out;
    // a 10x10 child hangs below its bottom-right corner.
    assert.deepEqual(bounds("Box"), [200, 90, 100, 80]);
    assert.deepEqual(bounds("Empty"), [], "0x004913c0 returns 0: no values");
    // CSimpleScrollFrame's +0x64 (0x0096b9d0) walks the same way but leaves its scroll child out.
    assert.deepEqual(bounds("Scroller"), [400, 100, 50, 50]);
  } finally { close(); }
});

test("an HTML refusal opens its dialog's HTML twin with the page as written, and only OPEN_STATUS_DIALOG", () => {
  const html = '<html><body><p align="CENTER">Вы указали неверные сведения. <a href="u">Справка</a></p></body></html>';
  const strings = { LOGIN_UNKNOWN_ACCOUNT: html, LOGIN_FAILED: html, LOGIN_ENTER_NAME: "Введите имя" };
  const run = (message, hasDialogType) => {
    const events = [];
    showStatusMessage({ fire: (...args) => events.push(args.map(String).join(" / ")), glueString: (key) => strings[key], hasDialogType },
      message);
    return events;
  };
  const all = () => true;
  assert.deepEqual(run({ key: "LOGIN_UNKNOWN_ACCOUNT", dialog: "OKAY" }, all), [`OPEN_STATUS_DIALOG / OKAY_HTML / ${html}`]);
  assert.deepEqual(run({ key: "LOGIN_FAILED", dialog: "CONNECTION_HELP" }, all), [`OPEN_STATUS_DIALOG / CONNECTION_HELP_HTML / ${html}`]);
  // Plain text keeps the plain dialog and its re-measure.
  assert.deepEqual(run({ key: "LOGIN_ENTER_NAME", dialog: "OKAY" }, all),
    ["OPEN_STATUS_DIALOG / OKAY / Введите имя", "UPDATE_STATUS_DIALOG / Введите имя"]);
  // A corpus without the twin: the plain dialog, the page flattened.
  assert.deepEqual(run({ key: "LOGIN_UNKNOWN_ACCOUNT", dialog: "OKAY" }, (type) => !type.endsWith("_HTML")), [
    "OPEN_STATUS_DIALOG / OKAY / Вы указали неверные сведения. Справка",
    "UPDATE_STATUS_DIALOG / Вы указали неверные сведения. Справка",
  ]);
  // PARENTAL_CONTROL has no twin in FUN_004d80c0.
  assert.deepEqual(run({ key: "LOGIN_FAILED", dialog: "PARENTAL_CONTROL", data: "URL" }, all).slice(0, 1),
    ["OPEN_STATUS_DIALOG / PARENTAL_CONTROL / Вы указали неверные сведения. Справка / URL"]);
});

test("a twin that did not open (a Lua error in GlueDialog_Show) falls back to the plain dialog, flattened (3.35-review)", () => {
  // 03.10 review: GlueDialog_Show does arithmetic on GetBoundsRect's height (GlueDialog.lua:608-630); an
  // error there — a throw, or no values — leaves no dialog at all, and the login screen says nothing.
  const html = '<html><body><p align="CENTER">Ошибка входа. <a href="u">Справка</a></p></body></html>';
  const run = (dialogShown) => {
    const events = [];
    const asked = [];
    showStatusMessage({
      fire: (...args) => events.push(args.map(String).join(" / ")),
      glueString: (key) => ({ LOGIN_FAILED: html })[key],
      hasDialogType: () => true,
      dialogShown: (type) => { asked.push(type); return dialogShown(type); },
    }, { key: "LOGIN_FAILED", dialog: "CONNECTION_HELP" });
    return { events, asked };
  };
  const failed = run(() => false);
  assert.deepEqual(failed.asked, ["CONNECTION_HELP_HTML"]);
  assert.deepEqual(failed.events, [
    `OPEN_STATUS_DIALOG / CONNECTION_HELP_HTML / ${html}`,
    "OPEN_STATUS_DIALOG / CONNECTION_HELP / Ошибка входа. Справка",
    "UPDATE_STATUS_DIALOG / Ошибка входа. Справка",
  ]);
  assert.deepEqual(run((type) => type === "CONNECTION_HELP_HTML").events, [`OPEN_STATUS_DIALOG / CONNECTION_HELP_HTML / ${html}`]);
});

test("odd pages never throw and never shrink the widget's box (3.35-review)", () => {
  const { lua, bounds, close } = runtime();
  try {
    const pages = [
      "",
      "<html><body></body></html>",
      "<html><body><img src='Interface\\\\Icons\\\\X' width='20' height='64'/></body></html>",
      "<html><body><img src='x' width='abc' height='-5'/><img/></body></html>",
      "<html><body><p>а<br/><br/>б</p><br/><br/><h1><br/></h1></body></html>",
      "<html><body><p>не закрыт",
      "<html><body><p><p><h2>вложено</h2></p></p></body></html>",
      `<html><body><p>${"Ж".repeat(400)}</p></body></html>`,
      "|n|n|n",
      "<HTML><BODY><P>верхний регистр</P></BODY></HTML>",
    ];
    for (const page of pages) {
      lua(`Page:SetText(${JSON.stringify(page)})`);
      const values = bounds("Page");
      assert.equal(values.length, 4, `four values for ${JSON.stringify(page).slice(0, 40)}`);
      assert.ok(values.every(Number.isFinite), `finite for ${JSON.stringify(page).slice(0, 40)}: ${values}`);
      assert.equal(values[2], 300);
      assert.ok(values[3] >= 30, `at least the declared 30: ${values[3]}`);
    }
    // The pictures-only page is as tall as its picture; the long word wraps inside the width.
    lua(`Page:SetText(${JSON.stringify(pages[2])})`);
    assert.equal(bounds("Page")[3], 64);
    lua(`Page:SetText(${JSON.stringify(pages[7])})`);
    assert.equal(bounds("Page")[3], 8 * 12 + 7 * 2, "400 characters of 6 units: 8 lines of 50");
  } finally { close(); }
});
