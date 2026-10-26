// 6.31 (26.10, owner: «анимации способностей иногда повторяются дважды, мигают, снаряды пропадают раньше
// времени»): the spell visual mechanisms the audit of 26.10 traced to those symptoms, each pinned here.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as THREE from "three";
import {
  MISSILE_OVERRUN_MS, flyMissileInstance, missileSample, missileStillFlying,
} from "../dist/code/browser/MissileFlight.js";
import { selectVisualEffectGroups } from "../dist/code/browser/WorldRenderer3D.js";
import { SPELL_LIGHT_GATHER, SPELL_LIGHT_SLOT_HOLD, SpellLights } from "../dist/code/browser/SpellLights.js";

const renderer = () => readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");

function points(map) {
  return {
    point(guid, attachment, out) {
      const at = map.get(`${guid}:${attachment}`);
      if (!at) return false;
      out.x = at.x; out.y = at.y; out.z = at.z;
      return true;
    },
  };
}

test("a missile later than planned is still flying past its planned life, and the sweep keeps it", async () => {
  // Planned for 1 s over 20 yards; the target runs away, so the bolt (homing at its launch speed) is late.
  const where = new Map([["1:22", { x: 0, y: 0, z: 0 }], ["2:34", { x: 20, y: 0, z: 0 }]]);
  const instance = { startedAt: 0, endsAt: 1000,
    flight: { from: { x: 0, y: 0, z: 0 }, to: { x: 20, y: 0, z: 0 },
      launch: { guid: 1n, attachment: 22 }, target: { guid: 2n, attachment: 34 } } };
  const out = missileSample();
  let now = 0;
  assert.equal(flyMissileInstance(instance, now, points(where), out), true);
  for (now = 16; now < 1000; now += 16) {
    where.set("2:34", { x: 20 + now * 0.006, y: 0, z: 0 }); // 6 yd/s away
    flyMissileInstance(instance, now, points(where), out);
  }
  // The renderer's sweep runs before this frame's flight: at the planned end the missile must still be on its way.
  assert.ok(now >= instance.endsAt - 16, "the planned life is (about to be) over");
  assert.equal(missileStillFlying(instance, now), true, "not arrived: the sweep keeps it");
  while (flyMissileInstance(instance, (now += 16), points(where), out) && now < 10_000) {
    where.set("2:34", { x: 20 + Math.min(now, 1200) * 0.006, y: 0, z: 0 });
  }
  assert.ok(Math.abs(out.position.x - (20 + 1200 * 0.006)) < 0.5, `arrives at the target: ${out.position.x}`);
  assert.equal(missileStillFlying(instance, now), false, "arrived: the sweep may take it");
  // And never forever: past the overrun nothing is kept.
  const stuck = { startedAt: 0, endsAt: 1000, flight: { from: { x: 0, y: 0, z: 0 }, to: { x: 20, y: 0, z: 0 } } };
  flyMissileInstance(stuck, 0, points(new Map()), out);
  assert.equal(missileStillFlying(stuck, 1000 + MISSILE_OVERRUN_MS + 1), false);
  assert.equal(missileStillFlying({}, 0), false, "a visual that never flew is not a missile");

  const source = await renderer();
  assert.match(source, /if \(visual\.instance\.endsAt > now\s+\/\/[^\n]*\n\s+\|\| missileStillFlying\(visual\.instance, now\)/,
    "the sweep asks before it removes");
});

test("a released phase keeps its origin while dropped for a frame; an arrived missile does not reject its phase", async () => {
  const source = await renderer();
  const start = source.indexOf("// Install the shared local origin only after the effect budget admits the complete phase.");
  const block = source.slice(start, source.indexOf("// Spell batch alpha/weight tracks", start));
  assert.match(block, /if \(!admitted\) continue;/);
  assert.ok(!block.includes("visual.phaseOriginAt = undefined"), "the origin is never cleared once set");
  assert.match(source,
    /rootVisible: visual\.node\.visible \|\| \(visual\.instance\.flight !== undefined && visual\.instance\.endsAt <= now\),/);
});

test("the emitter allowance keeps last frame's kits before nearer newcomers", () => {
  const entries = [
    { key: "far-kit", handleId: 1, distance: 30 },
    { key: "near-kit", handleId: 2, distance: 5 },
  ];
  assert.deepEqual(selectVisualEffectGroups(entries, 1).selected.map((entry) => entry.key), ["near-kit"]);
  const kept = selectVisualEffectGroups(entries, 1, undefined, new Set([1]));
  assert.deepEqual(kept.selected.map((entry) => entry.key), ["far-kit"], "admitted last frame: it stays");
  assert.equal(kept.droppedGroups, 1);
  // With room for both, nothing changes but the order.
  assert.equal(selectVisualEffectGroups(entries, 2, undefined, new Set([1])).selected.length, 2);
});

test("a spell light keeps its slot against a slightly brighter newcomer, not a much brighter one", () => {
  const lights = new SpellLights();
  const sample = { position: new THREE.Vector3(), colour: new THREE.Vector3(), radius: 0, intensity: 0 };
  const apart = SPELL_LIGHT_GATHER * 3;
  const frame = (energies) => {
    lights.begin();
    energies.forEach((energy, index) => {
      if (!(energy > 0)) return;
      Object.assign(lights.glowOf(keys[index]), {
        energy, red: energy, green: energy, blue: energy, x: energy * index * apart, y: 0, z: 0,
      });
    });
    lights.end(1 / 60);
    const shown = [];
    lights.forEach(sample, (light) => shown.push(Math.round(light.position.x / apart)));
    return shown.sort();
  };
  const keys = [{}, {}, {}];
  let shown;
  for (let index = 0; index < 60; index++) shown = frame([4, 3, 0]);
  assert.deepEqual(shown, [0, 1]);
  for (let index = 0; index < 60; index++) shown = frame([4, 3, 3.6]);
  assert.deepEqual(shown, [0, 1], "a little brighter: the slot holds");
  assert.ok(SPELL_LIGHT_SLOT_HOLD > 1);
  for (let index = 0; index < 60; index++) shown = frame([4, 3, 40]);
  assert.deepEqual(shown, [0, 2], "much brighter: it takes the dimmer slot");
});
