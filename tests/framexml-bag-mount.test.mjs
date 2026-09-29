import assert from "node:assert/strict";
import test, { after } from "node:test";

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
/** tools/mpq.mjs clientArchives answers one chain per process: a test that opens it leaves it to this hook. */
const openedChains = new Set();
after(() => { for (const chain of openedChains) chain.close(); });

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
  const created = [];
  const bridge = {
    diagnostics: [],
    created,
    getFrame(name) { return frames.get(name); },
    // Bridge CreateFrame answers a shown, unnamed top-level frame, as the real one does.
    CreateFrame(type) {
      const made = { name: undefined, type, visible: true };
      created.push(made);
      return made;
    },
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

test("the owner keeps the BankFrame alias through stock hide callbacks until disposal", () => {
  const setup = fixture({ requireBankAliasOnHide: true });
  const owner = frameXmlBagGate(setup.boot, setup.renderer);
  assert.ok(owner, "ContainerFrame_OnHide must see the VM-local BankFrame proxy");
  const proxy = setup.boot.bridge.created[0];
  assert.ok(proxy && proxy.visible === false, "the proxy is one dedicated hidden bridge frame");
  assert.equal(setup.boot.vm.getGlobal("BankFrame"), proxy,
    "the proxy remains available to renderer and Lua dispatch after the probe");
  owner.close();
  assert.equal(setup.boot.vm.getGlobal("BankFrame"), proxy,
    "closing bags does not dispose their mouse handlers");
  owner.dispose();
  assert.equal(setup.boot.vm.getGlobal("BankFrame"), undefined,
    "owner disposal cleans the alias");
});

test("missing optional frames alias one dedicated hidden proxy, never the shown game menu", () => {
  const setup = fixture({ includeGameMenu: true });
  // The stock GameMenuFrame is the game menu now: it may be open while the bag gate runs.
  setup.frames.get("GameMenuFrame").visible = true;
  const owner = frameXmlBagGate(setup.boot, setup.renderer);
  assert.ok(owner, "a shown game menu no longer blocks the bag owner");
  assert.equal(setup.boot.bridge.created.length, 1, "exactly one stand-in is created");
  const proxy = setup.boot.bridge.created[0];
  assert.equal(proxy.type, "Frame");
  assert.equal(proxy.visible, false, "the stand-in is hidden, so IsOptionFrameOpen() stays false");
  assert.notEqual(proxy, setup.frames.get("GameMenuFrame"));
  assert.equal(setup.boot.vm.getGlobal("InterfaceOptionsFrame"), proxy);
  assert.equal(setup.boot.vm.getGlobal("MerchantFrame"), proxy,
    "missing MerchantFrame is answered by the hidden stand-in for item clicks");
  assert.equal(setup.boot.vm.getGlobal("StackSplitFrame"), proxy,
    "missing StackSplitFrame is answered by the hidden stand-in for item clicks");
  owner.toggleBackpack();
  assert.equal(setup.boot.vm.getGlobal("InterfaceOptionsFrame"), proxy);
  assert.equal(setup.frames.get("GameMenuFrame").visible, true, "bag clicks leave the open menu alone");
  owner.close();
  assert.equal(setup.boot.vm.getGlobal("MerchantFrame"), proxy,
    "compatibility globals stay alive for the whole owner lifetime");
  owner.dispose?.();
  assert.equal(setup.boot.vm.getGlobal("InterfaceOptionsFrame"), undefined,
    "owner disposal removes the options proxy");
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
  assert.equal(setup.boot.vm.getGlobal("InterfaceOptionsFrame"), undefined);
  assert.equal(setup.boot.vm.getGlobal("BankFrame"), undefined);
  release();
  assert.equal(failures, 1, "stale cleanup does not demote a second time");
});

test("a real frame that takes a global over during the probe keeps it: through the probe, the owner and its release", () => {
  const setup = fixture();
  const { vm, bridge } = setup.boot;
  const options = frame("InterfaceOptionsFrame", "Frame");
  // The real frame takes the global over while the probe's click runs (the options chain's load).
  const click = bridge.Click;
  bridge.Click = (target, ...rest) => {
    const result = click(target, ...rest);
    if (vm.getGlobal("InterfaceOptionsFrame") !== options) vm.setGlobal("InterfaceOptionsFrame", options);
    return result;
  };
  // Every write that took the global away from the real frame: a stand-in over it, or a release.
  const covered = [];
  const write = vm.setGlobal;
  vm.setGlobal = (name, value) => {
    if (vm.getGlobal(name) === options && value !== options) covered.push(name);
    write(name, value);
  };
  const owner = frameXmlBagGate(setup.boot, setup.renderer);
  assert.ok(owner !== undefined);
  assert.equal(vm.getGlobal("InterfaceOptionsFrame") === options, true,
    "after the gate the global is the real frame, not the stand-in reinstalled over it");
  assert.equal(vm.getGlobal("BankFrame") === setup.boot.bridge.created[0], true, "the other stand-ins are installed");
  owner.dispose();
  assert.equal(vm.getGlobal("InterfaceOptionsFrame") === options, true, "and after the owner is released");
  assert.equal(vm.getGlobal("BankFrame") === undefined, true, "while its own stand-ins go");
  assert.deepEqual(covered, [], "no install covered the real frame and no release cleared it");
});

test("the real MPQ options chain replaces the InterfaceOptionsFrame stand-in, and releasing the bags keeps it", withClient, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
  const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
  const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
  const { loadFrameXmlOptionsChain } = await import("../dist/code/browser/framexml/FrameXmlOptionsOwner.js");
  const chain = await clientArchives(clientDirectory);
  openedChains.add(chain);
  const decoder = new TextDecoder("utf-8");
  const boot = new FrameXmlBoot({
    subset: FRAMEXML_VERTICAL_TOC,
    exercise: true,
    seam: new CannedWorldSeam(),
    locale: "ruRU",
    provider: {
      async read(path) {
        const bytes = await chain.read(path);
        return bytes ? decoder.decode(bytes) : undefined;
      },
    },
    screen: () => ({ width: 1365, height: 768 }),
  });
  const lua = (code) => {
    const fn = boot.vm.compileFunction(code, "bag-options-test", []);
    assert.ok(fn !== undefined, "compiles");
    try { return boot.vm.call(fn, [], 1); } finally { boot.vm.release(fn); }
  };
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
    assert.equal(boot.bridge.getFrame("InterfaceOptionsFrame") === undefined, true, "the chain is not loaded at boot");
    const owner = frameXmlBagGate(boot, renderer);
    assert.ok(owner !== undefined, "the stock bags pass their gate");
    const stand = boot.vm.getGlobal("InterfaceOptionsFrame");
    assert.equal(stand?.type, "Frame", "a stand-in answers IsOptionFrameOpen() meanwhile");
    assert.equal(String(stand?.name).startsWith("__framexml_"), true, "an anonymous bridge frame");
    // The first «Интерфейс»: the lazy chain loads into the same VM, and its frame wins the global.
    const loaded = await loadFrameXmlOptionsChain(boot, { preset() {}, storageNote: () => "" });
    assert.equal(loaded.ok, true, loaded.message);
    const options = boot.bridge.getFrame("InterfaceOptionsFrame");
    assert.equal(options?.name, "InterfaceOptionsFrame");
    assert.equal(boot.vm.getGlobal("InterfaceOptionsFrame") === options, true, "the real frame replaced the stand-in");
    const errors = boot.errorCount;
    owner.dispose(); // what an unpublish, a demotion or a /reload teardown runs
    assert.equal(boot.vm.getGlobal("InterfaceOptionsFrame") === options, true, "releasing the bags kept the real frame");
    assert.deepEqual(lua("return IsOptionFrameOpen() and 1 or 0"), [0], "stock's check still reads the real frame");
    assert.equal(boot.errorCount, errors, "no nil InterfaceOptionsFrame error");
  } finally {
    boot.close();
  }
});

test("the real MPQ stock backpack click opens and closes through the gated owner", withClient, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
  const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
  const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
  const chain = await clientArchives(clientDirectory);
  openedChains.add(chain);
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
    const stackSplit = boot.bridge.getFrame("StackSplitFrame");
    assert.equal(stackSplit?.type, "Frame", "StackSplitFrame.xml is in the vertical: a real frame");
    const owner = frameXmlBagGate(boot, renderer);
    assert.ok(owner, "all stock bag dependencies and the real bridge click must pass");
    const options = boot.vm.getGlobal("InterfaceOptionsFrame");
    assert.ok(options && options !== boot.bridge.getFrame("GameMenuFrame"),
      "the missing options frame is a dedicated stand-in, not the game menu");
    assert.equal(options.visible, false);
    assert.equal(boot.vm.getGlobal("StackSplitFrame") === stackSplit, true, "the real StackSplitFrame is not aliased");
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
  }
});
