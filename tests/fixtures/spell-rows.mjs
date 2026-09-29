// Real Spell.dbc rows for tests that must not invent a spell's shape (line A3, item 2.06).
//
// Reads the selected dataset's Spell.dbc through the gateway's own reader — the same generated
// layout the `/dbc/spells` route serves from — and hands back only the columns such a test compares:
// the name and rank string, `SpellLevel`, and the three `Effect` / `EffectMiscValue` slots, under the
// names `SpellMetadata` gives them. The table is opened once per process and only when first asked.
// A machine without the dataset gets `SPELL_ROWS_SKIP`, a `node:test` skip reason, instead of an
// error at import.
import { existsSync } from "node:fs";
import { join } from "node:path";

let directory;
try {
  directory = (await import("../../tools/paths.mjs")).dbcDirectory();
} catch {
  directory = undefined;
}

/** `false` when the dataset's Spell.dbc is on this machine, otherwise why the test is skipped. */
export const SPELL_ROWS_SKIP = directory !== undefined && existsSync(join(directory, "Spell.dbc"))
  ? false
  : "no tswow dataset Spell.dbc on this machine";

let table;
function spellTable() {
  if (SPELL_ROWS_SKIP) return Promise.reject(new Error(SPELL_ROWS_SKIP));
  table ??= import("../../dist/code/gateway/Dbc.js").then(({ openDbcFile }) => openDbcFile(directory, "Spell"));
  return table;
}

const SLOTS = [0, 1, 2];

function rowOf(spells, row) {
  return {
    id: spells.id(row),
    name: spells.locstring(row, "Name_lang"),
    rank: spells.locstring(row, "NameSubtext_lang"),
    spellLevel: spells.int(row, "SpellLevel"),
    effects: SLOTS.map((slot) => spells.int(row, "Effect", slot)),
    effectMiscValue: SLOTS.map((slot) => spells.int(row, "EffectMiscValue", slot)),
  };
}

/** The rows for `ids`, keyed by id. An id the table does not have is simply absent. */
export async function spellRows(ids) {
  const spells = await spellTable();
  const rows = new Map();
  for (const id of ids) {
    const row = spells.rowOf(id);
    if (row !== undefined) rows.set(id, rowOf(spells, row));
  }
  return rows;
}

/** Every row carrying `effect` in any of its three slots, in table order. */
export async function spellRowsWithEffect(effect) {
  const spells = await spellTable();
  const rows = [];
  for (const row of spells.rows()) {
    if (SLOTS.some((slot) => spells.int(row, "Effect", slot) === effect)) rows.push(rowOf(spells, row));
  }
  return rows;
}
