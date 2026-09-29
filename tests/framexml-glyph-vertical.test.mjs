import assert from "node:assert/strict";
import test, { after } from "node:test";

// MPQ-backed: the real Blizzard_TalentUI and Blizzard_GlyphUI loaded on demand by the lazy stock
// talent owner and its glyph extension (FrameXmlWorldMount.ts, FrameXmlGlyphOwner.ts) over the vertical
// corpus and the canned glyph fixture (FrameXmlGlyphCanned.ts): the TOGGLEINSCRIPTION entry, the
// «Символы» tab over the six sockets, a glyph item's USE_GLYPH → cursor → PlaceGlyphInSocket, the
// removal, the GLYPH_* edges and the socket tooltip.

// FrameXmlWorldMount imports the normal UI module graph; give it a harmless DOM while it evaluates.
const style = { setProperty() {}, removeProperty() {} };
const classList = { add() {}, remove() {}, toggle() { return false; }, contains() { return false; } };
const domNode = () => new Proxy({
  style, classList, dataset: {}, children: [], hidden: false, value: "", textContent: "",
  querySelector: () => domNode(), querySelectorAll: () => [], addEventListener() {}, removeEventListener() {},
  append() {}, appendChild() {}, replaceChildren() {}, remove() {}, setAttribute() {}, getAttribute: () => null,
  removeAttribute() {}, getContext: () => ({ setTransform() {}, clearRect() {} }),
}, { get(target, property) {
  if (property in target) return target[property];
  if (property === "ownerDocument") return globalThis.document;
  if (property === "parentNode" || property === "parentElement" || property === "nextSibling") return null;
  if (property === "clientWidth" || property === "clientHeight") return 1024;
  if (property === "getBoundingClientRect") return () => ({ left: 0, top: 0, width: 0, height: 0 });
  if (property === "focus" || property === "blur" || property === "click") return () => {};
  return undefined;
} });
const documentNode = domNode();
globalThis.document = {
  head: documentNode, body: documentNode, documentElement: documentNode, createElement: () => domNode(),
  getElementById: () => domNode(), querySelector: () => domNode(), querySelectorAll: () => [],
};
globalThis.window = {
  innerWidth: 1024, innerHeight: 768, devicePixelRatio: 1, location: { protocol: "http:", hostname: "localhost" },
  addEventListener() {}, removeEventListener() {}, requestAnimationFrame: () => 1, cancelAnimationFrame() {},
};
globalThis.location = globalThis.window.location;
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

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

const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { createLazyFrameXmlTalentOwner } = await import("../dist/code/browser/framexml/FrameXmlWorldMount.js");
const { createFrameXmlGlyphExtension } = await import("../dist/code/browser/framexml/FrameXmlGlyphOwner.js");
const { publishFrameXmlTalent, frameXmlTalentOpen } = await import(
  "../dist/code/browser/framexml/FrameXmlTalentController.js");
const decoder = new TextDecoder("utf-8");

function renderer() {
  const elements = new Map();
  return {
    elementFor(frame) {
      if (!elements.has(frame)) {
        const attributes = new Map([["data-framexml-name", frame.name], ["data-framexml-type", frame.type]]);
        elements.set(frame, { dataset: {}, getAttribute: (name) => attributes.get(name) ?? null });
      }
      return elements.get(frame);
    },
    addRoots() {},
    sync() {},
  };
}

function lua(boot, code, results = 1) {
  const fn = boot.vm.compileFunction(code, "glyph-test", []);
  assert.ok(fn, `compiles: ${code.slice(0, 60)}`);
  try { return boot.vm.call(fn, [], results); } finally { boot.vm.release(fn); }
}

const settle = async () => { for (let i = 0; i < 40; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); };
/**
 * Lua failures from the glyph add-on or this lane's chunks. Blizzard_TalentUI.lua:968 (PlayerSpecTab's
 * GetCheckedTexture on a CheckButton with none) is the talent frame's own, raised with or without glyphs.
 */
const glyphErrors = (boot, from) => boot.errors.slice(from)
  .filter((error) => /glyph|sparkle|talentframebase|talentframetemplates/i.test(String(error.file)))
  .map((error) => `${error.file}:${error.line} ${error.message}`);

async function mounted() {
  const seam = new CannedWorldSeam();
  const reads = [];
  const boot = new FrameXmlBoot({
    provider: {
      async read(path) {
        const data = await chain.read(path);
        if (data) reads.push(path.toLowerCase().replaceAll("\\", "/"));
        return data ? decoder.decode(data) : undefined;
      },
    },
    locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam, exercise: true, screen: () => ({ width: 1365, height: 768 }),
  });
  await boot.load();
  const view = renderer();
  const failures = [];
  const extension = createFrameXmlGlyphExtension({ seam, boot, renderer: view, onFailure: (reason) => failures.push(reason) });
  assert.ok(extension, "the UIParent entry points were taken over");
  const owner = createLazyFrameXmlTalentOwner(seam, boot, view, () => failures.push("talent"), extension);
  const cleanup = publishFrameXmlTalent(owner);
  return { seam, boot, reads, extension, owner, cleanup, failures };
}

test("TOGGLEINSCRIPTION loads both add-ons, opens the talent frame on its «Символы» tab and draws the sockets", withClient, async () => {
  const { seam, boot, reads, extension, owner, cleanup, failures } = await mounted();
  try {
    const errors = boot.errors.length;
    assert.equal(boot.bridge.getFrame("GlyphFrame")?.name, undefined, "nothing loads at boot");
    assert.equal(seam.glyphs.owned, true, "a glyph item raises the glyph cursor from publication on");
    lua(boot, "ToggleGlyphFrame()", 0);
    await settle();
    assert.deepEqual(failures, []);
    assert.equal(extension.state, "ready");
    assert.ok(reads.includes("interface/addons/blizzard_glyphui/blizzard_glyphui.lua"));
    assert.ok(reads.includes("interface/framexml/sparkleframe.lua"), "SparkleFrame.xml ran before the add-on");
    const glyphFrame = boot.bridge.getFrame("GlyphFrame");
    const talent = boot.bridge.getFrame("PlayerTalentFrame");
    assert.equal(glyphFrame.parent, talent, "GlyphFrame_OnEvent(ADDON_LOADED) parented it to PlayerTalentFrame");
    assert.equal(owner.isOpen(), true);
    assert.equal(frameXmlTalentOpen(), true);
    assert.equal(glyphFrame.visible, true, "GlyphFrame_Toggle selected the glyph tab");
    const [tab, title] = lua(boot, "return PanelTemplates_GetSelectedTab(PlayerTalentFrame), GlyphFrameTitleText:GetText()", 2);
    assert.equal(tab, 4, "GLYPH_TALENT_TAB");
    assert.equal(title, "Символы", "one talent group: GLYPHS (Blizzard_TalentUI.lua:205-209)");
    // GlyphFrameGlyph_UpdateSlot over GetGlyphSocketInfo: the canned mage is level 60 (sockets 1-4 open).
    const [rune1, rune2, shown3, locked5, glyph3] = lua(boot, `
      return GlyphFrameGlyph1Glyph:GetTexture(), GlyphFrameGlyph2Glyph:GetTexture(),
        GlyphFrameGlyph3Background:IsShown() and 1 or 0, GlyphFrameGlyph5Setting:GetTexture(),
        GlyphFrameGlyph3Glyph:IsShown() and 1 or 0
    `, 5);
    assert.match(String(rune1), /UI-Glyph-Rune-11$/i, "socket 1: Glyph of Frostbolt's SpellIcon");
    assert.match(String(rune2), /UI-Glyph-Rune-20$/i, "socket 2: Glyph of Slow Fall's SpellIcon");
    assert.equal(shown3, 1, "socket 3 open and empty");
    assert.equal(glyph3, 0);
    assert.match(String(locked5), /UI-GlyphFrame-Locked$/i, "socket 5 locked until 70");
    const [major, minor] = lua(boot, "return GlyphFrameGlyph1.glyphType, GlyphFrameGlyph3.glyphType", 2);
    assert.deepEqual([major, minor], [1, 2], "GlyphSlot.Type 0/1 as GLYPHTYPE_MAJOR/MINOR");
    assert.deepEqual(glyphErrors(boot, errors), []);

    lua(boot, "ToggleGlyphFrame()", 0);
    await settle();
    assert.equal(talent.visible, false, "a second press on the glyph tab closes the talent frame (stock toggle)");
    assert.deepEqual(glyphErrors(boot, errors), []);
  } finally {
    cleanup();
    boot.close();
  }
});

test("a glyph item: USE_GLYPH opens the tab, the cursor matches its kind, the click inscribes it, Shift-right-click removes", withClient, async () => {
  const { seam, boot, extension, cleanup, failures } = await mounted();
  try {
    const errors = boot.errors.length;
    // The first use loads everything through OpenGlyphFrame (UIParent.lua:1053-1054 → the hook).
    assert.equal(seam.glyphWorld.use(56593), true, "Glyph of Ice Lance, a major glyph");
    await settle();
    assert.deepEqual(failures, []);
    assert.equal(extension.state, "ready");
    assert.equal(boot.bridge.getFrame("GlyphFrame").visible, true, "USE_GLYPH opened the glyph tab");
    const [targeting, matches] = lua(boot, `
      local matches = {}
      for index = 1, 6 do matches[#matches + 1] = GlyphMatchesSocket(index) and 1 or 0 end
      return SpellIsTargeting() and 1 or 0, table.concat(matches, "")
    `, 2);
    assert.equal(targeting, 1);
    assert.equal(matches, "100100", "major sockets 1 and 4 are open at 60");

    lua(boot, `GlyphFrameGlyph_OnClick(GlyphFrameGlyph4, "LeftButton")`, 0);
    seam.tick(1);
    assert.deepEqual(seam.glyphWorld.sent, [["place", 322, 3]], "PlaceGlyphInSocket(4): the item with socket index 3");
    assert.deepEqual(seam.glyphWorld.sockets(), [319, 451, 0, 322, 0, 0]);
    const [spell4, targetingAfter] = lua(boot,
      `return select(3, GetGlyphSocketInfo(4)), SpellIsTargeting() and 1 or 0`, 2);
    assert.equal(spell4, 56377, "GLYPH_ADDED(4) redrew the socket from the realm's answer");
    assert.equal(targetingAfter, 0, "the cursor is spent");
    assert.match(String(lua(boot, "return GlyphFrameGlyph4Glyph:GetTexture()")[0]), /UI-Glyph-Rune-20$/i);

    // GlyphFrameGlyph_OnClick's Shift-right-click shows CONFIRM_REMOVE_GLYPH; its OnAccept removes.
    lua(boot, `
      local dialog = StaticPopup_Show("CONFIRM_REMOVE_GLYPH", "x")
      dialog.data = 1
      StaticPopupDialogs["CONFIRM_REMOVE_GLYPH"].OnAccept(dialog)
      StaticPopup_Hide("CONFIRM_REMOVE_GLYPH")
    `, 0);
    seam.tick(2);
    assert.deepEqual(seam.glyphWorld.sent.at(-1), ["remove", 0]);
    assert.equal(lua(boot, "return select(3, GetGlyphSocketInfo(1))")[0], undefined, "GLYPH_REMOVED(1)");
    assert.equal(lua(boot, "return GlyphFrameGlyph1Glyph:IsShown() and 1 or 0")[0], 0);

    // The socket tooltip (GameTooltip:SetGlyph) over GlobalStrings.lua.
    const [emptyTitle, lockedTitle, lockedLine] = lua(boot, `
      GlyphFrameGlyph_OnEnter(GlyphFrameGlyph3)
      local empty = GameTooltipTextLeft1:GetText()
      GlyphFrameGlyph_OnLeave(GlyphFrameGlyph3)
      GlyphFrameGlyph_OnEnter(GlyphFrameGlyph6)
      local locked, line = GameTooltipTextLeft1:GetText(), GameTooltipTextLeft3:GetText()
      GlyphFrameGlyph_OnLeave(GlyphFrameGlyph6)
      return empty, locked, line
    `, 3);
    assert.equal(emptyTitle, "Свободно", "GLYPH_EMPTY");
    assert.equal(lockedTitle, "Заблокировано", "GLYPH_LOCKED");
    assert.equal(lockedLine, "Требуется 80-й уровень", "GLYPH_SLOT_TOOLTIP6");

    // Escape: stock ToggleGameMenu stops at SpellStopTargeting first.
    seam.glyphWorld.use(58241);
    assert.equal(lua(boot, "return SpellStopTargeting() and 1 or 0, SpellIsTargeting() and 1 or 0", 2).join(","), "1,0");
    assert.deepEqual(glyphErrors(boot, errors), []);
  } finally {
    cleanup();
    boot.close();
  }
});

test("dispose gives the UIParent entry points back and a glyph item is used as before", withClient, async () => {
  const { seam, boot, extension, owner, cleanup } = await mounted();
  try {
    lua(boot, "__glyphTestHooked = ToggleGlyphFrame", 0);
    cleanup();
    owner.dispose();
    assert.equal(extension.state, "disposed");
    assert.equal(seam.glyphs.owned, false);
    assert.equal(seam.glyphWorld.use(56593), false, "no USE_GLYPH without the stock owner");
    assert.equal(lua(boot, "return (ToggleGlyphFrame ~= __glyphTestHooked and type(ToggleGlyphFrame) == 'function') and 1 or 0")[0], 1,
      "the stock function is back");
  } finally {
    boot.close();
  }
});
