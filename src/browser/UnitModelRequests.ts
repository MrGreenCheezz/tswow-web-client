import { UPDATE_FIELDS } from "../generated/updateFields.js";
import type { EventBus, Unsubscribe, WorldEvents } from "../world/EventBus.js";
import { unit } from "../world/Fields.js";
import type { WorldObjectState, WorldState } from "../world/WorldState.js";
import { corpseDisplayRequest } from "./CorpseModel.js";

/** The one call of `CreatureModelClient` used here; it ignores a zero and dedupes everything else. */
export interface UnitModelRequester {
  request(displayId: number): void;
}

const DISPLAY_ID = UPDATE_FIELDS.UNIT_FIELD_DISPLAYID.offset;

/**
 * Asks for the models one object needs drawn: a unit's own display id and its mount's, a corpse's
 * body. Anything else asks for nothing. `request` dedupes, so asking twice is harmless.
 */
export function requestUnitModels(object: WorldObjectState, models: UnitModelRequester): void {
  if (object.typeId === 7) { models.request(corpseDisplayRequest(object)); return; } // 05.10-A7a-G2 6.05: a corpse's body
  if (object.typeId !== 3 && object.typeId !== 4) return;
  models.request(object.fields.get(DISPLAY_ID) ?? 0);
  // And its mount, which is a display id of the same table and would otherwise never be asked for:
  // `request` ignores a zero, which is what all but the mounted carry.
  models.request(unit.mountDisplayId(object) ?? 0);
}

/**
 * Every object in the state, once. Before P1-20c this ran on every world refresh — every frame with a
 * packet, three hundred units and seven hundred other objects in a city — to find the handful of ids
 * that were new. The events below find those as they happen; this pass is the safety net, run on the
 * prefetch throttle: an object that predates the binding, a field with no event (a corpse's), and
 * the retry ladder of `CreatureModelClient`, which only asks again when it is asked again.
 */
export function sweepUnitModels(state: WorldState, models: UnitModelRequester): void {
  for (const object of state.objects.values()) requestUnitModels(object, models);
}

/**
 * P1-20c: a new unit, a new display id, a new mount — asked for in the `store.flush()` that delivers
 * it, which runs before the frame's `drainWorldState`, so the first request of a new unit is not
 * later than before. One sweep at binding covers what the state already held.
 *
 * `current` says whether `models` is still the session's client; a replaced one is not fed.
 */
export function bindUnitModelRequests(
  store: { readonly events: Pick<EventBus<WorldEvents>, "on"> },
  state: WorldState,
  models: UnitModelRequester,
  current: () => boolean = () => true,
): Unsubscribe[] {
  const one = ({ guid }: { guid: bigint }): void => {
    if (!current()) return;
    // The type is read from the object, not the event: a guid created implicitly first is announced
    // again with its type, and either way the object holds the type by the time the flush runs.
    const object = state.objects.get(guid);
    if (object) requestUnitModels(object, models);
  };
  const stops = [
    store.events.on("OBJECT_CREATED", one),
    store.events.on("UNIT_DISPLAY_ID", one),
    store.events.on("UNIT_MOUNT_DISPLAY_ID", one),
  ];
  if (current()) sweepUnitModels(state, models);
  return stops;
}
