import assert from "node:assert/strict";
import test from "node:test";

// The flight map's geometry end to end, over this dataset's own DBCs: the gateway's `/dbc/areas`
// continents carry WorldMapContinent's TaxiMin/TaxiMax, its WorldMapTransforms move Quel'Thalas and
// the Draenei isles onto EK and Kalimdor, and LiveWorldSeam hands both to the stock TaxiFrame model,
// so a node sits where the client's square TAXIMAP picture has it. In-process: the running gateway
// keeps its old dist until the owner restarts it.
import { loadAreaData } from "../dist/code/gateway/AreaMetadata.js";
import { loadTaxiMetadata } from "../dist/code/gateway/TaxiMetadata.js";
import { dbcDirectory } from "../tools/paths.mjs";

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
