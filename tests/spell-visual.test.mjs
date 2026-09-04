import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import {
  parseSpellGo, TARGET_FLAG_CORPSE_ALLY, TARGET_FLAG_CORPSE_ENEMY, TARGET_FLAG_DEST_LOCATION,
  TARGET_FLAG_GAMEOBJECT, TARGET_FLAG_ITEM, TARGET_FLAG_SOURCE_LOCATION, TARGET_FLAG_STRING,
  TARGET_FLAG_TRADE_ITEM, TARGET_FLAG_UNIT, TARGET_FLAG_UNIT_MINIPET,
} from "../dist/code/world/SpellProtocol.js";
import {
  applySpellVisualTransformFrame, composeSpellVisualTransform, placeOnAttachmentBone,
} from "../dist/code/browser/WorldRenderer3D.js";
import { attachmentOffset } from "../dist/code/browser/Attachment.js";
import {
  loadSpellVisualKits, loadSpellVisuals, parseSpellVisualKits, parseSpellVisuals,
} from "../dist/code/gateway/SpellVisual.js";
import {
  AREA_EFFECT_SIZE_MAX_GROWTH, CAST_KIT_MS, IMPACT_KIT_MS, MISSILE_ARC, MISSILE_FALLBACK_SPEED,
  MISSILE_MAX_SECONDS, areaEffectScale,
  expiredInstances, missileDirection, missilePoint, missileSeconds, planSpellAuraDone, planSpellAuraState, planSpellCastStart,
  planSpellVisual, spellVisualTransformEuler, spellVisualTransformOffset,
} from "../dist/code/browser/SpellVisuals.js";

let dbcDirectory;
try {
  dbcDirectory = (await import("../tools/paths.mjs")).dbcDirectory();
} catch {
  dbcDirectory = undefined;
}
const withDataset = { skip: dbcDirectory ? false : "no tswow dataset on this machine" };

function modelAttachPayload(rows) {
  const payload = new Uint8Array(20 + rows.length * 40 + 1);
  const view = new DataView(payload.buffer);
  payload.set([0x57, 0x44, 0x42, 0x43]); // WDBC
  view.setUint32(4, rows.length, true);
  view.setUint32(8, 10, true);
  view.setUint32(12, 40, true);
  view.setUint32(16, 1, true);
  rows.forEach((row, index) => {
    const offset = 20 + index * 40;
    view.setInt32(offset, row.id, true);
    view.setInt32(offset + 4, row.parent, true);
    view.setInt32(offset + 8, row.effect, true);
    view.setInt32(offset + 12, row.attachment, true);
    for (let component = 0; component < 3; component++) {
      view.setFloat32(offset + 16 + component * 4, row.offset?.[component] ?? 0, true);
    }
    view.setFloat32(offset + 28, row.yaw ?? 0, true);
    view.setFloat32(offset + 32, row.pitch ?? 0, true);
    view.setFloat32(offset + 36, row.roll ?? 0, true);
  });
  return payload;
}

// patch-W's row 1061 stores this exact float (raw bits 1070134723), rather than an idealized
// mathematical PI/2. Keep the fixture at the authored value so a later DBC conversion cannot
// silently normalize the Cone of Cold orientation.
const CONE_OF_COLD_PITCH = 1.57000005245;

/* --- SMSG_SPELL_GO ---------------------------------------------------------------------------- */

/** A packed guid, as the wire writes one: a mask byte then the non-zero bytes. */
function packed(value) {
  const bytes = [0];
  for (let index = 0; index < 8; index++) {
    const byte = Number((value >> BigInt(index * 8)) & 0xffn);
    if (byte === 0) continue;
    bytes[0] |= 1 << index;
    bytes.push(byte);
  }
  return bytes;
}

function full(value) {
  const bytes = [];
  for (let index = 0; index < 8; index++) bytes.push(Number((value >> BigInt(index * 8)) & 0xffn));
  return bytes;
}

function u32(value) {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff];
}

function f32(value) {
  return [...new Uint8Array(Float32Array.of(value).buffer)];
}

function spellGo({ caster = 5n, unit = 5n, spellId = 133, hits = [], misses = [], destination } = {}) {
  return Uint8Array.from([
    ...packed(caster), ...packed(unit),
    1,                       // castCount
    ...u32(spellId),
    ...u32(0),               // castFlags
    ...u32(1234),            // timestamp
    hits.length, ...hits.flatMap(full),
    // A reflect writes the result of the reflection after its reason, and nothing else does.
    misses.length, ...misses.flatMap(({ guid, reason }) => [...full(guid), reason, ...(reason === 11 ? [0] : [])]),
    ...(destination ? [...u32(0x40), ...packed(0n), ...f32(destination.x), ...f32(destination.y), ...f32(destination.z)] : []),
  ]);
}

test("a cast says who it landed on, not just that it happened", () => {
  // The header alone stops at the timestamp, and the renderer was left guessing the target from
  // UNIT_FIELD_TARGET — empty for every area spell, stale for anything mid-swap, and absent for
  // whatever a totem does. The hit list is eleven bytes further in and is the server's own answer.
  const packet = spellGo({ caster: 0x1234n, unit: 0x1234n, spellId: 133, hits: [7n, 9n, 0xdeadbeefn] });
  const cast = parseSpellGo(packet);
  assert.equal(cast.spellId, 133);
  assert.equal(cast.casterUnit, 0x1234n);
  assert.deepEqual(cast.hits, [7n, 9n, 0xdeadbeefn]);
  assert.deepEqual(cast.misses, []);
});

test("a miss carries its reason, and a reflect carries one byte more", () => {
  // SPELL_MISS_REFLECT is the only reason that writes the result of the reflection after itself,
  // and it is 11. Three is a dodge — this repository's own MISS_REASONS says so and the reference
  // client agrees — so reading three as the reflect ate a byte after every dodged attack and
  // shifted every target behind it.
  const cast = parseSpellGo(spellGo({
    hits: [1n],
    misses: [{ guid: 2n, reason: 1 }, { guid: 3n, reason: 11 }, { guid: 4n, reason: 2 }],
  }));
  assert.deepEqual(cast.hits, [1n]);
  assert.deepEqual(cast.misses.map((miss) => miss.guid), [2n, 3n, 4n]);
  assert.deepEqual(cast.misses.map((miss) => miss.reason), [1, 11, 2]);
});

test("a dodge does not eat the target behind it", () => {
  // The case the wrong constant broke: three is the commonest miss reason there is, and reading
  // it as a reflect took a byte that belonged to the next guid.
  const cast = parseSpellGo(spellGo({
    misses: [{ guid: 0x11n, reason: 3 }, { guid: 0x22n, reason: 3 }, { guid: 0x33n, reason: 4 }],
  }));
  assert.deepEqual(cast.misses.map((miss) => miss.guid), [0x11n, 0x22n, 0x33n]);
  assert.deepEqual(cast.misses.map((miss) => miss.reason), [3, 3, 4]);
});

test("a packet that stops early stops the reader with it", () => {
  // A legacy/private packet can still stop after the target lists.
  const packet = spellGo({ hits: [1n, 2n] }).slice(0, 20);
  const cast = parseSpellGo(packet);
  assert.ok(Array.isArray(cast.hits));
  assert.ok(cast.hits.length <= 2);
});

test("SpellCastTargets destination is parsed when present, and remains optional for old packets", () => {
  const old = parseSpellGo(spellGo({ hits: [1n] }));
  assert.equal(old.targets, undefined);
  const cast = parseSpellGo(spellGo({
    destination: { x: 10.5, y: -2.25, z: 7 },
  }));
  assert.equal(cast.targets.targetFlags, 0x40);
  assert.deepEqual(cast.targets.destination, { x: 10.5, y: -2.25, z: 7 });
});

test("SpellCastTargets consumes the mutually-exclusive GUID groups before source/destination/string", () => {
  const flags = TARGET_FLAG_UNIT | TARGET_FLAG_ITEM | TARGET_FLAG_SOURCE_LOCATION
    | TARGET_FLAG_DEST_LOCATION | TARGET_FLAG_STRING;
  // Keep this fixture explicit: the target section is the real wire order, with both GUID groups
  // before the coordinate fields. The old short fixture above remains a separate regression.
  const base = spellGo({ hits: [1n] });
  const target = [
    ...u32(flags), ...packed(0x1234n), ...packed(0x5678n),
    ...packed(0n), ...f32(1), ...f32(2), ...f32(3), ...packed(0n),
    ...f32(10), ...f32(20), ...f32(30),
    ...new TextEncoder().encode("chain"), 0,
  ];
  const cast = parseSpellGo(Uint8Array.from([...base, ...target]));
  assert.equal(TARGET_FLAG_STRING, 0x2000);
  assert.equal(cast.targets.targetFlags, flags);
  assert.equal(cast.targets.unitTarget, 0x1234n);
  assert.equal(cast.targets.itemTarget, 0x5678n);
  assert.deepEqual(cast.targets.source, { x: 1, y: 2, z: 3 });
  assert.deepEqual(cast.targets.destination, { x: 10, y: 20, z: 30 });
  assert.equal(cast.targets.targetString, "chain");
  for (const objectFlag of [TARGET_FLAG_UNIT, TARGET_FLAG_UNIT_MINIPET, TARGET_FLAG_GAMEOBJECT,
    TARGET_FLAG_CORPSE_ENEMY, TARGET_FLAG_CORPSE_ALLY]) {
    const objectTarget = spellGo({ hits: [1n] });
    const objectCast = parseSpellGo(Uint8Array.from([
      ...objectTarget, ...u32(objectFlag | TARGET_FLAG_TRADE_ITEM), ...packed(0x99n), ...packed(0x88n),
    ]));
    assert.equal(objectCast.targets.itemTarget, 0x88n);
    assert.equal(objectFlag === TARGET_FLAG_GAMEOBJECT ? objectCast.targets.gameObjectTarget : objectCast.targets.unitTarget, 0x99n);
  }
});

/* --- The DBC chain ---------------------------------------------------------------------------- */

test("a spell resolves to the models the client shows for it", withDataset, async () => {
  // Four tables deep: Spell.SpellVisualID to SpellVisual to SpellVisualKit to
  // SpellVisualEffectName. The last one stores `.mdx`, which is Warcraft III's extension and is
  // not in the archives at all; the file on disk is `.m2`.
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const read = (name) => readFile(join(dbcDirectory, name));
  const visuals = parseSpellVisuals(
    await read("Spell.dbc"), await read("SpellVisual.dbc"),
    await read("SpellVisualKit.dbc"), await read("SpellVisualEffectName.dbc"));

  const fireball = visuals.get(133);
  assert.ok(fireball, "Fireball has a visual");
  assert.ok(fireball.precast, "and a wind-up");
  const hands = fireball.precast.effects.map((effect) => effect.attachment).sort((a, b) => a - b);
  assert.deepEqual(hands, [21, 22], "one flourish in each spell hand");
  for (const effect of fireball.precast.effects) {
    assert.ok(effect.path.toLowerCase().endsWith(".m2"), `${effect.path} is an m2, not an mdx`);
    assert.ok(/fire/i.test(effect.path), `${effect.path} is a fire effect`);
  }
  assert.ok(fireball.missile, "and a bolt");
  assert.ok(/fireball/i.test(fireball.missile.path), fireball.missile.path);
  // Spell.Speed, in yards a second. Nothing on the wire says how long a bolt is in the air.
  assert.equal(fireball.missile.speed, 24);

  // The school shows in the file names, which is the cheapest possible check that the chain is
  // not returning the same rows for everything.
  assert.ok(/ice|frost/i.test(visuals.get(116).precast.effects[0].path), "Frostbolt is cold");
  assert.ok(/nature/i.test(visuals.get(5185).precast.effects[0].path), "Healing Touch is nature");
  assert.ok(/shadow/i.test(visuals.get(686).precast.effects[0].path), "Shadow Bolt is shadow");
});

test("SpellVisualKitModelAttach merges kit 1027 with its authored transform and drops dangling parents", withDataset, async () => {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const read = (name) => readFile(join(dbcDirectory, name));
  const visuals = parseSpellVisuals(
    await read("Spell.dbc"), await read("SpellVisual.dbc"),
    await read("SpellVisualKit.dbc"), await read("SpellVisualEffectName.dbc"), undefined,
    modelAttachPayload([
      { id: 1061, parent: 1027, effect: 4884, attachment: 17, pitch: CONE_OF_COLD_PITCH },
      { id: 5001, parent: 20015, effect: 4884, attachment: 18, offset: [-0.37, 0, -0.64], yaw: -0.25 },
      { id: 5002, parent: 1027, effect: 4884, attachment: 18, yaw: Number.NaN },
    ]));
  const coneEffects = visuals.get(120)?.cast?.effects.filter((candidate) =>
    candidate.path.includes("ConeofCold_Mouth"));
  const effect = coneEffects?.[0];
  assert.ok(effect, "Cone of Cold reaches the kit row");
  assert.equal(coneEffects.length, 1, "malformed transforms are omitted, not converted to zero");
  assert.equal(effect.attachment, 17);
  assert.deepEqual(effect.transform.offset, [0, 0, 0]);
  assert.ok(Math.abs(effect.transform.rotation[1] - CONE_OF_COLD_PITCH) < 1e-7);
  assert.equal([...visuals.values()].flatMap((visual) => Object.values(visual)
    .flatMap((phase) => phase?.effects ?? [])).filter((candidate) =>
      candidate.transform?.offset[0] === -0.37).length, 0,
    "rows whose parent kit is absent do not become dangling spell effects");
  const instance = planSpellVisual(visuals.get(120), {
    caster: 1n, casterPoint: { x: 0, y: 0, z: 0 }, targets: [],
  }, 100).instances.find((candidate) => candidate.path.includes("ConeofCold_Mouth"));
  assert.deepEqual(instance.transform.offset, [0, 0, 0]);
  assert.deepEqual(spellVisualTransformOffset(instance.transform, true), { x: 0, y: 0, z: 0 });
  assert.deepEqual(spellVisualTransformEuler(instance.transform), {
    x: 0, y: instance.transform.rotation[1], z: 0, order: "ZYX",
  });
});

test("visual DBC override replaces only model-attach input", withDataset, async () => {
  const { mkdtemp, readFile, rm, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const overrideDirectory = await mkdtemp(join(tmpdir(), "spell-visual-"));
  try {
    // A deliberately invalid gameplay DBC in the visual directory proves that the override is
    // scoped to the visual-only table; the loader must continue reading Spell/SpellVisual/etc.
    await writeFile(join(overrideDirectory, "Spell.dbc"), Buffer.from("not a dbc"));
    await writeFile(join(overrideDirectory, "SpellVisualKitModelAttach.dbc"), modelAttachPayload([
      { id: 1061, parent: 1027, effect: 4884, attachment: 17, pitch: CONE_OF_COLD_PITCH },
    ]));
    const visuals = await loadSpellVisuals(dbcDirectory, overrideDirectory);
    const effect = visuals.get(120)?.cast?.effects.find((candidate) =>
      candidate.path.includes("ConeofCold_Mouth"));
    assert.ok(effect, "the override row is loaded through the normal dataset chain");
    assert.equal(effect.attachment, 17);
    assert.ok(Math.abs(effect.transform.rotation[1] - CONE_OF_COLD_PITCH) < 1e-7);
    // The dataset gameplay table remains authoritative even though a same-named file is present
    // beside the visual override.
    assert.ok(visuals.get(133)?.precast, "gameplay DBCs are not redirected to the overlay");
  } finally {
    await rm(overrideDirectory, { recursive: true, force: true });
  }
});

test("model-attach transforms preserve M2 offset axes and rotation composition", () => {
  const transform = { offset: [1.25, -2, 3], rotation: [0.3, 0.4, -0.2] };
  assert.deepEqual(spellVisualTransformOffset(transform, true), { x: 1.25, y: -2, z: 3 });
  assert.deepEqual(spellVisualTransformOffset(transform, false), { x: 1.25, y: 3, z: 2 });
  assert.deepEqual(spellVisualTransformEuler(transform), { x: -0.2, y: 0.4, z: 0.3, order: "ZYX" });

  const local = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.2, 0.4, 0.3, "ZYX"));
  const modelToScene = new THREE.Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2);
  const sceneToModel = modelToScene.clone().invert();
  const expected = [
    modelToScene.clone().multiply(local),
    local.clone(),
    modelToScene.clone().multiply(local).multiply(sceneToModel),
    local.clone().multiply(sceneToModel),
  ];
  const actual = [
    composeSpellVisualTransform(transform, false, false),
    composeSpellVisualTransform(transform, true, false),
    composeSpellVisualTransform(transform, false, true),
    composeSpellVisualTransform(transform, true, true),
  ];
  for (let index = 0; index < actual.length; index++) {
    assert.ok(actual[index].angleTo(expected[index]) < 1e-7, `composition ${index}`);
  }

  // Exercise the renderer-facing helper as well as the pure quaternion function: a regression
  // that computes the right answer but forgets to copy it onto the frame leaves the live effect
  // visibly unrotated while still passing the composition table above.
  const frame = new THREE.Object3D();
  frame.quaternion.identity();
  applySpellVisualTransformFrame(frame, transform, true, true);
  assert.ok(frame.quaternion.angleTo(expected[3]) < 1e-7, "frame receives authored rotation");
  assert.deepEqual(frame.position.toArray(), [1.25, -2, 3], "attached offset reaches the frame");
});

test("Paladin Judgement keeps its complete authored impact model family", withDataset, async () => {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const read = (name) => readFile(join(dbcDirectory, name));
  const visuals = parseSpellVisuals(
    await read("Spell.dbc"), await read("SpellVisual.dbc"),
    await read("SpellVisualKit.dbc"), await read("SpellVisualEffectName.dbc"));
  for (const [spellId, suffix] of [[20271, "judgement_impact_chest.m2"],
    [53407, "judgement_impact_chest_red.m2"], [53408, "judgement_impact_chest_blue.m2"]]) {
    const impact = visuals.get(spellId)?.impact;
    assert.ok(impact, `${spellId} has an impact phase`);
    assert.deepEqual(impact.effects.map((effect) => effect.path.toLowerCase()), [`spells\\${suffix}`]);
    assert.equal(impact.effects[0].attachment, 34, `${spellId} remains target-bound`);
  }
});

test("every model a spell names is one the archives can serve", withDataset, async () => {
  // A `.mdl` row is a `zzOLD__` leftover and no such file exists; dropping them here is what keeps
  // the browser from asking for a model that will 404 on every cast for the rest of the session.
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const read = (name) => readFile(join(dbcDirectory, name));
  const visuals = parseSpellVisuals(
    await read("Spell.dbc"), await read("SpellVisual.dbc"),
    await read("SpellVisualKit.dbc"), await read("SpellVisualEffectName.dbc"));

  let paths = 0;
  for (const visual of visuals.values()) {
    for (const phase of [
      "precast", "cast", "impact", "state", "stateDone", "channel", "casterImpact", "targetImpact",
      "missileTargeting", "instantArea", "impactArea", "persistentArea",
    ]) {
      for (const effect of visual[phase]?.effects ?? []) {
        assert.ok(effect.path.toLowerCase().endsWith(".m2"), effect.path);
        assert.ok(effect.scale > 0, `${effect.path} has a scale`);
        paths++;
      }
    }
    if (visual.missile) assert.ok(visual.missile.path.toLowerCase().endsWith(".m2"), visual.missile.path);
  }
  assert.ok(paths > 50_000, `the table is whole: ${paths} placements`);
  assert.ok(visuals.size > 25_000, `and reaches most of the spellbook: ${visuals.size} spells`);
});

/* --- The plan ---------------------------------------------------------------------------------- */

const kit = (paths, attachment = 22, animation = -1) => ({
  startAnimation: -1,
  animation,
  effects: paths.map((path) => ({ path, attachment, scale: 1 })),
  sound: 0,
});

test("a bolt takes as long as the distance and the spell's own speed say", () => {
  // 24 yards at 24 yards a second is one second, and nothing on the wire says so — Spell.Speed is
  // the only place the number lives.
  assert.equal(missileSeconds(24, 24), 1);
  assert.ok(Math.abs(missileSeconds(48, 24) - 2) < 1e-9);
  // Zero-speed authored missiles use the one corpus-wide fallback, not disappearance.
  assert.equal(missileSeconds(24, 0), 24 / MISSILE_FALLBACK_SPEED);
  assert.ok(missileSeconds(0.01, 0) > 0, "fallback remains positive for every non-zero distance");
  // And a bolt fired at somebody standing on top of you arrives at once rather than flickering.
  assert.equal(missileSeconds(0.2, 24), 0);
  assert.equal(missileSeconds(1000, 24), MISSILE_MAX_SECONDS, "a long shot is capped, not endless");
});

test("a bolt leaves the hand and arrives at the target, bowing in between", () => {
  const from = { x: 0, y: 0, z: 10 };
  const to = { x: 30, y: 0, z: 10 };
  const out = { x: 0, y: 0, z: 0 };
  // Both ends exactly, or the bolt is thrown from beside the caster at something beside the
  // target. The arc has to vanish there and only there.
  assert.deepEqual(missilePoint(from, to, 0, out), { x: 0, y: 0, z: 10 });
  assert.deepEqual(missilePoint(from, to, 1, out), { x: 30, y: 0, z: 10 });
  const middle = missilePoint(from, to, 0.5, { x: 0, y: 0, z: 0 });
  assert.equal(middle.x, 15);
  assert.ok(Math.abs(middle.z - (10 + 30 * MISSILE_ARC)) < 1e-9, `${middle.z} at the top of the arc`);
  // Off both ends it holds rather than flying on past.
  assert.deepEqual(missilePoint(from, to, 2, out), { x: 30, y: 0, z: 10 });
});

test("a bolt's facing follows the 3D tangent of its bowed flight", () => {
  const direction = { x: 0, y: 0, z: 0 };
  missileDirection({ x: 0, y: 0, z: 0 }, { x: 30, y: 8, z: 10 }, 0.5, direction);
  // At the apex the bow has no vertical derivative, so the tangent is exactly the endpoint
  // delta. This catches the old yaw-only path, which could not expose a target's z component.
  assert.deepEqual(direction, { x: 30, y: 8, z: 10 });
  missileDirection({ x: 0, y: 0, z: 0 }, { x: 30, y: 8, z: 10 }, 0, direction);
  assert.ok(direction.z > 10, "the launch tangent follows the upward arc");
});

test("a cast plays now and its flash plays when the bolt gets there", () => {
  const visual = {
    id: 133,
    cast: kit(["Spells\\Fire_Cast_Hand.m2"], 22, 53),
    impact: kit(["Spells\\Fireball_Impact.m2"], 34),
    missile: { path: "Spells\\Fireball_Missile.m2", scale: 1, attachment: 22, speed: 24 },
  };
  const now = 1000;
  const plan = planSpellVisual(visual, {
    caster: 1n,
    casterPoint: { x: 0, y: 0, z: 0 },
    targets: [{ guid: 2n, point: { x: 24, y: 0, z: 0 } }],
  }, now);

  const cast = plan.instances.find((one) => one.path.includes("Cast_Hand"));
  assert.ok(cast);
  assert.equal(cast.anchor, 1n, "the flourish is on the caster");
  assert.equal(cast.startedAt, now);
  assert.equal(cast.endsAt, now + CAST_KIT_MS);

  const bolt = plan.instances.find((one) => one.flight);
  assert.ok(bolt, "there is a bolt");
  assert.equal(bolt.startedAt, now);
  // 24 yards at 24 yards a second.
  assert.equal(bolt.endsAt, now + 1000);
  assert.deepEqual(bolt.flight.to, { x: 24, y: 0, z: 0 });

  const impact = plan.instances.find((one) => one.path.includes("Impact"));
  assert.ok(impact, "and a flash at the far end");
  assert.equal(impact.anchor, 2n, "on the target");
  assert.equal(impact.startedAt, bolt.endsAt, "when the bolt arrives, not when it left");
  assert.equal(impact.endsAt, bolt.endsAt + IMPACT_KIT_MS);

  assert.deepEqual(plan.animations, [{ guid: 1n, animation: 53, at: 1000, hold: 0, mode: "once" }]);
  assert.deepEqual(plan.sounds, []);
});

test("precast and channel plans are real timed kits, and all impact phases coexist", () => {
  const visual = {
    id: 1,
    precast: kit(["Spells\\Precast.m2"], 21, 52),
    channel: kit(["Spells\\Channel.m2"], 22, 125),
    casterImpact: kit(["Spells\\CasterImpact.m2"], 19),
    missileTargeting: kit(["Spells\\Targeting.m2"], 34),
    impact: kit(["Spells\\Impact.m2"], 34),
    targetImpact: kit(["Spells\\TargetImpact.m2"], 34),
    instantArea: kit(["Spells\\InstantArea.m2"], 22),
    impactArea: kit(["Spells\\ImpactArea.m2"], 23),
    persistentArea: kit(["Spells\\PersistentArea.m2"], 24),
    durationMs: 8_000,
    missile: { path: "Spells\\Missile.m2", scale: 1, attachment: 22, speed: 0, sound: 12 },
    missileSound: 13,
    animEventSound: 14,
  };
  const cast = {
    caster: 1n,
    casterPoint: { x: 0, y: 0, z: 0 },
    targets: [{ guid: 2n, point: { x: 24, y: 0, z: 0 } }],
    destination: { x: 12, y: 3, z: 0 },
  };
  const start = planSpellCastStart(visual, { ...cast, castTime: 1500, channel: false }, 100);
  assert.equal(start.instances[0].startedAt, 100);
  assert.equal(start.instances[0].endsAt, 1600);
  const channel = planSpellCastStart(visual, { ...cast, castTime: 2000, channel: true }, 100);
  assert.equal(channel.instances[0].endsAt, 2100);
  const plan = planSpellVisual(visual, cast, 1000);
  assert.equal(plan.instances.filter((one) => one.flight).length, 1, "zero speed still flies");
  const directImpacts = plan.instances.filter((one) =>
    one.path.endsWith("\\Impact.m2") || one.path.endsWith("\\TargetImpact.m2"));
  assert.equal(directImpacts.length, 2);
  assert.ok(plan.instances.some((one) => one.path.includes("Targeting")));
  assert.deepEqual(plan.instances.find((one) => one.path.includes("InstantArea")).position, cast.destination);
  for (const instance of plan.instances.filter((one) => one.path.includes("Area"))) {
    assert.deepEqual(instance.position, cast.destination);
    assert.equal(instance.anchor, undefined, "area effects do not attach to the caster");
  }
  assert.equal(plan.instances.find((one) => one.path.includes("CasterImpact")).startedAt, 2_000);
  assert.equal(plan.instances.find((one) => one.path.includes("PersistentArea")).endsAt, 10_000);
  assert.deepEqual(plan.sounds.map((sound) => sound.sound).sort((a, b) => a - b), [13, 14]);
});

test("unit spell playback separates one-shots from held poses and preserves startAnimation", () => {
  const cast = { caster: 1n, casterPoint: { x: 0, y: 0, z: 0 }, targets: [] };
  const visual = {
    id: 1,
    cast: {
      startAnimation: 11, animation: 22,
      effects: [{ path: "Spells\\Cast.m2", attachment: 22, scale: 1 }], sound: 0,
    },
    precast: {
      startAnimation: 31, animation: 32,
      effects: [{ path: "Spells\\Precast.m2", attachment: 22, scale: 1 }], sound: 0,
    },
  };
  const go = planSpellVisual(visual, cast, 1_000);
  assert.deepEqual(go.animations, [{
    guid: 1n, animation: 11, at: 1_000, hold: 0, mode: "once",
    followUp: { animation: 22, mode: "once", hold: 0 },
  }]);
  const start = planSpellCastStart(visual, { ...cast, castTime: 1_500 }, 2_000);
  assert.deepEqual(start.animations, [{
    guid: 1n, animation: 31, at: 2_000, hold: 0, mode: "once",
    followUp: { animation: 32, mode: "hold", hold: 1_500 },
  }]);
  assert.equal(start.instances[0].fitToModel, undefined,
    "packet-owned precast lifetime is not extended by a model clip");
});

test("finite spell VFX can fit a model clip without extending flights or persistent auras", () => {
  const visual = {
    id: 1,
    missile: { path: "Spells\\Bolt.m2", scale: 1, attachment: 22, speed: 24 },
    cast: { startAnimation: -1, animation: -1,
      effects: [{ path: "Spells\\Cast.m2", attachment: 22, scale: 1 }], sound: 0 },
    impact: { startAnimation: -1, animation: -1,
      effects: [{ path: "Spells\\Impact.m2", attachment: 22, scale: 1 }], sound: 0 },
    persistentArea: { startAnimation: -1, animation: -1,
      effects: [{ path: "Spells\\Area.m2", attachment: -1, scale: 1 }], sound: 0 },
    durationMs: 4_000,
  };
  const plan = planSpellVisual(visual, {
    caster: 1n, casterPoint: { x: 0, y: 0, z: 0 },
    targets: [{ guid: 2n, point: { x: 24, y: 0, z: 0 } }],
  }, 0);
  assert.equal(plan.instances.find((one) => one.path.endsWith("Cast.m2")).fitToModel, true);
  const persistent = plan.instances.find((one) => one.path.endsWith("Area.m2"));
  assert.equal(persistent.fitToModel, undefined);
  assert.equal(persistent.modelPlayback, "hold",
    "persistent area model clips loop for the packet-owned lifetime");
  assert.equal(plan.instances.find((one) => one.flight).fitToModel, undefined);
});

test("future impact animations carry their absolute arrival time", () => {
  const visual = {
    id: 1,
    missile: { path: "Spells\\Missile.m2", scale: 1, attachment: 22, speed: 24 },
    impact: kit(["Spells\\Impact.m2"], 34, 53),
  };
  const plan = planSpellVisual(visual, {
    caster: 1n, casterPoint: { x: 0, y: 0, z: 0 },
    targets: [{ guid: 2n, point: { x: 24, y: 0, z: 0 } }],
  }, 500);
  assert.deepEqual(plan.animations, [{ guid: 2n, animation: 53, at: 1500, hold: 0, mode: "once" }]);
});

test("a synthetic static target keeps effects but never asks unit 0 to animate", () => {
  const visual = {
    id: 1,
    cast: kit(["Spells\\Cast.m2"], 22, 51),
    impact: kit(["Spells\\Impact.m2"], 34, 52),
    instantArea: kit(["Spells\\Area.m2"], 22, 53),
  };
  const plan = planSpellVisual(visual, {
    caster: 1n,
    casterPoint: { x: 1, y: 2, z: 3 },
    targets: [{ guid: 0n, point: { x: 40, y: 41, z: 42 } }],
    destination: { x: 40, y: 41, z: 42 },
  }, 1000);
  assert.ok(plan.instances.some((instance) => instance.path.endsWith("Impact.m2")));
  assert.ok(plan.instances.some((instance) => instance.path.endsWith("Area.m2")));
  assert.ok(plan.animations.some((animation) => animation.guid === 1n && animation.animation === 51));
  assert.ok(plan.animations.every((animation) => animation.guid !== 0n));
});

test("missile launch sound is emitted exactly once for a multi-target cast", () => {
  const visual = {
    id: 2,
    missile: { path: "Spells\\Bolt.m2", scale: 1, attachment: 22, speed: 24 },
    missileSound: 71,
  };
  const plan = planSpellVisual(visual, {
    caster: 1n, casterPoint: { x: 0, y: 0, z: 0 },
    targets: [
      { guid: 2n, point: { x: 24, y: 0, z: 0 } },
      { guid: 3n, point: { x: 48, y: 0, z: 0 } },
    ],
  }, 100);
  assert.deepEqual(plan.sounds, [{ sound: 71, point: { x: 0, y: 0, z: 0 }, at: 100 }]);
});

test("StateDoneKit is a finite removal plan, including a sound-only kit", () => {
  const plan = planSpellAuraDone({ id: 1, stateDone: { startAnimation: -1, animation: -1, effects: [], sound: 99 } }, {
    guid: 2n, point: { x: 1, y: 2, z: 3 },
  }, 500);
  assert.deepEqual(plan.instances, []);
  assert.deepEqual(plan.sounds, [{ sound: 99, point: { x: 1, y: 2, z: 3 }, at: 500 }]);
});

test("StateKit keeps world-bound effects positioned for the aura lifetime", () => {
  const plan = planSpellAuraState({ id: 1, state: kit(["Spells\\StateGround.m2"], -1) }, {
    guid: 2n, point: { x: 4, y: 5, z: 6 },
  }, 500, 2_500);
  assert.deepEqual(plan.instances, [{
    path: "Spells\\StateGround.m2", scale: 1, attachment: -1,
    position: { x: 4, y: 5, z: 6 }, startedAt: 500, endsAt: 2_500, modelPlayback: "hold",
  }]);
});

test("an instant spell lands on the frame it is cast", () => {
  const visual = { id: 1, impact: kit(["Spells\\Holy_Impact.m2"], 34) };
  const plan = planSpellVisual(visual, {
    caster: 1n, casterPoint: { x: 0, y: 0, z: 0 },
    targets: [{ guid: 2n, point: { x: 3, y: 0, z: 0 } }],
  }, 500);
  assert.equal(plan.instances.length, 1);
  assert.equal(plan.instances[0].startedAt, 500, "no flight, no wait");
});

test("a spell that hit eight things is drawn hitting eight things", () => {
  // The reason the hit list is parsed at all. Reading the caster's target field gives one target
  // for a spell that landed on a whole pull.
  const visual = {
    id: 1,
    impact: kit(["Spells\\Arcane_Impact.m2"], 34),
    missile: { path: "Spells\\Arcane_Missile.m2", scale: 1, attachment: 22, speed: 30 },
  };
  const targets = Array.from({ length: 8 }, (_, index) => ({
    guid: BigInt(index + 10),
    point: { x: 15 + index, y: index, z: 0 },
  }));
  const plan = planSpellVisual(visual, { caster: 1n, casterPoint: { x: 0, y: 0, z: 0 }, targets }, 0);
  assert.equal(plan.instances.filter((one) => one.flight).length, 8, "eight bolts");
  assert.equal(plan.instances.filter((one) => one.path.includes("Impact")).length, 8, "eight flashes");
  // Each flash waits for its own bolt: the far target's is later than the near one's.
  const flashes = plan.instances.filter((one) => one.path.includes("Impact"));
  assert.ok(flashes[7].startedAt > flashes[0].startedAt, "and the far one lands later");
});

test("a world effect stands on the ground rather than inside somebody", () => {
  // Attachment −1 is not an attachment. A rune circle belongs under the target's feet, and hung
  // on a bone it would be drawn inside their chest.
  const visual = { id: 1, cast: kit(["Spells\\Rune_Circle.m2"], -1) };
  const plan = planSpellVisual(visual, {
    caster: 1n, casterPoint: { x: 4, y: 5, z: 6 }, targets: [],
  }, 0);
  assert.equal(plan.instances.length, 1);
  assert.equal(plan.instances[0].anchor, undefined);
  assert.deepEqual(plan.instances[0].position, { x: 4, y: 5, z: 6 });
});

/* --- S3: kits by their own id, the authored attachment offset and AreaEffectSize -------------- */

/** A WDBC file with the header this repository's reader validates, and nothing else. */
function dbcPayload(fieldCount, recordSize, rows, strings = new Uint8Array(1)) {
  const payload = new Uint8Array(20 + rows.length * recordSize + strings.length);
  const view = new DataView(payload.buffer);
  payload.set([0x57, 0x44, 0x42, 0x43]); // WDBC
  view.setUint32(4, rows.length, true);
  view.setUint32(8, fieldCount, true);
  view.setUint32(12, recordSize, true);
  view.setUint32(16, strings.length, true);
  rows.forEach((row, index) => payload.set(row, 20 + index * recordSize));
  payload.set(strings, 20 + rows.length * recordSize);
  return payload;
}

function stringBytes(values) {
  const offsets = new Map();
  const parts = [0];
  let offset = 1;
  for (const value of values) {
    const bytes = new TextEncoder().encode(value);
    offsets.set(value, offset);
    parts.push(...bytes, 0);
    offset += bytes.length + 1;
  }
  return { bytes: Uint8Array.from(parts), offsets };
}

/** SpellVisualEffectName: 7 fields of 28 bytes, byte offsets out of src/generated/dbcLayouts.ts. */
function effectNameRow(id, file, offsets, { scale = 1, areaSize = 1 } = {}) {
  const row = new Uint8Array(28);
  const view = new DataView(row.buffer);
  view.setInt32(0, id, true);
  view.setUint32(8, offsets.get(file), true);
  view.setFloat32(12, areaSize, true);
  view.setFloat32(16, scale, true);
  view.setFloat32(20, 0.01, true);
  view.setFloat32(24, 100, true);
  return row;
}

/** SpellVisualKit: 38 fields of 152 bytes. */
function kitRow(id, { startAnim = -1, anim = -1, rightHand = 0, world = 0, sound = 0, shake = 0 } = {}) {
  const row = new Uint8Array(152);
  const view = new DataView(row.buffer);
  view.setInt32(0, id, true);
  view.setInt32(4, startAnim, true);
  view.setInt32(8, anim, true);
  view.setInt32(28, rightHand, true);
  view.setInt32(56, world, true);
  view.setInt32(60, sound, true);
  view.setInt32(64, shake, true);
  return row;
}

function syntheticKitTables() {
  const strings = stringBytes(["Spells\\Hand.mdx", "Spells\\Ring.mdx"]);
  const names = dbcPayload(7, 28, [
    effectNameRow(1, "Spells\\Hand.mdx", strings.offsets),
    // The one row whose AreaEffectSize is not the table's identity, and exceeds its own Scale.
    effectNameRow(2, "Spells\\Ring.mdx", strings.offsets, { scale: 1.5, areaSize: 4 }),
  ], strings.bytes);
  const kits = dbcPayload(38, 152, [
    kitRow(20, { anim: 53, rightHand: 1, sound: 77 }),
    kitRow(21, { world: 2 }),
    // Shake and nothing else: no model, no pose, no sound. Not a kit.
    kitRow(22, { shake: 9 }),
  ]);
  return { names, kits };
}

test("S3: kits resolve by their own id, and a shake-only row is not one", () => {
  const { names, kits } = syntheticKitTables();
  const byId = parseSpellVisualKits(kits, names);
  assert.deepEqual([...byId.keys()].sort((a, b) => a - b), [20, 21],
    "the row with only a ShakeID is dropped exactly as it is inside a spell");
  assert.equal(byId.get(20).animation, 53);
  assert.equal(byId.get(20).startAnimation, -1);
  assert.equal(byId.get(20).sound, 77);
  assert.deepEqual(byId.get(20).effects,
    [{ path: "Spells\\Hand.m2", attachment: 22, scale: 1 }],
    "the .mdx the table stores is renamed on the way out, as it is for a spell");
});

test("S3: a kit answered by id is the same record a spell's phase carries", () => {
  const { names, kits } = syntheticKitTables();
  const byId = parseSpellVisualKits(kits, names);
  // The same three tables reached the long way round: Spell -> SpellVisual -> SpellVisualKit.
  const visualRow = new Uint8Array(128);
  new DataView(visualRow.buffer).setInt32(0, 10, true);
  new DataView(visualRow.buffer).setInt32(8, 20, true); // CastKit
  const visuals = dbcPayload(32, 128, [visualRow]);
  const spellRow = new Uint8Array(936);
  new DataView(spellRow.buffer).setInt32(0, 133, true);
  new DataView(spellRow.buffer).setInt32(524, 10, true); // SpellVisualID[0]
  const spells = dbcPayload(234, 936, [spellRow]);
  const bySpell = parseSpellVisuals(spells, visuals, kits, names);
  assert.deepEqual(bySpell.get(133).cast, byId.get(20),
    "one resolution, two routes — the browser holds one vocabulary for both");
});

test("S3: AreaEffectSize is carried only when it says something Scale does not", () => {
  const byId = parseSpellVisualKits(syntheticKitTables().kits, syntheticKitTables().names);
  // Row 1 authors the table's identity 1, which is dropped: 552 of the 588 authored values inside
  // this dataset's area-column kits are that 1 and no rule can act on it. Measured over the whole
  // dataset, only 271 of 81,239 effect placements carry the field at all after this filter, and a
  // 200-spell answer grew by zero bytes.
  assert.equal(byId.get(20).effects[0].areaSize, undefined);
  // Row 2 authors 4 against a Scale of 1.5, which is the only shape worth carrying.
  assert.equal(byId.get(21).effects[0].areaSize, 4);
  assert.equal(byId.get(21).effects[0].scale, 1.5);
});

test("S3: AreaEffectSize only ever grows an area placement, and never past the cap", () => {
  // The rule, spelled out: applied when it exceeds both 1 and the authored Scale, capped at twice
  // that Scale. Measured over the 687 distinct area-phase placements this dataset's spells reach,
  // it moves four of them, across 13 spells.
  assert.equal(areaEffectScale(1, undefined), 1, "no authored value changes nothing");
  assert.equal(areaEffectScale(1, 1), 1, "the identity changes nothing");
  assert.equal(areaEffectScale(2, 0.5), 2, "it never shrinks an authored scale");
  assert.equal(areaEffectScale(2, 2), 2, "and a value equal to Scale is not squared");
  assert.equal(areaEffectScale(1.5, 4), 3, "growth stops at twice the authored scale");
  assert.equal(areaEffectScale(2, 3), 3, "and stops at the authored value when that comes first");
  assert.equal(areaEffectScale(1, 20), AREA_EFFECT_SIZE_MAX_GROWTH,
    "thunderclap_cast_base's 20 does not put a 130-yard ring on the ground");
});

test("S3: an area kit is drawn at the size the rule chose, and other phases are untouched", () => {
  const ring = { path: "Spells\\Ring.m2", attachment: -1, scale: 1.5, areaSize: 4 };
  const phase = { startAnimation: -1, animation: -1, effects: [ring], sound: 0 };
  const plan = planSpellVisual({ id: 1, instantArea: phase, cast: phase },
    { caster: 1n, casterPoint: { x: 0, y: 0, z: 0 }, targets: [] }, 0);
  assert.deepEqual(plan.instances.map((instance) => instance.scale).sort((a, b) => a - b), [1.5, 3],
    "the area column reads AreaEffectSize; the cast column keeps the authored Scale");
});

test("S3: a bone-anchored effect lands on the authored attachment point, not on the pivot", () => {
  // The defect the slice exists for. An item is parented to the bone and gets the pivot-to-point
  // offset for free; a spell effect is a top-level node whose transform is copied off the bone,
  // and the copy stopped at the pivot. Measured on the client's own rigs, 98 of 7,080 spell
  // placements are offset from their pivot — TaurenMale's head by 0.753 yards.
  const wvm = { attachments: [{ id: 20, bone: 1, position: [1, 2, 3] }] };
  const pivots = Float32Array.from([0, 0, 0, 0, 0, 0]);
  const offset = attachmentOffset(wvm, pivots, 20);
  assert.deepEqual(offset.toArray(), [1, 2, 3], "bone 1 sits at the origin, so the point is the offset");

  const bone = new THREE.Object3D();
  bone.updateMatrixWorld(true);
  const node = new THREE.Object3D();
  placeOnAttachmentBone(bone.matrixWorld, offset, 1, node);
  assert.deepEqual(node.position.toArray(), [1, 2, 3], "the node lands on the point");
  assert.equal(node.scale.x, 1);

  // With no offset the placement is the bone's own pivot, exactly what it was before the slice.
  const plain = new THREE.Object3D();
  placeOnAttachmentBone(bone.matrixWorld, new THREE.Vector3(), 2, plain);
  assert.deepEqual(plain.position.toArray(), [0, 0, 0]);
  assert.equal(plain.scale.x, 2, "and the instance scale still multiplies the bone's own");

  // The offset is in the bone's frame, so the bone's rotation, translation and scale carry it —
  // which is exactly what parenting would have done to a hung item.
  const turned = new THREE.Object3D();
  turned.position.set(10, 0, 0);
  turned.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
  turned.scale.setScalar(2);
  turned.updateMatrixWorld(true);
  const carried = new THREE.Object3D();
  placeOnAttachmentBone(turned.matrixWorld, offset, 1, carried);
  const expected = offset.clone().applyMatrix4(turned.matrixWorld);
  assert.ok(carried.position.distanceTo(expected) < 1e-6, carried.position.toArray().join(","));
  assert.equal(carried.scale.x, 2, "and the bone's own scale still reaches the effect");
});

test("S3: the kit route reaches kits this dataset's spells cannot", withDataset, async () => {
  const kits = await loadSpellVisualKits(dbcDirectory);
  // Measured on this dataset: 8,663 SpellVisualKit rows, 8,217 of which resolve to a model, a pose
  // or a sound. 7,023 of those are named by some Spell row; the other 1,194 are reachable only by
  // kit id, which is the number the packet carries.
  assert.ok(kits.size > 8_000, `${kits.size} resolvable kits`);
  // Kit ids this server's own core sends through SMSG_PLAY_SPELL_VISUAL.
  const food = kits.get(406);        // SPELL_VISUAL_KIT_FOOD, SharedDefines.h:375
  const drink = kits.get(438);       // SPELL_VISUAL_KIT_DRINK, SharedDefines.h:376
  const glaive = kits.get(7668);     // boss_illidan.cpp:212, SPELL_GLAIVE_VISUAL_KIT
  assert.ok(food?.effects.some((effect) => /food/i.test(effect.path)), "eating shows a model");
  assert.ok(drink?.effects.some((effect) => /tankard/i.test(effect.path)), "drinking holds a tankard");
  assert.equal(food.animation, 61, "and both play the same authored pose");
  assert.equal(drink.animation, 61);
  assert.ok(glaive?.effects.some((effect) => /shadow_nova_area/i.test(effect.path)),
    "and Illidan's glaive has a picture, which no spell row could have reached");
  assert.equal(glaive.sound, 11658);
});

test("what is over is over, and only that", () => {
  const instances = [
    { endsAt: 100 }, { endsAt: 500 }, { endsAt: 99 }, { endsAt: 1000 },
  ];
  assert.deepEqual(expiredInstances(instances, 500), [0, 1, 2]);
  assert.deepEqual(expiredInstances(instances, 0), []);
});
