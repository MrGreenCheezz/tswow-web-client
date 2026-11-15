/**
 * The binding table (`Bindings.ts`: action → two chords) as Wow.exe's bindings cache text and back (5.37).
 *
 * A set's text is its differences from the default bindings (Wow.exe 0x0055f1b0 writes only keys whose
 * binding is not DefaultBindings.wtf's; `bind KEY NONE` takes a default key away). Reading is therefore
 * «this client's defaults, then the text's lines»; writing is «the server's lines, each brought to what the
 * table says now, then a line for every other key the table holds differently from its defaults».
 *
 * What the table cannot hold is kept, never written over:
 *  - a line whose key is not a keyboard chord here (a mouse button, a joystick, ESCAPE) or that is not in
 *    mode 0, every `modifiedclick` line and every line of no known kind: written back as read;
 *  - a line binding a key to a command this client has no row for (a raid mark, the camera wheel's): the
 *    key is taken off its default here, as in Wow.exe, and the line is written back as read until the
 *    player binds that key to something here;
 *  - a third key on a command (the table holds two per action): the same, «reserved».
 * Commands are Bindings.xml's names for the stock rows (`FrameXmlBinding.ts`), `WEBCLIENT_*` for this
 * client's own rows, and the row's own name for a direct binding (`SPELL x`, `ITEM x`, `MACRO x`,
 * `CLICK b:m`, Wow.exe's own commands) and for a module's action (`module:…`, which Wow.exe keeps as an
 * unknown command and writes back).
 *
 * DOM-free and world-free.
 */

import { DEFAULT_BINDINGS, INPUT_ACTIONS, type BindingPair } from "./Bindings.js";
import {
  frameXmlBindingAction, frameXmlBindingCommand, frameXmlChordToKey, frameXmlKeyToChord,
} from "../framexml/FrameXmlBinding.js";
import { bindLine, canonicalBindingKey, renderBindingsCacheText, type BindingsCacheLine } from "./BindingsCacheText.js";

export interface BindingTablesView {
  readonly core: Readonly<Record<string, BindingPair>>;
  readonly modules: Readonly<Record<string, BindingPair>>;
}

export interface BindingTables {
  core: Record<string, [string, string]>;
  modules: Record<string, [string, string]>;
}

/** The core table's mark that it is written under the stock layout (`Bindings.LAYOUT_ROW`). */
const LAYOUT_ROW = "$layout";
const STOCK_LAYOUT = "stock";

const CORE_ACTIONS: ReadonlySet<string> = new Set(INPUT_ACTIONS.map((entry) => entry.action));

/** A module-table row a text line can name: a direct binding's command or a module's action. */
export function textModuleCommand(name: string): boolean {
  if (/[\r\n]/.test(name)) return false;
  return /^(?:SPELL|ITEM|MACRO|CLICK) \S/.test(name) || name.startsWith("module:");
}

/** A text key as the table's chord, or undefined for a key the table cannot hold. */
export function bindingChordOfKey(key: string): string | undefined {
  return frameXmlKeyToChord(canonicalBindingKey(key));
}

/** chord → command, resolved as `Bindings.reindex` resolves a chord: core rows first, in order. */
export function commandsByChord(tables: BindingTablesView): Map<string, string> {
  const result = new Map<string, string>();
  for (const { action } of INPUT_ACTIONS) {
    const pair = tables.core[action];
    if (!pair) continue;
    const command = frameXmlBindingCommand(action);
    for (const chord of pair) if (chord && !result.has(chord)) result.set(chord, command);
  }
  for (const [name, pair] of Object.entries(tables.modules)) {
    if (!textModuleCommand(name)) continue;
    for (const chord of pair) if (chord && !result.has(chord)) result.set(chord, name);
  }
  return result;
}

/** A mutable copy of tables (core rows of every action, the layout mark kept). */
export function copyTables(tables: BindingTablesView): BindingTables {
  const core: Record<string, [string, string]> = {};
  for (const [name, pair] of Object.entries(tables.core)) core[name] = [pair[0], pair[1]];
  const modules: Record<string, [string, string]> = {};
  for (const [name, pair] of Object.entries(tables.modules)) modules[name] = [pair[0], pair[1]];
  return { core, modules };
}

/** Takes a chord off every row that holds it. */
export function unbindChord(tables: BindingTables, chord: string): void {
  for (const rows of [tables.core, tables.modules]) {
    for (const pair of Object.values(rows)) {
      if (pair[0] === chord) pair[0] = "";
      if (pair[1] === chord) pair[1] = "";
    }
  }
}

/** Puts a chord in a row's first empty place; false when the row has none. */
function place(pair: [string, string], chord: string): boolean {
  if (pair[0] === "") pair[0] = chord;
  else if (pair[1] === "") pair[1] = chord;
  else return false;
  return true;
}

function defaultTables(): BindingTables {
  const tables = copyTables({ core: DEFAULT_BINDINGS, modules: {} });
  tables.core[LAYOUT_ROW] = [STOCK_LAYOUT, ""];
  return tables;
}

/** The mode-0 `bind` lines with a chord here, and which of them is the last for its chord (Wow.exe's last wins). */
function chordLines(lines: readonly BindingsCacheLine[]): { chordAt: Map<number, string>; lastOf: Map<string, number> } {
  const chordAt = new Map<number, string>();
  const lastOf = new Map<string, number>();
  lines.forEach((line, index) => {
    if (line.kind !== "bind" || line.mode !== 0) return;
    const chord = bindingChordOfKey(line.key);
    if (chord === undefined) return;
    chordAt.set(index, chord);
    lastOf.set(chord, index);
  });
  return { chordAt, lastOf };
}

function isNone(command: string): boolean {
  const trimmed = command.trim();
  return trimmed === "" || trimmed.toUpperCase() === "NONE";
}

export interface TablesFromText {
  readonly tables: BindingTables;
  /** Chords a kept line holds for a command the table has no place for (see the module comment). */
  readonly reserved: ReadonlySet<string>;
}

/**
 * The table a set's text means: the defaults, every chord a line names taken off its default first, then
 * each line's binding put on (the last line of a chord wins). The core table carries the stock layout mark.
 */
export function tablesFromCacheText(lines: readonly BindingsCacheLine[]): TablesFromText {
  const tables = defaultTables();
  const reserved = new Set<string>();
  const { chordAt, lastOf } = chordLines(lines);
  // Taken off first: a key moved from a default command to another is not «a third key» of the second.
  for (const chord of chordAt.values()) unbindChord(tables, chord);
  for (const [index, chord] of chordAt) {
    if (lastOf.get(chord) !== index) continue;
    const line = lines[index]!;
    if (line.kind !== "bind" || isNone(line.command)) continue;
    const command = line.command.trim();
    const action = frameXmlBindingAction(command);
    let placed = false;
    if (action !== undefined) placed = place(tables.core[action]!, chord);
    else if (textModuleCommand(command)) placed = place(tables.modules[command] ??= ["", ""], chord);
    if (!placed) reserved.add(chord);
  }
  return { tables, reserved };
}

/**
 * The set's text for the table: the server's lines brought to the table (a line whose binding the table no
 * longer has becomes the table's, or `NONE`; reserved and foreign lines stay as read), then a line for each
 * chord the table binds otherwise than its defaults. Text with nothing in it is the empty text.
 */
export function cacheTextFromTables(
  serverLines: readonly BindingsCacheLine[], tables: BindingTablesView, reserved: ReadonlySet<string>,
): string {
  const ours = commandsByChord(tables);
  const base = commandsByChord({ core: DEFAULT_BINDINGS, modules: {} });
  const { chordAt, lastOf } = chordLines(serverLines);
  const handled = new Set<string>();
  const out: BindingsCacheLine[] = [];
  serverLines.forEach((line, index) => {
    const chord = chordAt.get(index);
    if (line.kind !== "bind" || chord === undefined) {
      out.push(line);
      return;
    }
    // An earlier line of the same key: Wow.exe applied the later one, and writes one line per key.
    if (lastOf.get(chord) !== index) return;
    handled.add(chord);
    const desired = ours.get(chord);
    if (desired === undefined) {
      if (reserved.has(chord) || isNone(line.command)) out.push(line);
      else out.push({ ...line, command: "NONE", raw: bindLine(line.key, "NONE") });
      return;
    }
    if (line.command.trim() === desired) out.push(line);
    else out.push({ ...line, command: desired, raw: bindLine(line.key, desired) });
  });
  for (const chord of new Set([...ours.keys(), ...base.keys()])) {
    if (handled.has(chord)) continue;
    const desired = ours.get(chord) ?? "NONE";
    if (desired === (base.get(chord) ?? "NONE")) continue;
    const key = frameXmlChordToKey(chord);
    if (key === undefined) continue;
    out.push({ kind: "bind", mode: 0, key, command: desired, raw: bindLine(key, desired) });
  }
  return renderBindingsCacheText(out);
}

/** Every chord of the tables with the row and place that holds it: what a change moved. */
export function chordHolders(tables: BindingTablesView): Map<string, string> {
  const holders = new Map<string, string>();
  for (const [kind, rows] of [["c", tables.core], ["m", tables.modules]] as const) {
    for (const [name, pair] of Object.entries(rows)) {
      if (kind === "c" && !CORE_ACTIONS.has(name)) continue;
      pair.forEach((chord, slot) => {
        if (chord && !holders.has(chord)) holders.set(chord, `${kind}\u0001${slot}\u0001${name}`);
      });
    }
  }
  return holders;
}

/** Puts chords back where `holders` says (undefined: nowhere), over tables built from elsewhere. */
export function overlayChords(tables: BindingTables, chords: ReadonlyMap<string, string | undefined>): void {
  for (const [chord, holder] of chords) {
    unbindChord(tables, chord);
    if (holder === undefined) continue;
    const [kind, slot, ...rest] = holder.split("\u0001");
    const name = rest.join("\u0001");
    const rows = kind === "c" ? tables.core : tables.modules;
    if (kind === "c" && !CORE_ACTIONS.has(name)) continue;
    const pair = rows[name] ??= ["", ""];
    pair[slot === "1" ? 1 : 0] = chord;
  }
}
