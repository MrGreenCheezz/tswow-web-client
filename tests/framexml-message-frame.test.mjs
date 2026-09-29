import assert from "node:assert/strict";
import test from "node:test";

// A dependency-free DOM seam that exposes the private message layer and input
// event path without needing a browser. It intentionally records replacement
// calls so an unchanged bridge revision can be shown not to rebuild the tree.
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
      value: "",
      disabled: false,
      textContent: "",
      scrollTop: 0,
      replaceChildrenCalls: 0,
      className: "",
      classList: {
        add(...names) {
          node.className = [...new Set([...node.className.split(" ").filter(Boolean), ...names])].join(" ");
        },
      },
      addEventListener(name, listener) {
        const current = listeners.get(name) ?? [];
        current.push(listener);
        listeners.set(name, current);
      },
      dispatchEvent(event) {
        for (const listener of listeners.get(event.type) ?? []) listener(event);
      },
      focus() { doc.activeElement = node; },
      blur() { if (doc.activeElement === node) doc.activeElement = undefined; },
      setSelectionRange(start, end) { node.selectionStart = start; node.selectionEnd = end; },
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

function runtime() {
  const vm = new GlueLuaVm();
  const bridge = new FrameXmlUiBridge();
  const binder = new GlueWidgetBinder(vm, bridge);
  bridge.setRuntime(binder);
  const loaded = bridge.loadAddon(String.raw`<Ui>
    <Font name="ChatFontNormal" font="Fonts\\FRIZQT__.TTF" justifyH="LEFT">
      <FontHeight><AbsValue val="14"/></FontHeight>
    </Font>
    <ScrollingMessageFrame name="ChatFrame" maxLines="2" displayDuration="120" width="320" height="64">
      <FontString inherits="ChatFontNormal" justifyH="LEFT" indented="true" nonspacewrap="true"/>
      <Fontstring name="Authored" text="owned child"/>
    </ScrollingMessageFrame>
    <EditBox name="ChatEdit" historyLines="2"><Scripts>
      <OnEnterPressed>EnterCount = (EnterCount or 0) + 1</OnEnterPressed>
      <OnEscapePressed>EscapeCount = (EscapeCount or 0) + 1</OnEscapePressed>
      <OnSpacePressed>SpaceCount = (SpaceCount or 0) + 1</OnSpacePressed>
    </Scripts></EditBox>
    <Frame name="UIParent" width="300" height="100"><Frame name="Bounds" width="100" height="20"><Anchors>
      <Anchor point="TOPLEFT"><Offset x="7" y="-9"/></Anchor>
    </Anchors></Frame></Frame>
  </Ui>`);
  assert.equal(loaded.ok, true, loaded.diagnostics.map((entry) => entry.message).join("\n"));
  bridge.registerFontObjects();
  return { vm, bridge, loaded };
}

test("original chat hyperlink markup renders text and dispatches Lua link events", () => {
  const { vm, bridge, loaded } = runtime();
  const host = document.createElement("section");
  const renderer = new FrameXmlDomRenderer(host, { bridge });
  try {
    assert.equal(vm.execute(String.raw`
      ChatFrame:SetScript("OnHyperlinkClick", function(self, link, text, button)
        ClickLink, ClickText, ClickButton = link, text, button
      end)
      ChatFrame:SetScript("OnHyperlinkEnter", function(self, link) HoverLink = link end)
      ChatFrame:AddMessage("От |Hplayer:Игрок:1:SAY|h|cff00ff00[Игрок]|r|h: привет")
    `, "@chat-links").ok, true);
    renderer.mount(loaded.roots);
    const layer = find(host, "ChatFrame").children.find(child => child.getAttribute("data-framexml-message-layer") === "true");
    const spans = layer.children[0].children;
    assert.equal(spans.map(span => span.textContent).join(""), "От [Игрок]: привет");
    const link = spans.find(span => span.getAttribute("role") === "link");
    assert.equal(link.style.color, "#00ff00ff");
    assert.equal(link.style.pointerEvents, "auto", "links must escape their transparent message layer");
    link.dispatchEvent({ type: "mouseenter" });
    assert.equal(vm.getGlobal("HoverLink"), "player:Игрок:1:SAY");
    link.dispatchEvent({ type: "click" });
    assert.equal(vm.getGlobal("ClickLink"), "player:Игрок:1:SAY");
    assert.equal(vm.getGlobal("ClickButton"), "LeftButton");
    link.dispatchEvent({ type: "contextmenu" });
    assert.equal(vm.getGlobal("ClickButton"), "RightButton");
    link.dispatchEvent({ type: "keydown", key: "Enter" });
    assert.equal(vm.getGlobal("ClickButton"), "LeftButton");
  } finally { renderer.destroy(); vm.close(); }
});

test("bounded ScrollingMessageFrame owns lines, scroll state, attrs and color", () => {
  const { vm, bridge, loaded } = runtime();
  const result = vm.execute(String.raw`
    ChatFrame:AddMessage("one", 1, 0, 0, 7, false, "access-a", "extra")
    ChatFrame:AddMessage("two", 0, 1, 0, 8, false, "access-b")
    ChatFrame:AddMessage("three", 0, 0, 1, 9, false, "access-b")
    MessageCount = ChatFrame:GetNumMessages()
    AccessCount = ChatFrame:GetNumMessages("access-b")
    Text, Access, Line, Extra = ChatFrame:GetMessageInfo(1)
    AtBottomBefore = ChatFrame:AtBottom()
    ChatFrame:ScrollUp()
    Scrolled = ChatFrame:GetVerticalScroll()
    ScrollRange = ChatFrame:GetVerticalScrollRange()
    AtBottomAfter = ChatFrame:AtBottom()
    ChatFrame:SetMaxLines(3)
    ChatFrame:SetTimeVisible(42)
    MaxLines = ChatFrame:GetMaxLines()
    Duration = ChatFrame:GetTimeVisible()
  `, "@message-frame");
  assert.equal(result.ok, true, result.error ?? "message-frame methods failed");
  const chat = bridge.getFrame("ChatFrame");
  assert.ok(chat);
  assert.equal(chat.type, "ScrollingMessageFrame");
  assert.equal(vm.getGlobal("MessageCount"), 2, "maxLines trims the oldest message");
  assert.equal(vm.getGlobal("AccessCount"), 2);
  assert.equal(vm.getGlobal("Text"), "two");
  assert.equal(vm.getGlobal("Access"), "access-b");
  assert.equal(vm.getGlobal("Line"), 8);
  assert.equal(vm.getGlobal("Extra"), undefined);
  assert.equal(vm.getGlobal("AtBottomBefore"), true);
  assert.equal(vm.getGlobal("Scrolled"), 0);
  assert.equal(vm.getGlobal("ScrollRange"), 1);
  assert.equal(vm.getGlobal("AtBottomAfter"), false);
  assert.equal(vm.getGlobal("MaxLines"), 3);
  assert.equal(vm.getGlobal("Duration"), 42);
  assert.deepEqual(chat.messageFrame.messages.map((message) => message.text), ["two", "three"]);

  const host = document.createElement("section");
  const renderer = new FrameXmlDomRenderer(host, { bridge });
  renderer.mount(loaded.roots);
  const element = find(host, "ChatFrame");
  const authored = find(host, "Authored");
  assert.ok(element && authored);
  const layer = element.children.find((child) => child.getAttribute("data-framexml-message-layer") === "true");
  assert.ok(layer);
  assert.equal(layer.children.length, 2);
  assert.equal(layer.children[0].textContent, "two");
  assert.equal(layer.children[0].style.color, "rgba(0, 255, 0, 1)");
  assert.equal(layer.children[1].textContent, "three");
  assert.equal(authored.textContent, "owned child");
  assert.equal(layer.getAttribute("data-framexml-max-lines"), "3");
  assert.equal(layer.getAttribute("data-framexml-display-duration"), "42");
  assert.equal(layer.getAttribute("data-framexml-font"), "ChatFontNormal");
  assert.equal(layer.style.fontSize, "14px");
  assert.equal(layer.style.textAlign, "left");
  assert.equal(layer.style.overflowWrap, "anywhere");
  assert.equal(layer.getAttribute("data-framexml-nonspacewrap"), "true");
  assert.equal(layer.getAttribute("data-framexml-scroll"), "0");

  const rebuilds = layer.replaceChildrenCalls;
  renderer.sync();
  assert.equal(layer.replaceChildrenCalls, rebuilds, "unchanged bridge revision skips renderer walk");

  vm.execute("ChatFrame:ScrollToBottom(); ChatFrame:AddMessage('four', 1, .5, 0)", "@message-frame-update");
  assert.equal(layer.children.length, 3);
  assert.equal(layer.children[2].textContent, "four");
  assert.equal(layer.getAttribute("data-framexml-scroll"), "2");
  // The layer's real pixel range is owned by browser layout, not by the logical
  // line offset kept in the bridge.
  layer.scrollHeight = 100;
  layer.clientHeight = 20;
  bridge.SetVerticalScroll(chat, chat.scroll.verticalScroll - 1);
  assert.equal(layer.scrollTop, 40);
  bridge.ScrollToBottom(chat);
  assert.equal(layer.scrollTop, 80);

  vm.execute("ChatFrame:RemoveMessagesByAccessID('access-b')", "@message-frame-remove");
  assert.equal(layer.children.length, 1);
  vm.execute("ChatFrame:Clear()", "@message-frame-clear");
  assert.equal(layer.children.length, 0);
  renderer.destroy();
  vm.close();
});

test("hidden message mutations defer private DOM work until one reveal", () => {
  const { bridge, loaded } = runtime();
  const chat = bridge.getFrame("ChatFrame");
  assert.ok(chat);
  const host = document.createElement("section");
  const renderer = new FrameXmlDomRenderer(host, { bridge });
  renderer.mount(loaded.roots);
  const element = find(host, "ChatFrame");
  assert.ok(element);
  const layer = element.children.find((child) => child.getAttribute("data-framexml-message-layer") === "true");
  assert.ok(layer);
  bridge.Hide(chat);
  const baseline = layer.replaceChildrenCalls;
  bridge.AddMessage(chat, "hidden-one", 1, 0, 0, 1, false, "hidden");
  bridge.AddMessage(chat, "hidden-two", 0, 1, 0, 2, false, "hidden");
  assert.equal(layer.replaceChildrenCalls, baseline, "hidden updates do not rebuild lines");
  assert.equal(layer.children.length, 0);
  bridge.Show(chat);
  assert.equal(layer.replaceChildrenCalls, baseline + 1, "reveal paints latest history once");
  assert.deepEqual(layer.children.map((line) => line.textContent), ["hidden-one", "hidden-two"]);
  renderer.sync();
  assert.equal(layer.replaceChildrenCalls, baseline + 1, "unchanged revealed state stays stable");
  renderer.destroy();
});

test("message scroll maps top, intermediate and bottom offsets to pixel range", () => {
  const { bridge, loaded } = runtime();
  const chat = bridge.getFrame("ChatFrame");
  assert.ok(chat);
  bridge.SetMaxLines(chat, 4);
  bridge.AddMessage(chat, "one");
  bridge.AddMessage(chat, "two");
  bridge.AddMessage(chat, "three");
  const host = document.createElement("section");
  const renderer = new FrameXmlDomRenderer(host, { bridge });
  renderer.mount(loaded.roots);
  const element = find(host, "ChatFrame");
  assert.ok(element);
  const layer = element.children.find((child) => child.getAttribute("data-framexml-message-layer") === "true");
  assert.ok(layer);
  assert.equal(layer.style.overflowX, "hidden", "chat clips long lines without a browser scrollbar");
  assert.equal(layer.style.overflowY, "hidden", "stock chat owns scrolling; the browser adds no scrollbar");
  layer.scrollHeight = 120;
  layer.clientHeight = 20;
  assert.equal(chat.scroll.verticalScrollRange, 2);
  bridge.SetVerticalScroll(chat, 0);
  assert.equal(layer.scrollTop, 0, "top is zero");
  bridge.SetVerticalScroll(chat, 1);
  assert.equal(layer.scrollTop, 50, "middle line is halfway through pixel range");
  bridge.ScrollToBottom(chat);
  assert.equal(layer.scrollTop, 100, "bottom reaches scrollHeight-clientHeight");
  renderer.destroy();
});

test("EditBox preserves caret/history and dispatches stock chat keys", () => {
  const { vm, bridge, loaded } = runtime();
  const edit = bridge.getFrame("ChatEdit");
  assert.ok(edit);
  const result = vm.execute(String.raw`
    ChatEdit:AddHistoryLine("first")
    ChatEdit:AddHistoryLine("second")
    ChatEdit:SetText("abc")
    ChatEdit:SetCursorPosition(1)
    ChatEdit:Insert("X")
    Cursor = ChatEdit:GetUTF8CursorPosition()
    Value = ChatEdit:GetText()
  `, "@editbox-methods");
  assert.equal(result.ok, true, result.error ?? "editbox methods failed");
  assert.equal(vm.getGlobal("Value"), "aXbc");
  assert.equal(vm.getGlobal("Cursor"), 2);
  assert.deepEqual(edit.editBox.history, ["first", "second"]);

  const host = document.createElement("section");
  const renderer = new FrameXmlDomRenderer(host, { bridge });
  renderer.mount(loaded.roots);
  const input = find(host, "ChatEdit").children.find((child) => child.getAttribute("data-framexml-input") === "true");
  assert.ok(input);
  input.dispatchEvent({ type: "keydown", key: "ArrowUp", preventDefault() { this.prevented = true; } });
  assert.equal(edit.text, "second");
  input.dispatchEvent({ type: "keydown", key: "ArrowDown", preventDefault() {} });
  assert.equal(edit.text, "");
  input.dispatchEvent({ type: "keydown", key: "Enter" });
  input.dispatchEvent({ type: "keydown", key: "Escape" });
  input.dispatchEvent({ type: "keydown", key: " " });
  assert.equal(vm.getGlobal("EnterCount"), 1);
  assert.equal(vm.getGlobal("EscapeCount"), 1);
  assert.equal(vm.getGlobal("SpaceCount"), 1);
  renderer.destroy();
  vm.close();
});

test("EditBox preserves browser selection across unrelated syncs and honors explicit caret requests", () => {
  const { vm, bridge, loaded } = runtime();
  const edit = bridge.getFrame("ChatEdit");
  const renderer = new FrameXmlDomRenderer(document.createElement("section"), { bridge });
  try {
    renderer.mount(loaded.roots);
    const input = renderer.elementFor(edit).children.find(child => child.getAttribute("data-framexml-input") === "true");
    input.focus();
    input.dispatchEvent({ type: "focus" });
    bridge.SetText(edit, "Тест");
    input.setSelectionRange(0, 4); // Ctrl+A changes selection without an input event.
    bridge.SetText(bridge.getFrame("Authored"), "animation tick");
    assert.deepEqual([input.selectionStart, input.selectionEnd], [0, 4]);
    bridge.SetCursorPosition(edit, 4);
    assert.deepEqual([input.selectionStart, input.selectionEnd], [4, 4]);
    input.setSelectionRange(1, 3);
    input.dispatchEvent({ type: "select" });
    bridge.SetText(bridge.getFrame("Authored"), "another tick");
    assert.deepEqual([input.selectionStart, input.selectionEnd], [1, 3]);
    vm.execute("ChatEdit:HighlightText(0, 4)", "@highlight");
    assert.deepEqual([input.selectionStart, input.selectionEnd], [0, 4]);
    input.value = "Новое";
    input.setSelectionRange(5, 5);
    input.dispatchEvent({ type: "input" });
    assert.equal(edit.text, "Новое");
    bridge.SetText(bridge.getFrame("Authored"), "final tick");
    assert.deepEqual([input.selectionStart, input.selectionEnd], [5, 5]);
  } finally { renderer.destroy(); vm.close(); }
});

test("stock chat geometry methods and lowercase widget names stay bounded", () => {
  const { vm, bridge } = runtime();
  const result = vm.execute(String.raw`
    Left = Bounds:GetLeft()
    Right = Bounds:GetRight()
    Top = Bounds:GetTop()
    Bottom = Bounds:GetBottom()
  `, "@message-frame-geometry");
  assert.equal(result.ok, true, result.error ?? "geometry methods failed");
  assert.equal(vm.getGlobal("Left"), 7);
  assert.equal(vm.getGlobal("Right"), 107);
  assert.equal(vm.getGlobal("Top"), 91);
  assert.equal(vm.getGlobal("Bottom"), 71);
  assert.equal(bridge.getFrame("Authored")?.type, "FontString");
  vm.close();
});
