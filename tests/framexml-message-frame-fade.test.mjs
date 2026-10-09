import assert from "node:assert/strict";
import test from "node:test";

// WORK_PLAN 3.34: MessageFrame/ScrollingMessageFrame line fade, as Wow.exe 3.3.5a does it
// (FrameXmlMessageFade.ts header). A dependency-free DOM seam; frames are never handed to assert.
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

/** UIErrorsFrame.xml's shape (512x60, ErrorFont, displayDuration 5, insertMode TOP) and its siblings. */
function runtime() {
  const vm = new GlueLuaVm();
  const bridge = new FrameXmlUiBridge();
  const binder = new GlueWidgetBinder(vm, bridge);
  bridge.setRuntime(binder);
  const loaded = bridge.loadAddon(String.raw`<Ui>
    <Font name="ErrorFont" font="Fonts\\FRIZQT__.TTF" justifyH="CENTER">
      <FontHeight><AbsValue val="16"/></FontHeight>
    </Font>
    <MessageFrame name="Errors" displayDuration="5" insertMode="TOP" width="512" height="60">
      <FontString inherits="ErrorFont" justifyH="CENTER"/>
    </MessageFrame>
    <MessageFrame name="Plain" width="200" height="100"><FontString inherits="ErrorFont"/></MessageFrame>
    <ScrollingMessageFrame name="Chat" displayDuration="120" maxLines="10" width="300" height="100"/>
    <ScrollingMessageFrame name="Log" fade="false" insertMode="TOP" maxLines="10" width="300" height="100"/>
  </Ui>`);
  assert.equal(loaded.ok, true, loaded.diagnostics.map((entry) => entry.message).join("\n"));
  bridge.registerFontObjects();
  const host = document.createElement("section");
  const renderer = new FrameXmlDomRenderer(host, { bridge });
  renderer.mount(loaded.roots);
  const lua = (code) => {
    const result = vm.execute(code, "@fade");
    assert.equal(result.ok, true, result.error);
  };
  return { vm, bridge, renderer, host, lua, close() { renderer.destroy(); vm.close(); } };
}

const texts = (layer) => layer.children.map((line) => line.textContent);
const opacity = (line) => (line.style.opacity === undefined || line.style.opacity === "" ? 1 : Number(line.style.opacity));

test("the XML's and the client's defaults: timeVisible 10, fadeDuration 3, fading on, insertMode BOTTOM", () => {
  const { vm, lua, close } = runtime();
  try {
    lua(`
      E1, E2, E3, E4 = Errors:GetTimeVisible(), Errors:GetFadeDuration(), Errors:GetFading(), Errors:GetInsertMode()
      P1, P2, P3, P4 = Plain:GetTimeVisible(), Plain:GetFadeDuration(), Plain:GetFading(), Plain:GetInsertMode()
      LogFading = Log:GetFading()
      Chat:SetFadeDuration(7); Chat:SetFading(false); Chat:SetInsertMode("TOP")
      C1, C2, C3 = Chat:GetFadeDuration(), Chat:GetFading(), Chat:GetInsertMode()
    `);
    const globals = (...names) => names.map((name) => vm.getGlobal(name));
    assert.deepEqual(globals("E1", "E2", "E3", "E4"), [5, 3, 1, "TOP"]);
    assert.deepEqual(globals("P1", "P2", "P3", "P4"), [10, 3, 1, "BOTTOM"]);
    assert.equal(vm.getGlobal("LogFading"), undefined, "fade=\"false\": GetFading answers nil");
    assert.deepEqual(globals("C1", "C2", "C3"), [7, undefined, "TOP"]);
  } finally { close(); }
});

test("a MessageFrame line is shown for timeVisible, fades linearly over fadeDuration, then is cleared", () => {
  const { bridge, host, renderer, lua, close } = runtime();
  try {
    lua(`Errors:AddMessage("Недостаточно маны", 1.0, 0.1, 0.1, 1.0)`);
    const layer = layerOf(host, "Errors");
    assert.deepEqual(texts(layer), ["Недостаточно маны"]);
    bridge.tick(4.9);
    renderer.tickMessageFades();
    assert.equal(opacity(layer.children[0]), 1, "still shown before timeVisible");
    bridge.tick(0.1);
    bridge.tick(1.5);
    renderer.tickMessageFades();
    assert.ok(Math.abs(opacity(layer.children[0]) - 0.5) < 0.01, `half faded at 1.5 of 3 s: ${layer.children[0].style.opacity}`);
    bridge.tick(1.4);
    renderer.tickMessageFades();
    assert.ok(opacity(layer.children[0]) < 0.06, "almost gone");
    bridge.tick(0.2);
    renderer.tickMessageFades();
    assert.equal(bridge.getFrame("Errors").messageFrame.messages.length, 0, "a cleared MessageFrame line is gone");
    assert.deepEqual(texts(layer), []);
  } finally { close(); }
});

test("insertMode TOP draws the newest line on top; the frame keeps the lines its height holds", () => {
  const { bridge, host, lua, close } = runtime();
  try {
    lua(`for i = 1, 4 do Errors:AddMessage("line " .. i) end; for i = 1, 2 do Plain:AddMessage("plain " .. i) end`);
    const errors = layerOf(host, "Errors");
    assert.deepEqual(texts(errors), ["line 4", "line 3", "line 2"], "60 high in a 16 font: three lines, newest first");
    assert.equal(bridge.getFrame("Errors").messageFrame.messages.length, 3);
    assert.equal(errors.style.justifyContent, "flex-start");
    const plain = layerOf(host, "Plain");
    assert.deepEqual(texts(plain), ["plain 1", "plain 2"], "BOTTOM: oldest first, the newest at the bottom");
    assert.equal(plain.style.justifyContent, "flex-end");
    lua(`Plain:SetInsertMode("TOP")`);
    assert.deepEqual(texts(plain), ["plain 2", "plain 1"]);
    lua(`Errors:AddMessage("")`);
    assert.deepEqual(texts(errors), ["line 4", "line 3", "line 2"], "an empty string adds nothing");
    lua(`Errors:Clear()`);
    assert.deepEqual(texts(errors), []);
  } finally { close(); }
});

test("SetFading(false) holds the lines, SetTimeVisible restarts shown ones, a hidden frame does not count", () => {
  const { bridge, host, renderer, lua, close } = runtime();
  try {
    const errors = bridge.getFrame("Errors");
    lua(`Errors:AddMessage("held"); Errors:SetFading(false)`);
    bridge.tick(100);
    renderer.tickMessageFades();
    assert.equal(errors.messageFrame.messages.length, 1, "nothing counts while fading is off");
    lua(`Errors:SetFading(true)`);
    bridge.tick(4);
    lua(`Errors:SetTimeVisible(2)`);
    bridge.tick(1.9);
    renderer.tickMessageFades();
    assert.equal(opacity(layerOf(host, "Errors").children[0]), 1, "SetTimeVisible gave the shown line 2 s again");
    lua(`Errors:Hide()`);
    bridge.tick(100);
    assert.equal(errors.messageFrame.messages.length, 1, "a hidden frame gets no update");
    lua(`Errors:Show()`);
    bridge.tick(0.2);
    bridge.tick(3);
    assert.equal(errors.messageFrame.messages.length, 0);
    lua(`Log:AddMessage("kept")`);
    bridge.tick(1000);
    renderer.tickMessageFades();
    assert.equal(opacity(layerOf(host, "Log").children[0]), 1, "fade=\"false\" keeps its lines");
  } finally { close(); }
});

test("a ScrollingMessageFrame fades only at the bottom, keeps faded history, and a scroll brings it back", () => {
  const { bridge, host, renderer, lua, close } = runtime();
  try {
    const chat = bridge.getFrame("Chat");
    lua(`Chat:AddMessage("one"); Chat:AddMessage("two")`);
    for (let i = 0; i < 500; i += 1) bridge.tick(0.25);
    renderer.tickMessageFades();
    const layer = layerOf(host, "Chat");
    assert.equal(chat.messageFrame.messages.length, 2, "the history stays");
    assert.deepEqual(layer.children.map((line) => line.style.visibility), ["hidden", "hidden"], "faded lines are hidden");
    lua(`Chat:ScrollUp()`);
    renderer.tickMessageFades();
    assert.deepEqual(layer.children.map((line) => line.style.visibility ?? ""), ["", ""], "a scroll shows them again");
    bridge.tick(0.25);
    for (let i = 0; i < 800; i += 1) bridge.tick(0.25);
    renderer.tickMessageFades();
    assert.deepEqual(layer.children.map(opacity), [1, 1], "scrolled up, nothing counts");
    lua(`Chat:ScrollToBottom()`);
    for (let i = 0; i < 488; i += 1) bridge.tick(0.25);
    renderer.tickMessageFades();
    const alpha = opacity(layer.children[1]);
    assert.ok(alpha > 0.3 && alpha < 0.37, `back at the bottom, fresh countdowns: 1 of 3 s left, ${alpha}`);
  } finally { close(); }
});

test("SetFadeDuration restarts a fading line at full alpha over the new length; a shown line keeps its time (0x00967e00)", () => {
  // Review 03.10: the client writes the new length into every line whose "fading" is not 0 — a
  // fading line starts its fade again, a shown one fades longer when its time runs out.
  const { bridge, host, renderer, lua, close } = runtime();
  try {
    const plain = bridge.getFrame("Plain");
    lua(`Plain:AddMessage("old")`);
    bridge.tick(10.2);
    bridge.tick(1.3);
    renderer.tickMessageFades();
    const layer = layerOf(host, "Plain");
    assert.ok(Math.abs(opacity(layer.children[0]) - 0.5) < 0.01, `1.5 of 3 s left: ${layer.children[0].style.opacity}`);
    lua(`Plain:AddMessage("new"); Plain:SetFadeDuration(6)`);
    bridge.tick(3);
    renderer.tickMessageFades();
    assert.deepEqual(texts(layer), ["old", "new"]);
    assert.ok(Math.abs(opacity(layer.children[0]) - 0.5) < 0.01, `the fading line began 6 s again: ${layer.children[0].style.opacity}`);
    assert.equal(opacity(layer.children[1]), 1, "the shown line still has 7 s");
    bridge.tick(3.1);
    renderer.tickMessageFades();
    assert.deepEqual(plain.messageFrame.messages.map((line) => line.text), ["new"], "faded out after 6 s");
    bridge.tick(4);
    bridge.tick(3);
    renderer.tickMessageFades();
    assert.ok(Math.abs(opacity(layer.children[0]) - 0.48) < 0.01, `its own fade is 6 s long: ${layer.children[0].style.opacity}`);
  } finally { close(); }
});

test("a 0 fade clears a line when its time is up, and is not lengthened later; 0 and 0 keep a line for good", () => {
  // 0x00968a60: "shown" past 0 with no "fading" clears the line; with both at 0 the update passes it
  // by. 0x00967e00 leaves a 0 "fading" alone, 0x00967db0 a 0 "shown".
  const { bridge, renderer, lua, close } = runtime();
  try {
    const plain = bridge.getFrame("Plain");
    const lines = () => plain.messageFrame.messages.map((line) => line.text);
    lua(`Plain:AddMessage("a"); Plain:SetFadeDuration(0)`);
    bridge.tick(9.9);
    assert.deepEqual(lines(), ["a"]);
    bridge.tick(0.2);
    assert.deepEqual(lines(), [], "no fade: cleared the moment its 10 s ran out");
    lua(`Plain:AddMessage("c"); Plain:SetFadeDuration(5)`);
    bridge.tick(9.9);
    assert.deepEqual(lines(), ["c"]);
    bridge.tick(0.2);
    assert.deepEqual(lines(), [], "added with a 0 fade, it keeps it: SetFadeDuration does not give it one");
    lua(`Plain:SetFadeDuration(0); Plain:AddMessage("b"); Plain:SetTimeVisible(0)`);
    for (let i = 0; i < 40; i += 1) bridge.tick(0.25);
    renderer.tickMessageFades();
    assert.deepEqual(lines(), ["b"], "0 shown and 0 fading: the line stays");
  } finally { close(); }
});

test("RemoveMessagesByAccessID ends at the bottom and shows the lines again, a call that removes nothing too", () => {
  // Review 03.10: Lua RemoveMessagesByAccessID (0x00973270) runs 0x0096a510, which compacts the history,
  // then scrolls to the newest line and gives the shown lines full alpha and fresh countdowns
  // (0x00969fa0, 0x00969410). Stock calls it when a whisper moves to its own tab (ChatFrame.lua:4514).
  const { vm, bridge, host, renderer, lua, close } = runtime();
  try {
    const chat = bridge.getFrame("Chat");
    lua(`Chat:AddMessage("a", 1, 1, 1, nil, false, 1); Chat:AddMessage("b", 1, 1, 1, nil, false, 2)
      Chat:AddMessage("c", 1, 1, 1, nil, false, 2)`);
    for (let i = 0; i < 500; i += 1) bridge.tick(0.25);
    renderer.tickMessageFades();
    const layer = layerOf(host, "Chat");
    const shown = () => layer.children.map((line) => line.style.visibility ?? "");
    assert.deepEqual(shown(), ["hidden", "hidden", "hidden"]);
    lua(`Chat:RemoveMessagesByAccessID(99)`);
    renderer.tickMessageFades();
    assert.deepEqual(shown(), ["", "", ""], "nothing removed, the lines are back");
    // The bridge's scroll is by line index: two steps up leave the bottom.
    lua(`Chat:ScrollUp(); Chat:ScrollUp(); Up = Chat:AtBottom() and 1 or 0
      Chat:RemoveMessagesByAccessID(1); Down = Chat:AtBottom() and 1 or 0`);
    assert.equal(vm.getGlobal("Up"), 0);
    assert.equal(vm.getGlobal("Down"), 1, "at the bottom after the call");
    assert.deepEqual(chat.messageFrame.messages.map((line) => line.text), ["b", "c"]);
    for (let i = 0; i < 500; i += 1) bridge.tick(0.25);
    renderer.tickMessageFades();
    assert.deepEqual(shown(), ["hidden", "hidden"], "at the bottom the lines count again");
  } finally { close(); }
});

test("the per-frame walk is skipped until a line can change, and stops once nothing can", () => {
  const { bridge, renderer, lua, close } = runtime();
  try {
    assert.equal(renderer.tickMessageFades(), 0, "no message lines: nothing walked");
    lua(`Errors:AddMessage("one")`);
    renderer.tickMessageFades();
    bridge.tick(1);
    assert.equal(renderer.tickMessageFades(), 0, "shown and 4 s before fading: not walked");
    bridge.tick(4.5);
    assert.equal(renderer.tickMessageFades(), 1, "fading: walked");
    bridge.tick(0.5);
    assert.equal(renderer.tickMessageFades(), 1);
    bridge.tick(3);
    renderer.tickMessageFades();
    assert.equal(renderer.tickMessageFades(), 0, "cleared: no longer tracked");
  } finally { close(); }
});
