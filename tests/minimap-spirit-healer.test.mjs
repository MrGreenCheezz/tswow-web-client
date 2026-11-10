import assert from "node:assert/strict";
import test from "node:test";

// 3.13 (11.11): the spirit healer's mark (Wow.exe 0x006e2e90 case 0x378 → 0x0051f690 → 0x007f4a00, cleared by
// 0x006df710) and the AreaPOI bound to a world state (0x007f44a0 through 0x00548d10), on the minimap's canvas.
// Notes: .runtime/re-2026-11-11/minimap/spirit.c, spirit2.c, enter.c, areapoi.c.

const calls = [];
const context = {
  setTransform() {}, clearRect() {}, save() {}, restore() {}, translate() {},
  rotate() {}, beginPath() {}, arc() {}, clip() {}, fillRect() {},
  drawImage(image, ...rest) { calls.push(["draw", image?.path, ...rest]); },
  fill() {}, stroke() {}, strokeText() {}, fillText() {}, moveTo() {}, lineTo() {}, closePath() {}, rect() {},
  createLinearGradient: () => ({ addColorStop() {} }),
  measureText: () => ({ width: 10 }),
  fillStyle: "", strokeStyle: "", lineWidth: 1, font: "", textAlign: "", textBaseline: "",
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
const { MINIMAP_POI_ARROW_TEXTURE, minimapPoiWorldStateShown, minimapRimPois } =
  await import("../dist/code/browser/ui/MinimapArt.js");
const { MINIMAP_GUIDE_ARROW_TEXTURE, MINIMAP_POI_ICONS_TEXTURE, minimapPoiIconCell } =
  await import("../dist/code/browser/ui/MinimapGossipPoi.js");
const { spiritHealerMarkAfterRelease, SPIRIT_HEALER_POI_ICON } = await import("../dist/code/world/SpiritHealerMark.js");

const PLAYER_FLAGS = UPDATE_FIELDS.PLAYER_FLAGS.offset;
// Outdoors at the widest step: 466.67 yards over 140 units.
const YARDS_PER_UNIT = 1400 / 3 / 140;

test("the release packet sets the mark on this map or map −1, keeps it for another map, and clears it for a ghost", () => {
  const release = (mapId, x, y) => ({ mapId, x, y, z: 0 });
  const kept = { x: 1, y: 2 };
  assert.deepEqual(spiritHealerMarkAfterRelease(undefined, release(0, 10, 20), 0, false), { x: 10, y: 20 });
  assert.deepEqual(spiritHealerMarkAfterRelease(kept, release(1, 10, 20), 0, false), kept, "another map leaves the mark");
  assert.deepEqual(spiritHealerMarkAfterRelease(kept, release(-1, 10, 20), 0, false), { x: 10, y: 20 });
  assert.equal(spiritHealerMarkAfterRelease(kept, release(-1, 0, 0), 0, false), undefined,
    "TrinityCore's ResurrectPlayer: map −1 at the origin is no mark");
  assert.equal(spiritHealerMarkAfterRelease(kept, release(0, 10, 20), 0, true), undefined, "with GHOST set, cleared");
  assert.equal(SPIRIT_HEALER_POI_ICON, 8);
});

test("a world-state AreaPOI counts only while its state is not 0", () => {
  const poi = (worldStateId) => ({ x: 1, y: 1, mapId: 0, flags: 0x1, worldStateId });
  const states = new Map([[2355, 1], [2356, 0]]);
  const get = (id) => states.get(id);
  assert.equal(minimapPoiWorldStateShown(0, get), true);
  assert.equal(minimapPoiWorldStateShown(2355, get), true);
  assert.equal(minimapPoiWorldStateShown(2356, get), false, "a state at 0");
  assert.equal(minimapPoiWorldStateShown(2357, get), false, "a state the client never got");
  assert.deepEqual(minimapRimPois([poi(0), poi(2355), poi(2356)], 0, get).map((row) => row.worldStateId), [0, 2355]);
  assert.deepEqual(minimapRimPois([poi(0), poi(2355)], 0).map((row) => row.worldStateId), [0], "no states: none");
});

function liveWorld({ ghost, mark, states = new Map() }) {
  const self = {
    guid: 1n, typeId: 4, position: { x: 0, y: 0, z: 0, orientation: 0 },
    fields: new Map(ghost ? [[PLAYER_FLAGS, 0x10]] : []),
  };
  return {
    mapId: 0,
    state: { selfGuid: 1n, revision: 0, objects: new Map([[1n, self]]) },
    questPoi: new Map(), questGiverStatus: new Map(), taxiNodeStatus: new Map(),
    names: new Map(), selfName: "Я", petNameOf: () => undefined, gameObjectTemplate: () => undefined,
    creatureTemplates: new Map(), currentGameTime: () => undefined,
    spiritHealerMark: mark, worldStates: states,
  };
}

function draw(world, areaPois = []) {
  game.world = world;
  game.mapArt = { bitmap: (path) => ({ path }), revision: 0 };
  game.areas = { snapshot: () => ({ areaPois }), area: () => undefined };
  forgetMinimap();
  calls.length = 0;
  updateMinimap(0);
  return calls.slice();
}

const iconCell = minimapPoiIconCell(8);
const poiIconDraws = (drawn) => drawn.filter((call) => call[1] === MINIMAP_POI_ICONS_TEXTURE);

test("a ghost sees the spirit healer: icon 8 within the circle, the guide arrow past it, its name in the tooltip", () => {
  const shown = [];
  setMinimapHoverHost({
    show: (text) => shown.push(text), hide: () => {},
    globalString: (name) => ({ SPIRIT_HEALER_RELEASE_RED: "Целитель душ" })[name], colorblind: () => false,
  });
  try {
    // 30 units north of the centre: inside 0.8 of the radius.
    let drawn = draw(liveWorld({ ghost: true, mark: { x: 30 * YARDS_PER_UNIT, y: 0 } }));
    const icons = poiIconDraws(drawn);
    assert.equal(icons.length, 1);
    assert.deepEqual(icons[0].slice(2, 4), [iconCell.x, iconCell.y], "POIIcons icon 8");
    listeners.get("mousemove")({ clientX: 70, clientY: 70 - 30 });
    assert.deepEqual(shown, ["Целитель душ"]);

    // 500 yards north: past the circle and within 694.44, the guide arrow.
    drawn = draw(liveWorld({ ghost: true, mark: { x: 500, y: 0 } }));
    assert.equal(poiIconDraws(drawn).length, 0);
    assert.equal(drawn.filter((call) => call[1] === MINIMAP_GUIDE_ARROW_TEXTURE).length, 1);
    // 800 yards: unlike the corpse, nothing.
    drawn = draw(liveWorld({ ghost: true, mark: { x: 800, y: 0 } }));
    assert.equal(drawn.filter((call) => call[1] === MINIMAP_GUIDE_ARROW_TEXTURE).length, 0);

    // Alive again: GHOST left PLAYER_FLAGS and the mark with it (0x006df710).
    drawn = draw(liveWorld({ ghost: false, mark: { x: 30 * YARDS_PER_UNIT, y: 0 } }));
    assert.equal(poiIconDraws(drawn).length, 0);
  } finally {
    setMinimapHoverHost(undefined);
    game.world = undefined;
    game.mapArt = undefined;
    game.areas = undefined;
    forgetMinimap();
  }
});

test("a quest's POI blob puts nothing on the minimap (0x0057f7f0's objects, 0x007f6730's list)", () => {
  try {
    const world = liveWorld({ ghost: false });
    world.questPoi = new Map([[100, [{ map: 0, points: [{ x: 20, y: 0 }, { x: 20, y: 10 }, { x: 30, y: 5 }] }]]]);
    const drawn = draw(world);
    assert.equal(drawn.filter((call) => String(call[1]).includes("ObjectIcons")).length, 0);
    assert.equal(poiIconDraws(drawn).length, 0);
  } finally {
    game.world = undefined;
    game.mapArt = undefined;
    game.areas = undefined;
    forgetMinimap();
  }
});

test("a world-state AreaPOI on the canvas: absent while its state is 0 or unknown, icons[0] once it is not", () => {
  const tower = (x, y, worldStateId) => ({
    id: 1, importance: 3, icons: [6, 11, 10], factionId: 0, x, y, mapId: 0, flags: 0x3, areaId: 0, name: "Башня",
    description: "", worldStateId, worldMapLink: 0,
  });
  try {
    const near = [tower(30 * YARDS_PER_UNIT, 0, 2355)];
    assert.equal(poiIconDraws(draw(liveWorld({ ghost: false }), near)).length, 0, "no state yet");
    assert.equal(poiIconDraws(draw(liveWorld({ ghost: false, states: new Map([[2355, 0]]) }), near)).length, 0);
    const icons = poiIconDraws(draw(liveWorld({ ghost: false, states: new Map([[2355, 2]]) }), near));
    assert.equal(icons.length, 1);
    const first = minimapPoiIconCell(6);
    assert.deepEqual(icons[0].slice(2, 4), [first.x, first.y], "the record's first icon, whatever the value");
    const far = [tower(500, 0, 2355)];
    const arrows = (states) => draw(liveWorld({ ghost: false, states }), far)
      .filter((call) => call[1] === MINIMAP_POI_ARROW_TEXTURE).length;
    assert.equal(arrows(new Map()), 0);
    assert.equal(arrows(new Map([[2355, 1]])), 1);
  } finally {
    game.world = undefined;
    game.mapArt = undefined;
    game.areas = undefined;
    forgetMinimap();
  }
});
