import assert from "node:assert/strict";
import test from "node:test";

const { CannedWorldSeam, CANNED_MINIMAP_ZONE } =
  await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { LiveWorldSeam } =
  await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS, FRAMEXML_SEAM_EVENTS } =
  await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");

class FakeEvents {
  #listeners = new Map();

  on(name, listener) {
    let listeners = this.#listeners.get(name);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(name, listeners);
    }
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  emit(name, payload) {
    for (const listener of [...(this.#listeners.get(name) ?? [])]) listener(payload);
  }
}

function liveFixture() {
  const selfGuid = 0x10n;
  const events = new FakeEvents();
  const zone = {
    minimapZoneText: "Test zone",
    zoneText: "Test zone",
    subZoneText: "Test sub-zone",
    pvpType: "contested",
    isSubZonePvP: false,
    factionName: "Alliance",
  };
  let resolvedZone = zone;
  let resolvedWorldMapAreaId = 10;
  const world = {
    mapId: 0,
    worldStateContext: { mapId: 0, zoneId: 12, areaId: 34 },
    state: {
      selfGuid,
      objects: new Map([[selfGuid, {
        guid: selfGuid,
        typeId: 4,
        position: { x: 100, y: 200, z: 3, orientation: 1 },
        fields: new Map(),
      }]]),
    },
    actionButtons: [],
    casts: new Map(),
    events,
    cooldownRemaining: () => 0,
  };
  const fired = [];
  const pump = {
    fire(event, ...args) {
      fired.push([event, ...args]);
      return 1;
    },
    now: () => 10,
  };
  const context = {
    world: () => world,
    store: () => undefined,
    spell: () => undefined,
    monotonic: () => 1000,
    globalCooldownUntil: () => 0,
    castSpell: () => {},
    minimapZone: (mapId, zoneId, areaId) => {
      assert.deepEqual([mapId, zoneId, areaId], [
        world.mapId ?? world.worldStateContext?.mapId,
        world.worldStateContext?.zoneId,
        world.worldStateContext?.areaId,
      ]);
      return resolvedZone;
    },
    worldMapAreaId: () => resolvedWorldMapAreaId,
  };
  return {
    seam: new LiveWorldSeam(context),
    context,
    world,
    events,
    fired,
    pump,
    selfGuid,
    zone,
    setZone: (nextZone) => { resolvedZone = nextZone; },
    setWorldMapAreaId: (nextAreaId) => { resolvedWorldMapAreaId = nextAreaId; },
  };
}

test("the measured minimap C APIs keep exact text and PVP tuple shapes", () => {
  const canned = new CannedWorldSeam();
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetMinimapZoneText(canned, []), [CANNED_MINIMAP_ZONE.minimapZoneText]);
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetZoneText(canned, []), [CANNED_MINIMAP_ZONE.zoneText]);
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetSubZoneText(canned, []), [CANNED_MINIMAP_ZONE.subZoneText]);
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetZonePVPInfo(canned, []), [
    CANNED_MINIMAP_ZONE.pvpType,
    CANNED_MINIMAP_ZONE.isSubZonePvP,
    CANNED_MINIMAP_ZONE.factionName,
  ]);
  const cannedEvents = [];
  canned.attach({ now: () => 100, fire: (event, ...args) => {
    cannedEvents.push([event, ...args]);
    return 1;
  } });
  cannedEvents.length = 0;
  canned.tick(100);
  assert.equal(cannedEvents.some(([event]) => event.startsWith("ZONE_CHANGED")), false,
    "the fixed fixture adds no zone noise to the deterministic timeline");
  assert.equal(canned.minimapZoneText(), CANNED_MINIMAP_ZONE.minimapZoneText);
  canned.detach();
  // WorldMapFrame now owns this stock C API; without selected map metadata the player has no
  // known position on that map, which the client's off-map tuple represents as zeroes.
  assert.equal(typeof FRAMEXML_SEAM_BINDINGS.GetPlayerMapPosition, "function");
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetPlayerMapPosition(canned, ["player"]), [0, 0]);
  // These two are still outside the adopted minimap contract.
  assert.equal(FRAMEXML_SEAM_BINDINGS.GetMinimapZoom, undefined);
  assert.equal(FRAMEXML_SEAM_BINDINGS.GetMinimapRotation, undefined);
});

test("live minimap labels use authoritative area context and nil when unresolved", () => {
  const { seam, context, fired, pump } = liveFixture();
  seam.attach(pump);
  assert.deepEqual(fired.filter(([event]) => event.startsWith("ZONE_CHANGED")), [
    [FRAMEXML_SEAM_EVENTS.zoneChangedNewArea],
  ], "late mount receives one initial world-area edge");
  fired.length = 0;

  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetMinimapZoneText(seam, []), ["Test zone"]);
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetZoneText(seam, []), ["Test zone"]);
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetSubZoneText(seam, []), ["Test sub-zone"]);
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetZonePVPInfo(seam, []), ["contested", false, "Alliance"]);
  assert.deepEqual(fired, [], "getters do not create world events");

  const unresolved = new LiveWorldSeam({
    ...context,
    minimapZone: undefined,
  });
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetMinimapZoneText(unresolved, []), []);
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetZonePVPInfo(unresolved, []), []);
  seam.detach();
});

test("live minimap keeps raw world pings out of FrameXML and deduplicates zone edges", () => {
  const { seam, world, events, fired, pump } = liveFixture();
  seam.attach(pump);
  fired.length = 0;
  // Prime the throttled action poll once; the minimap-specific edge below is then isolated from
  // the existing action-bar seed events.
  seam.tick(10);
  fired.length = 0;

  // WorldClient's event coordinates are absolute world points. Minimap.lua expects normalized
  // local offsets, so forwarding these without a zoom/rotation projection would place the ping
  // off-map; the adopted native canvas already consumes the world event correctly.
  events.emit("MINIMAP_PING", { guid: 0x10n, x: 100, y: 200 });
  assert.deepEqual(fired, [], "raw world ping coordinates are not promoted to FrameXML");

  world.worldStateContext = { mapId: 0, zoneId: 13, areaId: 35 };
  events.emit("WORLD_STATE_CHANGED", { variableId: undefined });
  assert.deepEqual(fired, [[FRAMEXML_SEAM_EVENTS.zoneChanged]]);
  fired.length = 0;
  events.emit("WORLD_STATE_CHANGED", { variableId: undefined });
  assert.deepEqual(fired, [], "unchanged world-state updates stay quiet");

  world.mapId = 1;
  world.worldStateContext = { mapId: 1, zoneId: 13, areaId: 35 };
  seam.tick(10.1);
  assert.deepEqual(fired, [[FRAMEXML_SEAM_EVENTS.zoneChangedNewArea]]);
  seam.detach();
});

test("live minimap publishes one zone edge when the resolved area shape becomes fresh", () => {
  const { seam, zone, setZone, fired, pump } = liveFixture();
  setZone(undefined);
  seam.attach(pump);
  fired.length = 0;
  // Prime the existing throttled action poll so this freshness assertion only observes the
  // minimap zone edge.
  seam.tick(10);
  fired.length = 0;

  // The raw map/zone/area IDs are unchanged, but late area metadata resolves now. A tick must
  // observe that shape transition so Minimap.lua can refresh its labels and PvP tuple.
  setZone(zone);
  seam.tick(10.1);
  assert.deepEqual(fired, [[FRAMEXML_SEAM_EVENTS.zoneChanged]]);
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetMinimapZoneText(seam, []), ["Test zone"]);
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetZonePVPInfo(seam, []), ["contested", false, "Alliance"]);

  fired.length = 0;
  setZone({ ...zone });
  seam.tick(10.1);
  assert.deepEqual(fired, [], "an equivalent resolved shape stays quiet");

  setZone({ ...zone, subZoneText: "Fresh sub-zone", pvpType: "sanctuary", isSubZonePvP: true });
  seam.tick(10.2);
  assert.deepEqual(fired, [[FRAMEXML_SEAM_EVENTS.zoneChanged]],
    "sub-zone/PvP shape changes publish exactly one normal zone edge");
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetSubZoneText(seam, []), ["Fresh sub-zone"]);
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetZonePVPInfo(seam, []), ["sanctuary", true, "Alliance"]);
  seam.detach();
});

test("live WatchFrame POI filter refreshes once when WorldMapArea metadata arrives late", () => {
  const { seam, fired, pump, setWorldMapAreaId } = liveFixture();
  setWorldMapAreaId(undefined);
  seam.attach(pump);
  fired.length = 0;

  // The raw map/zone IDs remain unchanged while AreaClient is still loading. The first poll only
  // records the unresolved primitive; it must not fabricate a POI update or a second area edge.
  seam.tick(10);
  fired.length = 0;

  setWorldMapAreaId(10);
  seam.tick(10.1);
  assert.deepEqual(fired, [[FRAMEXML_SEAM_EVENTS.worldMapUpdate]],
    "late WorldMapArea readiness refreshes the stock current-map quest filter once");

  fired.length = 0;
  seam.tick(10.11);
  seam.tick(10.2);
  assert.deepEqual(fired, [], "stable area metadata does not duplicate WORLD_MAP_UPDATE");

  setWorldMapAreaId(11);
  seam.tick(10.3);
  assert.deepEqual(fired, [[FRAMEXML_SEAM_EVENTS.worldMapUpdate]],
    "a WorldMapArea transition refreshes the filter exactly once");
  seam.detach();
});
