import assert from "node:assert/strict";
import test from "node:test";
import { flyMissileInstance, missileSample } from "../dist/code/browser/MissileFlight.js";
import { missileLaunchEvent, missileLaunchSource } from "../dist/code/browser/MissileLaunchEvent.js";
import { planSpellVisual } from "../dist/code/browser/SpellVisuals.js";

// 15.11 (6.12): a missile whose visual names no point leaves from 0x0071a720's "$CSL"/"$CSR"/"$CST" event when SPELL_GO
// launches it (0x0080e1b0 → 0x0072e240: the CastKit plays no animation); the visual's own point wins (0x00720bf0).

const event = (id, bone = 0) => ({ id, bone, x: 0, y: 0, z: 0 });

test("15.11: the events are read $CSL, then $CSR, then $CST, never $AIM", () => {
  assert.equal(missileLaunchEvent([event("$CST"), event("$CSR"), event("$CSL")]).id, "$CSL");
  assert.equal(missileLaunchEvent([event("$CST"), event("$CSR")]).id, "$CSR");
  assert.equal(missileLaunchEvent([event("$AIM"), event("$CST")]).id, "$CST");
  assert.equal(missileLaunchEvent([event("$AIM"), event("$CAH")]), undefined);
});

const kit = (animation) => ({ startAnimation: -1, animation, effects: [], sound: 0 });
const missile = (extra = {}) => ({ path: "Spells\\Missile.m2", scale: 1, attachment: 22, speed: 20, sound: 0, ...extra });
const cast = { caster: 4n, casterPoint: { x: 0, y: 0, z: 0 }, targets: [{ guid: 9n, point: { x: 40, y: 0, z: 0 } }] };

test("15.11: only a visual without its own point and without a cast animation asks for the events", () => {
  const launchOf = (visual) => planSpellVisual(visual, cast, 0).instances.find((one) => one.flight).flight.launch;
  assert.equal(launchOf({ id: 1, missile: missile() }).events, true);
  assert.equal(launchOf({ id: 1, cast: kit(-1), missile: missile() }).events, true);
  assert.equal(launchOf({ id: 1, cast: kit(0), missile: missile() }).events, true);
  assert.equal(launchOf({ id: 1, cast: kit(53), missile: missile() }).events, undefined, "its animation's event launches it");
  assert.equal(launchOf({ id: 1, missile: missile({ launch: 1 }) }).events, undefined, "the visual's own point");
});

test("15.11: SpellVisual.Flags & 4 launches from the events even when the CastKit animates (0x00732ff0)", () => {
  const launchOf = (visual) => planSpellVisual(visual, cast, 0).instances.find((one) => one.flight).flight.launch;
  assert.equal(launchOf({ id: 1, cast: kit(124), missile: missile({ launchNow: true }) }).events, true);
  assert.equal(launchOf({ id: 1, cast: kit(124), missile: missile() }).events, undefined, "without the flag it waits");
  assert.equal(launchOf({ id: 1, cast: kit(124), missile: missile({ launchNow: true, launch: 1 }) }).events, undefined,
    "the visual's own point still wins (0x0072df00 → 0x00720bf0)");
});

test("15.11: a model with none of the three events launches from the unit's position (vfunc +0x2c = 0x006e6ef0)", () => {
  assert.equal(missileLaunchSource(undefined), undefined, "events not known yet: the caller's stand-in");
  assert.equal(missileLaunchSource([]), "position");
  assert.equal(missileLaunchSource([event("$AIM"), event("$BWR")]), "position");
  assert.equal(missileLaunchSource([event("$CST"), event("$CSR")]).id, "$CSR");
});

test("15.11: the flight leaves from the event when the model has one, else from the attachment", () => {
  const plan = planSpellVisual({ id: 1, missile: missile() }, cast, 0);
  const instance = plan.instances.find((one) => one.flight);
  const points = (withEvent) => ({
    point: (guid, attachment, out) => {
      if (guid === 9n) Object.assign(out, { x: 40, y: 0, z: 0 });
      else Object.assign(out, { x: 0, y: 1, z: 1 });
      return true;
    },
    castEvent: (guid, out) => {
      if (!withEvent) return false;
      Object.assign(out, { x: 0, y: -1, z: 2 });
      return true;
    },
  });
  const out = missileSample();
  flyMissileInstance(instance, 0, points(true), out);
  assert.deepEqual({ x: out.position.x, y: out.position.y, z: out.position.z }, { x: 0, y: -1, z: 2 });
  const other = planSpellVisual({ id: 1, missile: missile() }, cast, 0).instances.find((one) => one.flight);
  flyMissileInstance(other, 0, points(false), out);
  assert.deepEqual({ x: out.position.x, y: out.position.y, z: out.position.z }, { x: 0, y: 1, z: 1 });
});
