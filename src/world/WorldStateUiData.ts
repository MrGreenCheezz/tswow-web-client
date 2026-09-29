/** Authored presentation from the 3.3.5a WorldStateUI client table. */
export interface WorldStateUiRow {
  readonly id: number;
  readonly mapId: number;
  readonly areaId: number;
  readonly phaseMask: number;
  readonly icon: string;
  readonly text: string;
  readonly tooltip: string;
  readonly stateVariable: number;
  readonly type: number;
  readonly dynamicIcon: string;
  readonly dynamicTooltip: string;
  readonly extendedUi: string;
  readonly extendedVariables: readonly [number, number, number];
}

export function isWorldStateUiCatalog(value: unknown): value is readonly WorldStateUiRow[] {
  return Array.isArray(value) && value.length <= 10000 && value.every((row: Partial<WorldStateUiRow> | null) =>
    row && [row.id, row.mapId, row.areaId, row.phaseMask, row.stateVariable, row.type].every(Number.isInteger)
      && [row.icon, row.text, row.tooltip, row.dynamicIcon, row.dynamicTooltip, row.extendedUi]
        .every((text) => typeof text === "string")
      && Array.isArray(row.extendedVariables) && row.extendedVariables.length === 3
      && row.extendedVariables.every(Number.isInteger));
}

/** `%1581w` is a state value; `%3781k` is an absolute server-time deadline. */
export function formatWorldStateText(
  text: string, states: ReadonlyMap<number, number>, serverTime: number | undefined,
): string | undefined {
  let unresolved = false;
  const rendered = text.replace(/%(\d+)([wk])/g, (_match, id: string, kind: string) => {
    const value = states.get(Number(id));
    if (value === undefined || kind === "k" && serverTime === undefined) {
      unresolved = true;
      return "";
    }
    if (kind === "w") return String(value);
    const seconds = Math.max(0, Math.floor(value - serverTime!));
    const minutes = Math.floor(seconds / 60);
    return minutes >= 60
      ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
      : `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
  });
  return unresolved ? undefined : rendered;
}
