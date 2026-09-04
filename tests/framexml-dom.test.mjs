import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { FrameXmlBoot } from "../dist/code/browser/framexml/FrameXmlBoot.js";
import { FrameXmlTsAddonPresentation } from "../dist/code/browser/framexml/FrameXmlTsAddonPresentation.js";
import { createFrameXmlTsAddonWindows } from "../dist/code/browser/framexml/FrameXmlTsAddonWindows.js";
import { createFixtureProvider } from "../dist/code/browser/glue/GlueLoader.js";
import { FrameXmlUiBridge } from "../dist/code/browser/ui/framexml_compat/FrameXmlRuntime.js";
import { FrameXmlDomRenderer } from "../dist/code/browser/ui/framexml_compat/FrameXmlDomRenderer.js";

// Deliberately tiny DOM seam: this keeps the vertical slice dependency-free
// while making every DOM operation used by the renderer explicit.
function fakeDocument() {
  const doc = {
    createElement: (tag) => make(tag),
    createElementNS: (_namespace, tag) => make(tag),
  };
  function make(tag) {
    const attributes = new Map();
    const listeners = new Map();
    const style = {
      setProperty(name, value) { this[name] = String(value); },
      removeProperty(name) {
        delete this[name];
        if (!name.startsWith("--") && name.includes("-")) {
          this[name.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())] = "";
        }
      },
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
      // The grown renderer also touches an EditBox's value/disabled pair and
      // needs a document head to install `@font-face`; both stay explicit.
      value: "",
      disabled: false,
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
      insertBefore(child, reference) {
        child.parentElement = node;
        const index = node.children.indexOf(reference);
        if (index < 0) node.children.push(child);
        else node.children.splice(index, 0, child);
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

test("TSWoW projection paints XML and lazy Lua UI over native anchors without painting stock HUD", async () => {
  const boot = new FrameXmlBoot({
    provider: createFixtureProvider({
      "interface/framexml/framexml.toc": "Stock.xml\n## tsaddon-begin: future-ui\nTSAddons/future-ui/addon/addon.xml\n## tsaddon-end: future-ui",
      "interface/framexml/stock.xml": `<Ui><Frame name="UIParent" width="1024" height="768">
        <Frames><Frame name="StockHud"><Layers><Layer><FontString name="StockHudText" text="duplicate HUD"/></Layer></Layers></Frame>
        <Frame name="CharacterFrame" hidden="true"><Frames><Frame name="PaperDollFrame"/></Frames></Frame></Frames>
      </Frame></Ui>`,
      "interface/framexml/tsaddons/future-ui/addon/addon.xml": `<Ui>
        <Frame name="FutureCharacterStats" parent="PaperDollFrame" width="200" height="80">
          <Layers><Layer><FontString name="FutureStatText" text="module stat"/></Layer></Layers>
        </Frame><Script file="addon.lua"/></Ui>`,
      "interface/framexml/tsaddons/future-ui/addon/addon.lua": `
        function FutureOpen()
          local frame = CreateFrame("Frame", "FutureLazyWindow", UIParent)
          frame:SetSize(320, 180)
          local button = CreateFrame("Button", "FutureLazyButton", frame)
          button:SetSize(100, 30)
          button:SetText("Original action")
          button:SetScript("OnClick", function() FutureClicked = true end)
        end
      `,
    }),
    subset: ["Stock.xml"], includeActiveTsAddons: true, exercise: false,
  });
  let renderer;
  try {
    await boot.load();
    assert.equal(boot.isAddonLoaded("future-ui"), true);
    assert.equal(boot.tsAddonOwner(boot.bridge.getFrame("FutureCharacterStats")), "future-ui");
    const presentation = new FrameXmlTsAddonPresentation(boot);
    const host = document.createElement("section");
    renderer = new FrameXmlDomRenderer(host, {
      bridge: boot.bridge, includeCreatedRoots: true, createdRootParent: "UIParent",
      frameFilter: presentation.includes, layoutOnly: presentation.layoutOnly,
    });
    renderer.mount(boot.roots.filter(frame => !frame.parent));
    assert.equal(renderer.elementFor(boot.bridge.getFrame("StockHud")), undefined);
    assert.equal(renderer.elementFor(boot.bridge.getFrame("StockHudText")), undefined);
    const character = boot.bridge.getFrame("CharacterFrame");
    assert.equal(renderer.elementFor(character).hidden, true);
    const rectangle = { left: 50, top: 80, width: 340, height: 500 };
    const nativeCharacter = { hidden: false, getBoundingClientRect: () => rectangle };
    const stage = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 1024, height: 768 }) };
    boot.bridge.runInMutationBatch(() => presentation.syncNativeAnchors(stage, nativeCharacter, null));
    assert.equal(renderer.elementFor(character).hidden, false);
    assert.equal(renderer.elementFor(boot.bridge.getFrame("FutureCharacterStats")).hidden, false);
    assert.equal(renderer.elementFor(boot.bridge.getFrame("FutureStatText")).textContent, "module stat");
    assert.equal(character.points[0].x, 50);
    assert.equal(character.points[0].y, -80);
    const nativeSheet = { hidden: true };
    boot.bridge.runInMutationBatch(() => presentation.syncNativeAnchors(stage, nativeCharacter, null, nativeSheet));
    assert.equal(renderer.elementFor(boot.bridge.getFrame("PaperDollFrame")).hidden, true,
      "custom character stats follow the sheet tab, not skills/collections");
    nativeSheet.hidden = false;
    boot.bridge.runInMutationBatch(() => presentation.syncNativeAnchors(stage, nativeCharacter, null, nativeSheet));
    assert.equal(renderer.elementFor(boot.bridge.getFrame("FutureCharacterStats")).hidden, false);
    boot.bridge.runInMutationBatch(() => boot.vm.execute("FutureOpen()", "@host-open"));
    const lazy = boot.bridge.getFrame("FutureLazyWindow");
    assert.equal(boot.tsAddonOwner(lazy), "future-ui");
    assert.equal(renderer.elementFor(lazy).hidden, false, "lazy UI is discovered after initial mount");
    boot.bridge.Click(boot.bridge.getFrame("FutureLazyButton"));
    assert.equal(boot.vm.getGlobal("FutureClicked"), true);
    nativeCharacter.hidden = true;
    boot.bridge.runInMutationBatch(() => presentation.syncNativeAnchors(stage, nativeCharacter, null));
    assert.equal(renderer.elementFor(character).hidden, true);
    assert.equal(renderer.elementFor(lazy).hidden, false, "closing C does not close independent addon windows");
    boot.vm.execute('UISpecialFrames = { "FutureLazyWindow", "StockHud" }', "@register-escape");
    const windows = createFrameXmlTsAddonWindows(boot);
    assert.equal(windows.isOpen(), true);
    windows.close();
    assert.equal(renderer.elementFor(lazy).hidden, true, "Escape closes original module windows");
    assert.equal(boot.bridge.getFrame("StockHud").visible, true, "only module-owned special frames are closed");
    windows.dispose();
    assert.equal(windows.isOpen(), false);
    assert.deepEqual(boot.errors, []);
  } finally { renderer?.destroy(); boot.close(); }
});
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

test("incremental add-on roots preserve mounted identity while rendering the new tree", () => {
  const bridge = new FrameXmlUiBridge();
  const base = bridge.loadAddon(`<Ui><Frame name="BaseRoot"><Texture name="BaseIcon" file="Interface\\Icons\\Base"/></Frame></Ui>`);
  const addon = bridge.loadAddon(`<Ui><Frame name="TalentRoot"><Button name="TalentButton" text="Талант"/></Frame></Ui>`);
  const host = document.createElement("section");
  const renderer = new FrameXmlDomRenderer(host, {
    bridge,
    textureResolver: (texture) => `/assets/${texture.toLowerCase().replaceAll("\\", "/")}.png`,
  });
  renderer.mount(base.roots);
  const baseRoot = find(host, "BaseRoot");
  const baseIcon = find(host, "BaseIcon");
  assert.ok(baseRoot && baseIcon);
  const sourceWrites = baseIcon.writes.src;

  renderer.addRoots(addon.roots);

  assert.equal(find(host, "BaseRoot"), baseRoot,
    "a load-on-demand add-on must not remount the existing world DOM");
  assert.equal(find(host, "BaseIcon"), baseIcon,
    "existing texture leases and borrowed canvases retain their element identity");
  assert.equal(baseIcon.writes.src, sourceWrites, "existing texture state is not rewritten");
  assert.ok(find(host, "TalentRoot"),
    "the newly loaded root is reconciled into the same renderer");
  assert.ok(find(host, "TalentButton"),
    "the newly loaded root's child is rendered without remounting the base tree");
});

test("created roots stay explicit in world mode while glue keeps its historical default", () => {
  const bridge = new FrameXmlUiBridge();
  const dynamic = bridge.CreateFrame("Frame", "LuaCreatedRoot");
  assert.ok(dynamic);
  assert.ok(bridge.createdRoots.includes(dynamic), "CreateFrame without a parent publishes a created root");

  const glueHost = document.createElement("section");
  const glueRenderer = new FrameXmlDomRenderer(glueHost, { bridge });
  glueRenderer.mount([]);
  assert.ok(find(glueHost, "LuaCreatedRoot"),
    "the default renderer keeps discovering Lua-created roots for Glue");

  const worldHost = document.createElement("section");
  const worldRenderer = new FrameXmlDomRenderer(worldHost, {
    bridge,
    includeCreatedRoots: false,
  });
  worldRenderer.mount([]);
  assert.equal(find(worldHost, "LuaCreatedRoot"), undefined,
    "world mode does not auto-paint an unowned parentless dynamic root");

  worldRenderer.addRoots([dynamic]);
  assert.ok(find(worldHost, "LuaCreatedRoot"),
    "an owner/lifecycle gate can explicitly publish the dynamic root with addRoots");

  glueRenderer.destroy();
  worldRenderer.destroy();
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
  // Layout offsets, not client rectangles: the renderer reads `offsetLeft`/`offsetTop`/
  // `offsetWidth`, because the glue stage is laid out in UI units and only visually scaled by a
  // transform — a client rectangle would come back in device pixels and be short by that scale.
  // The expected numbers are unchanged; only where they are read from is.
  Object.assign(other, { offsetLeft: 10, offsetTop: 15, offsetWidth: 100, offsetHeight: 20, offsetParent: root });
  Object.assign(child, { offsetLeft: 0, offsetTop: 0, offsetWidth: 20, offsetHeight: 10, offsetParent: root });
  renderer.sync();
  assert.equal(child.style.left, "-7px", "right edge is aligned to Other's top-left plus X");
  assert.equal(child.style.top, "1px", "bottom edge is aligned with FrameXML's upward Y offset");
  assert.equal(child.style.transform, "");
});

test("an anchor reaches a frame in another branch, because FrameXML's anchors are not parented", () => {
  // The owner's login screen declares "Запомнить логин и пароль" inside an anonymous, sizeless
  // `<Frame>` (`AccountLogin.xml:631`) and anchors it to the checkbox two branches over. Measured
  // on the live corpus: 13 of its 853 cross-frame anchors point at a frame that is not inside the
  // anchored one's own parent. Walking up from the target alone never reaches that parent, and the
  // label fell back to its 0x0 parent's edge — a sliver in the screen's top-left corner.
  const bridge = new FrameXmlUiBridge();
  const loaded = bridge.loadAddon(`<Ui><Frame name="Root" width="300" height="200">
    <Frame name="Anchor" width="40" height="20"/>
    <Frame name="Holder">
      <Frame name="Label" width="30" height="10"><Anchors><Anchor point="LEFT" relativeTo="Anchor" relativePoint="RIGHT"><Offset x="-2" y="0"/></Anchor></Anchors></Frame>
    </Frame>
  </Frame></Ui>`);
  const host = document.createElement("section");
  const renderer = new FrameXmlDomRenderer(host);
  renderer.mount(loaded.roots);
  const root = find(host, "Root");
  const anchor = find(host, "Anchor");
  const holder = find(host, "Holder");
  const label = find(host, "Label");
  assert.ok(root && anchor && holder && label);
  // `Anchor` sits at (60, 100) in Root; `Holder` — the label's containing block — at (10, 40).
  Object.assign(anchor, { offsetLeft: 60, offsetTop: 100, offsetWidth: 40, offsetHeight: 20, offsetParent: root });
  Object.assign(holder, { offsetLeft: 10, offsetTop: 40, offsetWidth: 0, offsetHeight: 0, offsetParent: root });
  Object.assign(label, { offsetLeft: 0, offsetTop: 0, offsetWidth: 30, offsetHeight: 10, offsetParent: holder });
  renderer.sync();
  // Anchor's RIGHT edge is 100 in Root and 90 inside Holder; the offset takes two off it.
  assert.equal(label.style.left, "88px");
  // Its vertical centre is 110 in Root, 70 inside Holder, less half the label's own height.
  assert.equal(label.style.top, "65px");
  assert.equal(label.style.transform, "");
});

test("SetPoint moves the anchor of the same name instead of adding a second one", () => {
  // 3.3.5 holds at most one anchor per point name, and only `ClearAllPoints` empties the set. The
  // owner's login screen leans on it: `AccountLogin.xml:559` anchors `OptionsButton` BOTTOM to the
  // hidden manage-account button and `XlIlHI.lua:78` re-anchors it BOTTOM to the exit button.
  // Carrying both pinned the top edge from one and the bottom edge from the other, the declared
  // height was dropped as over-constrained, and a 38-unit button laid itself out 126 units tall,
  // reaching down through Exit game.
  const bridge = new FrameXmlUiBridge();
  const loaded = bridge.loadAddon(`<Ui><Frame name="Root" width="300" height="200">
    <Frame name="First" width="40" height="20"/>
    <Frame name="Second" width="40" height="20"/>
    <Frame name="Moved" width="30" height="10"><Anchors><Anchor point="BOTTOM" relativeTo="First" relativePoint="TOP"/></Anchors></Frame>
  </Frame></Ui>`);
  const host = document.createElement("section");
  const renderer = new FrameXmlDomRenderer(host);
  renderer.mount(loaded.roots);
  const moved = bridge.getFrame("Moved");
  assert.equal(moved.points.length, 1);

  assert.equal(bridge.SetPoint(moved, "BOTTOM", bridge.getFrame("Second"), "TOP", 0, 0), true);
  assert.equal(moved.points.length, 1, "the same point name moves rather than stacking");
  assert.equal(moved.points[0].relativeTo?.name, "Second");

  // A different point name is a second anchor, which is what pins two edges of one box.
  assert.equal(bridge.SetPoint(moved, "TOP", bridge.getFrame("First"), "BOTTOM", 0, 0), true);
  assert.equal(moved.points.length, 2);
  assert.deepEqual(moved.points.map((point) => point.point), ["BOTTOM", "TOP"]);
  // And `ClearAllPoints` is still the only thing that empties the set.
  assert.equal(bridge.ClearAllPoints(moved), true);
  assert.equal(moved.points.length, 0);
  renderer.destroy();
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
  // 3.3.5 delivers OnEnter/OnLeave as (self, motion); motion is a scalar
  // boolean, so the transition stays free of any DOM object.
  assert.deepEqual(calls, [
    {
      source: "enter-handler",
      frame: "Hover",
      args: [true],
      hasDocument: false,
      hasWindow: false,
    },
    {
      source: "leave-handler",
      frame: "Hover",
      args: [true],
      hasDocument: false,
      hasWindow: false,
    },
  ]);
  renderer.destroy();
});

test("ButtonText defaults to its own button center and preserves authored anchors", () => {
  const bridge = new FrameXmlUiBridge();
  const loaded = bridge.loadAddon(`<Ui>
    <Button name="PlainLabelTemplate" virtual="true"><ButtonText name="$parentText"/></Button>
    <Frame name="EchoPanel" width="400" height="200">
      <Button name="ExplicitButton" width="100" height="24">
        <ButtonText name="$parentText"><Anchors><Anchor point="LEFT" relativePoint="LEFT">
          <Offset><AbsDimension x="7" y="2"/></Offset>
        </Anchor></Anchors></ButtonText>
      </Button>
    </Frame>
  </Ui>`);
  const parent = bridge.getFrame("EchoPanel");
  const first = bridge.CreateFrame("Button", undefined, parent, "PlainLabelTemplate");
  const second = bridge.CreateFrame("Button", undefined, parent, "PlainLabelTemplate");
  const firstLabel = first.stateTextures.get("BUTTONTEXT");
  const secondLabel = second.stateTextures.get("BUTTONTEXT");
  assert.notEqual(firstLabel, secondLabel, "anonymous template buttons keep independent label widgets");
  bridge.SetText(first, "Все ауры");
  bridge.SetText(second, "Обновить");
  const host = document.createElement("section");
  const renderer = new FrameXmlDomRenderer(host, { bridge });
  try {
    renderer.mount(loaded.roots);
    for (const [button, label] of [[first, firstLabel], [second, secondLabel]]) {
      const element = renderer.elementFor(label);
      assert.equal(element.getAttribute("data-framexml-point"), "CENTER:CENTER:0:0");
      assert.equal(label.points[0].relativeTo, button, "the anchor uses the immediate button, not the shared named ancestor");
      assert.equal(element.style.left, "50%");
      assert.equal(element.style.top, "50%");
      assert.match(element.style.transform, /translateX\(-50%\).*translateY\(-50%\)/);
    }
    assert.equal(renderer.elementFor(firstLabel).textContent, "Все ауры");
    assert.equal(renderer.elementFor(secondLabel).textContent, "Обновить");
    const explicit = find(host, "ExplicitButtonText");
    assert.equal(explicit.getAttribute("data-framexml-point"), "LEFT:LEFT:7:2");
    assert.equal(explicit.style.left, "7px");
    assert.equal(explicit.style.top, "calc(50% + -2px)");
  } finally { renderer.destroy(); }
});

test("Lua SetFont overrides inherited face, size and outline for addon button labels", async () => {
  const boot = new FrameXmlBoot({
    provider: createFixtureProvider({
      "interface/framexml/fonts.xml": `<Ui><Font name="ButtonFont" font="Fonts\\FRIZQT__.TTF" outline="NORMAL" virtual="true">
        <FontHeight><AbsValue val="12"/></FontHeight><Color r="1" g="0.82" b="0"/>
      </Font></Ui>`,
      "interface/framexml/labels.lua": `
        LabelPanel = CreateFrame("Frame", "LabelPanel")
        LabelPanel:SetSize(200, 100)
        DirectLabel = LabelPanel:CreateFontString("DirectLabel", "OVERLAY", "ButtonFont")
        DirectLabel:SetPoint("CENTER")
        DirectLabel:SetText("Обновить")
        DirectLabel:SetFont("Fonts\\\\ARIALN.TTF", 19, "THICKOUTLINE")
        DirectFontFile, DirectFontHeight, DirectFontFlags = DirectLabel:GetFont()
      `,
    }),
    subset: ["Fonts.xml", "Labels.lua"], exercise: false,
  });
  let renderer;
  try {
    await boot.load();
    const requested = [];
    const host = document.createElement("section");
    renderer = new FrameXmlDomRenderer(host, { bridge: boot.bridge,
      fontLoader: (file, family) => requested.push({ file, family }),
    });
    renderer.registerFonts(boot.bridge.fontStyles);
    renderer.mount(boot.roots);
    const label = find(host, "DirectLabel");
    assert.equal(label.style.fontSize, "19px", "the addon size must override the inherited 12px");
    assert.match(label.style.fontFamily, /framexml-ARIALN/);
    assert.match(label.style.textShadow, /2px 0 0 #000/);
    assert.equal(requested.filter(row => row.file === "Fonts\\ARIALN.TTF").length, 1,
      "a face first named by Lua uses the existing trusted font loader once");
    assert.equal(boot.vm.getGlobal("DirectFontFile"), "Fonts\\ARIALN.TTF");
    assert.equal(boot.vm.getGlobal("DirectFontHeight"), 19);
    assert.equal(boot.vm.getGlobal("DirectFontFlags"), "THICKOUTLINE");
    assert.equal(boot.vm.execute('DirectLabel:SetFont("Fonts\\\\ARIALN.TTF", 11, "")', "@change-label-font").ok, true);
    assert.equal(label.style.fontSize, "11px");
    assert.ok(!label.style.textShadow, "empty flags clear the inherited outline");
    assert.equal(requested.filter(row => row.file === "Fonts\\ARIALN.TTF").length, 1);
    assert.equal(boot.vm.execute(`DirectLabel:SetFontObject("ButtonFont")
      RestoredFile, RestoredHeight, RestoredFlags = DirectLabel:GetFont()`, "@restore-label-font").ok, true);
    assert.equal(label.style.fontSize, "12px", "SetFontObject restores its own inherited style");
    assert.match(label.style.fontFamily, /framexml-FRIZQT__/);
    assert.equal(boot.vm.getGlobal("RestoredFlags"), "OUTLINE", "XML NORMAL uses the Lua OUTLINE spelling");
    assert.deepEqual(boot.errors, []);
  } finally { renderer?.destroy(); boot.close(); }
});

test("FontString vertical alignment keeps multiline WoW text runs in normal inline layout", () => {
  const bridge = new FrameXmlUiBridge();
  const loaded = bridge.loadAddon(`<Ui><Frame name="Panel" width="200" height="100">
    <FontString name="SizedLabel" width="180" height="60" justifyH="RIGHT" justifyV="MIDDLE"
      text="До |cffff0000красный|r\nПосле"/>
  </Frame></Ui>`);
  const host = document.createElement("section");
  const renderer = new FrameXmlDomRenderer(host, { bridge });
  try {
    renderer.mount(loaded.roots);
    const label = find(host, "SizedLabel");
    assert.equal(label.style.alignContent, "center");
    assert.equal(label.style.textAlign, "right");
    assert.notEqual(label.style.display, "flex", "colored runs must stay on the same text line");
    const runs = [...label.children];
    assert.equal(runs.map(run => run.textContent).join(""), "До красный\nПосле");
    assert.equal(runs[1].style.color, "#ff0000ff");
    for (const [justifyV, css] of [["TOP", "start"], ["BOTTOM", "end"], ["MIDDLE", "center"]]) {
      bridge.update(bridge.getFrame("SizedLabel"), frame => { frame.justifyV = justifyV; });
      assert.equal(label.style.alignContent, css);
      assert.deepEqual(label.children, runs, "alignment does not replace or regroup the inline markup");
    }
  } finally { renderer.destroy(); }
});

test("the grown grammar renders layers, texcoords, backdrops, fonts and a model placeholder", () => {
  const bridge = new FrameXmlUiBridge();
  // Shaped like the corpus: a font object chain, a layered texture with
  // TexCoords and an ADD alpha mode, a nine-slice backdrop, and a ModelFFX
  // whose 3D content G2 only records.
  const loaded = bridge.loadAddon(`<Ui>
    <Font name="TestFont" font="Fonts\\FRIZQT__.TTF" outline="NORMAL" virtual="true">
      <FontHeight><AbsValue val="16"/></FontHeight>
      <Color r="1" g="0.82" b="0"/>
      <Shadow><Offset><AbsDimension x="1" y="-1"/></Offset><Color r="0" g="0" b="0"/></Shadow>
    </Font>
    <Frame name="Panel" width="200" height="100">
      <Backdrop bgFile="Interface\\DialogFrame\\Bg" edgeFile="Interface\\DialogFrame\\Border" tile="true">
        <EdgeSize><AbsValue val="32"/></EdgeSize>
        <TileSize><AbsValue val="16"/></TileSize>
      </Backdrop>
      <Layers>
        <Layer level="BACKGROUND">
          <Texture name="$parentBg" file="Interface\\Glues\\Bg" alphaMode="ADD">
            <TexCoords left="0" right="0.5" top="0.25" bottom="1"/>
          </Texture>
        </Layer>
        <Layer level="OVERLAY">
          <FontString name="$parentLabel" inherits="TestFont" text="Готово" justifyH="LEFT"/>
        </Layer>
      </Layers>
      <Frames>
        <ModelFFX name="PanelModel" file="Interface\\Glues\\Models\\UI_Human\\UI_Human.mdx" fogFar="1200" glow="0.15"/>
      </Frames>
    </Frame>
  </Ui>`);
  assert.equal(loaded.ok, true);
  bridge.registerFontObjects();

  const host = document.createElement("section");
  const renderer = new FrameXmlDomRenderer(host, {
    bridge,
    textureResolver: (texture) => `/texture?path=${encodeURIComponent(texture)}`,
    fontResolver: (font) => `/client/file?path=${encodeURIComponent(font)}`,
  });
  assert.equal(renderer.registerFonts(bridge.fontStyles), 1);
  renderer.mount(loaded.roots);

  const background = find(host, "PanelBg");
  assert.ok(background);
  // A draw layer becomes a z-index band, so BACKGROUND stays under OVERLAY.
  assert.equal(Number(background.style.zIndex) < Number(find(host, "PanelLabel").style.zIndex), true);
  assert.equal(background.getAttribute("data-framexml-texcoords"), "0:0.5:0.25:1");
  // ADD blending is the glue screen's highlight vocabulary; plus-lighter is
  // the CSS operator with the same maths.
  assert.equal(background.style.mixBlendMode, "plus-lighter");
  assert.equal(background.getAttribute("src"), "/texture?path=Interface%5CGlues%5CBg");

  const label = find(host, "PanelLabel");
  assert.equal(label.textContent, "Готово");
  assert.equal(label.getAttribute("data-framexml-font"), "TestFont");
  assert.equal(label.style.fontSize, "16px");
  assert.equal(label.style.textAlign, "left");
  assert.match(label.style.fontFamily, /framexml-FRIZQT__/);

  const panel = find(host, "Panel");
  assert.equal(panel.getAttribute("data-framexml-backdrop"), "Interface\\DialogFrame\\Bg");
  // The backdrop is private paint, not root `border-image`: a WoW edge file is eight square tiles
  // in a row, not the square nine-patch CSS slices, and two of the eight are stored on their side.
  // Without a texture source there are no edge pieces to draw, but the background still paints.
  const backdropBackground = panel.children.find((child) => child.getAttribute("data-framexml-backdrop-paint") === "background");
  assert.equal(panel.style.borderImageSlice, undefined);
  assert.equal(panel.style.backgroundImage, "");
  assert.equal(backdropBackground.style.backgroundRepeat, "repeat");
  assert.match(backdropBackground.style.backgroundImage, /^url\("[^\"]*Interface%5CDialogFrame%5CBg"\)$/);

  // The 3D box is a positioned placeholder carrying the recorded model state;
  // G3 replaces exactly this element with a canvas.
  const model = find(host, "PanelModel");
  assert.equal(model.getAttribute("data-framexml-model-placeholder"), "true");
  assert.equal(model.getAttribute("data-framexml-model"), "Interface\\Glues\\Models\\UI_Human\\UI_Human.mdx");
  assert.equal(model.getAttribute("data-framexml-fog-far"), "1200");
  assert.equal(model.getAttribute("data-framexml-glow"), "0.15");
  assert.equal(model.getAttribute("src"), null, "a model path is never loaded as an image");
  renderer.destroy();
});

test("two opposite anchors pin both edges and drop the declared size", () => {
  const bridge = new FrameXmlUiBridge();
  // This is what `setAllPoints="true"` expands to, and how a glue screen
  // inherits GlueParent's rectangle instead of anchoring to the document.
  const loaded = bridge.loadAddon(`<Ui><Frame name="Root" width="300" height="200">
    <Frame name="Full" setAllPoints="true" width="10" height="10"/>
    <Frame name="Corner" width="40" height="20">
      <Anchors><Anchor point="BOTTOMRIGHT"><Offset><AbsDimension x="-8" y="12"/></Offset></Anchor></Anchors>
    </Frame>
  </Frame></Ui>`);
  const host = document.createElement("section");
  const renderer = new FrameXmlDomRenderer(host);
  renderer.mount(loaded.roots);

  const full = find(host, "Full");
  assert.equal(full.style.left, "0%");
  assert.equal(full.style.top, "0%");
  assert.equal(full.style.right, "0%");
  assert.equal(full.style.bottom, "0%");
  assert.equal(full.style.width, undefined, "a pinned pair defines the box, so width is dropped");

  const corner = find(host, "Corner");
  // FrameXML's positive Y points up; CSS's points down, so +12 becomes a
  // bottom offset of 12 and the negative X an inset from the right.
  assert.equal(corner.style.right, "8px");
  assert.equal(corner.style.bottom, "12px");
  assert.equal(corner.style.width, "40px");
  renderer.destroy();
});

test("a pinned Texture takes its anchors' box even when the region also declares a size", () => {
  // The owner's golden frame. `GlueButtons.xml:263` declares the Website button's glow as
  // `<Texture name="$parentGlow" setAllPoints="true" alphaMode="ADD">` **with** a
  // `<Size x="150" y="51"/>` inside it. Two anchors outrank a size in the original — so the
  // declared 150 is (rightly) not written — but a Texture is an `<img>`, and CSS sizes an
  // absolutely positioned *replaced* element from its intrinsic dimensions when `width` is `auto`
  // instead of solving for the pinned pair. Measured live at 1920x969 before this rule:
  // `AccountLoginCommunityButtonGlow` came out **747x219** UI units against the button's 150x38 —
  // an ADD-blended plate five times the button, hung off its top-left corner.
  const bridge = new FrameXmlUiBridge();
  const loaded = bridge.loadAddon(`<Ui><Frame name="Button" width="150" height="38">
    <Layers><Layer level="ARTWORK">
      <Texture name="Glow" file="Glue\\Glow" setAllPoints="true">
        <Size><AbsDimension x="150" y="51"/></Size>
      </Texture>
      <Texture name="Plate" file="Glue\\Plate" width="60" height="20">
        <Anchors><Anchor point="TOPLEFT"/></Anchors>
      </Texture>
    </Layer></Layers>
  </Frame></Ui>`);
  const host = document.createElement("section");
  const renderer = new FrameXmlDomRenderer(host, { textureResolver: (path) => `t:${path}` });
  renderer.mount(loaded.roots);

  const glow = find(host, "Glow");
  assert.equal(glow.style.left, "0%");
  assert.equal(glow.style.right, "0%");
  assert.equal(glow.style.width, "calc(100% - (0%) - (0%))", "the pinned pair is written out for a replaced element");
  assert.equal(glow.style.height, "calc(100% - (0%) - (0%))");

  // A Texture pinned on one edge only is untouched: its declared size is still the box.
  const plate = find(host, "Plate");
  assert.equal(plate.style.width, "60px");
  assert.equal(plate.style.height, "20px");
  renderer.destroy();
});

test("an anchor to a centre-anchored frame lands on where that frame is painted", () => {
  // Both halves of the owner's realm dialog. A widget anchored by its own centre is placed as
  // `left: 50%` plus `translateX(-50%)`, because the renderer does not know its width in advance —
  // and a transform does not move layout, so `offsetLeft` reports the pre-transform edge.
  //
  // `RealmList.xml:340` anchors the header plate `point="TOP"` and `:352` anchors «Выбор мира»
  // `point="TOP" relativeTo="RealmListHeader"`: the title was placed against a centre half the
  // plate's 256 units too far right, and sat beside the notch instead of in it. `:147` anchors each
  // column's sort arrow `point="LEFT" relativeTo="$parentText" relativePoint="RIGHT"`, and the
  // `ButtonText` it names is vertically centred, so the arrow hung half a line below the heading.
  const bridge = new FrameXmlUiBridge();
  const loaded = bridge.loadAddon(`<Ui><Frame name="Dialog" width="400" height="200">
    <Frame name="Header" width="256" height="64">
      <Anchors><Anchor point="TOP"><Offset x="-12" y="12"/></Anchor></Anchors>
    </Frame>
    <Frame name="Title" width="90" height="16">
      <Anchors><Anchor point="TOP" relativeTo="Header"><Offset x="0" y="-14"/></Anchor></Anchors>
    </Frame>
  </Frame></Ui>`);
  const host = document.createElement("section");
  const renderer = new FrameXmlDomRenderer(host);
  renderer.mount(loaded.roots);
  const dialog = find(host, "Dialog");
  const header = find(host, "Header");
  const title = find(host, "Title");
  assert.ok(dialog && header && title);

  // The header is centre-anchored, so the renderer placed it at `left: calc(50% + -12px)` with a
  // `translateX(-50%)`; the layout engine reports the pre-transform edge, 200 - 12 = 188.
  assert.equal(header.style.transform, "translateX(-50%)");
  Object.assign(header, { offsetLeft: 188, offsetTop: -12, offsetWidth: 256, offsetHeight: 64, offsetParent: dialog });
  Object.assign(title, { offsetLeft: 0, offsetTop: 0, offsetWidth: 90, offsetHeight: 16, offsetParent: dialog });
  renderer.sync();

  // The plate is painted from 60 to 316, so its centre is at 188 and the title's own centre goes
  // there: 188 - 45. Read off the layout edge instead, it would have been 188 + 128 - 45 = 271.
  assert.equal(title.style.left, "143px", "the target's own centring translate is taken off");
  // Its TOP is the plate's TOP, 14 below it: FrameXML's positive Y points up.
  assert.equal(title.style.top, "2px");
  renderer.destroy();
});

// --- G3: pictures come from a texture source, and a backdrop is nine background layers -------

/** A stub picture store with the same shape the real cache has, answering synchronously. */
function fakeTextures(ready = true) {
  const holds = new Map();
  const edgeHolds = new Map();
  const count = (map, key, delta) => map.set(key, (map.get(key) ?? 0) + delta);
  const edgePieces = (path) => Object.fromEntries(
    ["LEFT", "RIGHT", "TOP", "BOTTOM", "TOPLEFT", "TOPRIGHT", "BOTTOMLEFT", "BOTTOMRIGHT"]
      .map((piece) => [piece, `blob:${path}#${piece}`]),
  );
  return {
    holds,
    edgeHolds,
    acquire(path) { count(holds, path, 1); return ready ? `blob:${path}` : undefined; },
    peek(path) { return ready ? `blob:${path}` : undefined; },
    release(path) { count(holds, path, -1); },
    acquireEdge(path) {
      count(edgeHolds, path, 1);
      if (!ready) return undefined;
      return edgePieces(path);
    },
    peekEdge(path) { return ready ? edgePieces(path) : undefined; },
    releaseEdge(path) { count(edgeHolds, path, -1); },
  };
}

test("a texture source supplies the pixels, and every reference is given back on teardown", () => {
  const bridge = new FrameXmlUiBridge();
  const host = document.createElement("section");
  const textures = fakeTextures();
  const renderer = new FrameXmlDomRenderer(host, { bridge, textures });
  const loaded = bridge.loadAddon(`<Ui><Frame name="Root">
    <Texture name="Bg" file="Interface\\Glues\\Credits\\Parchment8"/>
  </Frame></Ui>`);
  renderer.mount(loaded.roots);

  const image = find(host, "Bg");
  // The name the corpus wrote, completed to the file the route has.
  assert.equal(image.getAttribute("data-framexml-texture"), "Interface\\Glues\\Credits\\Parchment8");
  assert.equal(image.getAttribute("src"), "blob:Interface\\Glues\\Credits\\Parchment8.blp");
  assert.equal(textures.holds.get("Interface\\Glues\\Credits\\Parchment8.blp"), 1);

  // Re-pointing a texture gives back the old picture and takes the new one.
  bridge.SetTexture(bridge.getFrame("Bg"), "Interface\\Glues\\Common\\LoginBorder.blp");
  assert.equal(textures.holds.get("Interface\\Glues\\Credits\\Parchment8.blp"), 0);
  assert.equal(textures.holds.get("Interface\\Glues\\Common\\LoginBorder.blp"), 1);

  renderer.destroy();
  assert.equal(textures.holds.get("Interface\\Glues\\Common\\LoginBorder.blp"), 0,
    "a destroyed renderer holds no pictures");
});

test("a Backdrop draws its edge file as eight pieces, corners over edges over the background", () => {
  const bridge = new FrameXmlUiBridge();
  const host = document.createElement("section");
  const textures = fakeTextures();
  const renderer = new FrameXmlDomRenderer(host, { bridge, textures });
  const loaded = bridge.loadAddon(`<Ui><Frame name="Panel" width="200" height="100">
    <Backdrop bgFile="Interface\\Tooltips\\UI-Tooltip-Background" edgeFile="Interface\\Glues\\Common\\LoginBorder" tile="true">
      <TileSize><AbsValue val="16"/></TileSize>
      <EdgeSize><AbsValue val="32"/></EdgeSize>
    </Backdrop>
  </Frame></Ui>`);
  renderer.mount(loaded.roots);

  const panel = find(host, "Panel");
  const background = panel.children.find((child) => child.getAttribute("data-framexml-backdrop-paint") === "background");
  const edge = panel.children.find((child) => child.getAttribute("data-framexml-backdrop-paint") === "edge");
  const images = edge.style.backgroundImage.split(", ");
  assert.equal(images.length, 8, edge.style.backgroundImage);
  // The four corners first, so they draw over the edges that run under them.
  assert.match(images[0], /#TOPLEFT/);
  assert.match(images[3], /#BOTTOMRIGHT/);
  assert.match(images[4], /#TOP/);
  assert.match(images[7], /#RIGHT/);
  assert.match(background.style.backgroundImage, /UI-Tooltip-Background\.blp/);
  assert.deepEqual(edge.style.backgroundRepeat.split(", "), [
    "no-repeat", "no-repeat", "no-repeat", "no-repeat", "repeat-x", "repeat-x", "repeat-y", "repeat-y",
  ]);
  assert.deepEqual(edge.style.backgroundPosition.split(", ").slice(0, 4),
    ["left top", "right top", "left bottom", "right bottom"]);
  // The pieces are drawn at the declared edge size, the background at its tile size.
  assert.equal(edge.style.backgroundSize.split(", ")[0], "32px 32px");
  assert.equal(background.style.backgroundSize, "16px 16px");
  assert.equal(background.style.filter ?? "", "", "an identity backdrop color needs no SVG filter");
  assert.equal(edge.style.filter ?? "", "", "an identity border color needs no SVG filter");
  assert.equal(host.children.filter((child) => child.getAttribute("data-framexml-backdrop-filters") !== null).length, 0,
    "an uncolored Backdrop creates no filter definitions");
  renderer.destroy();
});

test("a Backdrop owns inset/tinted paint layers without styling authored children", () => {
  const bridge = new FrameXmlUiBridge();
  const host = document.createElement("section");
  const textures = fakeTextures();
  const renderer = new FrameXmlDomRenderer(host, { bridge, textures });
  const loaded = bridge.loadAddon(`<Ui><Frame name="Panel" width="200" height="100">
    <Backdrop bgFile="Interface\\Glues\\Common\\Glue-Tooltip-Background" edgeFile="Interface\\Glues\\Common\\Glue-Tooltip-Border" tile="true">
      <BackgroundInsets><AbsInset left="10" right="5" top="4" bottom="9"/></BackgroundInsets>
      <TileSize><AbsValue val="16"/></TileSize>
      <EdgeSize><AbsValue val="16"/></EdgeSize>
    </Backdrop>
    <Texture name="Authored" file="Interface\\Icons\\Spell"/>
  </Frame><Frame name="Plain"/></Ui>`);
  assert.equal(loaded.ok, true);
  renderer.mount(loaded.roots);
  const panelFrame = bridge.getFrame("Panel");
  bridge.update(panelFrame, (frame) => {
    frame.backdropColor = { r: 0.09, g: 0.09, b: 0.09, a: 0.85 };
    frame.backdropBorderColor = { r: 0.8, g: 0.8, b: 0.8, a: 1 };
  });

  const panel = find(host, "Panel");
  const authored = find(host, "Authored");
  const plain = find(host, "Plain");
  assert.ok(panel && authored && plain);
  assert.equal(panel.style.backgroundImage ?? "", "", "the root no longer owns backdrop paint");
  assert.equal(panel.style.backgroundColor ?? "", "", "the root no longer stacks a color below the bitmap");
  assert.equal(panel.style.filter ?? "", "", "authored frame is never filtered");
  const background = panel.children.find((child) => child.getAttribute("data-framexml-backdrop-paint") === "background");
  const edge = panel.children.find((child) => child.getAttribute("data-framexml-backdrop-paint") === "edge");
  assert.ok(background && edge, "backdrop owns two internal paint nodes");
  assert.equal(panel.children.indexOf(background) < panel.children.indexOf(authored), true,
    "background paint precedes authored regions");
  assert.equal(panel.children.indexOf(edge) < panel.children.indexOf(authored), true,
    "edge paint precedes authored regions");
  assert.equal(background.style.left, "10px");
  assert.equal(background.style.right, "5px");
  assert.equal(background.style.top, "4px");
  assert.equal(background.style.bottom, "9px");
  assert.equal(edge.style.left, "0px");
  assert.equal(edge.style.right, "0px");
  assert.equal(edge.style.top, "0px");
  assert.equal(edge.style.bottom, "0px");
  assert.equal(background.style.pointerEvents, "none");
  assert.equal(edge.style.pointerEvents, "none");
  assert.equal(background.style.backgroundImage.includes("Glue-Tooltip-Background.blp"), true);
  assert.equal(edge.style.backgroundImage.split(", ").length, 8);
  assert.match(background.style.filter ?? "", /^url\(#/);
  assert.match(edge.style.filter ?? "", /^url\(#/);
  assert.equal(authored.style.filter ?? "", "", "a sibling authored region is not filtered");

  const filterSvg = host.children.find((child) => child.getAttribute("data-framexml-backdrop-filters") === "Panel");
  assert.ok(filterSvg, "backdrop filters are private to this rendered frame");
  const matrices = filterSvg.children[0].children;
  assert.equal(matrices[0].children[0].getAttribute("values"),
    "0.09 0 0 0 0 0 0.09 0 0 0 0 0 0.09 0 0 0 0 0 0.85 0");
  assert.equal(matrices[1].children[0].getAttribute("values"),
    "0.8 0 0 0 0 0 0.8 0 0 0 0 0 0.8 0 0 0 0 0 1 0");
  assert.equal(authored.children.some((child) => child.getAttribute("data-framexml-backdrop-paint")), false,
    "a frame without a Backdrop gets no private paint nodes");
  assert.equal(plain.children.some((child) => child.getAttribute("data-framexml-backdrop-paint")), false,
    "a frame without a Backdrop does not allocate paint nodes");

  bridge.update(panelFrame, (frame) => {
    frame.backdropColor = { r: 1, g: 1, b: 1, a: 1 };
    frame.backdropBorderColor = { r: 1, g: 1, b: 1, a: 1 };
  });
  assert.equal(background.style.filter ?? "", "", "identity recolor removes the background filter");
  assert.equal(edge.style.filter ?? "", "", "identity recolor removes the edge filter");
  assert.equal(host.children.filter((child) => child.getAttribute("data-framexml-backdrop-filters") !== null).length, 0,
    "identity recolor removes the private filter definitions");

  const backdrop = panelFrame.backdrop;
  assert.equal(textures.holds.get("Interface\\Glues\\Common\\Glue-Tooltip-Background.blp"), 1);
  assert.equal(textures.edgeHolds.get("Interface\\Glues\\Common\\Glue-Tooltip-Border.blp"), 1);
  bridge.update(panelFrame, (frame) => { frame.backdrop = undefined; });
  assert.equal(textures.holds.get("Interface\\Glues\\Common\\Glue-Tooltip-Background.blp"), 0,
    "SetBackdrop(nil) releases its background lease");
  assert.equal(textures.edgeHolds.get("Interface\\Glues\\Common\\Glue-Tooltip-Border.blp"), 0,
    "SetBackdrop(nil) releases its edge lease");
  assert.equal(panel.style.backgroundImage ?? "", "");
  assert.equal(panel.children.find((child) => child.getAttribute("data-framexml-backdrop-paint") === "background").style.display, "none");
  assert.equal(host.children.includes(filterSvg), false, "removed backdrop drops its private filter definitions");

  bridge.update(panelFrame, (frame) => { frame.backdrop = backdrop; });
  assert.equal(textures.holds.get("Interface\\Glues\\Common\\Glue-Tooltip-Background.blp"), 1);
  assert.equal(textures.edgeHolds.get("Interface\\Glues\\Common\\Glue-Tooltip-Border.blp"), 1);
  renderer.destroy();
  assert.equal(textures.holds.get("Interface\\Glues\\Common\\Glue-Tooltip-Background.blp"), 0,
    "destroy releases the active background lease");
  assert.equal(textures.edgeHolds.get("Interface\\Glues\\Common\\Glue-Tooltip-Border.blp"), 0,
    "destroy releases the active edge lease");
});

test("a pending Backdrop source does not flash its tint as a solid paint", () => {
  const bridge = new FrameXmlUiBridge();
  const host = document.createElement("section");
  const textures = fakeTextures(false);
  const renderer = new FrameXmlDomRenderer(host, { bridge, textures });
  const loaded = bridge.loadAddon(`<Ui><Frame name="Panel" width="200" height="100">
    <Backdrop bgFile="Interface\\Glues\\Common\\Glue-Tooltip-Background" edgeFile="Interface\\Glues\\Common\\Glue-Tooltip-Border" tile="true">
      <TileSize><AbsValue val="16"/></TileSize><EdgeSize><AbsValue val="16"/></EdgeSize>
    </Backdrop>
  </Frame></Ui>`);
  renderer.mount(loaded.roots);
  const panelFrame = bridge.getFrame("Panel");
  bridge.update(panelFrame, (frame) => {
    frame.backdropColor = { r: 0.09, g: 0.09, b: 0.09, a: 0.85 };
  });
  const panel = find(host, "Panel");
  const background = panel.children.find((child) => child.getAttribute("data-framexml-backdrop-paint") === "background");
  assert.equal(background.style.display, "none", "a named source stays hidden until its pixels arrive");
  assert.equal(background.style.backgroundColor ?? "", "", "a pending bitmap cannot recreate the old opaque tint");
  assert.equal(textures.holds.get("Interface\\Glues\\Common\\Glue-Tooltip-Background.blp"), 1);
  assert.equal(textures.edgeHolds.get("Interface\\Glues\\Common\\Glue-Tooltip-Border.blp"), 1);
  renderer.destroy();
  assert.equal(textures.holds.get("Interface\\Glues\\Common\\Glue-Tooltip-Background.blp"), 0);
  assert.equal(textures.edgeHolds.get("Interface\\Glues\\Common\\Glue-Tooltip-Border.blp"), 0);
});

test("frame strata order the screen, and a button's state texture fills the button", () => {
  const bridge = new FrameXmlUiBridge();
  const host = document.createElement("section");
  const renderer = new FrameXmlDomRenderer(host, { bridge });
  const loaded = bridge.loadAddon(`<Ui><Frame name="Root">
    <Frame name="Scene" frameStrata="LOW"/>
    <Frame name="Ui"/>
    <Button name="Big">
      <NormalTexture file="Interface\\Glues\\Common\\Glues-BigButton-Up"/>
    </Button>
  </Frame></Ui>`);
  renderer.mount(loaded.roots);

  // `lgzg.lua` puts its whole login scene in LOW and the account boxes are a sibling in the
  // default MEDIUM; with strata dropped the later-created scene covered the entire interface.
  const scene = Number(find(host, "Scene").style.zIndex);
  const ui = Number(find(host, "Ui").style.zIndex);
  assert.equal(scene < ui, true, `LOW ${scene} must be under MEDIUM ${ui}`);

  // A state texture with neither anchors nor a size fills its button rather than drawing at the
  // picture's own dimensions вЂ” measured at 747x219 over the login screen before this.
  const normal = bridge.getFrame("Big").stateTextures.get("NORMAL");
  assert.ok(normal);
  assert.equal(normal.setAllPoints, true);
  assert.equal(normal.points.length, 2);
  renderer.destroy();
});

test("a button draws the one picture its state calls for, not all six at once", () => {
  const bridge = new FrameXmlUiBridge();
  const host = document.createElement("section");
  const renderer = new FrameXmlDomRenderer(host, { bridge });
  // `GlueDialogButtonTemplate`'s four pictures, which is what the realm list's OK and Cancel are.
  const loaded = bridge.loadAddon(`<Ui><Frame name="Root">
    <Button name="Ok">
      <NormalTexture file="Interface\\Glues\\Common\\Glue-Panel-Button-Up"/>
      <PushedTexture file="Interface\\Glues\\Common\\Glue-Panel-Button-Down"/>
      <DisabledTexture file="Interface\\Glues\\Common\\Glue-Panel-Button-Disabled"/>
      <HighlightTexture file="Interface\\Glues\\Common\\Glue-Panel-Button-Highlight" alphaMode="ADD"/>
    </Button>
  </Frame></Ui>`);
  renderer.mount(loaded.roots);

  const button = bridge.getFrame("Ok");
  const picture = (state) => renderer.elementFor(button.stateTextures.get(state));
  const shown = (state) => picture(state).style.visibility !== "hidden";
  const role = (state) => picture(state).getAttribute("data-framexml-state-texture");

  // Every one of them says which state it is, so the stylesheet can reach the highlight on hover.
  assert.deepEqual(["NORMAL", "PUSHED", "DISABLED", "HIGHLIGHT"].map(role),
    ["NORMAL", "PUSHED", "DISABLED", "HIGHLIGHT"]);

  // Resting: the normal picture and nothing else. Measured on the owner's own chain, this is the
  // whole of "чёрные кнопки без материала" — `Glue-Panel-Button-Highlight` is opaque (α 255 over
  // 100 % of its crop, mean RGB 22/3/0), and it used to be painted over every button, always.
  assert.equal(shown("NORMAL"), true);
  assert.equal(shown("PUSHED"), false);
  assert.equal(shown("DISABLED"), false);
  assert.ok(!picture("HIGHLIGHT").style.visibility, "the highlight is left to the stylesheet's :hover");

  // Held down: the pushed picture replaces the normal one.
  bridge.update(button, (m) => { m.buttonState = "PUSHED"; });
  renderer.sync();
  assert.equal(shown("NORMAL"), false);
  assert.equal(shown("PUSHED"), true);
  bridge.update(button, (m) => { m.buttonState = "NORMAL"; });

  // Disabled: the disabled picture replaces it instead.
  bridge.update(button, (m) => { m.enabled = false; });
  renderer.sync();
  assert.equal(shown("NORMAL"), false);
  assert.equal(shown("DISABLED"), true);
  bridge.update(button, (m) => { m.enabled = true; });

  // `LockHighlight` is state rather than hover, so it wins over the stylesheet inline.
  bridge.update(button, (m) => { m.highlightLocked = true; });
  renderer.sync();
  assert.equal(picture("HIGHLIGHT").style.visibility, "visible");
  renderer.destroy();
});

test("a button with no disabled picture keeps showing its normal one", () => {
  const bridge = new FrameXmlUiBridge();
  const host = document.createElement("section");
  const renderer = new FrameXmlDomRenderer(host, { bridge });
  // `CharSelectCharacterButtonTemplate` is exactly this shape: one highlight and nothing else.
  const loaded = bridge.loadAddon(`<Ui><Frame name="Root">
    <Button name="Row">
      <NormalTexture file="Interface\\Glues\\Common\\Glue-Panel-Button-Up"/>
    </Button>
  </Frame></Ui>`);
  renderer.mount(loaded.roots);
  const button = bridge.getFrame("Row");
  const normal = renderer.elementFor(button.stateTextures.get("NORMAL"));
  bridge.update(button, (m) => { m.enabled = false; });
  renderer.sync();
  assert.notEqual(normal.style.visibility, "hidden",
    "with nothing to replace it, the normal picture stays — only the font changes");
  bridge.update(button, (m) => { m.buttonState = "PUSHED"; });
  renderer.sync();
  assert.notEqual(normal.style.visibility, "hidden");
  renderer.destroy();
});

test("SetRotation turns the picture and RegisterForClicks decides which press fires OnClick", () => {
  const bridge = new FrameXmlUiBridge();
  const host = document.createElement("section");
  const renderer = new FrameXmlDomRenderer(host, { bridge });
  const loaded = bridge.loadAddon(`<Ui><Frame name="Root">
    <Texture name="Logo" width="310" height="310"/>
    <Button name="Spin"/>
  </Frame></Ui>`);
  renderer.mount(loaded.roots);

  // `lgzg.lua` turns the login logo once per frame; CSS's positive angle runs the other way.
  bridge.update(bridge.getFrame("Logo"), (frame) => { frame.textureRotation = Math.PI / 2; });
  assert.match(find(host, "Logo").style.transform, /rotate\(-1\.5707963267948966rad\)/);

  const clicks = [];
  bridge.SetScript(bridge.getFrame("Spin"), "OnClick", (self, button, down) => {
    clicks.push(`${button}:${down}`);
  });
  const spin = find(host, "Spin");
  // With nothing registered, the browser's own click is the 3.3.5 default of LeftButtonUp.
  spin.dispatchEvent({ type: "click", button: 0 });
  assert.deepEqual(clicks, ["LeftButton:false"]);

  bridge.update(bridge.getFrame("Spin"), (frame) => {
    frame.clickRegistrations.clear();
    frame.clickRegistrations.add("LEFTBUTTONDOWN");
    frame.clickRegistrations.add("LEFTBUTTONUP");
  });
  clicks.length = 0;
  // Now the click event must stay silent and the press/release pair must speak instead: the
  // character-select rotation arrows spin while held and need both halves.
  spin.dispatchEvent({ type: "click", button: 0 });
  spin.dispatchEvent({ type: "mousedown", button: 0 });
  spin.dispatchEvent({ type: "mouseup", button: 0 });
  spin.dispatchEvent({ type: "mousedown", button: 2 });
  assert.deepEqual(clicks, ["LeftButton:true", "LeftButton:false"]);
  renderer.destroy();
});


test("Lua RegisterForClicks AnyUp and AnyDown dispatch real mouse events once per registered phase", async () => {
  const boot = new FrameXmlBoot({
    provider: createFixtureProvider({
      "interface/framexml/framexml.toc": "Clicks.xml",
      "interface/framexml/clicks.xml": `<Ui>
        <Frame name="UIParent"><Frames><Button name="Press"/></Frames></Frame>
        <Script file="Clicks.lua"/>
      </Ui>`,
      "interface/framexml/clicks.lua": `
        ClickLog = ""
        Press:RegisterForClicks("AnyUp", "LeftButtonUp")
        Press:SetScript("OnClick", function(self, button, down)
          ClickLog = ClickLog .. button .. ":" .. tostring(down) .. ";"
        end)
      `,
    }),
    subset: ["Clicks.xml"], exercise: false,
  });
  let renderer;
  try {
    await boot.load();
    const host = document.createElement("section");
    renderer = new FrameXmlDomRenderer(host, { bridge: boot.bridge });
    renderer.mount(boot.roots);
    const press = find(host, "Press");
    const click = (button) => {
      press.dispatchEvent({ type: "mousedown", button });
      press.dispatchEvent({ type: "mouseup", button });
      press.dispatchEvent({ type: "click", button });
    };
    click(0);
    click(2);
    assert.equal(boot.vm.getGlobal("ClickLog"), "LeftButton:false;RightButton:false;",
      "AnyUp covers right clicks; overlapping explicit registrations and DOM click must not duplicate OnClick");

    boot.vm.execute('ClickLog = ""; Press:RegisterForClicks("AnyDown")', "@any-down");
    click(0);
    click(1);
    assert.equal(boot.vm.getGlobal("ClickLog"), "LeftButton:true;MiddleButton:true;",
      "AnyDown fires on press and replaces the old release registration");
    boot.vm.execute('ClickLog = ""; Press:Disable()', "@disabled");
    click(0);
    assert.equal(boot.vm.getGlobal("ClickLog"), "", "disabled actions stay disabled");
    assert.deepEqual(boot.errors, []);
  } finally { renderer?.destroy(); boot.close(); }
});

test("an EditBox is a box with a text field inside it, so its own regions can draw", () => {
  const bridge = new FrameXmlUiBridge();
  // Exactly the shape `AccountLogin.xml` declares: a placeholder FontString in a BACKGROUND layer
  // and a bare `<FontString>` carrying the font, both *inside* the EditBox.
  const loaded = bridge.loadAddon(`<Ui><Frame name="Root">
    <Frames>
      <EditBox name="Account" letters="320" width="200" height="37">
        <Layers><Layer level="BACKGROUND">
          <FontString name="AccountFill" text="|cffB5AF80Account Name"/>
        </Layer></Layers>
        <TextInsets><AbsInset left="12" right="5" top="0" bottom="5"/></TextInsets>
      </EditBox>
    </Frames>
  </Frame></Ui>`);
  assert.equal(loaded.ok, true);
  const host = document.createElement("section");
  const renderer = new FrameXmlDomRenderer(host, { bridge });
  renderer.mount(loaded.roots);

  const account = find(host, "Account");
  assert.ok(account);
  // A <input> is a void element: rendered as one, every child below was laid out at 0x0 and the
  // login screen's two fields looked empty. Measured on the live page before this changed.
  assert.equal(account.tagName, "DIV");
  const input = account.children.find((child) => child.getAttribute("data-framexml-input") === "true");
  assert.ok(input, "the EditBox owns an <input>");
  assert.equal(input.tagName, "INPUT");
  assert.equal(input.getAttribute("maxlength"), "320");
  assert.equal(input.style.padding, "0px 5px 5px 12px", "TextInsets is the field's padding");

  // The placeholder is a real child of the box and carries its parsed colour.
  const fill = find(host, "AccountFill");
  assert.ok(fill, "the placeholder FontString is rendered");
  assert.equal(fill.parentElement, account);
  const run = fill.children[0];
  assert.equal(run.getAttribute("data-framexml-run"), "true");
  assert.equal(run.style.color, "#b5af80ff");
  assert.equal(run.textContent, "Account Name");

  // Typing goes to the field and reaches the bridge; the value is never run through the escape
  // parser, because a pipe is a character an account name may contain.
  input.value = "a|b";
  input.dispatchEvent({ type: "input" });
  assert.equal(bridge.getFrame("Account").text, "a|b");
  renderer.destroy();
});

test("OnMouseDown reaches a frame, and a press on a control inside it does not", () => {
  const bridge = new FrameXmlUiBridge();
  const loaded = bridge.loadAddon(`<Ui><Frame name="Scene" enableMouse="true">
    <Frames><Button name="Enter"/></Frames>
  </Frame></Ui>`);
  assert.equal(loaded.ok, true);
  const host = document.createElement("section");
  const renderer = new FrameXmlDomRenderer(host, { bridge });
  renderer.mount(loaded.roots);
  const presses = [];
  bridge.SetScript(bridge.getFrame("Scene"), "OnMouseDown", (self, button) => presses.push(`down:${button}`));
  bridge.SetScript(bridge.getFrame("Scene"), "OnMouseUp", (self, button) => presses.push(`up:${button}`));

  const scene = find(host, "Scene");
  const enter = find(host, "Enter");
  scene.dispatchEvent({ type: "mousedown", button: 0, target: scene });
  scene.dispatchEvent({ type: "mouseup", button: 0, target: scene });
  // `CharacterSelectFrame_OnMouseDown` starts the drag that turns the character; without these two
  // the character-select screen could not be turned at all.
  assert.deepEqual(presses, ["down:LeftButton", "up:LeftButton"]);

  presses.length = 0;
  // A press that landed on the button inside the scene belongs to the button: in FrameXML the
  // click stops there, and this event only reached the scene by bubbling.
  enter.closest = (selector) => (selector === "[data-framexml-type]" ? enter : undefined);
  scene.dispatchEvent({ type: "mousedown", button: 0, target: enter });
  assert.deepEqual(presses, []);
  renderer.destroy();
});

test("a shown toplevel frame rises above its strata, and a parentless Lua frame is drawn inside the root", () => {
  const bridge = new FrameXmlUiBridge();
  const host = document.createElement("section");
  const renderer = new FrameXmlDomRenderer(host, { bridge, createdRootParent: "GlueParent" });
  const loaded = bridge.loadAddon(`<Ui><Frame name="GlueParent">
    <Frames>
      <Frame name="ScreenOne" toplevel="true" hidden="true"/>
      <Frame name="ScreenTwo" toplevel="true" hidden="true"/>
    </Frames>
  </Frame></Ui>`);
  renderer.mount(loaded.roots);

  // The login module's rotating logo: `CreateFrame("Frame", nil, LoginScene)` at `lgzg.lua:146`,
  // where `LoginScene` is nil because the file is `<Script file="lgzg.lua"/>` inside
  // `AccountLogin.xml` and `LoginScene` is not assigned until `LoginScreen_OnLoad`. So the frame
  // really is parentless, and `SetFrameLevel(1)` puts it one above every screen.
  const logo = bridge.CreateFrame("Frame");
  bridge.update(logo, (mutable) => { mutable.frameLevel = 1; });
  renderer.sync();
  const logoElement = find(host, logo.name);
  assert.ok(logoElement, "the parentless frame is drawn");
  // Inside the root and not beside it: a DOM sibling of a root wins outright over that root's whole
  // subtree whatever the z-indexes inside it say, which is how a MEDIUM/1 logo drew over a HIGH
  // screen. Measured in the live page before this: logo z-index 3001 over AccountLogin's 4000.
  assert.equal(logoElement.parentElement, find(host, "GlueParent"));

  const one = bridge.getFrame("ScreenOne");
  const two = bridge.getFrame("ScreenTwo");
  assert.equal(one.toplevel, true, "the XML attribute is read");
  assert.equal(one.frameLevel, 0);

  // Showing a toplevel frame raises it over everything else in its strata — which on the glue
  // screens is what puts the screen just entered in front of the module's leftover logo.
  bridge.Show(one);
  assert.ok(one.frameLevel > logo.frameLevel, `${one.frameLevel} vs ${logo.frameLevel}`);
  const first = one.frameLevel;
  bridge.Show(two);
  assert.ok(two.frameLevel > first, `${two.frameLevel} vs ${first}`);

  // A second show does not walk the level upwards again: it is already the top of its strata.
  bridge.Hide(two);
  bridge.Show(two);
  assert.equal(two.frameLevel, first + 1);

  // A frame in another strata is not raised past by it, and does not raise past it either.
  bridge.update(one, (mutable) => { mutable.frameStrata = "LOW"; mutable.frameLevel = 0; });
  bridge.Hide(one);
  bridge.Show(one);
  assert.equal(one.frameLevel, 0, "nothing else is in LOW, so there is nothing to rise above");
  renderer.destroy();
});

test("EnableMouse lets addon card frames receive input through a transparent layout ancestor", () => {
  const bridge = new FrameXmlUiBridge();
  const loaded = bridge.loadAddon('<Ui><Frame name="LayoutAnchor"><Frames><Frame name="AddonCard" enableMouse="true"/></Frames></Frame></Ui>');
  const anchor = bridge.getFrame("LayoutAnchor");
  const card = bridge.getFrame("AddonCard");
  const host = document.createElement("section");
  const renderer = new FrameXmlDomRenderer(host, { bridge, layoutOnly: frame => frame === anchor });
  try {
    renderer.mount(loaded.roots);
    assert.equal(renderer.elementFor(anchor).style.pointerEvents, "none");
    assert.equal(renderer.elementFor(card).style.pointerEvents, "auto");
    bridge.update(card, frame => frame.setAttribute("enableMouse", "false"));
    assert.equal(renderer.elementFor(card).style.pointerEvents, "none");
    bridge.update(card, frame => frame.setAttribute("enableMouse", "true"));
    assert.equal(renderer.elementFor(card).style.pointerEvents, "auto");
    bridge.update(anchor, frame => frame.setAttribute("enableMouse", "true"));
    assert.equal(renderer.elementFor(anchor).style.pointerEvents, "none", "layout-only ancestors remain transparent");
  } finally { renderer.destroy(); }
});

test("layout-only stock ancestors never receive addon click or hover input", () => {
  const bridge = new FrameXmlUiBridge();
  const loaded = bridge.loadAddon(`<Ui><Button name="StockAnchor" width="120" height="120">
    <Frames><Button name="OwnAddonButton" width="30" height="30"/></Frames>
  </Button></Ui>`);
  const anchor = bridge.getFrame("StockAnchor");
  const addon = bridge.getFrame("OwnAddonButton");
  const calls = [];
  for (const event of ["OnClick", "OnMouseDown", "OnMouseUp", "OnEnter", "OnLeave"]) {
    bridge.SetScript(anchor, event, () => calls.push(`stock:${event}`));
  }
  for (const event of ["OnClick", "OnEnter", "OnLeave"]) {
    bridge.SetScript(addon, event, () => calls.push(`addon:${event}`));
  }
  let layoutOnly = true;
  const host = document.createElement("section");
  const renderer = new FrameXmlDomRenderer(host, { bridge, layoutOnly: (frame) => layoutOnly && frame === anchor });
  try {
    renderer.mount(loaded.roots);
    const stockElement = renderer.elementFor(anchor);
    const addonElement = renderer.elementFor(addon);
    assert.equal(stockElement.style.pointerEvents, "none");
    addonElement.closest = () => addonElement;
    addonElement.dispatchEvent({ type: "click", target: addonElement, button: 0 });
    // CSS pointer-events:none does not suppress an ancestor's listener when its child bubbles.
    stockElement.dispatchEvent({ type: "click", target: addonElement, button: 0 });
    stockElement.dispatchEvent({ type: "mousedown", target: addonElement, button: 0 });
    stockElement.dispatchEvent({ type: "mouseup", target: addonElement, button: 0 });
    stockElement.dispatchEvent({ type: "mouseenter", target: stockElement });
    addonElement.dispatchEvent({ type: "mouseenter", target: addonElement });
    addonElement.dispatchEvent({ type: "mouseleave", target: addonElement });
    stockElement.dispatchEvent({ type: "mouseleave", target: stockElement });
    bridge.update(anchor, (frame) => frame.clickRegistrations.add("LEFTBUTTONUP"));
    stockElement.dispatchEvent({ type: "mouseup", target: addonElement, button: 0 });
    assert.deepEqual(calls, ["addon:OnClick", "addon:OnEnter", "addon:OnLeave"],
      "Layout ancestors provide geometry without dispatching stock actions or tooltips");

    layoutOnly = false;
    bridge.touch();
    stockElement.dispatchEvent({ type: "mouseup", target: stockElement, button: 0 });
    assert.ok(calls.includes("stock:OnClick"), "The ordinary painted renderer retains registered clicks");
  } finally { renderer.destroy(); }
});

test("Lua addon windows clamp to a scaled viewport and drag through their original callbacks", async () => {
  const boot = new FrameXmlBoot({
    provider: createFixtureProvider({
      "interface/framexml/framexml.toc": "Windows.lua",
      "interface/framexml/windows.lua": `
        UIParent = CreateFrame("Frame", "UIParent")
        UIParent:SetSize(1248, 768)
        Main = CreateFrame("Frame", "Main", UIParent)
        Main:SetSize(1040, 600)
        Main:SetPoint("CENTER")
        Side = CreateFrame("Frame", "Side", UIParent)
        Side:SetSize(400, 500)
        Side:SetPoint("TOPLEFT", Main, "TOPRIGHT", 16, 0)
        Side:SetClampedToScreen(true)
        Side:SetMovable(true)
        Side:EnableMouse(true)
        Side:RegisterForDrag("LeftButton")
        DragStarts, DragStops = 0, 0
        Side:SetScript("OnDragStart", function(self)
          DragStarts = DragStarts + 1
          self:StartMoving()
        end)
        Side:SetScript("OnDragStop", function(self)
          DragStops = DragStops + 1
          self:StopMovingOrSizing()
        end)
      `,
    }), subset: ["Windows.lua"], exercise: false,
  });
  await boot.load();
  const host = document.createElement("section");
  const events = new Map();
  const doc = host.ownerDocument;
  const previous = [doc.addEventListener, doc.removeEventListener];
  doc.addEventListener = (type, listener) => {
    const set = events.get(type) ?? new Set(); set.add(listener); events.set(type, set);
  };
  doc.removeEventListener = (type, listener) => events.get(type)?.delete(listener);
  const send = (type, x, y, button = 0) => {
    for (const listener of [...(events.get(type) ?? [])]) listener({ type, clientX: x, clientY: y, button });
  };
  const countListeners = () => [...events.values()].reduce((sum, set) => sum + set.size, 0);
  const stage = { left: 80, top: 40, width: 624, height: 384 };
  host.offsetWidth = 1248; host.offsetHeight = 768;
  host.getBoundingClientRect = () => ({ ...stage, right: stage.left + stage.width, bottom: stage.top + stage.height });
  const renderer = new FrameXmlDomRenderer(host, { bridge: boot.bridge });
  const size = (frame) => ({ width: Number(frame.attributes.width) || 0, height: Number(frame.attributes.height) || 0 });
  // A deterministic layout seam in CSS UI units. Browser rectangles include the stage's 0.5 scale.
  // The bridge supplies authored anchor geometry; the renderer's final CSS translate moves it.
  const rect = (frame) => {
    const authored = boot.bridge.geometry(frame);
    const element = renderer.elementFor(frame);
    const shift = (element?.style.translate ?? "0px 0px").split(" ").map(parseFloat);
    const left = stage.left + (authored.left + (shift[0] || 0)) * 0.5;
    const top = stage.top + (768 - authored.top + (shift[1] || 0)) * 0.5;
    return { left, top, width: authored.width * 0.5, height: authored.height * 0.5,
      right: left + authored.width * 0.5, bottom: top + authored.height * 0.5 };
  };
  try {
    renderer.mount(boot.roots);
    for (const frame of boot.bridge.frames) {
      const node = renderer.elementFor(frame);
      if (!node) continue;
      Object.defineProperties(node, {
        offsetWidth: { get: () => size(frame).width }, offsetHeight: { get: () => size(frame).height },
      });
      node.getBoundingClientRect = () => rect(frame);
    }
    boot.bridge.touch();
    const side = boot.bridge.getFrame("Side");
    const node = renderer.elementFor(side);
    assert.equal(rect(side).right, stage.left + stage.width, "the side panel is fully inside the viewport");
    boot.vm.execute("Side:SetClampedToScreen(false)", "@unclamp");
    assert.ok(rect(side).right > stage.left + stage.width, "turning clamping off restores the authored anchor");
    boot.vm.execute("Side:SetClampedToScreen(true)", "@clamp");
    assert.equal(rect(side).right, stage.left + stage.width);
    const press = (button = 0) => node.dispatchEvent({ type: "mousedown", target: node,
      clientX: rect(side).left + 20, clientY: rect(side).top + 10, button });
    press(2);
    send("mousemove", 300, 200, 2); send("mouseup", 300, 200, 2);
    assert.equal(boot.vm.getGlobal("DragStarts"), 0, "unregistered mouse buttons cannot drag");
    const start = rect(side);
    press();
    send("mousemove", start.left - 30, start.top + 35);
    assert.equal(boot.vm.getGlobal("DragStarts"), 1);
    assert.equal(rect(side).left, start.left - 50, "mouse pixels convert to scaled UI units");
    assert.equal(rect(side).top, start.top + 25);
    send("mousemove", -1000, -1000);
    assert.equal(rect(side).left, stage.left);
    assert.equal(rect(side).top, stage.top);
    send("mouseup", -1000, -1000);
    assert.equal(boot.vm.getGlobal("DragStops"), 1, "release outside the element runs OnDragStop once");
    assert.equal(countListeners(), 0, "release removes capture listeners");
    assert.equal(side.points[0].point, "TOPLEFT");
    assert.equal(side.points[0].x, 0, "stopping commits the clamped position");
    assert.equal(side.points[0].y, 0);
    boot.bridge.touch();
    assert.equal(rect(side).left, stage.left, "a later layout keeps the dropped window in place");
    press(); send("mousemove", stage.left + 90, stage.top + 90);
    assert.ok(countListeners() > 0);
    boot.vm.execute("Side:Hide()", "@hide-dragging");
    assert.equal(countListeners(), 0, "hiding a window also releases capture");
    assert.equal(side.moving, false);
    boot.vm.execute("Side:Show()", "@show-draggable");
    press(); send("mousemove", stage.left + 120, stage.top + 120);
    assert.ok(countListeners() > 0);
    renderer.destroy();
    assert.equal(countListeners(), 0, "unmount during a drag releases document capture");
    const stoppedAtDestroy = boot.vm.getGlobal("DragStops");
    send("mouseup", 200, 200);
    assert.equal(boot.vm.getGlobal("DragStops"), stoppedAtDestroy, "no Lua callback survives renderer destruction");
    assert.deepEqual(boot.errors, []);
  } finally {
    renderer.destroy(); boot.close();
    [doc.addEventListener, doc.removeEventListener] = previous;
  }
});

test("addon tooltip descriptions wrap inside the frame and following lines grow its background", async () => {
  const boot = new FrameXmlBoot({ provider: createFixtureProvider({
    "interface/framexml/framexml.toc": "TooltipFonts.xml\nTooltip.lua",
    "interface/framexml/tooltipfonts.xml": '<Ui><FontString name="GameTooltipHeaderText" virtual="true"/><FontString name="GameTooltipText" virtual="true"/></Ui>',
    "interface/framexml/tooltip.lua": `
      UIParent = CreateFrame("Frame", "UIParent")
      UIParent:SetSize(1000, 600)
      Owner = CreateFrame("Button", "Owner", UIParent)
      GameTooltip = CreateFrame("GameTooltip", "GameTooltip", UIParent)
      function ShowAddonTooltip()
      GameTooltip:SetOwner(Owner, "ANCHOR_CURSOR")
      GameTooltip:SetText("Внутренний резерв (0/3)")
      GameTooltip:AddLine("Критические эффекты с вероятностью 33% за ранг восстанавливают 1% максимального здоровья. Не чаще раза в 5 секунд.", 1, 1, 1, true)
      GameTooltip:AddLine("5 очков ОСНОВА | Нужно: Закалка", 0.7, 0.7, 1, true)
      GameTooltip:Show()
      end
    `,
  }), subset: ["TooltipFonts.xml", "Tooltip.lua"], exercise: false });
  await boot.load();
  const host = document.createElement("section");
  const renderer = new FrameXmlDomRenderer(host, { bridge: boot.bridge });
  try {
    renderer.mount(boot.roots);
    boot.vm.execute("ShowAddonTooltip()", "@addon-tooltip");
    assert.deepEqual(boot.errors, []);
    const tooltip = boot.bridge.getFrame("GameTooltip");
    const description = boot.bridge.getFrame("GameTooltipTextLeft2");
    const requirement = boot.bridge.getFrame("GameTooltipTextLeft3");
    assert.equal(description.attributes.wordWrap, "true", "AddLine's fifth argument is the addon-authored wrap request");
    assert.deepEqual(requirement.textColor, { r: 0.7, g: 0.7, b: 1, a: 1 });
    const root = renderer.elementFor(tooltip);
    const second = renderer.elementFor(description);
    const third = renderer.elementFor(requirement);
    assert.equal(root.style.height, "auto", "a wrapped paragraph must expand the actual tooltip background");
    assert.ok(parseFloat(root.style.width) <= 360, "a description uses the readable tooltip width");
    assert.equal(second.style.position, "relative", "following rows must flow below wrapped lines, not fixed 14px anchors");
    assert.equal(second.style.whiteSpace, "pre-wrap");
    assert.equal(second.style.overflowWrap, "anywhere", "long unbroken names cannot escape the tooltip either");
    assert.equal(third.style.gridRow, "3");
    boot.vm.execute('GameTooltip:SetText("Короткая подсказка")', "@short-tooltip");
    assert.equal(renderer.elementFor(description).hidden, true, "shorter tooltip content releases the old paragraph");
    assert.equal(renderer.elementFor(requirement).hidden, true);
    assert.deepEqual(boot.errors, []);
  } finally { renderer.destroy(); boot.close(); }
});

test("original ANCHOR_CURSOR tooltips use the pointer, scale and viewport and release tracking", async () => {
  const boot = new FrameXmlBoot({ provider: createFixtureProvider({
    "interface/framexml/framexml.toc": "Cursor.lua",
    "interface/framexml/cursor.lua": `
      UIParent = CreateFrame("Frame", "UIParent")
      UIParent:SetSize(1000, 600)
      Owner = CreateFrame("Button", "Owner", UIParent)
      Owner:SetSize(100, 30)
      GameTooltip = CreateFrame("GameTooltip", "GameTooltip", UIParent)
      GameTooltip:SetScale(0.75)
      GameTooltip:Hide()
      Owner:SetScript("OnEnter", function(self)
        GameTooltip:SetOwner(self, "ANCHOR_CURSOR", 4, 6)
        GameTooltip:SetText("Companion ability")
      end)
      Owner:SetScript("OnLeave", function() GameTooltip:Hide() end)
    `,
  }), subset: ["Cursor.lua"], exercise: false });
  await boot.load();
  const host = document.createElement("section");
  const doc = host.ownerDocument;
  const events = new Map();
  const previous = [doc.addEventListener, doc.removeEventListener];
  doc.addEventListener = (type, listener) => {
    const set = events.get(type) ?? new Set(); set.add(listener); events.set(type, set);
  };
  doc.removeEventListener = (type, listener) => events.get(type)?.delete(listener);
  const send = (x, y) => {
    for (const listener of [...(events.get("mousemove") ?? [])]) listener({ type: "mousemove", clientX: x, clientY: y });
  };
  const viewport = { left: 80, top: 40, width: 500, height: 300, right: 580, bottom: 340 };
  host.getBoundingClientRect = () => viewport;
  host.offsetWidth = 1000; host.offsetHeight = 600;
  const renderer = new FrameXmlDomRenderer(host, { bridge: boot.bridge });
  try {
    renderer.mount(boot.roots);
    const root = renderer.elementFor(boot.bridge.getFrame("UIParent"));
    root.offsetWidth = 1000; root.offsetHeight = 600; root.getBoundingClientRect = () => viewport;
    const tooltip = boot.bridge.getFrame("GameTooltip");
    const element = renderer.elementFor(tooltip);
    Object.defineProperties(element, {
      offsetWidth: { get: () => Number(tooltip.attributes.width) || 0 },
      offsetHeight: { get: () => Number(tooltip.attributes.height) || 0 },
    });
    element.getBoundingClientRect = () => {
      const shift = (element.style.translate ?? "0px 0px").split(" ").map(parseFloat);
      const left = viewport.left + ((parseFloat(element.style.left) || 0) + (shift[0] || 0)) * 0.5;
      const top = viewport.top + ((parseFloat(element.style.top) || 0) + (shift[1] || 0)) * 0.5;
      const width = element.offsetWidth * tooltip.scale * 0.5;
      const height = element.offsetHeight * tooltip.scale * 0.5;
      return { left, top, width, height, right: left + width, bottom: top + height };
    };
    const owner = renderer.elementFor(boot.bridge.getFrame("Owner"));
    const enter = (x, y) => owner.dispatchEvent({ type: "mouseenter", target: owner, clientX: x, clientY: y });
    enter(300, 180);
    const rect = element.getBoundingClientRect();
    assert.ok(rect.left > 300 && rect.left < 320, "the tooltip is next to the cursor, not the owner's origin");
    assert.ok(rect.bottom < 180 && rect.bottom > 160, "tooltip height and local scale place it above the cursor");
    assert.equal(events.get("mousemove")?.size, 1);
    send(578, 42);
    const clamped = element.getBoundingClientRect();
    assert.ok(clamped.right <= viewport.right && clamped.left >= viewport.left);
    assert.ok(clamped.top >= viewport.top && clamped.bottom <= viewport.bottom);
    owner.dispatchEvent({ type: "mouseleave", target: owner });
    assert.equal(events.get("mousemove")?.size ?? 0, 0, "hidden cursor tooltips stop tracking");
    enter(320, 200);
    assert.equal(events.get("mousemove")?.size, 1);
    renderer.destroy();
    assert.equal(events.get("mousemove")?.size, 0, "destroy releases the active cursor listener");
    assert.deepEqual(boot.errors, []);
  } finally {
    renderer.destroy(); boot.close();
    [doc.addEventListener, doc.removeEventListener] = previous;
  }
});

const companionLuaPath = new URL("../../tswow-install/modules/default/datasets/dataset/luaxml/Interface/FrameXML/TSAddons/custom-companions/addon/addon.lua", import.meta.url);
test("published companion model rotation reads real cursor coordinates and releases outside its window", {
  skip: !existsSync(companionLuaPath),
}, async () => {
  const original = readFileSync(companionLuaPath, "utf8");
  const cursorCall = original.indexOf("local startX = GetCursorPosition()");
  const callbackStart = original.lastIndexOf("m:SetScript(", cursorCall);
  const callbackEnd = original.indexOf("parent:HookScript(", cursorCall);
  assert.ok(cursorCall >= 0 && callbackStart >= 0 && callbackEnd > callbackStart);
  const callbacks = original.slice(callbackStart, callbackEnd);
  assert.ok(callbacks.includes('"OnMouseUp"') && callbacks.includes("m:SetFacing"));
  const boot = new FrameXmlBoot({ provider: createFixtureProvider({
    "interface/framexml/framexml.toc": "Rotation.lua",
    "interface/framexml/rotation.lua": `
      UIParent = CreateFrame("Frame", "UIParent")
      UIParent:SetSize(1000, 600)
      Main = CreateFrame("Frame", "Main", UIParent)
      Main:SetSize(500, 400)
      Main:SetPoint("CENTER")
      Main:SetMovable(true)
      Main:RegisterForDrag("LeftButton")
      ParentDrags = 0
      Main:SetScript("OnDragStart", function(self) ParentDrags = ParentDrags + 1; self:StartMoving() end)
      Main:SetScript("OnDragStop", function(self) self:StopMovingOrSizing() end)
      local m = CreateFrame("DressUpModel", "OriginalPreview", Main)
      m:SetSize(250, 330)
      m:SetFacing(45)
      m:EnableMouse(true)
      ${callbacks}
    `,
  }), subset: ["Rotation.lua"], exercise: false });
  await boot.load();
  const host = document.createElement("section");
  host.offsetWidth = 1000; host.offsetHeight = 600;
  host.getBoundingClientRect = () => ({ left: 80, top: 40, width: 500, height: 300, right: 580, bottom: 340 });
  const doc = host.ownerDocument;
  const events = new Map();
  const previous = [doc.addEventListener, doc.removeEventListener];
  doc.addEventListener = (type, listener) => {
    const set = events.get(type) ?? new Set(); set.add(listener); events.set(type, set);
  };
  doc.removeEventListener = (type, listener) => events.get(type)?.delete(listener);
  const send = (type, x, y, target = host) => {
    for (const listener of [...(events.get(type) ?? [])]) listener({ type, clientX: x, clientY: y, target, button: 0 });
  };
  const count = () => [...events.values()].reduce((sum, set) => sum + set.size, 0);
  const renderer = new FrameXmlDomRenderer(host, { bridge: boot.bridge });
  try {
    renderer.mount(boot.roots);
    const model = boot.bridge.getFrame("OriginalPreview");
    const element = renderer.elementFor(model);
    const main = renderer.elementFor(boot.bridge.getFrame("Main"));
    element.closest = () => element;
    const press = () => {
      const down = { type: "mousedown", target: element, clientX: 300, clientY: 200, button: 0 };
      element.dispatchEvent(down);
      main.dispatchEvent(down); // Browser bubbling must not arm the parent window's drag.
    };
    press();
    send("mousemove", 350, 220);
    boot.bridge.tick(0.016);
    assert.equal(model.model.facing, 46, "50 physical pixels at half scale turn the original Lua model by one radian");
    boot.vm.execute("CursorX, CursorY = GetCursorPosition()", "@inspect-cursor");
    assert.equal(boot.vm.getGlobal("CursorX"), 540);
    assert.equal(boot.vm.getGlobal("CursorY"), 240, "cursor Y is measured from the logical screen bottom");
    assert.equal(boot.vm.getGlobal("ParentDrags"), 0, "model rotation does not also move its StoreStyle parent");
    send("mouseup", 900, 900);
    assert.equal(boot.bridge.GetScript(model, "OnUpdate"), undefined, "outside release invokes the original cleanup callback");
    assert.equal(count(), 0);
    send("mousemove", 100, 100); boot.bridge.tick(0.016);
    assert.equal(model.model.facing, 46, "released rotation remains stopped");
    press();
    boot.vm.execute("Main:Hide()", "@hide-rotating-preview");
    assert.equal(boot.bridge.GetScript(model, "OnUpdate"), undefined, "hide cannot leave a rotation callback armed for the next opening");
    assert.equal(count(), 0);
    boot.vm.execute("Main:Show()", "@reopen-preview");
    press();
    assert.ok(count() > 0);
    renderer.destroy();
    assert.equal(count(), 0);
    assert.equal(boot.bridge.GetScript(model, "OnUpdate"), undefined, "renderer teardown also completes the original gesture");
    boot.bridge.tick(0.016);
    assert.equal(model.model.facing, 46);
    assert.deepEqual(boot.errors, []);
  } finally {
    renderer.destroy(); boot.close();
    [doc.addEventListener, doc.removeEventListener] = previous;
  }
});
