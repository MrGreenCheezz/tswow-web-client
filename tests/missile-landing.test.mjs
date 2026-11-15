import assert from "node:assert/strict";
import test from "node:test";
import {
  clearProjectileFlights, flyMissileInstance, missileLandedAt, missileSample, setProjectilePosition,
} from "../dist/code/browser/MissileFlight.js";
import { landImpacts } from "../dist/code/browser/MissileLanding.js";
import { planSpellVisual } from "../dist/code/browser/SpellVisuals.js";

// 15.11 (11.02): SMSG_SET_PROJECTILE_POSITION reaches the drawn missiles (0x008005a0 → 0x006ff2c0, 0x007015d0's
// 0x400000 landing) and the landing's ImpactAreaKit stands at +0x44 — the point it stopped at (0x00700e20 →
// 0x006fec10; .runtime/re-2026-11-15/fx5/r1/d.c).

const kit = (path) => ({ startAnimation: -1, animation: -1, effects: [{ path, attachment: 22, scale: 1 }], sound: 0 });

const visual = {
  id: 1,
  impact: kit("Spells\\Impact.m2"),
  impactArea: kit("Spells\\ImpactArea.m2"),
  missile: { path: "Spells\\Missile.m2", scale: 1, attachment: 22, speed: 20, sound: 0 },
};

const pointCast = (castCount) => ({
  caster: 4n,
  casterPoint: { x: 0, y: 0, z: 0 },
  targets: [{ guid: 0n, point: { x: 40, y: 0, z: 0 } }],
  destination: { x: 40, y: 0, z: 0 },
  areaPoint: { x: 40, y: 0, z: 0 },
  ...(castCount === undefined ? {} : { castCount }),
});

test("15.11: a point target's missile carries its cast and its impacts the landing", () => {
  const plan = planSpellVisual(visual, pointCast(7), 1000);
  const missile = plan.instances.find((one) => one.flight);
  assert.deepEqual(missile.flight.cast, { caster: 4n, count: 7 });
  assert.equal(missile.flight.landing, 1);
  for (const path of ["Spells\\Impact.m2", "Spells\\ImpactArea.m2"]) {
    assert.equal(plan.instances.find((one) => one.path === path).landsWith, 1, path);
  }
  // Without a cast count nothing can name it.
  const untagged = planSpellVisual(visual, pointCast(undefined), 1000);
  assert.equal(untagged.instances.find((one) => one.flight).flight.cast, undefined);
  assert.equal(untagged.instances.some((one) => one.landsWith !== undefined), false);
  // A unit target keeps its impacts on the unit: only the cast is tagged.
  const unit = planSpellVisual(visual, { ...pointCast(7), targets: [{ guid: 9n, point: { x: 40, y: 0, z: 0 } }],
    destination: undefined, areaPoint: undefined }, 1000);
  assert.deepEqual(unit.instances.find((one) => one.flight).flight.cast, { caster: 4n, count: 7 });
  assert.equal(unit.instances.find((one) => one.flight).flight.landing, undefined);
  assert.equal(unit.instances.some((one) => one.landsWith !== undefined), false);
});

test("15.11: the server's point lands the drawn missile and moves its impact area there", () => {
  clearProjectileFlights();
  const plan = planSpellVisual(visual, pointCast(7), 0);
  const handle = {};
  const visuals = plan.instances.map((instance) => ({ instance, handle, authoredEndsAt: instance.endsAt }));
  const missile = plan.instances.find((one) => one.flight);
  const area = plan.instances.find((one) => one.path === "Spells\\ImpactArea.m2");
  const plannedArea = { startedAt: area.startedAt, endsAt: area.endsAt };
  assert.ok(plannedArea.startedAt > 500, "40 yards at 20 a second lands after two seconds");
  const points = { point: () => false };
  const out = missileSample();
  assert.equal(flyMissileInstance(missile, 0, points, out), true);
  assert.equal(flyMissileInstance(missile, 250, points, out), true);
  // Another cast count names nothing; this one names the flight.
  assert.equal(setProjectilePosition(4n, 8, { x: 10, y: 0, z: 0 }), 0);
  assert.equal(setProjectilePosition(4n, 7, { x: 10, y: 0, z: 0 }), 1);
  let at = 250;
  while (flyMissileInstance(missile, at, points, out)) at += 100;
  const landed = missileLandedAt(missile);
  assert.ok(landed && landed.x < 40, `stopped short of the destination: ${landed?.x}`);
  assert.equal(landImpacts(visuals, handle, missile.flight.landing, landed, at), 2);
  assert.deepEqual(area.position, { x: landed.x, y: landed.y, z: landed.z });
  assert.equal(area.startedAt, at);
  assert.equal(area.endsAt - area.startedAt, plannedArea.endsAt - plannedArea.startedAt);
  // Once: a second landing of the same cast moves nothing.
  assert.equal(landImpacts(visuals, handle, missile.flight.landing, { x: 0, y: 0, z: 0 }, at + 10), 0);
  // Another plan's effects are not moved.
  assert.equal(landImpacts([{ instance: { ...area, landsWith: 1 }, handle: {} }], handle, 1, landed, at), 0);
  clearProjectileFlights();
});

test("15.11: a missile that reaches its aim untouched reports no early landing", () => {
  clearProjectileFlights();
  const plan = planSpellVisual(visual, pointCast(3), 0);
  const missile = plan.instances.find((one) => one.flight);
  const out = missileSample();
  let at = 0;
  while (flyMissileInstance(missile, at, { point: () => false }, out)) at += 100;
  assert.equal(missileLandedAt(missile), undefined);
  clearProjectileFlights();
});
