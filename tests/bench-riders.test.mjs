import assert from "node:assert/strict";
import test from "node:test";

// 06.11 (12.13): the bench's riding crowd (bench/city-riders.json) — who rides, on what, and that the
// renderer can read the mounts the way the live client's display cache answers them.
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { BenchCrowd, BenchUnitModels, benchRiderMount, benchScenario } = await import("../dist/code/browser/bench/BenchScene.js");
const { mountDisplayModel } = await import("../dist/code/browser/RenderLookups.js");

const MOUNT = UPDATE_FIELDS.UNIT_FIELD_MOUNTDISPLAYID.offset;
const city = {
  map: 0, x: -8840, y: 626, z: 93.95, population: 128, spacing: 2.4, walkers: 16, orbit: 18, pitch: -0.35,
  displays: [3167, 5446], graphics: { lightingQuality: 2, grassRadius: 80, grassDense: true, grassDensity: 3, fullscreenGlow: true },
};
const config = (mounts) => ({
  seed: 1, width: 1, height: 1, pixelRatio: 1, durationSeconds: 20, warmupSeconds: 5, timeoutSeconds: 1, halfMinute: 0,
  route: { map: 0, x: 0, y: 0, dx: 0, dy: 0 }, graphics: city.graphics,
  city: mounts ? { ...city, mounts } : city,
});
const mounts = { displays: [2404, 14337, 247], riders: 20 };

test("twenty riders spread over the 127 NPCs of the square, every sixth from the first, cycling the mounts", () => {
  const riding = [];
  for (let index = 0; index < 128; index++) {
    const mount = benchRiderMount(mounts, 128, index);
    if (mount !== undefined) riding.push([index, mount]);
  }
  assert.equal(riding.length, 20);
  assert.deepEqual(riding.slice(0, 4), [[1, 2404], [7, 14337], [13, 247], [19, 2404]]);
  assert.deepEqual(riding.at(-1), [115, 14337]);
  assert.equal(benchRiderMount(mounts, 128, 0), undefined, "the player never rides");
  assert.equal(benchRiderMount(undefined, 128, 1), undefined);
  assert.equal(benchRiderMount({ displays: [], riders: 20 }, 128, 1), undefined);
});

test("the crowd seats only standing NPCs, and a square without mounts stays as it was", () => {
  const crowd = new BenchCrowd(config(mounts), benchScenario(config(mounts), "city"), () => 3167);
  const riders = crowd.objects.filter((object) => object.fields.has(MOUNT));
  assert.equal(riders.length, 20);
  assert.ok(riders.every((object) => object.movementFlags === 0 && object.typeId === 3));
  assert.equal(crowd.objects[1].fields.get(MOUNT), 2404);
  const plain = new BenchCrowd(config(undefined), benchScenario(config(undefined), "city"), () => 3167);
  assert.equal(plain.objects.filter((object) => object.fields.has(MOUNT)).length, 0);
});

test("the mounts reach the renderer as creature display rows; without them the lookup stays empty", () => {
  const rows = [{ id: 2404, model: "Creature\\horsemultisaddle\\horsemultisaddle.m2" }, { id: 247, model: "Creature\\DireWolfNew\\RidingDireWolf.m2" }];
  const models = new BenchUnitModels(() => undefined, rows);
  const crowd = new BenchCrowd(config(mounts), benchScenario(config(mounts), "city"), () => 3167);
  assert.equal(mountDisplayModel(crowd.objects[1], models.lookups.creatureDisplays)?.id, 2404);
  assert.equal(mountDisplayModel(crowd.objects[13], models.lookups.creatureDisplays)?.id, 247);
  assert.equal(models.lookups.creatureDisplayRevision, 1);
  const plain = new BenchUnitModels(() => undefined);
  assert.equal(plain.lookups.creatureDisplays, undefined);
  assert.equal(plain.lookups.creatureDisplayRevision, undefined);
});
