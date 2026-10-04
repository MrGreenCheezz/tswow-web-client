import assert from "node:assert/strict";
import test from "node:test";

// WORK_PLAN 3.34 leftovers (03.10, L5): the ScrollingMessageFrame rules of Wow.exe 3.3.5a for
// SetTimeVisible/SetFadeDuration, a fade length of 0 mid-fade, insertMode TOP and the scroll calls.
// The same dependency-free DOM seam as framexml-message-frame-fade; frames never go to assert.
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
      writes: 0,
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
      replaceChildrenCalls: 0,
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
        node.replaceChildrenCalls += 1;
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

function find(root, name) {
  if (root.getAttribute("data-framexml-name") === name) return root;
  for (const child of root.children) {
    const result = find(child, name);
    if (result) return result;
  }
  return undefined;
}

function layerOf(host, name) {
  return find(host, name)?.children.find((child) => child.getAttribute("data-framexml-message-layer") === "true");
}

function runtime() {
  const vm = new GlueLuaVm();
  const bridge = new FrameXmlUiBridge();
  const binder = new GlueWidgetBinder(vm, bridge);
  bridge.setRuntime(binder);
  const loaded = bridge.loadAddon(String.raw`<Ui>
    <Font name="LineFont" font="Fonts\\FRIZQT__.TTF">
      <FontHeight><AbsValue val="16"/></FontHeight>
    </Font>
    <MessageFrame name="Plain" width="200" height="100"><FontString inherits="LineFont"/></MessageFrame>
    <ScrollingMessageFrame name="Chat" displayDuration="10" maxLines="40" width="300" height="100">
      <FontString inherits="LineFont"/>
    </ScrollingMessageFrame>
    <ScrollingMessageFrame name="Log" fade="false" insertMode="top" maxLines="10" width="300" height="100">
      <FontString inherits="LineFont"/>
    </ScrollingMessageFrame>
    <ScrollingMessageFrame name="Odd" insertMode="CENTER" width="300" height="100"/>
    <MessageFrame name="OddPlain" insertMode="CENTER" width="300" height="100"/>
  </Ui>`);
  assert.equal(loaded.ok, true, loaded.diagnostics.map((entry) => entry.message).join("\n"));
  bridge.registerFontObjects();
  const host = document.createElement("section");
  const renderer = new FrameXmlDomRenderer(host, { bridge });
  renderer.mount(loaded.roots);
  const lua = (code) => {
    const result = vm.execute(code, "@retime");
    assert.equal(result.ok, true, result.error);
  };
  return { vm, bridge, renderer, host, lua, close() { renderer.destroy(); vm.close(); } };
}

const texts = (layer) => layer.children.map((line) => line.textContent);
const opacity = (line) => (line.style.opacity === undefined || line.style.opacity === "" ? 1 : Number(line.style.opacity));
const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 0.01, `${label}: ${actual}, expected ${expected}`);

test("a ScrollingMessageFrame's SetTimeVisible holds a fading line at its alpha, then lets it fade on (0x00969280)", () => {
  const { bridge, host, renderer, lua, close } = runtime();
  try {
    lua(`Chat:AddMessage("chat"); Plain:AddMessage("plain")`);
    bridge.tick(10);
    bridge.tick(1.5);
    renderer.tickMessageFades();
    const chat = layerOf(host, "Chat");
    const plain = layerOf(host, "Plain");
    near(opacity(chat.children[0]), 0.5, "chat half faded");
    near(opacity(plain.children[0]), 0.5, "plain half faded");
    lua(`Chat:SetTimeVisible(2); Plain:SetTimeVisible(2)`);
    bridge.tick(1.9);
    renderer.tickMessageFades();
    near(opacity(chat.children[0]), 0.5, "the client writes 2 s into the fading line's \"shown\": it waits at its alpha");
    assert.equal(bridge.getFrame("Plain").messageFrame.messages.length, 0,
      "a MessageFrame touches only a line still shown (0x00967db0): this one faded on and was cleared");
    bridge.tick(0.2);
    bridge.tick(0.65);
    renderer.tickMessageFades();
    near(opacity(chat.children[0]), 0.25, "then it fades from where it stopped: 0.75 of 3 s left");
    // Held again, then revived by a scroll call (0x00969410): its own alpha, fresh countdowns.
    lua(`Chat:SetTimeVisible(5)`);
    bridge.tick(1);
    renderer.tickMessageFades();
    near(opacity(chat.children[0]), 0.25, "held");
    lua(`Chat:ScrollDown()`);
    renderer.tickMessageFades();
    assert.equal(opacity(chat.children[0]), 1, "a revived line is drawn in its own alpha");
  } finally { close(); }
});

test("SetFadeDuration(0) while a line fades keeps the alpha it had, for good — in both kinds of frame", () => {
  const { bridge, host, renderer, lua, close } = runtime();
  try {
    lua(`Chat:AddMessage("chat"); Plain:AddMessage("plain")`);
    bridge.tick(10);
    bridge.tick(1.5);
    lua(`Chat:SetFadeDuration(0); Plain:SetFadeDuration(0)`);
    for (let i = 0; i < 40; i += 1) bridge.tick(2.5);
    renderer.tickMessageFades();
    near(opacity(layerOf(host, "Chat").children[0]), 0.5, "chat");
    near(opacity(layerOf(host, "Plain").children[0]), 0.5, "plain");
    assert.equal(bridge.getFrame("Plain").messageFrame.messages.length, 1, "both countdowns are 0: the update passes it by");
    // A new fade length: the ScrollingMessageFrame gives it to every live line (0x009692c0), the
    // MessageFrame only to a line whose "fading" is not 0 (0x00967e00).
    lua(`Chat:SetFadeDuration(2); Plain:SetFadeDuration(2)`);
    bridge.tick(1);
    renderer.tickMessageFades();
    near(opacity(layerOf(host, "Chat").children[0]), 0.5, "chat fades again, from full, over 2 s");
    near(opacity(layerOf(host, "Plain").children[0]), 0.5, "plain stays where it stopped");
    bridge.tick(1.1);
    renderer.tickMessageFades();
    assert.equal(layerOf(host, "Chat").children[0].style.visibility, "hidden");
    // A line revived by a scroll starts from its own alpha again.
    lua(`Chat:ScrollDown()`);
    renderer.tickMessageFades();
    assert.equal(opacity(layerOf(host, "Chat").children[0]), 1);
  } finally { close(); }
});

test("a ScrollingMessageFrame's SetFadeDuration also lengthens a line that had no fade", () => {
  const { bridge, host, renderer, lua, close } = runtime();
  try {
    lua(`Chat:SetFadeDuration(0); Chat:AddMessage("z"); Chat:SetFadeDuration(4)`);
    bridge.tick(10);
    bridge.tick(2);
    renderer.tickMessageFades();
    near(opacity(layerOf(host, "Chat").children[0]), 0.5, "fading over the 4 s it was given");
    // Both countdowns 0 keep a line; a new "shown" then is all it has left — in a
    // ScrollingMessageFrame (0x00969280). A MessageFrame touches only a line still shown (0x00967db0).
    lua(`Chat:SetFadeDuration(0); Chat:SetTimeVisible(0); Chat:AddMessage("w")
      Plain:SetFadeDuration(0); Plain:SetTimeVisible(0); Plain:AddMessage("w")`);
    for (let i = 0; i < 20; i += 1) bridge.tick(1);
    lua(`Chat:SetTimeVisible(1); Plain:SetTimeVisible(1)`);
    bridge.tick(1.1);
    renderer.tickMessageFades();
    assert.equal(layerOf(host, "Chat").children[1].style.visibility, "hidden", "cleared when its 1 s ran out");
    assert.deepEqual(bridge.getFrame("Plain").messageFrame.messages.map((line) => line.text), ["w"]);
  } finally { close(); }
});

test("insertMode TOP on a ScrollingMessageFrame: the newest line on top; SetScrollOffset counts from it", () => {
  const { vm, bridge, host, lua, close } = runtime();
  try {
    lua(`for _, text in ipairs({ "a", "b", "c" }) do Log:AddMessage(text) end
      M1, M2, M3 = Log:GetInsertMode(), Odd:GetInsertMode(), OddPlain:GetInsertMode()`);
    // The loaders differ (0x0096ac50 / 0x00968da0): a ScrollingMessageFrame's is TOP only for "TOP",
    // case-blind; a MessageFrame's is BOTTOM only for "BOTTOM".
    assert.deepEqual([vm.getGlobal("M1"), vm.getGlobal("M2"), vm.getGlobal("M3")], ["TOP", "BOTTOM", "TOP"]);
    const log = layerOf(host, "Log");
    assert.deepEqual(texts(log), ["c", "b", "a"], "the guild bank log reads newest first");
    lua(`Log:SetScrollOffset(1); S1, B1 = Log:GetCurrentScroll(), Log:AtBottom() and 1 or 0
      Log:SetScrollOffset(0); S0, B0 = Log:GetCurrentScroll(), Log:AtBottom() and 1 or 0
      Log:ScrollToTop(); ST = Log:GetCurrentScroll()
      Log:SetScrollOffset(5); S5 = Log:GetCurrentScroll()`);
    assert.deepEqual(["S1", "B1", "S0", "B0", "ST"].map((name) => vm.getGlobal(name)), [1, 0, 0, 1, 2]);
    assert.equal(vm.getGlobal("S5"), 2, "an offset is taken modulo the lines (0x0096a970): 5 of 3 is 2");
    assert.equal(bridge.getFrame("Log").scroll.verticalScroll, 0);
    // L5-review: lua_isnumber takes a numeric string too; anything else moves nothing (0x00973470).
    lua(`Log:SetScrollOffset("1"); SS = Log:GetCurrentScroll()
      Log:SetScrollOffset("one"); SX = Log:GetCurrentScroll()
      Log:SetScrollOffset(5)`);
    assert.deepEqual([vm.getGlobal("SS"), vm.getGlobal("SX")], [1, 1]);
    lua(`Log:AddMessage("d")`);
    assert.deepEqual(texts(log), ["d", "c", "b", "a"]);
  } finally { close(); }
});

test("a scroll at the bottom brings back only the lines in view; ScrollUp with every line in view stays", () => {
  const { vm, bridge, host, renderer, lua, close } = runtime();
  try {
    const layer = layerOf(host, "Chat");
    // The browser's layout, as the renderer reads it: 100 px of a 400 px history in a 16 px font.
    layer.clientHeight = 100;
    layer.scrollHeight = 400;
    lua(`for i = 1, 20 do Chat:AddMessage("line " .. i) end`);
    for (let i = 0; i < 60; i += 1) bridge.tick(0.25);
    renderer.tickMessageFades();
    const shown = () => layer.children.map((line) => line.style.visibility ?? "");
    assert.ok(shown().every((value) => value === "hidden"));
    lua(`Chat:ScrollDown()`);
    renderer.tickMessageFades();
    // 0x00969410 revives the client's visible slots, not the history: ceil(100 / 16) + 1 lines here.
    const visible = shown().map((value) => value === "");
    assert.deepEqual(visible.slice(0, 12), new Array(12).fill(false), "out of view: left hidden");
    assert.deepEqual(visible.slice(12), new Array(8).fill(true), "in view: back");
    for (let i = 0; i < 60; i += 1) bridge.tick(0.25);
    assert.equal(renderer.tickMessageFades(), 1);
    // A burst, then a scroll at the bottom: the lines out of view stop counting (they would only fade
    // out of sight, a style write a frame each); the ones in view start again.
    lua(`for i = 1, 20 do Chat:AddMessage("burst " .. i) end`);
    bridge.tick(1);
    lua(`Chat:ScrollDown()`);
    renderer.tickMessageFades();
    const lines = bridge.getFrame("Chat").messageFrame.messages;
    const clock = bridge.getFrame("Chat").messageFrame.fadeClock;
    assert.equal(lines.filter((line) => clock < line.fadeUntil).length, 8, "only the lines in view still count");
    assert.equal(layer.children.at(-1).style.visibility ?? "", "");
    // Everything in view: the client's ScrollUp is at its top (0x0096a8a0, +0x2d0) and only revives.
    layer.scrollHeight = 100;
    lua(`Chat:AddMessage("line 21")`);
    lua(`Chat:ScrollUp(); FITS = Chat:AtBottom() and 1 or 0`);
    assert.equal(vm.getGlobal("FITS"), 1, "nothing to scroll: still at the bottom");
    layer.scrollHeight = 400;
    lua(`Chat:AddMessage("line 22")`);
    lua(`Chat:ScrollUp(); MOVED = Chat:AtBottom() and 1 or 0`);
    assert.equal(vm.getGlobal("MOVED"), 0, "with more lines than room ScrollUp leaves the bottom");
  } finally { close(); }
});
