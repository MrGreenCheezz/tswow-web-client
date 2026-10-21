/**
 * 22.10 ARC-2 S4a: the renderer's map from the id the main thread gave a spell visual (`playSpellVisual(plan, id)`)
 * to the handle the renderer still keys its own nodes, beams, pending poses and action owners by. The handle and
 * its internal sequence number are made exactly as before, so effect seeds and phase keys do not move.
 *
 * An id leaves with `cancelSpellVisual` and `clearSpellVisuals`. A visual that simply runs out is never cancelled,
 * so the map is also pruned of handles nothing holds any more — a cancel or retime of such an id did nothing
 * before and does nothing after. The prune runs when the map has doubled since the last one: amortised O(1).
 */

const PRUNE_FLOOR = 64;

export class SpellVisualIds<Handle> {
  readonly #byId = new Map<number, Handle>();
  #pruneAt = PRUNE_FLOOR;

  get size(): number {
    return this.#byId.size;
  }

  get(id: number): Handle | undefined {
    return this.#byId.get(id);
  }

  /** `live` is asked only when a prune is due: every handle some node, beam, pose or action still holds. */
  set(id: number, handle: Handle, live: () => ReadonlySet<Handle>): void {
    this.#byId.set(id, handle);
    if (this.#byId.size < this.#pruneAt) return;
    const held = live();
    for (const [key, value] of this.#byId) if (!held.has(value)) this.#byId.delete(key);
    this.#pruneAt = Math.max(PRUNE_FLOOR, this.#byId.size * 2);
  }

  delete(id: number): Handle | undefined {
    const handle = this.#byId.get(id);
    this.#byId.delete(id);
    return handle;
  }

  clear(): void {
    this.#byId.clear();
    this.#pruneAt = PRUNE_FLOOR;
  }
}
