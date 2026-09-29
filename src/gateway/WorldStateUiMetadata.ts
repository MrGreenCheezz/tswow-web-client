import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DbcError, DEFAULT_LOCALE } from "./Dbc.js";
import { DBC_LOCALES } from "../generated/dbcLayouts.js";
import type { WorldStateUiRow } from "../world/WorldStateUiData.js";

/**
 * Layout verified against the installed TSWoW wotlk/dbc/WorldStateUI.ts getters and
 * the selected dataset: 63 words, three 17-word localized strings, three trailing variables.
 * This table is not part of the gateway's vendored WoWDBDefs set.
 */
export function parseWorldStateUiMetadata(payload: Uint8Array): readonly WorldStateUiRow[] {
  const data = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  if (data.length < 20 || data.toString("latin1", 0, 4) !== "WDBC") throw new DbcError("WorldStateUI: not WDBC");
  const count = data.readUInt32LE(4), fields = data.readUInt32LE(8), size = data.readUInt32LE(12);
  const stringSize = data.readUInt32LE(16), strings = 20 + count * size;
  if (fields !== 63 || size !== 252 || count > 10000 || strings + stringSize !== data.length) {
    throw new DbcError("WorldStateUI: invalid 3.3.5a shape or length");
  }
  const string = (at: number): string => {
    const offset = data.readUInt32LE(at);
    if (!offset) return "";
    const end = data.indexOf(0, strings + offset);
    if (offset >= stringSize || end < 0) throw new DbcError("WorldStateUI: invalid string offset");
    return data.toString("utf8", strings + offset, end);
  };
  const localized = (at: number): string => {
    const locale = DBC_LOCALES.indexOf(DEFAULT_LOCALE);
    for (const index of new Set([locale, 0, ...Array.from({ length: 16 }, (_, i) => i)])) {
      if (index < 0) continue;
      const value = string(at + index * 4);
      if (value) return value;
    }
    return "";
  };
  const rows: WorldStateUiRow[] = [];
  const ids = new Set<number>();
  for (let row = 0; row < count; row++) {
    const at = 20 + row * size;
    const int = (offset: number): number => data.readInt32LE(at + offset);
    const id = int(0);
    if (ids.has(id)) throw new DbcError(`WorldStateUI: duplicate ${id}`);
    ids.add(id);
    rows.push({ id, mapId: int(4), areaId: int(8), phaseMask: int(12), icon: string(at + 16),
      text: localized(at + 20), tooltip: localized(at + 88), stateVariable: int(156), type: int(160),
      dynamicIcon: string(at + 164), dynamicTooltip: localized(at + 168), extendedUi: string(at + 236),
      extendedVariables: [int(240), int(244), int(248)] });
  }
  return rows;
}

export async function loadWorldStateUiMetadata(directory: string): Promise<readonly WorldStateUiRow[]> {
  return parseWorldStateUiMetadata(await readFile(join(directory, "WorldStateUI.dbc")));
}
