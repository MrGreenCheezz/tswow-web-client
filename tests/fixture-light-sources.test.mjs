// 06.10-render-fix — owner, 06.10, building furniture: «мебель любит менять цвет».
//
// Since the visual-tile-v5 generation (05.10-A7b-1, 7.03 slice 1) a WMO doodad that only outdoor
// groups own is `interior: false`. The renderer's fixture-light pass used `interior` as its "not a
// building's doodad" test, so every façade lamp became one of the four (enhanced) or eight
// (cinematic) nearest-to-camera point lights: Stormwind tiles carry 57–94 such lamps each
// (STORMWINDSTREETLAMP01, GENERALLANTERN01, …), and as the camera moves the nearest-N set reshuffles
// and the pools on the furniture, crates and benches around them switch on and off. Before 05.10 a
// building's doodads never lit anything (their room light is baked); this file pins that again.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { fixtureLightSource } from "../dist/code/browser/FixtureLightSources.js";

/** A WMO doodad as `generate-visual-tile.mjs` ids it: -(placement * 1e6 + ordinal + 1). */
const doodadId = (placement, ordinal) => -(placement * 1_000_000 + ordinal + 1);

test("a building's doodad never lights, indoor or outdoor", () => {
  const lamp = "WORLD\\GENERIC\\HUMAN\\PASSIVE DOODADS\\STREETLAMPS\\STORMWINDSTREETLAMP01.M2";
  // An outdoor-only façade lamp of the v5 tile (interior: false, no MODD light).
  assert.equal(fixtureLightSource({ id: doodadId(10047, 12), interior: false, name: lamp }), false);
  // The old v4 form and an indoor lamp keep being excluded.
  assert.equal(fixtureLightSource({ id: doodadId(10047, 12), interior: true, name: lamp }), false);
  assert.equal(fixtureLightSource({ id: doodadId(71414, 0), interior: true, localLight: [90, 60, 40, 255], name: lamp }), false);
});

test("a terrain lamp (ADT placement) still lights, unless it is indoors or room-lit", () => {
  assert.equal(fixtureLightSource({ id: 136661, name: "ELWYNNLAMPPOST01.M2" }), true);
  assert.equal(fixtureLightSource({ id: 136661, interior: false, name: "ELWYNNLAMPPOST01.M2" }), true);
  assert.equal(fixtureLightSource({ id: 136661, interior: true, name: "ELWYNNLAMPPOST01.M2" }), false);
  assert.equal(fixtureLightSource({ id: 136661, localLight: [1, 2, 3, 255], name: "X.M2" }), false);
});

test("the renderer's fixture-light pass asks this predicate for environment placements", async () => {
  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("#updateFixtureLights(now: number): void {"));
  const loop = body.slice(0, body.indexOf("for (const rendered of this.#gameObjects.values())"));
  assert.match(loop, /if \(!fixtureLightSource\(rendered\.source\)\) continue;/);
  assert.doesNotMatch(loop, /if \(rendered\.interior \|\| rendered\.source\.localLight\) continue;/);
});
