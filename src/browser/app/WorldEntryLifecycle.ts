import type { Unsubscribe } from "../../world/EventBus.js";

/** Owns the per-character event listeners and invalidates work still awaiting world login. */
export class WorldEntryLifecycle {
  #generation = 0;
  readonly #subscriptions: Unsubscribe[] = [];

  begin(): number {
    this.retire();
    return this.#generation;
  }

  track(unsubscribe: Unsubscribe): void {
    this.#subscriptions.push(unsubscribe);
  }

  isCurrent(generation: number): boolean {
    return generation === this.#generation;
  }

  retire(): void {
    ++this.#generation;
    for (const unsubscribe of this.#subscriptions.splice(0)) unsubscribe();
  }
}
