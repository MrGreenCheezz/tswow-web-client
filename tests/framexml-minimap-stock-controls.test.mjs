import assert from "node:assert/strict";
import test from "node:test";

// MPQ-backed: MiniMapWorldMapButton's own OnClick (Minimap.xml) and the Blizzard_TimeManager
// add-on come from the retail client. The host only reroutes the one button and loads the add-on.
let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine" };

// FrameXmlWorldMount's import graph resolves page ids at import; an inert DOM is enough here.
function inertNode() {
  const node = {
    hidden: true, dataset: {}, children: [], className: "", width: 0, height: 0, value: "",
    style: { setProperty() {}, removeProperty() {} },
    classList: { add() {}, remove() {}, toggle() { return false; }, contains() { return false; } },
    append() {}, insertBefore() {}, remove() {}, replaceChildren() {},
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    addEventListener() {}, removeEventListener() {},
    querySelector(selector) { return selector === 'button[type="submit"]' ? inertNode() : null; },
    querySelectorAll() { return []; },
    getContext() { return undefined; },
    getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
  };
  return node;
}
globalThis.document = {
  head: inertNode(), body: inertNode(),
  getElementById: inertNode, createElement: inertNode, querySelectorAll() { return []; },
};
globalThis.window = {
  innerWidth: 1024, innerHeight: 768, devicePixelRatio: 1,
  location: { protocol: "http:", hostname: "localhost" },
  addEventListener() {}, removeEventListener() {},
  requestAnimationFrame() { return 0; }, cancelAnimationFrame() {},
};
globalThis.location = globalThis.window.location;
globalThis.localStorage = { getItem() { return null; }, setItem() {} };

const { FrameXmlBoot, FRAMEXML_VERTICAL_EXERCISE_EVENTS } =
  await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { GlueLuaVm } = await import("../dist/code/browser/glue/GlueLua.js");
const {
  installFrameXmlMinimapWorldMapButton,
  loadFrameXmlStockClock,
} = await import("../dist/code/browser/framexml/FrameXmlWorldMount.js");

const decoder = new TextDecoder("utf-8");

async function bootVertical() {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const chain = await clientArchives(clientDirectory);
  const boot = new FrameXmlBoot({
    provider: {
      async read(path) {
        const data = await chain.read(path);
        return data ? decoder.decode(data) : undefined;
      },
    },
    locale: "ruRU",
    subset: FRAMEXML_VERTICAL_TOC,
    seam: new CannedWorldSeam(),
    exerciseEvents: FRAMEXML_VERTICAL_EXERCISE_EVENTS,
    screen: () => ({ width: 1024, height: 768 }),
  });
  await boot.load();
  return { boot, chain };
}

function luaString(boot, expression) {
  const probe = boot.vm.execute(`__minimapProbe = tostring(${expression})`, "@minimap-stock-controls");
  assert.equal(probe.ok, true, probe.error);
  return boot.vm.getGlobal("__minimapProbe");
}

test("MPQ minimap world-map button and stock clock go through the host owners", withClient, async () => {
  const { boot, chain } = await bootVertical();
  try {
    const button = boot.bridge.getFrame("MiniMapWorldMapButton");
    const worldMap = boot.bridge.getFrame("WorldMapFrame");
    assert.ok(button && worldMap, "stock MiniMapWorldMapButton and WorldMapFrame are loaded");
    assert.equal(worldMap.visible, false);

    // Stock OnClick is ToggleFrame(WorldMapFrame): it would show the map past the host's
    // readiness gate. After the install the click reaches the gated host toggle only.
    let toggles = 0;
    assert.equal(installFrameXmlMinimapWorldMapButton(boot, () => { toggles += 1; }), true);
    assert.equal(boot.bridge.Click(button, "LeftButton", false), true);
    assert.equal(toggles, 1, "the click reached the host toggleWorldMap");
    assert.equal(worldMap.visible, false, "the click did not show WorldMapFrame by itself");

    // Blizzard_TimeManager: the host LoD path, then TimeManagerClockButton_Show() for showClock.
    assert.equal(luaString(boot, 'IsAddOnLoaded("Blizzard_TimeManager")'), "false");
    assert.equal(boot.bridge.getFrame("TimeManagerClockButton")?.name, undefined, "no clock before the load");
    const errorsBefore = boot.errorCount;
    assert.equal(await loadFrameXmlStockClock(boot), true);
    const clock = boot.bridge.getFrame("TimeManagerClockButton");
    assert.ok(clock, "the stock clock button exists after the load");
    assert.equal(clock.parent?.name, "Minimap", "the clock is authored on the stock Minimap");
    assert.equal(boot.bridge.isVisible(clock), true, "showClock (or its 3.3.5 default) shows the clock");
    assert.equal(luaString(boot, 'IsAddOnLoaded("Blizzard_TimeManager")'), "true");
    assert.match(luaString(boot, "TimeManagerClockTicker:GetText()"), /^\d{1,2}:\d{2}/,
      "the ticker shows the realm time");
    assert.equal(boot.errorCount - errorsBefore, 0, "the add-on loads without a Lua error");
  } finally {
    boot.close();
    chain.close();
  }
});

test("the stock clock respects showClock and needs UIParent's TimeManager loader", async () => {
  const bootWith = (cvar, withLoader) => {
    const vm = new GlueLuaVm();
    vm.execute(`
      __shown = 0
      GetCVar = function(name) if name == "showClock" then return ${cvar === undefined ? "nil" : `"${cvar}"`} end end
      ${withLoader ? "TimeManager_LoadUI = function() end" : ""}
    `, "@t");
    const loads = [];
    return {
      vm,
      loads,
      loadAddon: async (name) => {
        loads.push(name);
        vm.execute("function TimeManagerClockButton_Show() __shown = __shown + 1 end", "@t");
        return { ok: true, addon: name, status: "loaded", dependencies: [], loaded: [name], roots: [] };
      },
    };
  };
  for (const [cvar, expected] of [["1", 1], [undefined, 1], ["0", 0]]) {
    const boot = bootWith(cvar, true);
    try {
      assert.equal(await loadFrameXmlStockClock(boot), true);
      assert.deepEqual(boot.loads, ["Blizzard_TimeManager"]);
      assert.equal(boot.vm.getGlobal("__shown"), expected, `showClock=${cvar}`);
    } finally {
      boot.vm.close();
    }
  }
  const bare = bootWith("1", false);
  try {
    assert.equal(await loadFrameXmlStockClock(bare), false);
    assert.deepEqual(bare.loads, [], "a corpus without TimeManager_LoadUI loads nothing");
  } finally {
    bare.vm.close();
  }
});
