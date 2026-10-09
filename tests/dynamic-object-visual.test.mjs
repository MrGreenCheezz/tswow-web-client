import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import {
  DYNAMIC_OBJECT_CAST_WINDOW_MS, DynamicObjectAreas, dynamicObjectArea,
} from "../dist/code/browser/DynamicObjectVisual.js";
import { planPersistentArea } from "../dist/code/browser/SpellVisuals.js";

// 6.05б (line A7a, slice G2, 05.10): a DynamicObject (type 6) shows its spell's PersistentAreaKit for
// as long as it exists — unless the cast that made it already shows the area. Wow.exe 0x00705230
// (CGDynamicObject_C create) asks 0x00804cc0 whether (caster, spell, cast time) is a cast the client
// saw, and 0x00704f60 draws the object's own area only when it is not.

const F = (name) => UPDATE_FIELDS[name].offset;
const KIT = { animation: -1, startAnimation: -1, sound: 0,
  effects: [{ path: "Spells\\Rain_Of_Fire_Area.m2", scale: 1, attachment: 0 }] };
const VISUAL = { id: 1, persistentArea: KIT, durationMs: 8000 };

function dynamic(guid, { spellId = 5740, caster = 0x10n, type = 1, radius = 8, castTime = 1234, position = { x: 10, y: 20, z: 30 } } = {}) {
  const fields = new Map([
    [F("DYNAMICOBJECT_CASTER"), Number(caster & 0xffffffffn)], [F("DYNAMICOBJECT_CASTER") + 1, Number(caster >> 32n)],
    [F("DYNAMICOBJECT_BYTES"), type], [F("DYNAMICOBJECT_SPELLID"), spellId],
    [F("DYNAMICOBJECT_RADIUS"), new Uint32Array(new Float32Array([radius]).buffer)[0]],
    [F("DYNAMICOBJECT_CASTTIME"), castTime],
  ]);
  return { guid, typeId: 6, position, fields, movementFlags: 0 };
}

function harness(visuals = { 5740: VISUAL }) {
  const played = [];
  const cancelled = [];
  const asked = [];
  const areas = new DynamicObjectAreas({
    visual: (spellId) => { asked.push(spellId); return visuals[spellId]; },
    renderer: () => ({
      playSpellVisual: (plan) => { const handle = { plan }; played.push(handle); return handle; },
      cancelSpellVisual: (handle) => cancelled.push(handle),
    }),
  });
  return { areas, played, cancelled, asked };
}

test("the object's fields: caster, spell, radius (a float), type, cast time", () => {
  const area = dynamicObjectArea(dynamic(1n, { caster: 0xF130_0000_0000_0042n, radius: 7.5, type: 1 }));
  assert.deepEqual(area, { caster: 0xF130_0000_0000_0042n, spellId: 5740, radius: 7.5, type: 1, castTime: 1234 });
  assert.equal(dynamicObjectArea({ ...dynamic(1n), typeId: 5 }), undefined);
});

test("an area nobody saw cast: its kit at the object, held until the object goes", () => {
  const h = harness();
  const objects = new Map([[1n, dynamic(1n)]]);
  h.areas.sync(objects, 100);
  assert.equal(h.played.length, 1);
  const instance = h.played[0].plan.instances[0];
  assert.equal(instance.path, "Spells\\Rain_Of_Fire_Area.m2");
  assert.deepEqual(instance.position, { x: 10, y: 20, z: 30 });
  assert.equal(instance.endsAt, Number.POSITIVE_INFINITY, "the object, not SpellDuration, ends it");
  assert.equal(instance.modelPlayback, "hold");
  h.areas.sync(objects, 200);
  assert.equal(h.played.length, 1, "once per object");
  objects.delete(1n);
  h.areas.sync(objects, 300);
  assert.deepEqual(h.cancelled, [h.played[0]], "gone with SMSG_DESTROY_OBJECT");
});

test("an area whose cast this client saw is the cast's own: no second copy", () => {
  const h = harness();
  h.areas.noteCast(0x10n, 5740, 1_000);
  h.areas.sync(new Map([[1n, dynamic(1n)]]), 1_000 + DYNAMIC_OBJECT_CAST_WINDOW_MS - 1);
  assert.equal(h.played.length, 0);
  const late = harness();
  late.areas.noteCast(0x10n, 5740, 1_000);
  late.areas.sync(new Map([[1n, dynamic(1n)]]), 1_000 + DYNAMIC_OBJECT_CAST_WINDOW_MS + 1);
  assert.equal(late.played.length, 1, "an old cast does not own a new object");
  const other = harness();
  other.areas.noteCast(0x11n, 5740, 1_000);
  other.areas.sync(new Map([[1n, dynamic(1n)]]), 1_001);
  assert.equal(other.played.length, 1, "someone else's cast");
});

test("metadata on its way: asked again next frame, drawn once it is here; none — nothing", () => {
  const visuals = {};
  const h = harness(visuals);
  const objects = new Map([[1n, dynamic(1n)]]);
  h.areas.sync(objects, 1);
  assert.equal(h.played.length, 0);
  visuals[5740] = VISUAL;
  h.areas.sync(objects, 2);
  assert.equal(h.played.length, 1);
  const bare = harness({ 5740: { id: 1 } });
  bare.areas.sync(objects, 1);
  bare.areas.sync(objects, 2);
  assert.equal(bare.played.length, 0);
  assert.deepEqual(bare.asked, [5740], "a visual without a persistent kit is not asked about again");
});

test("clear() lets everything go (a teleport or a logout)", () => {
  const h = harness();
  h.areas.sync(new Map([[1n, dynamic(1n)], [2n, dynamic(2n, { spellId: 5740 })]]), 1);
  h.areas.clear();
  assert.equal(h.cancelled.length, 2);
  h.areas.sync(new Map([[1n, dynamic(1n)]]), 2);
  assert.equal(h.played.length, 3, "and draws again what is still there");
});

test("planPersistentArea: the PersistentAreaKit alone, held", () => {
  const plan = planPersistentArea(VISUAL, { x: 1, y: 2, z: 3 }, 50);
  assert.equal(plan.instances.length, 1);
  assert.equal(plan.instances[0].startedAt, 50);
  assert.equal(plan.animations.length, 0);
  assert.equal(planPersistentArea({ id: 2 }, { x: 0, y: 0, z: 0 }, 0).instances.length, 0);
});

test("the coordinator hooks: noteCast on SPELL_GO, sync on tick, clear with the effects", () => {
  const source = readFileSync(new URL("../src/browser/SpellVisualLifecycle.ts", import.meta.url), "utf8");
  assert.match(source, /this\.#areas\.noteCast\(cast\.casterUnit !== 0n \? cast\.casterUnit : cast\.casterGuid, cast\.spellId, now\)/);
  const tick = source.slice(source.indexOf("  tick(now = this.#now()): void {"), source.indexOf("if (this.#starts.size === 0) return;"));
  assert.match(tick, /this\.#areas\.sync\(this\.#world\.state\.objects, now\)/);
  const clear = source.slice(source.indexOf("  #clearEffects(): void {"), source.indexOf("  #clearEffects(): void {") + 400);
  assert.match(clear, /this\.#areas\.clear\(\)/);
});

// 05.10: ревью G2 — per-frame cost. An object whose spell row is still on its way (or answered "no
// visual", which `get` keeps answering as undefined) is looked at again every frame; that look must be
// the spell word and a lookup, not a parse of every word (a BigInt caster, a float) and a key string.
test("an object still without its visual row costs one word per frame, not a parse", () => {
  const h = harness({});
  const object = dynamic(1n);
  const reads = new Map();
  const fields = object.fields;
  object.fields = { get(key) { reads.set(key, (reads.get(key) ?? 0) + 1); return fields.get(key); } };
  const objects = new Map([[1n, object]]);
  for (let frame = 0; frame < 10; frame++) h.areas.sync(objects, 100 + frame * 16);
  assert.equal(h.asked.length, 10, "the row is asked for every frame until it comes");
  assert.equal(reads.get(F("DYNAMICOBJECT_CASTER")) ?? 0, 0, "no caster parse while no cast is in the window");
  assert.equal(reads.get(F("DYNAMICOBJECT_RADIUS")) ?? 0, 0);
  // A cast seen in the window still claims the object.
  h.areas.noteCast(0x10n, 5740, 300);
  h.areas.sync(objects, 310);
  assert.equal(h.asked.length, 10, "the seen cast settles it before the row is asked for");
  assert.equal(h.played.length, 0);
});
