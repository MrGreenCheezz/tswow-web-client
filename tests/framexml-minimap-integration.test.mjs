import assert from "node:assert/strict";
import test from "node:test";

// This test deliberately goes through the stock 3.3.5a files. A hand-written Minimap frame would
// not prove that Minimap.xml's inheritance, relative Minimap.lua and event handlers still agree.
let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine" };

const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const {
  CannedWorldSeam,
  CANNED_MINIMAP_ZONE,
} = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FRAMEXML_VERTICAL_TOC } =
  await import("../dist/code/browser/framexml/FrameXmlCorpus.js");

const MINIMAP_XML = "interface/framexml/minimap.xml";
const MINIMAP_LUA = "interface/framexml/minimap.lua";
const MINIMAP_API = [
  "GetMinimapZoneText",
  "GetZoneText",
  "GetSubZoneText",
  "GetZonePVPInfo",
];
const decoder = new TextDecoder("utf-8");

function normalized(path) {
  return path.replaceAll("\\", "/").toLowerCase();
}

function makeAdapter() {
  let zoom = 1;
  const setZoomCalls = [];
  const pingCalls = [];
  return {
    adapter: {
      getZoom: () => zoom,
      getZoomLevels: () => 3,
      setZoom: (value) => {
        setZoomCalls.push(value);
        zoom = value;
      },
      pingLocation: (x, y) => pingCalls.push([x, y]),
    },
    get zoom() {
      return zoom;
    },
    setZoomCalls,
    pingCalls,
  };
}

async function loadCandidate(chain, adapter) {
  const requests = [];
  const provider = {
    async read(path) {
      requests.push(normalized(path));
      const data = await chain.read(path);
      return data ? decoder.decode(data) : undefined;
    },
  };
  const seam = new CannedWorldSeam();
  const boot = new FrameXmlBoot({
    provider,
    locale: "ruRU",
    subset: FRAMEXML_VERTICAL_TOC,
    seam,
    minimapAdapter: adapter,
    screen: () => ({ width: 1024, height: 768 }),
  });
  const cursorProbe = boot.vm.execute(
    "__minimapCursorBindingBeforeLoad = rawget(_G, 'GetCursorPosition')",
    "@minimap-integration-cursor-binding-before-load",
  );
  assert.equal(cursorProbe.ok, true, cursorProbe.error ?? "cursor binding probe failed");
  const cursorBindingBeforeLoad = boot.vm.getGlobal("__minimapCursorBindingBeforeLoad");
  const inventory = await boot.load();
  return { boot, seam, inventory, cursorBindingBeforeLoad, requests: new Set(requests) };
}

function frame(boot, name) {
  const result = boot.bridge.getFrame(name);
  assert.ok(result, `${name} exists in the stock MPQ load`);
  return result;
}

function inventoryCensus(inventory) {
  return Object.fromEntries(MINIMAP_API.map((name) => [
    name,
    inventory.api.find((entry) => entry.name === name)?.calls ?? 0,
  ]));
}

/** Read the live wrapper counters without adding another C-API call to the census. */
function liveCensus(boot) {
  const result = {};
  for (const name of MINIMAP_API) {
    const escaped = JSON.stringify(name);
    const executed = boot.vm.execute(
      `__minimapCensus = __fxCalls[${escaped}] or 0`,
      `@minimap-census:${name}`,
    );
    assert.equal(executed.ok, true, executed.error ?? `${name} census probe failed`);
    result[name] = Number(boot.vm.getGlobal("__minimapCensus"));
  }
  return result;
}

test("MPQ Minimap.xml/Lua drives the canned seam and widget adapter", withClient, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const chain = await clientArchives(clientDirectory);
  const adapterState = makeAdapter();
  let candidate;
  try {
    candidate = await loadCandidate(chain, adapterState.adapter);

    assert.ok(candidate.requests.has(MINIMAP_XML), "Minimap.xml was read from MPQ");
    assert.ok(candidate.requests.has(MINIMAP_LUA),
      "Minimap.lua was read through Minimap.xml's relative Script");
    assert.equal(candidate.inventory.files.missing.length, 0,
      "the current vertical MPQ subset has no missing files");
    assert.equal(candidate.inventory.xml.failed.length, 0,
      "Minimap.xml parses without refusal");
    assert.equal(candidate.inventory.lua.failed, 0,
      "Minimap.lua executes successfully");

    const cluster = frame(candidate.boot, "MinimapCluster");
    const watch = frame(candidate.boot, "WatchFrame");
    const battlefield = frame(candidate.boot, "BattlefieldFrame");
    const minimap = frame(candidate.boot, "Minimap");
    const zoneLabel = frame(candidate.boot, "MinimapZoneText");
    const zoomIn = frame(candidate.boot, "MinimapZoomIn");
    const zoomOut = frame(candidate.boot, "MinimapZoomOut");
    assert.equal(cluster.type, "Frame");
    assert.equal(minimap.type, "Minimap");
    assert.equal(zoneLabel.text, CANNED_MINIMAP_ZONE.minimapZoneText,
      "stock Minimap_Update paints the canned zone label");
    assert.deepEqual([...cluster.registeredEvents], [
      "ZONE_CHANGED", "ZONE_CHANGED_INDOORS", "ZONE_CHANGED_NEW_AREA",
    ]);
    assert.deepEqual([
      ["MinimapCluster", cluster],
      ["WatchFrame", watch],
      ["BattlefieldFrame", battlefield],
    ].filter(([, owner]) => owner.registeredEvents.has("ZONE_CHANGED_NEW_AREA"))
      .map(([name]) => name),
    ["MinimapCluster", "WatchFrame", "BattlefieldFrame"],
    "ZONE_CHANGED_NEW_AREA has exactly the MinimapCluster, WatchFrame and BattlefieldFrame handlers");
    const zoneEventOwners = Object.freeze({
      ZONE_CHANGED: Object.freeze([["MinimapCluster", cluster], ["BattlefieldFrame", battlefield]]),
      ZONE_CHANGED_INDOORS: Object.freeze([["MinimapCluster", cluster]]),
      ZONE_CHANGED_NEW_AREA: Object.freeze([
        ["MinimapCluster", cluster], ["WatchFrame", watch], ["BattlefieldFrame", battlefield],
      ]),
    });
    for (const [event, expectedOwners] of Object.entries(zoneEventOwners)) {
      assert.deepEqual(
        expectedOwners.filter(([, owner]) => owner.registeredEvents.has(event)).map(([name]) => name),
        expectedOwners.map(([name]) => name),
        `${event} keeps the required stock handler ownership`,
      );
    }

    // This is the exact load-time census of the stock Minimap.lua path. GetZoneText and
    // GetSubZoneText belong to its tooltip branch and are not reached while the tooltip is closed;
    // a changed count is red evidence of a stock-path or dependency change, not a reason to skip.
    assert.deepEqual(inventoryCensus(candidate.inventory), {
      GetMinimapZoneText: 1,
      GetZoneText: 0,
      GetSubZoneText: 0,
      GetZonePVPInfo: 1,
    }, "exact stock Minimap.lua zone C-API census changed");
    assert.deepEqual(liveCensus(candidate.boot), inventoryCensus(candidate.inventory),
      "inventory census matches the live Lua wrappers");

    assert.equal(adapterState.zoom, 1, "the adapter's initial zoom survives FrameXML load");
    assert.deepEqual(adapterState.setZoomCalls, [], "load does not synthesize a zoom write");
    assert.equal(zoomIn.enabled, true);
    assert.equal(zoomOut.enabled, true);

    const errorsAtLoad = candidate.boot.vm.errors.length;

    // The stock OnClick functions call Minimap:SetZoom exactly once. The second click at a bound
    // is rejected by the real Button state, so it cannot notify the adapter a second time.
    assert.equal(candidate.boot.bridge.Click(zoomIn), true);
    assert.equal(adapterState.zoom, 2);
    assert.deepEqual(adapterState.setZoomCalls, [2]);
    assert.equal(zoomIn.enabled, false, "stock zoom-in disables at the highest level");
    assert.equal(zoomOut.enabled, true);
    assert.equal(candidate.boot.bridge.Click(zoomIn), false,
      "a disabled stock zoom-in does not dispatch another click");
    assert.deepEqual(adapterState.setZoomCalls, [2]);

    assert.equal(candidate.boot.bridge.Click(zoomOut), true);
    assert.equal(adapterState.zoom, 1);
    assert.deepEqual(adapterState.setZoomCalls, [2, 1]);
    assert.equal(zoomIn.enabled, true);
    assert.equal(zoomOut.enabled, true);
    assert.equal(candidate.boot.bridge.Click(zoomOut), true);
    assert.equal(adapterState.zoom, 0);
    assert.deepEqual(adapterState.setZoomCalls, [2, 1, 0]);
    assert.equal(zoomIn.enabled, true);
    assert.equal(zoomOut.enabled, false, "stock zoom-out disables at the lowest level");
    assert.equal(candidate.boot.bridge.Click(zoomOut), false,
      "a disabled stock zoom-out does not dispatch another click");
    assert.deepEqual(adapterState.setZoomCalls, [2, 1, 0]);

    // Exercise Minimap's own bounded method through Lua too. These writes are one adapter call
    // each, and pin both clamp directions independently of the button's enabled guard.
    let executed = candidate.boot.vm.execute(
      "Minimap:SetZoom(999)", "@minimap-integration-clamp-high",
    );
    assert.equal(executed.ok, true, executed.error ?? "high Minimap:SetZoom failed");
    assert.equal(adapterState.zoom, 2);
    assert.deepEqual(adapterState.setZoomCalls, [2, 1, 0, 2]);
    executed = candidate.boot.vm.execute(
      "Minimap:SetZoom(-999)", "@minimap-integration-clamp-low",
    );
    assert.equal(executed.ok, true, executed.error ?? "low Minimap:SetZoom failed");
    assert.equal(adapterState.zoom, 0);
    assert.deepEqual(adapterState.setZoomCalls, [2, 1, 0, 2, 0]);

    // Production deliberately leaves GetCursorPosition unbound before FrameXML's missing-API
    // floor can synthesize a Lua stub: the native canvas Ctrl-click path is covered by
    // framexml-minimap-adoption.test.mjs.
    assert.equal(candidate.cursorBindingBeforeLoad, undefined,
      "production FrameXML does not bind GetCursorPosition");

    // Exercise only the bounded widget adapter contract through the stock Minimap method. This is
    // not a simulated browser click; the direct local point must still reach the adapter once.
    executed = candidate.boot.vm.execute(
      "Minimap:PingLocation(20, -20)", "@minimap-integration-ping",
    );
    assert.equal(executed.ok, true, executed.error ?? "Minimap:PingLocation failed");
    assert.deepEqual(adapterState.pingCalls, [[20, -20]],
      "one finite local ping reaches the adapter unchanged");

    // The canned seam is intentionally fixed, so each event repaints the same label. Battlefield
    // owns the stock PVP refresh for ZONE_CHANGED/NEW_AREA in this full vertical; derive dispatch
    // counts from the required owners instead of pinning a stale global number.
    assert.equal(candidate.boot.bridge.SetText(zoneLabel, "stale zone"), true);
    assert.equal(zoneLabel.text, "stale zone");
    const expectedZoneCensus = inventoryCensus(candidate.inventory);
    for (const [event, expectedOwners] of Object.entries(zoneEventOwners)) {
      // WatchFrame owns the registration, but its NEW_AREA branch requires the intentionally
      // omitted WorldMapFrame. FrameXmlBoot skips only that dependent handler and still delivers
      // the event to MinimapCluster/BattlefieldFrame.
      const dispatchedOwners = event === "ZONE_CHANGED_NEW_AREA"
        && !candidate.boot.bridge.getFrame("WorldMapFrame")
        ? expectedOwners.filter(([name]) => name !== "WatchFrame")
        : expectedOwners;
      const expectedHandlers = dispatchedOwners.length;
      const expectedMinimapRefreshes = dispatchedOwners.filter(([name, owner]) =>
        name === "MinimapCluster" && owner.registeredEvents.has(event),
      ).length;
      const beforeZone = liveCensus(candidate.boot);
      assert.equal(candidate.boot.pump.fire(event), expectedHandlers,
        `${event} dispatches once per required stock owner`);
      assert.equal(zoneLabel.text, CANNED_MINIMAP_ZONE.minimapZoneText);
      for (const name of MINIMAP_API) {
        const expectedDelta = ["GetMinimapZoneText", "GetZonePVPInfo"].includes(name)
          ? expectedMinimapRefreshes : 0;
        expectedZoneCensus[name] += expectedDelta;
        const afterZone = liveCensus(candidate.boot);
        assert.equal(afterZone[name] - beforeZone[name], expectedDelta,
          `${event} updates ${name} once per stock owner`);
      }
    }
    const beforeRepeatedZone = liveCensus(candidate.boot);
    assert.equal(candidate.boot.pump.fire("ZONE_CHANGED"), zoneEventOwners.ZONE_CHANGED.length,
      "repeated ZONE_CHANGED keeps exactly the required owners");
    assert.equal(zoneLabel.text, CANNED_MINIMAP_ZONE.minimapZoneText);
    const repeatedMinimapRefreshes = zoneEventOwners.ZONE_CHANGED.filter(([name, owner]) =>
      name === "MinimapCluster" && owner.registeredEvents.has("ZONE_CHANGED"),
    ).length;
    for (const name of MINIMAP_API) {
      const expectedDelta = ["GetMinimapZoneText", "GetZonePVPInfo"].includes(name)
        ? repeatedMinimapRefreshes : 0;
      expectedZoneCensus[name] += expectedDelta;
      const afterRepeatedZone = liveCensus(candidate.boot);
      assert.equal(afterRepeatedZone[name] - beforeRepeatedZone[name], expectedDelta,
        `repeated ZONE_CHANGED updates ${name} once per stock owner`);
    }
    assert.deepEqual(liveCensus(candidate.boot), expectedZoneCensus,
      "zone events produce only the C-API calls owned by their stock handlers");

    // Probe the four seam bindings through the same Lua VM, including the tooltip-only names.
    // This pins their return values and tuple shape without fabricating a tooltip owner.
    executed = candidate.boot.vm.execute(String.raw`
      __minimapZone = GetMinimapZoneText()
      __zoneText = GetZoneText()
      __subZoneText = GetSubZoneText()
      __pvpType, __isSubZonePvP, __factionName = GetZonePVPInfo()
    `, "@minimap-integration-c-api");
    assert.equal(executed.ok, true, executed.error ?? "Minimap C-API probe failed");
    assert.equal(candidate.boot.vm.getGlobal("__minimapZone"), CANNED_MINIMAP_ZONE.minimapZoneText);
    assert.equal(candidate.boot.vm.getGlobal("__zoneText"), CANNED_MINIMAP_ZONE.zoneText);
    assert.equal(candidate.boot.vm.getGlobal("__subZoneText"), CANNED_MINIMAP_ZONE.subZoneText);
    assert.deepEqual([
      candidate.boot.vm.getGlobal("__pvpType"),
      candidate.boot.vm.getGlobal("__isSubZonePvP"),
      candidate.boot.vm.getGlobal("__factionName"),
    ], [
      CANNED_MINIMAP_ZONE.pvpType,
      CANNED_MINIMAP_ZONE.isSubZonePvP,
      CANNED_MINIMAP_ZONE.factionName,
    ]);
    for (const name of MINIMAP_API) expectedZoneCensus[name] += 1;
    assert.deepEqual(liveCensus(candidate.boot), expectedZoneCensus,
      "manual seam probes add exactly one call per bound C-API");

    assert.equal(candidate.boot.vm.errors.length, errorsAtLoad,
      "minimap clicks, ping, zone events and C-API calls add no unhandled Lua errors");
  } finally {
    candidate?.boot.close();
    chain.close();
  }
});
