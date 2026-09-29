import assert from "node:assert/strict";
import test, { after } from "node:test";

// The real Blizzard_TokenUI from the client's MPQs — CharacterFrame's «Валюта» (tab 5) and the
// backpack token strip — loaded on demand by the token owner (FrameXmlTokenOwner.ts) over the vertical
// corpus and the canned currencies (FrameXmlCurrencyCanned.ts): nothing at boot, the load through the
// host instead of stock's UIParentLoadAddOn, the gate, MainMenuBar's own KNOWN_CURRENCY_TYPES_UPDATE
// handler from the released events, and the stock window's rows, headings, popup and backpack strip.
let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}
const skip = clientDirectory ? false : "no 3.3.5a client on this machine";

// FrameXmlCharacterController imports Portraits for its model gate, which reads the page at import;
// the owner under test never touches it. The same tiny bootstrap as framexml-character-controller.
const elements = new Map();
const makeElement = () => ({
  value: "", hidden: true, parentElement: undefined, parentNode: undefined, dataset: {}, className: "",
  style: {}, width: 0, height: 0, children: [], remove() {},
  append(child) { child.parentElement = this; child.parentNode = this; this.children.push(child); },
  insertBefore(child) { child.parentElement = this; child.parentNode = this; this.children.push(child); },
  querySelector(selector) { return selector === 'button[type="submit"]' ? makeElement() : undefined; },
});
globalThis.location ??= { protocol: "http:", hostname: "localhost" };
globalThis.document ??= {
  getElementById(id) {
    if (!elements.has(id)) elements.set(id, makeElement());
    return elements.get(id);
  },
  createElement() { return makeElement(); },
  querySelectorAll() { return []; },
};
globalThis.window ??= { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {} };

const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { createFrameXmlCharacterOwner } = await import("../dist/code/browser/framexml/FrameXmlCharacterController.js");
const { FRAMEXML_TOKEN_ADDON, mountFrameXmlToken } = await import("../dist/code/browser/framexml/FrameXmlTokenOwner.js");

const decoder = new TextDecoder("utf-8");
const normalize = (path) => path.replaceAll("\\", "/").toLowerCase();
const ADDON_PREFIX = "interface/addons/blizzard_tokenui/";

// tools/mpq.mjs shares one chain per client directory across the process: close it once, at the end.
let sharedChain;
after(() => sharedChain?.close());

function lua(boot, code, count = 1) {
  const fn = boot.vm.compileFunction(code, "currency-test", []);
  assert.ok(fn, "the probe compiles");
  try { return boot.vm.call(fn, [], count); } finally { boot.vm.release(fn); }
}

function frame(boot, name) {
  const value = boot.bridge.getFrame(name);
  assert.ok(value, `${name} exists`);
  return value;
}

/** The vertical over the canned seam; `missing` answers no add-on file. */
async function stage({ missing = false, known } = {}) {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const chain = sharedChain ??= await clientArchives(clientDirectory);
  const requests = [];
  const seam = new CannedWorldSeam();
  if (known !== undefined) seam.currencyWorld.knownMask = known;
  const boot = new FrameXmlBoot({
    provider: {
      async read(path) {
        const key = normalize(path);
        requests.push(key);
        if (missing && key.startsWith(ADDON_PREFIX)) return undefined;
        const data = await chain.read(path);
        return data ? decoder.decode(data) : undefined;
      },
    },
    locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam, exercise: false, screen: () => ({ width: 1024, height: 768 }),
  });
  await boot.load();
  const roots = [];
  const renderer = { addRoots(list) { roots.push(...list); }, sync() {} };
  // Every stock message() — UIParentLoadAddOn's «Ошибка загрузки» goes through it.
  lua(boot, `__currencyMessages = {}
    local say = message
    message = function(text, ...) __currencyMessages[#__currencyMessages + 1] = tostring(text) return say(text, ...) end`, 0);
  return { seam, boot, renderer, roots, requests };
}

test("MPQ Blizzard_TokenUI: loaded by the host on demand, gated, and fed by the currency model", { skip }, async () => {
  const { seam, boot, renderer, roots, requests } = await stage();
  try {
    assert.equal(requests.some((path) => path.startsWith(ADDON_PREFIX)), false, "nothing of the add-on loads at boot");
    assert.deepEqual(lua(boot, "return type(TokenFrame), TokenFrame.hidden, CharacterFrameTab5:IsShown()", 3),
      ["table", true, false], "the inert placeholder stands and tab 5 is hidden");
    const character = frame(boot, "CharacterFrame");
    const owner = createFrameXmlCharacterOwner(boot, character);
    owner.showTab("TokenFrame");
    assert.equal(character.visible, false, "asking for the placeholder is a no-op, not a demotion");

    const mounted = mountFrameXmlToken(seam, boot, renderer);
    assert.ok(mounted, "UIParent.lua's TokenFrame_LoadUI is there to take over");
    assert.equal(mounted.owner.state, "loading", "the canned player knows currencies: the load starts at once");
    await mounted.owner.settled();
    assert.equal(mounted.owner.state, "ready");
    for (const file of ["blizzard_tokenui.toc", "blizzard_tokenui.lua", "blizzard_tokenui.xml", "localization.lua"]) {
      assert.ok(requests.includes(ADDON_PREFIX + file), `${file} is read from the MPQ chain`);
    }
    assert.deepEqual(roots, [], "every Blizzard_TokenUI frame hangs from CharacterFrame or UIParent");
    assert.equal(boot.errorCount, 0, "load, gate and the released events raise nothing");
    assert.deepEqual(lua(boot, "return #__currencyMessages", 1), [0], "stock's load-error dialog never ran");

    const token = frame(boot, "TokenFrame");
    assert.equal(token.parent, character);
    assert.equal(token.id, 5);
    assert.deepEqual(lua(boot, `return CharacterFrameTab5:IsShown(), GetCVar("showTokenFrame"), GetCVar("showTokenFrameHonor"),
      BackpackTokenFrame:IsShown()`, 4), [true, "1", "1", false],
    "MainMenuBar's handler saw normal and PvP tokens, and tab 5 is shown by stock TokenFrame_Update");

    owner.showTab("TokenFrame");
    assert.equal(character.visible && token.visible, true, "the character owner opens tab 5");
    assert.equal(frame(boot, "PaperDollFrame").visible, false);
    const text = (name) => frame(boot, name).text;
    assert.equal(text("TokenFrameContainerButton1"), "PvP", "a heading is the button's own text");
    assert.equal(text("TokenFrameContainerButton2Name"), "Очки арены");
    assert.equal(text("TokenFrameContainerButton2Count"), "0");
    assert.equal(text("TokenFrameContainerButton3Name"), "Очки чести");
    assert.equal(text("TokenFrameContainerButton3Count"), "1500");
    assert.equal(text("TokenFrameContainerButton4"), "Подземелья и рейды");
    assert.equal(text("TokenFrameContainerButton5Name"), "Эмблема героизма");
    assert.equal(text("TokenFrameContainerButton5Count"), "12");
    assert.equal(frame(boot, "TokenFrameContainerButton5Icon").texture, "Interface\\Icons\\Spell_Holy_ProclaimChampion");
    assert.equal(frame(boot, "TokenFrameContainerButton7").visible, false, "six rows, the rest hidden");

    // A heading click collapses it through ExpandCurrencyList.
    boot.bridge.Click(frame(boot, "TokenFrameContainerButton1"), "LeftButton", false);
    assert.deepEqual(lua(boot, "return GetCurrencyListSize()", 1), [4]);
    assert.equal(text("TokenFrameContainerButton2"), "Подземелья и рейды");
    boot.bridge.Click(frame(boot, "TokenFrameContainerButton1"), "LeftButton", false);
    assert.deepEqual(lua(boot, "return GetCurrencyListSize()", 1), [6]);

    // A currency click opens the popup; «show on backpack» watches it.
    boot.bridge.Click(frame(boot, "TokenFrameContainerButton5"), "LeftButton", false);
    assert.deepEqual(lua(boot, "return TokenFramePopup:IsShown(), TokenFrame.selectedToken", 2), [true, "Эмблема героизма"]);
    boot.bridge.Click(frame(boot, "TokenFramePopupBackpackCheckBox"), "LeftButton", false);
    assert.deepEqual(lua(boot, "return GetNumWatchedTokens(), select(5, GetCurrencyListInfo(5))", 2), [1, true]);
    assert.equal(frame(boot, "TokenFrameContainerButton5Check").visible, true, "the row's check mark");
    // The backpack opens: stock ContainerFrame_OnShow → ManageBackpackTokenFrame puts the strip under it.
    // IsOptionFrameOpen reads InterfaceOptionsFrame, which this vertical loads lazily; the live mount
    // supplies the same hidden stand-in before its bag gate (framexml-bags-vertical installBagPanelSeams).
    boot.vm.setGlobal("InterfaceOptionsFrame", frame(boot, "GameMenuFrame"));
    lua(boot, "ToggleBag(0)", 0);
    assert.deepEqual(lua(boot, `return BackpackTokenFrame:IsShown(), BackpackTokenFrame:GetParent():GetName(),
      BackpackTokenFrameToken1Count:GetText(), BackpackTokenFrameToken1.itemID, BackpackTokenFrameToken2:IsShown()`, 5),
    [true, "ContainerFrame1", "12", 40752, false]);

    // An amount changes: CURRENCY_DISPLAY_UPDATE → MainMenuBar → TokenFrame_Update/BackpackTokenFrame_Update.
    seam.currencyWorld.held.set(40752, 30);
    seam.currency.tick();
    assert.equal(text("TokenFrameContainerButton5Count"), "30");
    assert.equal(text("BackpackTokenFrameToken1Count"), "30");

    // «Unused» moves the emblem under «Неактивно», the last heading.
    boot.bridge.Click(frame(boot, "TokenFramePopupInactiveCheckBox"), "LeftButton", false);
    assert.deepEqual(lua(boot, "return GetCurrencyListSize(), (GetCurrencyListInfo(6)), (GetCurrencyListInfo(7))", 3),
      [7, "Неактивно", "Эмблема героизма"]);
    assert.equal(boot.errorCount, 0, "the whole walk raises nothing");

    owner.showTab("TokenFrame");
    assert.equal(character.visible, false, "the current tab asked again closes the frame, as stock does");
    mounted.cleanup();
  } finally {
    boot.close();
  }
});

test("a character who knows no currency loads nothing until the first one", { skip }, async () => {
  const { seam, boot, renderer, requests } = await stage({ known: 0n });
  try {
    const mounted = mountFrameXmlToken(seam, boot, renderer);
    assert.equal(mounted.owner.state, "idle");
    seam.currency.tick();
    assert.equal(mounted.owner.state, "idle");
    assert.equal(requests.some((path) => path.startsWith(ADDON_PREFIX)), false);
    assert.deepEqual(lua(boot, "return CharacterFrameTab5:IsShown()", 1), [false]);
    // Honor earned: Player::SetHonorPoints sets bit 13 (Player.cpp:7128-7135).
    seam.currencyWorld.knownMask = 1n << 12n;
    seam.currency.tick();
    assert.equal(mounted.owner.state, "loading");
    await mounted.owner.settled();
    assert.equal(mounted.owner.state, "ready");
    assert.deepEqual(lua(boot, "return CharacterFrameTab5:IsShown(), GetCurrencyListSize(), GetCVar('showTokenFrameHonor')", 3),
      [true, 2, "1"]);
    assert.equal(boot.errorCount, 0);
  } finally {
    boot.close();
  }
});

test("a failed load keeps tab 5 hidden, the events held and stock's loader unreached", { skip }, async () => {
  const { seam, boot, renderer } = await stage({ missing: true });
  try {
    const failures = [];
    const warn = console.warn;
    console.warn = (message) => failures.push(String(message));
    let mounted;
    try {
      mounted = mountFrameXmlToken(seam, boot, renderer);
      await mounted.owner.settled();
    } finally {
      console.warn = warn;
    }
    assert.equal(mounted.owner.state, "failed");
    assert.ok(failures.some((line) => line.includes(FRAMEXML_TOKEN_ADDON)));
    assert.equal(seam.currency.released, false, "MainMenuBar never hears of currencies it cannot show");
    seam.currency.tick();
    assert.deepEqual(lua(boot, "return CharacterFrameTab5:IsShown(), #__currencyMessages, TokenFrame.hidden", 3), [false, 0, true]);
    const character = frame(boot, "CharacterFrame");
    createFrameXmlCharacterOwner(boot, character).showTab("TokenFrame");
    assert.equal(character.visible, false);
    assert.equal(boot.errorCount, 0);
  } finally {
    boot.close();
  }
});
