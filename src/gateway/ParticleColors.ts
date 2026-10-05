/**
 * 6.11а (line A7a, slice H, 05.10): `ParticleColor.dbc` rows carried with the creature displays that
 * name them, so the browser can recolour emitters without a route of its own.
 *
 * The file is ten 32-bit columns: ID, Start[3], MID[3], End[3], each colour `0xAARRGGBB` (106 rows on
 * this dataset; none of the 560 displays with `ParticleColorID` names a missing row). Wow.exe
 * 0x004ea9e0 reads exactly those columns (set i = Start[i], MID[i], End[i]). When a row is missing it
 * paints all three sets 0xff00ff00; that case does not occur in the data, and nothing is sent for it.
 */
import type { CreatureModelMetadata } from "./CreatureModelMetadata.js";

const COLUMNS = 10;

/** Row id → the nine colour words in column order; empty for anything but a 10-column WDBC. */
export function parseParticleColors(file: Uint8Array): Map<number, number[]> {
  const rows = new Map<number, number[]>();
  if (file.byteLength < 20) return rows;
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  if (view.getUint32(0, true) !== 0x43424457) return rows; // "WDBC"
  const count = view.getUint32(4, true);
  const fields = view.getUint32(8, true);
  const size = view.getUint32(12, true);
  if (fields !== COLUMNS || size !== COLUMNS * 4 || 20 + count * size > file.byteLength) return rows;
  for (let row = 0; row < count; row++) {
    const at = 20 + row * size;
    const words: number[] = [];
    for (let column = 1; column < COLUMNS; column++) words.push(view.getUint32(at + column * 4, true));
    rows.set(view.getUint32(at, true), words);
  }
  return rows;
}

/** Puts each display's colour row on it as `particleColors`, where the row exists. */
export function attachParticleColors(displays: Map<number, Pick<CreatureModelMetadata, "particleColor" | "particleColors">>,
  colors: ReadonlyMap<number, number[]>): void {
  for (const metadata of displays.values()) {
    if (metadata.particleColor === undefined) continue;
    const row = colors.get(metadata.particleColor);
    if (row) metadata.particleColors = row;
  }
}
