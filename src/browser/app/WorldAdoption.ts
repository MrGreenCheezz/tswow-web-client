import { WorldStore } from "../../world/WorldStore.js";
import type { WorldState } from "../../world/WorldState.js";

/**
 * The tail of every route into a world: a live connection becomes *this client's* world.
 *
 * There are two routes now — `connectRealm` in the DOM flow, and the GlueXML character screen
 * handing over the connection it already opened — and they have to agree exactly. Not roughly:
 * the store is what every panel subscribes through, and a second route that forgot
 * `bindDeathScreenEffect` would be a client that never turns grey when the player dies, on one of
 * the two front doors only. So the five lines live here and both callers call them.
 *
 * The bindings arrive as a seam rather than as imports because everything that draws lives behind
 * `ui/Dom.ts`, which resolves 166 elements at import time and cannot exist in a node test. What is
 * worth testing here is the *wiring* — that the store is built from this connection's state, that
 * both binders see that store, and that the context ends up pointing at both — and with the seam
 * that is exactly what a test can drive with a fake connection.
 */

/** The half of `WorldClient` this file needs: the state a store is built over. */
export interface AdoptableWorld {
  readonly state: WorldState;
}

/** The half of `GameContext` this file writes. */
export interface WorldAdoptionTarget<W extends AdoptableWorld> {
  world: W | undefined;
  store: WorldStore | undefined;
}

export interface WorldAdoptionBindings {
  /** `bindPlayerHud` — the frames that follow the controlled character. */
  readonly bindHud: (store: WorldStore) => void;
  /** `bindDeathScreenEffect` — same update path as the HUD, for the same character. */
  readonly bindDeathScreen: (store: WorldStore) => void;
  /** What a panel that threw inside an update is reported through. */
  readonly onListenerError: (error: unknown) => void;
}

/**
 * Point the context at one world connection and give its store to the interface.
 *
 * The previous store is expected to have been detached by the caller before this runs — that is
 * part of leaving the previous world and not of joining this one — but a caller that forgot is
 * caught here rather than leaking a store that is still observing a state nobody reads.
 */
export function adoptWorldConnection<W extends AdoptableWorld>(
  target: WorldAdoptionTarget<W>,
  world: W,
  bindings: WorldAdoptionBindings,
): WorldStore {
  // `state.observer` is a single slot, so a store left attached to another state would keep
  // firing into panels that have moved on. Detaching here is idempotent when the caller already did.
  target.store?.detach();
  target.world = world;
  const store = new WorldStore(world.state);
  store.onListenerError = bindings.onListenerError;
  target.store = store;
  bindings.bindHud(store);
  bindings.bindDeathScreen(store);
  return store;
}
