import assert from "node:assert/strict";
import test from "node:test";

// 3.13 (15.11): objects in a building on the minimap, as Wow.exe 0x0057F7F0 has them (.runtime/re-2026-11-15/quest5,
// .runtime/re-2026-11-07/313): a player in a building sees only that building's objects; a player outside sees every
// object, those in a building with icons at 0xB0B0B0 and names in |cffb0b0b0.

const calls = [];
const context = {
  setTransform() {}, clearRect() {}, save() {}, restore() {}, translate() {},
  rotate() {}, beginPath() {}, arc() {}, clip() {}, fillRect() {},
  drawImage(image, ...rest) { calls.push({ path: image?.path, rest, filter: this.filter }); },
  fill() {}, stroke() {}, strokeText() {}, fillText() {}, moveTo() {}, lineTo() {}, closePath() {}, rect() {},
  createLinearGradient: () => ({ addColorStop() {} }),
  measureText: () => ({ width: 10 }),
  fillStyle: "", strokeStyle: "", lineWidth: 1, font: "", textAlign: "", textBaseline: "", filter: "none",
  imageSmoothingEnabled: true, globalCompositeOperation: "source-over",
};

const fakeNode = () => ({
  children: [], dataset: {}, className: "", textContent: "", hidden: false, disabled: false,
  value: "", type: "", title: "", tabIndex: 0,
  style: { setProperty() {}, removeProperty() {}, getPropertyValue: () => "" },
  classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  append() {}, appendChild(child) { return child; }, insertBefore(child) { return child; },
  replaceChildren() {}, remove() {},
  addEventListener() {}, removeEventListener() {}, setAttribute() {}, getAttribute() { return null; },
  querySelector: () => fakeNode(), querySelectorAll: () => [],
});

const listeners = new Map();
const canvas = () => {
  const node = fakeNode();
  node.clientWidth = 140;
  node.width = 140;
  node.height = 140;
  node.getContext = (kind) => (kind === "2d" ? context : null);
  node.getBoundingClientRect = () => ({ left: 0, top: 0, width: 140, height: 140 });
  node.addEventListener = (type, listener) => { listeners.set(type, listener); };
  return node;
};

globalThis.location = { protocol: "http:", hostname: "127.0.0.1", origin: "http://127.0.0.1:5173" };
globalThis.window = {
  addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1,
  innerWidth: 1024, innerHeight: 768,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
};
globalThis.localStorage = globalThis.window.localStorage;
globalThis.document = {
  createElement: (tag) => (tag === "canvas" ? canvas() : fakeNode()),
  createElementNS: () => fakeNode(),
  body: fakeNode(), documentElement: fakeNode(), head: fakeNode(),
  getElementById: () => fakeNode(), querySelector: () => null, querySelectorAll: () => [],
  addEventListener() {}, removeEventListener() {},
};

const { game } = await import("../dist/code/browser/game/Context.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { forgetMinimap, setMinimapHoverHost, updateMinimap } = await import("../dist/code/browser/ui/Minimap.js");
const {
  MINIMAP_WMO_GREY, MINIMAP_WMO_RECHECK_MS, MinimapWmoMembership, minimapWmoBuildingAt, minimapWmoVerdict,
} = await import("../dist/code/browser/MinimapWmoMembership.js");

// A building: an interior room over x ∈ [10, 40], its floor at z 0, the terrain far below; a courtyard group open to
// the sky (MOGP 0x8) over x ∈ [-40, -10]. Everything else has no WMO floor.
const INN = "world/wmo/azeroth/buildings/inn/inn.wmo";
const HOUSE = "world/wmo/azeroth/buildings/house/house.wmo";
function floorAt(x) {
  if (x >= 10 && x <= 40) return { floorZ: 0, groupFlags: 0x2000, placement: { canonicalModelName: INN } };
  if (x >= 50 && x <= 60) return { floorZ: 0, groupFlags: 0x2000, placement: { canonicalModelName: HOUSE } };
  if (x >= -40 && x <= -10) return { floorZ: 0, groupFlags: 0x8, placement: { canonicalModelName: INN } };
  return null;
}
function sources(overrides = {}) {
  return {
    revision: 1,
    floor: (_map, x) => floorAt(x),
    gridHeight: () => -20,
    ...overrides,
  };
}

test("0x0057F7F0's verdict: the player inside lists only its own building, plain; outside, a building's object is grey", () => {
  assert.equal(minimapWmoVerdict(undefined, undefined), "plain");
  assert.equal(minimapWmoVerdict(undefined, INN), "grey");
  assert.equal(minimapWmoVerdict(INN, INN), "plain");
  assert.equal(minimapWmoVerdict(INN, HOUSE), "hidden");
  assert.equal(minimapWmoVerdict(INN, undefined), "hidden", "an object outside is not listed for a player inside");
});

test("in a building: a WMO floor without MOGP 0x8 that the server would stand on; null while the collision is not current", () => {
  const live = sources();
  assert.equal(minimapWmoBuildingAt(live, 0, 20, 0, 0), INN);
  assert.equal(minimapWmoBuildingAt(live, 0, -20, 0, 0), undefined, "a courtyard open to the sky is not inside (0x007A1480)");
  assert.equal(minimapWmoBuildingAt(live, 0, 0, 0, 0), undefined, "no WMO floor");
  // A cellar under the ground: the terrain above it wins (Map.cpp GetAreaId), the object stands outside.
  assert.equal(minimapWmoBuildingAt(sources({ gridHeight: () => 5 }), 0, 20, 0, 5), undefined);
  assert.equal(minimapWmoBuildingAt(sources({ floor: () => undefined }), 0, 20, 0, 0), null);
});

test("the cost: a walk on first sight, then at most once a second and only after a move, a new collision or no answer", () => {
  const membership = new MinimapWmoMembership();
  const live = sources();
  const at = { x: 20, y: 0, z: 0 };
  membership.begin();
  assert.equal(membership.buildingOf(5n, 0, at, 0, live), INN);
  assert.equal(membership.walks, 1);
  assert.equal(membership.buildingOf(5n, 0, { x: 45, y: 0, z: 0 }, 500, live), INN, "within the second the answer stands");
  assert.equal(membership.walks, 1);
  assert.equal(membership.buildingOf(5n, 0, at, MINIMAP_WMO_RECHECK_MS + 10, live), INN, "a second on, standing still: no walk");
  assert.equal(membership.walks, 1);
  assert.equal(membership.buildingOf(5n, 0, { x: 45, y: 0, z: 0 }, MINIMAP_WMO_RECHECK_MS + 20, live), undefined);
  assert.equal(membership.walks, 2);
  live.revision = 2;
  assert.equal(membership.buildingOf(5n, 0, { x: 45, y: 0, z: 0 }, 2 * MINIMAP_WMO_RECHECK_MS + 30, live), undefined);
  assert.equal(membership.walks, 3, "other walls: asked again");
  membership.end();
  membership.begin();
  membership.end();
  membership.begin();
  membership.buildingOf(5n, 0, at, 2 * MINIMAP_WMO_RECHECK_MS + 40, live);
  assert.equal(membership.walks, 4, "an object not listed in a pass is forgotten");
});

const ENTRY = UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset;
// Outdoors at the widest step: 466.67 yards over 140 units.
const YARDS_PER_UNIT = 1400 / 3 / 140;

function liveWorld(playerX) {
  const self = { guid: 1n, typeId: 4, position: { x: playerX, y: 0, z: 0, orientation: 0 }, fields: new Map() };
  const unit = (guid, x, y, entry) => ({ guid, typeId: 3, position: { x, y, z: 0, orientation: 0 }, fields: new Map([[ENTRY, entry]]) });
  return {
    mapId: 0,
    state: {
      selfGuid: 1n, revision: 0,
      objects: new Map([[1n, self], [50n, unit(50n, 20, 0, 240)], [51n, unit(51n, 0, 30, 241)], [52n, unit(52n, 55, 0, 242)]]),
    },
    questPoi: new Map(), questGiverStatus: new Map([[50n, 8], [51n, 8], [52n, 8]]), taxiNodeStatus: new Map(),
    names: new Map(), selfName: "Я", petNameOf: () => undefined, gameObjectTemplate: () => undefined,
    creatureTemplates: new Map([
      [240, { found: true, name: "Трактирщик", subName: "" }],
      [241, { found: true, name: "Стражник", subName: "" }],
      [242, { found: true, name: "Хозяйка", subName: "" }],
    ]),
    currentGameTime: () => undefined,
  };
}

/** The quest marks drawn (ObjectIcons cell (1,1)), in order, with the filter each was drawn with. */
function questDraws() {
  return calls.filter((call) => call.path?.includes("ObjectIcons") && call.rest[0] === 32 && call.rest[1] === 32)
    .map((call) => ({ filter: call.filter }));
}

test("on the canvas: outside, the inn's quest giver is grey and drawn last; inside the inn, only the inn's own", () => {
  const shown = [];
  game.mapArt = { bitmap: (path) => ({ path }), revision: 0 };
  game.areas = { snapshot: () => ({ areaPois: [] }), area: () => undefined };
  game.terrain = { heightAt: () => -20, areaAt: () => 0 };
  game.collision = { revision: 1, staticWmoFloorState: (_map, x) => floorAt(x) };
  setMinimapHoverHost({ show: (text) => shown.push(text), hide() {}, globalString: () => undefined, colorblind: () => false });
  try {
    // The player in the open at the origin: three quest givers, the inn's and the house's grey, after the plain one.
    game.world = liveWorld(0);
    forgetMinimap();
    calls.length = 0;
    updateMinimap(0);
    const outside = questDraws();
    assert.equal(outside.length, 3);
    assert.deepEqual(outside.map((draw) => draw.filter), ["none", `brightness(${MINIMAP_WMO_GREY})`, `brightness(${MINIMAP_WMO_GREY})`],
      "the plain list first (0x00580380 with 0), then the marked one (with 1)");
    assert.equal(context.filter, "none", "the filter is put back");
    // The tooltip over the inn's quest giver, 20 yards north: its name in grey.
    listeners.get("mousemove")({ clientX: 70, clientY: 70 - 20 / YARDS_PER_UNIT });
    assert.equal(shown.at(-1), "|cffb0b0b0Трактирщик|r");
    listeners.get("mouseleave")();

    // The player inside the inn: the guard outside and the house's mistress are not listed, the innkeeper is, plain.
    game.world = liveWorld(15);
    forgetMinimap();
    calls.length = 0;
    updateMinimap(0);
    const inside = questDraws();
    assert.equal(inside.length, 1);
    assert.equal(inside[0].filter, "none");
    listeners.get("mousemove")({ clientX: 70, clientY: 70 - 5 / YARDS_PER_UNIT });
    assert.equal(shown.at(-1), "Трактирщик");
  } finally {
    setMinimapHoverHost(undefined);
    game.world = undefined;
    game.mapArt = undefined;
    game.areas = undefined;
    game.terrain = undefined;
    game.collision = undefined;
    forgetMinimap();
  }
});
