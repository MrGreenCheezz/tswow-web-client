import assert from "node:assert/strict";
import test from "node:test";

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
const {
  frameXmlBagsOpen,
  publishFrameXmlBags,
  toggleFrameXmlBackpack,
} = await import("../dist/code/browser/framexml/FrameXmlBagController.js");

let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine" };

function frame(name, type, id) {
  return { name, type, ...(id === undefined ? {} : { id }), visible: false };
}

function rendered(name, type) {
  const element = fakeNode("div");
  element.setAttribute("data-framexml-name", name);
  element.setAttribute("data-framexml-type", type);
  return element;
}

function fixture({
  includeBackpack = true,
  includeGameMenu = true,
  diagnoseOnClick = false,
  luaErrorOnClick = false,
  luaErrorOnHide = false,
  requireBankAliasOnHide = false,
} = {}) {
  const frames = new Map();
  if (includeGameMenu) frames.set("GameMenuFrame", frame("GameMenuFrame", "Frame"));
  if (includeBackpack) frames.set("MainMenuBarBackpackButton", frame("MainMenuBarBackpackButton", "CheckButton"));
  for (let index = 0; index < 4; index += 1) {
    frames.set(`CharacterBag${index}Slot`, frame(`CharacterBag${index}Slot`, "CheckButton", 20 + index));
  }
  frames.set("KeyRingButton", frame("KeyRingButton", "CheckButton"));
  for (let index = 1; index <= 13; index += 1) frames.set(`ContainerFrame${index}`, frame(`ContainerFrame${index}`, "Frame"));
  const elements = new Map([...frames].map(([name, value]) => [name, rendered(name, value.type)]));
  const backpack = frames.get("MainMenuBarBackpackButton");
  const firstContainer = frames.get("ContainerFrame1");
  const globals = new Map();
  const vm = {
    errors: [],
    getGlobal(name) { return globals.get(name); },
    setGlobal(name, value) {
      if (value === undefined) globals.delete(name); else globals.set(name, value);
    },
  };
  const behavior = { diagnoseOnClick, luaErrorOnClick, luaErrorOnHide, requireBankAliasOnHide };
  const bridge = {
    diagnostics: [],
    getFrame(name) { return frames.get(name); },
    hasScript() { return true; },
    Click(target) {
      if (behavior.diagnoseOnClick) bridge.diagnostics.push("bag click failed");
      if (behavior.luaErrorOnClick) vm.errors.push("nil global in stock bag click");
      if (target === backpack) firstContainer.visible = true;
      return true;
    },
    Hide(target) {
      if (behavior.requireBankAliasOnHide && target.visible && vm.getGlobal("BankFrame") === undefined) {
        vm.errors.push("nil global BankFrame in stock bag hide");
      }
      if (behavior.luaErrorOnHide && target.visible) vm.errors.push("nil global in stock bag hide");
      target.visible = false;
      return true;
    },
  };
  return {
    boot: { bridge, vm },
    renderer: { elementFor(target) { return elements.get(target.name); } },
    frames,
    behavior,
  };
}

test("bag mount gate stays in native fallback when the stock backpack root is absent", () => {
  const setup = fixture({ includeBackpack: false });
  const result = frameXmlBagGate(setup.boot, setup.renderer);
  assert.equal(result, undefined);
});

test("bag mount gate stays in native fallback without the stock game-menu guard", () => {
  const setup = fixture({ includeGameMenu: false });
  assert.equal(frameXmlBagGate(setup.boot, setup.renderer), undefined);
});

test("bag mount gate stays in native fallback when PaperDoll inventory IDs are not stock", () => {
  const setup = fixture();
  setup.frames.get("CharacterBag2Slot").id = 0;
  assert.equal(frameXmlBagGate(setup.boot, setup.renderer), undefined);
});

test("bag mount gate probes the real backpack click before publishing an owner", () => {
  const setup = fixture();
  const owner = frameXmlBagGate(setup.boot, setup.renderer);
  assert.ok(owner);
  assert.equal(owner.isOpen(), false, "the probe closes its temporary frame");
  assert.equal(setup.frames.get("ContainerFrame1").visible, false);
  owner.close();
});

test("a stock click diagnostic keeps native bags as the fallback", () => {
  const setup = fixture({ diagnoseOnClick: true });
  assert.equal(frameXmlBagGate(setup.boot, setup.renderer), undefined);
  assert.equal(setup.frames.get("ContainerFrame1").visible, false);
});

test("a stock Lua click error keeps the native bags as the fallback", () => {
  const setup = fixture({ luaErrorOnClick: true });
  assert.equal(frameXmlBagGate(setup.boot, setup.renderer), undefined);
  assert.equal(setup.frames.get("ContainerFrame1").visible, false);
});

test("a stock Lua hide error keeps the native bags as the fallback", () => {
  const setup = fixture({ luaErrorOnHide: true });
  assert.equal(frameXmlBagGate(setup.boot, setup.renderer), undefined);
  assert.equal(setup.frames.get("ContainerFrame1").visible, false);
});

test("the probe keeps a temporary BankFrame alias through ContainerFrame_OnHide", () => {
  const setup = fixture({ requireBankAliasOnHide: true });
  const owner = frameXmlBagGate(setup.boot, setup.renderer);
  assert.ok(owner, "ContainerFrame_OnHide must see the VM-local BankFrame proxy");
  assert.equal(setup.boot.vm.getGlobal("BankFrame"), undefined,
    "the proxy is cleaned after the transactional probe");
  owner.close();
  assert.equal(setup.boot.vm.getGlobal("BankFrame"), undefined,
    "owner close also cleans the alias");
});

test("the bounded gate aliases only a missing options frame to the hidden game menu", () => {
  const setup = fixture({ includeGameMenu: true });
  const owner = frameXmlBagGate(setup.boot, setup.renderer);
  assert.ok(owner);
  assert.equal(setup.boot.vm.getGlobal("InterfaceOptionsFrame"), undefined);
  assert.equal(setup.boot.vm.getGlobal("MerchantFrame"), setup.frames.get("GameMenuFrame"),
    "missing MerchantFrame is proxied by the hidden stock game menu for item clicks");
  assert.equal(setup.boot.vm.getGlobal("StackSplitFrame"), setup.frames.get("GameMenuFrame"),
    "missing StackSplitFrame is proxied by the hidden stock game menu for item clicks");
  owner.toggleBackpack();
  assert.equal(setup.boot.vm.getGlobal("InterfaceOptionsFrame"), undefined);
  owner.close();
  assert.equal(setup.boot.vm.getGlobal("MerchantFrame"), setup.frames.get("GameMenuFrame"),
    "compatibility globals stay alive for the whole owner lifetime");
  owner.dispose?.();
  assert.equal(setup.boot.vm.getGlobal("MerchantFrame"), undefined,
    "owner disposal removes the MerchantFrame proxy");
  assert.equal(setup.boot.vm.getGlobal("StackSplitFrame"), undefined,
    "owner disposal removes the StackSplitFrame proxy");
});

test("a post-publish stock error demotes the owner and releases its VM aliases", () => {
  const setup = fixture();
  let failures = 0;
  const owner = frameXmlBagGate(setup.boot, setup.renderer, () => { failures += 1; });
  assert.ok(owner);
  const release = publishFrameXmlBags(owner);
  setup.behavior.luaErrorOnClick = true;
  assert.equal(toggleFrameXmlBackpack(), false, "a failed stock operation permits native fallback");
  assert.equal(frameXmlBagsOpen(), false, "the failed owner is no longer authoritative");
  assert.equal(failures, 1, "mount failure callback runs once");
  assert.equal(setup.boot.vm.getGlobal("MerchantFrame"), undefined);
  assert.equal(setup.boot.vm.getGlobal("StackSplitFrame"), undefined);
  release();
  assert.equal(failures, 1, "stale cleanup does not demote a second time");
});

test("the real MPQ stock backpack click opens and closes through the gated owner", withClient, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
  const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
  const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
  const chain = await clientArchives(clientDirectory);
  const decoder = new TextDecoder("utf-8");
  const seam = new CannedWorldSeam();
  const subset = [
    ...FRAMEXML_VERTICAL_TOC,
    "MoneyFrame.lua",
    "MoneyFrame.xml",
    "GameMenuFrame.xml",
    "MainMenuBarBagButtons.xml",
  ];
  const boot = new FrameXmlBoot({
    subset,
    exercise: false,
    seam,
    provider: {
      async read(path) {
        const bytes = await chain.read(path);
        return bytes ? decoder.decode(bytes) : undefined;
      },
    },
    screen: () => ({ width: 1024, height: 768 }),
  });
  try {
    await boot.load();
    const renderer = {
      elementFor(target) {
        const element = fakeNode("div");
        element.setAttribute("data-framexml-name", target.name);
        element.setAttribute("data-framexml-type", target.type);
        return element;
      },
    };
    const vmErrors = boot.vm.errors.length;
    const diagnostics = boot.bridge.diagnostics.length;
    const owner = frameXmlBagGate(boot, renderer);
    assert.ok(owner, "all stock bag dependencies and the real bridge click must pass");
    assert.equal(owner.isOpen(), false, "the probe is transactional");
    assert.equal(boot.vm.errors.length, vmErrors);
    assert.equal(boot.bridge.diagnostics.length, diagnostics);
    owner.toggleBackpack();
    assert.equal(owner.isOpen(), true);
    assert.equal(boot.vm.errors.length, vmErrors);
    owner.close();
    assert.equal(owner.isOpen(), false);
  } finally {
    boot.close();
    chain.close();
  }
});
