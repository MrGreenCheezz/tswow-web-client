import assert from "node:assert/strict";
import test, { after } from "node:test";

/** Minimal DOM surface used by the production renderer in the integration below. */
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
        add(...names) { for (const name of names) classes.add(name); node.className = [...classes].join(" "); },
        remove(...names) { for (const name of names) classes.delete(name); node.className = [...classes].join(" "); },
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
        return selector === 'button[type="submit"]' ? makeNode("button") : undefined;
      },
      querySelectorAll() { return []; },
      closest() { return null; },
      focus() { doc.activeElement = node; },
      blur() { if (doc.activeElement === node) doc.activeElement = undefined; },
      setSelectionRange() {},
      getContext() { return undefined; },
    };
    return node;
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
  requestAnimationFrame: () => 1,
  cancelAnimationFrame() {},
};
globalThis.location = { protocol: "http:", hostname: "localhost" };
globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };

// The add-on is deliberately loaded through the real MPQ provider.  A synthetic XML fixture can
// prove that LoadAddOn works, but it cannot prove that Blizzard_TalentUI.lua's first Show/Update
// path reaches the same C API names as the 3.3.5 client.
let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine" };
let archiveChainPromise;
async function archiveChain() {
  if (!archiveChainPromise) {
    archiveChainPromise = import("../tools/mpq.mjs")
      .then(({ clientArchives }) => clientArchives(clientDirectory));
  }
  return await archiveChainPromise;
}
after(async () => {
  if (archiveChainPromise) (await archiveChainPromise).close();
});

const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { resolveFrameXmlTalentSnapshot } = await import(
  "../dist/code/browser/framexml/FrameXmlTalentResolver.js",
);
const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { FRAMEXML_VERTICAL_TOC } = await import(
  "../dist/code/browser/framexml/FrameXmlCorpus.js",
);
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FrameXmlDomRenderer } = await import(
  "../dist/code/browser/ui/framexml_compat/FrameXmlDomRenderer.js"
);
const {
  createPatchedFrameXmlTalentOwner,
  selectFrameXmlWorldRoots,
} = await import("../dist/code/browser/framexml/FrameXmlWorldMount.js");
const {
  publishFrameXmlTalent,
  toggleFrameXmlTalent,
} = await import("../dist/code/browser/framexml/FrameXmlTalentController.js");

function resolverPlayer(classId = 8) {
  return {
    guid: 1n,
    typeId: 4,
    fields: new Map([[UPDATE_FIELDS.UNIT_FIELD_BYTES_0.offset, classId << 8]]),
  };
}

test("talent resolver keeps first tab/cell rank and prerequisite without pet or preview rows", () => {
  const snapshot = resolveFrameXmlTalentSnapshot(
    resolverPlayer(),
    {
      pet: false,
      unspentPoints: 3,
      activeSpec: 0,
      specs: [{
        talents: [{ talentId: 100, rank: 1 }],
        glyphs: [],
      }],
    },
    {
      ready: true,
      revision: 1,
      tabsForClass: () => [{ id: 10, name: "Огонь", orderIndex: 1, iconId: 700 }],
      talentsIn: () => [
        { id: 100, tabId: 10, tier: 0, column: 0, ranks: [1000, 1001], name: "Огненный удар", prerequisites: [] },
        { id: 101, tabId: 10, tier: 1, column: 0, ranks: [1010], name: "Поджог", prerequisites: [{ talentId: 100, rank: 1 }] },
      ],
    },
  );

  assert.ok(snapshot);
  assert.equal(snapshot.groups.length, 1, "player projection has no fabricated pet/inspect group");
  assert.equal(snapshot.groups[0].active, true);
  assert.equal(snapshot.groups[0].tabs.length, 1);
  assert.equal(snapshot.groups[0].tabs[0].name, "Огонь");
  assert.equal(snapshot.groups[0].tabs[0].talents[0].rank, 1);
  assert.equal(snapshot.groups[0].tabs[0].talents[1].rank, 0);
  assert.deepEqual(snapshot.groups[0].tabs[0].talents[1].prerequisites[0], {
    talentId: 100,
    tier: 1,
    column: 1,
    requiredRank: 1,
    meetsPrereq: true,
    meetsPreviewPrereq: undefined,
  });
  assert.equal(snapshot.groups[0].tabs[0].talents[0].previewRank, undefined);
  assert.equal(snapshot.groups[0].tabs[0].talents[0].meetsPreviewPrereq, undefined);
  assert.equal(snapshot.groups[0].tabs[0].talents[0].link, undefined);
});

function normalized(path) {
  return path.replaceAll("\\", "/").toLowerCase();
}

function apiCallCount(boot, name) {
  boot.vm.execute(
    `__fxTalentCallCount = __fxCalls[${JSON.stringify(name)}] or 0`,
    "@talent-call-count",
  );
  return Number(boot.vm.getGlobal("__fxTalentCallCount") ?? 0);
}

test("production subset executes the active retail-talents hook as the only talent root", withClient, async () => {
  const chain = await archiveChain();
  const decoder = new TextDecoder("utf-8");
  const boot = new FrameXmlBoot({
    provider: {
      async read(path) {
        const data = await chain.read(path);
        return data ? decoder.decode(data) : undefined;
      },
    },
    locale: "ruRU",
    seam: new CannedWorldSeam(),
    subset: FRAMEXML_VERTICAL_TOC,
    includeActiveTsAddons: true,
    exercise: false,
    screen: () => ({ width: 1024, height: 768 }),
  });

  try {
    const inventory = await boot.load();
    assert.equal(boot.isAddonLoaded("retail-talents"), true,
      "the marker and generated Lua block survive the production subset");
    assert.ok(inventory.files.addon > 0);
    assert.equal(boot.bridge.getFrame("PlayerTalentFrame")?.name, undefined,
      "production does not load the competing stock LoD root");

    const errorsBeforeOpen = [...boot.vm.errors];
    const toggle = boot.vm.globalFunction("ToggleTalentFrame");
    assert.ok(toggle, "the active module replaced the standard talent hook");
    try { boot.vm.call(toggle, [], 0); }
    finally { boot.vm.release(toggle); }

    const custom = boot.bridge.getFrame("UniversalTalentFrame");
    assert.ok(custom);
    assert.equal(custom.visible, true);
    assert.equal(boot.bridge.getFrame("PlayerTalentFrame")?.name, undefined);
    assert.deepEqual(boot.vm.errors, errorsBeforeOpen,
      "opening the patched owner introduces no Lua failure");
  } finally {
    boot.close();
  }
});

test("production N owner renders the lazy retail-talents root and keeps native fallback hidden", withClient,
  async () => {
    const chain = await archiveChain();
    const decoder = new TextDecoder("utf-8");
    const boot = new FrameXmlBoot({
      provider: {
        async read(path) {
          const data = await chain.read(path);
          return data ? decoder.decode(data) : undefined;
        },
      },
      locale: "ruRU",
      seam: new CannedWorldSeam(),
      subset: FRAMEXML_VERTICAL_TOC,
      includeActiveTsAddons: true,
      exercise: false,
      screen: () => ({ width: 1024, height: 768 }),
    });
    const host = document.createElement("section");
    const renderer = new FrameXmlDomRenderer(host, {
      bridge: boot.bridge,
      createdRootParent: "UIParent",
      includeCreatedRoots: false,
    });
    let cleanup;
    let stopObserving;
    let nativeVisible = true;

    try {
      await boot.load();
      renderer.mount(selectFrameXmlWorldRoots(boot.roots));
      assert.equal(boot.bridge.getFrame("UniversalTalentFrame")?.name, undefined,
        "the TSAddon constructs its window lazily on the first N press");

      const errorsBeforeOpen = boot.errorCount;
      const owner = createPatchedFrameXmlTalentOwner(
        boot,
        renderer,
        () => { nativeVisible = false; },
        () => { nativeVisible = true; },
      );
      assert.ok(owner, "the active retail-talents module publishes a custom talent owner");
      cleanup = publishFrameXmlTalent(owner);
      const publications = [];
      stopObserving = boot.bridge.subscribe(() => {
        const frame = boot.bridge.getFrame("UniversalTalentFrame");
        publications.push({ visible: frame?.visible, children: frame?.children.length });
      });

      assert.equal(toggleFrameXmlTalent(), true, "the N route is consumed by the patched owner");
      const custom = boot.bridge.getFrame("UniversalTalentFrame");
      assert.ok(custom);
      assert.equal(custom.visible, true);
      assert.deepEqual(publications, [{ visible: true, children: custom.children.length }],
        "first N publishes the completed window once, not every intermediate Lua setter");
      const element = renderer.elementFor(custom);
      assert.ok(element, "the UIParent-owned lazy frame is reconciled into the production renderer");
      assert.equal(element.hidden, false);
      // A HIGH window under the MEDIUM UIParent (StoreStyle.lua:93) is drawn in the renderer's strata
      // layer laid over UIParent's box — above UIParent's MEDIUM frames, as in the client. Compared
      // as a boolean: a failing `equal` of two stub DOM trees spends minutes building its diff.
      const drawnIn = element.parentElement;
      assert.ok(drawnIn === renderer.elementFor(boot.bridge.getFrame("UIParent"))
        || drawnIn?.getAttribute("data-framexml-strata-layer") === "UniversalTalentFrame",
        "the custom window remains a rendered child of UIParent (directly or in its strata layer)");
      assert.equal(custom.parent, boot.bridge.getFrame("UIParent"));
      assert.equal(nativeVisible, false, "native talents stay hidden after the custom gate passes");
      assert.equal(boot.bridge.getFrame("PlayerTalentFrame")?.name, undefined,
        "the competing stock talent root is never loaded");
      assert.equal(boot.errorCount, errorsBeforeOpen,
        `opening the custom owner adds no Lua errors: ${boot.vm.errors.join(" | ")}`);

      assert.equal(toggleFrameXmlTalent(), true, "a second N press closes the same custom owner");
      assert.equal(custom.visible, false);
      assert.equal(element.hidden, true);
      assert.equal(nativeVisible, false, "closing custom talents does not resurrect a duplicate native panel");

      publications.length = 0;
      assert.equal(toggleFrameXmlTalent(), true, "the next N reopens the same custom owner");
      assert.equal(renderer.elementFor(custom), element, "reopening retains the existing DOM window");
      assert.equal(element.hidden, false);
      assert.deepEqual(publications, [{ visible: true, children: custom.children.length }],
        "reopening also publishes one complete refresh instead of repainting each card setter");
      assert.equal(boot.errorCount, errorsBeforeOpen);
    } finally {
      stopObserving?.();
      cleanup?.();
      renderer.destroy();
      boot.close();
    }
  });

test("real Blizzard_TalentUI loads asynchronously, starts hidden, and reaches the first talent binding", withClient, async () => {
  const chain = await archiveChain();
  const decoder = new TextDecoder("utf-8");
  const requests = [];
  const seam = new CannedWorldSeam();
  const learnCalls = [];
  const cannedLearnTalent = typeof seam.learnTalent === "function"
    ? seam.learnTalent.bind(seam)
    : undefined;
  // Keep the test spy at the existing WorldClient ownership boundary so one stock click remains
  // exactly one learn request without inventing a second transport in the FrameXML layer.
  seam.learnTalent = (...args) => {
    learnCalls.push(args);
    return cannedLearnTalent?.(...args);
  };
  const boot = new FrameXmlBoot({
    provider: {
      async read(path) {
        requests.push(normalized(path));
        const data = await chain.read(path);
        if (!data) return undefined;
        const source = decoder.decode(data);
        if (normalized(path) !== "interface/framexml/framexml.toc") return source;
        // This is a stock capability diagnostic, not the production path. Keep the complete
        // Blizzard corpus but remove generated TSAddon blocks so their authored replacement of
        // PlayerTalentFrame_Toggle cannot turn the diagnostic into two simultaneous owners.
        let insideTsAddon = false;
        return source.split(/\r?\n/).filter((line) => {
          if (/^\s*##\s*tsaddon-begin(?:-lib|\s*:)/i.test(line)) {
            insideTsAddon = true;
            return false;
          }
          if (/^\s*##\s*tsaddon-end(?:-lib|\s*:)/i.test(line)) {
            insideTsAddon = false;
            return false;
          }
          return !insideTsAddon;
        }).join("\n");
      },
    },
    locale: "ruRU",
    seam,
    exercise: false,
    screen: () => ({ width: 1024, height: 768 }),
  });

  try {
    await boot.load();
    assert.equal(boot.bridge.getFrame("PlayerTalentFrame")?.name, undefined,
      "the load-on-demand root is absent before the async add-on load");

    const pending = boot.loadAddon("Blizzard_TalentUI");
    assert.equal(boot.bridge.getFrame("PlayerTalentFrame")?.name, undefined,
      "Toggle cannot expose a partially loaded add-on");
    const loaded = await pending;
    assert.equal(loaded.ok, true, loaded.message);
    assert.equal(loaded.status, "loaded");
    assert.deepEqual(loaded.loaded, [
      "interface/addons/blizzard_talentui/blizzard_talentui.toc",
      "interface/addons/blizzard_talentui/blizzard_talentui.xml",
      "interface/addons/blizzard_talentui/blizzard_talentui.lua",
      "interface/addons/blizzard_talentui/localization.lua",
    ]);
    assert.ok(requests.includes("interface/addons/blizzard_talentui/blizzard_talentui.xml"));

    const root = boot.bridge.getFrame("PlayerTalentFrame");
    assert.ok(root);
    assert.equal(root.visible, false, "stock PlayerTalentFrame starts hidden");
    const vmErrorsBeforeOpen = [...boot.vm.errors];

    // Open through the same stock toggle used by the lazy in-world owner.  Calling bridge.Show
    // directly skips Blizzard_TalentUI's active-group/selected-tab initialization and leaves the
    // first button reporting tab zero, which is not a valid LearnTalent boundary.
    const toggle = boot.vm.globalFunction("PlayerTalentFrame_Toggle");
    assert.ok(toggle);
    try {
      boot.vm.call(toggle, [false, 1], 0);
    } finally {
      boot.vm.release(toggle);
    }
    // ShowUIPanel is a neutral host helper in the dependency-free bridge; the stock call still
    // performs selection/initialization, then the bridge completes the visible transition.
    if (!root.visible) assert.equal(boot.bridge.Show(root), true);
    const panelGetTab = boot.vm.globalFunction("PanelTemplates_GetSelectedTab");
    const panelTab = panelGetTab ? boot.vm.call(panelGetTab, [root], 1)[0] : "missing";
    if (panelGetTab) boot.vm.release(panelGetTab);
    if (!(Number.isInteger(Number(panelTab)) && Number(panelTab) > 0)) {
      const playerTalentTabOnClick = boot.vm.globalFunction("PlayerTalentTab_OnClick");
      assert.ok(playerTalentTabOnClick);
      try { boot.vm.call(playerTalentTabOnClick, [boot.bridge.getFrame("PlayerTalentFrameTab1")], 0); }
      finally { boot.vm.release(playerTalentTabOnClick); }
    }
    assert.equal(root.visible, true);
    assert.deepEqual(boot.vm.errors, vmErrorsBeforeOpen,
      "opening Blizzard_TalentUI introduces no new unhandled Lua errors");
    assert.ok(apiCallCount(boot, "GetNumTalentGroups") > 0,
      "stock PlayerTalentFrame reached GetNumTalentGroups");
    const getNumTalentGroups = boot.vm.globalFunction("GetNumTalentGroups");
    assert.ok(getNumTalentGroups);
    const groupValues = boot.vm.call(getNumTalentGroups, [false, false], 1);
    boot.vm.release(getNumTalentGroups);
    assert.equal(groupValues[0], 1,
      "GetNumTalentGroups must be bound to the player resolver, not a nil neutral stub");

    const getNumTabs = boot.vm.globalFunction("GetNumTalentTabs");
    assert.ok(getNumTabs);
    const tabCount = boot.vm.call(getNumTabs, [false, false], 1);
    boot.vm.release(getNumTabs);
    assert.equal(tabCount[0], 1);
    const firstTab = boot.vm.globalFunction("GetTalentTabInfo");
    assert.ok(firstTab);
    const tabValues = boot.vm.call(firstTab, [1, false, false, 1], 5);
    boot.vm.release(firstTab);
    assert.equal(tabValues[0], "Огонь");
    assert.equal(typeof tabValues[1], "string");
    assert.ok(tabValues[1].length > 0, "talent tab exposes its SpellIcon texture path");
    assert.equal(typeof tabValues[3], "string");
    assert.ok(tabValues[3].length > 0, "talent tab exposes its TalentTab background basename");
    assert.equal(tabValues[4], 0, "preview points are the honest numeric no-preview value");
    const firstCell = boot.vm.globalFunction("GetTalentInfo");
    assert.ok(firstCell);
    const cellValues = boot.vm.call(firstCell, [1, 1, false, false, 1], 10);
    boot.vm.release(firstCell);
    assert.equal(typeof cellValues[0], "string");
    assert.ok(cellValues[0].length > 0, "first talent button has a resolved name");
    assert.equal(typeof cellValues[1], "string");
    assert.ok(cellValues[1].length > 0, "first talent button has a resolved icon");
    assert.equal(cellValues[4], 1);
    assert.equal(boot.bridge.Click(boot.bridge.getFrame("PlayerTalentFrameTalent1"), "LeftButton", false), true);
    assert.deepEqual(learnCalls, [[1, 1, false, 1]],
      "one stock talent click delegates once to the existing learn boundary");
  } finally {
    boot.close();
  }
});
