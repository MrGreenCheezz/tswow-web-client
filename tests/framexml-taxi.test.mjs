import assert from "node:assert/strict";
import test from "node:test";
import { loadAreaData } from "../dist/code/gateway/AreaMetadata.js";
import { loadTaxiMetadata } from "../dist/code/gateway/TaxiMetadata.js";
import { dbcDirectory } from "../tools/paths.mjs";

// Merged 2026-10-20 from 2 files; each block below is one former file,
// kept in its own scope so its helpers and module loads stay as they were.

// ── framexml-taxi-areas.test.mjs
{
// The flight map's geometry end to end, over this dataset's own DBCs: the gateway's `/dbc/areas`
// continents carry WorldMapContinent's TaxiMin/TaxiMax, its WorldMapTransforms move Quel'Thalas and
// the Draenei isles onto EK and Kalimdor, and LiveWorldSeam hands both to the stock TaxiFrame model,
// so a node sits where the client's square TAXIMAP picture has it. In-process: the running gateway
// keeps its old dist until the owner restarts it.

const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { FRAMEXML_CANNED_TAXI_CATALOG, FRAMEXML_CANNED_TAXI_MENU } =
  await import("../dist/code/browser/framexml/FrameXmlTaxiCanned.js");

let areas;
let taxi;
try {
  [areas, taxi] = await Promise.all([loadAreaData(dbcDirectory()), loadTaxiMetadata(dbcDirectory())]);
} catch {
  areas = undefined;
}
const withDataset = { skip: areas ? false : "no dataset DBCs on this machine" };

/** A LiveWorldSeam over a fake world whose flight master opens `menu`; `call` is the seam's C API. */
function openFlightMap(menu, catalog) {
  const listeners = new Map();
  const world = {
    state: { selfGuid: 1n, objects: new Map([[1n, { guid: 1n, typeId: 4, fields: new Map() }]]) },
    names: { get: () => undefined, declined: () => undefined },
    creatureTemplates: new Map(), itemTemplates: new Map(), gameObjectTemplates: new Map(),
    casts: new Map(),
    taxiMenu: undefined,
    events: { on(name, listener) {
      listeners.set(name, [...(listeners.get(name) ?? []), listener]);
      return () => {};
    } },
    takeTaxi: () => {}, closeTaxiMenu: () => {},
  };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: () => undefined, monotonic: () => 0,
    globalCooldownUntil: () => 0, castSpell: () => {},
    mapSource: { metadata: () => areas, location: () => undefined },
  });
  const fired = [];
  seam.attach({ fire(event, ...args) { fired.push([event, ...args]); return 1; }, now: () => 0 });
  seam.taxi.catalogSource = { catalog, load: async () => catalog };
  seam.taxi.owned = true;
  world.taxiMenu = menu;
  for (const listener of listeners.get("TAXI_MENU") ?? []) listener(menu);
  const call = (name, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);
  const nodes = () => Array.from({ length: call("NumTaxiNodes")[0] }, (_, index) => ({
    name: call("TaxiNodeName", index + 1)[0], type: call("TaxiNodeGetType", index + 1)[0],
    position: call("TaxiNodePosition", index + 1),
  }));
  return { seam, fired, call, nodes };
}

test("/dbc/areas carries each continent's flight-map square: WorldMapContinent TaxiMin/TaxiMax as world [x, y]", withDataset, () => {
  const byMap = Object.fromEntries(areas.continents.map((row) => [row.mapId, [row.taxiMin, row.taxiMax]]));
  assert.deepEqual(byMap, {
    0: [[-16530, -16530], [12270, 12270]],
    1: [[-11870, -13370], [12470, 10970]],
    530: [[-5867, -1600], [6400, 10670]],
    571: [[-3733, -6933], [11730, 8533]],
  });
  for (const [min, max] of Object.values(byMap)) {
    assert.ok(Math.abs((max[0] - min[0]) - (max[1] - min[1])) <= 3, "a square, like the 512x512 TAXIMAP pictures");
  }
});

test("LiveWorldSeam places the flight master's nodes through that square, not the 1.5:1 WorldMapArea", withDataset, () => {
  const { seam, fired, call } = openFlightMap(FRAMEXML_CANNED_TAXI_MENU, FRAMEXML_CANNED_TAXI_CATALOG);
  try {
    assert.ok(fired.some(([event]) => event === "TAXIMAP_OPENED"));
    const [u, v] = call("TaxiNodePosition", 1);
    // Stormwind (x -8840.56, y 489.70) on EK's -16530..12270 square.
    assert.ok(Math.abs(u - (12270 - 489.7) / 28800) < 1e-6, String(u));
    assert.ok(Math.abs(v - (-8840.56 + 16530) / 28800) < 1e-6, String(v));
  } finally {
    seam.detach();
  }
});

test("a Silvermoon or Exodar flight master opens the EK or Kalimdor picture, its nodes on that picture", withDataset, () => {
  // Silvermoon (82), Tranquillien (83) and Zul'Aman (205) are map 530 in TaxiNodes; WorldMapTransforms
  // row 2 draws them on map 0, as the client's flight map does.
  const silvermoon = openFlightMap({ guid: 0xF1300000010000AAn, currentNode: 82, knownNodes: [82, 83, 205] }, taxi);
  try {
    assert.deepEqual(silvermoon.call("GetTaxiMapID"), [0], "not Outland's 530");
    assert.deepEqual(silvermoon.call("WebClientTaxiMapTexture"), ["Interface\\TaxiFrame\\TAXIMAP0"]);
    const nodes = silvermoon.nodes();
    const current = nodes.find((node) => node.type === "CURRENT");
    assert.equal(current.name, "Луносвет");
    // (9375.3, -7166.5) + (-2400, 2400) on EK's square: the top right of TAXIMAP0, Eversong.
    const [u, v] = current.position;
    assert.ok(u > 0.55 && u < 0.62 && v > 0.78 && v < 0.84, `${u}, ${v}`);
    assert.ok(nodes.some((node) => node.name === "Транквиллион, Призрачные земли" && node.type === "REACHABLE"));
    assert.ok(nodes.some((node) => /Штормград/.test(node.name)), "the rest of the Eastern Kingdoms shares the picture");
    assert.ok(!nodes.some((node) => /Шаттрат/.test(node.name)), "Outland is not on it");
    for (const node of nodes.filter((entry) => entry.type !== "NONE")) {
      assert.ok(node.position.every((value) => value > 0 && value < 1), `${node.name} on the picture: ${node.position}`);
    }
  } finally {
    silvermoon.seam.detach();
  }
  const exodar = openFlightMap({ guid: 0xF1300000020000BBn, currentNode: 94, knownNodes: [94, 93] }, taxi);
  try {
    assert.deepEqual(exodar.call("GetTaxiMapID"), [1], "row 3 draws the Draenei isles on Kalimdor");
    const [u, v] = exodar.nodes().find((node) => node.type === "CURRENT").position;
    // (-4054.7, -11792.8) + (10133.33, 17600) on Kalimdor's square: the Azuremyst isles, top left.
    assert.ok(u > 0.18 && u < 0.25 && v > 0.70 && v < 0.77, `${u}, ${v}`);
  } finally {
    exodar.seam.detach();
  }
});
}

// ── framexml-taxi-seam.test.mjs
{
// The stock TaxiFrame's C API over the canned Stormwind flight master: the node list and its
// types, positions through the continent's flight-map square (WorldMapContinent TaxiMin/TaxiMax, up
// from the bottom), the planned hops, and TAXIMAP_OPENED/CLOSED. MPQ-free; TaxiFrame.lua runs in
// framexml-taxi-vertical.test.mjs.
const { FRAMEXML_TAXI_BINDINGS, FrameXmlTaxiModel, frameXmlTaxiMapBounds, frameXmlTaxiNodes } =
  await import("../dist/code/browser/framexml/FrameXmlTaxi.js");
const {
  FRAMEXML_CANNED_TAXI_CATALOG, FRAMEXML_CANNED_TAXI_CONTINENT, FRAMEXML_CANNED_TAXI_MENU, FRAMEXML_CANNED_TAXI_MASTER,
  FRAMEXML_CANNED_TAXI_WORLD_MAP_AREA, createCannedFrameXmlTaxi,
} = await import("../dist/code/browser/framexml/FrameXmlTaxiCanned.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");

function fixture(context = {}) {
  const { model, world } = createCannedFrameXmlTaxi(context);
  const fired = [];
  model.attach({ fire(event, ...args) { fired.push([event, ...args]); return 1; } });
  model.owned = true;
  const call = (name, ...args) => FRAMEXML_TAXI_BINDINGS[name]({ taxi: model }, args);
  return { model, world, fired, call };
}

test("the list: the map's flyable nodes by id; CURRENT, REACHABLE and hidden NONE; cheapest routes", () => {
  const nodes = frameXmlTaxiNodes(FRAMEXML_CANNED_TAXI_MENU, FRAMEXML_CANNED_TAXI_CATALOG, FRAMEXML_CANNED_TAXI_CONTINENT, "Alliance");
  assert.deepEqual(nodes.map(({ node, type, route }) => [node.id, type, route?.nodes.join(">") ?? "", route?.cost ?? 0]), [
    [2, "CURRENT", "", 0],
    [4, "REACHABLE", "2>4", 110],
    [5, "REACHABLE", "2>5", 210],
    [6, "REACHABLE", "2>6", 50],
    [7, "REACHABLE", "2>6>7", 380],
    [8, "REACHABLE", "2>6>8", 160],
    [12, "REACHABLE", "2>12", 330],
    [14, "NONE", "", 0],
    [16, "NONE", "", 0],
  ]);
  // A known node with no path of discovered nodes is DISTANT (yellow), not hidden.
  const cut = frameXmlTaxiNodes({ ...FRAMEXML_CANNED_TAXI_MENU, knownNodes: [2, 8] },
    FRAMEXML_CANNED_TAXI_CATALOG, FRAMEXML_CANNED_TAXI_CONTINENT, "Alliance");
  assert.equal(cut.find((entry) => entry.node.id === 8).type, "DISTANT", "Thelsamar without Ironforge");
  // A Horde character is not offered Alliance-only nodes it has not discovered.
  assert.deepEqual(frameXmlTaxiNodes({ ...FRAMEXML_CANNED_TAXI_MENU, knownNodes: [2] },
    FRAMEXML_CANNED_TAXI_CATALOG, FRAMEXML_CANNED_TAXI_CONTINENT, "Horde").map((entry) => entry.node.id), [2]);
});

test("positions: the flight map's square (WorldMapContinent TaxiMin/TaxiMax), v measured up from the bottom", () => {
  const nodes = frameXmlTaxiNodes(FRAMEXML_CANNED_TAXI_MENU, FRAMEXML_CANNED_TAXI_CATALOG, FRAMEXML_CANNED_TAXI_CONTINENT, "Alliance");
  const at = (id) => nodes.find((entry) => entry.node.id === id).position;
  const [u, v] = at(2);
  // Stormwind: world (x -8840.56, y 489.70) in EK's TaxiMin (-16530, -16530) .. TaxiMax (12270, 12270):
  // u = (maxY - y) / 28800 across, v = (x - minX) / 28800 up from the bottom.
  assert.ok(Math.abs(u - (12270 - 489.7) / 28800) < 1e-9, String(u));
  assert.ok(Math.abs(v - (-8840.56 + 16530) / 28800) < 1e-9, String(v));
  // The square picture keeps the world's proportions: Stormwind -> Ironforge is 1645.14 yd east for
  // 4018.78 yd north, and so it is on the map. The 1.5:1 WorldMapArea made it 0.28 (the review).
  const [iu, iv] = at(6);
  assert.ok(Math.abs((iu - u) / (iv - v) - (489.7 + 1155.44) / (-4821.78 + 8840.56)) < 1e-9);
  assert.ok(at(6)[1] > at(2)[1], "Ironforge is north of Stormwind: higher up the map");
  assert.ok(at(4)[1] < at(2)[1], "Sentinel Hill is south");
  assert.ok(at(8)[0] > at(6)[0], "Thelsamar is east of Ironforge");
  assert.equal(frameXmlTaxiNodes(FRAMEXML_CANNED_TAXI_MENU, FRAMEXML_CANNED_TAXI_CATALOG, undefined, "Alliance")[0].position,
    undefined, "no rectangle, no position");
});

test("the flight map's rectangle: TaxiMin/TaxiMax as world [x, y]; an older gateway's WorldMapArea stands in", () => {
  // Kalimdor's corners are the asymmetric ones (this dataset's WorldMapContinent row 2): read as
  // [x, y] every one of its 52 nodes lands on TAXIMAP1's coast and towns (plotted), as [y, x] the
  // east coast's nodes fall in the sea.
  assert.deepEqual(frameXmlTaxiMapBounds({ taxiMin: [-11870, -13370], taxiMax: [12470, 10970] }, FRAMEXML_CANNED_TAXI_WORLD_MAP_AREA),
    { left: 10970, right: -13370, top: 12470, bottom: -11870 });
  assert.equal(frameXmlTaxiMapBounds({}, FRAMEXML_CANNED_TAXI_WORLD_MAP_AREA), FRAMEXML_CANNED_TAXI_WORLD_MAP_AREA,
    "a /dbc/areas reply from before the field: the continent's WorldMapArea");
  assert.equal(frameXmlTaxiMapBounds({ taxiMin: [0, 0], taxiMax: [0, 0] }, undefined), undefined, "a degenerate row is no rectangle");
  assert.equal(frameXmlTaxiMapBounds(undefined, undefined), undefined);
  const stand = frameXmlTaxiNodes(FRAMEXML_CANNED_TAXI_MENU, FRAMEXML_CANNED_TAXI_CATALOG, FRAMEXML_CANNED_TAXI_WORLD_MAP_AREA, "Alliance")[0];
  assert.ok(Math.abs(stand.position[0] - (18171.970703125 - 489.7) / (18171.970703125 + 22569.2109375)) < 1e-9,
    "the stand-in still maps through worldMapPoint");
});

test("TAXIMAP_OPENED once per menu, after the catalog; TAXIMAP_CLOSED when the flight leaves or the map is closed", async () => {
  let catalog;
  let resolve;
  const loading = new Promise((done) => { resolve = done; });
  const { world, fired } = fixture({ catalog: () => catalog, loadCatalog: () => loading });
  world.open();
  assert.deepEqual(fired, [], "without the catalog every node would read NONE");
  catalog = FRAMEXML_CANNED_TAXI_CATALOG;
  resolve(catalog);
  await loading;
  await Promise.resolve();
  assert.deepEqual(fired.map(([event]) => event), ["TAXIMAP_OPENED"]);
  world.reply(3);
  assert.equal(fired.length, 1, "a refused flight keeps the map open");
  world.reply(0);
  assert.deepEqual(fired.map(([event]) => event), ["TAXIMAP_OPENED", "TAXIMAP_CLOSED"]);
});

test("the C API over the open map: names, types, positions, costs, hops and TakeTaxiNode", () => {
  const { world, call } = fixture();
  world.open();
  assert.deepEqual(call("NumTaxiNodes"), [9]);
  assert.deepEqual(call("TaxiNodeName", 5), ["Гавань Менетилов, Болотина"], "index 5 of 2,4,5,6,7,… is node 7");
  assert.deepEqual([1, 2, 8].map((index) => call("TaxiNodeGetType", index)[0]), ["CURRENT", "REACHABLE", "NONE"]);
  assert.deepEqual(call("TaxiNodeCost", 6), [160]);
  assert.deepEqual(call("GetNumRoutes", 6), [2], "Thelsamar: two hops through Ironforge");
  const [sx, sy] = [call("TaxiGetSrcX", 6, 1)[0], call("TaxiGetSrcY", 6, 1)[0]];
  assert.deepEqual([sx, sy], call("TaxiNodePosition", 1), "hop 1 starts at Stormwind");
  assert.deepEqual([call("TaxiGetDestX", 6, 2)[0], call("TaxiGetDestY", 6, 2)[0]], call("TaxiNodePosition", 6), "hop 2 ends at Thelsamar");
  assert.deepEqual(call("TaxiGetDestX", 6, 3), [0], "no third hop");
  assert.deepEqual(call("GetTaxiMapID"), [0]);
  assert.deepEqual(call("WebClientTaxiMapTexture"), ["Interface\\TaxiFrame\\TAXIMAP0"]);
  call("TakeTaxiNode", 6);
  call("TakeTaxiNode", 1);
  call("TakeTaxiNode", 8);
  assert.deepEqual(world.calls, [{ kind: "take", guid: FRAMEXML_CANNED_TAXI_MASTER, nodes: [2, 6, 8] }],
    "only a reachable node flies, with every hop (CMSG_ACTIVATETAXIEXPRESS)");
  call("CloseTaxiMap");
  assert.deepEqual(world.calls.at(-1), { kind: "close" });
  assert.deepEqual(call("NumTaxiNodes"), [0]);
});

test("a failed catalog fetch is asked once per menu and said as an error, never spun", async () => {
  let loads = 0;
  const { world, fired } = fixture({ catalog: () => undefined, loadCatalog: () => { loads += 1; return Promise.resolve(undefined); } });
  world.open();
  for (let round = 0; round < 5; round += 1) await Promise.resolve();
  assert.equal(loads, 1);
  assert.deepEqual(fired, [["UI_ERROR_MESSAGE", "Карта маршрутов недоступна."]]);
  world.open({ ...world.taxiMenu });
  for (let round = 0; round < 5; round += 1) await Promise.resolve();
  assert.equal(loads, 2, "the next flight master asks again");
});

test("no WorldMapArea rectangle yet: the node extent stands in, so TaxiFrame never multiplies a nil", () => {
  const { world, call } = fixture({ continent: () => undefined });
  world.open();
  for (let index = 1; index <= 9; index += 1) {
    const [x, y] = call("TaxiNodePosition", index);
    assert.ok(x > 0 && x < 1 && y > 0 && y < 1, `node ${index} at (${x}, ${y})`);
  }
  // The same orientation as the real rectangle: Ironforge north of Stormwind, Thelsamar east of it.
  assert.ok(call("TaxiNodePosition", 4)[1] > call("TaxiNodePosition", 1)[1]);
  assert.ok(call("TaxiNodePosition", 6)[0] > call("TaxiNodePosition", 4)[0]);
});

test("unowned or probed, the model raises nothing and sends nothing; UnitOnTaxi reads the unit flag", () => {
  const { model, world, fired, call } = fixture();
  model.owned = false;
  world.open();
  assert.deepEqual(fired, [], "the native list answers while unpublished");
  model.owned = true;
  assert.deepEqual(fired.map(([event]) => event), ["TAXIMAP_OPENED"], "publication hands the open map over");
  model.probe({ menu: FRAMEXML_CANNED_TAXI_MENU, catalog: FRAMEXML_CANNED_TAXI_CATALOG, continent: FRAMEXML_CANNED_TAXI_CONTINENT },
    () => { call("TakeTaxiNode", 2); call("CloseTaxiMap"); });
  assert.deepEqual(world.calls, []);
  const onTaxi = new FrameXmlTaxiModel({ world: () => undefined, continent: () => undefined, playerFaction: () => undefined,
    unitOnTaxi: (unit) => unit === "player" });
  assert.deepEqual(FRAMEXML_TAXI_BINDINGS.UnitOnTaxi({ taxi: onTaxi }, ["player"]), [true]);
  assert.deepEqual(FRAMEXML_TAXI_BINDINGS.UnitOnTaxi({ taxi: onTaxi }, ["target"]), [false]);
  for (const name of Object.keys(FRAMEXML_TAXI_BINDINGS)) assert.ok(FRAMEXML_SEAM_BINDINGS[name], name);
});
}
