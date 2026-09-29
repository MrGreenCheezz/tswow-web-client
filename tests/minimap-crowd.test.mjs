import assert from "node:assert/strict";
import test from "node:test";

// The minimap's key used to carry the state's revision, which every packet about anybody moves: in
// a crowd the circle was repainted every frame for neighbours far outside it. The blips are the
// state's whole contribution to the picture, so they are what is compared now.

let draws = 0;
const context = {
  setTransform() {}, clearRect() { draws++; }, save() {}, restore() {}, translate() {},
  rotate() {}, beginPath() {}, arc() {}, clip() {}, fillRect() {}, drawImage() {},
  fill() {}, stroke() {}, strokeText() {}, fillText() {}, moveTo() {}, lineTo() {}, closePath() {},
  createLinearGradient: () => ({ addColorStop() {} }),
  measureText: () => ({ width: 10 }),
  fillStyle: "", strokeStyle: "", lineWidth: 1, font: "", textAlign: "", textBaseline: "",
  imageSmoothingEnabled: true,
};

const fakeNode = () => {
  const node = {
    children: [], dataset: {}, className: "", textContent: "", hidden: false, disabled: false,
    value: "", type: "", title: "", tabIndex: 0,
    style: { setProperty() {}, removeProperty() {}, getPropertyValue: () => "" },
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    append() {}, appendChild(child) { return child; }, insertBefore(child) { return child; },
    replaceChildren() {}, remove() {},
    addEventListener() {}, removeEventListener() {}, setAttribute() {}, getAttribute() { return null; },
    querySelector: () => fakeNode(), querySelectorAll: () => [],
  };
  return node;
};

const canvas = () => {
  const node = fakeNode();
  node.clientWidth = 160;
  node.width = 160;
  node.height = 160;
  node.getContext = (kind) => (kind === "2d" ? context : null);
  return node;
};

globalThis.location = { protocol: "http:", hostname: "127.0.0.1", origin: "http://127.0.0.1:5173" };
globalThis.window = {
  addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1,
  innerWidth: 1280, innerHeight: 800,
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
const { forgetMinimap, updateMinimap } = await import("../dist/code/browser/ui/Minimap.js");

test("a crowd moving outside the circle repaints nothing; a body inside it moving does", () => {
  const self = { guid: 1n, typeId: 4, position: { x: 0, y: 0, z: 0, orientation: 0 }, fields: new Map() };
  const objects = new Map([[1n, self]]);
  // Three hundred players far outside the 266-yard circle, walking every frame.
  for (let index = 0; index < 300; index += 1) {
    objects.set(BigInt(100 + index), { guid: BigInt(100 + index), typeId: 4, position: { x: 2000 + index, y: 0, z: 0, orientation: 0 }, fields: new Map() });
  }
  // One lootable corpse inside the circle: a blip.
  const corpse = {
    guid: 50n, typeId: 3, position: { x: 30, y: 0, z: 0, orientation: 0 },
    fields: new Map([[UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 0], [UPDATE_FIELDS.UNIT_DYNAMIC_FLAGS.offset, 1]]),
  };
  objects.set(50n, corpse);
  const world = {
    mapId: 0, state: { selfGuid: 1n, revision: 0, objects }, questPoi: new Map(),
    currentGameTime: () => undefined,
  };
  game.world = world;
  forgetMinimap();
  let now = 0;
  updateMinimap(now);
  const first = draws;
  for (let frame = 1; frame <= 5; frame += 1) {
    for (const [guid, object] of objects) if (guid >= 100n) object.position = { ...object.position, x: object.position.x + 1 };
    world.state.revision += 1;
    now += 16;
    updateMinimap(now);
  }
  assert.equal(draws, first, "five crowd frames inside the idle interval, no repaint");
  corpse.position = { ...corpse.position, y: 5 };
  world.state.revision += 1;
  now += 1;
  updateMinimap(now);
  assert.equal(draws, first + 1, "the one dot on the map moved: repainted at once");
  game.world = undefined;
  forgetMinimap();
});
