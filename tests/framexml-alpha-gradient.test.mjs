import assert from "node:assert/strict";
import test from "node:test";

// Plan item 3.21 (05.10): FontString:SetAlphaGradient as Wow.exe 0x0048d0f0 → 0x006c78f0 does it, and
// GameTooltip:SetSpellByID (0x00625b90) over a fake binder host. See FrameXmlAlphaGradient.ts and
// GlueWidgetMethodFills.ts for the addresses.
const {
  frameXmlGradientGlyphCount, frameXmlGradientOpacity, frameXmlGradientSegments, setFrameXmlAlphaGradient,
  paintFrameXmlAlphaGradient, frameXmlAlphaGradient,
} = await import("../dist/code/browser/ui/framexml_compat/FrameXmlAlphaGradient.js");
const { parseFrameXmlText } = await import("../dist/code/browser/ui/framexml_compat/FrameXmlText.js");
const { tooltipSpellByIdMethods, frameDepthMethods, fontStringGradientMethods } =
  await import("../dist/code/browser/glue/GlueWidgetMethodFills.js");

function fakeElement() {
  const document = { createElement: () => fakeChild() };
  function fakeChild() {
    const node = {
      ownerDocument: document, children: [], textContent: "", style: {}, attributes: new Map(),
      setAttribute(name, value) { node.attributes.set(name, String(value)); },
      remove() { const list = node.parent?.children; if (list) list.splice(list.indexOf(node), 1); },
      append(child) { child.parent = node; node.children.push(child); },
    };
    return node;
  }
  return fakeChild();
}

const frame = (text, name = "QuestInfoDescriptionText") => ({ type: "FontString", name, text });

test("the ramp: a glyph before start is whole, then two steps of round(255/length) per glyph down to 0", () => {
  // length 30: 255/30 = 8.5 rounds half to even → 8.
  assert.equal(frameXmlGradientOpacity(2, 3, 30), 1);
  assert.equal(frameXmlGradientOpacity(3, 3, 30), (255 + 247) / 2 / 255);
  assert.equal(frameXmlGradientOpacity(3 + 15, 3, 30), (15 + 7) / 2 / 255);
  assert.equal(frameXmlGradientOpacity(3 + 16, 3, 30), 0);
  assert.equal(frameXmlGradientOpacity(500, 3, 30), 0, "past start + length the ramp's end value, 0");
  // length 10: 25.5 → 26 (half to even); length 0: no ramp, every glyph whole.
  assert.equal(frameXmlGradientOpacity(1, 0, 10), (255 - 52 + 255 - 78) / 2 / 255);
  assert.equal(frameXmlGradientOpacity(7, 0, 0), 1);
  // A ramp too long for a step (255/600 rounds to 0) fades nothing.
  assert.equal(frameXmlGradientOpacity(5, 0, 600), 1);
});

test("glyphs are the visible characters of the parsed text, without whitespace or escapes", () => {
  assert.equal(frameXmlGradientGlyphCount("abc"), 3);
  assert.equal(frameXmlGradientGlyphCount("ab c|nd"), 4);
  assert.equal(frameXmlGradientGlyphCount("|cffff0000ру|r!"), 3);
  assert.equal(frameXmlGradientGlyphCount(""), 0);
});

test("the answer: 1 while start is short of the glyph count, nil after, nil and no change for a negative", () => {
  const f = frame("abcdef");
  assert.deepEqual(setFrameXmlAlphaGradient(f, f.text, 0, 30), { answer: true, changed: true });
  assert.deepEqual(setFrameXmlAlphaGradient(f, f.text, 0, 30), { answer: true, changed: false }, "the same pair");
  assert.deepEqual(setFrameXmlAlphaGradient(f, f.text, 5, 30), { answer: true, changed: true });
  assert.deepEqual(setFrameXmlAlphaGradient(f, f.text, 6, 30), { answer: false, changed: true }, "the last glyph is whole");
  assert.deepEqual(setFrameXmlAlphaGradient(f, f.text, 6, 30), { answer: true, changed: false },
    "the layout's own pair answers 1 even past the end (0x006c78f0)");
  assert.deepEqual(setFrameXmlAlphaGradient(f, f.text, -1, 30), { answer: false, changed: false });
  assert.deepEqual(frameXmlAlphaGradient(f), { start: 6, length: 30 }, "a refused pair is not kept");
  // A new text resets the layout's pair: the same numbers are measured again.
  assert.deepEqual(setFrameXmlAlphaGradient(f, "abcdefgh", 6, 30), { answer: true, changed: true });
  const empty = frame("");
  assert.equal(setFrameXmlAlphaGradient(empty, "", 0, 30).answer, true, "no glyphs: no vertex buffer, 1");
});

test("segments split the coloured runs where the opacity changes; spaces ride with the glyph before", () => {
  const segments = frameXmlGradientSegments(parseFrameXmlText("ab |cffff0000cd|r"), 1, 30);
  assert.deepEqual(segments.map((s) => [s.text, s.color, Math.round(s.opacity * 255)]), [
    ["a", undefined, 255], ["b ", undefined, 251], ["c", "#ff0000ff", 235], ["d", "#ff0000ff", 219],
  ]);
});

test("the renderer hook draws the fade as spans, skips an unchanged repaint and gives the text back at (0, 0)", () => {
  const f = frame("abcd efgh");
  const element = fakeElement();
  assert.equal(paintFrameXmlAlphaGradient(element, f), "none", "no gradient yet");
  setFrameXmlAlphaGradient(f, f.text, 2, 4);
  assert.equal(paintFrameXmlAlphaGradient(element, f), "painted");
  const opacities = element.children.map((span) => [span.textContent, span.style.opacity ?? "1"]);
  // 255/4 = 63.75 → 64: glyph 2 is (255+191)/2, glyph 3 (127+63)/2, glyph 4 on 0.
  assert.deepEqual(opacities, [["ab", "1"], ["c", "0.875"], ["d ", "0.373"], ["efgh", "0"]]);
  const first = element.children[0];
  assert.equal(paintFrameXmlAlphaGradient(element, f), "painted");
  assert.equal(element.children[0], first, "an unchanged pair is not drawn again");
  setFrameXmlAlphaGradient(f, f.text, 0, 0);
  assert.equal(paintFrameXmlAlphaGradient(element, f), "cleared", "(0, 0) fades nothing: the caller draws the text");
  assert.equal(element.children.length, 0);
  assert.equal(paintFrameXmlAlphaGradient(element, f), "none");
});

test("SetAlphaGradient: numbers only, truncated, answers 1 or nothing, repaints only a new pair", () => {
  let paints = 0;
  const bridge = { update: (_frame, mutate, kind) => { mutate({}); assert.equal(kind, "paint"); paints += 1; } };
  const { SetAlphaGradient } = fontStringGradientMethods(bridge);
  const f = frame("abcdef", "Probe");
  const call = (...args) => SetAlphaGradient({ frame: f, self: f, args });
  assert.deepEqual(call(1.9, 30.7), [1]);
  assert.deepEqual(frameXmlAlphaGradient(f), { start: 1, length: 30 });
  assert.equal(paints, 1);
  assert.deepEqual(call(1.2, "30"), [1]);
  assert.equal(paints, 1, "the same truncated pair is no repaint (QuestInfoFadingFrame_OnUpdate runs every frame)");
  assert.deepEqual(call(6, 30), []);
  assert.throws(() => call(1), /Usage: Probe:SetAlphaGradient\(start, length\)/);
  assert.throws(() => call("x", 1), /Usage: Probe:SetAlphaGradient/);
});

test("IgnoreDepth wants a boolean", () => {
  const { IgnoreDepth } = frameDepthMethods();
  const f = { type: "Frame", name: "WorldFrame" };
  assert.equal(IgnoreDepth({ frame: f, self: f, args: [true] }), undefined);
  assert.throws(() => IgnoreDepth({ frame: f, self: f, args: [1] }), /Usage: WorldFrame:IgnoreDepth\(ignore\)/);
  assert.throws(() => IgnoreDepth({ frame: { name: "" }, self: f, args: [] }), /Usage: <unnamed>:IgnoreDepth/);
});

test("SetSpellByID: a known spell is drawn and answers 1; an unknown one answers nothing and draws nothing", () => {
  const asked = [];
  const drawn = [];
  const known = new Set([3599]);
  const host = {
    callGlobal: (name, args) => { asked.push([name, ...args]); return [known.has(args[0])]; },
    spell: (_frame, id) => { drawn.push(id); return id !== 404; },
  };
  const { SetSpellByID } = tooltipSpellByIdMethods(host);
  const tooltip = { type: "GameTooltip", name: "GameTooltip" };
  const call = (...args) => SetSpellByID({ frame: tooltip, self: tooltip, args });
  assert.deepEqual(call(3599, false, true), [1]);
  assert.deepEqual(asked.at(-1), ["IsSpellKnown", 3599], "the player's book");
  assert.deepEqual(call(8071, true), []);
  assert.deepEqual(asked.at(-1), ["IsSpellKnown", 8071, true], "the pet's book");
  assert.deepEqual(drawn, [3599], "an unknown spell leaves the tooltip alone");
  known.add(404);
  assert.deepEqual(call(404), [], "the builder found nothing");
  assert.deepEqual(call(0), [], "id 0 is in no book");
  assert.throws(() => call(-1), /Invalid spell ID in GameTooltip:SetSpellByID/);
  assert.throws(() => call("fire"), /Invalid spell ID in GameTooltip:SetSpellByID/);
});
