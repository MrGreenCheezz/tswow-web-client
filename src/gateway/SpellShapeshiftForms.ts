import { DbcError } from "./Dbc.js";

// TrinityCore DBCStructure.h:1628-1640 names column 0 as ID and column 1 as
// BonusActionBar. DBCfmt.h:128 confirms the 35-word 3.3.5a record. The core skips
// column 1, but the original client uses it to select the extra action page.
const FIELDS = 35;
const RECORD_BYTES = FIELDS * 4;
const MAX_ROWS = 256;

/** Form ID -> authored action-bar offset from SpellShapeshiftForm.dbc. */
export function parseSpellShapeshiftFormBonuses(payload: Uint8Array): Map<number, number> {
  const data = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  if (data.length < 20 || data.toString("latin1", 0, 4) !== "WDBC") {
    throw new DbcError("SpellShapeshiftForm.dbc: not a WDBC file.");
  }
  const rows = data.readUInt32LE(4);
  const fields = data.readUInt32LE(8);
  const recordSize = data.readUInt32LE(12);
  const stringBytes = data.readUInt32LE(16);
  if (fields !== FIELDS || recordSize !== RECORD_BYTES || rows > MAX_ROWS
    || 20 + rows * RECORD_BYTES + stringBytes !== data.length) {
    throw new DbcError("SpellShapeshiftForm.dbc: invalid 3.3.5a record shape or length.");
  }
  const bonuses = new Map<number, number>();
  for (let row = 0; row < rows; row++) {
    const at = 20 + row * RECORD_BYTES;
    const id = data.readUInt32LE(at);
    if (id === 0) continue;
    if (bonuses.has(id)) throw new DbcError(`SpellShapeshiftForm.dbc: duplicate form ${id}.`);
    bonuses.set(id, data.readUInt32LE(at + 4));
  }
  return bonuses;
}
