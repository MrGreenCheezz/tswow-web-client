// 11.11 (6.13): an aura's StateKit beams run from the aura's caster to its holder — Wow.exe plays a StateKit as kit
// type 2 with the aura's caster (0x00724820 → 0x00745230 play flags 0x21000), and the beam procedure 0x007265c0 with
// flag 0x1000 and another unit's guid takes that unit as the first end and the holder as the only target
// (browser/SpellVisuals.ts `planSpellAuraState`, ChainBeamPlan.ts).
import assert from "node:assert/strict";
import test from "node:test";
import { planSpellAuraState } from "../dist/code/browser/SpellVisuals.js";

const row = (extra = {}) => ({
  id: 1, texture: "T.blp", width: 0.5, avgSegLen: 2, noiseScale: 0, texCoordScale: 0, textureLength: 2, segDuration: 1000,
  segDelay: 0, flags: 0, jointCount: 0, color: [128, 255, 255, 255], blendMode: 3, renderLayer: 0, combo: [], ...extra,
});

const state = {
  startAnimation: -1, animation: -1, effects: [], sound: 0,
  chains: [{ slot: 0, proc: 0, param1: 0, persistent: true, effect: row({ id: 7 }) }],
};
// MissileAttachment index 4 (right spell hand 22), MissileDestinationAttachment index 1 (chest 34), a cast offset.
const visual = { id: 5, state, beamEnds: { attachment: 4, dest: 1, castOffset: [0, 0, 1] } };
const holder = { guid: 2n, point: { x: 10, y: 0, z: 0 } };

test("the StateKit's beam starts at the aura's caster and ends at the holder, for as long as the aura", () => {
  const plan = planSpellAuraState(visual, holder, 1000, 31_000, { guid: 1n, point: { x: 0, y: 0, z: 0 } });
  assert.equal(plan.beams?.length, 1);
  const [beam] = plan.beams;
  assert.equal(beam.from.guid, 1n, "the caster is the first end");
  assert.equal(beam.from.attachment, 22, "at its MissileAttachment (through 0x00adaa20)");
  assert.deepEqual(beam.from.offset, [0, -0, 1], "moved by MissileCastOffset");
  assert.equal(beam.to.guid, 2n, "the holder is the target");
  assert.equal(beam.to.attachment, 34, "at its MissileDestinationAttachment");
  assert.deepEqual([beam.startedAt, beam.endsAt, beam.persistent], [1000, 31_000, true]);
});

test("the coordinator hands an aura's caster to the StateKit and the beam goes with the aura's handle", async () => {
  const { SpellVisualCoordinator } = await import("../dist/code/browser/SpellVisualLifecycle.js");
  const listeners = new Map();
  const events = {
    on(name, listener) { (listeners.get(name) ?? listeners.set(name, new Set()).get(name)).add(listener); return () => {}; },
    emit(name, value) { for (const listener of listeners.get(name) ?? []) listener(value); },
  };
  const world = {
    events, auras: new Map(), targetGuid: 0n,
    state: { selfGuid: 9n, objects: new Map([[1n, { position: { x: 0, y: 0, z: 0, orientation: 0 } }],
      [2n, { position: { x: 10, y: 0, z: 0, orientation: 0 } }]]) },
  };
  const plans = [];
  const cancelled = [];
  const renderer = {
    playSpellVisual(plan) { plans.push(plan); },
    setStateVisuals() {},
    cancelSpellVisual(id) { cancelled.push(id); },
    retimeSpellVisual() {},
  };
  const source = { get: (id) => (id === 5 ? visual : undefined) };
  const coordinator = new SpellVisualCoordinator({ metadata: source, renderer, now: () => 1000 });
  coordinator.bindWorld(world);
  const aura = { slot: 3, spellId: 5, flags: 0, casterLevel: 1, applications: 1, casterGuid: 1n, expiresAt: 31_000 };
  events.emit("AURA_CHANGED", { guid: 2n, previous: new Map(), current: new Map([[3, aura]]), added: [aura], removed: [], updated: [] });
  const beams = plans.flatMap((plan) => plan.beams ?? []);
  assert.equal(beams.length, 1);
  assert.deepEqual([beams[0].from.guid, beams[0].to.guid], [1n, 2n]);
  events.emit("AURA_CHANGED", { guid: 2n, previous: new Map([[3, aura]]), current: new Map(), added: [], removed: [aura], updated: [] });
  assert.equal(cancelled.length, 1, "the aura's end takes its beam");
});

test("a self-cast aura or an absent caster draws no StateKit beam", () => {
  assert.equal(planSpellAuraState(visual, holder, 1000, 31_000).beams, undefined, "no caster in view");
  assert.equal(planSpellAuraState(visual, holder, 1000, 31_000, { guid: 2n, point: holder.point }).beams, undefined,
    "the holder's own aura (flag 0x1000 with its own guid takes the normal path)");
  assert.equal(planSpellAuraState({ ...visual, state: { ...state, chains: undefined } }, holder, 1000, 31_000,
    { guid: 1n, point: { x: 0, y: 0, z: 0 } }).beams, undefined, "a kit without a beam");
});
