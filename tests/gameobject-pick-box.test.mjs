// 06.10-7.24 — a game object's click box is its model's box as drawn (owner 06.10: «границы, где
// курсор определяет, можно ли нажать на игровой объект, слишком маленькие, не соответствуют
// размерам объектов»), not a 10–34 px square over its origin.
import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { SimpleScene, createCamera, projectPoint } from "../dist/code/browser/SimpleScene.js";
import { modelPickBox } from "../dist/code/browser/GameObjectPickBox.js";
import { gameObjectWorldRotation, placedBoxCorners } from "../dist/code/world/GameObjectModelFrame.js";

const WIDTH = 1280;
const HEIGHT = 720;
// GameObjectDisplayInfo 39 (GeneralChairLoEnd01), the stock inn chair, from the dataset DBC.
const CHAIR_BOX = { minX: -0.999, minY: -0.553, minZ: -0.007, maxX: 0.179, maxY: 0.553, maxZ: 1.328 };
const CHAIR = { x: 7, y: 2.5, z: 0, orientation: 2.1 };
// A forge-sized goober (4 × 3 × 3.5 yards): where the old 42 px square fell short.
const FORGE_BOX = { minX: -2, minY: -1.5, minZ: 0, maxX: 2, maxY: 1.5, maxZ: 3.5 };

function frame(objects, corners) {
  const context = new Proxy({
    createLinearGradient: () => ({ addColorStop() {} }),
    measureText: (text) => ({ width: text.length * 6 }),
  }, { get: (target, property) => target[property] ?? (() => {}) });
  const canvas = { width: 0, height: 0, getContext: () => context, getBoundingClientRect: () => ({ width: WIDTH, height: HEIGHT }) };
  const previous = globalThis.window;
  globalThis.window = { devicePixelRatio: 1 };
  try {
    const scene = new SimpleScene(canvas, false);
    scene.draw({ selfGuid: 1n, objects: new Map(objects.map((object) => [object.guid, object])) },
      () => 0, undefined, [], undefined, 0, undefined, undefined, () => 2, () => undefined,
      undefined, undefined, corners);
    return scene;
  } finally {
    globalThis.window = previous;
  }
}

const player = {
  guid: 1n, typeId: 4, position: { x: 0, y: 0, z: 0, orientation: 0 },
  fields: new Map([[UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 1], [UPDATE_FIELDS.UNIT_FIELD_MAXHEALTH.offset, 1]]),
};
const chair = {
  guid: 2n, typeId: 5, position: CHAIR,
  fields: new Map([
    [UPDATE_FIELDS.GAMEOBJECT_DISPLAYID.offset, 39],
    [UPDATE_FIELDS.GAMEOBJECT_BYTES_1.offset, 7 << 8], // GAMEOBJECT_TYPE_CHAIR
  ]),
};

/** What the renderer's `gameObjectPickCorners` answers for an object drawn at its spawn point. */
const cornersOf = (box) => (object, out) => {
  if (object.guid !== 2n) return false;
  const rotation = gameObjectWorldRotation(object, object.position.orientation, { x: 0, y: 0, z: 0, w: 1 });
  placedBoxCorners(box, object.position, rotation, 1, out);
  return true;
};

/** The screen rectangle of the chair's box, worked out here from Rz(o) corners. */
function expectedRect(box = CHAIR_BOX) {
  const camera = createCamera(player.position, 0, undefined, undefined, {});
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  const o = CHAIR.orientation;
  for (let corner = 0; corner < 8; corner++) {
    const vx = (corner & 1) ? box.maxX : box.minX;
    const vy = (corner & 2) ? box.maxY : box.minY;
    const vz = (corner & 4) ? box.maxZ : box.minZ;
    const point = projectPoint({
      x: CHAIR.x + vx * Math.cos(o) - vy * Math.sin(o), y: CHAIR.y + vx * Math.sin(o) + vy * Math.cos(o), z: CHAIR.z + vz,
    }, camera, WIDTH, HEIGHT);
    minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y);
  }
  return { minX, minY, maxX, maxY };
}

test("the whole drawn object is clickable, not only a square over its origin", () => {
  for (const [label, box] of [["chair", CHAIR_BOX], ["forge", FORGE_BOX]]) {
    const withBox = frame([player, chair], cornersOf(box));
    const without = frame([player, chair]);
    const rect = expectedRect(box);
    let inside = 0; let picked = 0; let pickedBefore = 0;
    for (let x = Math.ceil(rect.minX) + 1; x < rect.maxX - 1; x += 2) {
      for (let y = Math.ceil(rect.minY) + 1; y < rect.maxY - 1; y += 2) {
        inside++;
        const hit = withBox.pick(x, y);
        // The player's own body is nearer and may overlap the box's bottom corner; it wins there.
        if (hit === 2n || (hit === 1n && without.pick(x, y) === 1n)) picked++;
        if (without.pick(x, y) === 2n) pickedBefore++;
      }
    }
    assert.ok(inside > 200, `${label} covers ${inside} sample points`);
    assert.equal(picked, inside, `every point over the ${label}'s box picks it`);
    if (label === "forge") assert.ok(pickedBefore < inside * 0.6, `the old square covered ${pickedBefore} of ${inside}`);
    // And it is still only the object's box: well outside it nothing is picked.
    assert.equal(withBox.pick(rect.maxX + 60, rect.minY - 60), undefined);
  }
});

test("a model without a box keeps the old square", () => {
  const scene = frame([player, chair], () => false);
  const rect = expectedRect();
  let picked = 0;
  for (let x = 0; x < WIDTH; x += 4) for (let y = 0; y < HEIGHT; y += 4) if (scene.pick(x, y) === 2n) picked++;
  assert.ok(picked > 0, "still clickable");
  assert.ok(rect.maxX - rect.minX > 0);
});

test("the model box comes from the WVM header box, a WMO's groups or the legacy geometry", () => {
  const wvm = { bounds: { min: [-0.999, -0.553, -0.007], max: [0.179, 0.553, 1.328], radius: 1 } };
  assert.deepEqual(modelPickBox({ wvm }), CHAIR_BOX);
  const group = (minX, maxX, boundsValid) => ({
    bounds: { minX, minY: -1, minZ: 0, maxX, maxY: 1, maxZ: 3 }, ...(boundsValid === undefined ? {} : { boundsValid }),
  });
  assert.deepEqual(modelPickBox({ wmo: { model: { groups: [group(-2, 1), group(0, 5), group(-90, 90, false)] } } }),
    { minX: -2, minY: -1, minZ: 0, maxX: 5, maxY: 1, maxZ: 3 });
  // The legacy artifact bakes VMAP_TO_THREE, (x, y, z) → (−x, z, y), into its vertices.
  const raw = [[-0.999, -0.553, -0.007], [0.179, 0.553, 1.328]];
  const positions = new Float32Array(raw.flatMap(([x, y, z]) => [-x, z, y]));
  const geometry = new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const legacy = modelPickBox({ legacyGeometry: { geometry } });
  for (const key of Object.keys(CHAIR_BOX)) assert.ok(Math.abs(legacy[key] - CHAIR_BOX[key]) < 1e-6, key);
  assert.equal(modelPickBox({ wvm: { bounds: { min: [0, 0, 0], max: [0, 0, 0], radius: 0 } } }), undefined,
    "a point box is no box");
});

// 06.10: ревью 7.24 — the box is worked out only for an object a click can land on. A city holds
// hundreds of game objects in reach (collision hulls, decorations, transports) whose box the click
// list never takes; asking the renderer for eight corners and projecting them was per-frame waste.
test("06.10 review: no box is worked out for an object nothing can click", () => {
  const asked = [];
  const corners = (object, out) => { asked.push(object.guid); return cornersOf(CHAIR_BOX)(object, out); };
  const generic = { ...chair, guid: 3n, fields: new Map([[UPDATE_FIELDS.GAMEOBJECT_BYTES_1.offset, 5 << 8]]) }; // GENERIC
  const unselectable = { ...chair, guid: 4n, fields: new Map([...chair.fields, [UPDATE_FIELDS.GAMEOBJECT_FLAGS.offset, 0x10]]) };
  frame([player, chair, generic, unselectable], corners);
  assert.deepEqual(asked.map(String), ["2"]);
});

test("06.10 review: a box with a corner behind the camera falls back to the square, still clickable", () => {
  // Corners reaching behind the camera (yaw 0 puts it about 20 yards back along −x).
  const behind = (object, out) => {
    if (object.guid !== 2n) return false;
    placedBoxCorners({ minX: -40, minY: -1, minZ: 0, maxX: 1, maxY: 1, maxZ: 2 }, object.position, { x: 0, y: 0, z: 0, w: 1 }, 1, out);
    return true;
  };
  const scene = frame([player, chair], behind);
  let picked = 0;
  for (let x = 0; x < WIDTH; x += 4) for (let y = 0; y < HEIGHT; y += 4) if (scene.pick(x, y) === 2n) picked++;
  assert.ok(picked > 0 && picked < 400, `fallback square only (${picked} samples)`);
});
