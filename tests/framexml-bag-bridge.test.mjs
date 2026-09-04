import assert from "node:assert/strict";
import test from "node:test";

let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = {
  skip: clientDirectory ? false : "no 3.3.5a client on this machine",
  concurrency: false,
};

const { clientArchives } = await import("../tools/mpq.mjs");
const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const {
  CannedWorldSeam,
  CANNED_CONTAINERS,
} = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const {
  closeFrameXmlBags,
  frameXmlBagsOpen,
  publishFrameXmlBags,
  toggleFrameXmlBag,
  toggleFrameXmlBackpack,
  toggleFrameXmlKeyring,
} = await import("../dist/code/browser/framexml/FrameXmlBagController.js");

function fakeNode(tag) {
  const attributes = new Map();
  const classes = new Set();
  const node = {
    tagName: tag.toUpperCase(), children: [], parentNode: undefined, ownerDocument: undefined,
    style: {}, dataset: {}, hidden: false, textContent: "", value: "", clientWidth: 1024,
    clientHeight: 768, offsetWidth: 0, offsetHeight: 0,
    classList: {
      add(...names) { for (const name of names) classes.add(name); },
      remove(...names) { for (const name of names) classes.delete(name); },
      toggle(name, force) {
        const active = force === undefined ? !classes.has(name) : force;
        if (active) classes.add(name); else classes.delete(name);
        return active;
      },
      contains(name) { return classes.has(name); },
    },
    append(...children) {
      for (const child of children) { child.parentNode = node; node.children.push(child); }
    },
    replaceChildren(...children) { node.children = [...children]; },
    remove() {
      if (node.parentNode) node.parentNode.children = node.parentNode.children.filter((child) => child !== node);
      node.parentNode = undefined;
    },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name) ?? null; },
    removeAttribute(name) { attributes.delete(name); },
    addEventListener() {}, removeEventListener() {},
    querySelector(selector) {
      if (selector === 'button[type="submit"]') return fakeNode("button");
      return null;
    },
    querySelectorAll() { return []; },
    getContext() { return {}; },
  };
  return node;
}

const document = {
  head: fakeNode("head"), body: fakeNode("body"),
  createElement(tag) { const node = fakeNode(tag); node.ownerDocument = document; return node; },
  getElementById() { const node = fakeNode("div"); node.ownerDocument = document; return node; },
  querySelectorAll() { return []; },
};
document.head.ownerDocument = document;
document.body.ownerDocument = document;
globalThis.document = document;
globalThis.window = {
  innerWidth: 1024, innerHeight: 768, location: { protocol: "http:", hostname: "localhost" },
  addEventListener() {}, removeEventListener() {}, requestAnimationFrame() { return 1; },
  cancelAnimationFrame() {},
};
globalThis.location = globalThis.window.location;
globalThis.localStorage = { getItem() { return null; }, setItem() {} };

const { frameXmlBagGate } = await import("../dist/code/browser/framexml/FrameXmlWorldMount.js");

const decoder = new TextDecoder("utf-8");

function rendererFor() {
  // The actual DOM renderer owns the browser event listeners. This acceptance path deliberately
  // drives the real bridge Click below: a synthetic DOM event would not be a faithful browser test
  // without a DOM implementation, while this adapter still verifies every gate's rendered identity.
  return {
    elementFor(frame) {
      return {
        getAttribute(name) {
          if (name === "data-framexml-name") return frame.name;
          if (name === "data-framexml-type") return frame.type;
          return null;
        },
        dataset: {},
      };
    },
  };
}

async function loadStockBags() {
  const chain = await clientArchives(clientDirectory);
  // Keep all four carried bags available so this bridge test distinguishes a bad slot-id map
  // from the one-bag canned fixture used by the lower-level seam tests.
  const extraBags = Array.from({ length: 3 }, (_unused, index) => ({
    id: index + 2,
    hostBagSlot: index + 20,
    hostSlotOffset: 0,
    name: `Сумка ${index + 2}`,
    bagFamily: 0,
    slots: Object.freeze(Array(4).fill(undefined)),
  }));
  const seam = new CannedWorldSeam(undefined, undefined, [
    ...CANNED_CONTAINERS,
    ...extraBags,
  ]);
  const boot = new FrameXmlBoot({
    provider: {
      async read(path) {
        const bytes = await chain.read(path);
        return bytes ? decoder.decode(bytes) : undefined;
      },
    },
    locale: "ruRU",
    subset: FRAMEXML_VERTICAL_TOC,
    seam,
    screen: () => ({ width: 1024, height: 768 }),
    exercise: false,
  });
  await boot.load();
  return { boot, chain, seam };
}

test("MPQ stock bags bridge through the seam, controller, and owner lifecycle", withClient, async () => {
  const { boot, chain, seam } = await loadStockBags();
  let release;
  try {
    assert.equal(boot.inventory?.files.missing.length, 0, "the stock vertical has no missing files");
    assert.equal(boot.inventory?.lua.failed, 0, "stock bag Lua loads without execution failures");
    assert.deepEqual(boot.inventory?.errors.filter(({ file, handled }) =>
      /(?:moneyframe|containerframe)/i.test(file) && !handled), [],
    "stock bag and money files add no unhandled inventory errors");
    assert.deepEqual(boot.vm.errors, [], "stock bag and money paths raise no unhandled Lua errors");

    const backpack = boot.bridge.getFrame("MainMenuBarBackpackButton");
    const backpackFrame = boot.bridge.getFrame("ContainerFrame1");
    const carriedButton = boot.bridge.getFrame("CharacterBag0Slot");
    const carriedFrame = boot.bridge.getFrame("ContainerFrame2");
    const keyringButton = boot.bridge.getFrame("KeyRingButton");
    const bagButtons = Array.from({ length: 4 }, (_unused, index) =>
      boot.bridge.getFrame(`CharacterBag${index}Slot`));
    const containers = Array.from({ length: 13 }, (_unused, index) =>
      boot.bridge.getFrame(`ContainerFrame${index + 1}`));
    const item = boot.bridge.getFrame("ContainerFrame1Item16");
    const icon = boot.bridge.getFrame("ContainerFrame1Item16IconTexture");
    const count = boot.bridge.getFrame("ContainerFrame1Item16Count");
    const gold = boot.bridge.getFrame("ContainerFrame1MoneyFrameGoldButtonText");
    const silver = boot.bridge.getFrame("ContainerFrame1MoneyFrameSilverButtonText");
    const copper = boot.bridge.getFrame("ContainerFrame1MoneyFrameCopperButtonText");
    for (const [name, frame] of [
      ["MainMenuBarBackpackButton", backpack],
      ["ContainerFrame1", backpackFrame],
      ["CharacterBag0Slot", carriedButton],
      ["ContainerFrame2", carriedFrame],
      ["KeyRingButton", keyringButton],
      ["ContainerFrame13", boot.bridge.getFrame("ContainerFrame13")],
      ["ContainerFrame1Item16", item],
      ["ContainerFrame1Item16IconTexture", icon],
      ["ContainerFrame1Item16Count", count],
      ["ContainerFrame1MoneyFrameGoldButtonText", gold],
      ["ContainerFrame1MoneyFrameSilverButtonText", silver],
      ["ContainerFrame1MoneyFrameCopperButtonText", copper],
    ]) assert.ok(frame, `${name} is a stock FrameXML widget`);
    assert.deepEqual(bagButtons.map((button) => button?.id), [20, 21, 22, 23],
      "PaperDollItemSlotButton_OnLoad maps carried bag buttons to stock inventory slots");
    assert.equal(backpackFrame.visible, false);
    assert.equal(carriedFrame.visible, false);
    assert.ok(containers.every((frame) => frame && frame.visible === false));

    const owner = frameXmlBagGate(boot, rendererFor());
    assert.ok(owner, "the real stock roots pass the renderer/gate probe");
    release = publishFrameXmlBags(owner);
    assert.equal(frameXmlBagsOpen(), false, "the controller publishes a closed owner");

    const diagnosticsBefore = boot.bridge.diagnostics.length;
    const vmErrorsBefore = boot.vm.errors.length;

    // This is the real stock button handler through the gate-owned alias wrapper; the only
    // browser-side shortcut is the bridge Click scalar dispatch, as explained by rendererFor.
    owner.toggleBackpack();
    assert.equal(frameXmlBagsOpen(), true, "the stock backpack owner opens");
    assert.equal(backpackFrame.visible, true);
    assert.equal(icon.texture, "Interface\\Icons\\INV_Potion_54", "first item texture is visible");
    assert.equal(count.text, "5", "first item count is visible");
    assert.equal(boot.bridge.Enter(item), true, "the stock bag item hover dispatches");
    assert.equal(boot.bridge.getFrame("GameTooltip")?.visible, true,
      "bag item hover shows the shared GameTooltip");
    assert.equal(boot.bridge.getFrame("GameTooltipTextLeft1")?.text,
      "Огромный флакон с лечебным зельем",
      "bag item hover publishes the cached item name through SetBagItem");
    assert.equal(gold.text, "12", "gold is 123456 copper");
    assert.equal(silver.text, "34", "silver is 123456 copper");
    assert.equal(copper.text, "56", "copper is 123456 copper");

    seam.usedContainerItems.length = 0;
    assert.equal(boot.bridge.Click(item, "RightButton", false), true,
      "the real stock item OnClick accepts a right-click");
    assert.deepEqual(seam.usedContainerItems, [{ bag: 255, slot: 23 }],
      "right-click invokes UseContainerItem exactly once with host mapping");

    assert.equal(closeFrameXmlBags(), true, "the controller Escape/close route is handled");
    assert.equal(frameXmlBagsOpen(), false);
    assert.equal(backpackFrame.visible, false, "Escape closes the backpack frame");

    assert.equal(toggleFrameXmlBackpack(), true, "the controller reopens the backpack for stock bag stacking");
    assert.equal(backpackFrame.visible, true);
    assert.equal(toggleFrameXmlBag(1), true, "the controller opens the carried bag through stock OnClick");
    assert.equal(carriedFrame.visible, true);
    assert.equal(boot.bridge.getFrame("ContainerFrame2Item4IconTexture")?.texture,
      "Interface\\Icons\\INV_Potion_54", "the carried-bag item texture is visible");
    assert.equal(closeFrameXmlBags(), true);
    assert.equal(carriedFrame.visible, false, "the carried bag closes through the controller");

    // Exercise every controller route while all four carried bags are available. Each stock
    // button must translate its inventory slot (20..23) to the matching ContainerFrame id (1..4).
    for (let index = 1; index <= 4; index += 1) {
      assert.equal(toggleFrameXmlBag(index), true, `controller opens carried bag ${index}`);
      const visibleIds = containers.filter((frame) => frame?.visible).map((frame) => frame.id);
      assert.deepEqual(visibleIds, [index], `carried bag ${index} opens its distinct container`);
      assert.equal(closeFrameXmlBags(), true, `controller closes carried bag ${index}`);
    }

    owner.toggleAllBags();
    assert.deepEqual(
      containers.filter((frame) => frame?.visible).map((frame) => frame.id),
      [0, 1, 2, 3, 4],
      "toggleAll opens the backpack and every available carried bag distinctly",
    );
    owner.close();
    assert.ok(containers.every((frame) => !frame.visible));

    assert.ok(seam.setContainerItem(-2, 1, {
      entry: 20815,
      texture: "Interface\\Icons\\INV_Misc_Key_05",
      count: 1,
    }) > 0, "the truthful keyring fixture mutation emits BAG_UPDATE to mounted stock frames");
    assert.equal(toggleFrameXmlKeyring(), true, "the controller opens the stock keyring");
    const keyringFrame = containers.find((frame) => frame?.visible && frame.id === -2);
    assert.ok(keyringFrame, "a stock container root opens for the keyring");
    const keyringItem = keyringFrame.children.find((frame) => frame.type === "Button" && frame.id === 1);
    assert.ok(keyringItem, "the keyring item is assigned its stock slot id");
    assert.equal(boot.bridge.getFrame(`${keyringItem.name}IconTexture`)?.texture,
      "Interface\\Icons\\INV_Misc_Key_05", "the mutated keyring item reaches the stock slot");

    owner.close();
    assert.equal(frameXmlBagsOpen(), false, "owner close leaves no visible stock bag state");
    assert.equal(backpackFrame.visible, false);
    assert.equal(carriedFrame.visible, false);
    assert.ok(containers.every((frame) => frame && frame.visible === false));
    assert.equal(boot.bridge.diagnostics.length, diagnosticsBefore,
      "bag interactions add no bridge diagnostics");
    assert.equal(boot.vm.errors.length, vmErrorsBefore,
      "bag interactions add no unhandled Lua errors");
  } finally {
    try { release?.(); } finally {
      boot.close();
      chain.close();
    }
  }
});
