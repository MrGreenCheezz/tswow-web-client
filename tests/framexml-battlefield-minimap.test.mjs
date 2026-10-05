import assert from "node:assert/strict";
import test from "node:test";

// Plan item 3.14 (L17, 04.10): the battlefield half of the stock map's source and the C functions only
// Blizzard_BattlefieldMinimap calls, as Wow.exe 3.3.5a 12340 answers them (read-only Ghidra,
// .runtime/re-2026-10-04/l17/g1.c-g6.c): GetNumBattlefieldFlagPositions 0x0054a0e0, GetBattlefieldFlagPosition
// 0x0054dcc0 (slots from MSG_BATTLEGROUND_PLAYER_POSITIONS 0x0054b3f0, token 0x0054d010), GetNumBattlefieldVehicles
// 0x0054a140 and GetBattlefieldVehicleInfo 0x0054c4d0 (the list 0x00be9f70 of units whose Vehicle.dbc flags have
// 0x10000000), GetBattlefieldMapIconScale 0x0054c740 (Map.dbc MinimapIconScale of 0x00bea564), PlayerIsPVPInactive
// 0x00612e20 (aura 43681), and the owner that loads the add-on (FrameXmlBattlefieldMinimapLod.ts).
let dbcDirectory;
try {
  dbcDirectory = (await import("../tools/paths.mjs")).dbcDirectory();
} catch {
  dbcDirectory = undefined;
}
const withDataset = { skip: dbcDirectory ? false : "no 3.3.5a DBC dataset on this machine" };
const { loadAreaData } = await import("../dist/code/gateway/AreaMetadata.js");
const { FrameXmlMap, FRAMEXML_MAP_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlMap.js");
const { frameXmlBattlefieldMapSource, frameXmlGuidValue, FRAMEXML_BATTLEFIELD_VEHICLE_FLAG } = await import(
  "../dist/code/browser/framexml/FrameXmlBattlefieldMapSource.js",
);
const { frameXmlPlayerIsPvpInactive, FRAMEXML_PVP_INACTIVE_SPELL } = await import(
  "../dist/code/browser/framexml/FrameXmlBattlefieldMinimapApi.js",
);
const { createFrameXmlBattlefieldMinimapOwner } = await import("../dist/code/browser/framexml/FrameXmlBattlefieldMinimapLod.js");
const { worldMapPoint } = await import("../dist/code/browser/MinimapGeometry.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

const data = dbcDirectory ? await loadAreaData(dbcDirectory) : undefined;
const WSG = 489;
const EOTS = 566;
const SELF = 0x10n;

function unit(guid, { race = 1, typeId = 4, position, vehicleId, flags, health = 100 } = {}) {
  const fields = new Map();
  fields.set(UPDATE_FIELDS.UNIT_FIELD_BYTES_0.offset, race);
  fields.set(UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, health);
  if (flags !== undefined) fields.set(UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset, flags);
  return { guid, typeId, fields, position, vehicleId, transport: undefined };
}

function battleground(mapId = WSG) {
  const self = unit(SELF, { race: 1, position: { x: 1200, y: 1500, z: 0, orientation: 0 } });
  return {
    mapId,
    state: { selfGuid: SELF, objects: new Map([[SELF, self]]), revision: 1 },
    battlefieldQueues: new Map([[0, { status: 3, mapId, cleared: false }]]),
    flagCarriers: [],
    names: new Map(),
    creatureTemplates: new Map(),
    group: undefined,
    partyStats: new Map(),
  };
}

function source(world, extra = {}) {
  return frameXmlBattlefieldMapSource({
    world: () => world, metadata: () => extra.data ?? data, vehicles: () => extra.catalog, unitGuid: extra.unitGuid,
  });
}

const areaOf = (mapId) => data.mapAreas.find((area) => area.mapId === mapId && area.areaId !== 0);
const pinAt = (mapId, x, y) => { const point = worldMapPoint(areaOf(mapId), x, y); return [point.u, point.v]; };

test("flags fill the two slots from the packet's last carrier down; tokens are the flag the carrier's side carries", withDataset, () => {
  const world = battleground();
  const allianceCarrier = 0x21n;
  const hordeCarrier = 0x22n;
  // TrinityCore writes the Alliance carrier first (BattleGroundHandler.cpp:297-309); the Alliance carrier is in view.
  world.state.objects.set(allianceCarrier, unit(allianceCarrier, { race: 1, position: { x: 1300, y: 1600, z: 0, orientation: 0 } }));
  world.flagCarriers = [{ guid: allianceCarrier, x: 900, y: 1000 }, { guid: hordeCarrier, x: 1500, y: 1100 }];
  const pins = source(world).battlefieldFlagPositions();
  assert.equal(pins.length, 2);
  // Slot 0 is the packet's second: the Horde carrier, out of view, not in the player's raid — the other side
  // (Horde, 0) — carrying the Alliance flag, at its packet position.
  assert.deepEqual([pins[0].x, pins[0].y, pins[0].texture], [...pinAt(WSG, 1500, 1100), "AllianceFlag"]);
  // Slot 1: the Alliance carrier in view, at its live position, carrying the Horde flag.
  assert.deepEqual([pins[1].x, pins[1].y, pins[1].texture], [...pinAt(WSG, 1300, 1600), "HordeFlag"]);

  // One carrier is slot 0; a carrier in the player's raid is on the player's side.
  world.flagCarriers = [{ guid: hordeCarrier, x: 1500, y: 1100 }];
  world.group = { groupType: 0x02, members: [{ guid: hordeCarrier }] };
  const one = source(world).battlefieldFlagPositions();
  assert.equal(one.length, 1);
  assert.equal(one[0].texture, "HordeFlag", "own side (Alliance): the Horde flag");
  // Off the battlefield map the pin is (0, 0), which the stock Lua hides.
  world.flagCarriers = [{ guid: hordeCarrier, x: 99_999, y: 99_999 }];
  assert.deepEqual([source(world).battlefieldFlagPositions()[0].x, source(world).battlefieldFlagPositions()[0].y], [0, 0]);
  // Outside a battlefield there is no map to project onto.
  world.battlefieldQueues.clear();
  world.flagCarriers = [{ guid: hordeCarrier, x: 1500, y: 1100 }];
  assert.deepEqual([source(world).battlefieldFlagPositions()[0].x, source(world).battlefieldFlagPositions()[0].y], [0, 0]);
});

test("Eye of the Storm shows its one flag in the carrier's colour (map 566 inverts the token)", withDataset, () => {
  const world = battleground(EOTS);
  const orc = 0x31n;
  world.state.objects.set(orc, unit(orc, { race: 2, position: { x: 2200, y: 1300, z: 0, orientation: 0 } }));
  world.flagCarriers = [{ guid: orc, x: 2200, y: 1300 }];
  const [pin] = source(world).battlefieldFlagPositions();
  assert.equal(pin.texture, "HordeFlag");
  assert.deepEqual([pin.x, pin.y], pinAt(EOTS, 2200, 1300));
});

test("team positions are none — TrinityCore writes no player part — and the flag answers reuse one array", withDataset, () => {
  const world = battleground();
  const map = source(world);
  assert.deepEqual(map.battlefieldPositions(), []);
  world.flagCarriers = [{ guid: 0x22n, x: 1500, y: 1100 }];
  assert.equal(map.battlefieldFlagPositions(), map.battlefieldFlagPositions(), "pooled: no allocation per call");
  assert.equal(source(undefined).battlefieldPositions?.(), undefined);
});

test("vehicles: units whose Vehicle.dbc flags carry 0x10000000, at most 40, rebuilt only when the world changes", withDataset, () => {
  const world = battleground();
  const rows = new Map([
    [1, { flags: FRAMEXML_BATTLEFIELD_VEHICLE_FLAG, uiLocomotionType: 0 }],
    [2, { flags: 0, uiLocomotionType: 1 }],
    [3, { flags: FRAMEXML_BATTLEFIELD_VEHICLE_FLAG | 0x10, uiLocomotionType: 3 }],
  ]);
  const catalog = { vehicle: (id) => rows.get(id) };
  const demolisher = unit(0x41n, { typeId: 3, vehicleId: 1, flags: 0x0100_0000, position: { x: 1250, y: 1550, z: 0, orientation: 1.5 } });
  demolisher.fields.set(UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, 28781);
  const plain = unit(0x42n, { typeId: 3, vehicleId: 2, position: { x: 1250, y: 1550, z: 0, orientation: 0 } });
  const airship = unit(0xF150000000000043n, { typeId: 3, vehicleId: 3, health: 0, position: { x: 1260, y: 1560, z: 0, orientation: 0 } });
  for (const object of [demolisher, plain, airship]) world.state.objects.set(object.guid, object);
  world.creatureTemplates.set(28781, { found: true, name: "Разрушитель" });
  // The player rides the airship.
  world.state.objects.get(SELF).transport = { guid: 0xF150000000000043n };
  const map = source(world, { catalog });
  const list = map.battlefieldVehicles();
  assert.equal(list.length, 2);
  assert.equal(map.battlefieldVehicleCount(), 2);
  assert.deepEqual(list.map((pin) => [pin.name, pin.possessed, pin.type, pin.isPlayer, pin.alive, pin.location.orientation]), [
    ["Разрушитель", true, "Drive", false, true, 1.5],
    [undefined, false, "Airship Horde", true, false, 0],
  ]);
  assert.equal(map.battlefieldVehicles(), list, "same revision: the same list");
  demolisher.position = { x: 1300, y: 1500, z: 0, orientation: 2 };
  assert.equal(map.battlefieldVehicles()[0].location.x, 1250, "not rebuilt until the world's revision moves");
  world.state.revision += 1;
  assert.equal(map.battlefieldVehicles()[0].location.x, 1300);
  for (let index = 0; index < 45; index += 1) {
    const extra = unit(0x1000n + BigInt(index), { typeId: 3, vehicleId: 1, position: { x: 1250, y: 1550, z: 0, orientation: 0 } });
    world.state.objects.set(extra.guid, extra);
  }
  world.state.revision += 1;
  assert.equal(map.battlefieldVehicles().length, 40, "the client's list holds 40");
  assert.equal(source(world).battlefieldVehicles().length, 0, "no vehicle tables, no vehicles");
});

test("the map answers GetBattlefieldVehicleInfo on the shown map and the battlefield's icon scale", withDataset, () => {
  const world = battleground();
  const rows = new Map([[1, { flags: FRAMEXML_BATTLEFIELD_VEHICLE_FLAG, uiLocomotionType: 1 }]]);
  const catalog = { vehicle: (id) => rows.get(id) };
  const glaive = unit(0x51n, { typeId: 3, vehicleId: 1, position: { x: 1250, y: 1550, z: 0, orientation: 0.5 } });
  world.state.objects.set(glaive.guid, glaive);
  world.names.set(glaive.guid, "Метатель");
  const area = areaOf(WSG);
  const map = new FrameXmlMap({
    metadata: () => data,
    location: () => ({ mapId: WSG, areaId: area.areaId, x: 1200, y: 1500, orientation: 0 }),
    corpseLocation: () => null, deathReleaseLocation: () => null,
    ...source(world, { catalog }),
  });
  const host = { map };
  assert.equal(map.ready, true, "a battleground map is ready with the battlefield sources");
  assert.deepEqual(FRAMEXML_MAP_BINDINGS.GetNumBattlefieldVehicles(host, []), [1]);
  const info = FRAMEXML_MAP_BINDINGS.GetBattlefieldVehicleInfo(host, [1]);
  assert.deepEqual(info, [...pinAt(WSG, 1250, 1550), "Метатель", false, "Fly", 0.5, false, true]);
  assert.deepEqual(FRAMEXML_MAP_BINDINGS.GetBattlefieldVehicleInfo(host, [2]), []);
  glaive.position = { x: 99_999, y: 99_999, z: 0, orientation: 0 };
  world.state.revision += 1;
  assert.deepEqual(FRAMEXML_MAP_BINDINGS.GetBattlefieldVehicleInfo(host, [1]), [], "off the shown map: nothing");
  // Map.dbc MinimapIconScale: 1 until the gateway's map rows carry the column; a row that has it answers it.
  assert.deepEqual(FRAMEXML_MAP_BINDINGS.GetBattlefieldMapIconScale(host, []), [1]);
  const arathi = { ...data, maps: data.maps.map((row) => (row.id === WSG ? { ...row, minimapIconScale: 1.25 } : row)) };
  const scaled = new FrameXmlMap({ metadata: () => arathi, location: () => undefined, ...source(world, { data: arathi }) });
  assert.deepEqual(FRAMEXML_MAP_BINDINGS.GetBattlefieldMapIconScale({ map: scaled }, []), [1.25]);
  world.battlefieldQueues.clear();
  assert.deepEqual(FRAMEXML_MAP_BINDINGS.GetBattlefieldMapIconScale({ map: scaled }, []), [1], "no battlefield: 1");
});

test("party and raid pins: a member in view at its position, out of view at its stats' signed words", withDataset, () => {
  const world = battleground();
  const friend = 0x61n;
  const far = 0x62n;
  world.state.objects.set(friend, unit(friend, { position: { x: 1201, y: 1502, z: 0, orientation: 0 } }));
  world.partyStats.set(far, { status: 1, zoneId: 3277, positionX: 1210, positionY: (-20 & 0xffff) });
  const units = { party1: friend, party2: far };
  const map = source(world, { unitGuid: (token) => units[token] });
  assert.deepEqual(map.positionOfUnit("party1"), { mapId: WSG, areaId: 0, x: 1201, y: 1502 });
  assert.deepEqual(map.positionOfUnit("party2"), { mapId: WSG, areaId: 3277, x: 1210, y: -20 });
  world.partyStats.get(far).status = 0x21;
  assert.equal(map.positionOfUnit("party2"), undefined, "status 0x20: not placed");
  assert.equal(map.positionOfUnit("party3"), undefined);
  assert.equal(frameXmlGuidValue("0x00000000000000AB"), 0xabn);
  assert.equal(frameXmlGuidValue("party1"), undefined);
});

// L17-review 05.10: the stock OnUpdates ask GetPlayerMapPosition for all 40 raid slots every frame; an
// out-of-view member's zone must not cost a scan of AreaTable (2307 rows on this dataset) per call.
test("out-of-view pins look the member's zone up by id, not by a scan of the area rows per call", withDataset, () => {
  const world = battleground();
  const far = 0x62n;
  world.partyStats.set(far, { status: 1, zoneId: 3277, positionX: 1210, positionY: 1500 });
  let reads = 0;
  const areas = new Proxy(data.areas, {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) reads += 1;
      return Reflect.get(target, key, receiver);
    },
  });
  const counted = { ...data, areas };
  const map = source(world, { data: counted, unitGuid: (token) => (token === "raid2" ? far : undefined) });
  for (let frame = 0; frame < 50; frame += 1) {
    assert.equal(map.positionOfUnit("raid2")?.areaId, 3277);
  }
  assert.ok(reads <= data.areas.length, `area rows read ${reads} times for 50 calls (${data.areas.length} rows)`);
  // A new snapshot (the gateway's areas reloaded) is indexed again.
  let snapshot = data;
  const reloaded = frameXmlBattlefieldMapSource({
    world: () => world, metadata: () => snapshot, vehicles: () => undefined, unitGuid: () => far,
  });
  assert.equal(reloaded.positionOfUnit("raid2")?.areaId, 3277);
  snapshot = { ...data, areas: data.areas.filter((area) => area.id !== 3277) };
  assert.equal(reloaded.positionOfUnit("raid2"), undefined);
});

test("PlayerIsPVPInactive: aura 43681 on a unit in view, or in an out-of-view member's stats", () => {
  const inView = 0x71n;
  const away = 0x72n;
  const world = {
    state: { objects: new Map([[inView, {}]]) },
    auras: new Map([[inView, new Map([[3, { spellId: 1 }]])]]),
    partyStats: new Map([[away, { auras: [{ spellId: FRAMEXML_PVP_INACTIVE_SPELL }] }]]),
  };
  assert.equal(frameXmlPlayerIsPvpInactive(world, inView), false);
  world.auras.get(inView).set(9, { spellId: FRAMEXML_PVP_INACTIVE_SPELL });
  assert.equal(frameXmlPlayerIsPvpInactive(world, inView), true);
  assert.equal(frameXmlPlayerIsPvpInactive(world, away), true);
  // A unit in view is answered from its own auras only.
  world.state.objects.set(away, {});
  assert.equal(frameXmlPlayerIsPvpInactive(world, away), false);
  assert.equal(frameXmlPlayerIsPvpInactive(world, undefined), false);
});

test("the owner waits for the published HUD, loads once, and a failed load demotes it for good", async () => {
  const loads = [];
  const failures = [];
  let answer = { ok: false, status: "missing", message: "not installed", roots: [] };
  const boot = {
    loadAddon: async (name) => { loads.push(name); return answer; },
    vm: { compileFunction: () => undefined, release() {}, errors: [] }, bridge: { getFrame: () => undefined, diagnostics: [] },
    errorCount: 0,
  };
  const owner = createFrameXmlBattlefieldMinimapOwner({ boot: () => boot, onFailure: (reason) => failures.push(reason) });
  owner.request("show");
  assert.equal(owner.state, "waiting", "nothing loads before the stock HUD is published");
  assert.deepEqual(loads, []);
  const renderer = { addRoots() {}, sync() {} };
  owner.publish(renderer);
  assert.equal(owner.state, "loading");
  await owner.settled();
  assert.equal(owner.state, "failed");
  assert.deepEqual(loads, ["Blizzard_BattlefieldMinimap"]);
  assert.equal(failures.length, 1);
  owner.request("toggle");
  owner.request("show");
  await owner.settled();
  assert.deepEqual(loads, ["Blizzard_BattlefieldMinimap"], "a demoted add-on is never asked for again");

  // A loaded add-on whose frames are not there fails its gate.
  answer = { ok: true, status: "loaded", roots: [] };
  const second = createFrameXmlBattlefieldMinimapOwner({ boot: () => boot, onFailure: (reason) => failures.push(reason) });
  second.publish(renderer);
  assert.equal(second.state, "idle", "published without an ask: nothing loads");
  second.request("load");
  await second.settled();
  assert.equal(second.state, "failed");
  assert.match(failures[1], /gate/);
});
