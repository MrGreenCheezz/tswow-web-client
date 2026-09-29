import assert from "node:assert/strict";
import test from "node:test";

// This is intentionally an MPQ-backed integration test. A hand-built frame tree could prove that
// the bridge can show a frame, but not that retail CharacterFrame.lua/PaperDollFrame.lua actually
// updates the paper doll, equipment icons/counts and stat rows through the seam.
let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine" };

let webglContextRequests = 0;

/**
 * The renderer only needs a small DOM surface for this test. Keeping it explicit also makes the
 * model gate meaningful: the canvas is adopted into the renderer's real CharacterModelFrame box,
 * without constructing a WebGL context or a second 3D renderer.
 */
function fakeDocument() {
  const ids = new Map();
  const doc = {
    activeElement: undefined,
    head: undefined,
    createElement(tag) { return makeNode(tag); },
    createElementNS(_namespace, tag) { return makeNode(tag); },
    getElementById(id) {
      if (!ids.has(id)) ids.set(id, makeNode("div"));
      return ids.get(id);
    },
    querySelectorAll() { return []; },
  };

  function style() {
    return {
      setProperty(name, value) { this[name] = String(value); },
      removeProperty(name) { delete this[name]; },
    };
  }

  function makeNode(tag) {
    const attributes = new Map();
    const listeners = new Map();
    const classes = new Set();
    const node = {
      ownerDocument: doc,
      tagName: String(tag).toUpperCase(),
      children: [],
      parentElement: undefined,
      parentNode: undefined,
      style: style(),
      hidden: false,
      className: "",
      dataset: {},
      textContent: "",
      value: "",
      disabled: false,
      width: 0,
      height: 0,
      offsetLeft: 0,
      offsetTop: 0,
      offsetWidth: 0,
      offsetHeight: 0,
      scrollTop: 0,
      scrollHeight: 0,
      clientHeight: 0,
      classList: {
        add(...names) { for (const name of names) { classes.add(name); } node.className = [...classes].join(" "); },
        remove(...names) { for (const name of names) { classes.delete(name); } node.className = [...classes].join(" "); },
        toggle(name, force) {
          const enabled = force === undefined ? !classes.has(name) : force;
          if (enabled) classes.add(name); else classes.delete(name);
          node.className = [...classes].join(" ");
          return enabled;
        },
        contains(name) { return classes.has(name); },
      },
      get nextSibling() {
        const siblings = node.parentElement?.children ?? [];
        const index = siblings.indexOf(node);
        return index < 0 ? null : siblings[index + 1] ?? null;
      },
      append(...children) {
        for (const child of children) {
          if (!child) continue;
          child.parentElement?.removeChild(child);
          child.parentElement = node;
          child.parentNode = node;
          node.children.push(child);
        }
      },
      insertBefore(child, before) {
        child.parentElement?.removeChild(child);
        child.parentElement = node;
        child.parentNode = node;
        const index = node.children.indexOf(before);
        if (index < 0) node.children.push(child);
        else node.children.splice(index, 0, child);
      },
      removeChild(child) {
        const index = node.children.indexOf(child);
        if (index >= 0) node.children.splice(index, 1);
        if (child.parentElement === node) child.parentElement = undefined;
        if (child.parentNode === node) child.parentNode = undefined;
      },
      replaceChildren(...children) {
        for (const child of node.children) {
          child.parentElement = undefined;
          child.parentNode = undefined;
        }
        node.children = [];
        node.append(...children);
      },
      remove() { node.parentElement?.removeChild(node); },
      setAttribute(name, value) { attributes.set(String(name), String(value)); },
      getAttribute(name) { return attributes.get(String(name)) ?? null; },
      removeAttribute(name) { attributes.delete(String(name)); },
      addEventListener(name, listener) {
        listeners.set(name, [...(listeners.get(name) ?? []), listener]);
      },
      removeEventListener(name, listener) {
        listeners.set(name, (listeners.get(name) ?? []).filter((value) => value !== listener));
      },
      dispatchEvent(event) {
        for (const listener of listeners.get(event.type) ?? []) listener(event);
      },
      querySelector(selector) {
        if (selector === 'button[type="submit"]') return makeNode("button");
        return findSelector(node, selector);
      },
      querySelectorAll(selector) {
        const result = [];
        walk(node, (child) => { if (matches(child, selector)) result.push(child); });
        return result;
      },
      closest(selector) {
        for (let current = node; current; current = current.parentElement) {
          if (matches(current, selector)) return current;
        }
        return null;
      },
      focus() { doc.activeElement = node; },
      blur() { if (doc.activeElement === node) doc.activeElement = undefined; },
      setSelectionRange() {},
      getContext(context) {
        if (typeof context === "string" && context.toLowerCase().includes("webgl")) {
          webglContextRequests += 1;
        }
        return undefined;
      },
    };
    return node;
  }

  function walk(node, visit) {
    for (const child of node.children ?? []) {
      visit(child);
      walk(child, visit);
    }
  }

  function matches(node, selector) {
    if (selector === "canvas[data-portrait-slot=\"paperdoll\"]"
      || selector === "canvas[data-portrait-slot=\"character\"]") {
      const slot = selector.includes("character") ? "character" : "paperdoll";
      return node.tagName === "CANVAS" && node.dataset.portraitSlot === slot;
    }
    if (selector === "[data-framexml-type]") return node.getAttribute("data-framexml-type") !== null;
    return false;
  }

  function findSelector(root, selector) {
    let result;
    walk(root, (child) => { if (!result && matches(child, selector)) result = child; });
    return result;
  }

  doc.head = makeNode("head");
  return doc;
}

globalThis.document = fakeDocument();
globalThis.window = {
  devicePixelRatio: 1,
  innerWidth: 1024,
  innerHeight: 768,
  addEventListener() {},
  removeEventListener() {},
};
globalThis.location = { protocol: "http:", hostname: "localhost" };
globalThis.localStorage = { getItem() { return null; }, setItem() {} };

const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { FrameXmlDomRenderer } =
  await import("../dist/code/browser/ui/framexml_compat/FrameXmlDomRenderer.js");
const { CannedWorldSeam, CANNED_PLAYER } =
  await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FRAMEXML_VERTICAL_TOC } =
  await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const {
  closeFrameXmlCharacter,
  frameXmlCharacterModelGate,
  frameXmlCharacterOpen,
  publishFrameXmlCharacter,
  toggleFrameXmlCharacter,
} = await import("../dist/code/browser/framexml/FrameXmlCharacterController.js");

const EQUIPMENT_IDS = Object.freeze({
  CharacterHeadSlot: 1,
  CharacterNeckSlot: 2,
  CharacterShoulderSlot: 3,
  CharacterBackSlot: 15,
  CharacterChestSlot: 5,
  CharacterShirtSlot: 4,
  CharacterTabardSlot: 19,
  CharacterWristSlot: 9,
  CharacterHandsSlot: 10,
  CharacterWaistSlot: 6,
  CharacterLegsSlot: 7,
  CharacterFeetSlot: 8,
  CharacterFinger0Slot: 11,
  CharacterFinger1Slot: 12,
  CharacterTrinket0Slot: 13,
  CharacterTrinket1Slot: 14,
  CharacterMainHandSlot: 16,
  CharacterSecondaryHandSlot: 17,
  CharacterRangedSlot: 18,
});

function normalized(path) {
  return path.replaceAll("\\", "/").toLowerCase();
}

function descendants(frame) {
  const result = [];
  for (const child of frame.children) {
    result.push(child, ...descendants(child));
  }
  return result;
}

function renderedDescendants(node) {
  const result = [];
  walk(node, (child) => result.push(child));
  return result;
}

function walk(node, visit) {
  for (const child of node.children ?? []) {
    visit(child);
    walk(child, visit);
  }
}

function frame(boot, name) {
  const result = boot.bridge.getFrame(name);
  assert.ok(result, `${name} exists in the stock MPQ load`);
  return result;
}

function liveApiCalls(boot, name) {
  const key = JSON.stringify(name);
  const probe = boot.vm.execute(`__characterApiCalls = __fxCalls[${key}] or 0`,
    `@character-integration:census:${name}`);
  assert.equal(probe.ok, true, probe.error ?? `${name} census probe failed`);
  return Number(boot.vm.getGlobal("__characterApiCalls"));
}

function effectivelyVisible(node) {
  for (let current = node; current; current = current.parentElement) {
    if (current.hidden) return false;
  }
  return true;
}

test("MPQ stock CharacterFrame/PaperDollFrame mounts, shows and paints through CannedWorldSeam",
  withClient, async () => {
    const { clientArchives } = await import("../tools/mpq.mjs");
    const chain = await clientArchives(clientDirectory);
    const decoder = new TextDecoder("utf-8");
    const requests = new Set();
    const seam = new CannedWorldSeam();
    webglContextRequests = 0;
    const boot = new FrameXmlBoot({
      provider: {
        async read(path) {
          requests.add(normalized(path));
          const data = await chain.read(path);
          return data ? decoder.decode(data) : undefined;
        },
      },
      locale: "ruRU",
      subset: FRAMEXML_VERTICAL_TOC,
      seam,
      exercise: false,
      screen: () => ({ width: 1024, height: 768 }),
    });
    const host = document.createElement("section");
    const renderer = new FrameXmlDomRenderer(host, { bridge: boot.bridge });
    let releaseOwner;
    let gate;
    try {
      const inventory = await boot.load();
      assert.ok(requests.has("interface/framexml/characterframe.xml"));
      assert.ok(requests.has("interface/framexml/characterframe.lua"));
      assert.ok(requests.has("interface/framexml/paperdollframe.xml"));
      assert.ok(requests.has("interface/framexml/paperdollframe.lua"));
      assert.equal(inventory.xml.failed.length, 0, "stock Character/PaperDoll XML parses");
      assert.equal(inventory.lua.failed, 0, "stock Character/PaperDoll Lua executes");
      assert.ok(boot.bridge.dispatchEvent("VARIABLES_LOADED") > 0,
        "stock startup initializes character preferences before its first show");

      const character = frame(boot, "CharacterFrame");
      const paperDoll = frame(boot, "PaperDollFrame");
      const model = frame(boot, "CharacterModelFrame");
      assert.equal(character.visible, false, "CharacterFrame starts hidden");
      assert.equal(model.type, "PlayerModel");

      renderer.mount(boot.roots);
      const characterElement = renderer.elementFor(character);
      const paperDollElement = renderer.elementFor(paperDoll);
      const modelElement = renderer.elementFor(model);
      assert.ok(characterElement && paperDollElement && modelElement);
      assert.equal(characterElement.hidden, true, "hidden stock root is hidden in mounted DOM");
      assert.equal(paperDollElement.hidden, true,
        "PaperDollFrame is factually hidden behind the hidden stock root");

      // This gate is deliberately structural. It adopts one existing canvas into the actual
      // PlayerModel box and does not call a model constructor or create a WebGL renderer.
      gate = frameXmlCharacterModelGate(boot, renderer);
      assert.ok(gate, "the complete stock model/equipment/stat tree is adoptable");
      assert.equal(gate.modelElement, modelElement);
      assert.equal(modelElement.querySelectorAll("canvas[data-portrait-slot=\"paperdoll\"]").length, 1,
        "model adoption contributes one persistent canvas");
      const characterPortrait = frame(boot, "CharacterFramePortrait");
      const characterPortraitElement = renderer.elementFor(characterPortrait);
      assert.equal(characterPortrait.type, "Texture");
      assert.ok(characterPortraitElement?.parentElement === characterElement,
        "CharacterFramePortrait stays owned by the stock CharacterFrame root");
      assert.equal(characterElement.querySelectorAll("canvas[data-portrait-slot=\"character\"]").length, 1,
        "the stock CharacterFramePortrait owner receives one separate bust canvas");
      assert.equal(webglContextRequests, 0,
        "structural model adoption does not create a second WebGL context");
      assert.equal(frameXmlCharacterModelGate(boot, renderer)?.portraitCleanup, gate.portraitCleanup,
        "rechecking the gate is identity-safe and does not add a second canvas");

      assert.deepEqual([...Object.values(EQUIPMENT_IDS)].sort((left, right) => left - right),
        Array.from({ length: 19 }, (_, index) => index + 1),
      "the stock equipment map covers every inventory ID 1..19 exactly once");
      for (const [name, id] of Object.entries(EQUIPMENT_IDS)) {
        assert.equal(frame(boot, name).id, id, `${name} keeps stock inventory ID ${id}`);
      }

      let characterShows = 0;
      let paperDollShows = 0;
      let characterHides = 0;
      let paperDollHides = 0;
      assert.equal(boot.bridge.HookScript(character, "OnShow", () => { characterShows += 1; }), true);
      assert.equal(boot.bridge.HookScript(paperDoll, "OnShow", () => { paperDollShows += 1; }), true);
      assert.equal(boot.bridge.HookScript(character, "OnHide", () => { characterHides += 1; }), true);
      assert.equal(boot.bridge.HookScript(paperDoll, "OnHide", () => { paperDollHides += 1; }), true);

      const errorsBeforeShow = boot.vm.errors.length;
      const owner = {
        isOpen: () => character.visible && paperDoll.visible,
        show: () => { assert.equal(boot.bridge.Show(character), true); },
        hide: () => { assert.equal(boot.bridge.Hide(character), true); },
        dispose: () => { gate.portraitCleanup(); },
      };
      const cvarComposition = boot.vm.execute(`
        __characterLeftCVar = GetCVar("playerStatLeftDropdown")
        __characterRightCVar = GetCVar("playerStatRightDropdown")
        __characterLeftCVarBool = GetCVarBool("playerStatLeftDropdown")
        __characterUnknownCVarBool = GetCVarBool("framexml_unknown_character_cvar")
        SetCVar("showAllSpellRanks", "1")
        __characterShowAllSpellRanks = GetCVarBool("showAllSpellRanks")
      `, "@character-integration:cvar-composition");
      assert.equal(cvarComposition.ok, true, cvarComposition.error ?? "CVar composition failed");
      assert.equal(boot.vm.getGlobal("__characterLeftCVar"), "PLAYERSTAT_BASE_STATS",
        "stock VARIABLES_LOADED initializes base stats from the empty registered preference");
      assert.equal(boot.vm.getGlobal("__characterRightCVar"), "PLAYERSTAT_MELEE_COMBAT",
        "stock VARIABLES_LOADED selects the warrior melee category without host seeding");
      assert.equal(boot.vm.getGlobal("__characterLeftCVarBool"), true,
        "unknown host CVar falls back to the neutral string CVar view");
      assert.equal(boot.vm.getGlobal("__characterUnknownCVarBool"), undefined,
        "unregistered CVar remains nil through the composed bool API");
      assert.equal(boot.vm.getGlobal("__characterShowAllSpellRanks"), true,
        "ShowAllSpellRanks keeps the seam host boolean behavior");
      releaseOwner = publishFrameXmlCharacter(owner);
      assert.equal(frameXmlCharacterOpen(), false, "gated stock owner starts closed");
      assert.equal(toggleFrameXmlCharacter(), true, "toggle reaches the stock Show path");
      assert.equal(characterShows, 1, "CharacterFrame stock OnShow runs once");
      assert.equal(paperDollShows, 1, "PaperDollFrame stock OnShow runs once");
      assert.equal(character.visible, true);
      assert.equal(paperDoll.visible, true);
      assert.equal(characterElement.hidden, false);
      assert.equal(paperDollElement.hidden, false);
      assert.equal(frameXmlCharacterOpen(), true);
      const statEvent = boot.bridge.dispatchEvent("UNIT_STATS", "player");
      assert.ok(statEvent > 0, "UNIT_STATS reaches stock PaperDollFrame handler");
      assert.equal(boot.vm.errors.length, errorsBeforeShow,
        `Show adds no character-specific Lua failures: ${boot.vm.errors.join(" | ")}`);

      const head = frame(boot, "CharacterHeadSlot");
      const item = {
        entry: 13446,
        name: "Огромный флакон с лечебным зельем",
        texture: "Interface\\Icons\\INV_Potion_54",
        count: 3,
        quality: 1,
      };
      assert.ok(seam.setInventoryItem(1, item) > 0, "canned equipped item emits UNIT_INVENTORY_CHANGED");
      assert.equal(boot.bridge.Enter(head), true, "stock equipment hover dispatches");
      const tooltip = frame(boot, "GameTooltip");
      assert.equal(tooltip.visible, true, "equipment hover shows the stock GameTooltip");
      assert.equal(frame(boot, "GameTooltipTextLeft1").text, item.name,
        "equipment hover publishes the cached item name through the common tooltip method");
      assert.ok(descendants(head).some((child) => child.type === "Texture" && child.texture === item.texture),
        "stock PaperDoll item handler paints the canned equipment texture");
      assert.ok(descendants(head).some((child) => child.type === "FontString" && child.text === "3"),
        "stock PaperDoll item handler paints the canned equipment count");
      assert.ok(liveApiCalls(boot, "GetInventoryItemTexture") > 0);
      assert.ok(liveApiCalls(boot, "GetInventoryItemCount") > 0);
      assert.ok(liveApiCalls(boot, "GetInventorySlotInfo") >= 19);

      const statFrames = [
        "PlayerStatFrameLeft1", "PlayerStatFrameLeft2", "PlayerStatFrameLeft3",
        "PlayerStatFrameLeft4", "PlayerStatFrameLeft5", "PlayerStatFrameLeft6",
        "PlayerStatFrameRight1", "PlayerStatFrameRight2", "PlayerStatFrameRight3",
        "PlayerStatFrameRight4", "PlayerStatFrameRight5", "PlayerStatFrameRight6",
      ];
      for (const name of statFrames) {
        const stat = frame(boot, name);
        const label = frame(boot, `${name}Label`);
        const value = frame(boot, `${name}StatText`);
        assert.notEqual(label.text, "", `${name} label is populated by stock Lua`);
        assert.notEqual(value.text, "", `${name} value is populated by CannedWorldSeam`);
        assert.ok(stat.loaded, `${name} ran its stock template OnLoad`);
      }
      assert.equal(frame(boot, "PlayerStatFrameLeft1StatText").text,
        String(CANNED_PLAYER.stats[0][1]),
        "first stock stat row shows CannedWorldSeam strength");
      assert.notEqual(frame(boot, "PlayerStatFrameLeft5StatText").text, "",
        "fifth stock stat row is populated");
      assert.ok(liveApiCalls(boot, "UnitStat") > 0);
      assert.ok(liveApiCalls(boot, "UnitArmor") > 0);
      assert.ok(liveApiCalls(boot, "UnitAttackPower") > 0);
      assert.equal(boot.vm.errors.length, errorsBeforeShow,
        `equipment/stat updates add no character-specific Lua failures: ${boot.vm.errors.join(" | ")}`);

      assert.equal(closeFrameXmlCharacter(), true, "close reaches the stock Hide path");
      assert.equal(characterHides, 1, "CharacterFrame stock OnHide runs once");
      assert.equal(paperDollHides, 1, "PaperDollFrame stock OnHide runs once");
      assert.equal(character.visible, false);
      assert.equal(characterElement.hidden, true);
      assert.equal(effectivelyVisible(characterElement), false);
      assert.equal(effectivelyVisible(paperDollElement), false,
        "closing the stock root effectively hides PaperDollFrame");
      assert.equal(frameXmlCharacterOpen(), false);
      releaseOwner();
      releaseOwner = undefined;
      assert.equal(modelElement.querySelectorAll("canvas[data-portrait-slot=\"paperdoll\"]").length, 0,
        "owner cleanup removes the adopted canvas");
      assert.equal(characterElement.querySelectorAll("canvas[data-portrait-slot=\"character\"]").length, 0,
        "owner cleanup removes the adopted CharacterFramePortrait canvas");
      assert.equal(renderedDescendants(host).some((node) => effectivelyVisible(node)
        && node.getAttribute("data-framexml-name") === "CharacterFrame"), false,
      "cleanup leaves no visible CharacterFrame window");
      assert.equal(renderedDescendants(host).some((node) => effectivelyVisible(node)
        && node.getAttribute("data-framexml-name") === "PaperDollFrame"), false,
      "cleanup leaves no visible PaperDollFrame window");
      assert.equal(boot.vm.errors.length, errorsBeforeShow);
    } finally {
      releaseOwner?.();
      gate?.portraitCleanup?.();
      renderer.destroy();
      boot.close();
      chain.close();
    }
  });
