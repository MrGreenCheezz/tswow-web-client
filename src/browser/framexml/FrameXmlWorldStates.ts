import { formatWorldStateText, isWorldStateUiCatalog, type WorldStateUiRow } from "../../world/WorldStateUiData.js";
import type { FrameXmlSeamPump } from "./FrameXmlWorldSeam.js";
import { FrameXmlWorldStateTimer, frameXmlWorldStateSignatureRow } from "./FrameXmlWorldStateTimer.js"; // L3 3.14

export interface FrameXmlWorldStateSnapshot {
  readonly mapId: number;
  readonly zoneId: number;
  readonly areaId: number;
  readonly phaseMask: number;
  readonly states: ReadonlyMap<number, number>;
  readonly serverTime?: number;
}

export type FrameXmlWorldStateInfo = readonly [
  type: number, state: number, text: string, icon: string, dynamicIcon: string,
  tooltip: string, dynamicTooltip: string, extendedUi: string, value1: number, value2: number, value3: number,
];

export class FrameXmlWorldStates {
  readonly #catalog: () => readonly WorldStateUiRow[] | undefined;
  readonly #snapshot: () => FrameXmlWorldStateSnapshot | undefined;
  #pump: FrameXmlSeamPump | undefined;
  #signature = "";
  /** L3 3.14: WORLD_STATE_UI_TIMER_UPDATE once a second (FrameXmlWorldStateTimer.ts). */
  readonly #timer = new FrameXmlWorldStateTimer();
  constructor(catalog: () => readonly WorldStateUiRow[] | undefined, snapshot: () => FrameXmlWorldStateSnapshot | undefined) {
    this.#catalog = catalog;
    this.#snapshot = snapshot;
  }
  attach(pump: FrameXmlSeamPump): void { this.#pump = pump; this.#signature = ""; this.#timer.reset(); this.tick(); } // L3 3.14: timer reset
  detach(): void { this.#pump = undefined; this.#signature = ""; }
  tick(): void {
    if (!this.#pump) return;
    // L3 3.14: a Type-3 row's countdown texts are the timer event's, not a state change.
    const signature = JSON.stringify(this.rows().map(frameXmlWorldStateSignatureRow));
    if (signature !== this.#signature) { // L3 3.14: no early return, the timer runs after
      this.#signature = signature;
      this.#pump.fire("UPDATE_WORLD_STATES");
    }
    this.#timer.tick(this.#pump, this.#catalog, this.#snapshot); // L3 3.14
  }
  rows(): readonly FrameXmlWorldStateInfo[] {
    const snapshot = this.#snapshot();
    if (!snapshot) return [];
    const rows: FrameXmlWorldStateInfo[] = [];
    for (const row of this.#catalog() ?? []) {
      if (row.mapId !== -1 && row.mapId !== snapshot.mapId
        || row.areaId !== 0 && row.areaId !== snapshot.zoneId && row.areaId !== snapshot.areaId
        || row.phaseMask !== 0 && (row.phaseMask & snapshot.phaseMask) === 0) continue;
      const state = snapshot.states.get(row.stateVariable);
      if (state === undefined || state <= 0) continue;
      // Only the stock capture-point extended owner is implemented by WorldStateFrame.lua.
      if (row.extendedUi && row.extendedUi !== "CAPTUREPOINT") continue;
      const values = row.extendedVariables.map((id) => id === 0 ? 0 : snapshot.states.get(id));
      if (values.some((value) => value === undefined)) continue;
      const texts = [row.text, row.tooltip, row.dynamicTooltip].map((text) =>
        formatWorldStateText(text, snapshot.states, snapshot.serverTime));
      // CAPTUREPOINT's stock branch uses only its three extended variables. Several actual DBC
      // rows refer to an unrelated, absent variable in their unused text (e.g. row 139 uses
      // %2427w although its capture states are 2473/2474/2475). Keep the bar, leaving any
      // unresolved, unused text empty instead of inventing that other variable's value.
      if (row.extendedUi === "CAPTUREPOINT") {
        if (row.icon && texts[1] === undefined) continue; // stock displays this tooltip
      } else if (texts.some((text) => text === undefined)) continue;
      rows.push([row.type, state, texts[0] ?? "", row.icon, row.dynamicIcon,
        texts[1] ?? "", texts[2] ?? "", row.extendedUi,
        values[0]!, values[1]!, values[2]!]);
    }
    return rows;
  }
}

export const FRAMEXML_WORLD_STATE_BINDINGS = Object.freeze({
  GetNumWorldStateUI: (seam: { worldStates?: FrameXmlWorldStates }): readonly unknown[] => [seam.worldStates?.rows().length ?? 0],
  GetWorldStateUIInfo: (seam: { worldStates?: FrameXmlWorldStates }, args: readonly unknown[]): readonly unknown[] => {
    const index = args[0];
    return typeof index === "number" && Number.isInteger(index) && index > 0
      ? seam.worldStates?.rows()[index - 1] ?? [] : [];
  },
});

export async function fetchFrameXmlWorldStates(origin: string): Promise<readonly WorldStateUiRow[]> {
  const response = await fetch(new URL("/dbc/world-state-ui?v=1", origin), { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`WorldStateUI gateway returned ${response.status}`);
  const data: unknown = await response.json();
  if (!isWorldStateUiCatalog(data)) throw new Error("malformed WorldStateUI catalog");
  return data;
}
