import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as THREE from "three";

// 11.02-tails: the overlays of a seated vehicle passenger follow its model to the seat point
// (browser/VehiclePassengerOverlay.ts, written by browser/VehiclePassengerPose.ts), and a passenger a
// HIDE_PASSENGER seat hides has no click box. Wow.exe 3.3.5a, Ghidra read-only
// (.runtime/re-2026-10-03/l1102tails): the name plate is projected from the drawn model's name point
// (0x00715720 → vtable +0x20 = 0x0071fef0 → 0x00831330), the pick list holds only objects the world
// frame drew (0x004f8d10 skips a unit whose render query 0x00730f30 says hidden), the plate gate
// 0x0072b060 and Tab 0x00524440 never ask the render query.

/** A document whose overlay layer and elements persist per id (HeadOverlay builds its layer at run time). */
function fakeDocument() {
  const byId = new Map();
  const make = (tag) => {
    const node = {
      tagName: String(tag).toUpperCase(), children: [], dataset: {}, className: "", textContent: "",
      hidden: false, id: "", isConnected: true,
      style: { setProperty(name, value) { this[name] = value; }, removeProperty(name) { delete this[name]; } },
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      append(...nodes) { node.children.push(...nodes); },
      replaceChildren(...nodes) { node.children = [...nodes]; },
      remove() {}, addEventListener() {}, removeEventListener() {},
      setAttribute(name, value) { node[name] = value; }, getAttribute(name) { return node[name] ?? null; },
      removeAttribute(name) { delete node[name]; },
      querySelector() { return make("div"); }, querySelectorAll() { return []; },
      getBoundingClientRect() { return { x: 0, y: 0, width: 1280, height: 720, top: 0, left: 0, right: 1280, bottom: 720 }; },
      getContext() { return null; },
    };
    return node;
  };
  return {
    createElement: make, createElementNS: (_namespace, tag) => make(tag),
    createTextNode: (text) => ({ textContent: text }), body: make("body"), head: make("head"),
    getElementById(id) {
      let node = byId.get(id);
      if (!node) { node = make("div"); node.id = id; byId.set(id, node); }
      return node;
    },
    querySelector() { return make("div"); }, querySelectorAll() { return []; },
    addEventListener() {}, removeEventListener() {},
  };
}

globalThis.document = fakeDocument();
globalThis.location = { protocol: "http:", hostname: "127.0.0.1", origin: "http://127.0.0.1:5173" };
globalThis.window = {
  addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1, innerWidth: 1280, innerHeight: 720,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
};
globalThis.localStorage = globalThis.window.localStorage;
globalThis.matchMedia = globalThis.window.matchMedia;
globalThis.requestAnimationFrame = () => 0;
globalThis.HTMLElement = class {};

const {
  beginSeatDrawnFrame, drawnUnitPosition, hiddenBySeat, seatDrawnRecord, seatDrawnRecordOf,
} = await import("../dist/code/browser/VehiclePassengerOverlay.js");
const { VehiclePassengerPoser } = await import("../dist/code/browser/VehiclePassengerPose.js");
const { M2_TO_SCENE } = await import("../dist/code/browser/AnimatedModel.js");
const {
  VEHICLE_CATALOG_VERSION, VEHICLE_COLUMN, VEHICLE_FORMAT, VEHICLE_SEAT_COLUMN, VEHICLE_SEAT_FORMAT, vehicleCatalogFrom,
} = await import("../dist/code/world/VehicleDbc.js");
const { VEHICLE_SEAT_FLAGS } = await import("../dist/code/world/VehicleSeatModel.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { SimpleScene, createCamera, projectPoint } = await import("../dist/code/browser/SimpleScene.js");
const { plateLayout, RANK_NORMAL } = await import("../dist/code/browser/NamePlate.js");
const { REACTION_HOSTILE } = await import("../dist/code/world/FactionRules.js");
const { game, cameraPivotHeight } = await import("../dist/code/browser/game/Context.js");
const { resetHeadOverlay, showChatBubble, updateHeadOverlay } = await import("../dist/code/browser/ui/HeadOverlay.js");
const { inSightFromCamera } = await import("../dist/code/browser/game/Targeting.js");

const F = VEHICLE_SEAT_FLAGS;
const EPS = 1e-6;
const near = (actual, expected, message, eps = EPS) =>
  assert.ok(Math.abs(actual - expected) <= eps, `${message}: ${actual} vs ${expected}`);

// ---- the synthetic vehicle tables of vehicle-passenger-pose.test.mjs, cut down ------------------

function vehicleRow({ id, seats = [] }) {
  const row = [...VEHICLE_FORMAT].map((kind) => (kind === "s" ? "" : 0));
  row[VEHICLE_COLUMN.ID] = id;
  seats.forEach((seat, slot) => { row[VEHICLE_COLUMN.SeatID + slot] = seat; });
  return row;
}
function seatRow({ id, flags = 0, attachmentId = -1, offset = [0, 0, 0], ride = [-1, -1] }) {
  const C = VEHICLE_SEAT_COLUMN;
  const row = [...VEHICLE_SEAT_FORMAT].map(() => 0);
  for (const column of [C.EnterAnimStart, C.EnterAnimLoop, C.ExitAnimStart, C.ExitAnimLoop, C.ExitAnimEnd,
    C.VehicleEnterAnim, C.VehicleExitAnim, C.VehicleRideAnimLoop, C.RideUpperAnimStart, C.RideUpperAnimLoop]) row[column] = -1;
  row[C.ID] = id;
  row[C.Flags] = flags;
  row[C.AttachmentID] = attachmentId;
  [row[C.AttachmentOffsetX], row[C.AttachmentOffsetY], row[C.AttachmentOffsetZ]] = offset;
  [row[C.RideAnimStart], row[C.RideAnimLoop]] = ride;
  row[C.PassengerAttachmentID] = -1;
  return row;
}

const ENGINE_VEHICLE = 117;
const MAMMOTH_VEHICLE = 312;
const DRIVER_SEAT = 1648;
const HIDDEN_SEAT = 1649;
const MAMMOTH_SEAT = 2764;
const catalog = vehicleCatalogFrom({
  version: VEHICLE_CATALOG_VERSION,
  vehicles: [
    vehicleRow({ id: ENGINE_VEHICLE, seats: [DRIVER_SEAT, HIDDEN_SEAT] }),
    vehicleRow({ id: MAMMOTH_VEHICLE, seats: [0, MAMMOTH_SEAT] }),
  ],
  seats: [
    seatRow({ id: DRIVER_SEAT, flags: F.HAS_LOWER_ANIM_FOR_RIDE, attachmentId: 13, offset: [0.2, 0, 0], ride: [-1, 91] }),
    // The 18 of the dataset: HIDE_PASSENGER without PASSENGER_NOT_SELECTABLE (siege seat 1649 style).
    seatRow({ id: HIDDEN_SEAT, flags: F.HAS_LOWER_ANIM_FOR_RIDE | F.HIDE_PASSENGER, attachmentId: 14, ride: [-1, 102] }),
    // A Traveler's Tundra Mammoth seat: offset 0,0,0 — the server puts the passenger in the beast.
    seatRow({ id: MAMMOTH_SEAT, flags: 0xde00800b, attachmentId: 14, ride: [-1, 91] }),
  ],
  indicators: [],
  indicatorSeats: [],
});

const SELF = 1n;
const MAMMOTH_OWNER = 2n;
const FRIEND = 3n;
const ENGINE = 0xf150_0000_0000_0042n;
const CREW = 5n;
const WALKER = 6n;
const SHIP = 0x1fc0_0000_0000_0104n;
const DECKHAND = 7n;

function object(guid, { typeId = 4, vehicleId, carrier, seat = 0, x = 0, y = 0, z = 0 } = {}) {
  const fields = new Map([
    [UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 100],
    [UPDATE_FIELDS.UNIT_FIELD_MAXHEALTH.offset, 100],
  ]);
  return {
    guid, typeId, vehicleId, fields, movementFlags: 0, position: { x, y, z, orientation: 0 },
    transport: carrier === undefined ? undefined : { guid: carrier, x: 0, y: 0, z: 0, orientation: 0, seat },
  };
}

/** One bone under the M2 quarter turn, in a node at scene `at` (scene = world x, z, −y). */
function rig({ at = [0, 0, 0], facing = 0, attachments = [] } = {}) {
  const node = new THREE.Group();
  node.position.set(...at);
  node.rotation.y = facing;
  const root = new THREE.Object3D();
  root.quaternion.copy(M2_TO_SCENE);
  node.add(root);
  const bone = new THREE.Bone();
  bone.position.set(1, 0, 2);
  root.add(bone);
  return { node, scale: 1, root, skinned: { skeleton: { bones: [bone] } }, template: { pivots: new Float32Array([1, 0, 2]) }, wvm: { attachments } };
}
function passengerRig(at) {
  const node = new THREE.Group();
  node.position.set(...at);
  return { node, scale: 1, wvm: { attachments: [] } };
}
function placeDrawn(poser, objects, guids, units) {
  const admitted = guids.filter((guid) => objects.has(guid)).map((guid) => ({ value: objects.get(guid) }));
  poser.place(admitted, new Set(guids), units);
}
/** A mammoth owner at world (15, 0, 0) and a friend on its VehicleSeat2 (its own place a little off), both drawn. */
/** Where `#drawUnit` puts the friend's node before the seat moves it: world (15, 2, 0.5) in scene axes. */
const FRIEND_OWN_PLACE = [15, 0.5, -2];
function mammothFrame(poser = new VehiclePassengerPoser()) {
  const owner = object(MAMMOTH_OWNER, { vehicleId: MAMMOTH_VEHICLE, x: 15 });
  const friend = object(FRIEND, { carrier: MAMMOTH_OWNER, seat: 1, x: 15, y: 2, z: 0.5 });
  const walker = object(WALKER, { typeId: 3, x: 15, y: 6 });
  const objects = new Map([[MAMMOTH_OWNER, owner], [FRIEND, friend], [WALKER, walker]]);
  const rider = rig({ at: [15, 0, 0], facing: 0.3 });
  const mammoth = rig({ attachments: [{ id: 40, bone: 0, position: [-0.5, 0.8, 4.2] }] });
  rider.node.add(mammoth.node);
  const units = new Map([
    [MAMMOTH_OWNER, { ...rider, mount: { skinned: mammoth.skinned, template: mammoth.template, wvm: mammoth.wvm } }],
    [FRIEND, passengerRig(FRIEND_OWN_PLACE)],
    [WALKER, passengerRig([15, 0, -6])],
  ]);
  poser.begin(objects, catalog);
  placeDrawn(poser, objects, [MAMMOTH_OWNER, FRIEND, WALKER], units);
  return { owner, friend, walker, objects, units, poser };
}

// ---- the record the poser leaves --------------------------------------------------------------

test("11.02-tails: a passenger drawn on its seat point hangs its overlays there; everyone else keeps its own position object", () => {
  const { owner, friend, walker, units } = mammothFrame();
  const node = units.get(FRIEND).node.position;
  const out = { x: NaN, y: NaN, z: NaN };
  const drawn = drawnUnitPosition(friend, out);
  // Scene (x, y, z) is world (x, −z… ): world x = scene x, world y = −scene z, world z = scene y.
  near(drawn.x, node.x, "x follows the model");
  near(drawn.y, -node.z, "y follows the model");
  near(drawn.z, node.y, "z follows the model — up on the mammoth's back");
  assert.ok(node.y > 3, `the seat point is up on the beast (${node.y})`);
  assert.equal(drawn === out, true, "written into the caller's scratch");
  assert.equal(friend.position.z, 0.5, "the unit's own place is not touched");
  assert.equal(hiddenBySeat(friend), false, "a mammoth seat shows its passenger");
  // The vehicle and a unit on foot: their own position objects, no copy, no record.
  assert.equal(drawnUnitPosition(owner, out) === owner.position, true, "the vehicle itself");
  assert.equal(drawnUnitPosition(walker, out) === walker.position, true, "an ordinary unit");
  assert.equal(seatDrawnRecordOf(walker), undefined);
  assert.equal(hiddenBySeat(walker), false);
});

test("11.02-tails: a record lasts until the next frame — a passenger that left its seat reads as on foot", () => {
  const { friend, objects, units, poser } = mammothFrame();
  const out = { x: 0, y: 0, z: 0 };
  assert.notEqual(drawnUnitPosition(friend, out) === friend.position, true, "seated this frame");
  // It gets off: no transport any more — at once, before the next frame is drawn — and the next
  // frame does not place it.
  friend.transport = undefined;
  assert.equal(drawnUnitPosition(friend, out) === friend.position, true, "off the seat between two frames");
  units.get(FRIEND).node.position.set(...FRIEND_OWN_PLACE);
  placeDrawn(poser, objects, [MAMMOTH_OWNER, FRIEND], units);
  assert.equal(drawnUnitPosition(friend, out) === friend.position, true, "back on its own place");
  // Back on the seat; then a frame that does not draw the mammoth: seated, but at its own place.
  friend.transport = { guid: MAMMOTH_OWNER, x: 0, y: 0, z: 0, orientation: 0, seat: 1 };
  placeDrawn(poser, objects, [MAMMOTH_OWNER, FRIEND], units);
  assert.notEqual(drawnUnitPosition(friend, out) === friend.position, true);
  units.get(FRIEND).node.position.set(...FRIEND_OWN_PLACE);
  placeDrawn(poser, objects, [FRIEND], units);
  assert.equal(drawnUnitPosition(friend, out) === friend.position, true, "the vehicle not drawn: no step left over");
  assert.equal(seatDrawnRecordOf(friend) !== undefined, true, "still a seated passenger");
  // Back on the seat point, then a frame without the vehicle tables: nothing is seated.
  placeDrawn(poser, objects, [MAMMOTH_OWNER, FRIEND], units);
  assert.notEqual(drawnUnitPosition(friend, out) === friend.position, true);
  poser.begin(objects, undefined);
  placeDrawn(poser, objects, [MAMMOTH_OWNER, FRIEND], units);
  assert.equal(drawnUnitPosition(friend, out) === friend.position, true, "no tables, no seat");
  // A record written by hand is stale once a frame begins.
  const record = seatDrawnRecord(friend, true);
  record.z = 2;
  assert.equal(hiddenBySeat(friend), true);
  beginSeatDrawnFrame();
  assert.equal(hiddenBySeat(friend), false);
  assert.equal(seatDrawnRecordOf(friend), undefined);
});

test("11.02-tails: HIDE_PASSENGER marks the passenger hidden, built or not; a ship's deckhand is nobody's passenger", () => {
  const engineObject = object(ENGINE, { typeId: 3, vehicleId: ENGINE_VEHICLE, x: 30 });
  const crew = object(CREW, { carrier: ENGINE, seat: 1, x: 30 });
  const driver = object(SELF, { carrier: ENGINE, seat: 0, x: 30 });
  const deckhand = object(DECKHAND, { carrier: SHIP, seat: 0, x: 40 });
  const objects = new Map([[ENGINE, engineObject], [CREW, crew], [SELF, driver], [DECKHAND, deckhand]]);
  const engine = rig({ at: [30, 0, 0], attachments: [] });
  const poser = new VehiclePassengerPoser();
  poser.begin(objects, catalog);
  // The crew member's model is not built yet: the seat still hides it.
  placeDrawn(poser, objects, [ENGINE, CREW, SELF, DECKHAND], new Map([[ENGINE, engine], [SELF, passengerRig([30, 0, 0])]]));
  assert.equal(hiddenBySeat(crew), true, "0x00730f30 hides whatever sits in a HIDE seat");
  assert.equal(hiddenBySeat(driver), false, "the driver's seat does not hide");
  assert.equal(hiddenBySeat(deckhand), false, "a ship is not a vehicle (0x0074b8b0)");
  const out = { x: 0, y: 0, z: 0 };
  assert.equal(drawnUnitPosition(crew, out) === crew.position, true, "no point on the model: its own place");
  // Built: hidden as well, and the record is the same object frame after frame.
  const units = new Map([[ENGINE, engine], [CREW, passengerRig([30, 0, 0])]]);
  placeDrawn(poser, objects, [ENGINE, CREW], units);
  const first = seatDrawnRecordOf(crew);
  placeDrawn(poser, objects, [ENGINE, CREW], units);
  assert.equal(seatDrawnRecordOf(crew) === first, true, "one record per passenger, reused");
  assert.equal(units.get(CREW).node.visible, false);
  assert.equal(hiddenBySeat(crew), true);
});

// ---- the canvas overlay: click boxes and plates ---------------------------------------------------

const WIDTH = 1280;
const HEIGHT = 720;
const BODY = 2;

function plateData(guid) {
  return {
    guid, name: "Пассажир", level: 80, reaction: REACTION_HOSTILE, classColour: undefined, health: 1,
    raidMark: undefined, questMark: undefined, rank: RANK_NORMAL, cast: undefined, target: false,
    lootable: false, tappedByOther: false,
  };
}

/** One `SimpleScene.draw` with WebGL alive (no painted world), plates for `plated` only. */
function sceneFrame(objects, plated = new Set()) {
  const context = new Proxy({
    createLinearGradient: () => ({ addColorStop() {} }),
    measureText: (text) => ({ width: text.length * 6 }),
  }, { get: (target, property) => target[property] ?? (() => {}) });
  const canvas = { width: 0, height: 0, getContext: () => context, getBoundingClientRect: () => ({ width: WIDTH, height: HEIGHT }) };
  const scene = new SimpleScene(canvas, false);
  scene.draw({ selfGuid: SELF, objects: new Map(objects.map((entry) => [entry.guid, entry])) },
    () => 0, undefined, [], undefined, 0, undefined, undefined, () => BODY,
    (entry) => (plated.has(entry.guid) ? plateData(entry.guid) : undefined));
  return scene;
}

const camera = () => createCamera({ x: 0, y: 0, z: 0, orientation: 0 }, 0, undefined, undefined);
/** The middle of the body box `#pushUnitHit` lays for a living unit standing at `at`. */
function bodyCentre(at) {
  const feet = projectPoint(at, camera(), WIDTH, HEIGHT);
  const top = projectPoint({ ...at, z: at.z + BODY }, camera(), WIDTH, HEIGHT);
  return [feet.x, (top.y - 2 + feet.y + 4) / 2];
}
/** The middle of the plate hung over a unit standing at `at`. */
function plateCentre(guid, at) {
  const feet = projectPoint(at, camera(), WIDTH, HEIGHT);
  const top = projectPoint({ ...at, z: at.z + BODY }, camera(), WIDTH, HEIGHT);
  const box = plateLayout(plateData(guid), feet.x, top.y);
  return [box.x + box.width / 2, box.y + box.height / 2];
}

function seatedFrame({ hidden = false, plated = new Set() } = {}) {
  const self = object(SELF, { x: 0 });
  // Off to one side of the character, whose own box stands in the middle of the screen.
  const owner = object(MAMMOTH_OWNER, { vehicleId: MAMMOTH_VEHICLE, x: 15, y: 8 });
  const friend = object(FRIEND, { carrier: MAMMOTH_OWNER, seat: 1, x: 15, y: 8 });
  beginSeatDrawnFrame();
  // Drawn three yards up and one to the side of its server place, on the beast's back.
  const record = seatDrawnRecord(friend, hidden);
  record.y = 1;
  record.z = 3;
  return { scene: sceneFrame([self, owner, friend], plated), drawnAt: { x: 15, y: 9, z: 3 } };
}

test("11.02-tails: the click box of a seated passenger is where its model sits, not inside the vehicle", () => {
  const { scene, drawnAt } = seatedFrame();
  assert.equal(scene.pick(...bodyCentre(drawnAt)), FRIEND, "the passenger is clicked on the mammoth's back");
  assert.equal(scene.pick(...bodyCentre({ x: 15, y: 8, z: 0 })), MAMMOTH_OWNER,
    "the mammoth's own body is the mammoth again, not the passenger hidden in it");
});

test("11.02-tails: the plate of a seated passenger hangs over the model, and is a click target there", () => {
  const { scene, drawnAt } = seatedFrame({ plated: new Set([FRIEND]) });
  assert.equal(scene.pick(...plateCentre(FRIEND, drawnAt)), FRIEND);
});

test("11.02-tails: a passenger a HIDE seat hides has no body to click; its plate still selects it (0x004f8d10 vs 0x0072b060)", () => {
  const { scene, drawnAt } = seatedFrame({ hidden: true });
  assert.notEqual(scene.pick(...bodyCentre(drawnAt)), FRIEND, "nothing drawn, nothing picked");
  const plated = seatedFrame({ hidden: true, plated: new Set([FRIEND]) });
  assert.equal(plated.scene.pick(...plateCentre(FRIEND, plated.drawnAt)), FRIEND, "the plate stays, and takes the click");
  // An ordinary unit next to it: its box is where it always was.
  const walker = object(WALKER, { typeId: 3, x: 15, y: 6 });
  const ordinary = sceneFrame([object(SELF), walker]);
  assert.equal(ordinary.pick(...bodyCentre(walker.position)), WALKER);
});

// ---- bubbles and floating numbers, the sight test ---------------------------------------------------

function stubWorld(objects) {
  return {
    mapId: 0, state: { selfGuid: SELF, objects }, targetGuid: undefined, group: undefined, questPoi: new Map(),
    raidTargets: new Map(), threat: new Map(), names: new Map(), casts: new Map(), questGiverStatus: new Map(),
    castProgress: () => 0, currentGameTime: () => undefined, displayName: () => "", aurasFor: () => [],
    forcedReactions: new Map(),
  };
}

test("11.02-tails: a seated passenger's speech bubble hangs over its model on the seat", () => {
  const previous = { world: game.world, renderer: game.renderer };
  try {
    const self = object(SELF);
    const owner = object(MAMMOTH_OWNER, { vehicleId: MAMMOTH_VEHICLE, x: 15 });
    const friend = object(FRIEND, { carrier: MAMMOTH_OWNER, seat: 1, x: 15 });
    game.world = stubWorld(new Map([[SELF, self], [MAMMOTH_OWNER, owner], [FRIEND, friend]]));
    game.renderer = { unitHeight: () => BODY };
    beginSeatDrawnFrame();
    const record = seatDrawnRecord(friend, false);
    record.z = 3;
    resetHeadOverlay();
    showChatBubble(FRIEND, "Держитесь крепче!");
    updateHeadOverlay(performance.now());
    const layer = document.getElementById("world-viewport").children.at(-1);
    const node = layer.children.at(-1);
    const match = /translate\((-?\d+)px, (-?\d+)px\)$/.exec(node.style.transform);
    assert.ok(match, node.style.transform);
    const view = createCamera(self.position, game.camera.yaw, game.camera.viewPitch, game.camera.view,
      { pivotHeight: cameraPivotHeight() });
    const crown = projectPoint({ x: 15, y: 0, z: 3 + BODY }, view, 1280, 720);
    const inside = projectPoint({ x: 15, y: 0, z: BODY }, view, 1280, 720);
    assert.equal(Number(match[2]), Math.round(crown.y) - 84, "over the model's head, the bubble's 84px gap above it");
    assert.notEqual(Math.round(crown.y), Math.round(inside.y));
  } finally {
    resetHeadOverlay();
    game.world = previous.world;
    game.renderer = previous.renderer;
  }
});

test("11.02-tails: the sight line to a seated passenger aims at its drawn chest", () => {
  const previous = { world: game.world, renderer: game.renderer, collision: game.collision };
  try {
    const self = object(SELF);
    const owner = object(MAMMOTH_OWNER, { vehicleId: MAMMOTH_VEHICLE, x: 15 });
    const friend = object(FRIEND, { carrier: MAMMOTH_OWNER, seat: 1, x: 15 });
    game.world = stubWorld(new Map([[SELF, self], [MAMMOTH_OWNER, owner], [FRIEND, friend]]));
    game.renderer = { unitHeight: () => BODY };
    let aimed;
    game.collision = { world: { size: 1, firstHit(_from, to) { aimed = { ...to }; return undefined; } } };
    beginSeatDrawnFrame();
    seatDrawnRecord(friend, false).z = 3;
    assert.equal(inSightFromCamera(FRIEND), true);
    const view = createCamera(self.position, game.camera.yaw, game.camera.viewPitch, game.camera.view,
      { pivotHeight: cameraPivotHeight() });
    const chest = { x: 15, y: 0, z: 3 + BODY * 0.6 };
    // The segment stops 1.2 yards short of the chest, on the line from the camera to it.
    const dx = chest.x - view.position.x, dy = chest.y - view.position.y, dz = chest.z - view.position.z;
    const length = Math.hypot(dx, dy, dz);
    const stop = 1 - 1.2 / length;
    near(aimed.z, view.position.z + dz * stop, "aimed up at the seat", 1e-9);
    near(aimed.x, view.position.x + dx * stop, "x", 1e-9);
  } finally {
    game.world = previous.world;
    game.renderer = previous.renderer;
    game.collision = previous.collision;
  }
});

// ---- the hook points in the shared files -------------------------------------------------------------

test("11.02-tails: the selection ring, the canvas overlay, the bubbles and the sight test read the drawn place", async () => {
  const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
  const [renderer, scene, overlay, targeting, pose] = await Promise.all([
    read("src/browser/WorldRenderer3D.ts"), read("src/browser/SimpleScene.ts"), read("src/browser/ui/HeadOverlay.ts"),
    read("src/browser/game/Targeting.ts"), read("src/browser/VehiclePassengerPose.ts"),
  ]);
  assert.match(renderer, /#updateSelectionRings[\s\S]{0,400}?drawnUnitPosition\(object, [^)]*\)[^\n]*11\.02-tails/,
    "the target ring is laid round the drawn feet");
  assert.match(scene, /hiddenBySeat\(object\)[^\n]*11\.02-tails/, "no body box for a hidden passenger");
  assert.match(overlay, /function anchorFor[\s\S]{0,600}?drawnUnitPosition\(object, /, "bubbles and numbers");
  assert.match(targeting, /export function inSightFromCamera[\s\S]{0,500}?drawnUnitPosition\(/, "the sight line");
  assert.match(pose, /beginSeatDrawnFrame\(\)/, "every place starts a new frame of records");
});
