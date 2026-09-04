import assert from "node:assert/strict";
import test from "node:test";

function fakeStyle() {
  return {
    setProperty(name, value) { this[name] = String(value); },
    removeProperty(name) { delete this[name]; },
  };
}

function fakeContext() {
  const context = {
    fillStyle: "", strokeStyle: "", lineWidth: 0, font: "", textAlign: "", textBaseline: "",
    measureText(text) { return { width: String(text).length * 8 }; },
  };
  return new Proxy(context, {
    get(target, property) {
      if (!(property in target)) target[property] = () => {};
      return target[property];
    },
  });
}

function fakeDocument() {
  const byId = new Map();
  let document;
  const make = (tag) => {
    const listeners = new Map();
    const node = {
      tagName: String(tag).toUpperCase(),
      children: [],
      parentElement: undefined,
      parentNode: undefined,
      dataset: {},
      style: fakeStyle(),
      className: "",
      textContent: "",
      title: "",
      hidden: false,
      disabled: false,
      id: "",
      value: "",
      type: "",
      width: 0,
      height: 0,
      clientWidth: 1280,
      clientHeight: 720,
      listeners,
      attributes: new Map(),
      classList: {
        add(...names) {
          node.className = [...new Set([...node.className.split(" ").filter(Boolean), ...names])].join(" ");
        },
        remove(...names) {
          node.className = node.className.split(" ").filter((name) => !names.includes(name)).join(" ");
        },
        toggle(name, force) {
          const enabled = force ?? !this.contains(name);
          if (enabled) this.add(name); else this.remove(name);
        },
        contains(name) { return node.className.split(" ").includes(name); },
      },
      append(...children) {
        for (const child of children) {
          child.parentElement = node;
          child.parentNode = node;
          node.children.push(child);
        }
      },
      prepend(...children) {
        for (const child of [...children].reverse()) {
          child.parentElement = node;
          child.parentNode = node;
          node.children.unshift(child);
        }
      },
      replaceChildren(...children) {
        node.children = [];
        node.append(...children);
      },
      remove() {
        const siblings = node.parentElement?.children;
        const index = siblings?.indexOf(node) ?? -1;
        if (index >= 0) siblings.splice(index, 1);
      },
      addEventListener(type, listener) {
        const entries = listeners.get(type) ?? [];
        entries.push(listener);
        listeners.set(type, entries);
      },
      removeEventListener(type, listener) {
        const entries = listeners.get(type) ?? [];
        const index = entries.indexOf(listener);
        if (index >= 0) entries.splice(index, 1);
      },
      dispatchEvent(event) {
        event.target ??= node;
        event.currentTarget = node;
        event.cancelBubble ??= false;
        event.defaultPrevented ??= false;
        event.stopPropagation ??= () => { event.cancelBubble = true; };
        event.preventDefault ??= () => { event.defaultPrevented = true; };
        for (const listener of [...(listeners.get(event.type) ?? [])]) listener.call(node, event);
        if (!event.cancelBubble) node.parentElement?.dispatchEvent(event);
        return !event.defaultPrevented;
      },
      setAttribute(name, value) { node.attributes.set(name, String(value)); },
      getAttribute(name) { return node.attributes.get(name) ?? null; },
      removeAttribute(name) { node.attributes.delete(name); },
      querySelector(selector) {
        if (selector === 'button[type="submit"]') return make("button");
        if (selector === "header") return node.children.find((child) => child.tagName === "HEADER") ?? null;
        return null;
      },
      querySelectorAll() { return []; },
      closest() { return undefined; },
      focus() {},
      blur() {},
      getContext(kind) { return kind === "2d" ? fakeContext() : null; },
      getBoundingClientRect() {
        return node.boundingRect ?? {
          left: 0, top: 0, width: node.clientWidth, height: node.clientHeight,
          right: node.clientWidth, bottom: node.clientHeight,
        };
      },
    };
    return node;
  };
  document = {
    createElement: make,
    createElementNS: (_namespace, tag) => make(tag),
    createTextNode: (text) => ({ textContent: text }),
    createDocumentFragment: () => make("fragment"),
    body: make("body"),
    head: make("head"),
    documentElement: make("html"),
    getElementById(id) {
      let node = byId.get(id);
      if (!node) {
        node = make("div");
        node.id = id;
        byId.set(id, node);
      }
      return node;
    },
    querySelector() { return make("div"); },
    querySelectorAll() { return []; },
    addEventListener() {},
    removeEventListener() {},
  };
  return document;
}

function mapArea(id, mapId, areaId, name, [left, right, top, bottom]) {
  return {
    id, mapId, areaId, name, left, right, top, bottom,
    displayMapId: -1, defaultDungeonFloor: 0, parentWorldMapId: 0,
  };
}

function descendant(root, predicate) {
  if (predicate(root)) return root;
  for (const child of root.children ?? []) {
    const found = descendant(child, predicate);
    if (found) return found;
  }
  return undefined;
}

globalThis.document = fakeDocument();
globalThis.location = { protocol: "http:", hostname: "127.0.0.1", origin: "http://127.0.0.1:5173" };
globalThis.window = {
  addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
  devicePixelRatio: 1, innerWidth: 1280, innerHeight: 720,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
};
globalThis.localStorage = globalThis.window.localStorage;
globalThis.matchMedia = globalThis.window.matchMedia;
globalThis.HTMLElement = class {};
globalThis.Element = class {};

const { usePanelHost } = await import("../dist/code/browser/ui/Widgets.js");
const viewport = document.createElement("div");
usePanelHost({ viewport, attach() {} });

const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { game } = await import("../dist/code/browser/game/Context.js");
const { WorldMapHierarchy } = await import("../dist/code/browser/ui/WorldMapHierarchy.js");
const { toggleWorldMap } = await import("../dist/code/browser/ui/WorldMap.js");

const continent = mapArea(14, 0, 0, "Azeroth", [18171, -22569, 11176, -15973]);
const elwynn = mapArea(30, 0, 12, "Elwynn", [1535, -1935, -7939, -10254]);
const tirisfal = mapArea(20, 0, 85, "Tirisfal", [3033.333, -1485.416, 3837.499, 824.999]);
const westernPlaguelands = mapArea(22, 0, 28, "WesternPlaguelands", [416.666, -3883.333, 3366.666, 499.999]);
const hierarchy = new WorldMapHierarchy({
  areas: [
    { id: 12, parentId: 0, mapId: 0, name: "Элвиннский лес" },
    { id: 85, parentId: 0, mapId: 0, name: "Тирисфальские леса" },
    { id: 28, parentId: 0, mapId: 0, name: "Западные Чумные земли" },
  ],
  maps: [{ id: 0, name: "Восточные королевства" }],
  mapAreas: [continent, elwynn, tirisfal, westernPlaguelands],
  continents: [{
    id: 1, mapId: 0, left: 26, right: 44, top: 8, bottom: 60,
    offsetX: 16.875, offsetY: -1.5, scale: 0.7, worldMapId: 1,
  }],
  transforms: [],
});

let zoneHit = { status: "unavailable" };
game.areas = {
  ready: true,
  worldMapHierarchy: () => hierarchy,
  worldMapAreaAt: () => zoneHit,
  worldMapZoneMapRevision: 0,
  mapAreaOfArea: () => undefined,
  continentMapArea: (mapId) => mapId === 0 ? continent : undefined,
  overlaysOf: () => [],
};
const playerFields = new Map([
  [UPDATE_FIELDS.PLAYER_QUEST_LOG_1_1.offset, 77],
  [UPDATE_FIELDS.PLAYER_QUEST_LOG_1_1.offset + 1, 0],
  [UPDATE_FIELDS.PLAYER_QUEST_LOG_1_1.offset + 2, 3],
]);
game.world = {
  mapId: 0,
  state: {
    selfGuid: 1n,
    objects: new Map([[1n, {
      guid: 1n, typeId: 4, fields: playerFields,
      position: { x: 0, y: 0, z: 0, orientation: 0 },
    }]]),
  },
  questTemplates: new Map([[77, {
    questId: 77, title: "Волки у ворот", objectives: [
      { entry: 299, count: 10, gameObject: false, itemDrop: 0, text: "" },
    ],
    itemObjectives: [],
  }]]),
  questPoi: new Map([[77, [{
    index: 10, objectiveIndex: 0, map: 0, worldMapAreaId: 14, floor: 0,
    points: [{ x: 500, y: 500 }, { x: 500, y: -500 }, { x: -500, y: 0 }],
  }]]]),
  creatureTemplates: new Map([[299, { name: "Лесной волк" }]]),
  gameObjectTemplates: new Map(),
  itemTemplates: new Map(),
};

test("world-map mouse controls use the painted CSS rectangle", () => {
  toggleWorldMap();
  const panel = descendant(viewport, (node) => node.id === "world-map");
  const canvas = descendant(panel, (node) => node.className === "world-map-canvas");
  const picker = descendant(panel, (node) => node.className === "world-map-picker");
  assert.ok(panel && canvas && picker);
  assert.equal(picker.value, "area:14");

  // The canvas is intrinsically 1002×668, while CSS paints it at half size and away from (0,0).
  // A click converted through intrinsic pixels, or without subtracting the CSS offset, misses Elwynn.
  canvas.boundingRect = { left: 137, top: 83, width: 501, height: 334, right: 638, bottom: 417 };
  const target = hierarchy.targets(hierarchy.node("area:14"))
    .find((entry) => entry.node.key === "area:30");
  assert.ok(target);
  const u = target.rect.left + target.rect.width / 2;
  const v = target.rect.top + target.rect.height / 2;
  const click = {
    type: "click", button: 0,
    clientX: canvas.boundingRect.left + u * canvas.boundingRect.width,
    clientY: canvas.boundingRect.top + v * canvas.boundingRect.height,
  };
  canvas.dispatchEvent(click);
  assert.equal(picker.value, "area:30", "left-click opens the child under the scaled canvas point");
  assert.equal(click.cancelBubble, true, "a handled map click does not leak into the window below it");

  const contextmenu = { type: "contextmenu", button: 2, clientX: 0, clientY: 0 };
  canvas.dispatchEvent(contextmenu);
  assert.equal(contextmenu.defaultPrevented, true, "the browser menu must not cover right-click navigation");
  assert.equal(contextmenu.cancelBubble, true, "right-click navigation is consumed by the map");
  assert.equal(picker.value, "area:14", "right-click returns to the authored parent");

  // A loaded authored ocean/empty cell is a complete answer. It must not fall back to a rectangle
  // which happens to cover the point.
  zoneHit = { status: "ready", areaId: 0 };
  canvas.dispatchEvent({ ...click, type: "click", cancelBubble: false, defaultPrevented: false });
  assert.equal(picker.value, "area:14", "authored ocean suppresses rectangular fallback");

  // This is the real stock overlap that motivated the ZMP path. The smaller WPL rectangle wins the
  // old bbox heuristic, but the original hit map names sub-area 168 and AreaClient resolves it to
  // Tirisfal. WorldMap must use that authored result.
  const tirisfalTarget = hierarchy.targets(hierarchy.node("area:14"))
    .find((entry) => entry.node.key === "area:20");
  const westernTarget = hierarchy.targets(hierarchy.node("area:14"))
    .find((entry) => entry.node.key === "area:22");
  assert.ok(tirisfalTarget && westernTarget);
  const overlapLeft = Math.max(tirisfalTarget.rect.left, westernTarget.rect.left);
  const overlapRight = Math.min(
    tirisfalTarget.rect.left + tirisfalTarget.rect.width,
    westernTarget.rect.left + westernTarget.rect.width,
  );
  const overlapTop = Math.max(tirisfalTarget.rect.top, westernTarget.rect.top);
  const overlapBottom = Math.min(
    tirisfalTarget.rect.top + tirisfalTarget.rect.height,
    westernTarget.rect.top + westernTarget.rect.height,
  );
  assert.ok(overlapRight > overlapLeft && overlapBottom > overlapTop);
  zoneHit = { status: "ready", areaId: 168, mapArea: tirisfal };
  canvas.dispatchEvent({
    type: "click", button: 0,
    clientX: canvas.boundingRect.left + (overlapLeft + overlapRight) / 2 * canvas.boundingRect.width,
    clientY: canvas.boundingRect.top + (overlapTop + overlapBottom) / 2 * canvas.boundingRect.height,
  });
  assert.equal(picker.value, "area:20", "authored ZMP result wins the overlapping bbox guess");
  canvas.dispatchEvent({ type: "contextmenu", button: 2, clientX: 0, clientY: 0 });
  assert.equal(picker.value, "area:14");
  zoneHit = { status: "unavailable" };
});

test("quest pin and objective-list clicks cannot fall through to map navigation", () => {
  const panel = descendant(viewport, (node) => node.id === "world-map");
  const picker = descendant(panel, (node) => node.className === "world-map-picker");
  const stage = descendant(panel, (node) => node.classList?.contains("world-map-stage"));
  const markerLayer = descendant(panel, (node) => node.classList?.contains("world-map-marker-layer"));
  const questPin = descendant(panel, (node) => node.classList?.contains("world-map-quest-pin"));
  const objectives = descendant(panel, (node) => node.classList?.contains("world-map-objectives"));
  assert.ok(panel && picker && stage && markerLayer && questPin && objectives,
    "the real map stage, quest pin and objective list must participate in the interaction test");
  assert.equal(picker.value, "area:14");

  // Quest rows/icons are controls above/beside the canvas. Their clicks must stay on that surface
  // even when they visually overlap a clickable region at a narrow layout.
  const pinClick = { type: "click", button: 0, clientX: 300, clientY: 200 };
  questPin.dispatchEvent(pinClick);
  assert.equal(pinClick.cancelBubble, true, "a quest pin consumes its click before map navigation");
  const objectiveControl = descendant(objectives, (node) => node.tagName === "BUTTON") ?? objectives;
  const objectiveClick = { type: "click", button: 0, clientX: 300, clientY: 200 };
  objectiveControl.dispatchEvent(objectiveClick);
  assert.equal(objectiveClick.cancelBubble, true, "the objective legend consumes its click before map navigation");
  assert.equal(picker.value, "area:14", "quest-marker and legend interaction cannot fall through to the map");
});
