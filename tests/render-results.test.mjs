import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 22.10 ARC-2 S3a: what the main thread reads back from the world renderer comes from one structured-clonable
// record the renderer fills (browser/RenderResults.ts), not from getters — so the renderer can move into a
// DedicatedWorker later and post the record instead.

const {
  PICK_CORNER_VALUES, PICK_RESULT_SIZE, PICK_RESULT_STAMP, UNIT_RESULT_EYE, UNIT_RESULT_HEIGHT, UNIT_RESULT_PIVOT,
  UNIT_RESULT_SIZE, UNIT_RESULT_STAMP, createRenderResults, dropStaleRows, resultGameObjectCorners, resultRow,
  resultUnitEyeHeight, resultUnitHeight, resultUnitPivotHeight,
} = await import("../dist/code/browser/RenderResults.js");
const {
  CAMERA_DEFAULT_EYE_HEIGHT, CAMERA_DEFAULT_PIVOT_HEIGHT, CAMERA_EYE_BODY_SHARE, CAMERA_PIVOT_BODY_SHARE, cameraBodyHeight,
} = await import("../dist/code/browser/SceneCamera.js");
const { DEFAULT_ATMOSPHERE_PROFILE } = await import("../dist/code/browser/AtmosphereEffects.js");

const source = (path) => readFileSync(new URL(`../src/browser/${path}`, import.meta.url), "utf8");

/** A record as one `#publishResults` leaves it: two units, one box, one seat, the scalars. */
function filledRecord() {
  const results = createRenderResults(DEFAULT_ATMOSPHERE_PROFILE);
  results.frame = 7;
  const self = resultRow(results.units, 1n, UNIT_RESULT_SIZE);
  self.set([2.0272, 1.7254, 1.9, 7]);
  const mounted = resultRow(results.units, 0xf130_0000_0000_0042n, UNIT_RESULT_SIZE);
  mounted.set([3.8929, 3.5911, 3.8929, 7]);
  const box = resultRow(results.gameObjectCorners, 0xf110_0000_0000_0005n, PICK_RESULT_SIZE);
  for (let index = 0; index < PICK_CORNER_VALUES; index++) box[index] = index * 0.5 - 3;
  box[PICK_RESULT_STAMP] = 7;
  results.seats.set(3n, { x: 0.25, y: -1, z: 3.5, hidden: false, stamp: 2 });
  results.seatFrame = 2;
  results.cameraAspect = 16 / 9;
  results.weatherStorm = 0.4;
  results.atmosphereProfile = Object.freeze({ ...DEFAULT_ATMOSPHERE_PROFILE, weatherSounds: true });
  results.atmosphereAudio = {
    kind: "rain", density: 0.7, thunder: true, indoors: false, underwater: false, wind: 0.3, gust: 0.1,
    strikes: 4, strikeDistance: 120, strikePan: -0.2, strikeStrength: 0.8,
  };
  results.fps = 143.9;
  results.indoors = true;
  results.status = "WebGL · terrain 9/25";
  return results;
}

test("22.10 ARC-2 S3a: a filled record survives structuredClone whole — it can be posted from a worker", () => {
  const results = filledRecord();
  const copy = structuredClone(results);
  assert.deepEqual(copy, results);
  assert.ok(copy.units.get(1n) instanceof Float64Array, "rows stay typed arrays");
  assert.ok(copy.gameObjectCorners !== results.gameObjectCorners, "a copy, not the same Map");
  // The readers answer the copy as they answer the original.
  const out = new Float64Array(PICK_CORNER_VALUES);
  assert.equal(resultGameObjectCorners(copy, 0xf110_0000_0000_0005n, out), true);
  assert.deepEqual([...out], [...results.gameObjectCorners.get(0xf110_0000_0000_0005n).subarray(0, PICK_CORNER_VALUES)]);
  assert.equal(resultUnitPivotHeight(copy, 0xf130_0000_0000_0042n), 3.5911);
});

test("22.10 ARC-2 S3a: the readers answer what the getters answered, for units drawn and not", () => {
  const results = filledRecord();
  // A unit the renderer holds: its row (`unit.height`, `#bodyHeight` for the shoulder and the helm).
  assert.equal(resultUnitHeight(results, 1n), 2.0272);
  assert.equal(resultUnitPivotHeight(results, 1n), 1.7254);
  assert.equal(resultUnitEyeHeight(results, 1n), 1.9);
  // One it does not hold: `unitHeight` was `this.#units.get(guid)?.height` — undefined, so the plate takes its
  // 2 yards — and `#bodyHeight` gave the clamped constant with no saddle and no seat lift.
  assert.equal(resultUnitHeight(results, 99n), undefined);
  assert.equal(resultUnitPivotHeight(results, 99n),
    cameraBodyHeight(undefined, undefined, CAMERA_PIVOT_BODY_SHARE, CAMERA_DEFAULT_PIVOT_HEIGHT) + 0 + 0);
  assert.equal(resultUnitEyeHeight(results, 99n),
    cameraBodyHeight(undefined, undefined, CAMERA_EYE_BODY_SHARE, CAMERA_DEFAULT_EYE_HEIGHT) + 0 + 0);
  // No renderer at all (`game.renderer?.…`): nothing, so each caller's own default applies as before.
  assert.equal(resultUnitHeight(undefined, 1n), undefined);
  assert.equal(resultUnitPivotHeight(undefined, 1n), undefined);
  assert.equal(resultUnitEyeHeight(undefined, 1n), undefined);
  // A game object without a drawn box: false and the caller's scratch untouched, as `gameObjectPickCorners` left it.
  const out = new Float64Array(PICK_CORNER_VALUES).fill(42);
  assert.equal(resultGameObjectCorners(results, 5n, out), false);
  assert.equal(resultGameObjectCorners(undefined, 5n, out), false);
  assert.ok(out.every((value) => value === 42));
});

test("22.10 ARC-2 S3a: rows are reused per guid and only the ones a fill did not stamp are dropped", () => {
  const rows = new Map();
  const first = resultRow(rows, 1n, UNIT_RESULT_SIZE);
  first[UNIT_RESULT_STAMP] = 1;
  resultRow(rows, 2n, UNIT_RESULT_SIZE)[UNIT_RESULT_STAMP] = 1;
  const again = resultRow(rows, 1n, UNIT_RESULT_SIZE);
  assert.equal(again, first, "the same row, no allocation");
  again[UNIT_RESULT_HEIGHT] = 1.5;
  again[UNIT_RESULT_STAMP] = 2;
  dropStaleRows(rows, UNIT_RESULT_STAMP, 2);
  assert.deepEqual([...rows.keys()], [1n], "the unit the renderer let go of has no row");
  assert.equal(rows.get(1n)[UNIT_RESULT_HEIGHT], 1.5);
  assert.equal(UNIT_RESULT_PIVOT !== UNIT_RESULT_EYE, true);
});

test("22.10 ARC-2 S3a: the renderer fills the record wherever a value it published changes", () => {
  const renderer = source("WorldRenderer3D.ts");
  // draw: one finally after the frame, so an early return or a throw still publishes.
  const draw = renderer.slice(renderer.indexOf("  draw(\n"), renderer.indexOf("  #drawFrame(\n"));
  assert.match(draw, /try \{\s*return this\.#drawFrame\([\s\S]*?\} finally \{\s*this\.#publishResults\(state\);\s*\}/);
  const at = (head) => {
    const start = renderer.indexOf(head);
    assert.ok(start >= 0, head);
    return renderer.slice(start, renderer.indexOf("\n  }\n", start));
  };
  assert.match(at("  clearWorldResources(): void {"), /this\.#publishResults\(undefined\);[^\n]*\n?$/);
  assert.match(at("  setIndoors(indoors: boolean): void {"), /this\.#results\.indoors = indoors;/);
  assert.match(at("  observeFrame(timestamp: number): number | undefined {"), /this\.#results\.fps = this\.#cadence\.fps;/);
  assert.match(at("  resetFrameCadence(): void {"), /this\.#results\.fps = this\.#cadence\.fps;/);
  assert.match(at("  endReplayEpoch(): void {"), /this\.#results\.fps = this\.#cadence\.fps;/);
  assert.match(at("  resetReplayEpoch(rngSeed: number): void {"), /this\.#publishScalars\(\);/);
  assert.match(at("  setAtmosphereEffects(profile:"), /finally \{\s*this\.#publishScalars\(\);/);
  assert.match(at("  endRenderFrame(): number | undefined {"),
    /if \(this\.#inputs\.publishStatus && this\.#renderFrameDepth === 0\) this\.#results\.status = this\.status;/);
  // The rows: every unit held, the boxes behind the overlay's own test, the seat pass, the scalars.
  const publish = at("  #publishResults(state: RenderWorld | undefined): void {");
  // S3a-review: incremental (RenderResultRows.ts), with the same math as the per-frame fill.
  assert.match(publish, /this\.#unitRows\.fill\(results\.units, this\.#units, this\.#vehiclePassengers, stamp, this\.#unitRowCompute\);/);
  assert.match(renderer, /this\.#bodyHeight\(rendered, lift, ATTACHMENT_SHOULDER_RIGHT, CAMERA_PIVOT_BODY_SHARE, CAMERA_DEFAULT_PIVOT_HEIGHT\)/);
  assert.match(renderer, /this\.#bodyHeight\(rendered, lift, ATTACHMENT_HELM, CAMERA_EYE_BODY_SHARE, CAMERA_DEFAULT_EYE_HEIGHT\)/);
  assert.match(publish, /overlaySquaredDistance\(position, subject\) < reach\) \|\| !clickableGameObject\(object\)/);
  assert.match(publish, /this\.#pickRows\.publish\(boxes, guid, object, rendered, stamp, this\.#pickRowCompute\)/);
  assert.match(publish, /this\.#vehiclePassengers\.publishSeats\(results\);/);
  const scalars = at("  #publishScalars(): void {");
  for (const field of ["cameraAspect = this.#camera.aspect", "weatherStorm = this.#weatherFade.storm",
    "atmosphereProfile = this.#atmosphereProfile", "fps = this.#cadence.fps", "indoors = this.#indoors"]) {
    assert.ok(scalars.includes(`results.${field};`), field);
  }
  // And the getters the main thread used to call are gone.
  for (const gone of [/\n  unitHeight\(/, /\n  unitPivotHeight\(/, /\n  unitEyeHeight\(/, /\n  gameObjectPickCorners\(/,
    /\n  get cameraAspect\(/, /\n  get fps\(/, /\n  get indoors\(/, /\n  get atmosphereProfile\(/]) {
    assert.doesNotMatch(renderer, gone);
  }
});

test("22.10 ARC-2 S3a: the main thread's call sites read the record, not renderer getters", () => {
  const getter = /renderer\??\.(unitHeight|unitPivotHeight|unitEyeHeight|gameObjectPickCorners)\(|renderer\??\.(cameraAspect|weatherStorm|atmosphereProfile|atmosphere|fps|indoors|status)\b/;
  for (const path of ["game/Loop.ts", "SimpleScene.ts", "ui/HeadOverlay.ts", "game/Targeting.ts", "game/WeatherAmbience.ts",
    "ui/DebugTab.ts", "framexml/FrameXmlWorldMount.ts", "ui/WindowBindings.ts"]) {
    assert.doesNotMatch(source(path), getter, path);
  }
  const loop = source("game/Loop.ts");
  assert.match(loop, /return resultUnitHeight\(game\.renderer\?\.results, guid\);/);
  assert.match(loop, /return resultGameObjectCorners\(game\.renderer\?\.results, object\.guid, out\);/);
  assert.match(loop, /bodyHeight: self === undefined \? undefined : resultUnitHeight\(game\.renderer\?\.results, self\.guid\),/);
  assert.match(loop, /aspect: game\.renderer\?\.results\.cameraAspect,/);
  assert.match(loop, /const storm = game\.renderer\?\.results\.weatherStorm \?\? 0;/);
  assert.match(loop, /gameObjectShown: loopGameObjectShown, publishStatus: statusDue,/);
  assert.match(loop, /Render: \$\{game\.renderer\.results\.status\}/);
  // The seat pass is accepted right after draw, in the same finally as the other after-draw asks.
  const call = loop.slice(loop.indexOf("renderer.draw("), loop.indexOf("renderer.renderPortraits(now)"));
  assert.match(call, /\} finally \{[\s\S]*acceptSeatResults\(renderer\.results, world\.state\.objects\);/);
  assert.match(source("ui/HeadOverlay.ts"), /resultUnitHeight\(game\.renderer\?\.results, guid\) \?\? 2/);
  assert.match(source("game/Targeting.ts"), /resultUnitHeight\(game\.renderer\?\.results, guid\) \?\? 2/);
  assert.match(source("game/WeatherAmbience.ts"), /enabled \? results\?\.atmosphereAudio : undefined/);
  const mount = source("framexml/FrameXmlWorldMount.ts");
  assert.match(mount, /framerate: \(\) => game\.renderer\?\.results\.fps \?\? 0,/);
  assert.match(mount, /playerIndoors: \(\) => liveWmoInterior\(\) \?\? game\.renderer\?\.results\.indoors === true,/);
});

// ---- 22.10 ARC-2 S3a-review: the rows are recomputed only when their inputs move --------------------------

const { PickResultRows, UnitResultRows } = await import("../dist/code/browser/RenderResultRows.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const UPDATE_BYTES_1 = UPDATE_FIELDS.GAMEOBJECT_BYTES_1.offset;

/** A stand-in for `#bodyHeight` that reads every input a unit row derives from. */
function unitMath(unit, lift, row) {
  const attachment = unit.wvm?.attachments[0]?.position[2] ?? 0;
  row[UNIT_RESULT_PIVOT] = (unit.body ? 1 : 2) * unit.height + attachment * unit.scale + (unit.mount?.seat ?? 0) + lift;
  row[UNIT_RESULT_EYE] = row[UNIT_RESULT_PIVOT] + 0.25;
}

function heldUnits() {
  const wvm = { attachments: [{ id: 5, bone: 0, position: [0, 0, 1.7254] }] };
  const unit = (height) => ({ height, wvm, scale: 1, body: undefined, mount: undefined, node: {}, resultKey: undefined });
  return new Map([[1n, unit(2.0272)], [2n, unit(1.1)], [3n, unit(3.5)]]);
}

test("22.10 ARC-2 S3a-review: an unchanged world recomputes no unit row on the second frame; a change recomputes its own", () => {
  const units = heldUnits();
  const lifts = new Map();
  const poser = { liftEpoch: 0, seatLift: (node) => lifts.get(node) ?? 0 };
  const rows = new Map();
  const fill = new UnitResultRows();
  let calls = 0;
  const compute = (unit, lift, row) => { calls++; unitMath(unit, lift, row); };
  fill.fill(rows, units, poser, 1, compute);
  assert.equal(calls, 3);
  fill.fill(rows, units, poser, 2, compute);
  assert.equal(calls, 3, "nothing moved, nothing recomputed");
  assert.equal(fill.computed, 3);
  // Each input moves one row, and only that one: height, model, scale, the pill, the saddle, the seat lift.
  const step = (mutate, stamp) => { const before = calls; mutate(); fill.fill(rows, units, poser, stamp, compute); return calls - before; };
  assert.equal(step(() => { units.get(1n).height = 2.1; }, 3), 1, "height");
  assert.equal(step(() => { units.get(2n).wvm = { attachments: [{ id: 5, bone: 0, position: [0, 0, 0.8226] }] }; }, 4), 1, "model");
  assert.equal(step(() => { units.get(3n).scale = 1.5; }, 5), 1, "scale");
  assert.equal(step(() => { units.get(3n).body = {}; }, 6), 1, "the stand-in pill");
  assert.equal(step(() => { units.get(1n).mount = { seat: 1.8657 }; }, 7), 1, "the saddle");
  assert.equal(step(() => { poser.liftEpoch++; }, 8), 0, "another passenger's lift moved: this one's did not");
  assert.equal(step(() => { lifts.set(units.get(2n).node, 0.6); poser.liftEpoch++; }, 9), 1, "its own seat lift");
  assert.equal(rows.get(2n)[UNIT_RESULT_STAMP], 9, "the stamp is the fill that last derived the row");
  // The answers are the full fill's.
  const fresh = new Map();
  for (const unit of units.values()) unit.resultKey = undefined;
  new UnitResultRows().fill(fresh, units, poser, 1, unitMath);
  for (const [guid, row] of fresh) {
    assert.deepEqual([...rows.get(guid).subarray(0, UNIT_RESULT_STAMP)], [...row.subarray(0, UNIT_RESULT_STAMP)], `${guid}`);
  }
  // A unit let go of loses its row.
  units.delete(3n);
  fill.fill(rows, units, poser, 10, compute);
  assert.deepEqual([...rows.keys()].sort(), [1n, 2n]);
});

test("22.10 ARC-2 S3a-review: a game object's box is recomputed only when its node, box or rotation inputs move", () => {
  const box = { minX: -1, minY: -1, minZ: 0, maxX: 1, maxY: 1, maxZ: 2 };
  const rendered = { node: { position: { x: 10, y: 1, z: -20 }, scale: { x: 1 } }, base: { orientation: 0.5 }, pickBox: box, pickKey: undefined };
  const object = { guid: 9n, fields: new Map(), rotation: { x: 0, y: 0, z: 0.2, w: 0.98 }, transport: undefined };
  const rows = new Map();
  const pick = new PickResultRows();
  let calls = 0;
  const compute = (_object, at, out) => {
    calls++;
    out.fill(at.node.position.x + at.node.scale.x + at.base.orientation + (_object.rotation?.z ?? 0)
      + (_object.transport?.orientation ?? 0));
    return true;
  };
  const frame = (stamp) => {
    const boxed = pick.publish(rows, 9n, object, rendered, stamp, compute) ? 1 : 0;
    if (rows.size !== boxed) dropStaleRows(rows, PICK_RESULT_STAMP, stamp);
  };
  frame(1);
  frame(2);
  assert.equal(calls, 1, "a static object: once");
  assert.equal(rows.get(9n)[PICK_RESULT_STAMP], 2, "still published, stamped by every fill");
  const step = (mutate, stamp) => { const before = calls; mutate(); frame(stamp); return calls - before; };
  assert.equal(step(() => { rendered.node.position.y += 0.5; }, 3), 1, "a lift moving");
  assert.equal(step(() => { rendered.node.scale.x = 2; }, 4), 1, "scale");
  assert.equal(step(() => { rendered.base.orientation = 1; }, 5), 1, "spawn orientation");
  assert.equal(step(() => { object.rotation.z = 0.3; }, 6), 1, "rotation written in place");
  assert.equal(step(() => { object.transport = { guid: 1n, x: 0, y: 0, z: 0, orientation: 2, seat: 0 }; }, 7), 1, "boarded");
  assert.equal(step(() => { object.transport.orientation = 2.5; }, 8), 1, "the carrier turned");
  assert.equal(step(() => { object.fields.set(UPDATE_BYTES_1, 15 << 8); }, 9), 1, "its type");
  assert.equal(step(() => { rendered.pickBox = { ...box, maxZ: 3 }; }, 10), 1, "a new model box");
  assert.equal(step(() => {}, 11), 0);
  // A frame out of range (no publish, the row dropped), then back unchanged: the row returns, not recomputed.
  dropStaleRows(rows, PICK_RESULT_STAMP, 12);
  assert.equal(rows.size, 0);
  assert.equal(step(() => {}, 13), 0);
  assert.ok(rows.get(9n), "put back");
  const expected = rendered.node.position.x + rendered.node.scale.x + rendered.base.orientation + object.rotation.z + object.transport.orientation;
  assert.equal(rows.get(9n)[0], expected, "the corners of the current inputs");
});
