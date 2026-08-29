import assert from "node:assert/strict";
import test from "node:test";

// Deliberately tiny DOM seam: this keeps the vertical slice dependency-free
// while making every DOM operation used by the renderer explicit.
function fakeDocument() {
  const doc = { createElement: (tag) => make(tag) };
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
      attributes,
      writes: { src: 0 },
      style,
      dataset: {},
      hidden: false,
      className: "",
      src: "",
      textContent: "",
      classList: {
        add(...names) { node.className = [...new Set([...node.className.split(" ").filter(Boolean), ...names])].join(" "); },
      },
      addEventListener(name, listener) {
        const current = listeners.get(name) ?? [];
        current.push(listener);
        listeners.set(name, current);
      },
      dispatchEvent(event) {
        for (const listener of listeners.get(event.type) ?? []) listener(event);
      },
      setAttribute(name, value) {
        if (name === "src") node.writes.src++;
        attributes.set(name, String(value));
      },
      getAttribute(name) { return attributes.get(name) ?? null; },
      removeAttribute(name) { attributes.delete(name); },
      append(...children) {
        for (const child of children) {
          child.parentElement = node;
          node.children.push(child);
        }
      },
      remove() {
        const index = node.parentElement?.children.indexOf(node) ?? -1;
        if (index >= 0) node.parentElement.children.splice(index, 1);
        node.parentElement = undefined;
      },
    };
    return node;
  }
  return doc;
}

globalThis.document = fakeDocument();
const { FrameXmlUiBridge } = await import("../dist/code/browser/ui/framexml_compat/FrameXmlRuntime.js");
const { FrameXmlDomRenderer } = await import("../dist/code/browser/ui/framexml_compat/FrameXmlDomRenderer.js");

function find(root, name) {
  if (root.getAttribute("data-framexml-name") === name) return root;
  for (const child of root.children) {
    const result = find(child, name);
    if (result) return result;
  }
  return undefined;
}

test("FrameXML DOM renderer mounts the supported subset and binds bridge mutations", () => {
  const bridge = new FrameXmlUiBridge();
  const host = document.createElement("section");
  const marker = document.createElement("i");
  host.append(marker);
  const renderer = new FrameXmlDomRenderer(host, {
    bridge,
    textureResolver: (texture) => `/assets/${texture.toLowerCase().replaceAll("\\", "/")}.png`,
  });
  const loaded = bridge.loadAddon(`<Ui><Frame name="Root" hidden="true" width="320" height="180">
    <Anchors><Anchor point="TOPLEFT"><Offset x="4" y="-2"/></Anchor></Anchors>
    <Button name="Cast" text="Каст"><FontString name="Label" text="Готово"/>
      <Texture name="Icon" file="Interface\\Icons\\Spell"/></Button>
  </Frame></Ui>`);
  assert.equal(loaded.ok, true);
  renderer.mount(loaded.roots);

  const root = find(host, "Root");
  const button = find(host, "Cast");
  const label = find(host, "Label");
  const icon = find(host, "Icon");
  assert.ok(root && button && label && icon);
  assert.equal(host.children[0], marker, "mount does not clear caller-owned DOM");
  assert.equal(root.hidden, true);
  assert.equal(root.style.width, "320px");
  assert.equal(root.style.height, "180px");
  assert.equal(root.style.left, "4px");
  assert.equal(root.style.top, "2px", "FrameXML positive Y points upward");
  assert.equal(button.children.find((child) => child.getAttribute("data-framexml-label") === "true").textContent, "Каст");
  assert.equal(label.textContent, "Готово");
  assert.equal(icon.getAttribute("data-framexml-texture"), "Interface\\Icons\\Spell");
  assert.equal(icon.getAttribute("src"), "/assets/interface/icons/spell.png");
  const sourceWrites = icon.writes.src;
  renderer.sync();
  assert.equal(icon.writes.src, sourceWrites, "stable trusted URL is not rewritten on an idempotent sync");

  // Renderer subscription makes the normal bridge mutation path observable
  // without handing the Lua adapter any DOM object.
  assert.equal(bridge.Show(bridge.getFrame("Root")), true);
  assert.equal(root.hidden, false);
  assert.equal(bridge.SetText(bridge.getFrame("Label"), "Обновлено"), true);
  assert.equal(label.textContent, "Обновлено");
  assert.equal(bridge.SetTexture(bridge.getFrame("Icon"), "Interface\\Icons\\New"), true);
  assert.equal(icon.getAttribute("src"), "/assets/interface/icons/new.png");

  const dynamic = bridge.CreateFrame("FontString", "Dynamic", bridge.getFrame("Root"));
  assert.ok(dynamic);
  assert.ok(find(host, "Dynamic"), "a frame created through the API is reconciled");
  renderer.destroy();
  assert.equal(host.children[0], marker);
  assert.equal(find(host, "Root"), undefined);
});

test("without a trusted texture resolver, addon texture values remain inert metadata", () => {
  const bridge = new FrameXmlUiBridge();
  const loaded = bridge.loadAddon(`<Ui><Frame name="Root"><Texture name="Icon" file="https://evil.invalid/pixel.png"/></Frame></Ui>`);
  const host = document.createElement("section");
  const renderer = new FrameXmlDomRenderer(host, { bridge });
  renderer.mount(loaded.roots);
  const icon = find(host, "Icon");
  assert.ok(icon);
  assert.equal(icon.getAttribute("data-framexml-texture"), "https://evil.invalid/pixel.png");
  assert.equal(icon.getAttribute("src"), null);
  bridge.SetTexture(bridge.getFrame("Icon"), "//evil.invalid/after.png");
  assert.equal(icon.getAttribute("src"), null);
});

test("renderer preserves relative anchor metadata while applying a bounded CSS position", () => {
  const bridge = new FrameXmlUiBridge();
  const loaded = bridge.loadAddon(`<Ui><Frame name="Root"><Frame name="Other"/>
    <Frame name="Child"><Anchors><Anchor point="BOTTOMRIGHT" relativeTo="Other" relativePoint="TOPLEFT"><Offset x="3" y="4"/></Anchor></Anchors></Frame>
  </Frame></Ui>`);
  const host = document.createElement("section");
  const renderer = new FrameXmlDomRenderer(host);
  renderer.mount(loaded.roots);
  const child = find(host, "Child");
  assert.ok(child);
  assert.equal(child.getAttribute("data-framexml-relative"), "Other");
  assert.equal(child.getAttribute("data-framexml-point"), "BOTTOMRIGHT:TOPLEFT:3:4");
  assert.equal(child.style.right, "-3px");
  assert.equal(child.style.bottom, "4px");
});

test("renderer resolves relative anchors when the host exposes layout rectangles", () => {
  const bridge = new FrameXmlUiBridge();
  const loaded = bridge.loadAddon(`<Ui><Frame name="Root" width="300" height="200">
    <Frame name="Other" width="100" height="20"/>
    <Frame name="Child" width="20" height="10"><Anchors><Anchor point="BOTTOMRIGHT" relativeTo="Other" relativePoint="TOPLEFT"><Offset x="3" y="4"/></Anchor></Anchors></Frame>
  </Frame></Ui>`);
  const host = document.createElement("section");
  const renderer = new FrameXmlDomRenderer(host);
  renderer.mount(loaded.roots);
  const root = find(host, "Root");
  const other = find(host, "Other");
  const child = find(host, "Child");
  assert.ok(root && other && child);
  root.getBoundingClientRect = () => ({ left: 0, top: 0, right: 300, bottom: 200, width: 300, height: 200 });
  other.getBoundingClientRect = () => ({ left: 10, top: 15, right: 110, bottom: 35, width: 100, height: 20 });
  child.getBoundingClientRect = () => ({ left: 0, top: 0, right: 20, bottom: 10, width: 20, height: 10 });
  renderer.sync();
  assert.equal(child.style.left, "-7px", "right edge is aligned to Other's top-left plus X");
  assert.equal(child.style.top, "1px", "bottom edge is aligned with FrameXML's upward Y offset");
  assert.equal(child.style.transform, "");
});

test("button clicks travel from the DOM through the bounded bridge to the Lua adapter", () => {
  const calls = [];
  const bridge = new FrameXmlUiBridge(undefined, {
    runtime: {
      name: "test-sandbox",
      luaVersion: "5.1-compatible adapter",
      execute(source, context) {
        calls.push({
          source,
          frame: context.frame.name,
          args: [...context.args],
          hasDocument: "document" in context,
          hasWindow: "window" in context,
        });
        context.ui.SetText(context.frame, context.args.join(":"));
      },
    },
  });
  const loaded = bridge.loadAddon(`<Ui><Button name="Action"><Scripts>
    <OnClick>button-handler</OnClick>
  </Scripts></Button></Ui>`);
  assert.equal(loaded.ok, true);
  const host = document.createElement("section");
  const renderer = new FrameXmlDomRenderer(host, { bridge });
  renderer.mount(loaded.roots);

  const button = find(host, "Action");
  assert.ok(button);
  button.dispatchEvent({ type: "click", button: 0 });
  assert.deepEqual(calls, [{
    source: "button-handler",
    frame: "Action",
    args: ["LeftButton", false],
    hasDocument: false,
    hasWindow: false,
  }]);
  assert.equal(bridge.getFrame("Action")?.text, "LeftButton:false");
  renderer.destroy();
});

test("pointer and mouse hover events dispatch OnEnter/OnLeave without leaking DOM objects", () => {
  const calls = [];
  const bridge = new FrameXmlUiBridge(undefined, {
    runtime: {
      name: "test-sandbox",
      luaVersion: "5.1-compatible adapter",
      execute(source, context) {
        calls.push({
          source,
          frame: context.frame.name,
          args: [...context.args],
          hasDocument: "document" in context,
          hasWindow: "window" in context,
        });
      },
    },
  });
  const loaded = bridge.loadAddon(`<Ui><Button name="Hover"><Scripts>
    <OnEnter>enter-handler</OnEnter>
    <OnLeave>leave-handler</OnLeave>
  </Scripts></Button></Ui>`);
  assert.equal(loaded.ok, true);
  const host = document.createElement("section");
  const renderer = new FrameXmlDomRenderer(host, { bridge });
  renderer.mount(loaded.roots);

  const button = find(host, "Hover");
  assert.ok(button);
  button.dispatchEvent({ type: "pointerenter" });
  // Browsers can emit mouseenter after pointerenter for a mouse. The bridge
  // must expose one logical OnEnter transition, not duplicate the addon call.
  button.dispatchEvent({ type: "mouseenter" });
  button.dispatchEvent({ type: "pointerleave" });
  button.dispatchEvent({ type: "mouseleave" });
  assert.deepEqual(calls, [
    {
      source: "enter-handler",
      frame: "Hover",
      args: [],
      hasDocument: false,
      hasWindow: false,
    },
    {
      source: "leave-handler",
      frame: "Hover",
      args: [],
      hasDocument: false,
      hasWindow: false,
    },
  ]);
  renderer.destroy();
});
