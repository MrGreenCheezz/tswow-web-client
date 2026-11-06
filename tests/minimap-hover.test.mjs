import assert from "node:assert/strict";
import test from "node:test";

// 3.13 (07.11): the minimap's tooltip and its three guide arrows, as Wow.exe 0x0057c720 and 0x007f44a0 have them
// (.runtime/re-2026-11-07/313).

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

let minimapCanvas;
const listeners = new Map();
const canvas = () => {
  const node = fakeNode();
  node.clientWidth = 140;
  node.width = 140;
  node.height = 140;
  node.getContext = (kind) => (kind === "2d" ? context : null);
  node.getBoundingClientRect = () => ({ left: 0, top: 0, width: 140, height: 140 });
  node.addEventListener = (type, listener) => { listeners.set(type, listener); };
  minimapCanvas = node;
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
  minimapHoverHits, minimapHoverText, sameMinimapHoverHits, MINIMAP_HOVER_ARROW_UNITS, MINIMAP_HOVER_ICON_UNITS,
} = await import("../dist/code/browser/ui/MinimapHover.js");
const { minimapGuideArrowInside, minimapGuideMarks } = await import("../dist/code/browser/ui/MinimapGuideArrows.js");
const { minimapObjectList, MINIMAP_FLIGHT_MASTER_CELL, MINIMAP_POI_ARROW_TEXTURE } = await import("../dist/code/browser/ui/MinimapArt.js");
const { compileFrameXmlMinimapHover } = await import("../dist/code/browser/framexml/FrameXmlMinimapHover.js");
const { GlueLuaVm } = await import("../dist/code/browser/glue/GlueLua.js");

const empty = { guideArrows: [], partyArrows: [], raidArrows: [], poiIcons: [], blips: [] };
const at = (column, row) => ({ column, row });

test("an arrow is hit strictly within 6.4 units of its centre, an icon within 8 with both edges, scaled", () => {
  const scene = { ...empty, guideArrows: [{ point: at(0, -56), name: "Златоземье" }], poiIcons: [{ point: at(20, 0), name: "Труп" }] };
  assert.equal(MINIMAP_HOVER_ARROW_UNITS, 6.4);
  assert.equal(MINIMAP_HOVER_ICON_UNITS, 8);
  assert.deepEqual(minimapHoverHits(scene, at(6.39, -56 + 6.39), 1).map((hit) => hit.key), ["g0"]);
  assert.deepEqual(minimapHoverHits(scene, at(6.4, -56), 1), [], "the arrow's edge is out");
  assert.deepEqual(minimapHoverHits(scene, at(28, 8), 1).map((hit) => hit.key), ["i0"], "the icon's edge is in");
  assert.deepEqual(minimapHoverHits(scene, at(28.01, 0), 1), []);
  // The frame at half scale: the icon's box is 16 frame units, the arrow's stays.
  assert.deepEqual(minimapHoverHits(scene, at(36, 0), 0.5).map((hit) => hit.key), ["i0"]);
  assert.deepEqual(minimapHoverHits(scene, at(6.5, -56), 0.5), []);
});

test("the hits go guide, party, raid, POI icons, then blips list by list", () => {
  const here = at(0, 0);
  const scene = {
    guideArrows: [{ point: here, name: "Стрелка" }],
    partyArrows: [{ point: here, name: "Друг" }],
    raidArrows: [{ point: here, name: "Рейд" }],
    poiIcons: [{ point: here, name: "Метка" }],
    blips: [
      { list: 13, point: here, name: "Распорядитель", flightMaster: true },
      { list: 9, point: here, name: "Квест 1" },
      { list: 13, point: at(30, 0), name: "Далеко" },
      { list: 9, point: here, name: "Квест 2" },
      { list: 1, point: here, name: "Группа" },
    ],
  };
  const hits = minimapHoverHits(scene, here, 1);
  assert.deepEqual(hits.map((hit) => hit.key), ["g0", "p0", "r0", "i0", "b1:0", "b9:0", "b9:1", "b13:0"]);
  assert.equal(minimapHoverText(hits, { colorblind: false, flightMaster: "Распорядитель полетов" }),
    "Стрелка\nДруг\nРейд\nМетка\nГруппа\nКвест 1\nКвест 2\nРаспорядитель");
  assert.equal(sameMinimapHoverHits(hits, minimapHoverHits(scene, at(1, 1), 1)), true, "the same set: no rewrite");
  assert.equal(sameMinimapHoverHits(hits, minimapHoverHits(scene, at(30, 0), 1)), false);
  const one = minimapHoverHits(scene, at(30, 0), 1);
  const other = minimapHoverHits({ ...empty, poiIcons: [{ point: at(30, 0), name: "Метка" }] }, at(30, 0), 1);
  assert.equal(sameMinimapHoverHits(one, other), false, "one hit each, a different one: rewritten");
});

test("a blip's own lines: the flight master's in colorblind mode, the subname, grey, a nameless one left out", () => {
  const here = at(0, 0);
  const hits = minimapHoverHits({
    ...empty,
    blips: [
      { list: 8, point: here, name: "Тренер", subName: "Учитель портняжного дела", grey: true },
      { list: 8, point: here, name: undefined },
      { list: 13, point: here, name: "Распорядитель", flightMaster: true },
    ],
  }, here, 1);
  assert.equal(minimapHoverText(hits, { colorblind: true, flightMaster: "Распорядитель полетов" }),
    "|cffb0b0b0Тренер\n <Учитель портняжного дела>|r\nРаспорядитель\n <Распорядитель полетов>");
  assert.equal(minimapHoverText(hits, { colorblind: false, flightMaster: "Распорядитель полетов" }),
    "|cffb0b0b0Тренер\n <Учитель портняжного дела>|r\nРаспорядитель");
});

const poi = (name, x, y, importance = 3, flags = 0x1, kind = "areaPoi") => ({ kind, name, x, y, importance, flags });
const player = { x: 0, y: 0 };

test("at most three arrows: the lowest importance, then the nearer; the worst kept gives way", () => {
  const marks = minimapGuideMarks([
    poi("A", 300, 0), poi("B", 400, 0), poi("C", 500, 0), poi("D", 350, 0), poi("E", 600, 0, 2), poi("F", 690, 0, 3),
  ], player, 233);
  assert.deepEqual(marks.arrows.map((mark) => mark.name), ["A", "E", "D"],
    "D (nearer than C) took C's slot, E (importance 2) took B's, F (the farthest of equals) none");
  assert.deepEqual(minimapGuideMarks([poi("A", 300, 0), poi("B", 300, 0)], player, 233).arrows.map((mark) => mark.name),
    ["A", "B"]);
});

test("the corpse at any distance, others to 694.44 yards; inside 0.8 of the radius only an icon with flag 0x2", () => {
  const marks = minimapGuideMarks([
    poi("далеко", 694.45, 0), poi("край", 694.44, 0), poi("рядом", 100, 0), poi("значок", 0, 100, 3, 0x3),
    poi("Труп", 5000, 0, -1, 0x2, "corpse"), poi("ноль", 0, 0, 3, 0x3),
  ], player, 233);
  assert.deepEqual(marks.arrows.map((mark) => mark.name), ["край", "Труп"]);
  assert.deepEqual(marks.icons.map((mark) => mark.name), ["значок"]);
  assert.equal(minimapGuideArrowInside(poi("город", 1, 1)), false, "an AreaPOI arrow is not over a building's minimap");
  assert.equal(minimapGuideArrowInside(poi("башня", 1, 1, 3, 0x101)), true);
  assert.equal(minimapGuideArrowInside(poi("Труп", 1, 1, -1, 0x2, "corpse")), true);
});

test("an object's list is its ObjectIcons cell", () => {
  assert.equal(minimapObjectList({ column: 1, row: 1 }), 9);
  assert.equal(minimapObjectList(MINIMAP_FLIGHT_MASTER_CELL), 13);
});

const ENTRY = UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset;
const NPC_FLAGS = UPDATE_FIELDS.UNIT_NPC_FLAGS.offset;
// Outdoors at the widest step: 466.67 yards over 140 units, so a yard north is 0.3 units up.
const YARDS_PER_UNIT = 1400 / 3 / 140;

function liveWorld() {
  const self = { guid: 1n, typeId: 4, position: { x: 0, y: 0, z: 0, orientation: 0 }, fields: new Map() };
  const quest = { guid: 50n, typeId: 3, position: { x: 30 * YARDS_PER_UNIT, y: 0, z: 0, orientation: 0 }, fields: new Map([[ENTRY, 240]]) };
  const flight = {
    guid: 60n, typeId: 3, position: { x: 30 * YARDS_PER_UNIT, y: -12 * YARDS_PER_UNIT, z: 0, orientation: 0 },
    fields: new Map([[ENTRY, 352], [NPC_FLAGS, 0x2000]]),
  };
  return {
    mapId: 0,
    // The flight master walked in first: the tooltip still names list 9 before list 13.
    state: { selfGuid: 1n, revision: 0, objects: new Map([[1n, self], [60n, flight], [50n, quest]]) },
    questPoi: new Map(), questGiverStatus: new Map([[50n, 8]]), taxiNodeStatus: new Map([[60n, false]]),
    names: new Map(), selfName: "Я", petNameOf: () => undefined, gameObjectTemplate: () => undefined,
    creatureTemplates: new Map([[240, { found: true, name: "Маршал Дугхан", subName: "" }], [352, { found: true, name: "Торнвил", subName: "Распорядитель полетов" }]]),
    currentGameTime: () => undefined,
  };
}

test("on the canvas: the names under the pointer go to the host, rewritten only when they change", () => {
  const shown = [];
  let colorblind = false;
  const strings = { MINIMAP_TRACKING_FLIGHTMASTER: "Распорядитель полетов", UNKNOWNOBJECT: "Неизвестно", CORPSE_RED: "Труп" };
  game.world = liveWorld();
  game.mapArt = { bitmap: (path) => ({ path }), revision: 0 };
  game.areas = {
    snapshot: () => areaData,
    area: () => undefined,
  };
  const areaPoi = (id, name, x, y) => ({ id, importance: 3, icons: [0], factionId: 0, x, y, mapId: 0, flags: 0x1, areaId: 0, name, description: "", worldStateId: 0, worldMapLink: 0 });
  // Four towns past the rim to the north, nearest last in the file: Wow.exe keeps three.
  const areaData = { areaPois: [areaPoi(1, "Дальний", 650, 0), areaPoi(2, "Средний", 500, 0), areaPoi(3, "Ближний", 400, 0), areaPoi(4, "Соседний", 300, 0)] };
  setMinimapHoverHost({
    show: (text) => shown.push(["show", text]),
    hide: () => shown.push(["hide"]),
    globalString: (name) => strings[name],
    colorblind: () => colorblind,
  });
  forgetMinimap();
  calls.length = 0;
  updateMinimap(0);
  const arrows = calls.filter((call) => call[1] === MINIMAP_POI_ARROW_TEXTURE);
  assert.equal(arrows.length, 3, "three guide arrows drawn of four towns");
  const flightCells = calls.filter((call) => call[1]?.includes("ObjectIcons") && call[2] === 5 * 32 && call[3] === 32);
  assert.equal(flightCells.length, 1, "the undiscovered flight master's cell (5,1)");

  const move = (column, row) => listeners.get("mousemove")({ clientX: 70 + column, clientY: 70 + row });
  move(0, -30);
  assert.deepEqual(shown, [["show", "Маршал Дугхан"]]);
  move(1, -29);
  assert.equal(shown.length, 1, "the same hit: nothing rewritten");
  move(6, -30);
  assert.deepEqual(shown.at(-1), ["show", "Маршал Дугхан\nТорнвил"], "list 9 before list 13");
  colorblind = true;
  move(20, -30);
  assert.deepEqual(shown.at(-1), ["show", "Торнвил\n <Распорядитель полетов>"]);
  move(0, -56);
  assert.deepEqual(shown.at(-1), ["show", "Соседний\nБлижний\nСредний"], "the arrows north overlap, named by slot");
  move(-40, 20);
  assert.deepEqual(shown.at(-1), ["hide"], "nothing under the pointer");
  const count = shown.length;
  listeners.get("mouseleave")();
  assert.equal(shown.length, count, "leaving with nothing named hides nothing more");
  move(0, -30);
  listeners.get("mouseleave")();
  assert.deepEqual(shown.slice(-2), [["show", "Маршал Дугхан"], ["hide"]]);

  setMinimapHoverHost(undefined);
  move(0, -30);
  assert.deepEqual(shown.at(-1), ["hide"], "no host, no tooltip");
  game.world = undefined;
  game.mapArt = undefined;
  game.areas = undefined;
  forgetMinimap();
  assert.ok(minimapCanvas);
});

test("the Lua half: SetOwner to Minimap at the cursor, the text in NORMAL_FONT_COLOR, Show; Hide", () => {
  const vm = new GlueLuaVm();
  try {
    vm.execute(`
      __calls = {}
      local function log(text) __calls[#__calls + 1] = text end
      Minimap = { name = "Minimap" }
      NORMAL_FONT_COLOR = { r = 1.0, g = 0.82, b = 0 }
      CORPSE_RED = "Труп"
      GameTooltip = {}
      function GameTooltip:SetOwner(owner, anchor) log("SetOwner:" .. owner.name .. ":" .. anchor) end
      function GameTooltip:SetText(text, r, g, b) log("SetText:" .. text .. ":" .. r .. "," .. g .. "," .. b) end
      function GameTooltip:Show() log("Show") end
      function GameTooltip:Hide() log("Hide") end
      __cvar = "0"
      function GetCVarBool(name) return name == "colorblindMode" and __cvar == "1" end
      function __joined() return table.concat(__calls, "|") end
    `, "@t");
    const host = compileFrameXmlMinimapHover(vm);
    host.show("Маршал Дугхан\nТорнвил");
    host.hide();
    const joined = vm.call(vm.compileFunction("return __joined()", "t", []), [], 1)[0];
    assert.equal(joined, "SetOwner:Minimap:ANCHOR_CURSOR|SetText:Маршал Дугхан\nТорнвил:1,0.82,0|Show|Hide");
    assert.equal(host.colorblind(), false);
    vm.execute('__cvar = "1"', "@t");
    assert.equal(host.colorblind(), true);
    assert.equal(host.globalString("CORPSE_RED"), "Труп");
  } finally {
    vm.close();
  }
});
