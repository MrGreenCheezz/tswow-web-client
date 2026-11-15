import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { unitCollisionModel } from "../dist/code/browser/game/MissileShot.js";
import { modelMissileCollision, parseCreatureModelMetadata } from "../dist/code/gateway/CreatureModelMetadata.js";
import { missileCollisionSphere } from "../dist/code/world/MissileCollision.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";

// 15.11 (11.02): the CreatureModelData columns of the trajectory missile's sphere around a unit (Wow.exe 0x006fbff0:
// MissileCollisionRadius × scale or CollisionHeight / 2 unscaled, pushed back by Push × scale, raised by Raise × scale).

let dbcDirectory;
try {
  dbcDirectory = (await import("../tools/paths.mjs")).dbcDirectory();
} catch {
  dbcDirectory = undefined;
}
const withDataset = { skip: dbcDirectory ? false : "no tswow dataset on this machine" };

const unit = (displayId, scale = 1) => ({
  guid: 9n,
  fields: new Map([[UPDATE_FIELDS.UNIT_FIELD_DISPLAYID.offset, displayId],
    [UPDATE_FIELDS.OBJECT_FIELD_SCALE_X.offset, new Uint32Array(new Float32Array([scale]).buffer)[0]]]),
});

test("15.11: only a row that sets one of the three columns carries them", () => {
  assert.deepEqual(modelMissileCollision(0, 0, 0), {});
  assert.deepEqual(modelMissileCollision(Number.NaN, 0, 0), {});
  assert.deepEqual(modelMissileCollision(2, 0.5, 1), { missileCollision: [2, 0.5, 1] });
});

test("15.11: the unit's model gives the columns and the unscaled height", () => {
  const plain = unitCollisionModel(unit(5), () => ({ scale: 2, collisionHeight: 4 }));
  assert.equal(plain.scale, 2);
  assert.deepEqual(plain.model, { collisionHeight: 2, missileCollisionRadius: 0, missileCollisionPush: 0, missileCollisionRaise: 0 });
  const set = unitCollisionModel(unit(5), () => ({ scale: 2, collisionHeight: 4, missileCollision: [1.5, 0.25, 0.5] }));
  assert.deepEqual(set.model, { collisionHeight: 2, missileCollisionRadius: 1.5, missileCollisionPush: 0.25, missileCollisionRaise: 0.5 });
  // Half the raw height (1), not of the scaled one (2): 0x006fbff0 reads +0x3c unscaled.
  const sphere = missileCollisionSphere({ position: { x: 0, y: 0, z: 0 }, ...plain }, { dirX: 1, dirY: 0 }, { collisionRadius: 0 });
  assert.ok(Math.abs(sphere.r - 1) < 1e-6, `radius ${sphere.r}`);
  // With the radius set: radius × scale, pushed back by push × scale, raised by raise × scale and the radius.
  const pushed = missileCollisionSphere({ position: { x: 0, y: 0, z: 0 }, ...set }, { dirX: 1, dirY: 0 }, { collisionRadius: 0 });
  assert.ok(Math.abs(pushed.r - 3) < 1e-6 && Math.abs(pushed.x + 0.5) < 1e-6 && Math.abs(pushed.z - 4) < 1e-6,
    JSON.stringify(pushed));
});

test("15.11: the dataset's rows with the columns reach the display answer", withDataset, async () => {
  const [displays, models] = await Promise.all([
    readFile(join(dbcDirectory, "CreatureDisplayInfo.dbc")), readFile(join(dbcDirectory, "CreatureModelData.dbc"))]);
  const metadata = parseCreatureModelMetadata(displays, models);
  const carrying = [...metadata.values()].filter((row) => row.missileCollision !== undefined);
  assert.ok(carrying.length > 0, "some display wears a model with the columns");
  for (const row of carrying) assert.ok(row.missileCollision.some((value) => value !== 0));
});
