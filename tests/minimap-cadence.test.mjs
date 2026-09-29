import assert from "node:assert/strict";
import test from "node:test";

// The minimap is a canvas repaint, so "nothing changed" is worth a frame only because it is cheap
// to ask. These stubs answer just enough of the page for the real `updateMinimap` to run: the
// draw count is what proves whether the repaint happened.

let draws = 0;
const paintColours = [];
const context = {
  setTransform() {}, clearRect() { draws++; }, save() {}, restore() {}, translate() {},
  rotate() {}, beginPath() {}, arc() {}, clip() {}, fillRect() {}, drawImage() {},
  fill() { paintColours.push(this.fillStyle); }, stroke() {}, strokeText() {}, fillText() {}, moveTo() {}, lineTo() {}, closePath() {},
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
const { fieldIndex } = await import("../dist/code/world/Fields.js");
const { addMinimapPing, forgetMinimap, setMinimapRotation, updateMinimap } =
  await import("../dist/code/browser/ui/Minimap.js");

function world() {
  const self = { guid: 1n, typeId: 4, position: { x: 100, y: 200, z: 30, orientation: 0.5 }, fields: new Map() };
  return {
    mapId: 0,
    state: {
      selfGuid: 1n,
      revision: 0,
      objects: new Map([[1n, self]]),
      self,
    },
    questPoi: new Map(),
    currentGameTime: () => undefined,
  };
}

test("a still minimap repaints on its own clock, and anything moving asks immediately", () => {
  const current = world();
  const self = current.state.objects.get(1n);
  game.world = current;
  forgetMinimap();

  updateMinimap(0);
  const drawn = draws;
  assert.equal(drawn, 1, "the first frame paints");

  updateMinimap(1);
  assert.equal(draws, drawn, "a still frame does not repaint the canvas");

  // The character moving is the one thing a minimap must follow without a tick of lag.
  self.position.x += 1;
  updateMinimap(2);
  assert.equal(draws, drawn + 1, "moving repaints at once");

  updateMinimap(3);
  assert.equal(draws, drawn + 1, "and then stands still again");

  // The world changing under a standing character still has to reach the map, the moment it moves
  // something the map draws. A state change that moves nothing on the circle — in a crowd, every
  // packet about every neighbour — repaints nothing.
  current.state.revision += 1;
  updateMinimap(3.5);
  assert.equal(draws, drawn + 1, "a state change that moves no blip does not repaint");
  current.targetGuid = 2n;
  current.state.objects.set(2n, { guid: 2n, typeId: 3, position: { x: 120, y: 200, z: 30, orientation: 0 }, fields: new Map() });
  current.state.revision += 1;
  updateMinimap(3.75);
  assert.equal(draws, drawn + 2, "a blip appearing repaints at once");
  current.state.objects.get(2n).position = { x: 121, y: 200, z: 30, orientation: 0 };
  current.state.revision += 1;
  updateMinimap(4);
  assert.equal(draws, drawn + 3, "a blip moving repaints at once");
  current.targetGuid = undefined;
  current.state.objects.delete(2n);
  current.state.revision += 1;
  updateMinimap(4);
  assert.equal(draws, drawn + 4, "and so does one going away");

  // ...and so does the clock, at its own much lower rate.
  updateMinimap(4 + 40);
  assert.equal(draws, drawn + 4, "the idle clock has not come round yet");
  updateMinimap(4 + 200);
  assert.equal(draws, drawn + 5, "the idle clock keeps the map honest");

  // The wheel and the rotation toggle are part of what the map shows.
  const before = draws;
  setMinimapRotation(true);
  updateMinimap(4 + 201);
  assert.equal(draws, before + 1, "rotating the map repaints at once");
  setMinimapRotation(false);

  // A ping animates for five seconds and must not be frozen by the idle rate.
  const beforePing = draws;
  addMinimapPing(100, 200, 4 + 202);
  updateMinimap(4 + 203);
  assert.equal(draws, beforePing + 1, "a ping paints at once");
  updateMinimap(4 + 204);
  assert.equal(draws, beforePing + 2, "and keeps animating while it lives");
  game.world = undefined;
  forgetMinimap();
});

test("a crowded minimap visits world objects once per repaint with tracking active", () => {
  const current = world();
  const self = current.state.objects.get(1n);
  self.fields.set(fieldIndex("PLAYER_TRACK_CREATURES"), 1);
  for (let index = 2; index <= 1_000; index++) {
    const guid = BigInt(index);
    current.state.objects.set(guid, {
      guid, typeId: 3,
      position: { x: 100 + index, y: 200, z: 30, orientation: 0 },
      fields: new Map(),
    });
  }
  let scans = 0;
  const values = current.state.objects.values;
  current.state.objects.values = function () {
    scans++;
    return values.call(this);
  };
  game.world = current;
  forgetMinimap();
  updateMinimap(0);
  assert.equal(scans, 1, "loot, quest and tracking markers share one object-table traversal");
  game.world = undefined;
  forgetMinimap();
});

test("tracked corpse keeps its loot dot under its tracking ring", async () => {
  const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
  const current = world();
  const self = current.state.objects.get(1n);
  self.fields.set(fieldIndex("PLAYER_TRACK_CREATURES"), 1);
  const corpse = {
    guid: 2n, typeId: 3,
    position: { x: 101, y: 200, z: 30, orientation: 0 },
    fields: new Map([
      [UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 0],
      [UPDATE_FIELDS.UNIT_DYNAMIC_FLAGS.offset, 1],
    ]),
  };
  current.state.objects.set(corpse.guid, corpse);
  game.world = current;
  game.creatureMetadata = { get: () => ({ type: 1 }) };
  paintColours.length = 0;
  forgetMinimap();
  updateMinimap(0);
  assert.deepEqual(paintColours.slice(0, 3), ["#b4e650", "#f2a63b", "#62e7a3"]);
  game.creatureMetadata = undefined;
  game.world = undefined;
  forgetMinimap();
});
