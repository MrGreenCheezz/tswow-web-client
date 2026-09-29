import type { WorldClient } from "../../world/WorldClient.js";
import type { WorldObjectState } from "../../world/WorldState.js";

/** The last unit under the world canvas, tied to the object generation and world that supplied it. */
let hover: { world: WorldClient; object: WorldObjectState } | undefined;

/**
 * How long a cleared pick must stay cleared before it counts, in milliseconds.
 *
 * `Controls.updateHoverCursor` clears the hover on every pointer move that lands inside its 16 ms
 * pick throttle (Controls.ts:353-357) and re-picks from a trailing timer, so the raw value reads
 * «no unit» for up to one throttle interval while the pointer rests on the same creature. The
 * stock tooltip is driven by UPDATE_MOUSEOVER_UNIT, and a flicker there hides and re-shows it; the
 * settle window is three throttle intervals, long enough for the trailing pick and its timer
 * jitter, short enough that leaving a unit still hides the tooltip within a frame or four.
 */
export const HOVER_SETTLE_MS = 50;

/** The settled pick: what a consumer that must not flicker (the mouseover unit token) sees. */
let settled: { world: WorldClient; object: WorldObjectState } | undefined;
let settleTimer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<(world: WorldClient | undefined, guid: bigint | undefined) => void>();

function settledGuidNow(): bigint | undefined {
  return settled?.object.guid;
}

function publish(next: { world: WorldClient; object: WorldObjectState } | undefined): void {
  const before = settledGuidNow();
  const beforeWorld = settled?.world;
  settled = next;
  if (before === settledGuidNow() && beforeWorld === settled?.world) return;
  const guid = settledGuidNow();
  for (const listener of [...listeners]) {
    try {
      listener(settled?.world ?? beforeWorld, guid);
    } catch (error) {
      console.error("hover listener failed", error);
    }
  }
}

export function setHoveredTarget(world: WorldClient | undefined, object: WorldObjectState | undefined): void {
  hover = world && object && (object.typeId === 3 || object.typeId === 4)
    ? { world, object }
    : undefined;
  if (hover) {
    // A real pick settles at once: pointing at a new unit must not wait.
    if (settleTimer !== undefined) clearTimeout(settleTimer);
    settleTimer = undefined;
    publish(hover);
    return;
  }
  // A clear is only provisional until it has lasted HOVER_SETTLE_MS; a trailing pick of the same
  // unit inside that window cancels it and nothing is published.
  if (settled === undefined || settleTimer !== undefined) return;
  settleTimer = setTimeout(() => {
    settleTimer = undefined;
    if (hover === undefined) publish(undefined);
  }, HOVER_SETTLE_MS);
}

/**
 * The raw, unsettled pick. Mouseover macros read this one on purpose: a key pressed inside the
 * throttle interval must not cast at the unit the pointer has already left (Controls.ts:355-357).
 */
export function hoveredUnitGuid(world: WorldClient | undefined): bigint | undefined {
  if (!world || hover?.world !== world) return undefined;
  const { object } = hover;
  // A removed unit or a reused GUID must not inherit a stationary mouseover macro.
  return world.state.objects.get(object.guid) === object ? object.guid : undefined;
}

/**
 * The settled pick for `world`: the FrameXML `"mouseover"` unit token. Transient clears inside the
 * pick throttle do not show here; a despawned or GUID-reused object does not either.
 */
export function settledHoveredUnitGuid(world: WorldClient | undefined): bigint | undefined {
  if (!world || settled?.world !== world) return undefined;
  const { object } = settled;
  return world.state.objects.get(object.guid) === object ? object.guid : undefined;
}

/**
 * Subscribe to settled hover changes. The listener receives the world the pick belongs to and the
 * new unit GUID (undefined when the pointer left every unit). It fires synchronously from the
 * pointer handler or the settle timer, outside any rendered frame, so a consumer that drives Lua
 * should record the change and act on it from its own frame tick. Returns the unsubscribe call.
 *
 * `LiveWorldSeam` does not subscribe: it reads `settledHoveredUnitGuid` from its own frame tick
 * and raises UPDATE_MOUSEOVER_UNIT there. This edge is for hosts that need the change outside the
 * seam, such as a mount that shows or fades the stock world-unit tooltip.
 */
export function onSettledHoverChanged(
  listener: (world: WorldClient | undefined, guid: bigint | undefined) => void,
): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
