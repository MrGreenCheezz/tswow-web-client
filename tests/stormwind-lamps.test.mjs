// 23.10 (7.36): Stormwind's lamps glow from afar and its lanterns glow at all (owner, 22–23.10: in the
// city lamps switched on only as one approached; Goldshire's glowed from far away).
import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { FarLightGlows } from "../dist/code/browser/FarLightGlows.js";
import { modelFixtureLights } from "../dist/code/browser/LocalLighting.js";

/** A model with an opaque post and one more batch: `texture`, `flags`, `blend`, 4 yards up. */
const model = (texture, flags = 1, blend = 0) => ({
  positions: new Float32Array([0, 0, 0, 0, 0, 4, 1, 0, 4, 0, 1, 4]),
  indices: new Uint16Array([0, 1, 2, 1, 2, 3]),
  submeshes: [{ indexStart: 0, indexCount: 3 }, { indexStart: 3, indexCount: 3 }],
  batches: [
    { submesh: 0, materialFlags: 0, blendMode: 0, textures: [0], colorIndex: 65535, textureWeight: 0 },
    { submesh: 1, materialFlags: flags, blendMode: blend, textures: [1], colorIndex: 65535, textureWeight: 0 },
  ],
  textures: [{ path: "World\\Generic\\Human\\Passive Doodads\\Lamps\\StreetLamp.blp" }, { path: texture }],
  particleEmitters: [], colours: [], textureWeights: [], globalSequences: new Uint32Array(),
});
const LAMP = "World\\Generic\\Human\\Passive Doodads\\Lamps\\StormwindStreetLamp01.m2";

test("23.10 (7.36): the city's lanterns are lit on the cinematic profile only", () => {
  // GeneralLantern01.m2: its lit body is an opaque unlit ElwynnLantern01.blp, no card, no flame.
  const lantern = model("World\\Generic\\Human\\Passive Doodads\\Lanterns\\ElwynnLantern01.blp", 3, 0);
  const name = "World\\Generic\\Human\\Passive Doodads\\Lanterns\\GeneralLantern01.m2";
  assert.equal(modelFixtureLights(lantern, name).length, 0, "the faithful heuristic is unchanged");
  assert.equal(modelFixtureLights(lantern, name, true).length, 1);
  // GeneralHangingLantern01.m2: an alpha-blended unlit Glow32.blp card.
  const hanging = model("Spells\\Glow32.blp", 17, 2);
  const hangingName = "World\\Generic\\Human\\Passive Doodads\\Lanterns\\GeneralHangingLantern01.m2";
  assert.equal(modelFixtureLights(hanging, hangingName).length, 0);
  assert.equal(modelFixtureLights(hanging, hangingName, true).length, 1);
  // A lit pane that is not unlit stays dark (GeneralLantern02.m2's ElwynnLantern02.blp, flags 4).
  assert.equal(modelFixtureLights(model("ElwynnLantern02.blp", 4, 0), "GeneralLantern02.m2", true).length, 0);
});

test("23.10 (7.36): a street lamp not built yet glows from afar, placed from a built twin", () => {
  const wvm = model("Dungeons\\Textures\\Doodads\\StormwindLampGlass.blp");
  // The built lamp, as the renderer keeps it: a placed node with the visual inside.
  const node = new THREE.Group();
  node.position.set(0, 0, 0);
  const visual = new THREE.Object3D();
  node.add(visual);
  const resident = { source: { id: -101, name: LAMP, interior: false }, node, visual, wvm };
  const placements = new Map([[-101, resident]]);
  // The streamed tile list: the built lamp, an unbuilt twin 150 yards off, a room's lamp beside it.
  const objects = [
    { id: -101, name: LAMP, interior: false, at: 0 },
    { id: -102, name: LAMP, interior: false, at: 150 },
    { id: -103, name: LAMP, interior: true, at: 152 },
  ];
  const streamed = {
    objects,
    place: (object, target) => target.makeTranslation(object.at, 0, 0),
  };
  const glows = new FarLightGlows();
  const camera = new THREE.Vector3(0, 2, 0);
  for (let frame = 0; frame < 70; frame++) glows.update(placements, camera, 0, Number.POSITIVE_INFINITY, streamed);
  assert.equal(glows.sourceCount, 2, "the built lamp and its outdoor twin; never the room's lamp");
  assert.ok(glows.mesh.count >= 1, "the twin at 150 yards draws a far glow");
  // Without the streamed list only the built lamp, inside the near band, is a source.
  const old = new FarLightGlows();
  for (let frame = 0; frame < 70; frame++) old.update(placements, camera, 0);
  assert.equal(old.sourceCount, 1);
  assert.equal(old.mesh.count, 0);
});
