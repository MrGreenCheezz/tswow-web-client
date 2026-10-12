// 12.10 7.33: «порталы (вход в подземелье) иногда не видны» — a model that is nothing but its emitters.
//
// The old-world instance portals are their particles. World\Generic\ActiveDoodads\InstancePortal\
// InstancePortal{,_Green,_Red,_White,_PurpleDifficulty}.m2 carry a 30-vertex slab whose one batch sits on
// texture weight track 0, a single key of 0 (drawn by nobody), and two sphere emitters (500 and 250
// particles a second) that are the swirl; Temporal_Displacement.m2 has no vertices at all. Of the 62
// portal placements on the four continents 56 are WMO doodads (the Deadmines, Scarlet Monastery,
// Gnomeregan, Blackrock, Dire Maul…) and 6 ADT doodads. (The Northrend ones are game objects of type 31
// with meshes of their own, SPELLS\InstanceNewPortal_*.)
//
// The emitter pass keeps the 32 nearest emitter sets within 90 yards (`EFFECT_BUDGET`, `EFFECT_RANGE` in
// WorldRenderer3D.ts). For a torch that only thins the scene — its mesh stays when its flame is dropped —
// but a portal dropped from it is gone outright: past 90 yards always, and nearer wherever the emitters
// around it outnumber the budget (over the 62, viewers 89 yards off in 8 directions: 8 dropped — Scarlet
// Monastery's wings, the Sunken Temple, Zul'Aman, Ragefire in Orgrimmar, the Stockades in Stormwind, the
// Scarlet crypt; one already at 60 yards. `.runtime/re-2026-10-12/p733/portalbudget.mjs`, doodads only:
// units and game objects with emitters compete too). In the original client the swirl stands wherever
// the portal is drawn. So a model whose geometry draws nothing is ranked apart, out to the leash its
// placement is admitted at, under an allowance of its own that the torches cannot spend.
//
// Per-frame cost: a WeakMap lookup per emitter-bearing placement; the answer is worked out once per model.

import type { WvmModel, WvmTrack } from "./Wvm.js";

const answers = new WeakMap<WvmModel, boolean>();

/** Every key of every sub-track is zero (and there is at least one): the value never leaves 0. */
function alwaysZero(track: WvmTrack | undefined): boolean {
  if (!track) return false;
  let keys = 0;
  for (const sub of track.tracks) {
    for (let index = 0; index < sub.values.length; index++) {
      if (sub.values[index] !== 0) return false;
      keys++;
    }
  }
  return keys > 0;
}

/**
 * Whether a model's only visible content is its particle and ribbon emitters: it has some, and its mesh
 * draws nothing — no vertices or no batches, or every batch held at zero by its texture weight or by its
 * colour's alpha (a track whose every key is 0).
 */
export function particleOnlyModel(wvm: WvmModel): boolean {
  const cached = answers.get(wvm);
  if (cached !== undefined) return cached;
  let answer = wvm.particleEmitters.length + wvm.ribbonEmitters.length > 0;
  if (answer && wvm.positions.length > 0 && wvm.indices.length > 0 && wvm.batches.length > 0) {
    answer = wvm.batches.every((batch) =>
      (batch.textureWeight >= 0 && alwaysZero(wvm.textureWeights[batch.textureWeight]))
      || (batch.colorIndex !== 0xffff && alwaysZero(wvm.colours[batch.colorIndex]?.alpha)));
  }
  answers.set(wvm, answer);
  return answer;
}
