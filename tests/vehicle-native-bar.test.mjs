import assert from "node:assert/strict";
import test, { after } from "node:test";
import { isolatedUi } from "./fixtures/isolated-ui.mjs";
import { installFakeUiDocument } from "./fixtures/fake-ui-document.mjs";

// 11.02-F2: the native vehicle row (ui/PetBar.ts) under Wow.exe's gates (ui/VehicleBarGates.ts) — leave only
// from a seat with CAN_ENTER_OR_EXIT (CanExitVehicle 0x005fb9c0, VehicleExit 0x005fb660), step seats only
// from one with CAN_SWITCH (VehiclePrevSeat/NextSeat 0x005fb6d0/0x005fb720), eject only an EJECTABLE seat's
// passenger (CanEjectPassengerFromSeat 0x00613d20) — and the `data-stock-vehicle` mark by which the world
// mount hides the row once the stock VehicleMenuBar/VehicleSeatIndicator own it. Without the vehicle tables
// the row works exactly as before.

const petProtocol = await import("../dist/code/world/PetProtocol.js");
const gates = await import("../dist/code/browser/ui/VehicleBarGates.js");
const { FrameXmlVehicleModel } = await import("../dist/code/browser/framexml/FrameXmlVehicle.js");
const { FrameXmlPossessModel } = await import("../dist/code/browser/framexml/FrameXmlPossess.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const {
  VEHICLE_CATALOG_VERSION, VEHICLE_COLUMN, VEHICLE_FORMAT, VEHICLE_SEAT_COLUMN, VEHICLE_SEAT_FORMAT, vehicleCatalogFrom,
} = await import("../dist/code/world/VehicleDbc.js");
const { VEHICLE_SEAT_FLAGS: F, VEHICLE_SEAT_FLAGS_B: FB } = await import("../dist/code/world/VehicleSeatModel.js");
const { packPetAction, REACT_DEFENSIVE, COMMAND_FOLLOW } = petProtocol;

function vehicleRow({ id, seats }) {
  const row = [...VEHICLE_FORMAT].map((kind) => (kind === "s" ? "" : 0));
  row[VEHICLE_COLUMN.ID] = id;
  seats.forEach((seat, slot) => { row[VEHICLE_COLUMN.SeatID + slot] = seat; });
  return row;
}
function seatRow({ id, flags = 0, flagsB = 0, ability = 1 }) {
  const row = [...VEHICLE_SEAT_FORMAT].map(() => 0);
  row[VEHICLE_SEAT_COLUMN.ID] = id;
  row[VEHICLE_SEAT_COLUMN.Flags] = flags;
  row[VEHICLE_SEAT_COLUMN.FlagsB] = flagsB;
  row[VEHICLE_SEAT_COLUMN.VehicleAbilityDisplay] = ability;
  return row;
}
// A siege engine whose slot 0 is the driver's (1648 as in the dataset: CAN_ENTER_OR_EXIT, CAN_SWITCH) and slot 1
// a locked seat (no CAN_ENTER_OR_EXIT, no CAN_SWITCH); a mammoth (the character's own kit) with an ejectable
// and a fixed rider seat; a cart whose driver keeps the bar off the main bar (VehicleAbilityDisplay 0).
const catalog = vehicleCatalogFrom({
  version: VEHICLE_CATALOG_VERSION,
  vehicles: [vehicleRow({ id: 117, seats: [1648, 7001, 7003] }), vehicleRow({ id: 312, seats: [0, 2764, 7002] }), vehicleRow({ id: 901, seats: [9010] })],
  seats: [
    seatRow({ id: 1648, flags: 0x67108a0b }),
    seatRow({ id: 7001, flags: F.CAN_CAST }),
    seatRow({ id: 7003, flags: F.CAN_ENTER_OR_EXIT }),
    seatRow({ id: 2764, flags: 0xde00800b, flagsB: FB.EJECTABLE }),
    seatRow({ id: 7002, flags: 0xde00800b }),
    seatRow({ id: 9010, flags: F.CAN_CONTROL | F.CAN_CAST, ability: 0 }),
  ],
  indicators: [],
  indicatorSeats: [],
});

const SELF = 0x10n;
const ENGINE = 0xf150_0074_9800_0101n;
const CART = 0xf150_0385_0000_0103n;
const FRIEND = 0x11n;
const STRANGER = 0x12n;
const FARSIGHT = UPDATE_FIELDS.PLAYER_FARSIGHT.offset;

const unit = (guid, typeId, extra = {}) => ({ guid, typeId, fields: new Map([[UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 100]]),
  position: { x: 0, y: 0, z: 0, orientation: 0 }, transport: undefined, ...extra });
const seat = (carrier, slot) => ({ guid: carrier, x: 0, y: 0, z: 0, orientation: 0, seat: slot });

function vehicleBar(guid) {
  return {
    guid, closed: false, creatureFamily: 0, duration: 0, reactState: REACT_DEFENSIVE, commandState: COMMAND_FOLLOW, flags: 0,
    spells: [], cooldowns: [],
    bar: Array.from({ length: 10 }, (_, slot) => {
      const packed = packPetAction(slot === 0 ? 62345 : 0, slot + 8);
      return { slot, packed, action: packed & 0xffffff, type: packed >>> 24 };
    }),
  };
}

test("11.02-F2: the gates — nothing without the tables, CAN_ENTER_OR_EXIT, CAN_SWITCH and EJECTABLE with them", () => {
  const objects = new Map([[SELF, unit(SELF, 4, { transport: seat(ENGINE, 0) })], [ENGINE, unit(ENGINE, 3, { vehicleId: 117 })]]);
  const world = { state: { selfGuid: SELF, objects } };
  assert.equal(gates.nativeVehicleGates(world, undefined), undefined, "no tables: no gate");
  assert.equal(gates.nativeVehicleGates(undefined, catalog), undefined);
  let now = gates.nativeVehicleGates(world, catalog);
  assert.deepEqual([now.canExit, now.canSwitch], [true, true], "the driver's seat 1648");
  objects.get(SELF).transport = seat(ENGINE, 1);
  now = gates.nativeVehicleGates(world, catalog);
  assert.deepEqual([now.canExit, now.canSwitch], [false, false], "the locked seat");
  objects.get(SELF).transport = seat(ENGINE, 2);
  now = gates.nativeVehicleGates(world, catalog);
  assert.deepEqual([now.canExit, now.canSwitch], [true, false], "CAN_ENTER_OR_EXIT without CAN_SWITCH");
  objects.get(SELF).transport = undefined;
  objects.get(SELF).vehicleId = 312;
  objects.set(FRIEND, unit(FRIEND, 4, { transport: seat(SELF, 1) }));
  objects.set(STRANGER, unit(STRANGER, 4, { transport: seat(SELF, 2) }));
  now = gates.nativeVehicleGates(world, catalog);
  assert.deepEqual([now.canEject(FRIEND), now.canEject(STRANGER), now.canEject(0x99n)], [true, false, false],
    "an EJECTABLE seat, a fixed one, nobody");
});

test("11.02-F2: the stock UI owns the row with its tables, and for a vehicle bar only once it is on the main bar", () => {
  const objects = new Map([[SELF, unit(SELF, 4, { transport: seat(ENGINE, 0) })], [ENGINE, unit(ENGINE, 3, { vehicleId: 117 })],
    [CART, unit(CART, 3, { vehicleId: 901 })]]);
  const world = { state: { selfGuid: SELF, objects }, petSpells: undefined, events: undefined };
  assert.equal(gates.stockOwnsVehicleRow(world), false, "no stock seam attached");
  let tables;
  const vehicle = new FrameXmlVehicleModel({ world: () => world, catalog: () => tables, unitGuid: () => undefined });
  const pump = { fire: () => 1 };
  vehicle.attach(pump);
  try {
    assert.equal(gates.stockOwnsVehicleRow(world), false, "attached, but the tables have not landed");
    tables = catalog;
    assert.equal(gates.stockOwnsVehicleRow(world), true, "a passenger's row: leave and seats are stock's");
    // 11.02-F2-review: a closed bar (SMSG_PET_SPELLS with a zero guid keeps its last words) is no bar.
    world.petSpells = { ...vehicleBar(ENGINE), closed: true };
    assert.equal(gates.stockOwnsVehicleRow(world), true, "a closed vehicle bar: the stock UI owns the row");
    world.petSpells = vehicleBar(ENGINE);
    assert.equal(gates.stockOwnsVehicleRow(world), false, "a vehicle bar no stock owner shows yet");
    const self = objects.get(SELF);
    self.fields.set(FARSIGHT, Number(ENGINE & 0xffff_ffffn));
    self.fields.set(FARSIGHT + 1, Number(ENGINE >> 32n));
    const possess = new FrameXmlPossessModel({ world: () => world, spell: () => undefined, unitGuid: () => undefined, vehicles: () => tables });
    possess.attach(pump);
    try {
      assert.equal(possess.onMainBar(), true, "VehicleAbilityDisplay 1: on the main bar (VehicleMenuBarActionButton1-6)");
      assert.equal(gates.stockOwnsVehicleRow(world), true);
      // The cart keeps its bar off the main bar: the native row stays for it.
      self.transport = seat(CART, 0);
      world.petSpells = vehicleBar(CART);
      self.fields.set(FARSIGHT, Number(CART & 0xffff_ffffn));
      self.fields.set(FARSIGHT + 1, Number(CART >> 32n));
      possess.tick();
      assert.equal(possess.onMainBar(), false);
      assert.equal(gates.stockOwnsVehicleRow(world), false);
    } finally {
      possess.detach();
    }
  } finally {
    vehicle.detach();
  }
  assert.equal(gates.stockOwnsVehicleRow(world), false, "detached");
});

test("11.02-F2: the world mount hides the native row by the mark, only with the stock lanes and pet bar", async () => {
  // The mount imports the native interface (ui/Dom.ts resolves its handles at import): the shared fake page
  // for the import, then this file's own document back for the row tests below.
  const own = globalThis.document;
  installFakeUiDocument();
  let selector;
  try {
    ({ FRAMEXML_NATIVE_VEHICLE_BAR_HIDE_SELECTOR: selector } = await import("../dist/code/browser/framexml/FrameXmlWorldMount.js"));
  } finally {
    globalThis.document = own;
  }
  assert.match(selector, /^body\.[\w-]+\.framexml-world-replaces-pet-bar #pet-bar\[data-stock-vehicle\]$/);
});

test("11.02-F2-review: a refused micro-button gate holds the stock row hidden past VehicleMenuBar_MoveMicroButtons", async () => {
  // The hold itself is exercised over the MPQ vertical (framexml-vehicle-vertical); here, that the mount's
  // refused branch uses it rather than a plain Hide, which the stock Lua undoes on the next loading screen.
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/browser/framexml/FrameXmlWorldMount.ts", import.meta.url), "utf8");
  assert.match(source, /\} else holdFrameXmlMicroButtonsHidden\(boot, FRAMEXML_MICROBUTTON_NAMES\);/);
  assert.doesNotMatch(source, /\} else hideFrameXmlMicroButtons\(boot\);/);
});

// ---- the row itself (ui/PetBar.ts, transpiled on its own) ------------------------------------------

class Element {
  constructor(tag) { this.tagName = tag.toUpperCase(); }
  children = []; listeners = {}; dataset = {}; hidden = false; className = ""; id = ""; draggable = false; disabled = false;
  textContent = "";
  style = { setProperty() {} };
  classList = { add() {}, remove() {}, toggle() {} };
  get isConnected() { return true; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute() {}
  addEventListener(name, listener) { (this.listeners[name] ??= []).push(listener); }
  click() { for (const listener of this.listeners.click ?? []) listener({ preventDefault() {} }); }
}

const realDocument = globalThis.document;
const byId = new Map();
globalThis.document = {
  createElement: (tag) => new Element(tag),
  getElementById: (id) => { if (!byId.has(id)) byId.set(id, new Element("div")); return byId.get(id); },
  documentElement: new Element("html"),
};
after(() => { globalThis.document = realDocument; });

class IconButton {
  constructor(options) { this.root = new Element("button"); this.options = options; }
  setContent() {} setCooldown() {} setUsable() {}
}

async function petBar() {
  byId.clear();
  const game = { world: undefined, spells: new Map(), gatewayOrigin: undefined };
  const state = { tables: catalog, stock: false };
  const confirmed = [];
  const bar = await isolatedUi("PetBar", {
    "../../world/PetProtocol.js": petProtocol,
    "../../world/VehicleProtocol.js": { vehiclePassengers: (worldState, owner) => [...worldState.objects.values()]
      .filter((object) => object.transport?.guid === owner).map((object) => object.guid) },
    "../game/Context.js": { game },
    "./Widgets.js": { IconButton, attachTooltip() {}, confirmPanel: (_anchor, options) => { confirmed.push(options); options.onConfirm(); } },
    "./IconImage.js": { spellIconUrl: () => undefined },
    "./DragGhost.js": { beginIconDrag() {} },
    "./PetSpellbook.js": { PET_SPELL_DRAG_FORMAT: "text/pet-spell", nativePetBook: () => ({ placeSpell() {} }) },
    "../GameWindows.js": { notifyHudLayout() {} },
    "./VehicleBarGates.js": {
      nativeVehicleGates: (world) => gates.nativeVehicleGates(world, state.tables),
      stockOwnsVehicleRow: () => state.stock,
    },
    "../VehicleClient.js": { vehicleCatalog: () => state.tables },
  });
  const calls = [];
  const objects = new Map([[SELF, unit(SELF, 4)], [ENGINE, unit(ENGINE, 3, { vehicleId: 117 })]]);
  game.world = {
    state: { selfGuid: SELF, objects, revision: 1 },
    vehicleKits: new Map(), controlledGuid: SELF, petSpells: undefined,
    displayName: (guid) => `#${guid}`,
    leaveVehicle: () => calls.push("leave"),
    changeVehicleSeat: (next) => calls.push(next ? "next" : "prev"),
    ejectPassenger: (guid) => calls.push(`eject ${guid}`),
  };
  const box = () => byId.get("bottom-hud-center").children[0];
  const exitButtons = () => box().children[1].children;
  return { bar, game, objects, state, calls, box, exitButtons, confirmed };
}

test("11.02-F2: the native row obeys CAN_ENTER_OR_EXIT and CAN_SWITCH, and without the tables works as before", async () => {
  const { bar, game, objects, state, calls, exitButtons } = await petBar();
  objects.get(SELF).transport = seat(ENGINE, 1);
  bar.showPetBar();
  let [previous, next, leave] = exitButtons();
  assert.deepEqual([previous.textContent, next.textContent, leave.textContent], ["◀ место", "место ▶", "Покинуть"]);
  assert.deepEqual([previous.disabled, next.disabled, leave.disabled], [true, true, true], "the locked seat");
  for (const button of [previous, next, leave]) button.click();
  assert.deepEqual(calls, [], "nothing sent");
  // The driver's seat: everything allowed.
  objects.get(SELF).transport = seat(ENGINE, 0);
  game.world.state.revision += 1;
  bar.updatePetBar(0);
  [previous, next, leave] = exitButtons();
  assert.deepEqual([previous.disabled, next.disabled, leave.disabled], [false, false, false], "a seat change redraws the row");
  for (const button of [previous, next, leave]) button.click();
  assert.deepEqual(calls, ["prev", "next", "leave"]);
  // Asked again on the click: a button drawn enabled refuses once the seat moved under it.
  calls.length = 0;
  objects.get(SELF).transport = seat(ENGINE, 1);
  leave.click();
  assert.deepEqual(calls, [], "the gate at the click");
  // Without the tables nothing is gated, as before this slice.
  state.tables = undefined;
  game.world.state.revision += 1;
  bar.updatePetBar(0);
  [previous, next, leave] = exitButtons();
  assert.deepEqual([previous.disabled, next.disabled, leave.disabled], [false, false, false]);
  for (const button of [previous, next, leave]) button.click();
  assert.deepEqual(calls, ["prev", "next", "leave"]);
});

test("11.02-F2: the owner's eject buttons obey EJECTABLE; the mark follows stockOwnsVehicleRow", async () => {
  const { bar, game, objects, state, calls, exitButtons, box, confirmed } = await petBar();
  objects.get(SELF).vehicleId = 312;
  game.world.vehicleKits.set(SELF, 312);
  objects.set(FRIEND, unit(FRIEND, 4, { transport: seat(SELF, 1) }));
  objects.set(STRANGER, unit(STRANGER, 4, { transport: seat(SELF, 2) }));
  bar.showPetBar();
  const [friend, stranger] = exitButtons();
  assert.deepEqual([friend.textContent, friend.disabled, stranger.textContent, stranger.disabled],
    [`Высадить: #${FRIEND}`, false, `Высадить: #${STRANGER}`, true]);
  stranger.click();
  friend.click();
  assert.equal(confirmed.length, 1, "only the ejectable rider asks");
  assert.deepEqual(calls, [`eject ${FRIEND}`]);
  // The stock mark: written on change only, by updatePetBar's per-frame sync.
  assert.equal("stockVehicle" in box().dataset, false);
  state.stock = true;
  bar.updatePetBar(0);
  assert.equal(box().dataset.stockVehicle, "");
  state.stock = false;
  bar.updatePetBar(0);
  assert.equal("stockVehicle" in box().dataset, false);
  state.stock = true;
  bar.updatePetBar(0);
  bar.resetPetBar();
  assert.equal("stockVehicle" in box().dataset, false, "a reset drops the mark with the rest");
});
