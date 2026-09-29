import assert from "node:assert/strict";
import test from "node:test";

function fakeNode(tag) {
  const attributes = new Map();
  return {
    tagName: tag.toUpperCase(),
    children: [],
    parentNode: undefined,
    style: {},
    dataset: {},
    hidden: false,
    textContent: "",
    clientWidth: 1024,
    clientHeight: 768,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    append(...children) {
      for (const child of children) {
        child.parentNode = this;
        this.children.push(child);
      }
    },
    replaceChildren(...children) {
      this.children = [...children];
      for (const child of children) child.parentNode = this;
    },
    remove() {
      if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((x) => x !== this);
      this.parentNode = undefined;
    },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name) ?? null; },
    removeAttribute(name) { attributes.delete(name); },
    addEventListener() {},
    removeEventListener() {},
    querySelector(selector) {
      return selector === 'button[type="submit"]' ? fakeNode("button") : null;
    },
    querySelectorAll() { return []; },
    getContext() { return {}; },
  };
}

const document = {
  head: fakeNode("head"),
  body: fakeNode("body"),
  createElement(tag) { return fakeNode(tag); },
  getElementById() { return fakeNode("div"); },
  querySelectorAll() { return []; },
};
globalThis.document = document;
globalThis.window = {
  innerWidth: 1024,
  innerHeight: 768,
  devicePixelRatio: 1,
  location: { protocol: "http:", hostname: "localhost" },
  addEventListener() {},
  removeEventListener() {},
  requestAnimationFrame() { return 1; },
  cancelAnimationFrame() {},
};
globalThis.location = globalThis.window.location;
globalThis.localStorage = { getItem() { return null; }, setItem() {} };

const { frameXmlMerchantGate, publishFrameXmlMerchantMount } = await import(
  "../dist/code/browser/framexml/FrameXmlWorldMount.js",
);
const { game } = await import("../dist/code/browser/game/Context.js");

function makeFrame(name, type, parent, scripts = []) {
  const frame = {
    name,
    type,
    parent,
    children: [],
    visible: true,
    registeredEvents: new Set(),
    scriptSources: new Map(scripts.map((script) => [script, ""])),
  };
  if (parent) parent.children.push(frame);
  return frame;
}

function fixture({ buttonOnLoad = true } = {}) {
  const ui = makeFrame("UIParent", "Frame");
  const root = makeFrame("MerchantFrame", "Frame", ui,
    ["OnLoad", "OnShow", "OnHide", "OnEvent"]);
  root.registeredEvents = new Set(["MERCHANT_SHOW", "MERCHANT_UPDATE", "MERCHANT_CLOSED"]);
  const frames = [ui, root];
  for (const name of [
    "MerchantFrameCloseButton", "MerchantFrameTab1", "MerchantFrameTab2",
    "MerchantPrevPageButton", "MerchantNextPageButton", "MerchantRepairAllButton",
    "MerchantRepairItemButton",
  ]) frames.push(makeFrame(name, "Button", root));
  for (let index = 1; index <= 12; index += 1) {
    const row = makeFrame(`MerchantItem${index}`, "Frame", root);
    frames.push(row);
    frames.push(makeFrame(`MerchantItem${index}ItemButton`, "Button", row,
      buttonOnLoad ? ["OnLoad", "OnClick"] : ["OnClick"]));
  }
  const buyback = makeFrame("MerchantBuyBackItem", "Frame", root);
  frames.push(buyback);
  frames.push(makeFrame("MerchantBuyBackItemItemButton", "Button", buyback,
    ["OnLoad", "OnClick"]));
  const elements = new Map(frames.map((frame) => {
    const element = {
      parentElement: frame.parent ? undefined : undefined,
      getAttribute(name) {
        if (name === "data-framexml-name") return frame.name;
        if (name === "data-framexml-type") return frame.type;
        return null;
      },
    };
    return [frame, element];
  }));
  for (const frame of frames) {
    const element = elements.get(frame);
    if (frame.parent) element.parentElement = elements.get(frame.parent);
  }
  const byName = new Map(frames.map((frame) => [frame.name, frame]));
  const seam = {
    merchantNumItems() { return 0; }, merchantItemInfo() {}, merchantItemLink() {},
    merchantItemMaxStack() { return 0; }, merchantItemCostInfo() { return [0, 0, 0]; },
    merchantItemCostItem() {}, itemInfo() {}, buybackNumItems() { return 0; }, buybackItemInfo() {},
    buybackItemLink() {}, buyMerchantItem() {}, buybackItem() {}, closeMerchant() {},
    canMerchantRepair() { return false; }, repairAllCost() { return [0, false]; },
    canGuildBankRepair() { return false; }, inRepairMode() { return false; },
  };
  const boot = {
    bridge: {
      getFrame(name) { return byName.get(name); },
      hasScript(frame, script) { return frame.scriptSources.has(script); },
      isVisible(frame) {
        for (let current = frame; current; current = current.parent) if (!current.visible) return false;
        return true;
      },
      Hide(frame) { frame.visible = false; },
    },
  };
  const renderer = { elementFor(frame) { return elements.get(frame); } };
  return { boot, renderer, seam, byName };
}

test("Merchant gate accepts the stock row Frame with scripts on its child item button", () => {
  const setup = fixture();
  const gate = frameXmlMerchantGate(setup.seam, setup.boot, setup.renderer);
  assert.ok(gate, "complete merchant tree must publish an owner");
  assert.equal(setup.byName.get("MerchantFrame").visible, false, "gate probe is transactional");
  const missingButton = fixture({ buttonOnLoad: false });
  assert.equal(frameXmlMerchantGate(missingButton.seam, missingButton.boot, missingButton.renderer), undefined,
    "missing child OnLoad must fail the gate");
});

test("merchant publication reopens active stock state and restores native fallback exactly once", () => {
  const vendor = { guid: 0x600n, items: [] };
  const world = { vendor };
  const previousWorld = game.world;
  game.world = world;
  const nativeWindow = { hidden: false };
  const root = { visible: false };
  let shows = 0;
  let hides = 0;
  let nativeShows = 0;
  const owner = {
    isOpen() { return root.visible; },
    show() { shows += 1; root.visible = true; },
    hide() {
      hides += 1;
      root.visible = false;
      // Match MerchantFrame_OnHide -> CloseMerchant without coupling this test to a VM.
      world.vendor = undefined;
    },
    refresh() {},
  };
  try {
    const cleanup = publishFrameXmlMerchantMount(
      owner,
      nativeWindow,
      nativeWindow.hidden,
      () => { nativeShows += 1; nativeWindow.hidden = false; },
    );
    assert.equal(root.visible, true, "an already-active vendor reopens the published stock root");
    assert.equal(nativeWindow.hidden, true, "native fallback stays hidden while stock owns merchant");
    assert.equal(shows, 1);
    cleanup();
    assert.equal(root.visible, false);
    assert.equal(nativeWindow.hidden, false, "active vendor restores native fallback");
    assert.equal(nativeShows, 1);
    assert.equal(world.vendor, vendor, "cleanup preserves the exact active vendor snapshot");
    cleanup();
    assert.equal(hides, 1, "owner cleanup is idempotent");
    assert.equal(nativeShows, 1, "native fallback is not shown twice");
  } finally {
    game.world = previousWorld;
  }
});

let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}

test("real MPQ MerchantFrame plus Canned seam passes the owner gate", {
  skip: clientDirectory ? false : "no 3.3.5a client on this machine",
}, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
  const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
  const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
  const chain = await clientArchives(clientDirectory);
  const decoder = new TextDecoder("utf-8");
  const seam = new CannedWorldSeam();
  const boot = new FrameXmlBoot({
    subset: FRAMEXML_VERTICAL_TOC,
    seam,
    provider: { async read(path) {
      const data = await chain.read(path);
      return data ? decoder.decode(data) : undefined;
    } },
    locale: "ruRU",
    screen: () => ({ width: 1024, height: 768 }),
  });
  try {
    await boot.load();
    const elements = new Map();
    for (const frame of boot.bridge.frames) {
      elements.set(frame, {
        parentElement: frame.parent ? elements.get(frame.parent) : undefined,
        getAttribute(name) {
          if (name === "data-framexml-name") return frame.name;
          if (name === "data-framexml-type") return frame.type;
          return null;
        },
      });
    }
    const gate = frameXmlMerchantGate(seam, boot, { elementFor(frame) { return elements.get(frame); } });
    assert.ok(gate, "the real stock tree must pass its narrow gate");
    assert.equal(boot.bridge.isVisible(gate.frame), false, "gate hides the owner until publication");
  } finally {
    boot.close();
    chain.close();
  }
});
