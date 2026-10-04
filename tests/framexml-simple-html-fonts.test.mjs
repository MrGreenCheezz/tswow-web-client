import assert from "node:assert/strict";
import test from "node:test";

// WORK_PLAN 3.35 leftovers (03.10, L5): SimpleHTML's per-element font methods (Wow.exe 0x009748f0) and
// line spacing / <BR/> drawn as GetBoundsRect measures them. The same DOM seam as framexml-simple-html.
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
      hasAttribute(name) { return attributes.has(name); },
      attributeNames() { return [...attributes.keys()]; },
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
    // A real element's innerHTML setter would parse markup; the renderer must never reach for it.
    Object.defineProperty(node, "innerHTML", { set() { throw new Error("innerHTML written"); }, get() { return ""; } });
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
const { parseFrameXmlSimpleHtml } = await import("../dist/code/browser/ui/framexml_compat/FrameXmlSimpleHtml.js");
const { frameXmlSimpleHtmlExtent } = await import("../dist/code/browser/ui/framexml_compat/FrameXmlSimpleHtmlBounds.js");

function runtime() {
  const vm = new GlueLuaVm();
  const bridge = new FrameXmlUiBridge();
  const binder = new GlueWidgetBinder(vm, bridge);
  bridge.setRuntime(binder);
  const loaded = bridge.loadAddon(String.raw`<Ui>
    <Font name="PageFont" font="Fonts\\FRIZQT__.TTF" justifyH="CENTER"><FontHeight><AbsValue val="12"/></FontHeight></Font>
    <Font name="HeaderFont" font="Fonts\\MORPHEUS.TTF"><FontHeight><AbsValue val="18"/></FontHeight>
      <Color r="1" g="0.82" b="0"/></Font>
    <SimpleHTML name="Page" width="300" height="100">
      <FontString inherits="PageFont" spacing="2"/>
      <FontStringHeader1 inherits="HeaderFont"/>
    </SimpleHTML>
  </Ui>`);
  assert.equal(loaded.ok, true, loaded.diagnostics.map((entry) => entry.message).join("\n"));
  bridge.registerFontObjects();
  const host = document.createElement("section");
  const renderer = new FrameXmlDomRenderer(host, { bridge });
  renderer.mount(loaded.roots);
  const lua = (code) => {
    const result = vm.execute(code, "@simple-html-fonts");
    assert.equal(result.ok, true, result.error);
  };
  const layer = () => find(host, "Page")?.children.find((child) => child.getAttribute("data-framexml-html-layer") === "true");
  return { vm, bridge, lua, layer, close() { renderer.destroy(); vm.close(); } };
}

function find(root, name) {
  if (root.getAttribute("data-framexml-name") === name) return root;
  for (const child of root.children) {
    const result = find(child, name);
    if (result) return result;
  }
  return undefined;
}

const globals = (vm, ...names) => names.map((name) => vm.getGlobal(name));

test("the font methods take an element first — P, H1, H2, H3, any case — as Wow.exe's SimpleHTML does (0x009748f0)", () => {
  const { vm, lua, close } = runtime();
  try {
    lua(`
      Page:SetFont("h2", "Fonts\\\\MORPHEUS.TTF", 22, "OUTLINE")
      A1, A2, A3 = Page:GetFont("H2")
      Page:SetTextColor("h2", 1, 0, 0)
      B1, B2, B3, B4 = Page:GetTextColor("h2")
      PAGE1, PAGE2, PAGE3 = Page:GetTextColor()
      Page:SetSpacing("h3", 4)
      C, CP = Page:GetSpacing("h3"), Page:GetSpacing()
      Page:SetJustifyH("p", "RIGHT")
      D = Page:GetJustifyH()
      Page:SetJustifyV("h1", "TOP")
      E, EP = Page:GetJustifyV("h1"), Page:GetJustifyV("P")
      Page:SetShadowOffset("H1", 2, -2)
      F1, F2 = Page:GetShadowOffset("h1")
      Page:SetShadowColor("h1", 0, 0, 1, 0.5)
      G1, G2, G3, G4 = Page:GetShadowColor("h1")
      H1, H1N = Page:GetFont("h3"), select("#", Page:GetFont("h3"))
      -- A first string that names no element is the page's own call, argument and all.
      Page:SetFont("Fonts\\\\FRIZQT__.TTF", 13)
      I1, I2 = Page:GetFont()
    `);
    assert.deepEqual(globals(vm, "A1", "A2", "A3"), ["Fonts\\MORPHEUS.TTF", 22, "OUTLINE"]);
    assert.deepEqual(globals(vm, "B1", "B2", "B3", "B4"), [1, 0, 0, 1]);
    assert.deepEqual(globals(vm, "PAGE1", "PAGE2", "PAGE3"), [1, 1, 1], "the page's colour is its own");
    assert.deepEqual(globals(vm, "C", "CP"), [4, 2]);
    assert.equal(vm.getGlobal("D"), "RIGHT", "\"p\" is the page's font");
    assert.deepEqual(globals(vm, "E", "EP"), ["TOP", "MIDDLE"], "H1's own; P's is the page's");
    assert.deepEqual(globals(vm, "F1", "F2"), [2, -2]);
    assert.deepEqual(globals(vm, "G1", "G2", "G3", "G4"), [0, 0, 1, 0.5]);
    assert.deepEqual(globals(vm, "H1", "H1N"), [undefined, 0], "a header with no font of its own has none to tell");
    assert.deepEqual(globals(vm, "I1", "I2"), ["Fonts\\FRIZQT__.TTF", 13]);
  } finally { close(); }
});

test("a header block is drawn in its own font with its own colour and shadow; without a font, in the page's", () => {
  const { lua, layer, close } = runtime();
  try {
    lua(`
      Page:SetFont("h2", "Fonts\\\\MORPHEUS.TTF", 22)
      Page:SetTextColor("h2", 1, 0, 0)
      Page:SetTextColor("h3", 0, 1, 0)
      Page:SetTextColor("h1", 0, 0, 1)
      Page:SetText("<html><body><h1>a</h1><h2>b</h2><h3>c</h3></body></html>")
    `);
    const [h1, h2, h3] = layer().children;
    assert.equal(h1.style.fontSize, "18px", "H1's font object");
    assert.equal(h1.style.color, "rgba(0, 0, 255, 1)", "its own colour over the font object's");
    assert.equal(h2.style.fontSize, "22px", "SetFont gave H2 a font of its own");
    assert.equal(h2.style.color, "rgba(255, 0, 0, 1)");
    assert.equal(h3.style.fontSize ?? "", "", "no font of its own: the page's (0x0096cc90), colour and all");
    assert.equal(h3.style.color ?? "", "");
    // A change of a header's font draws the page again.
    lua(`Page:SetFont("h3", "Fonts\\\\MORPHEUS.TTF", 16)`);
    assert.equal(layer().children[2].style.fontSize, "16px");
  } finally { close(); }
});

test("GetBoundsRect measures a header in the font SetFont gave it", () => {
  const { vm, lua, close } = runtime();
  try {
    lua(`
      Page:SetHeight(4)
      Page:SetText("<html><body><h1>a</h1><h2>b</h2></body></html>")
      local _, _, _, height = Page:GetBoundsRect()
      BEFORE = height
      Page:SetFont("h1", "Fonts\\\\MORPHEUS.TTF", 30)
      Page:SetFont("h2", "Fonts\\\\MORPHEUS.TTF", 20)
      _, _, _, height = Page:GetBoundsRect()
      AFTER = height
    `);
    // H1's font object is 18 high and H2 has none (the page's 12 with its spacing 2): 18 + 0 + 12.
    assert.equal(vm.getGlobal("BEFORE"), 30);
    // SetFont gives H1 30 and H2 a font of its own, 20 with no spacing: 30 + 0 + 20.
    assert.equal(vm.getGlobal("AFTER"), 50);
  } finally { close(); }
});

test("line spacing and <BR/> are drawn as GetBoundsRect measures them", () => {
  const { bridge, lua, layer, close } = runtime();
  try {
    const text = "<html><body><p>one</p><br/><p>two</p><h1>head</h1><img src='x' width='10' height='20'/><p>three</p></body></html>";
    lua(`Page:SetText("${text}")`);
    const blocks = layer().children;
    const px = (value) => Number.parseFloat(value);
    // The page font is 12 high with a spacing of 2; H1's font object is 18 with none.
    assert.equal(blocks[0].style.lineHeight, "14px");
    assert.equal(blocks[0].style.top, "-1px", "a line's spacing is below it, not around it");
    assert.equal(blocks[1].style.height, "14px", "<BR/>: a paragraph of one line in the page's font");
    assert.equal(blocks[3].style.lineHeight, "18px");
    assert.equal(blocks[4].style.height, "20px", "a picture in the flow takes its height, no line box below it");
    // The same numbers as the measurement: each text block's box is lines × (height + spacing), so the
    // blocks end where frameXmlSimpleHtmlExtent puts the last one plus its spacing.
    const fonts = { 0: { height: 12, spacing: 2 }, 1: { height: 18, spacing: 0 }, 2: { height: 12, spacing: 2 }, 3: { height: 12, spacing: 2 } };
    const extent = frameXmlSimpleHtmlExtent(parseFrameXmlSimpleHtml(text), 300, { font: (level) => fonts[level], textWidth: () => 10 });
    const drawn = blocks.reduce((sum, block) => sum + (block.style.height ? px(block.style.height) : px(block.style.lineHeight)), 0);
    assert.equal(drawn - 2, extent.bottom);
    assert.ok(bridge.getFrame("Page"));
  } finally { close(); }
});
