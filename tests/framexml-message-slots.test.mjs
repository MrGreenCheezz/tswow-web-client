import assert from "node:assert/strict";
import test from "node:test";

// WORK_PLAN 3.34 (13.10): a ScrollingMessageFrame's slots as Wow.exe 3.3.5a lays them (0x00969fa0) — AtTop
// (0x009734d0), GetNumLinesDisplayed (0x009736a0), PageUp/PageDown (0x0096ab50/0x0096abd0), the lines out of the
// slots frozen and counting again when a layout puts them back (0x00969e60, 0x00969370) — and a MessageFrame's
// slot count, a truncation with an exactness guard over font height plus spacing (0x00968790).
// The dependency-free DOM seam of framexml-message-frame-retime.test.mjs.
function fakeDocument() {
  const doc = {
    activeElement: undefined,
    createElement: (tag) => make(tag),
    createElementNS: (_namespace, tag) => make(tag),
    getElementById: () => undefined,
  };
  function make(tag) {
    const attributes = new Map();
    const listeners = new Map();
    const style = {
      setProperty(name, value) { this[name] = String(value); },
      removeProperty(name) { delete this[name]; },
    };
    const node = {
      ownerDocument: doc,
      tagName: tag.toUpperCase(),
      children: [],
      parentElement: undefined,
      style,
      hidden: false,
      textContent: "",
      scrollTop: 0,
      className: "",
      classList: { add(...names) { node.className = [...new Set([...node.className.split(" ").filter(Boolean), ...names])].join(" "); } },
      addEventListener(name, listener) {
        const current = listeners.get(name) ?? [];
        current.push(listener);
        listeners.set(name, current);
      },
      dispatchEvent(event) { for (const listener of listeners.get(event.type) ?? []) listener(event); },
      setAttribute(name, value) { attributes.set(name, String(value)); },
      getAttribute(name) { return attributes.get(name) ?? null; },
      removeAttribute(name) { attributes.delete(name); },
      append(...children) {
        for (const child of children) {
          child.parentElement = node;
          node.children.push(child);
        }
      },
      replaceChildren(...children) {
        for (const child of node.children) child.parentElement = undefined;
        node.children = [];
        node.append(...children);
      },
      remove() {
        const index = node.parentElement?.children.indexOf(node) ?? -1;
        if (index >= 0) node.parentElement.children.splice(index, 1);
        node.parentElement = undefined;
      },
    };
    return node;
  }
  doc.head = make("head");
  return doc;
}

globalThis.document = fakeDocument();
const { FrameXmlUiBridge } = await import("../dist/code/browser/ui/framexml_compat/FrameXmlRuntime.js");
const { FrameXmlDomRenderer } = await import("../dist/code/browser/ui/framexml_compat/FrameXmlDomRenderer.js");
const { GlueLuaVm } = await import("../dist/code/browser/glue/GlueLua.js");
const { GlueWidgetBinder } = await import("../dist/code/browser/glue/GlueWidgets.js");
const { frameXmlMessageLineCount } = await import("../dist/code/browser/ui/framexml_compat/FrameXmlMessageSlots.js");

function find(root, name) {
  if (root.getAttribute("data-framexml-name") === name) return root;
  for (const child of root.children) {
    const result = find(child, name);
    if (result) return result;
  }
  return undefined;
}
const layerOf = (host, name) =>
  find(host, name)?.children.find((child) => child.getAttribute("data-framexml-message-layer") === "true");

function runtime() {
  const vm = new GlueLuaVm();
  const bridge = new FrameXmlUiBridge();
  const binder = new GlueWidgetBinder(vm, bridge);
  bridge.setRuntime(binder);
  const loaded = bridge.loadAddon(String.raw`<Ui>
    <Font name="LineFont" font="Fonts\\FRIZQT__.TTF">
      <FontHeight><AbsValue val="16"/></FontHeight>
    </Font>
    <ScrollingMessageFrame name="Chat" displayDuration="10" maxLines="40" width="300" height="100">
      <FontString inherits="LineFont"/>
    </ScrollingMessageFrame>
    <MessageFrame name="Plain" width="200" height="100"><FontString inherits="LineFont"/></MessageFrame>
    <MessageFrame name="Spaced" width="200" height="100"><FontString inherits="LineFont" spacing="4"/></MessageFrame>
  </Ui>`);
  assert.equal(loaded.ok, true, loaded.diagnostics.map((entry) => entry.message).join("\n"));
  bridge.registerFontObjects();
  const host = document.createElement("section");
  const renderer = new FrameXmlDomRenderer(host, { bridge });
  renderer.mount(loaded.roots);
  const lua = (code, results = 0) => {
    const fn = vm.compileFunction(code, "slots", []);
    assert.ok(fn, code);
    try { return vm.call(fn, [], results); } finally { vm.release(fn); }
  };
  return { vm, bridge, renderer, host, lua, close() { renderer.destroy(); vm.close(); } };
}

const slots = (lua) => lua(`return Chat:GetNumLinesDisplayed(), Chat:AtTop(), Chat:GetCurrentScroll()`, 3);

test("AtTop and GetNumLinesDisplayed: the slots from the current line toward the oldest, each while it fits", () => {
  const { lua, host, close } = runtime();
  try {
    assert.deepEqual(slots(lua), [0, undefined, 0], "no lines: nothing laid out (0x00969960's values)");
    lua(`for i = 1, 20 do Chat:AddMessage("line " .. i) end`);
    assert.deepEqual(slots(lua), [0, undefined, 0], "no laid-out layer: nothing laid out");
    const layer = layerOf(host, "Chat");
    layer.clientHeight = 100;
    assert.deepEqual(slots(lua), [6, undefined, 0], "100 px of 16 px lines: six, the seventh does not fit");
    layer.children.at(-1).offsetHeight = 40; // the newest line wraps
    assert.deepEqual(slots(lua), [4, undefined, 0], "40 + 3 × 16 = 88; one more is 104");
    lua(`Chat:ScrollToTop()`);
    assert.deepEqual(slots(lua), [1, 1, 19], "the oldest line current: one slot, at the top");
    layer.clientHeight = 10;
    lua(`Chat:ScrollToBottom()`);
    assert.deepEqual(slots(lua), [1, undefined, 0], "the first line takes a slot even when it does not fit");
  } finally { close(); }
});

test("PageUp/PageDown walk the slots' count and come one line back; unlaid, PageDown goes one line up", () => {
  const { lua, host, close } = runtime();
  try {
    lua(`for i = 1, 20 do Chat:AddMessage("line " .. i) end`);
    const current = () => 19 - lua(`return Chat:GetCurrentScroll()`, 1)[0];
    lua(`Chat:PageDown()`);
    assert.equal(current(), 18, "0 slots: no steps, not at top, one line toward the oldest (0x0096abd0)");
    lua(`Chat:ScrollToBottom(); Chat:PageUp()`);
    assert.equal(current(), 19, "0 slots at the bottom: only a revive");
    layerOf(host, "Chat").clientHeight = 100;
    lua(`Chat:PageUp()`);
    assert.equal(current(), 14, "six lines up, one back: the page keeps a line");
    lua(`Chat:PageDown()`);
    assert.equal(current(), 19, "back at the bottom it stops (+0x2d4)");
    lua(`Chat:SetScrollOffset(12)`);
    assert.equal(current(), 7);
    lua(`Chat:PageUp()`);
    assert.equal(current(), 5, "at the top after two steps (+0x2d0): no step back");
    lua(`Chat:PageUp()`);
    assert.equal(current(), 5, "at the top: only a revive");
  } finally { close(); }
});

test("a line pushed out of the slots freezes; a taller layer puts it back counting where it stopped", () => {
  const { bridge, lua, host, close } = runtime();
  try {
    const layer = layerOf(host, "Chat");
    layer.clientHeight = 100;
    layer.scrollHeight = 400;
    lua(`for i = 1, 20 do Chat:AddMessage("line " .. i) end`);
    bridge.tick(4);
    lua(`Chat:AddMessage("line 21")`); // a paint at the bottom: line 15 leaves the slots at 4 s
    const state = bridge.getFrame("Chat").messageFrame;
    const lines = state.messages;
    assert.equal(lines[14].fadeUntil, Infinity, "line 15 frozen");
    bridge.tick(20);
    layer.clientHeight = 200;
    lua(`Chat:AddMessage("line 22")`); // 12 slots now: lines 11..22
    assert.equal(lines.length, 22);
    assert.equal(lines[14].fadeUntil - state.fadeClock, 6 + 3, "line 15 again with its 6 s shown and 3 s fade left");
    assert.equal(lines[10].visibleUntil - state.fadeClock, 10, "line 11 froze when it was laid out of the slots at once: 10 s");
    assert.equal(lines[9].fadeUntil, Infinity, "line 10 still out of the slots");
    lua(`Chat:SetTimeVisible(2); Chat:SetFadeDuration(1)`);
    assert.equal(lines[9].fadeUntil, Infinity, "0x00969280/0x009692c0 write only the lines in slots");
  } finally { close(); }
});

test("a MessageFrame's slots: font height plus spacing, truncated, with the client's exactness guard", () => {
  const { lua, bridge, close } = runtime();
  try {
    lua(`for i = 1, 9 do Plain:AddMessage("p" .. i); Spaced:AddMessage("s" .. i) end`);
    assert.equal(bridge.getFrame("Plain").messageFrame.messages.length, 6, "trunc(100 / 16)");
    assert.equal(bridge.getFrame("Spaced").messageFrame.messages.length, 5, "100 / (16 + 4)");
    assert.equal(frameXmlMessageLineCount(60, 16), 3, "UIErrorsFrame: 3.75 truncated, not rounded to 4");
    assert.equal(frameXmlMessageLineCount(95.99995, 16), 6, "within the guard of 6 lines");
    assert.equal(frameXmlMessageLineCount(95.9, 16), 5);
    assert.equal(frameXmlMessageLineCount(0, 16), undefined);
  } finally { close(); }
});
