import assert from "node:assert/strict";
import test from "node:test";
import { isolatedModule } from "./fixtures/isolated-ui.mjs";
import { STOCK_BINDING_COMMANDS, STOCK_DEFAULT_KEYS } from "../dist/code/generated/stockBindings.js";

/*
 * DEC-B 3.11 (04.10): Bindings.xml's CAMERA section — NEXTVIEW (End) and PREVVIEW (Home) from
 * DefaultBindings.wtf, SETVIEW/SAVEVIEW/RESETVIEW 1–5 and FLIPCAMERAYAW unbound there — as native rows
 * (input/StockActions.ts) and verbs (input/Actions.ts), RunBinding of those commands, and the Lua C
 * functions of Wow.exe's registration table 0xad20d0–0xad20f8 (framexml/FrameXmlCameraViews.ts).
 */

const bindings = await import("../dist/code/browser/input/Bindings.js");
const protocol = await import("../dist/code/world/ActionBarProtocol.js");
const stock = await import("../dist/code/browser/input/StockActions.js");
const { FrameXmlBindingModel, FRAMEXML_STOCK_BINDING_SECTIONS } = await import("../dist/code/browser/framexml/FrameXmlBinding.js");
const { FRAMEXML_CAMERA_VIEW_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlCameraViews.js");
const { FRAMEXML_SEAM_BINDINGS, FRAMEXML_SEAM_NAMES } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");

const VIEW_ACTIONS = [
  ["NEXTVIEW", "nextView"], ["PREVVIEW", "prevView"],
  ...[1, 2, 3, 4, 5].map((n) => [`SETVIEW${n}`, `setView${n}`]),
  ...[1, 2, 3, 4, 5].map((n) => [`SAVEVIEW${n}`, `saveView${n}`]),
  ...[1, 2, 3, 4, 5].map((n) => [`RESETVIEW${n}`, `resetView${n}`]),
  ["FLIPCAMERAYAW", "flipCameraYaw"],
];

test("End and Home are the client's NEXTVIEW and PREVVIEW; the other camera rows ship unbound, as there", () => {
  assert.deepEqual(STOCK_DEFAULT_KEYS.NEXTVIEW, ["END"]);
  assert.deepEqual(STOCK_DEFAULT_KEYS.PREVVIEW, ["HOME"]);
  const rows = new Map(stock.STOCK_ACTIONS.map((row) => [row.action, row]));
  for (const [command, action] of VIEW_ACTIONS) {
    assert.equal(rows.get(action)?.command, command, `${action} is ${command}`);
    assert.equal(rows.get(action)?.group, "Обзор", "BINDING_HEADER_CAMERA");
  }
  assert.equal(rows.get("nextView").label, "Следующий ракурс");
  assert.equal(rows.get("setView3").label, "Восстановить ракурс 3");
  assert.equal(rows.get("saveView2").label, "Сохранить ракурс 2");
  assert.equal(rows.get("resetView5").label, "Сбросить ракурс 5");
  assert.equal(rows.get("flipCameraYaw").label, "Переключение камеры");
  assert.deepEqual(bindings.DEFAULT_BINDINGS.nextView, ["End", ""]);
  assert.deepEqual(bindings.DEFAULT_BINDINGS.prevView, ["Home", ""]);
  for (const [, action] of VIEW_ACTIONS.slice(2)) assert.deepEqual(bindings.DEFAULT_BINDINGS[action], ["", ""], action);
  const holders = Object.entries(bindings.DEFAULT_BINDINGS).filter(([, pair]) => pair.includes("End") || pair.includes("Home"));
  assert.deepEqual(holders.map(([action]) => action).sort(), ["nextView", "prevView"], "no other action ships on End or Home");
  assert.equal(stock.STOCK_DEFAULTS_HELD.has("NEXTVIEW"), false);
  assert.equal(stock.isStockAction("nextView"), true, "in the world the key is the game's even at the last view");
});

test("the CAMERA section lists its rows in Bindings.xml's order, between MISC and MULTIACTIONBAR", () => {
  const headers = FRAMEXML_STOCK_BINDING_SECTIONS.map((section) => section.header);
  assert.equal(headers.indexOf("CAMERA"), headers.indexOf("MISC") + 1);
  assert.equal(headers.indexOf("MULTIACTIONBAR"), headers.indexOf("CAMERA") + 1);
  const camera = FRAMEXML_STOCK_BINDING_SECTIONS.find((section) => section.header === "CAMERA");
  const xml = STOCK_BINDING_COMMANDS.filter((command) => command.header === "CAMERA").map((command) => command.name);
  assert.deepEqual(camera.rows.map(([command]) => command), xml.filter((name) => name !== "CAMERAZOOMIN" && name !== "CAMERAZOOMOUT"),
    "the wheel's two (MOUSEWHEELUP/DOWN only) stay out");
  assert.deepEqual(camera.rows.map(([, action]) => action), VIEW_ACTIONS.map(([, action]) => action));
});

test("each key runs its view verb; RunBinding of the command runs the same", async () => {
  const calls = [];
  const live = {
    setView: (index) => { calls.push(["set", index]); return true; },
    saveView: (index) => { calls.push(["save", index]); return true; },
    resetView: (index) => { calls.push(["reset", index]); return true; },
    nextView: () => { calls.push(["next"]); return false; },
    prevView: () => { calls.push(["prev"]); return true; },
    flipCameraYaw: (degrees) => { calls.push(["flip", degrees]); },
  };
  const game = { world: { state: { objects: new Map() } } };
  let motion;
  const vehicleCamera = { vehicleMode: false };
  const actions = await isolatedModule("browser/input/Actions", {
    "../ui/Settings.js": { settings: () => ({ cameraYawSmoothSpeed: 120 }), cameraMaxDistance: () => 22 },
    "../ui/SettingsModel.js": { settingNumber: (values, id) => values[id] },
    "../game/VehicleCamera.js": { vehicleCamera, VEHICLE_ZOOM_DISTANCE: 50 },
    "../game/Context.js": { game },
    "./Bindings.js": bindings,
    "../../world/ActionBarProtocol.js": protocol,
    "../game/CameraViewsLive.js": { liveCameraViews: live, useCameraViewMotion: (source) => { motion = source; } },
  });
  const run = (action) => {
    calls.length = 0;
    return [actions.runAction(action), ...calls];
  };
  assert.deepEqual(run("nextView"), [false, ["next"]], "at view 5: nothing moved");
  assert.deepEqual(run("prevView"), [true, ["prev"]]);
  assert.deepEqual(run("setView3"), [true, ["set", 3]]);
  assert.deepEqual(run("saveView1"), [true, ["save", 1]]);
  assert.deepEqual(run("resetView5"), [true, ["reset", 5]]);
  assert.deepEqual(run("flipCameraYaw"), [true, ["flip", 180]], "Bindings.xml: FlipCameraYaw(180)");
  game.world = undefined;
  assert.deepEqual(run("nextView"), [false], "no world, no camera");
  assert.deepEqual(motion(), { yawSpeed: 120, pitchSpeed: 30, ceiling: 22 },
    "cameraYawSmoothSpeed, the pitch at a quarter (cameraPitchSmoothSpeed = value/4), the wheel's ceiling");
  vehicleCamera.vehicleMode = true;
  assert.equal(motion().ceiling, 50, "in vehicle mode the vehicle's 50 yards");

  const runs = [];
  bindings.useBindingStorage({ getItem: () => null, setItem() {} });
  const model = new FrameXmlBindingModel({ runAction: (action) => { runs.push(action); return true; } });
  model.run("NEXTVIEW");
  model.run("NEXTVIEW", "up");
  model.run("SETVIEW2", "down");
  model.run("FLIPCAMERAYAW");
  assert.deepEqual(runs, ["nextView", "setView2", "flipCameraYaw"]);
  assert.equal(model.bindingAction("END"), "NEXTVIEW");
  assert.deepEqual(model.bindingKey("PREVVIEW"), ["HOME"]);
});

test("the Lua functions: a number cut to an integer, 1–5 for the indexed three, Usage errors as Wow.exe raises them", () => {
  const calls = [];
  const host = { cameraViews: {
    setView: (index) => calls.push(["set", index]), saveView: (index) => calls.push(["save", index]),
    resetView: (index) => calls.push(["reset", index]), nextView: () => calls.push(["next"]),
    prevView: () => calls.push(["prev"]), flipCameraYaw: (degrees) => calls.push(["flip", degrees]),
  } };
  assert.deepEqual(Object.keys(FRAMEXML_CAMERA_VIEW_BINDINGS),
    ["SetView", "SaveView", "ResetView", "NextView", "PrevView", "FlipCameraYaw"], "registration 0xad20d0–0xad20f8");
  for (const name of Object.keys(FRAMEXML_CAMERA_VIEW_BINDINGS)) {
    assert.equal(FRAMEXML_SEAM_BINDINGS[name], FRAMEXML_CAMERA_VIEW_BINDINGS[name], `${name} is on the seam`);
    assert.ok(FRAMEXML_SEAM_NAMES.includes(name), `${name} reaches the VM`);
  }
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.SetView(host, [3]), []);
  FRAMEXML_SEAM_BINDINGS.SetView(host, ["4"]);
  FRAMEXML_SEAM_BINDINGS.SetView(host, [2.9]);
  FRAMEXML_SEAM_BINDINGS.SetView(host, [-1.5]);
  FRAMEXML_SEAM_BINDINGS.SaveView(host, [5]);
  FRAMEXML_SEAM_BINDINGS.ResetView(host, [" 1 "]);
  FRAMEXML_SEAM_BINDINGS.NextView(host, []);
  FRAMEXML_SEAM_BINDINGS.PrevView(host, ["ignored"]);
  FRAMEXML_SEAM_BINDINGS.FlipCameraYaw(host, [90]);
  FRAMEXML_SEAM_BINDINGS.FlipCameraYaw(host, ["-45.5"]);
  assert.deepEqual(calls, [
    ["set", 3], ["set", 4], ["set", 2], ["set", -1], ["save", 5], ["reset", 1], ["next"], ["prev"], ["flip", 90], ["flip", -45.5],
  ], "0x88b9c0 truncates toward zero; the range is the camera's to judge");
  assert.throws(() => FRAMEXML_SEAM_BINDINGS.SetView(host, []), /^Error: Usage: SetView\(viewModeIndex\)$/);
  assert.throws(() => FRAMEXML_SEAM_BINDINGS.SaveView(host, ["three"]), /Usage: SaveView\(viewModeIndex\)/);
  assert.throws(() => FRAMEXML_SEAM_BINDINGS.ResetView(host, [true]), /Usage: ResetView\(viewModeIndex\)/);
  assert.throws(() => FRAMEXML_SEAM_BINDINGS.FlipCameraYaw(host, [""]), /Usage: FlipCameraYaw\(degrees\)/);
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.NextView({}, []), [], "no camera on the seam: nothing, no error");
  calls.length = 0;
  FRAMEXML_SEAM_BINDINGS.SetView(host, [2 ** 31]);
  assert.deepEqual(calls, [["set", -(2 ** 31)]], "outside int32: 0x80000000, which no range takes");
});

test("the live seam's Lua functions move the page's one camera", async () => {
  const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
  const { liveCameraViews } = await import("../dist/code/browser/game/CameraViewsLive.js");
  const { cameraViews } = await import("../dist/code/browser/game/CameraViews.js");
  const seam = new LiveWorldSeam({
    world: () => undefined, store: () => undefined, spell: () => undefined, focusGuid: () => undefined,
    monotonic: () => 0, globalCooldownUntil: () => 0, castSpell: () => {},
  });
  assert.equal(seam.cameraViews, liveCameraViews);
  assert.equal(cameraViews.current, 2);
  FRAMEXML_SEAM_BINDINGS.NextView(seam, []);
  assert.equal(cameraViews.current, 3, "NextView from the starting view 2");
  assert.equal(cameraViews.gliding, true, "21.31 yards to 5.55: a glide, advanced by the frame");
  FRAMEXML_SEAM_BINDINGS.SetView(seam, [2]);
  assert.equal(cameraViews.current, 2);
});
