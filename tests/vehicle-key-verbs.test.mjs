import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { isolatedModule } from "./fixtures/isolated-ui.mjs";

// 11.02-input: the native keys of Bindings.xml's VEHICLE section (input/StockActions.ts rows, input/Actions.ts
// cases over input/VehicleVerbs.ts). Each verb calls what the stock binding body calls (Bindings.xml:1239-1273):
// VehicleExit 0x005fb660, VehiclePrevSeat/NextSeat 0x005fb6d0/0x005fb720, VehicleAimUp/DownStart/Stop =
// PitchUp/DownStart/Stop (0x005fc8e0…), VehicleAimIncrement/Decrement 0x005fb770/0x005fb7d0,
// VehicleCameraZoomIn/Out = CameraZoomIn/Out (0x006018a0/0x006018b0 → 0x006017e0/0x00601840; 0x005ffa60 —
// the number is yards). Wow.exe 3.3.5a 12340, Ghidra read-only (.runtime/re-2026-10-03/l1102bcd, l1102e,
// l1102input).

const UPDATE = await import("../dist/code/generated/updateFields.js");
const bindings = await import("../dist/code/browser/input/Bindings.js");
const stock = await import("../dist/code/browser/input/StockActions.js");
const { STOCK_BINDING_COMMANDS, STOCK_DEFAULT_KEYS } = await import("../dist/code/generated/stockBindings.js");
const verbs = await import("../dist/code/browser/input/VehicleVerbs.js");
const vehicleCameraModule = await import("../dist/code/browser/game/VehicleCamera.js");
const aim = await import("../dist/code/browser/game/VehicleAim.js");
const binding = await import("../dist/code/browser/framexml/FrameXmlBinding.js");
const { startVehicleData, vehicleCatalog } = await import("../dist/code/browser/VehicleClient.js");
const {
  VEHICLE_CATALOG_VERSION, VEHICLE_COLUMN, VEHICLE_FORMAT, VEHICLE_SEAT_COLUMN, VEHICLE_SEAT_FORMAT, vehicleCatalogFrom,
} = await import("../dist/code/world/VehicleDbc.js");
const { VEHICLE_SEAT_FLAGS: SEAT } = await import("../dist/code/world/VehicleSeatModel.js");

const VEHICLE_ROWS = [
  ["vehicleExit", "VEHICLEEXIT"], ["vehiclePrevSeat", "VEHICLEPREVSEAT"], ["vehicleNextSeat", "VEHICLENEXTSEAT"],
  ["vehicleAimUp", "VEHICLEAIMUP"], ["vehicleAimDown", "VEHICLEAIMDOWN"],
  ["vehicleAimIncrement", "VEHICLEAIMINCREMENT"], ["vehicleAimDecrement", "VEHICLEAIMDECREMENT"],
  ["vehicleCameraZoomIn", "VEHICLECAMERAZOOMIN"], ["vehicleCameraZoomOut", "VEHICLECAMERAZOOMOUT"],
];

// ---- vehicle tables: one vehicle, four seats with different flags ---------------------------------

const KIT = 9117;
const SEATS = {
  exitAndSwitch: [9001, SEAT.CAN_ENTER_OR_EXIT | SEAT.CAN_SWITCH],
  neither: [9002, SEAT.CAN_CONTROL],
  exitOnly: [9003, SEAT.CAN_ENTER_OR_EXIT],
  switchOnly: [9004, SEAT.CAN_SWITCH],
};
function vehicleRow(id, seatIds) {
  const row = [...VEHICLE_FORMAT].map((kind) => (kind === "s" ? "" : 0));
  row[VEHICLE_COLUMN.ID] = id;
  seatIds.forEach((seat, slot) => { row[VEHICLE_COLUMN.SeatID + slot] = seat; });
  return row;
}
function seatRow(id, flags) {
  const row = [...VEHICLE_SEAT_FORMAT].map(() => 0);
  row[VEHICLE_SEAT_COLUMN.ID] = id;
  row[VEHICLE_SEAT_COLUMN.Flags] = flags >>> 0;
  return row;
}
const ANSWER = {
  version: VEHICLE_CATALOG_VERSION,
  vehicles: [vehicleRow(KIT, Object.values(SEATS).map(([id]) => id))],
  seats: Object.values(SEATS).map(([id, flags]) => seatRow(id, flags)),
  indicators: [],
  indicatorSeats: [],
};
const CATALOG = vehicleCatalogFrom(JSON.parse(JSON.stringify(ANSWER)));
const SLOT = { exitAndSwitch: 0, neither: 1, exitOnly: 2, switchOnly: 3 };

const SELF = 1n;
const VEHICLE = 0xf150_7d9a_0000_0042n;

/** Actions.ts on its own, with the world, the camera and the panels it reaches replaced by recorders. */
async function harness({ seat, catalog } = {}) {
  const calls = [];
  const self = { guid: SELF, typeId: 4, fields: new Map(), position: { x: 0, y: 0, z: 0, orientation: 0 } };
  if (seat !== undefined) self.transport = { guid: VEHICLE, x: 0, y: 0, z: 2, orientation: 0, seat };
  const vehicle = { guid: VEHICLE, typeId: 3, vehicleId: KIT, fields: new Map(), position: { x: 0, y: 0, z: 0, orientation: 0 } };
  const world = {
    state: { selfGuid: SELF, objects: new Map([[SELF, self], [VEHICLE, vehicle]]) },
    leaveVehicle() { calls.push(["leave"]); },
    changeVehicleSeat(next) { calls.push(["seat", next]); },
    onSpellStatus(text, error) { calls.push(["status", text, error]); },
  };
  const camera = { distance: 20 };
  let pitch = 0.2;
  const input = {
    moverPitch: () => pitch,
    setMoverPitch: (next) => { calls.push(["pitch", Math.round(next * 1000) / 1000]); pitch = next; return true; },
    pitchKey: (direction, down) => calls.push(["pitchKey", direction, down]),
  };
  const isolatedVerbs = await isolatedModule("browser/input/VehicleVerbs", {
    "../../world/UnitSeat.js": await import("../dist/code/world/UnitSeat.js"),
    "../../world/VehicleSeatModel.js": await import("../dist/code/world/VehicleSeatModel.js"),
    "../framexml/FrameXmlVehicle.js": { frameXmlVehicleLive: () => undefined },
    "../game/VehicleAim.js": { vehicleAimInput: () => input },
    "../VehicleClient.js": { vehicleCatalog: () => catalog },
  });
  const actions = await isolatedModule("browser/input/Actions", {
    "../game/Context.js": { game: { world, camera, spells: new Map() } },
    "./Bindings.js": bindings,
    "../../world/ActionBarProtocol.js": await import("../dist/code/world/ActionBarProtocol.js"),
    "../../generated/updateFields.js": UPDATE,
    "../../generated/globalStrings.js": await import("../dist/code/generated/globalStrings.js"),
    "./VehicleVerbs.js": isolatedVerbs,
    "../game/VehicleCamera.js": vehicleCameraModule,
    "../ui/Settings.js": { cameraMaxDistance: () => 35, settingOn: () => false, setSetting: () => true },
    "../ui/Notices.js": { notice: (text) => calls.push(["notice", text]) },
  });
  const run = (action) => {
    calls.length = 0;
    return actions.runAction(action);
  };
  return { run, calls, camera, world };
}

test("11.02-input: the nine VEHICLE rows — stock commands, the client's own names, no default key", () => {
  const rows = new Map(stock.STOCK_ACTIONS.map((row) => [row.action, row]));
  const names = new Map(STOCK_BINDING_COMMANDS.map((command) => [command.name, command]));
  for (const [action, command] of VEHICLE_ROWS) {
    const row = rows.get(action);
    assert.ok(row, `${action} is a row`);
    assert.equal(row.command, command);
    assert.equal(names.get(command)?.header, "VEHICLE", `${command} is Bindings.xml's VEHICLE section`);
    assert.equal(row.group, "Управление транспортом", "BINDING_HEADER_VEHICLE");
    assert.equal(STOCK_DEFAULT_KEYS[command], undefined, `DefaultBindings.wtf of 12340 gives ${command} no key`);
    assert.deepEqual([...bindings.DEFAULT_BINDINGS[action]], ["", ""], `${action} ships unbound`);
    assert.equal(stock.isStockAction(action), true);
  }
  // The labels are GlobalStrings.lua's BINDING_NAME_<command>, when the dataset is here to say so.
  const globals = "F:/tswowRoot/tswow-install/modules/default/datasets/dataset/luaxml/Interface/FrameXML/GlobalStrings.lua";
  if (existsSync(globals)) {
    const lua = readFileSync(globals, "utf8");
    for (const [action, command] of VEHICLE_ROWS) {
      const match = new RegExp(`^BINDING_NAME_${command} = "([^"]*)";`, "m").exec(lua);
      assert.equal(rows.get(action).label, match?.[1], `${command}'s name`);
    }
    assert.match(lua, /^BINDING_HEADER_VEHICLE = "Управление транспортом";/m);
  }
  // runOnUp in Bindings.xml ↔ held here: the aim keys are the pitch keys themselves.
  for (const [action, command] of VEHICLE_ROWS) {
    assert.equal(bindings.HELD_ACTIONS.has(action), names.get(command).runOnUp, `${action} held as Bindings.xml runs it`);
  }
  assert.equal(bindings.heldMovementAction("vehicleAimUp"), "pitchUp");
  assert.equal(bindings.heldMovementAction("vehicleAimDown"), "pitchDown");
  for (const action of ["pitchUp", "moveForward", "turnLeft", "jump"]) assert.equal(bindings.heldMovementAction(action), action);
});

test("11.02-input: a key bound to a VEHICLE row reaches its row, and the stock key API names it by its command", () => {
  bindings.useBindingStorage({ getItem: () => null, setItem() {} });
  try {
    bindings.bindAction("vehicleExit", 0, "KeyY");
    bindings.bindAction("vehicleAimUp", 0, "Ctrl+KeyU");
    assert.equal(bindings.actionFor("KeyY"), "vehicleExit");
    assert.equal(bindings.actionFor("Ctrl+KeyU"), "vehicleAimUp");
    for (const [action, command] of VEHICLE_ROWS) assert.equal(binding.frameXmlBindingCommand(action), command);
    const section = binding.FRAMEXML_STOCK_BINDING_SECTIONS.find((entry) => entry.header === "VEHICLE");
    assert.deepEqual(section?.rows.map(([command]) => command), VEHICLE_ROWS.map(([, command]) => command),
      "the VEHICLE section in Bindings.xml order");
    assert.equal(binding.FRAMEXML_WEBCLIENT_BINDING_ROWS.some(([, action]) => action.startsWith("vehicle")), false);
  } finally {
    bindings.useBindingStorage(undefined);
  }
});

test("11.02-input: VEHICLEEXIT is VehicleExit — the exit from a CAN_ENTER_OR_EXIT seat, else the UI error", async () => {
  {
    const { run, calls } = await harness({ seat: SLOT.exitOnly, catalog: CATALOG });
    assert.equal(run("vehicleExit"), true);
    assert.deepEqual(calls, [["leave"]]);
  }
  for (const [where, seat] of [["a seat without CAN_ENTER_OR_EXIT", SLOT.switchOnly], ["on foot", undefined]]) {
    const { run, calls } = await harness({ seat, catalog: CATALOG });
    assert.equal(run("vehicleExit"), true);
    assert.deepEqual(calls, [["status", "Вы пока не можете этого сделать.", true]], where);
  }
  // Without the tables nothing is known of the seat: any unit seat is left.
  {
    const { run, calls } = await harness({ seat: SLOT.neither, catalog: undefined });
    run("vehicleExit");
    assert.deepEqual(calls, [["leave"]]);
  }
  // 11.02-input review: on foot there is no seat whatever the tables say — 0x005fb560 answers 0 for a character
  // without a passenger record (+0xf60) before it reads any seat row, so 0x005fb660 shows the error.
  {
    const { run, calls } = await harness({ catalog: undefined });
    run("vehicleExit");
    assert.deepEqual(calls, [["status", "Вы пока не можете этого сделать.", true]], "on foot without tables");
  }
});

test("11.02-input: VehicleExit is the stock model's own while a stock seam holds the tables", () => {
  const calls = [];
  const world = { state: { selfGuid: SELF, objects: new Map() }, leaveVehicle: () => calls.push("leave"), changeVehicleSeat() {} };
  const model = { active: true, exit: () => calls.push("stock exit") };
  assert.equal(verbs.vehicleExitKey(world, CATALOG, model), undefined);
  assert.deepEqual(calls, ["stock exit"], "the stock model decides and raises UI_ERROR_MESSAGE itself");
  calls.length = 0;
  assert.equal(verbs.vehicleExitKey(world, CATALOG, { active: false, exit: () => calls.push("stock exit") }), "SPELL_FAILED_CANT_DO_THAT_RIGHT_NOW");
  assert.deepEqual(calls, []);
});

test("11.02-input: VEHICLEPREVSEAT / VEHICLENEXTSEAT step only from a CAN_SWITCH seat, and say nothing otherwise", async () => {
  {
    const { run, calls } = await harness({ seat: SLOT.switchOnly, catalog: CATALOG });
    run("vehiclePrevSeat");
    assert.deepEqual(calls, [["seat", false]]);
    run("vehicleNextSeat");
    assert.deepEqual(calls, [["seat", true]]);
  }
  for (const seat of [SLOT.exitOnly, SLOT.neither, undefined]) {
    const { run, calls } = await harness({ seat, catalog: CATALOG });
    assert.equal(run("vehicleNextSeat"), true, "the key is the game's either way");
    assert.deepEqual(calls, [], `slot ${seat}`);
  }
  {
    const { run, calls } = await harness({ seat: SLOT.neither, catalog: undefined });
    run("vehicleNextSeat");
    assert.deepEqual(calls, [["seat", true]], "without tables any unit seat steps");
  }
  {
    const { run, calls } = await harness({ catalog: undefined });
    run("vehiclePrevSeat");
    assert.deepEqual(calls, [], "on foot without tables: nothing");
  }
});

test("11.02-input: VEHICLEAIMINCREMENT / DECREMENT move the active mover's pitch by Bindings.xml's 0.1", async () => {
  const { run, calls } = await harness({ seat: SLOT.neither, catalog: CATALOG });
  run("vehicleAimIncrement");
  assert.deepEqual(calls, [["pitch", 0.3]]);
  run("vehicleAimDecrement");
  assert.deepEqual(calls, [["pitch", 0.2]]);
  assert.equal(verbs.vehicleAimStepKey(1, undefined), false, "no movement code registered: nothing");
  // The real registration is Movement.ts's: a mover whose pitch does not count takes nothing.
  assert.equal(verbs.vehicleAimStepKey(1, aim.vehicleAimInput() ?? undefined), false);
});

test("11.02-input: VEHICLECAMERAZOOMIN / OUT move the camera a yard, within the wheel's bounds", async () => {
  const { run, camera } = await harness({ catalog: undefined });
  camera.distance = 20;
  run("vehicleCameraZoomIn");
  assert.equal(camera.distance, 19);
  run("vehicleCameraZoomOut");
  run("vehicleCameraZoomOut");
  assert.equal(camera.distance, 21);
  camera.distance = 34.5;
  run("vehicleCameraZoomOut");
  assert.equal(camera.distance, 35, "the player's own ceiling (cameraMaxDistance)");
  camera.distance = 4;
  run("vehicleCameraZoomIn");
  assert.equal(camera.distance, 0, "below the closest orbit the next stop is first person, as the wheel's");
  run("vehicleCameraZoomOut");
  assert.equal(camera.distance, 3.5, "and out of it the closest orbit");
  // The vehicle camera's own bounds and lock (VehicleCamera.ts): in vehicle mode the ceiling is 50.
  const tracker = new vehicleCameraModule.VehicleCameraTracker();
  assert.equal(tracker.zoomBy(20, -1, 35), 19);
  assert.equal(tracker.zoomBy(35, 1, 35), 35);
});

test("11.02-input: in the stock UI the keys are the same table — SetBinding/GetBindingKey by command, RunBinding runs the native verb", () => {
  // This client never runs Bindings.xml's Lua bodies: a key goes through input/Bindings.ts in both modes,
  // and RunBinding(command) runs the row's native verb (FrameXmlBinding.ts `run`). The verbs call what the
  // bodies call; VehicleCameraZoomIn/Out (and CameraZoomIn/Out) have no stock C function here at all.
  bindings.useBindingStorage({ getItem: () => null, setItem() {} });
  try {
    const runs = [];
    const model = new binding.FrameXmlBindingModel({ runAction: (action) => { runs.push(action); return true; } });
    model.attach({ now: () => 0, fire: () => 1 });
    assert.equal(model.setBinding("CTRL-Y", "VEHICLEEXIT"), true);
    assert.deepEqual(model.bindingKey("VEHICLEEXIT"), ["CTRL-Y"]);
    assert.equal(model.bindingAction("CTRL-Y"), "VEHICLEEXIT");
    assert.equal(bindings.actionFor("Ctrl+KeyY"), "vehicleExit", "the key the stock window set is the native table's");
    for (const [, command] of VEHICLE_ROWS) model.run(command, "down");
    model.run("VEHICLEEXIT", "up");
    assert.deepEqual(runs, VEHICLE_ROWS.map(([action]) => action));
    const listed = Array.from({ length: model.count() }, (_, index) => model.binding(index + 1)[0]);
    const header = listed.indexOf("HEADER_VEHICLE");
    assert.ok(header > listed.indexOf("HEADER_BLANK6") && header < listed.indexOf("HEADER_WEBCLIENT"));
    assert.deepEqual(listed.slice(header + 1, header + 10), VEHICLE_ROWS.map(([, command]) => command));
    model.detach();
  } finally {
    bindings.useBindingStorage(undefined);
  }
});

test("11.02-input: Actions.ts and Movement.ts carry the hooks", () => {
  const actions = readFileSync(new URL("../src/browser/input/Actions.ts", import.meta.url), "utf8");
  for (const name of ["vehicleExitKey", "vehicleSeatKey", "vehicleAimStepKey", "zoomBy"]) assert.ok(actions.includes(name), name);
  const movement = readFileSync(new URL("../src/browser/input/Movement.ts", import.meta.url), "utf8");
  assert.equal(movement.split("action = heldMovementAction(action); // 11.02-input").length - 1, 2, "beginHeld and endHeld");
});
