// 05.10-A7a-E (6.12): SpellMissileMotion.dbc, the motion scripts a missile flies by.
//
// Not in tools/dbd and not loaded by TrinityCore (the server has no use for a picture), so it is read with
// a checked fixed layout: 5 fields of 4 bytes — ID, Name (string), ScriptBody (string), Flags, MissileCount
// (probe docs/implementation/probes/A7a/probe-motion.mjs: 204 rows, Flags 0 on every row, MissileCount
// 1…10; Wow.exe 0x006ff0a0 reads the row's +4 name and +8 script). `SpellVisual.MissileMotion` names a row
// (1,053 visuals, 185 distinct rows). The script is carried verbatim — the browser compiles it
// (browser/MissileScript.ts) — and the name is dropped: nothing reads it.

import { parseFixed, type FixedLayout } from "./DbcFixed.js";

export const SPELL_MISSILE_MOTION_LAYOUT: FixedLayout = Object.freeze({ fieldCount: 5, recordSize: 20 });

/** What a missile carries of its motion row. */
export interface SpellMissileMotionRow {
  id: number;
  /** ScriptBody, verbatim. */
  script: string;
  /** MissileCount: how many missiles one launch shows (1 when the row says 0 or less). */
  count: number;
}

/** Every row with a script or a count above 1, by id. Throws `DbcError` when the file is not this layout. */
export function parseSpellMissileMotions(payload: Uint8Array): Map<number, SpellMissileMotionRow> {
  const data = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  const rows = parseFixed("SpellMissileMotion", data, SPELL_MISSILE_MOTION_LAYOUT);
  const result = new Map<number, SpellMissileMotionRow>();
  for (let row = 0; row < rows.records; row++) {
    const id = rows.int(row, 0);
    const script = rows.string(row, 2);
    const count = rows.int(row, 4);
    // Two rows ("Missile - 2" 1662, "Missile - 3" 2044) have no script and only a count: kept, they still
    // multiply the missile. A row with neither says nothing.
    if (id <= 0 || (script.trim() === "" && count <= 1)) continue;
    result.set(id, { id, script, count: count > 0 ? count : 1 });
  }
  return result;
}
