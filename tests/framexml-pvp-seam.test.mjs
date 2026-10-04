import assert from "node:assert/strict";
import test from "node:test";

const { CannedWorldSeam, CANNED_HONOR } = await import(
  "../dist/code/browser/framexml/CannedWorldSeam.js",
);
const { FRAMEXML_SEAM_BINDINGS, FRAMEXML_SEAM_EVENTS } = await import(
  "../dist/code/browser/framexml/FrameXmlWorldSeam.js",
);

function api(seam, name, ...args) {
  const binding = FRAMEXML_SEAM_BINDINGS[name];
  assert.equal(typeof binding, "function", `${name} seam binding exists`);
  return [...binding(seam, args)];
}

test("Canned PvP seam answers current honor and arena currency without fabricating caps", () => {
  const seam = new CannedWorldSeam();
  assert.deepEqual(api(seam, "GetHonorCurrency"), [CANNED_HONOR.honorCurrency, 75000]);
  assert.deepEqual(api(seam, "GetArenaCurrency"), [CANNED_HONOR.arenaCurrency, 10000]);
  assert.deepEqual(api(seam, "GetPVPSessionStats"), [
    CANNED_HONOR.todayHonorableKills, CANNED_HONOR.todayContribution,
  ]);
});

test("Canned PvP attach seeds one honor edge and detaches silently", () => {
  const seam = new CannedWorldSeam();
  const events = [];
  const pump = {
    now: () => 100,
    fire(event, ...args) { events.push([event, ...args]); return 1; },
  };
  seam.attach(pump);
  assert.equal(events.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.pvpKillsChanged).length, 1);
  seam.detach();
  events.length = 0;
  seam.tick(101);
  assert.deepEqual(events, []);
});

// FrameXmlWorldMount imports the browser-side owner modules.  Keep this gate
// proof DOM-free in production by supplying only the document surface those
// modules touch at import time; the MPQ bridge below remains the real fixture.
function mountTestNode(tag = "div") {
  const classes = new Set();
  return {
    tagName: tag.toUpperCase(),
    style: {},
    dataset: {},
    hidden: false,
    value: "",
    clientWidth: 1024,
    clientHeight: 768,
    children: [],
    parentNode: undefined,
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
      for (const child of children) {
        child.parentNode = this;
        this.children.push(child);
      }
    },
    replaceChildren(...children) { this.children = [...children]; },
    remove() {
      if (this.parentNode) {
        this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
      }
      this.parentNode = undefined;
    },
    setAttribute() {},
    getAttribute() { return null; },
    removeAttribute() {},
    addEventListener() {},
    removeEventListener() {},
    querySelector(selector) {
      return selector === 'button[type="submit"]' ? mountTestNode("button") : null;
    },
    querySelectorAll() { return []; },
    getContext() { return {}; },
  };
}

const mountTestDocument = {
  head: mountTestNode("head"),
  body: mountTestNode("body"),
  createElement(tag) { return mountTestNode(tag); },
  getElementById() { return mountTestNode(); },
  querySelectorAll() { return []; },
};
mountTestDocument.head.ownerDocument = mountTestDocument;
mountTestDocument.body.ownerDocument = mountTestDocument;
globalThis.document = mountTestDocument;
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

let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}

test("real PVPFrame owns honor and stock battleground pages", {
  skip: clientDirectory ? false : "no 3.3.5a client on this machine",
}, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
  const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
  const chain = await clientArchives(clientDirectory);
  const decoder = new TextDecoder("utf-8");
  const requests = new Set();
  const seam = new CannedWorldSeam();
  const boot = new FrameXmlBoot({
    provider: {
      async read(path) {
        requests.add(path.replaceAll("\\", "/").toLowerCase());
        const data = await chain.read(path);
        return data ? decoder.decode(data) : undefined;
      },
    },
    locale: "ruRU",
    subset: FRAMEXML_VERTICAL_TOC,
    seam,
    screen: () => ({ width: 1024, height: 768 }),
    exercise: false,
  });
  try {
    const inventory = await boot.load();
    assert.ok(requests.has("interface/framexml/pvpframe.xml"));
    assert.ok(requests.has("interface/framexml/pvpframetemplates.xml"));
    assert.ok(requests.has("interface/framexml/pvpframe.lua"));
    assert.equal(inventory.files.missing.length, 0);
    assert.equal(inventory.xml.failed.length, 0);
    assert.equal(inventory.lua.failed, 0);
    const root = boot.bridge.getFrame("PVPParentFrame");
    const honor = boot.bridge.getFrame("PVPFrame");
    const honorTab = boot.bridge.getFrame("PVPParentFrameTab1");
    const battlegroundTab = boot.bridge.getFrame("PVPParentFrameTab2");
    assert.ok(root && honor && honorTab && battlegroundTab);
    assert.equal(root.visible, false, "PVPParentFrame starts hidden");
    const errorsBeforeShow = boot.vm.errors.length;
    assert.equal(boot.bridge.Show(root), true);
    assert.equal(boot.vm.errors.length, errorsBeforeShow,
      "opening the honor page adds no Lua errors");
    assert.equal(boot.bridge.isVisible(honor), true);
    assert.equal(boot.bridge.getFrame("PVPHonorTodayKills").text, "42");
    assert.equal(boot.bridge.getFrame("PVPHonorTodayHonor").text, "900");
    assert.equal(boot.bridge.getFrame("PVPHonorYesterdayKills").text, "17");
    assert.equal(boot.bridge.getFrame("PVPHonorYesterdayHonor").text, "650");
    assert.equal(boot.bridge.getFrame("PVPFrameHonorPoints").text, "4567");
    assert.equal(boot.bridge.getFrame("PVPFrameArenaPoints").text, "321");
    const battleground = boot.bridge.getFrame("PVPBattlegroundFrame");
    const battlegroundName = boot.bridge.getFrame("BattlegroundType1Text");
    const battlegroundDescription = boot.bridge.getFrame(
      "PVPBattlegroundFrameInfoScrollFrameChildFrameDescription",
    );
    assert.ok(battleground && battlegroundName && battlegroundDescription);
    assert.equal(boot.bridge.Click(battlegroundTab), true);
    assert.equal(boot.bridge.isVisible(battleground), true);
    assert.equal(battlegroundName.text, "Alterac Valley");
    // OnShow populates the list; the first row's description is selected by the row click path.
    assert.equal(boot.bridge.Click(boot.bridge.getFrame("BattlegroundType2")), true);
    assert.equal(battlegroundDescription.text, "Capture the enemy flag.");
    assert.equal(boot.bridge.Hide(battlegroundTab), true);
    assert.equal(boot.bridge.isVisible(battlegroundTab), false);
    assert.equal(boot.bridge.Hide(root), true);
    assert.equal(boot.bridge.isVisible(root), false);
  } finally {
    boot.close();
  }
});

test("PVP mount gate publishes the complete battleground page and disables no tab", {
  skip: clientDirectory ? false : "no 3.3.5a client on this machine",
}, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
  const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
  const { frameXmlPvpGate } = await import("../dist/code/browser/framexml/FrameXmlWorldMount.js");
  const pvpController = await import("../dist/code/browser/framexml/FrameXmlPvpController.js");
  const chain = await clientArchives(clientDirectory);
  const decoder = new TextDecoder("utf-8");
  const seam = new CannedWorldSeam();
  const boot = new FrameXmlBoot({
    provider: {
      async read(path) {
        const data = await chain.read(path);
        return data ? decoder.decode(data) : undefined;
      },
    },
    locale: "ruRU",
    subset: FRAMEXML_VERTICAL_TOC,
    seam,
    screen: () => ({ width: 1024, height: 768 }),
    exercise: false,
  });
  let release;
  try {
    await boot.load();
    const elements = new Map();
    for (const current of boot.bridge.frames) {
      elements.set(current, {
        parentElement: current.parent ? elements.get(current.parent) : undefined,
        getAttribute(attribute) {
          if (attribute === "data-framexml-name") return current.name;
          if (attribute === "data-framexml-type") return current.type;
          return null;
        },
      });
    }
    // FrameXmlWorldMount's gate is intentionally renderer-only after boot; no browser DOM or
    // portrait adoption is needed to prove its ownership boundary.
    const renderer = { elementFor(frame) { return elements.get(frame); } };
    const gate = frameXmlPvpGate(seam, boot, renderer);
    const battlegroundTab = boot.bridge.getFrame("PVPParentFrameTab2");
    assert.ok(battlegroundTab);
    assert.ok(gate, "the real PVP parent tree passes the structural gate");
    assert.equal(gate.disabledTabs.length, 0);
    assert.ok(gate.battleground, "the complete stock battleground tree is gated");
    const type1 = boot.bridge.getFrame("BattlegroundType1");
    assert.ok(type1?.children.some((child) => child.name === "BattlegroundType1Text"),
      "PVPBattlegroundButtonTemplate resolves its inherited title child");
    assert.ok(type1?.scriptSources.has("OnLoad") && type1.scriptSources.has("OnClick"),
      "PVPBattlegroundButtonTemplate resolves its inherited scripts");
    assert.equal(battlegroundTab.enabled, true);
    assert.equal(battlegroundTab.visible, true, "the supported second tab remains shown");
    assert.equal(boot.bridge.isVisible(gate.frame), false);
    // The hidden BattlefieldFrame keeps only the queue status: the Wintergrasp manager events and
    // BATTLEFIELDS_SHOW stay unregistered, while UPDATE_BATTLEFIELD_STATUS is the stock route to
    // CONFIRM_BATTLEFIELD_ENTRY (BattlefieldFrame.lua:56-59, 289) that the popup owner detects.
    assert.deepEqual([...boot.bridge.getFrame("BattlefieldFrame").registeredEvents], ["UPDATE_BATTLEFIELD_STATUS"],
      "the hidden BattlefieldFrame retains only the queue status");
    const { frameXmlPopupsBattlefieldEntryReady } = await import("../dist/code/browser/framexml/FrameXmlPopupsOwner.js");
    assert.equal(frameXmlPopupsBattlefieldEntryReady(boot.bridge), true, "stock can raise CONFIRM_BATTLEFIELD_ENTRY");
    const errorsBeforeStatus = boot.vm.errors.length + boot.errors.length;
    boot.bridge.dispatchEvent("UPDATE_BATTLEFIELD_STATUS", 1);
    assert.equal(boot.vm.errors.length + boot.errors.length, errorsBeforeStatus,
      `a queue status reaches BattlefieldFrame_UpdateStatus without a Lua error: ${JSON.stringify(boot.errors.slice(-1))}`);
    assert.equal(boot.bridge.isVisible(boot.bridge.getFrame("BattlefieldFrame")), false, "and the frame stays hidden");

    // Every live status reaches BattlefieldFrame_UpdateStatus now, not just «confirm»: «queued» reads
    // the queue clocks (:260-261), «active» the shutdown timer (:303), and one Lua error there ends
    // the loop before a second slot's invitation. Statuses as LiveWorldSeam answers them.
    const lua = (code) => {
      const fn = boot.vm.compileFunction(code, "pvp-seam-test", []);
      try { return boot.vm.call(fn, [], 1)[0]; } finally { boot.vm.release(fn); }
    };
    const NONE = ["none", undefined, 0, 0, 0, 0, false];
    const slots = [NONE, NONE];
    let clocks = { queue: [0, 0], instance: [0, 0] };
    seam.battlefieldStatus = (index) => slots[index - 1] ?? NONE;
    seam.battlefieldQueueTimes = (index) => slots[index - 1]?.[0] === "queued" ? clocks.queue : [0, 0];
    seam.battlefieldInstanceTimes = () => clocks.instance;
    const status = (index) => {
      const before = boot.errors.length + boot.vm.errors.length;
      boot.bridge.dispatchEvent("UPDATE_BATTLEFIELD_STATUS", index);
      assert.equal(boot.errors.length + boot.vm.errors.length, before,
        `UPDATE_BATTLEFIELD_STATUS(${index}) ${JSON.stringify(slots)}: ${JSON.stringify(boot.errors.slice(before))}`);
    };
    const entryDialog = () => lua(`for i = 1, STATICPOPUP_NUMDIALOGS do local f = _G["StaticPopup" .. i]
      if f:IsShown() and f.which == "CONFIRM_BATTLEFIELD_ENTRY" then
        -- 3.3.5's Button:IsEnabled answers 1 or 0.
        return _G["StaticPopup" .. i .. "Text"]:GetText() .. "|" .. (f.button2:IsEnabled() == 1 and "leave" or "no-leave") end end`);
    slots[0] = ["queued", "Ущелье Песни Войны", 0, 10, 19, 0, false];
    clocks = { queue: [90_000, 30_000], instance: [0, 0] };
    status(1);
    assert.equal(lua("return MiniMapBattlefieldFrame:IsShown()"), true, "the queue shows the minimap eye");
    assert.match(lua("return MiniMapBattlefieldFrame.tooltip"), /^[^\n]*Ущелье Песни Войны\n[^\n]*: 1 мин\. [^\n]*\n[^\n]*: 30 с\.\n/,
      "its tooltip carries the estimated wait and the time waited");
    slots[1] = ["confirm", "Альтеракская долина", 0, 51, 60, 0, false];
    status(2);
    assert.equal(entryDialog(), "Вы можете войти на поле боя: Альтеракская долина. Ваше решение:|leave",
      "a second slot's invitation opens behind a queued first slot; a battleground can be left");
    lua("StaticPopup_Hide('CONFIRM_BATTLEFIELD_ENTRY', 2)");
    slots[0] = ["active", "Ущелье Песни Войны", 3, 10, 19, 0, false];
    clocks = { queue: [0, 0], instance: [120_000, 900_000] };
    status(2);
    assert.match(entryDialog(), /Альтеракская долина/, "and behind a running match");
    assert.equal(lua("return MiniMapBattlefieldFrame.status"), "active");
    assert.equal(lua("return BATTLEFIELD_SHUTDOWN_TIMER"), 120, "an ended match counts to its shutdown");
    const beforeTick = boot.errors.length + boot.vm.errors.length;
    lua("BattlefieldTimerFrame_OnUpdate(BattlefieldTimerFrame, 3.5)");
    assert.equal(boot.errors.length + boot.vm.errors.length, beforeTick, "the shutdown timer ticks without a Lua error");
    lua("StaticPopup_Hide('CONFIRM_BATTLEFIELD_ENTRY', 2)");
    // An arena: queued for all arenas without a map name, then invited; stock names it by type and
    // offers no Leave Queue (StaticPopup.lua:492).
    slots[0] = NONE;
    slots[1] = ["queued", "", 0, 80, 80, 2, false];
    clocks = { queue: [0, 5_000], instance: [0, 0] };
    status(2);
    assert.match(lua("return MiniMapBattlefieldFrame.tooltip"), /Стычка \(2 против 2\)/);
    slots[1] = ["confirm", "Арена Награнда", 0, 80, 80, 2, false];
    status(2);
    assert.equal(entryDialog(), "Вы можете войти на поле боя: Стычка (2 против 2). Ваше решение:|no-leave");
    lua("StaticPopup_Hide('CONFIRM_BATTLEFIELD_ENTRY', 2)");
    slots[1] = NONE;
    status(2);
    assert.equal(lua("return MiniMapBattlefieldFrame:IsShown()"), false, "no queue, no eye");
    delete seam.battlefieldStatus;
    delete seam.battlefieldQueueTimes;
    delete seam.battlefieldInstanceTimes;

    assert.equal(boot.bridge.Show(gate.frame), true);
    assert.equal(boot.bridge.Click(battlegroundTab), true);
    assert.equal(boot.bridge.isVisible(gate.battleground), true,
      "the supported battleground tab reveals the stock page");
    assert.equal(boot.bridge.Hide(gate.frame), true);
    const errorsBeforeOpen = boot.vm.errors.length;
    release = pvpController.publishFrameXmlPvp({
      isOpen: () => boot.bridge.isVisible(gate.frame),
      show: () => { boot.bridge.Show(gate.frame); },
      hide: () => { boot.bridge.Hide(gate.frame); },
    });
    assert.equal(pvpController.toggleFrameXmlPvp(), true,
      "the mounted owner is the H/controller route");
    assert.equal(boot.bridge.isVisible(gate.frame), true);
    assert.equal(boot.vm.errors.length, errorsBeforeOpen,
      "opening the mounted owner adds no Lua error");
    assert.equal(pvpController.closeFrameXmlPvp(), true,
      "Escape closes the mounted stock owner");
    assert.equal(boot.bridge.isVisible(gate.frame), false);

    // A seemingly present root must not claim ownership when one concrete inherited child is
    // absent from the renderer; the native/fallback route remains available in that case.
    const description = boot.bridge.getFrame(
      "PVPBattlegroundFrameInfoScrollFrameChildFrameDescription",
    );
    elements.delete(description);
    const degraded = frameXmlPvpGate(seam, boot, renderer);
    assert.ok(degraded);
    assert.equal(degraded.disabledTabs.length, 1);
    assert.equal(degraded.disabledTabs[0].enabled, false);
    assert.equal(boot.bridge.isVisible(degraded.disabledTabs[0]), false);
    // Without the battleground page stock cannot name a queue, so the status stays with the native
    // «Войти в бой» row: BattlefieldFrame hears nothing and the popup owner leaves the entry alone.
    assert.deepEqual([...boot.bridge.getFrame("BattlefieldFrame").registeredEvents], [],
      "a degraded gate leaves BattlefieldFrame deaf");
    assert.equal(frameXmlPopupsBattlefieldEntryReady(boot.bridge), false);
  } finally {
    release?.();
    boot.close();
    chain.close();
  }
});
