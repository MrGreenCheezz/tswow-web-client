import assert from "node:assert/strict";
import test, { after } from "node:test";
import { readFileSync } from "node:fs";
import { installFakeUiDocument } from "./fixtures/fake-ui-document.mjs";

// FrameXmlWorldMount.js imports the native interface, which resolves its element handles at import.
installFakeUiDocument();

// 06.10-dropdown: the owner saw an empty dropdown box (frame + yellow arrow) above the stock
// PlayerFrame in the world; Wow.exe shows nothing there.
//
// Not the unit dropdowns: PlayerFrame.xml declares PlayerFrameDropDown hidden="true" and
// UIDropDownMenu_Initialize(..., "MENU") hides the template's Left/Middle/Right and empties the
// button's textures (UIDropDownMenu.lua:73-85) — the first test keeps that pinned. The box is
// Blizzard_CombatLog.xml:6 `<Frame name="CombatLogDropDown" inherits="UIDropDownMenuTemplate"/>`:
// shown, parentless, no anchors. The world loads the combat log before mounting (3.01), admits the
// addon's visible roots, and the renderer laid the unanchored root out at the stage's top-left. A
// frame without an anchor point has no rectangle in Wow.exe and draws nothing.
let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine", concurrency: false };
const { clientArchives } = await import("../tools/mpq.mjs");
const chain = clientDirectory ? await clientArchives(clientDirectory) : undefined;
after(() => chain?.close());

const { FrameXmlBoot, FRAMEXML_VERTICAL_EXERCISE_EVENTS } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { loadFrameXmlCombatLog } = await import("../dist/code/browser/framexml/FrameXmlCombatLogOwner.js");
const { selectFrameXmlWorldRoots } = await import("../dist/code/browser/framexml/FrameXmlWorldMount.js");
const { createFixtureProvider } = await import("../dist/code/browser/glue/GlueLoader.js");
const { FrameXmlDomRenderer } = await import("../dist/code/browser/ui/framexml_compat/FrameXmlDomRenderer.js");
const decoder = new TextDecoder("utf-8");

/** The tiny DOM seam of framexml-dom.test.mjs: every operation the renderer uses, nothing more. */
function fakeDocument() {
  const doc = {
    createElement: (tag) => make(tag),
    createElementNS: (_namespace, tag) => make(tag),
  };
  function make(tag) {
    const attributes = new Map();
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
      ownerDocument: doc, tagName: tag.toUpperCase(), children: [], parentElement: undefined, style,
      dataset: {}, hidden: false, className: "", src: "", textContent: "", value: "", disabled: false,
      classList: { add() {} },
      addEventListener() {},
      setAttribute(name, value) { attributes.set(name, String(value)); },
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
const renderDocument = fakeDocument();

function render(boot, roots, options = {}) {
  const host = renderDocument.createElement("section");
  const renderer = new FrameXmlDomRenderer(host, { bridge: boot.bridge, includeCreatedRoots: false, ...options });
  renderer.mount(roots);
  return renderer;
}

function hiddenOf(renderer, boot, name) {
  const element = renderer.elementFor(boot.bridge.getFrame(name));
  return element === undefined ? "unmounted" : element.hidden;
}

function run(boot, code) {
  const ran = boot.vm.execute(code, "@unit-dropdown-hidden");
  assert.equal(ran.ok, true, ran.error);
}

function luaString(boot, code) {
  run(boot, `__dropdown_probe = tostring((function() ${code} end)())`);
  return String(boot.vm.getGlobal("__dropdown_probe"));
}

const UNIT_DROPDOWNS = ["PlayerFrameDropDown", "TargetFrameDropDown", "FocusFrameDropDown", "PartyMemberFrame1DropDown"];

test("06.10-dropdown: MPQ — unit MENU dropdowns stay hidden, the portrait menu opens, CombatLogDropDown is not drawn", withClient, async () => {
  const seam = new CannedWorldSeam();
  const boot = new FrameXmlBoot({
    provider: { async read(path) { const data = await chain.read(path); return data ? decoder.decode(data) : undefined; } },
    locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam,
    exerciseEvents: FRAMEXML_VERTICAL_EXERCISE_EVENTS, screen: () => ({ width: 1920, height: 1080 }),
  });
  const renderers = [];
  try {
    await boot.load();
    for (const name of UNIT_DROPDOWNS) {
      const state = luaString(boot, `
        local f = _G["${name}"]
        if not f then return "missing" end
        local out = { "shown=" .. (f:IsShown() and "1" or "0"), "visible=" .. (f:IsVisible() and "1" or "0"),
          "mode=" .. tostring(f.displayMode) }
        for _, suffix in ipairs({ "Left", "Middle", "Right" }) do
          local r = _G["${name}" .. suffix]
          out[#out + 1] = suffix .. "=" .. (r and (r:IsShown() and "1" or "0") or "nil")
        end
        out[#out + 1] = "normal=" .. tostring(_G["${name}ButtonNormalTexture"]:GetTexture())
        return table.concat(out, ",")
      `);
      assert.equal(state, "shown=0,visible=0,mode=MENU,Left=0,Middle=0,Right=0,normal=nil", `${name}: ${state}`);
    }
    // Right-click on the player portrait (PlayerFrame.lua:46) still opens the SELF menu.
    run(boot, `CloseDropDownMenus() ToggleDropDownMenu(1, nil, PlayerFrameDropDown, "PlayerFrame", 106, 27)`);
    const menu = luaString(boot, `return (DropDownList1:IsShown() and "1" or "0") .. ":"
      .. tostring(UIDROPDOWNMENU_OPEN_MENU and UIDROPDOWNMENU_OPEN_MENU:GetName()) .. ":" .. tostring(DropDownList1.numButtons or 0)`);
    const [open, owner, count] = menu.split(":");
    assert.equal(open, "1", menu);
    assert.equal(owner, "PlayerFrameDropDown", menu);
    assert.ok(Number(count) > 0, menu);
    run(boot, "CloseDropDownMenus()");

    // The culprit: the combat log the world mount loads before it mounts (FrameXmlWorldMount.ts, 3.01).
    assert.equal(await loadFrameXmlCombatLog(boot), true);
    const dropdown = boot.bridge.getFrame("CombatLogDropDown");
    assert.equal(dropdown?.name, "CombatLogDropDown");
    assert.equal(dropdown.parent?.name, undefined, "declared without a parent");
    assert.equal(dropdown.points.length, 0, "declared without an anchor");
    assert.equal(dropdown.visible, true, "declared shown");
    const admitted = selectFrameXmlWorldRoots(boot.roots, boot.addonRootNames).map((root) => root.name);
    assert.ok(admitted.includes("CombatLogDropDown"), "the world admits it as an add-on root");

    // The defect shape (renderer default): the unanchored root and its template art are drawn.
    const plain = render(boot, [dropdown]);
    renderers.push(plain);
    assert.equal(hiddenOf(plain, boot, "CombatLogDropDown"), false);
    assert.equal(hiddenOf(plain, boot, "CombatLogDropDownMiddle"), false);
    // The world mount's renderer: no rectangle, nothing drawn, while Lua still sees it shown.
    const world = render(boot, [dropdown], { unanchoredRootsUndrawn: true });
    renderers.push(world);
    assert.equal(hiddenOf(world, boot, "CombatLogDropDown"), true);
    assert.equal(luaString(boot, "return CombatLogDropDown:IsShown() and 1 or 0"), "1");
    // Its menu still opens at the cursor (Blizzard_CombatLog.lua:3570's EasyMenu).
    run(boot, `EasyMenu({ { text = "x", notCheckable = 1 } }, CombatLogDropDown, "cursor", nil, nil, "MENU")`);
    assert.equal(luaString(boot, "return DropDownList1:IsShown() and 1 or 0"), "1");
  } finally {
    for (const renderer of renderers) renderer.destroy();
    boot.close();
  }
});

test("06.10-dropdown: an unanchored root is undrawn until SetPoint, an anchored one is drawn", async () => {
  const boot = new FrameXmlBoot({
    exercise: false,
    provider: createFixtureProvider({
      "interface/framexml/framexml.toc": "frames.xml",
      "interface/framexml/frames.xml": `<Ui>
        <Frame name="Loose"><Size x="40" y="32"/>
          <Layers><Layer><Texture name="LooseArt"><Size x="25" y="64"/>
            <Anchors><Anchor point="TOPLEFT"/></Anchors></Texture></Layer></Layers>
          <Frames><Button name="LooseButton"><Size x="24" y="24"/><Anchors><Anchor point="TOPRIGHT"/></Anchors></Button></Frames>
        </Frame>
        <Frame name="Placed"><Size x="40" y="32"/><Anchors><Anchor point="CENTER"/></Anchors></Frame>
      </Ui>`,
    }),
  });
  const renderers = [];
  try {
    await boot.load();
    const roots = ["Loose", "Placed"].map((name) => boot.bridge.getFrame(name));
    const world = render(boot, roots, { unanchoredRootsUndrawn: true });
    renderers.push(world);
    assert.equal(hiddenOf(world, boot, "Loose"), true, "no anchor, no rectangle");
    assert.equal(hiddenOf(world, boot, "Placed"), false, "an anchored root is drawn");
    run(boot, `Loose:SetPoint("TOPLEFT", 10, -10)`);
    world.sync();
    assert.equal(hiddenOf(world, boot, "Loose"), false, "SetPoint gives it a rectangle");
    assert.equal(hiddenOf(world, boot, "LooseButton"), false, "and its child is drawn with it");
    run(boot, "Loose:ClearAllPoints()");
    world.sync();
    assert.equal(hiddenOf(world, boot, "Loose"), true, "ClearAllPoints takes it away again");
    // Glue and the fixture suites keep the historical default.
    const plain = render(boot, roots);
    renderers.push(plain);
    assert.equal(hiddenOf(plain, boot, "Loose"), false);
  } finally {
    for (const renderer of renderers) renderer.destroy();
    boot.close();
  }
});

test("06.10-dropdown: the world mount's renderer is the one that undraws unanchored roots", () => {
  const source = readFileSync(new URL("../src/browser/framexml/FrameXmlWorldMount.ts", import.meta.url), "utf8");
  assert.match(source, /new FrameXmlDomRenderer\(stage, \{[\s\S]{0,1200}unanchoredRootsUndrawn: !options\.addonsOnly,/);
});
