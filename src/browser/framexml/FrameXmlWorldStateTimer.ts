/**
 * WORLD_STATE_UI_TIMER_UPDATE as Wow.exe 3.3.5a fires it (plan item 3.14, L3), for
 * FrameXmlWorldStates.ts.
 *
 * The original client (read-only Ghidra; event 0x28b from the name table at 0x00c24eb0):
 * * 0x5487d0 rebuilds the WorldStateUI list (GetNumWorldStateUI/GetWorldStateUIInfo read it) from
 *   the rows whose MapID is -1 or the current map, AreaID 0 or the zone or the area, PhaseShift 0 or
 *   sharing a bit with the phase mask, and Type 0, 1 or 3 — whatever their state. It keeps
 *   (row id, Type) pairs.
 * * 0x5488f0, each frame from the world frame's update (0x4fa5f0): once a second, while that list
 *   holds a Type-3 pair, fire WORLD_STATE_UI_TIMER_UPDATE. (Every 20 s it also asks the server's
 *   clock, CMSG_WORLD_STATE_UI_TIMER_UPDATE through 0x548760 — not done here, see the plan note.)
 *   L3-review: an intentional omission. The answer carries only GameTime::GetGameTime()
 *   (MiscHandler.cpp:1454-1462), and Wow.exe keeps it as server time minus the local wall clock
 *   (0x4f7 → 0x50f420 → 0x5486e0) because its countdowns (0x576e50) are measured against time(NULL)
 *   plus that offset (0x548700), a clock the user or NTP can move. This client measures against
 *   `WorldClient.currentServerTime`, one answer run forward on performance.now() (asked at attach and
 *   on a Wintergrasp invite), so a resend would only add traffic.
 * * UPDATE_WORLD_STATES (0x1d0) comes with the world-state packets (0x526530 cases 0x2c2/0x2c3) and
 *   a phase change (0x513960) only.
 * Type 3 is the countdown row: the dataset's two are Wintergrasp's 208 «Время: %3781k» and 212
 * «Следующий бой: %4354k» (map 571, area 4197), and they are the only rows with a %Nk token. Their
 * text moves every second; the timer event is what re-reads it, so the UPDATE_WORLD_STATES
 * comparison leaves a Type-3 row's texts out.
 */
import type { WorldStateUiRow } from "../../world/WorldStateUiData.js";

/** WorldStateUI.Type of the countdown rows. */
export const FRAMEXML_WORLD_STATE_TIMER_ROW_TYPE = 3;
export const FRAMEXML_WORLD_STATE_TIMER_EVENT = "WORLD_STATE_UI_TIMER_UPDATE";
/** 0x5488f0's spacing, in the pump's GetTime seconds. */
const TIMER_SPACING_SECONDS = 1;

/** Where the player is, as FrameXmlWorldStates' snapshot says it. */
export interface FrameXmlWorldStateTimerPlace {
  readonly mapId: number;
  readonly zoneId: number;
  readonly areaId: number;
  readonly phaseMask: number;
}

interface FrameXmlWorldStateTimerPump {
  fire(event: string, ...args: readonly unknown[]): number;
  now?: () => number;
}

/** A GetWorldStateUIInfo row as the UPDATE_WORLD_STATES comparison sees it: a Type-3 row without its texts. */
export function frameXmlWorldStateSignatureRow(row: readonly unknown[]): readonly unknown[] {
  return row[0] === FRAMEXML_WORLD_STATE_TIMER_ROW_TYPE
    ? [row[0], row[1], row[3], row[4], row[7], row[8], row[9], row[10]] : row;
}

/** 0x5487d0's list holds a Type-3 row here. */
export function frameXmlWorldStateTimerRowListed(
  catalog: readonly Pick<WorldStateUiRow, "mapId" | "areaId" | "phaseMask" | "type">[] | undefined,
  place: FrameXmlWorldStateTimerPlace | undefined,
): boolean {
  if (!place) return false;
  for (const row of catalog ?? []) {
    if (row.type === FRAMEXML_WORLD_STATE_TIMER_ROW_TYPE
      && (row.mapId === -1 || row.mapId === place.mapId)
      && (row.areaId === 0 || row.areaId === place.zoneId || row.areaId === place.areaId)
      && (row.phaseMask === 0 || (row.phaseMask & place.phaseMask) !== 0)) return true;
  }
  return false;
}

/** 0x5488f0's once-a-second edge; a pump without a clock (a test double) gets none. */
export class FrameXmlWorldStateTimer {
  #at = Number.NEGATIVE_INFINITY;

  reset(): void {
    this.#at = Number.NEGATIVE_INFINITY;
  }

  /** The getters are FrameXmlWorldStates' own (no closure per poll); they are read once a second. */
  tick(
    pump: FrameXmlWorldStateTimerPump | undefined,
    catalog: () => readonly Pick<WorldStateUiRow, "mapId" | "areaId" | "phaseMask" | "type">[] | undefined,
    place: () => FrameXmlWorldStateTimerPlace | undefined,
  ): void {
    if (!pump || typeof pump.now !== "function") return;
    const now = pump.now();
    if (!(now - this.#at >= TIMER_SPACING_SECONDS)) return;
    this.#at = now;
    if (frameXmlWorldStateTimerRowListed(catalog(), place())) pump.fire(FRAMEXML_WORLD_STATE_TIMER_EVENT);
  }
}
