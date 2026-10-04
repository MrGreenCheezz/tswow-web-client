import assert from "node:assert/strict";
import test from "node:test";

// GetZonePVPInfo from AreaTable.Flags (column 4) and FactionGroupMask (column 28) — `/dbc/areas`
// version 8. Every row below is the dataset's own (flags and masks read from
// F:/tswowRoot/tswow-install/.../dbc/AreaTable.dbc on 2026-09-30). The expected answers follow the
// client's own GetZonePVPInfo (Wow.exe 3.3.5a 12340, Lua function at 0x0051BA50), checked 2026-09-30.
const { frameXmlZonePvp, frameXmlZonePair } = await import("../dist/code/browser/framexml/FrameXmlZoneInfo.js");

const rows = new Map([
  [12, { id: 12, parentId: 0, flags: 0x40, factionGroupMask: 2 }], // Элвиннский лес
  [87, { id: 87, parentId: 12, flags: 0x40300040, factionGroupMask: 0 }], // Златоземье
  [14, { id: 14, parentId: 0, flags: 0x40, factionGroupMask: 4 }], // Дуротар
  [33, { id: 33, parentId: 0, flags: 0x40, factionGroupMask: 0 }], // Тернистая долина
  [2177, { id: 2177, parentId: 33, flags: 0x400000d0, factionGroupMask: 0 }], // Ринг (Gurubashi)
  [35, { id: 35, parentId: 33, flags: 0x40200040, factionGroupMask: 0 }], // Пиратская Бухта
  [4395, { id: 4395, parentId: 0, flags: 0x20004d28, factionGroupMask: 6 }], // Даларан
  [4564, { id: 4564, parentId: 4395, flags: 0x800, factionGroupMask: 0 }], // a Dalaran sub-area (all 20 carry 0x800)
  [3703, { id: 3703, parentId: 0, flags: 0x4d28, factionGroupMask: 6 }], // Шаттрат
  [4197, { id: 4197, parentId: 0, flags: 0x9004441, factionGroupMask: 0 }], // Озеро Ледяных Оков
  [4538, { id: 4538, parentId: 4197, flags: 0x1000000, factionGroupMask: 0 }], // a Wintergrasp sub-area
  [3698, { id: 3698, parentId: 0, flags: 0x10080, factionGroupMask: 0 }], // Арена Награнда
  [1581, { id: 1581, parentId: 0, flags: 0, factionGroupMask: 2 }], // Мертвые копи
  [3277, { id: 3277, parentId: 0, flags: 0x4000, factionGroupMask: 0 }], // Ущелье Песни Войны
  [1519, { id: 1519, parentId: 0, flags: 0x200138, factionGroupMask: 2 }], // Штормград (0x10)
  [1637, { id: 1637, parentId: 0, flags: 0x200138, factionGroupMask: 4 }], // Оргриммар (0x10)
  [4411, { id: 4411, parentId: 1519, flags: 0x40000138, factionGroupMask: 0 }], // Порт Штормграда
  [9001, { id: 9001, parentId: 12, flags: 0x40040, factionGroupMask: 0 }], // CONTESTED_AREA inside a territory
]);
const lookup = (areaId) => rows.get(areaId);
const pvp = (areaId, options) => {
  const pair = frameXmlZonePair(areaId, lookup);
  const info = frameXmlZonePvp(pair.zone, pair.subZone, options);
  return info === undefined ? undefined : [info.pvpType, info.isSubZonePvP, info.faction];
};
const pvpRealm = (team) => ({ realmPvp: true, team });

test("the pair is one level deep: a sub-area's zone is its parent, a zone has no sub-zone", () => {
  const sub = frameXmlZonePair(87, lookup);
  assert.deepEqual([sub.zone?.id, sub.subZone?.id], [12, 87]);
  const zone = frameXmlZonePair(12, lookup);
  assert.deepEqual([zone.zone?.id, zone.subZone?.id], [12, undefined]);
  const none = frameXmlZonePair(5, lookup);
  assert.deepEqual([none.zone?.id, none.subZone?.id], [undefined, undefined]);
});

test("sanctuary, arena and combat read the sub-zone's own flags, and name it as the sub-zone's", () => {
  // The zone itself: the zone's flags, isSubZonePvP nil.
  assert.deepEqual(pvp(4395, pvpRealm("Horde")), ["sanctuary", false, undefined]);
  assert.deepEqual(pvp(3703, pvpRealm("Alliance")), ["sanctuary", false, undefined]);
  assert.deepEqual(pvp(4197, pvpRealm("Alliance")), ["combat", false, undefined]);
  // A sub-area: only its flags count, and the second value is set whenever the answer came from it.
  assert.deepEqual(pvp(4564, pvpRealm("Horde")), ["sanctuary", true, undefined]);
  assert.deepEqual(pvp(4538, pvpRealm("Horde")), ["combat", true, undefined]);
  assert.deepEqual(pvp(2177, pvpRealm("Alliance")), ["arena", true, undefined]);
  // The status kinds need no PvP realm and no known side.
  assert.deepEqual(pvp(2177, {}), ["arena", true, undefined]);
  // An instanced arena is its own zone (ARENA 0x80 with ARENA_INSTANCE 0x10000).
  assert.deepEqual(pvp(3698, {}), ["arena", false, undefined]);
});

test("on a PvP realm the zone's FactionGroupMask decides friendly, hostile or contested", () => {
  assert.deepEqual(pvp(12, pvpRealm("Alliance")), ["friendly", false, "Alliance"]);
  // A sub-area reads the zone's mask; the answer never names the sub-zone.
  assert.deepEqual(pvp(87, pvpRealm("Alliance")), ["friendly", false, "Alliance"]);
  assert.deepEqual(pvp(87, pvpRealm("Horde")), ["hostile", false, "Alliance"]);
  assert.deepEqual(pvp(14, pvpRealm("Alliance")), ["hostile", false, "Horde"]);
  // Nobody's zone is contested, and its faction name is the empty string, not nil.
  assert.deepEqual(pvp(35, pvpRealm("Horde")), ["contested", false, ""]);
  assert.deepEqual(pvp(33, pvpRealm("Alliance")), ["contested", false, ""]);
  // Both sides' mask (6) is friendly to either, named by the first faction group in it: the Alliance.
  const both = { id: 7, parentId: 0, flags: 0, factionGroupMask: 6 };
  const bothInfo = frameXmlZonePvp(both, undefined, pvpRealm("Horde"));
  assert.deepEqual([bothInfo?.pvpType, bothInfo?.isSubZonePvP, bothInfo?.faction], ["friendly", false, "Alliance"]);
  // CONTESTED_AREA (0x40000) on the sub-zone overrides the zone's owner.
  assert.deepEqual(pvp(9001, pvpRealm("Alliance")), ["contested", false, "Alliance"]);
  // Instances are not special: their zone rows answer the same way (mask 0 contested, 2 an owner's).
  assert.deepEqual(pvp(3277, pvpRealm("Horde")), ["contested", false, ""]);
  assert.deepEqual(pvp(1581, pvpRealm("Horde")), ["hostile", false, "Alliance"]);
  // The player's side unknown: not guessed.
  assert.deepEqual(pvp(12, { realmPvp: true }), [undefined, false, undefined]);
});

test("off a PvP realm only zones flagged 0x10 (the capitals) answer a territory", () => {
  assert.deepEqual(pvp(12, { team: "Alliance" }), [undefined, false, undefined]);
  assert.deepEqual(pvp(33, { realmPvp: false, team: "Horde" }), [undefined, false, undefined]);
  assert.deepEqual(pvp(1519, { team: "Horde" }), ["hostile", false, "Alliance"]);
  assert.deepEqual(pvp(4411, { team: "Alliance" }), ["friendly", false, "Alliance"]);
  assert.deepEqual(pvp(1637, { realmPvp: false, team: "Horde" }), ["friendly", false, "Horde"]);
});

test("no zone row answers nothing; a gateway older than version 8 answers no status at all", () => {
  assert.deepEqual(pvp(5, pvpRealm("Horde")), [undefined, false, undefined]);
  const old = { id: 12, parentId: 0 };
  assert.equal(frameXmlZonePvp(old, undefined, pvpRealm("Alliance")), undefined);
  assert.equal(frameXmlZonePvp({ ...rows.get(12) }, { id: 87, parentId: 12 }, pvpRealm("Alliance")), undefined);
});

const { frameXmlResolveZone } = await import("../dist/code/browser/framexml/FrameXmlZoneInfo.js");

/** The three AreaClient reads the resolver makes, over named rows. */
function areaIndex(areaRows, maps) {
  const byId = new Map(areaRows.map((area) => [area.id, area]));
  return {
    area: (id) => byId.get(id),
    zoneOf: (id) => {
      let area = byId.get(id);
      while (area && area.parentId !== 0 && byId.has(area.parentId)) area = byId.get(area.parentId);
      return area;
    },
    map: (id) => maps.get(id),
  };
}
const named = [
  { ...rows.get(12), name: "Элвиннский лес" },
  { ...rows.get(87), name: "Златоземье" },
  { ...rows.get(33), name: "Тернистая долина" },
  { ...rows.get(2177), name: "Ринг" },
];
const maps = new Map([[0, { id: 0, directory: "Azeroth", name: "Восточные королевства", instanceType: 0 }]]);
const factionName = (team) => (team === "Alliance" ? "Альянс" : "Орда");

test("the resolved zone: the minimap names the most specific area, the banner the zone and sub-zone", () => {
  const areas = areaIndex(named, maps);
  assert.deepEqual(
    frameXmlResolveZone(areas, { mapId: 0, zoneId: 12, areaId: 87, team: "Alliance", realmPvp: true, factionName }),
    {
      minimapZoneText: "Златоземье", zoneText: "Элвиннский лес", subZoneText: "Златоземье",
      pvpType: "friendly", isSubZonePvP: false, factionName: "Альянс",
    });
  // In the zone itself there is no sub-zone: GetSubZoneText answers "" (the binding's default).
  const zone = frameXmlResolveZone(areas, { mapId: 0, zoneId: 12, areaId: 12, team: "Horde", realmPvp: true, factionName });
  assert.deepEqual([zone?.minimapZoneText, zone?.zoneText, zone?.subZoneText, zone?.pvpType, zone?.factionName],
    ["Элвиннский лес", "Элвиннский лес", undefined, "hostile", "Альянс"]);
  // The terrain's precise area wins over the server's coarser one.
  const ring = frameXmlResolveZone(areas, { mapId: 0, zoneId: 33, areaId: 33, terrainAreaId: 2177, team: "Horde", factionName });
  assert.deepEqual([ring?.minimapZoneText, ring?.subZoneText, ring?.pvpType, ring?.isSubZonePvP], ["Ринг", "Ринг", "arena", true]);
  // A contested zone's third value is "" (no faction group in its mask), not nil.
  const stv = frameXmlResolveZone(areas, { mapId: 0, zoneId: 33, areaId: 33, team: "Horde", realmPvp: true, factionName });
  assert.deepEqual([stv?.pvpType, stv?.isSubZonePvP, stv?.factionName], ["contested", false, ""]);
  // The owner's realm is PvE (Realm.Type 0): Elwynn answers no territory there.
  const pve = frameXmlResolveZone(areas, { mapId: 0, zoneId: 12, areaId: 87, team: "Alliance", factionName });
  assert.deepEqual([pve?.pvpType, pve?.isSubZonePvP, pve?.factionName], [undefined, false, undefined]);
});

test("the resolved zone degrades: no PvP fields from an old gateway, nothing for an unknown map", () => {
  const old = areaIndex(named.map(({ flags, factionGroupMask, ...rest }) => rest), maps);
  const zone = frameXmlResolveZone(old, { mapId: 0, zoneId: 12, areaId: 87, team: "Alliance", realmPvp: true, factionName });
  assert.deepEqual(zone, { minimapZoneText: "Златоземье", zoneText: "Элвиннский лес", subZoneText: "Златоземье" });
  assert.equal(frameXmlResolveZone(areaIndex([], new Map()), { mapId: 9, zoneId: undefined, areaId: undefined, factionName }), undefined);
  // A map with no area yet still has a name: the map's.
  assert.deepEqual(frameXmlResolveZone(areaIndex([], maps), { mapId: 0, zoneId: undefined, areaId: undefined, factionName }),
    { minimapZoneText: "Восточные королевства", zoneText: "Восточные королевства" });
});

const { frameXmlRealmPlayerKilling } = await import("../dist/code/browser/framexml/FrameXmlZoneInfo.js");

// Wow.exe 0x00405540 (read 2026-09-30): on entering the world the client walks Cfg_Configs.dbc,
// takes the first row whose RealmType (column 2) equals the realm-list entry's type byte, and keeps
// PlayerKillingAllowed (column 3) != 0; no row leaves the flag as it was (off). The dataset's
// Cfg_Configs.dbc (13 rows, read 2026-09-30) allows player killing for types 1, 3, 5, 8, 10 and 12.
test("the realm's type answers PvP through Cfg_Configs' PlayerKillingAllowed", () => {
  const allowed = [];
  for (let type = 0; type <= 16; type += 1) if (frameXmlRealmPlayerKilling(type)) allowed.push(type);
  assert.deepEqual(allowed, [1, 3, 5, 8, 10, 12]);
  // Normal 0/4, RP 6: no; PvP 1, RP-PvP 8: yes. No realm (a canned seam) and a type past the table: no.
  assert.equal(frameXmlRealmPlayerKilling(undefined), false);
  assert.equal(frameXmlRealmPlayerKilling(13), false);
  // Elwynn for a Horde player: hostile on a PvP realm, nothing on a normal one.
  const areas = areaIndex(named, maps);
  const on = (type) => frameXmlResolveZone(areas, {
    mapId: 0, zoneId: 12, areaId: 12, team: "Horde", realmPvp: frameXmlRealmPlayerKilling(type), factionName,
  })?.pvpType;
  assert.deepEqual([on(0), on(1), on(4), on(6), on(8)], [undefined, "hostile", undefined, undefined, "hostile"]);
});
