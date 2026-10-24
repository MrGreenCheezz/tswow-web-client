// Plan item 3.13 (12.10): the guard's gossip POI (SMSG_GOSSIP_POI) — its lifetime and «reached» rule
// (GossipPoi.ts, Wow.exe 0x007f4870/0x007f5ba0), where the minimap draws it (MinimapGossipPoi.ts, 0x007f44a0),
// the world map's landmark row (FrameXmlMap.ts, 0x00546310/0x00545a30) and the live seam's WORLD_MAP_UPDATE when
// it ends (0x00546310 → event 0x163).
import assert from "node:assert/strict";
import test from "node:test";

const { activeGossipPoi, GOSSIP_POI_LIFETIME_MS } = await import("../dist/code/browser/GossipPoi.js");
const { gossipPoiPlacement, minimapPoiIconCell } = await import("../dist/code/browser/ui/MinimapGossipPoi.js");
const { FrameXmlMap } = await import("../dist/code/browser/framexml/FrameXmlMap.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_SEAM_EVENTS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");

let dbcDirectory;
try {
  dbcDirectory = (await import("../tools/paths.mjs")).dbcDirectory();
} catch {
  dbcDirectory = undefined;
}
const withDataset = { skip: dbcDirectory ? false : "no 3.3.5a DBC dataset on this machine" };

const mark = (extra = {}) => ({ flags: 0x2, x: 100, y: 200, icon: 7, importance: 0, name: "Банк", mapId: 0, ...extra });

test("a gossip POI lives 480 s from its first sighting, ends within 10 yards, and a new one starts over", () => {
  assert.equal(GOSSIP_POI_LIFETIME_MS, 480_000, "Wow.exe 0x007f4870: time + 0x1e0");
  const poi = mark();
  const world = { gossipPoi: poi, mapId: 0 };
  assert.equal(activeGossipPoi(world, 1_000), poi, "the first sighting starts the clock");
  assert.equal(activeGossipPoi(world, 1_000 + 479_999), poi);
  assert.equal(activeGossipPoi(world, 1_000 + 480_000), undefined, "its time is up");
  assert.equal(activeGossipPoi(world, 2_000), undefined, "and it stays gone");

  const near = mark();
  const nearWorld = { gossipPoi: near, mapId: 0 };
  assert.equal(activeGossipPoi(nearWorld, 0, { x: 110.5, y: 200 }), near, "10.5 yards is not reached");
  assert.equal(activeGossipPoi({ gossipPoi: near, mapId: 1 }, 0, { x: 100, y: 200 }), near,
    "the player's position counts on the POI's own map only");
  assert.equal(activeGossipPoi(nearWorld, 0, { x: 106, y: 207.9 }), undefined, "within 10 yards it is reached");
  assert.equal(activeGossipPoi(nearWorld, 0, { x: 500, y: 500 }), undefined, "reached is final");

  const next = mark({ name: "Аукцион" });
  assert.equal(activeGossipPoi({ gossipPoi: next, mapId: 0 }, 999_999), next, "the next packet is a fresh POI");
  assert.equal(activeGossipPoi({ gossipPoi: mark({ x: 0, y: 0 }), mapId: 0 }, 0), undefined, "(0, 0) is none");
  assert.equal(activeGossipPoi(undefined, 0), undefined);
});

test("the minimap: an icon within 0.8 of the radius with flag 0x2, a guide arrow out to 694.44 yards", () => {
  const player = { x: 0, y: 0 };
  // A 100-yard radius drawn at 1 yard per pixel.
  const icon = gossipPoiPlacement(mark({ x: 80, y: 0 }), player, 100, 1);
  assert.equal(icon?.kind, "icon", "0.8 of the radius is still near (0x00a34c18)");
  assert.deepEqual(icon.point, { row: -80, column: -0 }, "north is up");
  assert.equal(gossipPoiPlacement(mark({ x: 80, y: 0, flags: 0 }), player, 100, 1), undefined,
    "near without the minimap flag: not drawn");
  const north = gossipPoiPlacement(mark({ x: 81, y: 0, flags: 0 }), player, 100, 1);
  assert.equal(north?.kind, "arrow", "past 0.8: an arrow, flag or not");
  assert.ok(Math.abs(north.angle) < 1e-9, "north points up");
  const east = gossipPoiPlacement(mark({ x: 0, y: -600 }), player, 100, 1);
  assert.equal(east?.kind, "arrow");
  assert.ok(Math.abs(east.angle - Math.PI / 2) < 1e-9, "east (falling Y) is a quarter turn clockwise");
  assert.equal(gossipPoiPlacement(mark({ x: 694, y: 0 }), player, 100, 1)?.kind, "arrow");
  assert.equal(gossipPoiPlacement(mark({ x: 695, y: 0 }), player, 100, 1), undefined,
    "beyond 694.44 yards (0x00a41e00) nothing");
  // POIIcons: 14 columns of 18-pixel cells, the 16 pixels inside (WorldMap_GetPOITextureCoords).
  assert.deepEqual(minimapPoiIconCell(0), { x: 1, y: 1, size: 16 });
  assert.deepEqual(minimapPoiIconCell(15), { x: 19, y: 19, size: 16 });
});

test("the world map lists the gossip POI after the AreaPOI rows on its map only", withDataset, async () => {
  const { loadAreaData } = await import("../dist/code/gateway/AreaMetadata.js");
  const data = await loadAreaData(dbcDirectory);
  const elwynn = data.mapAreas.find((area) => area.name === "Elwynn");
  assert.ok(elwynn);
  let gossip;
  const map = new FrameXmlMap({
    metadata: () => data,
    location: () => ({ mapId: 0, areaId: elwynn.areaId, x: -9_000, y: -400 }),
    gossipPoi: () => gossip,
  });
  const before = map.getNumMapLandmarks();
  gossip = { mapId: 0, x: -9_050, y: -350, icon: 7, name: "Банк" };
  assert.equal(map.getNumMapLandmarks(), before + 1);
  const row = map.getMapLandmarkInfo(before + 1);
  // 3.58 (24.10): seven values (0x00545a30), the last the packet flags' 0x200 (showInBattleMap).
  assert.equal(row.length, 7);
  assert.deepEqual([row[0], row[1], row[2], row[5], row[6]], ["Банк", undefined, 7, undefined, false],
    "name, no text, icon, no link, not on the battle map");
  assert.ok(row[3] > 0 && row[3] < 1 && row[4] > 0 && row[4] < 1, "on the Elwynn sheet");
  gossip = { mapId: 1, x: -9_050, y: -350, icon: 7, name: "Банк" };
  assert.equal(map.getNumMapLandmarks(), before, "a POI from another map is not on this one");
  gossip = { mapId: 0, x: 3_000, y: 3_000, icon: 7, name: "Банк" };
  assert.equal(map.getNumMapLandmarks(), before, "nor one off this sheet");
});

test("the live seam raises WORLD_MAP_UPDATE once when the POI ends", () => {
  const selfGuid = 0x31n;
  const self = { guid: selfGuid, typeId: 4, fields: new Map(), position: { x: 500, y: 500, z: 0 } };
  const world = {
    mapId: 0,
    gossipPoi: mark(),
    state: { selfGuid, objects: new Map([[selfGuid, self]]) },
    actionButtons: [], casts: new Map(), channels: new Map(), itemTemplates: new Map(),
    creatureTemplates: new Map(), gameObjectTemplates: new Map(), questTemplates: new Map(), questPoi: new Map(),
    cooldownRemaining: () => 0, currentServerTime: () => 100, queryQuest() {},
    events: { on: () => () => {} },
  };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: () => undefined,
    monotonic: () => 0, globalCooldownUntil: () => 0, castSpell: () => {},
  });
  const fired = [];
  seam.attach({ fire: (event) => { fired.push(event); return 1; }, now: () => 1 });
  const updates = () => fired.filter((event) => event === FRAMEXML_SEAM_EVENTS.worldMapUpdate).length;
  seam.tick(1);
  const base = updates();
  seam.tick(1.1);
  assert.equal(updates(), base, "a living POI raises nothing");
  self.position = { x: 103, y: 204, z: 0 };
  seam.tick(1.2);
  assert.equal(updates(), base + 1, "reached: the map's landmarks are rebuilt");
  seam.tick(1.3);
  assert.equal(updates(), base + 1, "once");
  seam.detach();
});
