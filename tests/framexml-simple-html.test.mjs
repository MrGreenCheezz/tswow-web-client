import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// WORK_PLAN 3.35: SimpleHTML drawn by the DOM renderer, parsed as Wow.exe 3.3.5a parses `SetText`
// (FrameXmlSimpleHtml.ts header). A dependency-free DOM seam; frames are never handed to assert.
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
const { parseFrameXmlSimpleHtml, frameXmlSimpleHtmlLink } = await import("../dist/code/browser/ui/framexml_compat/FrameXmlSimpleHtml.js");
const { FrameXmlUiBridge } = await import("../dist/code/browser/ui/framexml_compat/FrameXmlRuntime.js");
const { FrameXmlDomRenderer } = await import("../dist/code/browser/ui/framexml_compat/FrameXmlDomRenderer.js");
const { GlueLuaVm } = await import("../dist/code/browser/glue/GlueLua.js");
const { GlueWidgetBinder } = await import("../dist/code/browser/glue/GlueWidgets.js");

const sources = new Map();
for (const file of ["FrameXmlSimpleHtml.ts", "FrameXmlSimpleHtmlDom.ts"]) {
  sources.set(file, await readFile(new URL(`../src/browser/ui/framexml_compat/${file}`, import.meta.url), "utf8"));
}

const text = (block) => (block.kind === "text" ? block.text : `<img ${block.src}>`);

test("a stock LOGIN_* refusal: one centred paragraph whose link takes the hyperlink format", () => {
  // GlueStrings.lua's LOGIN_BANNED shape (the URL here is a placeholder).
  const source = "<html><body><p align=\"CENTER\">Учетная запись закрыта. Подробнее: <a href=\"https://example.invalid/banned\">https://example.invalid/banned</a>.</p></body></html>";
  const blocks = parseFrameXmlSimpleHtml(source, "|cff06ff07|H%s|h[%s]|h|r");
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, "text");
  assert.equal(blocks[0].level, 0);
  assert.equal(blocks[0].align, "CENTER");
  assert.equal(blocks[0].text,
    "Учетная запись закрыта. Подробнее: |cff06ff07|Hhttps://example.invalid/banned|h[https://example.invalid/banned]|h|r.");
  assert.equal(frameXmlSimpleHtmlLink("|H%s|h%s|h", "a", "b"), "|Ha|hb|h", "the client's default format");
  assert.equal(frameXmlSimpleHtmlLink("100%% %s", "x", "y"), "100% x");
});

test("blocks: headers, paragraphs, <BR/>, whitespace and entities as the client lays them", () => {
  const blocks = parseFrameXmlSimpleHtml(
    "\n<HTML><BODY>\n<H1 align=\"center\">  Глава   первая </H1>\n<P>Первая\n   строка.<BR/>   Вторая &lt;строка&gt; &amp;amp; конец.  </P><BR/>"
    + "<h3 align='right'>Три</h3><p>a |n b</p></BODY></HTML>\n\n");
  assert.deepEqual(blocks.map((block) => [block.kind, block.level, block.align, text(block), block.empty ?? false]), [
    ["text", 1, "CENTER", "Глава первая", false],
    ["text", 0, "LEFT", "Первая строка.|nВторая <строка> &amp; конец.", false],
    ["text", 0, "LEFT", "", true],
    ["text", 3, "RIGHT", "Три", false],
    ["text", 0, "LEFT", "a|nb", false],
  ]);
});

test("BODY draws its block elements only; the first BODY counts; unknown elements are skipped", () => {
  const blocks = parseFrameXmlSimpleHtml(
    "<html><head/><body>x<p>y<b>bold</b><a>no href</a><a href='u'></a></p>z<div><p>in div</p></div></body><body><p>second</p></body></html>");
  assert.deepEqual(blocks.map(text), ["y"]);
});

test("not an HTML page — no markup, broken markup, another root, no BODY — is one plain paragraph as given", () => {
  for (const source of [
    "Просто текст\nв две строки",
    "a<P>b</P><P>c<BR/>d</P>",
    "<html><body><p>a</b></body></html>",
    "<html><body><p>a & b</p></body></html><p>tail</p>",
    "<page><body><p>a</p></body></page>",
    "<html><p>no body</p></html>",
  ]) {
    const blocks = parseFrameXmlSimpleHtml(source);
    assert.equal(blocks.length, 1, source);
    assert.deepEqual([blocks[0].kind, blocks[0].level, blocks[0].align, blocks[0].text], ["text", 0, "LEFT", source]);
  }
});

test("a page that is not well-formed XML for the client's expat parser is plain text, as written", () => {
  // Review 03.10: SetText (0x0096d890) hands the string to XMLTree.cpp's parser (0x00814d90), which drives
  // expat (its error table at 0x00b2ec04: "junk after document element", "undefined entity", …). Expat
  // matches end tags byte for byte, knows XML's five entities only, wants every `&` to start a
  // reference and refuses control characters, `]]>` in text and `--` in a comment; any such page is
  // drawn as one plain paragraph.
  for (const source of [
    "<html><body><P>a</p></body></html>",
    "<HTML><BODY><p>a</p></body></HTML>",
    "<html><body><p>a&nbsp;b</p></body></html>",
    "<html><body><p>Кузнец & сыновья</p></body></html>",
    "<html><body><p>&#0;</p></body></html>",
    "<html><body><p>&#X41;</p></body></html>",
    "<html><body><p>&#xD800;</p></body></html>",
    "<html><body><p>a]]>b</p></body></html>",
    "<html><body><p>a\u0001b</p></body></html>",
    "<html><body><p align=\"cen&ter\">a</p></body></html>",
    "<html><body><!-- a -- b --><p>a</p></body></html>",
  ]) {
    const blocks = parseFrameXmlSimpleHtml(source);
    assert.deepEqual(blocks.map((block) => [block.kind, block.level, block.text]), [["text", 0, source]], source);
  }
  const blocks = parseFrameXmlSimpleHtml(
    "<html><body><p>&#x41;&#66;&#x416;<a href=\"u&amp;v\nw\">ссылка</a></p><!-- a - b --></body></html>");
  assert.deepEqual(blocks.map(text), ["ABЖ|Hu&v w|hссылка|h"], "references, and the attribute's newline as a space");
  assert.equal(parseFrameXmlSimpleHtml("<html><body><img src=\"a\tb\r\nc&#10;d\"/></body></html>")[0].src, "a b c\nd",
    "an attribute's tab and line end are spaces, a referenced line feed stays");
});

test("an <IMG> keeps its picture fields and nothing else", () => {
  const blocks = parseFrameXmlSimpleHtml(
    "<html><body><img src=\"Interface\\Pictures\\Map\" width=\"128\" height=\"64\" align=\"left\" onerror=\"alert(1)\"/><img src='x'/></body></html>");
  assert.deepEqual(blocks, [
    { kind: "image", src: "Interface\\Pictures\\Map", width: 128, height: 64, align: "LEFT", floating: true },
    { kind: "image", src: "x", width: 0, height: 0, align: "LEFT", floating: false },
  ]);
});

function runtime() {
  const vm = new GlueLuaVm();
  const bridge = new FrameXmlUiBridge();
  const binder = new GlueWidgetBinder(vm, bridge);
  bridge.setRuntime(binder);
  const loaded = bridge.loadAddon(String.raw`<Ui>
    <Font name="PageFont" font="Fonts\\FRIZQT__.TTF" justifyH="CENTER"><FontHeight><AbsValue val="12"/></FontHeight></Font>
    <Font name="HeaderFont" font="Fonts\\MORPHEUS.TTF"><FontHeight><AbsValue val="18"/></FontHeight>
      <Color r="1" g="0.82" b="0"/></Font>
    <Font name="OtherFont" font="Fonts\\FRIZQT__.TTF"><FontHeight><AbsValue val="10"/></FontHeight></Font>
    <SimpleHTML name="Page" hyperlinkFormat="|cff06ff07|H%s|h[%s]|h|r" width="300" height="100">
      <Scripts><OnHyperlinkClick>Clicked, ClickedText, ClickedButton = link, text, button</OnHyperlinkClick>
        <OnHyperlinkEnter>Entered = link</OnHyperlinkEnter><OnHyperlinkLeave>Left = link</OnHyperlinkLeave></Scripts>
      <FontString inherits="PageFont"/>
      <FontStringHeader1 inherits="HeaderFont"/>
    </SimpleHTML>
  </Ui>`);
  assert.equal(loaded.ok, true, loaded.diagnostics.map((entry) => entry.message).join("\n"));
  bridge.registerFontObjects();
  const host = document.createElement("section");
  const renderer = new FrameXmlDomRenderer(host, { bridge });
  renderer.mount(loaded.roots);
  const lua = (code) => {
    const result = vm.execute(code, "@simple-html");
    assert.equal(result.ok, true, result.error);
  };
  const layer = () => {
    const page = find(host, "Page");
    return page?.children.find((child) => child.getAttribute("data-framexml-html-layer") === "true");
  };
  return { vm, bridge, renderer, host, lua, layer, close() { renderer.destroy(); vm.close(); } };
}

function find(root, name) {
  if (root.getAttribute("data-framexml-name") === name) return root;
  for (const child of root.children) {
    const result = find(child, name);
    if (result) return result;
  }
  return undefined;
}

function all(root, out = []) {
  out.push(root);
  for (const child of root.children) all(child, out);
  return out;
}

test("the renderer draws the page: header in its own font, paragraphs in the page's, block alignment", () => {
  const { lua, layer, close } = runtime();
  try {
    lua(`Page:SetText("<html><body><h1 align='center'>Заголовок</h1><p>Абзац <a href='url:1'>ссылка</a></p><h2>Без шрифта</h2></body></html>")`);
    const blocks = layer().children;
    assert.deepEqual(blocks.map((block) => block.getAttribute("data-framexml-html-block")), ["h1", "p", "h2"]);
    assert.deepEqual(blocks.map((block) => block.textContent || block.children.map((span) => span.textContent).join("")),
      ["Заголовок", "Абзац [ссылка]", "Без шрифта"]);
    assert.equal(blocks[0].getAttribute("data-framexml-font"), "HeaderFont");
    assert.equal(blocks[0].style.fontSize, "18px");
    assert.equal(blocks[0].style.textAlign, "center", "the block's align, not the font's");
    assert.equal(blocks[1].style.textAlign, "left", "a paragraph is left unless it says otherwise");
    assert.equal(blocks[2].getAttribute("data-framexml-font"), null, "a header without a font keeps the page's");
    const link = blocks[1].children.find((span) => span.getAttribute("role") === "link");
    assert.equal(link.getAttribute("data-framexml-hyperlink"), "url:1");
    assert.equal(link.style.pointerEvents, "auto");
    assert.equal(link.style.color, "#06ff07ff");
  } finally { close(); }
});

test("a link fires OnHyperlinkClick with the link, its text and the button", () => {
  const { vm, lua, layer, close } = runtime();
  try {
    lua(`Page:SetText("<html><body><p><a href='https://example.invalid/'>сайт</a></p></body></html>")`);
    const link = all(layer()).find((node) => node.getAttribute("role") === "link");
    link.dispatchEvent({ type: "click" });
    assert.equal(vm.getGlobal("Clicked"), "https://example.invalid/");
    assert.equal(vm.getGlobal("ClickedButton"), "LeftButton");
    assert.equal(vm.getGlobal("ClickedText"), "|Hhttps://example.invalid/|h[сайт]|h");
    // Review 03.10: hovering is the stock OnHyperlinkEnter/Leave with the same link, never a browser link.
    link.dispatchEvent({ type: "mouseenter" });
    link.dispatchEvent({ type: "mouseleave" });
    assert.deepEqual([vm.getGlobal("Entered"), vm.getGlobal("Left")], ["https://example.invalid/", "https://example.invalid/"]);
    assert.equal(link.tagName, "SPAN", "a span, with no href to follow");
    assert.equal(link.getAttribute("href"), null);
  } finally { close(); }
});

test("markup in a server's or an add-on's string never becomes live elements", () => {
  const { lua, layer, close } = runtime();
  try {
    lua(`Page:SetText("<html><body><p>&lt;script&gt;alert(1)&lt;/script&gt;<script>x()</script><img src='y' onerror='x()'/></p>"
      .. "<img src='Interface\\\\Pictures\\\\Map' onerror='x()' onload='x()'/></body></html>")`);
    const nodes = all(layer());
    assert.equal(nodes.some((node) => node.tagName === "SCRIPT"), false);
    assert.equal(nodes.find((node) => node.getAttribute("data-framexml-html-block") === "p").textContent,
      "<script>alert(1)</script>", "an escaped tag is text");
    const image = nodes.find((node) => node.tagName === "IMG");
    assert.ok(image, "the body's IMG is drawn");
    assert.deepEqual(image.attributeNames().filter((name) => name.startsWith("on")), [], "no handler attribute is copied");
    lua(`Page:SetText("a <b>plain</b> page")`);
    const plain = layer().children;
    assert.equal(plain.length, 1);
    assert.equal(plain[0].textContent, "a <b>plain</b> page", "not HTML: the string as it is, as text");
    for (const file of ["FrameXmlSimpleHtml.ts", "FrameXmlSimpleHtmlDom.ts"]) {
      const source = sources.get(file);
      assert.equal(/innerHTML|outerHTML|insertAdjacentHTML|DOMParser|createContextualFragment/.test(source), false, file);
    }
  } finally { close(); }
});

test("an <IMG> src reaches the element only through the host's texture resolver, never as written", async () => {
  // Review 03.10: a page (a server's page_text, an add-on) may name any URL; the client only ever
  // loads its own art. The renderer hands `src` to the host's resolver (`/texture?path=…` in every
  // mount; the world mount lets through nothing but its own gateway's icon routes), so the element
  // never gets the page's string as its URL.
  const { trustedGatewayIconUrl } = await import("../dist/code/browser/GatewayGeneration.js");
  const vm = new GlueLuaVm();
  const bridge = new FrameXmlUiBridge();
  const binder = new GlueWidgetBinder(vm, bridge);
  bridge.setRuntime(binder);
  const loaded = bridge.loadAddon(`<Ui><SimpleHTML name="Pic" width="300" height="100"/></Ui>`);
  assert.equal(loaded.ok, true);
  const host = document.createElement("section");
  const asked = [];
  const renderer = new FrameXmlDomRenderer(host, {
    bridge,
    textureResolver: (path) => { asked.push(path); return `/texture?path=${encodeURIComponent(path)}`; },
  });
  renderer.mount(loaded.roots);
  try {
    const result = vm.execute(`Pic:SetText("<html><body><img src='https://evil.example/x.png'/>"
      .. "<img src='javascript:alert(1)'/><img src='Interface\\\\Pictures\\\\Map'/></body></html>")`, "@img");
    assert.equal(result.ok, true, result.error);
    const images = all(find(host, "Pic")).filter((node) => node.tagName === "IMG");
    assert.equal(images.length, 3);
    assert.deepEqual(images.map((image) => image.getAttribute("src")?.startsWith("/texture?path=")), [true, true, true],
      "every picture URL is the resolver's");
    assert.deepEqual(asked, ["https://evil.example/x.png", "javascript:alert(1)", "Interface\\Pictures\\Map"]);
    const origin = "http://127.0.0.1:8090";
    assert.equal(trustedGatewayIconUrl("https://evil.example/x.png", origin), undefined, "a foreign host is not trusted");
    assert.equal(trustedGatewayIconUrl(`${origin}/client/file?path=x`, origin), undefined, "nor another gateway route");
  } finally { renderer.destroy(); vm.close(); }
});

test("the page is built once per change: same text no rebuild, new text or SetFontObject(\"h1\") rebuilds", () => {
  const { lua, layer, bridge, host, close } = runtime();
  try {
    lua(`Page:SetText("<html><body><h1>A</h1></body></html>")`);
    const built = layer().replaceChildrenCalls;
    lua(`Page:SetText("<html><body><h1>A</h1></body></html>"); Page:SetTextColor(1, 0, 0)`);
    assert.equal(layer().replaceChildrenCalls, built, "same page: not rebuilt");
    // ItemTextFrame.lua:23 colours the page per material; the blocks inherit the page's colour.
    assert.match(String(find(host, "Page").style.color), /^rgba\(255, 0, 0, 1\)$/, "SetTextColor reaches the page");
    lua(`Page:SetFontObject("h1", "OtherFont")`);
    assert.equal(layer().children[0].getAttribute("data-framexml-font"), "OtherFont");
    assert.equal(bridge.getFrame("Page").fontObject, "PageFont", "the page's own font is untouched");
    lua(`Page:SetFontObject("p", "OtherFont"); Page:SetHyperlinkFormat("<%s:%s>")`);
    assert.equal(bridge.getFrame("Page").fontObject, "OtherFont");
    lua(`Page:SetText("<html><body><p><a href='h'>t</a></p></body></html>")`);
    assert.equal(layer().children[0].textContent || layer().children[0].children.map((span) => span.textContent).join(""), "<h:t>");
  } finally { close(); }
});
