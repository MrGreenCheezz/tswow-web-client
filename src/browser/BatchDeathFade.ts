/**
 * 6.16а (05.10-A7a-F1): a batch's colour track under the *played* Death sequence, for one unit.
 *
 * `updateBatchAppearance` paints every build's batches from sequence 0 on one shared clock, because
 * the materials are shared by every unit of that appearance. That is right for a living creature
 * and wrong for a dying one: the file keys many creatures' dissolve under Death. Measured with
 * `docs/implementation/probes/A7a/probe-batch-seq.mjs` over the 1,353 readable creature and
 * character models of `F:/Circle`: **922 batches in 184 models** have a Death sub-track that ends at
 * opacity < 0.01 from a visible Stand — fire, water and air elementals, voidwalkers, wraiths,
 * ents, the Eye of Kilrogg — covering a median 52.5 % of the model's triangles (p90 100 %). The
 * character bodies are not among them: what HumanMale keys under Death is the texture weight of its
 * two death-knight eye-glow cards (geoset 1703), which blink 1 → 0 → 1 inside 433 ms.
 *
 * So the fade is per batch, not a unit opacity: only the batches the file keys under Death get a
 * private copy, the rest of the body keeps the shared material and its program. The copies are made
 * with `cloneMaterialFaded`, whose program is the fade twin `#trackUnitMeshes` already queued for
 * every unit material when the mesh was hung, so wearing them links nothing new.
 *
 * Only Death, and only while it is the clip a dead unit plays (its clamped terminal pose included):
 * the time is the action's own, held at the last key rather than wrapped, because a corpse lies for
 * minutes after a two-second clip. A Death alias would keep its keys under the alias target's slot,
 * which the clip does not carry; such a batch simply finds no sub-track and is left alone.
 */
import type * as THREE from "three";
import { cloneMaterialFaded, fadeMaterial, type AnimatedBatch } from "./ModelBuild.js";
import { sampleTrack } from "./Particles.js";
import type { WvmTrack } from "./Wvm.js";

/** Below this a batch is not drawn; the same threshold as `ModelBuild`'s `BATCH_INVISIBLE`. */
const DEATH_FADE_INVISIBLE = 0.01;

/** One batch of a build that the file keys under the Death sequence, by its material slot. */
export interface DeathFadeBatch {
  readonly index: number;
  readonly entry: AnimatedBatch;
}

interface DeathFadeBuild {
  readonly materials: readonly THREE.Material[];
  readonly animatedBatches: readonly AnimatedBatch[];
}

const NONE: readonly DeathFadeBatch[] = Object.freeze([]);
const BATCHES = new WeakMap<object, Map<number, readonly DeathFadeBatch[]>>();

function keyedUnder(track: WvmTrack | undefined, sequence: number): boolean {
  if (!track || track.globalSequence >= 0) return false;
  for (const sub of track.tracks) if (sub.sequence === sequence && sub.times.length > 0) return true;
  return false;
}

/**
 * The batches of a build whose opacity the file keys under `sequence`, cached per build.
 *
 * Read off `animatedBatches`, which already holds every batch with a track that moves — a sub-track
 * with keys under Death is one of those by construction (a fade has at least two keys).
 */
export function deathFadeBatches(built: DeathFadeBuild, sequence: number): readonly DeathFadeBatch[] {
  let bySequence = BATCHES.get(built);
  if (!bySequence) BATCHES.set(built, bySequence = new Map());
  const known = bySequence.get(sequence);
  if (known) return known;
  const picked: DeathFadeBatch[] = [];
  for (const entry of built.animatedBatches) {
    if (!keyedUnder(entry.colour?.alpha, sequence) && !keyedUnder(entry.weight, sequence)) continue;
    const index = built.materials.indexOf(entry.material);
    if (index >= 0) picked.push({ index, entry });
  }
  const result = picked.length > 0 ? picked : NONE;
  bySequence.set(sequence, result);
  return result;
}

/**
 * One track on one sequence's sub-track, held at its ends rather than wrapped.
 *
 * A track bound to a global sequence runs on the world clock whatever is played, exactly as in
 * `sampleTrack`. A track with no keys under `sequence` says nothing while it plays: `fallback`.
 * Interpolation 0 is a step; everything else is linear (the artifact carries no tangents).
 */
export function heldTrackValue(
  track: WvmTrack | undefined, sequence: number, clipMs: number, worldMs: number,
  globalSequences: Uint32Array, fallback: number,
): number {
  if (!track) return fallback;
  if (track.globalSequence >= 0) return sampleTrack(track, clipMs, worldMs, globalSequences, fallback);
  const subs = track.tracks;
  for (let at = 0; at < subs.length; at++) {
    const sub = subs[at]!;
    if (sub.sequence !== sequence) continue;
    const keys = sub.times.length;
    if (keys === 0) return fallback;
    const width = Math.max(1, track.components);
    const values = sub.values;
    if (keys === 1 || clipMs <= sub.times[0]!) return values[0] ?? fallback;
    if (clipMs >= sub.times[keys - 1]!) return values[(keys - 1) * width] ?? fallback;
    let index = 0;
    while (index + 1 < keys && sub.times[index + 1]! <= clipMs) index++;
    const start = values[index * width] ?? fallback;
    if (track.interpolation === 0) return start;
    const from = sub.times[index]!;
    const to = sub.times[index + 1]!;
    const end = values[(index + 1) * width] ?? fallback;
    return to > from ? start + (end - start) * ((clipMs - from) / (to - from)) : start;
  }
  return fallback;
}

/** A batch's opacity — colour alpha times texture weight — under `sequence` at `clipMs`. */
export function deathBatchOpacity(entry: AnimatedBatch, sequence: number, clipMs: number, worldMs: number): number {
  const sequences = entry.globalSequences;
  const alpha = heldTrackValue(entry.colour?.alpha, sequence, clipMs, worldMs, sequences, 1);
  const weight = heldTrackValue(entry.weight, sequence, clipMs, worldMs, sequences, 1);
  return Math.max(0, Math.min(1, alpha * weight));
}

/** Private copies one mesh wears for its fading batches, and the shared array it set aside. */
export interface DeathFadeState {
  readonly mesh: THREE.Mesh;
  readonly shared: THREE.Material[];
  readonly worn: THREE.Material[];
  readonly batches: readonly DeathFadeBatch[];
  /** Parallel to `batches`. */
  readonly clones: THREE.Material[];
  readonly sequence: number;
}

/**
 * Hangs private copies of the fading batches on `mesh`, when it is wearing exactly the build's
 * shared array; undefined when there is nothing to fade or the mesh is wearing something else.
 */
export function wearDeathFade(mesh: THREE.Mesh, built: DeathFadeBuild, sequence: number): DeathFadeState | undefined {
  const shared = mesh.material;
  if (!Array.isArray(shared) || shared !== built.materials) return undefined;
  const batches = deathFadeBatches(built, sequence);
  if (batches.length === 0) return undefined;
  const worn = shared.slice();
  const clones: THREE.Material[] = [];
  for (const batch of batches) {
    const clone = cloneMaterialFaded(shared[batch.index]!, 1);
    worn[batch.index] = clone;
    clones.push(clone);
  }
  mesh.material = worn;
  return { mesh, shared, worn, batches, clones, sequence };
}

/** Writes this frame's Death opacity into every copy. Allocation-free: it runs every frame for a corpse. */
export function updateDeathFade(state: DeathFadeState, clipMs: number, worldMs: number): void {
  for (let at = 0; at < state.batches.length; at++) {
    const batch = state.batches[at]!;
    const clone = state.clones[at]!;
    const source = state.shared[batch.index]!;
    const wanted = deathBatchOpacity(batch.entry, state.sequence, clipMs, worldMs);
    // `fadeMaterial` scales the shared value — Stand's — by a factor, and handles every blend mode's
    // algebra; the factor that lands on Death's value is the ratio. A batch the file hides under
    // Stand cannot be raised by a factor, and stays hidden.
    const base = source.opacity;
    const factor = base > 1e-6 ? Math.min(1, wanted / base) : 0;
    fadeMaterial(clone, factor, source);
    clone.visible = source.visible && base * factor > DEATH_FADE_INVISIBLE;
  }
}

/** Gives the shared array back if the mesh still wears this fade, and disposes the copies. */
export function releaseDeathFade(state: DeathFadeState): void {
  if (state.mesh.material === state.worn) state.mesh.material = state.shared;
  for (const clone of state.clones) clone.dispose();
}

/** What `syncDeathFade` needs of a rendered unit. */
export interface DeathFadeHost {
  deathFade?: DeathFadeState | undefined;
  built: DeathFadeBuild | undefined;
  skinned?: { mesh: THREE.Mesh } | undefined;
  /** A spawn/stealth fade's borrows; while present, this one neither wears nor releases. */
  opacityBorrows?: readonly unknown[] | undefined;
}

/** What `syncDeathFade` needs of the playing action: its time and the clip's sequence slot. */
export interface DeathFadeAction {
  readonly time: number;
  getClip(): { userData: Record<string, unknown> };
}

/**
 * The per-frame hook: `dying` is the action of the Death clip a dead unit is playing, or undefined
 * when it is not (alive, feigning nothing, another clip). Returns whether the materials the unit
 * wears changed, so the caller can re-decide its shadow policy.
 */
export function syncDeathFade(host: DeathFadeHost, dying: DeathFadeAction | undefined, worldMs: number): boolean {
  let changed = false;
  const state = host.deathFade;
  const mesh = host.skinned?.mesh;
  if (state && state.mesh !== mesh) {
    // The body was replaced underneath (a new look, a rebuild): the old mesh is not ours to write.
    for (const clone of state.clones) clone.dispose();
    host.deathFade = undefined;
    changed = true;
  }
  const current = host.deathFade;
  if (!dying) {
    if (current && host.opacityBorrows === undefined) {
      releaseDeathFade(current);
      host.deathFade = undefined;
      changed = true;
    }
    return changed;
  }
  const sequence = dying.getClip().userData["variationIndex"];
  if (typeof sequence !== "number") return changed;
  if (!current) {
    if (host.opacityBorrows !== undefined || !mesh || !host.built) return changed;
    const worn = wearDeathFade(mesh, host.built, sequence);
    if (!worn) return changed;
    host.deathFade = worn;
    changed = true;
  }
  const active = host.deathFade!;
  if (active.sequence === sequence) updateDeathFade(active, dying.time * 1000, worldMs);
  return changed;
}

/** Drops a unit's fade before its node is emptied: restores the shared array and disposes copies. */
export function dropDeathFade(host: DeathFadeHost): void {
  const state = host.deathFade;
  if (!state) return;
  releaseDeathFade(state);
  host.deathFade = undefined;
}
