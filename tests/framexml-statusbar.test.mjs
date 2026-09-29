import assert from "node:assert/strict";
import test from "node:test";

function fakeDocument() {
  const doc = { createElement: (tag) => make(tag) };
  const camel = (name) => name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
  function make(tag) {
    const attributes = new Map();
    const listeners = new Map();
    const style = {
      setProperty(name, value) { this[camel(name)] = String(value); },
      removeProperty(name) { delete this[camel(name)]; },
    };
    const node = {
      ownerDocument: doc,
      tagName: tag.toUpperCase(),
      children: [],
      parentElement: undefined,
      style,
      hidden: false,
      className: "",
      textContent: "",
      offsetWidth: 0,
      offsetHeight: 0,
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
      setAttribute(name, value) { attributes.set(name, String(value)); },
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
  doc.head = make("head");
  return doc;
}

globalThis.document = fakeDocument();
const { FrameXmlUiBridge } = await import("../dist/code/browser/ui/framexml_compat/FrameXmlRuntime.js");
const { FrameXmlDomRenderer } = await import("../dist/code/browser/ui/framexml_compat/FrameXmlDomRenderer.js");
const { GlueLuaVm } = await import("../dist/code/browser/glue/GlueLua.js");
const { GlueWidgetBinder } = await import("../dist/code/browser/glue/GlueWidgets.js");

const BAR_XML = String.raw`<Ui>
  <StatusBar name="CastBar" minValue="-2" maxValue="8" defaultValue="3" orientation="HORIZONTAL" width="200" height="12">
    <BarTexture file="Interface\TargetingFrame\UI-StatusBar"/>
    <BarColor r="0.2" g="0.4" b="0.6" a="0.8"/>
    <Texture name="AuthoredRegion" file=""/>
  </StatusBar>
  <StatusBar name="DefaultBar"/>
</Ui>`;

function find(root, name) {
  if (root.getAttribute("data-framexml-name") === name) return root;
  for (const child of root.children) {
    const found = find(child, name);
    if (found) return found;
  }
  return undefined;
}

test("StatusBar XML owns independent scalar, texture, and color state", () => {
  const bridge = new FrameXmlUiBridge();
  const loaded = bridge.loadAddon(BAR_XML);
  assert.equal(loaded.ok, true);
  const bar = bridge.getFrame("CastBar");
  const defaults = bridge.getFrame("DefaultBar");
  assert.ok(bar && defaults);
  assert.deepEqual(bar.statusBar, {
    min: -2,
    max: 8,
    value: 3,
    valueStep: 0,
    orientation: "HORIZONTAL",
    texture: String.raw`Interface\TargetingFrame\UI-StatusBar`,
    color: { r: 0.2, g: 0.4, b: 0.6, a: 0.8 },
  });
  assert.deepEqual(defaults.statusBar, {
    min: 0,
    max: 0,
    value: 0,
    valueStep: 0,
    orientation: "HORIZONTAL",
    texture: "",
    color: { r: 1, g: 1, b: 1, a: 1 },
  });
  assert.equal(bar.children.length, 1, "authored regions remain frame children, not fill state");
});

test("StatusBar Lua methods mutate the dedicated state and return its path", () => {
  const vm = new GlueLuaVm();
  const bridge = new FrameXmlUiBridge();
  const binder = new GlueWidgetBinder(vm, bridge);
  bridge.setRuntime(binder);
  const loaded = bridge.loadAddon(String.raw`<Ui><StatusBar name="CastBar"/></Ui>`);
  assert.equal(loaded.ok, true);

  const outcome = vm.execute(String.raw`
    CastBar:SetMinMaxValues(10, 20)
    CastBar:SetValue(15)
    Min, Max = CastBar:GetMinMaxValues()
    Value = CastBar:GetValue()
    CastBar:SetStatusBarTexture("Interface/StatusBar/Updated")
    Texture = CastBar:GetStatusBarTexture()
    CastBar:SetStatusBarColor(0.1, 0.3, 0.5, 0.7)
  `, "@statusbar-methods");
  assert.equal(outcome.ok, true, outcome.error ?? "statusbar Lua methods failed");
  const bar = bridge.getFrame("CastBar");
  assert.ok(bar);
  assert.equal(vm.getGlobal("Min"), 10);
  assert.equal(vm.getGlobal("Max"), 20);
  assert.equal(vm.getGlobal("Value"), 15);
  assert.equal(vm.getGlobal("Texture"), "Interface/StatusBar/Updated");
  assert.deepEqual(bar.statusBar.color, { r: 0.1, g: 0.3, b: 0.5, a: 0.7 });
  assert.deepEqual(bar.statusBar, {
    min: 10,
    max: 20,
    value: 15,
    valueStep: 0,
    orientation: "HORIZONTAL",
    texture: "Interface/StatusBar/Updated",
    color: { r: 0.1, g: 0.3, b: 0.5, a: 0.7 },
  });
  vm.close();
});

test("StatusBar DOM has one fill behind authored children and clamps its value", () => {
  const bridge = new FrameXmlUiBridge();
  const loaded = bridge.loadAddon(BAR_XML);
  const bar = bridge.getFrame("CastBar");
  assert.ok(loaded.ok && bar);

  const acquired = [];
  const released = [];
  const textureSource = {
    acquire(path) { acquired.push(path); return `blob:${path}`; },
    peek(path) { return `blob:${path}`; },
    release(path) { released.push(path); },
    acquireEdge() { return undefined; },
    peekEdge() { return undefined; },
    releaseEdge() {},
  };
  const host = document.createElement("section");
  const renderer = new FrameXmlDomRenderer(host, { bridge, textures: textureSource });
  renderer.mount(loaded.roots);

  const element = find(host, "CastBar");
  assert.ok(element);
  const fills = element.children.filter((child) => child.getAttribute("data-framexml-statusbar-fill") === "true");
  assert.equal(fills.length, 1);
  const fill = fills[0];
  assert.equal(element.children[0], fill, "fill precedes authored regions");
  assert.equal(element.children[1].getAttribute("data-framexml-name"), "AuthoredRegion");
  assert.equal(fill.style.width, "50%");
  assert.equal(fill.style.backgroundColor, "rgba(51, 102, 153, 0.8)");
  assert.equal(fill.style.backgroundImage, 'url("blob:Interface\\TargetingFrame\\UI-StatusBar.blp")');
  assert.equal(fill.style.backgroundBlendMode, "multiply", "bitmap does not hide SetStatusBarColor");
  assert.equal(fill.getAttribute("data-framexml-statusbar-texture"), String.raw`Interface\TargetingFrame\UI-StatusBar`);
  assert.deepEqual(acquired, [String.raw`Interface\TargetingFrame\UI-StatusBar.blp`]);

  bridge.update(bar, (mutable) => { mutable.statusBar.value = 2; });
  assert.equal(fill.style.width, "40%", "decreasing value decreases the fill naturally");
  bridge.update(bar, (mutable) => { mutable.statusBar.value = 999; });
  assert.equal(fill.style.width, "100%");
  bridge.update(bar, (mutable) => { mutable.statusBar.value = -999; });
  assert.equal(fill.style.width, "0%");

  bridge.update(bar, (mutable) => {
    mutable.statusBar.min = 4;
    mutable.statusBar.max = 4;
    mutable.statusBar.value = 4;
  });
  assert.equal(fill.style.width, "0%", "a zero range has no drawable fraction");
  bridge.update(bar, (mutable) => {
    mutable.statusBar.min = Number.NaN;
    mutable.statusBar.max = 8;
    mutable.statusBar.value = 3;
  });
  assert.equal(fill.style.width, "0%", "an invalid range is safe and empty");

  bridge.update(bar, (mutable) => {
    mutable.statusBar.color = { r: 1, g: 0, b: 0, a: 0.5 };
  });
  assert.equal(fill.style.backgroundColor, "rgba(255, 0, 0, 0.5)", "color updates reach the fill");
  bridge.update(bar, (mutable) => { mutable.statusBar.texture = "Interface/StatusBar/Other"; });
  assert.equal(fill.style.backgroundImage, 'url("blob:Interface\\StatusBar\\Other.blp")');
  assert.deepEqual(released, [String.raw`Interface\TargetingFrame\UI-StatusBar.blp`]);
  assert.deepEqual(acquired, [
    String.raw`Interface\TargetingFrame\UI-StatusBar.blp`,
    String.raw`Interface\StatusBar\Other.blp`,
  ]);
  renderer.destroy();
  assert.deepEqual(released, [
    String.raw`Interface\TargetingFrame\UI-StatusBar.blp`,
    String.raw`Interface\StatusBar\Other.blp`,
  ], "destroy releases the active StatusBar texture lease");
});
