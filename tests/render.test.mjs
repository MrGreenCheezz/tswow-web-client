import assert from "node:assert/strict";
import test from "node:test";
import {
  CAMERA_DEFAULT_DISTANCE, CAMERA_DEFAULT_EYE_HEIGHT, CAMERA_DEFAULT_PIVOT_HEIGHT, CAMERA_EYE_BODY_SHARE,
  CAMERA_FOV_DEGREES, CAMERA_MAX_PIVOT_HEIGHT, CAMERA_PIVOT_BODY_SHARE, cameraBodyHeight, createCamera,
  projectPoint,
} from "../dist/code/browser/SimpleScene.js";
import { appearanceKey } from "../dist/code/browser/CharacterAtlas.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { WorldState, fieldFloat, shortestTurn } from "../dist/code/world/WorldState.js";
import * as THREE from "three";
import {
  ADT_MODEL_TO_SCENE, ENVIRONMENT_SCENERY_BUDGET, buildTerrainMaterial, locatedWmoFog, mountInstanceMatches,
  placeEnvironmentNode, placementDistance, selectEnvironment, shouldRefreshWaterForNeighbour,
  staticWmoPlacementMatches, stateVisualKey, surfaceNormal, uniqueVisualWmoPlacement,
  waterCornerDepths, waterCornerHeight,
} from "../dist/code/browser/WorldRenderer3D.js";
import { EnvironmentClient, MODEL_BACKGROUND_RESERVATION_MS } from "../dist/code/browser/Terrain.js";
import { IMAGE_RETRY_BACKOFF_MS } from "../dist/code/browser/CharacterAtlas.js";
import { M2_TO_SCENE } from "../dist/code/browser/AnimatedModel.js";
import { buildModel } from "../dist/code/browser/ModelBuild.js";
import { encodeWvm9 } from "../tools/wvm.mjs";
import { decodeWvm9 } from "../dist/code/browser/Wvm.js";
import { mountNesting, mountSeatOffset } from "../dist/code/browser/Attachment.js";

test("state visuals retain identical authored occurrences and distinguish scale", () => {
  const effect = {
    spellId: 120, path: "Spells\\ConeofCold_Mouth.m2", attachment: 17, scale: 1,
    occurrence: "model-attach:1061", transform: {
      offset: [0, 0, 0], rotation: [0, 1.57, 0],
    },
  };
  const first = stateVisualKey(7n, effect);
  const duplicate = stateVisualKey(7n, { ...effect, occurrence: "model-attach:1062" });
  assert.notEqual(first, duplicate, "two equal rows keep two renderer nodes");
  assert.deepEqual(new Set([first, duplicate]), new Set([
    stateVisualKey(7n, effect),
    stateVisualKey(7n, { ...effect, occurrence: "model-attach:1062" }),
  ]), "stable row identity survives the next reconciliation");
  assert.notEqual(first, stateVisualKey(7n, { ...effect, scale: 1.25 }),
    "a changed authored scale is an update, not the old visual identity");
});

test("terrain is diffuse-only while retaining normal lighting and fog", () => {
  const material = buildTerrainMaterial();
  assert.equal(material.isMeshLambertMaterial, true, "terrain must not add a Standard specular lobe");
  assert.equal(material.fog, true, "terrain keeps scene fog");
  assert.equal("metalness" in material, false, "terrain has no metal channel");
  assert.equal("roughness" in material, false, "terrain has no plastic roughness channel");
});

test("a raw collision WMO matches exactly one visual placement by basename and transform, never id", () => {
  const raw = {
    map: 0,
    spawnId: 31446,
    key: "0:31446",
    modelName: "GoldshireInn.wmo",
    canonicalModelName: "goldshireinn.wmo",
    x: -9461.82,
    y: 63.31,
    z: 56.23,
    rotationX: 0,
    rotationY: 270,
    rotationZ: 0,
    scale: 1,
  };
  const visual = {
    id: 71414,
    kind: "wmo",
    name: "World\\wmo\\Azeroth\\Buildings\\GoldshireInn.wmo",
    x: raw.x,
    y: raw.y,
    z: raw.z,
    rotationX: 0,
    rotationY: -90,
    rotationZ: 0,
    scale: 1,
  };
  assert.equal(staticWmoPlacementMatches(raw, visual), true,
    "raw and visual ids differ; wrapped rotation and canonical basename identify the same spawn");
  assert.equal(uniqueVisualWmoPlacement(raw, [visual])?.id, 71414);
  assert.equal(staticWmoPlacementMatches(raw, { ...visual, x: visual.x + 2e-4 }), false,
    "the fail-closed tolerance is tighter than any measured corpus delta");
  assert.equal(uniqueVisualWmoPlacement(raw, [visual, { ...visual, id: 99999 }]), undefined,
    "an ambiguous duplicate must leave zone fog in force");
});

test("MFOG comes from the collision-selected visual group, not overlapping group boxes", () => {
  const fog = (end, colour) => ({
    flags: 1,
    position: [0, 0, 0],
    innerRadius: 0,
    outerRadius: 0,
    land: { end, scale: 0.25, colour },
    water: { end, scale: -1, colour },
  });
  const bounds = { minX: -10, minY: -10, minZ: -2, maxX: 10, maxY: 10, maxZ: 8 };
  const group = (flags, fogIds) => ({ flags, indoor: true, bounds, fogIds });
  const model = {
    fogs: [
      fog(444.4445, [255, 255, 255]),
      fog(194.4444, [0xfa, 0xd8, 0x90]),
      fog(83.3333, [0xfd, 0xcf, 0x9e]),
    ],
    // Both boxes contain the eye. Only the collision floor says group 1 won.
    groups: [group(0x2000, [1]), group(0x2001, [0, 2])],
  };
  const selected = locatedWmoFog(model, { groupIndex: 1, groupFlags: 0x2001 }, { x: 0, y: 0, z: 2 });
  assert.ok(selected);
  assert.equal(selected.land.end, 83.3333);
  assert.deepEqual(selected.land.colour, [0xfd, 0xcf, 0x9e],
    "the white sentinel is skipped inside the exact group");
  assert.equal(locatedWmoFog(model, { groupIndex: 1, groupFlags: 0x2000 }, { x: 0, y: 0, z: 2 }), undefined,
    "a visual/collision flag mismatch fails closed");
  assert.equal(locatedWmoFog(model, { groupIndex: 1, groupFlags: 0x2001 }, { x: 20, y: 0, z: 2 }), undefined,
    "a stale locator outside the group's own box fails closed");
});

test("water depth is continuous at shared corners instead of repeating a cell centre", () => {
  const sharedGround = 8;
  const left = waterCornerDepths([12, 13, 12, 13], [sharedGround, 8, sharedGround, 8]);
  const right = waterCornerDepths([13, 14, 13, 14], [8, 8, 8, 8]);
  assert.equal(left[1], right[0], "adjacent quads agree on their shared corner fade");
  assert.deepEqual(left, [4, 5, 4, 5]);
  assert.equal(waterCornerDepths([12], [Number.NEGATIVE_INFINITY])[0], 10, "unknown ground keeps the deep-water fallback");
});

test("water corners average compatible wet neighbours across liquid data formats", () => {
  const water = (height, cells, type = 1, entry = 81) => ({ height, cells, type, entry });
  const classes = new Map([[81, "water"], [182, "magma"]]);
  const mixed = waterCornerHeight(water(10, true), [water(14, false), undefined, water(12, true)], "water", classes);
  assert.equal(mixed, 12, "uniform and per-cell samples share one wet corner");
  assert.equal(waterCornerHeight(water(14, false), [water(10, true), undefined, water(12, true)], "water", classes), mixed,
    "the shared result does not depend on which adjacent cell is the base");
  assert.equal(waterCornerHeight(water(10, false), [water(14, false)], "water", classes), 12,
    "uniform neighbours are smoothed too");
  assert.equal(waterCornerHeight(water(10, true), [undefined, water(99, true, 4, 182)], "water", classes), 10,
    "dry and incompatible-class samples never pull a corner into another body");
});

test("a known-dry tile skips neighbour-only water rebuilds", () => {
  assert.equal(shouldRefreshWaterForNeighbour(undefined), false);
  assert.equal(shouldRefreshWaterForNeighbour([{}]), true, "wet tiles still refresh shared corners");
});

test("overlay projection uses the same intrinsics as the WebGL perspective camera", () => {
  const width = 1280;
  const height = 720;
  // THREE.PerspectiveCamera puts the pixel focal length at (height / 2) / tan(fov / 2) on both
  // axes; the Canvas overlay has to agree or its markers slide off the terrain below them.
  const expectedFocal = height / 2 / Math.tan(CAMERA_FOV_DEGREES * Math.PI / 360);
  const camera = createCamera({ x: 0, y: 0, z: 0, orientation: 0 }, 0, 0, 20);

  const ahead = {
    x: camera.position.x + camera.forward.x * 10,
    y: camera.position.y + camera.forward.y * 10,
    z: camera.position.z + camera.forward.z * 10,
  };
  const center = projectPoint(ahead, camera, width, height);
  assert.ok(center);
  assert.ok(Math.abs(center.x - width / 2) < 1e-6);
  assert.ok(Math.abs(center.y - height / 2) < 1e-6, "the horizon must sit on the optical axis");

  const offset = projectPoint({
    x: ahead.x + camera.right.x,
    y: ahead.y + camera.right.y,
    z: ahead.z + camera.right.z,
  }, camera, width, height);
  assert.ok(offset);
  assert.ok(Math.abs(offset.x - (width / 2 + expectedFocal / 10)) < 1e-6);

  const above = projectPoint({
    x: ahead.x + camera.up.x,
    y: ahead.y + camera.up.y,
    z: ahead.z + camera.up.z,
  }, camera, width, height);
  assert.ok(above);
  assert.ok(Math.abs(above.y - (height / 2 - expectedFocal / 10)) < 1e-6);
});

test("camera zoom keeps the character in frame instead of passing through it", () => {
  // Level, so the boom is the whole of the offset and the numbers can be read off. Since К1 the
  // camera is the pivot swung straight back, so at pitch zero these are exactly -21.31 and -4.00
  // against -20.313 and -2.975 before, when the aim point in front of the character ate seven
  // yards of every boom.
  const player = { x: 0, y: 0, z: 0, orientation: 0 };
  const far = createCamera(player, 0, 0, CAMERA_DEFAULT_DISTANCE);
  const near = createCamera(player, 0, 0, 4);
  assert.ok(far.position.x < near.position.x, "zooming in moves the camera towards the character");
  assert.ok(near.position.x < 0, "the camera stays behind the character at the closest zoom");
  assert.ok(Math.abs(far.position.x + CAMERA_DEFAULT_DISTANCE) < 1e-9, `${far.position.x}`);
  assert.ok(Math.abs(near.position.x + 4) < 1e-9, `${near.position.x}`);
});

test("movement packets are played out instead of teleporting other units", () => {
  const state = new WorldState();
  state.move(7n, { flags: 0, position: { x: 0, y: 0, z: 0, orientation: 0 } }, 0);
  assert.deepEqual(state.objects.get(7n).position, { x: 0, y: 0, z: 0, orientation: 0 });

  state.move(7n, { flags: 1, position: { x: 9, y: 0, z: 0, orientation: 0 } }, 1000);
  assert.equal(state.objects.get(7n).position.x, 0, "the new position is not applied at once");

  state.updateMotions(1090);
  assert.ok(Math.abs(state.objects.get(7n).position.x - 4.5) < 1e-6);

  state.updateMotions(1180);
  assert.equal(state.objects.get(7n).position.x, 9);
  assert.equal(state.objects.get(7n).glide, undefined);

  // Far enough away it is a teleport or a correction, and has to land immediately.
  state.move(7n, { flags: 0, position: { x: 900, y: 0, z: 0, orientation: 0 } }, 2000);
  assert.equal(state.objects.get(7n).position.x, 900);
});

test("the controlled character is never smoothed behind its own prediction", () => {
  const state = new WorldState();
  state.selfGuid = 3n;
  state.move(3n, { flags: 0, position: { x: 0, y: 0, z: 0, orientation: 0 } }, 0);
  state.move(3n, { flags: 1, position: { x: 2, y: 0, z: 0, orientation: 0 } }, 100);
  assert.equal(state.objects.get(3n).position.x, 2);
  assert.equal(state.objects.get(3n).glide, undefined);
});

test("facing is interpolated through the shorter side of the circle", () => {
  assert.ok(Math.abs(shortestTurn(3, -3) - (Math.PI * 2 - 6)) < 1e-9);
  assert.ok(Math.abs(shortestTurn(-3, 3) + (Math.PI * 2 - 6)) < 1e-9);

  const state = new WorldState();
  state.move(5n, { flags: 0, position: { x: 0, y: 0, z: 0, orientation: 3 } }, 0);
  state.move(5n, { flags: 0, position: { x: 0, y: 0, z: 0, orientation: -3 } }, 0);
  state.updateMotions(90);
  const orientation = state.objects.get(5n).position.orientation;
  assert.ok(orientation > 3, "turning past π must not spin the long way around");
});

test("unit sizes are reinterpreted from their raw update-field words", () => {
  const object = { fields: new Map() };
  const raw = new DataView(new ArrayBuffer(4));
  raw.setFloat32(0, 1.25, true);
  object.fields.set(UPDATE_FIELDS.UNIT_FIELD_BOUNDINGRADIUS.offset, raw.getUint32(0, true));
  assert.equal(fieldFloat(object, UPDATE_FIELDS.UNIT_FIELD_BOUNDINGRADIUS.offset), 1.25);
  assert.equal(fieldFloat(object, UPDATE_FIELDS.UNIT_FIELD_COMBATREACH.offset), undefined);
});

test("two characters of one race are two builds, not one", () => {
  // Everything built from a character model depends on the appearance: which files are painted
  // into the body, which hair texture fills the type 6 slot, which geosets are drawn. The key
  // used to be the model path plus the display record's texture list, and every playable race
  // leaves that list empty — so all fifteen thousand character displays shared 41 keys and the
  // first human male in view lent his skin, face, hair and armour to every human male after him.
  const look = (body, hair, geosets) => ({ body: body.map((path) => ({ path })), hair, geosets });

  const one = look(["HumanMaleSkin00_00.blp", "HumanMaleFaceUpper00_00.blp"], "Hair00_00.blp", [0, 702]);
  const same = look(["HumanMaleSkin00_00.blp", "HumanMaleFaceUpper00_00.blp"], "Hair00_00.blp", [0, 702]);
  assert.equal(appearanceKey(one), appearanceKey(same), "the same look is the same build");

  for (const other of [
    look(["HumanMaleSkin00_05.blp", "HumanMaleFaceUpper00_00.blp"], "Hair00_00.blp", [0, 702]),
    look(["HumanMaleSkin00_00.blp", "HumanMaleFaceUpper00_03.blp"], "Hair00_00.blp", [0, 702]),
    look(["HumanMaleSkin00_00.blp", "HumanMaleFaceUpper00_00.blp"], "Hair00_04.blp", [0, 702]),
    look(["HumanMaleSkin00_00.blp", "HumanMaleFaceUpper00_00.blp"], "Hair00_00.blp", [0, 702, 402]),
  ]) {
    assert.notEqual(appearanceKey(one), appearanceKey(other), "a different look is a different build");
  }

  // Armour is part of it: putting gloves on changes both the body texture and the geosets.
  const bare = look(["HumanMaleSkin00_00.blp"], "", [0, 401, 501]);
  const gloved = look(["HumanMaleSkin00_00.blp", "Cloth_B_01Yellow_Glove_AL_U.blp"], "", [0, 402, 501]);
  assert.notEqual(appearanceKey(bare), appearanceKey(gloved));
});

test("a building's furniture cannot spend the whole environment budget", () => {
  // The Goldshire tile: 1,302 things standing on the terrain against 6,638 doodads belonging to
  // the WMOs, all of the latter packed inside the buildings. Ranked as one set by distance, the
  // 320th nearest object at the Lion's Pride was 39.5 m away and nine in ten of them were the
  // inn's utensils, jars and book stacks, so every tree and both buildings went undrawn.
  const objects = [];
  for (let index = 0; index < 4000; index++) {
    objects.push({ id: -(index + 1), kind: "m2", name: "JAR.M2", interior: true, x: 5, y: 5, z: 0,
      rotationX: 0, rotationY: 0, rotationZ: 0, scale: 1 });
  }
  for (let index = 0; index < 400; index++) {
    objects.push({ id: index + 1, kind: "m2", name: "ELWYNNTREECANOPY01.M2", x: 60 + index * 0.4, y: 0, z: 0,
      rotationX: 0, rotationY: 0, rotationZ: 0, scale: 1 });
  }
  const player = { x: 0, y: 0, z: 0, orientation: 0 };

  const selected = selectEnvironment(objects, player);
  const trees = selected.filter(({ object }) => object.id > 0);
  // Loose outdoor M2s now hold the scenery quota, which these 400 trees do not fill.
  assert.equal(trees.length, Math.min(400, ENVIRONMENT_SCENERY_BUDGET), "every slot the terrain is allowed must go to the terrain");
  assert.ok(trees.at(-1).distance > 180, "the trees drawn have to reach past the near furniture");

  const furniture = selected.filter(({ object }) => object.id < 0);
  assert.equal(furniture.length, 360, "the interior keeps its own allowance and no more");

  // And an object with no flag at all - a tile cached before the flag existed - counts as terrain.
  const untagged = selectEnvironment(objects.map(({ interior, ...rest }) => rest), player);
  assert.equal(untagged.length, ENVIRONMENT_SCENERY_BUDGET);
});

test("a doodad built from its own materials is still placed where the tile puts it", () => {
  // The WVM5 branch of #modelNode used to return the built mesh directly, before the placement at
  // the end of the method ran. So every M2 doodad in the world - Elwynn's trees, its fences, its
  // signposts - was built correctly and then drawn at the map origin, unrotated and unscaled.
  // Buildings kept working only because a WMO still goes through the older branch.
  const object = {
    id: 1, kind: "m2", name: "ELWYNNTREECANOPY01.M2",
    x: -9464.5, y: 42.25, z: 61.5,
    rotationX: 0, rotationY: 0, rotationZ: 0, scale: 1.75,
    quaternionX: 0, quaternionY: Math.SQRT1_2, quaternionZ: 0, quaternionW: Math.SQRT1_2,
  };
  const node = placeEnvironmentNode(new THREE.Group(), object);

  // The scene is Y-up and the world is Z-up, so the tile's z becomes the height and its y flips.
  assert.deepEqual([node.position.x, node.position.y, node.position.z], [-9464.5, 61.5, -42.25]);
  assert.equal(node.scale.x, 1.75);
  assert.ok(Math.abs(node.quaternion.y - Math.SQRT1_2) < 1e-6);

  // Without a quaternion the placement falls back to the tile's Euler angles, and still lands.
  const { quaternionX, quaternionY, quaternionZ, quaternionW, ...euler } = object;
  const fallback = placeEnvironmentNode(new THREE.Group(), { ...euler, rotationY: 90 });
  assert.deepEqual([fallback.position.x, fallback.position.y, fallback.position.z], [-9464.5, 61.5, -42.25]);
  assert.ok(Math.abs(fallback.quaternion.length() - 1) < 1e-6, "the fallback rotation has to be a unit quaternion");
});

test("a doodad's mesh is converted into the frame its tile rotation is written in", () => {
  // The older artifact bakes VMAP_TO_THREE into every vertex as it decodes; a WVM5 model keeps
  // model space and carries the conversion as a rotation. Both the tile's Euler angles and a WMO
  // doodad's quaternion are conjugated by that same matrix where they are written, so the mesh
  // has to be turned by it too. The unit path's M2_TO_SCENE is half a turn about the vertical
  // away from it - invisible on a tree, wrong on a fence or a signpost.
  const model = new THREE.Vector3(1, 2, 3).applyQuaternion(ADT_MODEL_TO_SCENE);
  assert.ok(Math.abs(model.x - -1) < 1e-6 && Math.abs(model.y - 3) < 1e-6 && Math.abs(model.z - 2) < 1e-6,
    `expected (-1, 3, 2), got (${model.x}, ${model.y}, ${model.z})`);

  const unit = new THREE.Vector3(1, 2, 3).applyQuaternion(M2_TO_SCENE);
  assert.ok(Math.abs(unit.x - 1) < 1e-6, "the unit conversion is a different frame and stays that way");
});

test("terrain normals come from the height field, so a tile boundary has no seam in it", () => {
  const step = 533.3333333333334 / 128;

  // Flat ground points straight up. Compared by distance rather than by value: a flat field's
  // horizontal components come out of the cross product as negative zero, and -0 is not 0 to a
  // strict deep-equal.
  const flat = surfaceNormal(10, 10, 10, 10, step);
  assert.ok(
    Math.abs(flat[0]) < 1e-9 && Math.abs(flat[1] - 1) < 1e-9 && Math.abs(flat[2]) < 1e-9,
    `expected (0, 1, 0), got (${flat})`,
  );

  // A slope rising to the north tips the normal away from north. World x is north and the scene
  // draws it as scene x, so the normal leans toward -x.
  const northward = surfaceNormal(step, -step, 0, 0, step);
  assert.ok(northward[0] < -0.7, `expected a normal leaning south, got ${northward}`);
  assert.ok(Math.abs(northward[2]) < 1e-9);
  assert.ok(Math.abs(Math.hypot(...northward) - 1) < 1e-9);

  // A slope rising to the west leans the normal east. World y is west and the scene draws it as
  // -z, so leaning away from west is leaning toward +z.
  const westward = surfaceNormal(0, 0, step, -step, step);
  assert.ok(westward[2] > 0.7, `expected a normal leaning east, got ${westward}`);
  assert.ok(Math.abs(westward[0]) < 1e-9);

  // The point of the change: the same four samples give the same normal whichever tile is asking,
  // because they come from the field and not from the faces one tile happens to own. Measured on
  // the join between tiles 49-31 and 50-31, a one-sided normal was 26.9 degrees out on average
  // and 88.5 at worst.
  const fromEast = surfaceNormal(12, 8, 5, 7, step);
  const fromWest = surfaceNormal(12, 8, 5, 7, step);
  assert.deepEqual(fromEast, fromWest);

  // A one-sided difference — which is all a tile edge could see before — is a different answer.
  const oneSided = surfaceNormal(12, 12, 5, 7, step);
  assert.notDeepEqual(oneSided, fromEast);
});

test("a city is measured from its walls, not from the pin that placed it", () => {
  // Stormwind is one MODF placement at (-8931.6, 539.3) whose box spans 1488 by 1488 yards.
  // Ranked by the distance to that point, five of its seven districts fall outside the 230-metre
  // range and the city simply vanishes as a player walks into it: Old Town 260 m, the Mage
  // Quarter 331, Cathedral Square 413, the Slaughtered Lamb 465, the Dwarven District 508.
  const city = {
    id: 1, kind: "wmo", name: "Stormwind.wmo",
    x: -8931.6, y: 539.3, z: 102,
    rotationX: 0, rotationY: 38.5, rotationZ: 0, scale: 1,
    // The real box, read from the MODF record of Azeroth_31_48 with uniqueId 10047. Note where
    // the placement point sits in it: 267 yards west of the box's own centre, which is why
    // measuring to the point does not merely under-reach, it under-reaches lopsidedly.
    bounds: { minX: -9408.3, maxX: -7920.2, minY: -25, maxY: 1463.3, minZ: 2.2, maxZ: 378.6 },
  };
  const districts = [
    ["Trade District", -8831, 619],
    ["Old Town", -8721, 386],
    ["Mage Quarter", -8995, 864],
    ["Cathedral Square", -8603, 789],
    ["Dwarven District", -8427, 599],
  ];
  for (const [name, x, y] of districts) {
    const player = { x, y, z: 100, orientation: 0 };
    assert.equal(placementDistance(city, player), 0, `${name}: the player is inside the building`);
    const chosen = selectEnvironment([city], player);
    assert.equal(chosen.length, 1, `${name}: and the city is drawn`);
  }
  // A point genuinely outside still measures to the nearest wall rather than to the centre.
  const outside = { x: -9508.3, y: 539.3, z: 100, orientation: 0 };
  assert.ok(Math.abs(placementDistance(city, outside) - 100) < 1e-6, "a hundred yards west of the west wall");

  // Anything without a box is still its own point, which is what a tree is.
  const tree = { id: 2, kind: "m2", name: "Tree.m2", x: 10, y: 0, z: 0, rotationX: 0, rotationY: 0, rotationZ: 0, scale: 1 };
  assert.equal(placementDistance(tree, { x: 0, y: 0, z: 0, orientation: 0 }), 10);
});

test("same-turn critical models take the first slots and queued promotion stays deduplicated", async () => {
  const original = globalThis.fetch;
  const started = [];
  const pending = [];
  const artifact = new ArrayBuffer(16);
  new Uint8Array(artifact).set([0x57, 0x56, 0x4d, 0x31]);
  const response = () => ({ ok: true, status: 200, arrayBuffer: async () => artifact });
  const settle = async () => {
    for (let turn = 0; turn < 4; turn++) await new Promise((resolve) => setImmediate(resolve));
  };
  globalThis.fetch = (url) => {
    const address = new URL(String(url));
    assert.equal(address.pathname, "/visual/model");
    const path = address.searchParams.get("path");
    started.push(path);
    return new Promise((resolve) => pending.push({ path, resolve, settled: false }));
  };
  const finish = (path) => {
    const request = pending.find((entry) => entry.path === path && !entry.settled);
    assert.ok(request, `${path} has an active request`);
    request.settled = true;
    request.resolve(response());
  };

  const background = ["World\\A.m2", "World\\B.m2", "World\\C.m2", "World\\D.m2"];
  const promoted = "World\\Promoted.m2";
  const direct = "World\\DirectCritical.m2";
  const late = "World\\LateCritical.m2";
  try {
    const client = new EnvironmentClient("ws://127.0.0.1:8090/world");
    for (const path of background) assert.equal(client.model(path, "background"), undefined);
    assert.equal(client.model(promoted, "background"), undefined);
    assert.equal(client.model(direct, "critical"), undefined);
    assert.equal(client.model(promoted, "critical"), undefined, "a queued background request is promoted");
    assert.equal(client.model(promoted, "critical"), undefined, "repeated promotion is deduplicated");
    assert.deepEqual(started, [], "same-turn calls are batched before slots are assigned");

    await settle();
    assert.deepEqual(
      started,
      [promoted, direct, background[0], background[1]],
      "critical requests take the initial four-slot batch ahead of background FIFO",
    );
    assert.equal(started.filter((path) => path === promoted).length, 1, "promotion starts one fetch");

    assert.equal(client.model(late, "critical"), undefined);
    await settle();
    assert.equal(started.length, 4, "priority never interrupts the four active requests");

    finish(background[0]);
    await settle();
    assert.equal(started[4], late, "the next free slot takes queued critical work");

    finish(background[1]);
    await settle();
    assert.equal(started[5], background[2], "background FIFO resumes after critical work");
  } finally {
    // Resolving one wave lets queued requests enter the next one. Drain all of them before
    // restoring the global fetch stub so no model request can leak into a later test.
    for (let wave = 0; wave < 4; wave++) {
      for (const request of pending) {
        if (request.settled) continue;
        request.settled = true;
        request.resolve(response());
      }
      await settle();
    }
    globalThis.fetch = original;
  }
});

test("cold model loading reserves the fourth slot for critical work until its real timer expires", async () => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const pending = [];
  const started = [];
  const timers = new Map();
  let nextTimer = 1;
  const artifact = new ArrayBuffer(16);
  new Uint8Array(artifact).set([0x57, 0x56, 0x4d, 0x31]);
  const response = () => ({ ok: true, status: 200, arrayBuffer: async () => artifact });
  const settle = async () => {
    for (let turn = 0; turn < 4; turn++) await new Promise((resolve) => setImmediate(resolve));
  };
  globalThis.setTimeout = (callback, delay) => {
    assert.equal(delay, MODEL_BACKGROUND_RESERVATION_MS);
    const id = nextTimer++;
    timers.set(id, callback);
    return id;
  };
  globalThis.clearTimeout = (id) => timers.delete(id);
  globalThis.fetch = (url) => {
    const path = new URL(String(url)).searchParams.get("path");
    started.push(path);
    return new Promise((resolve) => pending.push({ path, resolve, settled: false }));
  };
  const finish = (path) => {
    const request = pending.find((entry) => entry.path === path && !entry.settled);
    assert.ok(request, `${path} has an active request`);
    request.settled = true;
    request.resolve(response());
  };

  try {
    const timed = new EnvironmentClient("ws://127.0.0.1:8090/world");
    timed.model("TimedNormal.m2", "normal");
    timed.model("TimedBackgroundA.m2", "background");
    timed.model("TimedBackgroundB.m2", "background");
    timed.model("TimedBackgroundC.m2", "background");
    await settle();
    assert.deepEqual(started, ["TimedNormal.m2", "TimedBackgroundA.m2", "TimedBackgroundB.m2"],
      "normal plus background work can occupy only three cold-start slots");
    assert.equal(timers.size, 1, "reservation owns a real expiry timer");
    [...timers.values()][0]();
    timers.clear();
    await settle();
    assert.equal(started[3], "TimedBackgroundC.m2", "timer expiry drains the fourth slot without a completion");

    const urgent = new EnvironmentClient("ws://127.0.0.1:8090/world");
    for (const path of ["UrgentA.m2", "UrgentB.m2", "UrgentC.m2", "UrgentD.m2"]) {
      urgent.model(path, "background");
    }
    await settle();
    assert.deepEqual(started.slice(4), ["UrgentA.m2", "UrgentB.m2", "UrgentC.m2"]);
    urgent.model("SelfCritical.m2", "critical");
    await settle();
    assert.equal(started[7], "SelfCritical.m2", "critical work takes the reserved live slot");
    assert.equal(timers.size, 0, "starting critical work cancels the reservation timer");
    finish("SelfCritical.m2");
    await settle();
    assert.equal(started[8], "UrgentD.m2", "after critical starts, background returns to four-slot throughput");
  } finally {
    for (const request of pending) {
      if (request.settled) continue;
      request.settled = true;
      request.resolve(response());
    }
    await settle();
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test("Ж0 a model that did not come is asked for again, and one the client has not got is not", async () => {
  // The Т6 ladder, on the path that was left without it. `EnvironmentClient` wrote a model off on
  // the *first* failure of any kind — `#models.set(key, null)`, with `#requestedModels` then
  // blocking it from ever being queued again — so a generation lane busy for one second cost a
  // building for the life of the tab. Orgrimmar's 92 models were published over 130.8 s of the
  // owner's own session at 1.42 s apiece, which is a long time to be one dead child away from a
  // hole in the city; and until this same slice the hole was a grey box the size of the city.
  //
  // The two answers mean different things only because `/visual/model` learnt to tell them apart
  // in this same slice: 404 is the archives not holding the model, 500 is this second's problem.
  const answers = new Map();
  const asked = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const address = String(url);
    asked.push(address);
    const visualPath = address.includes("/visual/model?")
      ? encodeURIComponent(new URL(address).searchParams.get("path") ?? "")
      : address.replace(/^.*\/environment\/model\//, "");
    return answers.get(visualPath) ?? { ok: false, status: 404 };
  };
  const clock = { now: 1_000 };
  const settle = async () => { for (let turn = 0; turn < 4; turn++) await new Promise((resolve) => setImmediate(resolve)); };
  const visualModels = (path) => asked.filter((address) => address.includes(`/visual/model?path=${path}`)).length;
  // The separator a real ADT placement carries, and the reason the addresses below are `%5C`.
  const BROKEN = "World\\Hut.wmo";
  const GONE = "World\\Absent.m2";
  const LATE = "World\\Tower.wmo";
  try {
    const client = new EnvironmentClient("ws://127.0.0.1:8090/world", () => clock.now);
    const broken = "World%5CHut.wmo";
    const gone = "World%5CAbsent.m2";
    const late = "World%5CTower.wmo";
    answers.set(broken, { ok: false, status: 500 });

    assert.equal(client.model(BROKEN), undefined);
    await settle();
    assert.equal(visualModels(broken), 1);

    // Inside the first wait, nothing is asked for.
    clock.now = 1_000 + IMAGE_RETRY_BACKOFF_MS[0] - 1;
    assert.equal(client.model(BROKEN), undefined);
    await settle();
    assert.equal(visualModels(broken), 1, "the wait is a wait");

    // Three retries, 2 s, 8 s and 30 s after the failure before each.
    let at = 1_000;
    for (const [index, wait] of IMAGE_RETRY_BACKOFF_MS.entries()) {
      at += wait;
      clock.now = at;
      assert.equal(client.model(BROKEN), undefined);
      await settle();
      assert.equal(visualModels(broken), index + 2, `retry ${index + 1} happened`);
    }

    // And then it is left alone, however long the session runs.
    clock.now = at + 86_400_000;
    assert.equal(client.model(BROKEN), undefined);
    await settle();
    assert.equal(visualModels(broken), IMAGE_RETRY_BACKOFF_MS.length + 1, "four requests in all, then silence");

    // A 404 is the client not holding the file, and asking three more times gets three more 404s.
    // The vmap hull is asked for once — it is what tells the renderer to stop drawing a stand-in
    // for something that is never coming — and then the model is written off for good.
    assert.equal(client.model(GONE), undefined);
    await settle();
    assert.equal(visualModels(gone), 1);
    assert.equal(asked.filter((address) => address.includes("/environment/model/Absent.m2")).length, 1);
    clock.now += IMAGE_RETRY_BACKOFF_MS[0] * 100;
    assert.equal(client.model(GONE), undefined);
    await settle();
    assert.equal(visualModels(gone), 1, "a 404 is final, and the hull is not asked for twice either");

    // And the whole point of the ladder: a model that comes back on a retry is the building the
    // player was walking towards, not a permanent hole where it stood.
    const artifact = new ArrayBuffer(16);
    new Uint8Array(artifact).set([0x57, 0x56, 0x4d, 0x31]);
    answers.set(late, { ok: false, status: 503 });
    assert.equal(client.model(LATE), undefined);
    await settle();
    assert.equal(visualModels(late), 1);
    answers.set(late, { ok: true, status: 200, arrayBuffer: async () => artifact });
    clock.now += IMAGE_RETRY_BACKOFF_MS[0];
    assert.equal(client.model(LATE), undefined, "the retry is made on this frame and lands on a later one");
    await settle();
    assert.equal(visualModels(late), 2);
    assert.deepEqual(client.model(LATE), { vertices: [], indices: [], uvs: [], visual: true },
      "the model the gateway could not build a second ago is on the screen");
  } finally {
    globalThis.fetch = original;
  }
});

/** One triangle wearing one texture of its own, which is the only batch shape this test needs. */
function texturedQuad() {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  return {
    positions,
    normals: new Float32Array(positions.length),
    uv0: new Float32Array(6),
    uv1: new Float32Array(6),
    indices: new Uint16Array([0, 1, 2]),
    submeshes: [{ geosetId: 0, indexStart: 0, indexCount: 3 }],
    batches: [{
      submesh: 0, textures: [0], uvSets: [0, 0], blendMode: 0, materialFlags: 0,
      renderFlags: 0, priority: 0, uvAnimation: -1, colour: -1, alpha: -1,
    }],
    // TEXTURE_TYPE_OWN, so the path in the record is the path that is loaded.
    textures: [{ type: 0, flags: 0, path: "Creature\\Bear\\BearSkinBrown.blp" }],
    bounds: { min: [0, 0, 0], max: [1, 1, 0], radius: 1 },
    particleEmitters: [], ribbonEmitters: [],
  };
}

test("Ж0 a model built for the world samples its textures at the renderer's anisotropy", () => {
  // `renderer.capabilities.getMaxAnisotropy()` is passed to the path-resolved textures built for the
  // world — every creature, animated doodad, spell effect, hair, cloak and armour slot. A supplied
  // texture takes the separate `buildMaterial` branch and remains caller-owned; the world renderer
  // configures its character atlas before handing it to this builder, while the character lab and
  // this isolated test have no renderer from which to derive a value.
  const built = (options) => buildModel(texturedQuad(), {
    modelPath: "Creature\\Bear\\Bear.m2",
    baseUrl: "https://example.invalid",
    loadTexture: () => new THREE.Texture(),
    ...options,
  }).materials[0].map;

  assert.equal(built({ anisotropy: 16 }).anisotropy, 16, "what the renderer asked for reaches the texture");
  assert.equal(built({ anisotropy: 4 }).anisotropy, 4);
  assert.equal(built({}).anisotropy, 1, "and a caller with no renderer changes nothing");

  // The one surface it does not reach, written down so it is not rediscovered as a fresh defect: a
  // texture handed in rather than resolved by path stays the caller's and the builder sets nothing
  // on it, `anisotropy` included. That is exactly how a character's body arrives — a composed
  // atlas, not a file — so the baseline remains sampled at 1 until the opt-in renderer integration
  // asks for the maximum beside the wrap flags the atlas already sets.
  const body = new THREE.Texture();
  assert.equal(built({ anisotropy: 16, slotTextures: new Map([[0, body]]) }), body,
    "a supplied texture is the map itself, untouched");
  assert.equal(body.anisotropy, 1, "the builder leaves the caller-owned texture untouched");
});

test("Э1 WVM9 carries the texture transforms across the wire whole", () => {
  // Byte 70 of the header stopped being a reserved zero and became the record count, and the block
  // sits between the texture weights and the portrait camera. What this pins is that the three
  // tracks come back in the order they went in — a reader that walked them in the wrong order
  // would hand a translation to the rotation slot, which is a texture spinning instead of
  // scrolling and no error anywhere.
  const track = (components, values, times, globalSequence = -1) => ({
    interpolation: 1, globalSequence, components,
    tracks: [{ sequence: 0, times: Uint32Array.from(times), values: Float32Array.from(values) }],
  });
  const model = {
    ...texturedQuad(),
    boneIndices: new Uint8Array(12), boneWeights: new Uint8Array(12),
    colours: [], textureWeights: [],
    textureTransforms: [{
      translation: track(3, [0, 0, 0, 0.25, 0.5, 0], [0, 1000]),
      rotation: track(4, [0, 0, 0, 1, 0, 0, 0.7071, 0.7071], [0, 1000]),
      // Bound to a global loop, which is how a portal swirls while nobody is casting.
      scaling: track(3, [1, 1, 1, 2, 2, 1], [0, 500], 0),
    }],
  };
  const encoded = encodeWvm9(model, undefined, [], { globalSequences: [500], particleEmitters: [], ribbonEmitters: [] });
  const decoded = decodeWvm9(encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength));
  assert.equal(decoded.textureTransforms.length, 1);
  const [transform] = decoded.textureTransforms;
  assert.deepEqual([...transform.translation.tracks[0].values], [0, 0, 0, 0.25, 0.5, 0]);
  assert.equal(transform.rotation.components, 4, "the rotation is a quaternion, not a vector");
  assert.deepEqual([...transform.rotation.tracks[0].values].map((value) => Math.round(value * 1e4) / 1e4),
    [0, 0, 0, 1, 0, 0, 0.7071, 0.7071]);
  assert.equal(transform.scaling.globalSequence, 0, "and a track on a global loop stays on it");
  assert.deepEqual([...transform.scaling.tracks[0].times], [0, 500]);
  // The block is between the weights and the camera, so a model that has neither still decodes.
  const bare = { ...model, textureTransforms: [] };
  const empty = encodeWvm9(bare, undefined, []);
  assert.deepEqual(decodeWvm9(empty.buffer.slice(empty.byteOffset, empty.byteOffset + empty.byteLength))
    .textureTransforms, []);
});

/**
 * The mounts the seat chain is pinned against, measured from the configured client's data
 * (the M2 attachment table, its header bounding box and the z extent of the vertices the skin
 * profile actually draws) and the dataset's `CreatureModelData` / `CreatureDisplayInfo`. Model
 * space, before the display scale.
 *
 * Two of the columns are here to be told apart. `boundsMaxZ` is the M2 header's own box — animation
 * extents and all — and `meshZ` is the geometry; the first version of this slice read the seat out
 * of the header, and because the golden numbers were taken from the same header the test agreed
 * with it. Wherever the two disagree below, the header is the wrong answer and the number the
 * function must produce is the one measured off the mesh.
 *
 * Over the whole table: 414 of the 1,331 rows carry `MountHeight > 0`, 405 of those also carry
 * attachment 0, and 403 of the 405 agree with the column to within 0.0001 — so these are one row
 * from each population rather than six horses.
 */
const MOUNTS = [
  // Display 2404, model 216. The ordinary case: the artist placed the saddle and the column agrees
  // with it to every decimal either tool prints.
  { name: "RidingHorse", seat: 1.8657, mountHeight: 1.8657, boundsMaxZ: 4.0629, meshZ: [-0.0013, 2.5792], expected: 1.8657 },
  // Display 17255, model 2241. One of the nine rows that name a height and carry no point at all:
  // its ten attachments run 15..23 and 34. (Eleven is Threshadon below — 1, 2, 15..22 and 34.)
  { name: "FrostWurm", seat: undefined, mountHeight: 8.1390, boundsMaxZ: 31.8993, meshZ: [-2.4785, 19.4222], expected: 8.1390 },
  // Display 995, model 133. Neither a point nor a column, so it falls to the guess: four fifths of
  // 3.3693, and not of the 5.1823 the header claims.
  { name: "Threshadon", seat: undefined, mountHeight: 0, boundsMaxZ: 5.1823, meshZ: [1.3248, 3.3693], expected: 2.6955 },
  // Display 18359, model 69, and the reason the header cannot be the source: its box runs −110.74
  // to 19.96 because it covers the boulders the elemental throws, while the elemental itself is
  // −0.17…3.07. At that display's scale of 2.5 the header answers 39.92 yards and the mesh 6.13.
  { name: "ElementalEarth", seat: undefined, mountHeight: 0, boundsMaxZ: 19.9615, meshZ: [-0.1656, 3.0673], expected: 2.4538 },
  // Display 4566, model 373, the second rung: four fifths of 1.1923 is 0.954, under the yard the
  // reference client refuses, so the answer is three quarters of the 1.3634 extent.
  { name: "Owl", seat: undefined, mountHeight: 0, boundsMaxZ: 7.5712, meshZ: [-0.1711, 1.1923], expected: 1.0226 },
  // Display 134, model 134, and the third rung: 0.257 of a yard tall, under the 0.5 the reference
  // client measures at all, so it takes the constant. 44 of the 642 models here are this flat.
  { name: "Squirrel", seat: undefined, mountHeight: 0, boundsMaxZ: 0.6260, meshZ: [-0.0094, 0.2476], expected: 1.8 },
];

/**
 * What the renderer holds for a mount whose model has been built: the artifact, and nothing else.
 *
 * The vertex list is the two extremes and nothing between them, which is all the z scan can see.
 */
const mountWvm = (mount, bounds = mount.boundsMaxZ) => ({
  attachments: mount.seat === undefined ? [] : [{ id: 0, bone: 0, position: [0, 0, mount.seat] }],
  bounds: { min: [0, 0, 0], max: [0, 0, bounds], radius: 0 },
  positions: new Float32Array([0, 0, mount.meshZ[0], 0, 0, mount.meshZ[1]]),
});

test("П2 a display swap rebuilds a shared mount model when its instance scale changes", () => {
  const whiteHorse = {
    id: 2410,
    model: "Creature\\RidingHorse\\RidingHorse.m2",
    textures: "11:Creature\\RidingHorse\\RidingHorseSkinWhite.blp",
    scale: 1,
    mountHeight: 1.8657,
  };
  // These two real CreatureDisplayInfo rows share the build key but not the drawn instance:
  // display 30518 scales the same model/skin to 0.8. Comparing the build key alone kept the first
  // horse's scale and saddle until a dismount happened between them.
  const smallerWhiteHorse = { ...whiteHorse, id: 30518, scale: 0.8 };
  assert.equal(mountInstanceMatches(whiteHorse, whiteHorse), true, "the current display is reused");
  assert.equal(mountInstanceMatches(whiteHorse, smallerWhiteHorse), false,
    "a new display id rebuilds even when model and textures are identical");
  assert.equal(mountInstanceMatches(whiteHorse, { ...whiteHorse, scale: 0.8 }), false,
    "a refreshed row cannot retain stale per-instance scale either");
});

test("П2 the saddle comes from the model's own point, then from MountHeight, then from the vertices", () => {
  const [horse, wurm, , elemental] = MOUNTS;
  const seatOf = (mount, scale = 1) => mountSeatOffset(mountWvm(mount), mount.mountHeight, scale);

  // 1. The point wins even where the column says the same thing, because the column is the copy
  // and the point is the bone the rider is really hung from.
  assert.ok(Math.abs(seatOf(horse) - 1.8657) < 5e-5, `RidingHorse: ${seatOf(horse)}`);
  assert.equal(mountSeatOffset(mountWvm(horse), 0, 1), seatOf(horse),
    "and it is the point that answered: zeroing the column moves nothing");

  // 2. No point, a height. FrostWurm is drawn at CreatureModelScale 0.75 and the seat goes with it,
  // which is why the gateway sends the column in model space.
  assert.ok(Math.abs(seatOf(wurm) - 8.1390) < 5e-5, `FrostWurm: ${seatOf(wurm)}`);
  assert.ok(Math.abs(seatOf(wurm, 0.75) - 6.10425) < 5e-5, `FrostWurm at 0.75: ${seatOf(wurm, 0.75)}`);

  // 3. Neither: the reference client's ladder off the drawn vertices
  // (`wowee/src/core/entity_spawner_processing.cpp:1713-1729`), all three of its rungs.
  for (const mount of MOUNTS.slice(2)) {
    assert.ok(Math.abs(seatOf(mount) - mount.expected) < 5e-4, `${mount.name}: ${seatOf(mount)}`);
  }

  // And the header box is not read, which is the defect this branch had: the same model with an
  // absurd box answers the same, and with the box it really has it does not answer 15.97.
  for (const mount of MOUNTS) {
    const withLies = mountSeatOffset(mountWvm(mount, 500), mount.mountHeight, 1);
    assert.ok(Math.abs(withLies - mount.expected) < 5e-4,
      `${mount.name} moved to ${withLies} when only the header box changed`);
  }
  assert.ok(Math.abs(seatOf(elemental) - 19.9615 * 0.8) > 1,
    `ElementalEarth is reading the header box: ${seatOf(elemental)}`);

  // Whichever branch answers, the rider ends up above the mount's feet — the one thing all of them
  // owe. A fallback of zero is what «висит в воздухе» looked like from the other side, and the two
  // `InvisibleStalker` files whose header box is an uninitialised −3.4e38 used to produce exactly
  // that.
  for (const mount of MOUNTS) assert.ok(seatOf(mount) > 0.5, `${mount.name}: ${seatOf(mount)}`);
  const stalker = { name: "InvisibleStalker", seat: undefined, mountHeight: 0, boundsMaxZ: -3.4028235e38, meshZ: [0, 0] };
  assert.equal(mountSeatOffset(mountWvm(stalker), 0, 1), 1.8,
    "a model with no geometry takes the reference client's constant, not the ground");
});

test("П2 the saddle is added outside the band a body point is clamped to", () => {
  // Measured on this machine: `Character\Human\Male\HumanMale.m2` carries its shoulder point (5) at
  // 1.7254 and its helm point (11) at 2.0272, and `RidingHorse` seats a rider at 1.8657 at scale 1.
  // `#bodyHeight` adds the second number to `cameraBodyHeight`'s answer rather than handing it in,
  // and this is why: the band is wowee's 0..3 for where a camera hangs on a *character*
  // (`camera_controller.hpp:384`), and a rider on a horse is over it by both points.
  const shoulder = 1.7254;
  const helm = 2.0272;
  const seat = 1.8657;
  const pivot = cameraBodyHeight(shoulder, undefined, CAMERA_PIVOT_BODY_SHARE, CAMERA_DEFAULT_PIVOT_HEIGHT);
  const eye = cameraBodyHeight(helm, undefined, CAMERA_EYE_BODY_SHARE, CAMERA_DEFAULT_EYE_HEIGHT);
  assert.ok(Math.abs(pivot - shoulder) < 5e-5, `on foot the shoulder is itself: ${pivot}`);
  assert.ok(Math.abs(eye - helm) < 5e-5, `and so is the helm point: ${eye}`);
  assert.ok(Math.abs((eye + seat) - 3.8929) < 5e-4, `mounted the eye is ${eye + seat}`);
  assert.ok(Math.abs((pivot + seat) - 3.5911) < 5e-4, `and the orbit centre ${pivot + seat}`);

  // Handed in instead, both are clamped away and the rider keeps a camera on the ground: this is
  // the arithmetic the slice was missing, not merely a nicety it skipped.
  assert.equal(cameraBodyHeight(helm + seat, undefined, CAMERA_EYE_BODY_SHARE, CAMERA_DEFAULT_EYE_HEIGHT),
    CAMERA_MAX_PIVOT_HEIGHT);
  assert.equal(cameraBodyHeight(shoulder + seat, undefined, CAMERA_PIVOT_BODY_SHARE, CAMERA_DEFAULT_PIVOT_HEIGHT),
    CAMERA_MAX_PIVOT_HEIGHT);
  assert.ok(Math.abs((eye + seat - CAMERA_MAX_PIVOT_HEIGHT) - 0.8929) < 5e-4,
    "0.8929 yards of the 1.8657 the saddle adds, thrown away by the clamp");
});

test("П2 a mount's scale and its rider's cancel, because one hangs inside the other", () => {
  // The unit's node carries the rider's scale, the mount's group hangs inside it, and the rider
  // then hangs off one of the mount's bones — so it is inside the mount's scale as well. Applying
  // one factor without the other gives a tauren a pony or a gnome a horse three sizes too big, and
  // both look authored rather than broken.
  //
  // The pairs are real ones: 1.35 is TaurenMale's display scale, 0.75 FrostWurm's, 1.15 a gnome's,
  // and 9.86 the largest `creature_template.scale` in this dataset's TDB dump.
  for (const [unitScale, mountScale] of [[1, 1], [1.35, 1], [1, 0.75], [1.15, 1.3], [9.86, 0.4]]) {
    const { mount, rider } = mountNesting(unitScale, mountScale);
    assert.ok(Math.abs(mount * rider - 1) < 1e-12, `${unitScale}/${mountScale}: ${mount} * ${rider}`);
    // What the scene ends up drawing, which is the whole point of the pair.
    assert.ok(Math.abs(unitScale * mount - mountScale) < 1e-12, `mount drawn at ${unitScale * mount}`);
    assert.ok(Math.abs(unitScale * mount * rider - unitScale) < 1e-12, `rider drawn at ${unitScale * mount * rider}`);
  }
});
