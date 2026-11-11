// 11.11 (6.12): where a spell missile leaves its caster — Wow.exe's fire point 0x00720bf0 (MissileAttachment through
// 0x00adaa20, MissileCastOffset in the attachment's frame) as the launch 0x0072df00 takes it; browser/SpellVisualAttach.ts
// `missileLaunchPoint`, SpellVisuals.ts (the plan), MissileFlight.ts (the read), gateway/SpellVisual.ts (`launch`).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { flyMissileInstance, missileSample } from "../dist/code/browser/MissileFlight.js";
import {
  ATTACH_SPELL_HAND_DIRECTED, MISSILE_DESTINATION_ATTACHMENTS, missileLaunchPoint,
} from "../dist/code/browser/SpellVisualAttach.js";
import { planSpellVisual } from "../dist/code/browser/SpellVisuals.js";

let dbcDirectory;
try {
  dbcDirectory = (await import("../tools/paths.mjs")).dbcDirectory();
} catch {
  dbcDirectory = undefined;
}
let visualFile;
try {
  visualFile = dbcDirectory ? await readFile(join(dbcDirectory, "SpellVisual.dbc")) : undefined;
} catch {
  visualFile = undefined;
}
const withDataset = { skip: visualFile ? false : "no SpellVisual.dbc in the tswow dataset on this machine" };

test("MissileAttachment is an index through 0x00adaa20 (0x0071a7f0), raw under Flags 0x200, moved by the cast offset", () => {
  assert.deepEqual(missileLaunchPoint({ launch: 2 }), { attachment: MISSILE_DESTINATION_ATTACHMENTS[2] },
    "index 2 is the ground under the feet (19), not the left hand (M2 id 2)");
  assert.equal(missileLaunchPoint({ launch: 1 }).attachment, 34, "index 1: the chest");
  assert.equal(missileLaunchPoint({ launch: 3 }).attachment, 21, "index 3: the left spell hand");
  assert.equal(missileLaunchPoint({ launch: 13 }).attachment, 22, "index 13: 0x00adaa30, the right spell hand");
  assert.equal(missileLaunchPoint({ launch: 40, destRaw: true }).attachment, 40, "Flags 0x200: the id itself");
  assert.deepEqual(missileLaunchPoint({ launch: 2, castOffset: [1, 2, 2.5] }), { attachment: 19, offset: [1, -2, 2.5] },
    "MissileCastOffset read as (x, −y, z)");
});

test("MissileAttachment −1: an offset is read on the directed spell hand (0x00adaa50); no offset leaves the caller's point", () => {
  assert.equal(ATTACH_SPELL_HAND_DIRECTED, MISSILE_DESTINATION_ATTACHMENTS[12]);
  assert.deepEqual(missileLaunchPoint({ castOffset: [1.65, 0, 0] }), { attachment: 38, offset: [1.65, -0, 0] });
  assert.deepEqual(missileLaunchPoint({ launch: -1, castOffset: [0, 0, 1] }), { attachment: 38, offset: [0, -0, 1] });
  assert.equal(missileLaunchPoint({}), undefined);
  assert.equal(missileLaunchPoint({ launch: -1, castOffset: [0, 0, 0] }), undefined);
});

test("the planner launches from the resolved attachment with the cast offset; without either, from `attachment`", () => {
  const cast = { caster: 1n, casterPoint: { x: 0, y: 0, z: 0 }, targets: [{ guid: 2n, point: { x: 30, y: 0, z: 0 } }] };
  const base = { path: "x.m2", scale: 1, attachment: 22, speed: 10 };
  const planned = (missile) => planSpellVisual({ id: 9, missile }, cast, 0).instances.find((one) => one.flight).flight.launch;
  assert.deepEqual(planned({ ...base, launch: 2, castOffset: [0, 0, 2.5] }), { guid: 1n, attachment: 19, offset: [0, -0, 2.5] });
  assert.deepEqual(planned({ ...base, launch: 1 }), { guid: 1n, attachment: 34 });
  assert.deepEqual(planned(base), { guid: 1n, attachment: 22 }, "an older gateway (no `launch`) keeps the spell hand");
});

test("the flight reads its fire point with the cast offset", () => {
  const asked = [];
  const points = {
    point(guid, attachment, out, offset) {
      asked.push({ guid, attachment, offset });
      out.x = guid === 1n ? 0 : 30; out.y = 0; out.z = guid === 1n ? (offset ? offset[2] : 0) : 1;
      return true;
    },
  };
  const instance = {
    startedAt: 0, endsAt: 3000,
    flight: {
      from: { x: 0, y: 0, z: 0 }, to: { x: 30, y: 0, z: 0 },
      launch: { guid: 1n, attachment: 19, offset: [0, 0, 2.5] }, target: { guid: 2n, attachment: 34 },
    },
  };
  const out = missileSample();
  assert.equal(flyMissileInstance(instance, 0, points, out), true);
  assert.deepEqual(asked.find((one) => one.guid === 1n), { guid: 1n, attachment: 19, offset: [0, 0, 2.5] });
  assert.ok(out.position.z > 2, `leaves 2.5 yards up: ${out.position.z}`);
});

test("dataset: the gateway carries MissileAttachment raw as `launch` whenever it is not −1", withDataset, async () => {
  const { parseSpellVisuals } = await import("../dist/code/gateway/SpellVisual.js");
  const read = (name) => readFile(join(dbcDirectory, name));
  const visuals = parseSpellVisuals(await read("Spell.dbc"), visualFile, await read("SpellVisualKit.dbc"),
    await read("SpellVisualEffectName.dbc"));
  let launches = 0;
  let offsets = 0;
  for (const visual of visuals.values()) {
    const missile = visual.missile ?? visual.ammoMissile;
    if (!missile) continue;
    assert.notEqual(missile.launch, -1);
    if (missile.launch !== undefined) launches++;
    if (missile.launch !== undefined && missile.castOffset) offsets++;
  }
  assert.ok(launches > 0, `spells whose missile names a MissileAttachment: ${launches}`);
  assert.ok(offsets > 0, `of them with a MissileCastOffset: ${offsets}`);
});
