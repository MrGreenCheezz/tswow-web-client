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
  let loading = false;
  let indoors = false;
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
    worldLoading: () => loading,
    playerIndoors: () => indoors,
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
    setLoading: (value) => { loading = value; },
    setIndoors: (value) => { indoors = value; },
  };
}

test("the measured minimap C APIs keep exact text and PVP tuple shapes", () => {
  const canned = new CannedWorldSeam();
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetMinimapZoneText(canned, []), [CANNED_MINIMAP_ZONE.minimapZoneText]);
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetZoneText(canned, []), [CANNED_MINIMAP_ZONE.zoneText]);
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetSubZoneText(canned, []), [CANNED_MINIMAP_ZONE.subZoneText]);
  // The client pushes 1 or nil for isSubZonePvP (GetZonePVPInfo, Wow.exe 0x0051BA50), never false.
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetZonePVPInfo(canned, []), [
    CANNED_MINIMAP_ZONE.pvpType,
    CANNED_MINIMAP_ZONE.isSubZonePvP ? 1 : undefined,
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

test("live minimap labels use authoritative area context; unresolved texts are \"\" and the PvP tuple nil", () => {
  const { seam, context, fired, pump } = liveFixture();
  seam.attach(pump);
  assert.deepEqual(fired.filter(([event]) => event.startsWith("ZONE_CHANGED")), [
    [FRAMEXML_SEAM_EVENTS.zoneChangedNewArea],
  ], "late mount receives one initial world-area edge");
  fired.length = 0;

  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetMinimapZoneText(seam, []), ["Test zone"]);
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetZoneText(seam, []), ["Test zone"]);
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetSubZoneText(seam, []), ["Test sub-zone"]);
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetZonePVPInfo(seam, []), ["contested", undefined, "Alliance"]);
  assert.deepEqual(fired, [], "getters do not create world events");

  const unresolved = new LiveWorldSeam({
    ...context,
    minimapZone: undefined,
  });
  // The client's three text APIs always answer a string: ZoneText_OnEvent compares
  // `GetSubZoneText() == ""` and Minimap_SetTooltip `subzoneName == zoneName`.
  for (const name of ["GetMinimapZoneText", "GetZoneText", "GetSubZoneText", "GetRealZoneText"]) {
    assert.deepEqual(FRAMEXML_SEAM_BINDINGS[name](unresolved, []), [""], name);
  }
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetZonePVPInfo(unresolved, []), []);
  // A zone with no sub-zone answers "" for it too, not nil.
  const zoneOnly = new LiveWorldSeam({
    ...context,
    minimapZone: () => ({ minimapZoneText: "Test zone", zoneText: "Test zone" }),
  });
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetSubZoneText(zoneOnly, []), [""]);
  seam.detach();
});

test("live minimap keeps raw world pings out of FrameXML and deduplicates zone edges", () => {
  const { seam, world, events, fired, pump, zone, setZone, setIndoors } = liveFixture();
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

  // Another area of the same zone with the same names: the client compares texts, not area ids
  // (the zone setter at Wow.exe 0x005204C0), so nothing fires.
  world.worldStateContext = { mapId: 0, zoneId: 12, areaId: 35 };
  events.emit("WORLD_STATE_CHANGED", { variableId: undefined });
  assert.deepEqual(fired, [], "an area id change with unchanged texts stays quiet");

  // Another sub-zone of the same zone: ZONE_CHANGED, alone.
  setZone({ ...zone, subZoneText: "Other sub-zone", minimapZoneText: "Other sub-zone" });
  world.worldStateContext = { mapId: 0, zoneId: 12, areaId: 37 };
  events.emit("WORLD_STATE_CHANGED", { variableId: undefined });
  assert.deepEqual(fired, [[FRAMEXML_SEAM_EVENTS.zoneChanged]]);
  fired.length = 0;
  events.emit("WORLD_STATE_CHANGED", { variableId: undefined });
  assert.deepEqual(fired, [], "unchanged world-state updates stay quiet");

  // The same kind of change while the player stands inside an indoor WMO group: the INDOORS name.
  setIndoors(true);
  setZone({ ...zone, subZoneText: "An inn", minimapZoneText: "An inn" });
  world.worldStateContext = { mapId: 0, zoneId: 12, areaId: 38 };
  events.emit("WORLD_STATE_CHANGED", { variableId: undefined });
  assert.deepEqual(fired, [[FRAMEXML_SEAM_EVENTS.zoneChangedIndoors]]);
  fired.length = 0;
  setIndoors(false);

  // Another zone on the same map: ZONE_CHANGED_NEW_AREA, once, and not a ZONE_CHANGED before it.
  world.worldStateContext = { mapId: 0, zoneId: 13, areaId: 36 };
  events.emit("WORLD_STATE_CHANGED", { variableId: undefined });
  assert.deepEqual(fired, [[FRAMEXML_SEAM_EVENTS.zoneChangedNewArea]]);
  fired.length = 0;

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
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetZonePVPInfo(seam, []), ["contested", undefined, "Alliance"]);

  fired.length = 0;
  setZone({ ...zone });
  seam.tick(10.1);
  assert.deepEqual(fired, [], "an equivalent resolved shape stays quiet");

  // The PvP answer alone is read on demand; the client raises no event for it.
  setZone({ ...zone, pvpType: "sanctuary", isSubZonePvP: true });
  seam.tick(10.15);
  assert.deepEqual(fired, [], "a PvP-only change stays quiet");
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetZonePVPInfo(seam, []), ["sanctuary", 1, "Alliance"]);

  setZone({ ...zone, subZoneText: "Fresh sub-zone", pvpType: "sanctuary", isSubZonePvP: true });
  seam.tick(10.2);
  assert.deepEqual(fired, [[FRAMEXML_SEAM_EVENTS.zoneChanged]],
    "a sub-zone text change publishes exactly one normal zone edge");
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetSubZoneText(seam, []), ["Fresh sub-zone"]);

  fired.length = 0;
  // A zone name that changes under the same zone id is ZONE_CHANGED too: only another zone id is
  // ZONE_CHANGED_NEW_AREA in the client.
  setZone({ ...zone, zoneText: "Other zone", minimapZoneText: "Other zone" });
  seam.tick(10.3);
  assert.deepEqual(fired, [[FRAMEXML_SEAM_EVENTS.zoneChanged]]);
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

test("the loading curtain holds zone edges back and ends with one ZONE_CHANGED_NEW_AREA for the new place", () => {
  const { seam, world, events, fired, pump, setLoading } = liveFixture();
  // Mounted under the curtain at login: the first edge waits for it, as the client's comes after
  // PLAYER_ENTERING_WORLD.
  setLoading(true);
  seam.attach(pump);
  seam.tick(10);
  assert.deepEqual(fired.filter(([event]) => event.startsWith("ZONE_CHANGED")), [], "nothing under the curtain");
  setLoading(false);
  seam.tick(10.1);
  assert.deepEqual(fired.filter(([event]) => event.startsWith("ZONE_CHANGED")),
    [[FRAMEXML_SEAM_EVENTS.zoneChangedNewArea]], "one edge once the curtain is down");
  fired.length = 0;

  // A worldport: NEW_WORLD moves mapId first while the world states still name the old zone, then
  // INIT_WORLD_STATES names the new one — two different answers in the gap, neither of them shown.
  setLoading(true);
  world.mapId = 1;
  seam.tick(10.2);
  world.worldStateContext = { mapId: 1, zoneId: 14, areaId: 14 };
  events.emit("WORLD_STATE_CHANGED", { variableId: undefined });
  seam.tick(10.3);
  assert.deepEqual(fired, [], "no zone edge while the destination loads");
  setLoading(false);
  seam.tick(10.4);
  assert.deepEqual(fired, [[FRAMEXML_SEAM_EVENTS.zoneChangedNewArea]], "the settled destination, once");
  fired.length = 0;
  seam.tick(10.5);
  assert.deepEqual(fired, []);

  // The browser also raises the curtain for a same-map teleport, which the client does without a
  // loading screen: in the same zone and area that is no zone edge at all.
  setLoading(true);
  seam.tick(10.6);
  setLoading(false);
  seam.tick(10.7);
  assert.deepEqual(fired, [], "same place after the curtain stays quiet");
  seam.detach();
});

test("a near teleport within the zone raises no zone edge: the position moves, the world states do not", () => {
  // 1.17: a blink or a short `.tele` has no curtain and no packet naming a place; the core's
  // UpdateZone sends INIT_WORLD_STATES only for another zone (Player::UpdateZone). Stock frames get
  // nothing — the zone text is re-read on demand by whoever asks.
  const { seam, world, fired, pump, selfGuid } = liveFixture();
  seam.attach(pump);
  seam.tick(10);
  fired.length = 0;
  world.state.objects.get(selfGuid).position = { x: 120, y: 200, z: 3, orientation: 1 };
  seam.tick(10.1);
  seam.tick(10.2);
  assert.deepEqual(fired.filter(([event]) => event.startsWith("ZONE_CHANGED")), [], "no ZONE_CHANGED_NEW_AREA for the same zone");
  seam.detach();
});
