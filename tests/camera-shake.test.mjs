// 05.10-A7a-E (6.13): kit camera shakes — CameraShakes/SpellEffectCameraShakes rows and the bank that runs
// them the way Wow.exe's 0x00606970 / 0x005fe6c0 do (browser/CameraShake.ts).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { parseCameraShakes } from "../dist/code/gateway/SpellKitExtras.js";
import {
  CameraShakeBank, SHAKE_AMPLITUDE_SCALE, SHAKE_CAPACITY, shakeAttenuation, shakeValue,
} from "../dist/code/browser/CameraShake.js";
import { planSpellVisual } from "../dist/code/browser/SpellVisuals.js";

let dbcDirectory;
try {
  dbcDirectory = (await import("../tools/paths.mjs")).dbcDirectory();
} catch {
  dbcDirectory = undefined;
}
let shakes;
let kitShakeIds;
try {
  if (dbcDirectory) {
    shakes = parseCameraShakes(await readFile(join(dbcDirectory, "SpellEffectCameraShakes.dbc")),
      await readFile(join(dbcDirectory, "CameraShakes.dbc")));
    const { openDbc } = await import("../dist/code/gateway/Dbc.js");
    const kits = openDbc(await readFile(join(dbcDirectory, "SpellVisualKit.dbc")), "SpellVisualKit");
    kitShakeIds = new Set();
    for (const row of kits.rows()) if (kits.int(row, "ShakeID") > 0) kitShakeIds.add(kits.int(row, "ShakeID"));
  }
} catch {
  shakes = undefined;
}
const withDataset = { skip: shakes ? false : "no camera shake tables in the tswow dataset on this machine" };

const near = (actual, expected, message, epsilon = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= epsilon, `${message}: ${actual} vs ${expected}`);

const sine = (extra = {}) => ({ type: 0, direction: 2, amplitude: 36, frequency: 1, duration: 2, phase: 0, coefficient: 0, ...extra });

test("dataset: every ShakeID a kit names resolves to rows with sane amplitude, frequency and duration", withDataset, () => {
  assert.equal(kitShakeIds.size, 28);
  for (const id of kitShakeIds) {
    const rows = shakes.get(id);
    assert.ok(rows && rows.length >= 1 && rows.length <= 3, `ShakeID ${id}`);
    for (const row of rows) {
      assert.ok(row.amplitude > 0 && row.amplitude <= 12, `${id} amplitude ${row.amplitude}`);
      assert.ok(row.frequency > 0 && row.frequency <= 12, `${id} frequency ${row.frequency}`);
      assert.ok(row.duration > 0 && row.duration <= 20, `${id} duration ${row.duration}`);
      assert.ok([0, 1].includes(row.type) && [0, 1, 2].includes(row.direction), `${id} type/direction`);
    }
  }
  // Row 1 (set 3's only row): damped vertical, 2/36 yd at 3 Hz for 0.4 s, phase 0.06, coefficient 1.
  assert.deepEqual(shakes.get(3).map((row) => [row.type, row.direction, row.amplitude, row.frequency]), [[1, 2, 2, 3]]);
});

test("one shake: sin(2π f t) · amplitude/36, damped by exp(−t·c) for type 1, vertical for direction 2", () => {
  const bank = new CameraShakeBank();
  const out = { x: 0, y: 0, z: 0 };
  bank.add([sine()], { x: 0, y: 0, z: 0 }, 0);
  assert.equal(bank.offset(250, { x: 0, y: 0, z: 0 }, 0, out), true);
  near(out.z, 36 * SHAKE_AMPLITUDE_SCALE, "a quarter period: the peak");
  assert.equal(out.x, 0);
  near(shakeValue(sine({ type: 1, coefficient: 2 }), 1, 0.25), Math.exp(-0.5), "damped");
  near(shakeValue(sine({ type: 0, coefficient: 2 }), 1, 0.25), 1, "type 0 ignores the coefficient");
});

test("phase is added to the clock, and a shake is gone once its clock reaches the duration", () => {
  const bank = new CameraShakeBank();
  const out = { x: 0, y: 0, z: 0 };
  bank.add([sine({ phase: 0.25, duration: 1 })], { x: 0, y: 0, z: 0 }, 0);
  bank.offset(0, { x: 0, y: 0, z: 0 }, 0, out);
  near(out.z, 1, "phase 0.25 starts at the peak");
  assert.equal(bank.offset(800, { x: 0, y: 0, z: 0 }, 0, out), false, "0.8 + 0.25 ≥ 1: over");
  assert.deepEqual(out, { x: 0, y: 0, z: 0 });
  assert.equal(bank.size, 0);
});

test("direction 0 runs along the facing, 1 across it; only the strongest shake per direction counts", () => {
  const bank = new CameraShakeBank();
  const out = { x: 0, y: 0, z: 0 };
  bank.add([sine({ direction: 0, amplitude: 72 }), sine({ direction: 0, amplitude: 36 }), sine({ direction: 1, amplitude: 36 })],
    { x: 0, y: 0, z: 0 }, 0);
  bank.offset(250, { x: 0, y: 0, z: 0 }, 0, out);
  near(out.x, 2, "the stronger along-facing shake alone (not 1 + 2)");
  near(out.y, 1, "facing + 90°");
  bank.offset(250, { x: 0, y: 0, z: 0 }, Math.PI / 2, out);
  near(out.y, 2, "turned with the facing");
  near(out.x, -1, "and the cross shake with it");
});

test("distance: full within 9 yards, nothing beyond 80, a falloff between", () => {
  assert.equal(shakeAttenuation(5), 1);
  assert.equal(shakeAttenuation(80), 0);
  assert.ok(shakeAttenuation(40) > 0 && shakeAttenuation(40) < 1);
  const bank = new CameraShakeBank();
  const out = { x: 0, y: 0, z: 0 };
  bank.add([sine()], { x: 100, y: 0, z: 0 }, 0);
  assert.equal(bank.offset(250, { x: 0, y: 0, z: 0 }, 0, out), false, "a boss stomp 100 yards away does not shake you");
});

test("the bank is bounded", () => {
  const bank = new CameraShakeBank();
  for (let index = 0; index < SHAKE_CAPACITY + 10; index++) bank.add([sine()], { x: 0, y: 0, z: 0 }, 0);
  assert.equal(bank.size, SHAKE_CAPACITY);
});

test("the planner carries a kit's shakes with where its unit stood and when", () => {
  const shake = [sine()];
  const visual = {
    id: 1,
    cast: { startAnimation: -1, animation: -1, effects: [], sound: 0, shake },
    impact: { startAnimation: -1, animation: -1, effects: [], sound: 0, shake },
    missile: { path: "Spells\\Bolt.m2", scale: 1, attachment: 22, speed: 20 },
  };
  const plan = planSpellVisual(visual, {
    caster: 1n, casterPoint: { x: 0, y: 0, z: 0 }, targets: [{ guid: 2n, point: { x: 20, y: 0, z: 0 } }],
  }, 1000);
  assert.deepEqual(plan.shakes.map((one) => [one.point.x, one.at]), [[0, 1000], [20, 2000]]);
  assert.equal(plan.shakes[0].shakes, shake);
});
