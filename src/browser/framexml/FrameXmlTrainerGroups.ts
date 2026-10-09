/**
 * Plan item 3.29: the trainer window's skill-line headers, their collapsing and the service order, as
 * Wow.exe 3.3.5a 12340 builds them (ClassTrainerFrame.cpp; read 2026-10-02). Nothing on the wire names a
 * group: the client derives it.
 *
 * - The list builder (0x596450, called by the SMSG_TRAINER_LIST handler 0x6d12c0 for the open trainer)
 *   files each service under a group: for a trade skill trainer (type 2) 1 when its spell has a
 *   SKILL_STEP effect, 3 when it is passive (Attributes 0x40), else 2 — named by the GlobalStrings
 *   TRADESKILL_SERVICE_STEP / _LEARN / _PASSIVE; for any other trainer the skill line (0x594ae0): the
 *   spell's — or, with a LEARN_SPELL effect not aimed at the pet, the taught spell's — SkillLineAbility
 *   row for the player's race and class (0x71a670 → 0x812410), named by SkillLine. A service whose
 *   spell has no group is left out of the list. Each group counts its services per state (available,
 *   unavailable, used) and remembers whether every one of them has a point cost.
 * - The groups are sorted (0x593ce0 / 0x5941b0): trade skill groups by number; skill lines with a point
 *   cost on every service after the others, each part by name in the client's compare (0x76ec80). One header row per
 *   group follows the services.
 * - The visible list (0x594ba0, after every list, filter, collapse or state change): a group shows when
 *   it has a service in a state the type filter shows; a header shows with its group; a service shows
 *   when its state is shown, its group shows and is not collapsed. GetNumTrainerServices counts the
 *   visible rows. The rows are then sorted (0x5947d0, trade skill 0x5949a0): visible first, by group,
 *   the header first, then services by required level, required skill rank, name and rank (a trade
 *   skill trainer: required skill rank and name). The selection becomes the first visible available
 *   service, else the second row when it is a service, else none (it is a spell id, kept until the
 *   next rebuild).
 * - `GetTrainerServiceInfo(i)` (0x595090): name, rank and type ("header", "available", "unavailable",
 *   "used"); a header's name is its group's and its rank "". The fourth value is nil only for a
 *   collapsed header and 1 for everything else.
 * - `CollapseTrainerSkillLine(i)` / `ExpandTrainerSkillLine(i)` (0x596150 / 0x5961f0): the header row
 *   i's group, or every group for i ≤ 0; a new list expands all again (0x596450). Each one rebuilds and
 *   signals TRAINER_UPDATE.
 *
 * The SkillLineAbility row (0x812410) takes SkillRaceClassInfo into account (0x810ed0, review 02.10):
 * FrameXmlTrainerRequirements.ts. The skill-line filter (`SetTrainerSkillLineFilter`) and «buy everything»
 * are FrameXmlTrainerSkillLines.ts (L12 3.29). Not modelled: 0x812410's answer of none for a race/class
 * pair CharBaseInfo does not list.
 */

import { frameXmlQuestLogCompare } from "./FrameXmlQuestLog.js";
import { FrameXmlTrainerLineFilter } from "./FrameXmlTrainerSkillLines.js"; // L12 3.29

export const TRAINER_STATE_AVAILABLE = 0;
export const TRAINER_STATE_UNAVAILABLE = 1;
export const TRAINER_STATE_USED = 2;
export type FrameXmlTrainerState = 0 | 1 | 2;

const STATE_NAMES = ["available", "unavailable", "used"] as const;

/** The parts of a trainer row the list reads (`TrainerSpell`). */
export interface FrameXmlTrainerGroupRow {
  readonly spellId: number;
  readonly pointCost: readonly [number, number];
  readonly requiredLevel: number;
  readonly requiredSkillRank: number;
}

export interface FrameXmlTrainerGroupSource<Row extends FrameXmlTrainerGroupRow> {
  /** Trade skill trainers group by kind of service rather than by skill line. */
  readonly tradeskill: boolean;
  readonly state: (row: Row) => FrameXmlTrainerState;
  /** The row's group: a skill line, or 1..3 for a trade skill trainer; 0 leaves the row out. */
  readonly group: (row: Row) => number;
  readonly groupName: (group: number) => string | undefined;
  readonly name: (row: Row) => string;
  readonly rank: (row: Row) => string | undefined;
  /** The type filter: whether rows in this state show. */
  readonly shown: (state: FrameXmlTrainerState) => boolean;
}

export type FrameXmlTrainerEntry<Row> =
  | { readonly header: true; readonly group: number; readonly name: string | undefined; readonly expanded: boolean }
  | { readonly header: false; readonly group: number; readonly row: Row; readonly state: FrameXmlTrainerState };

interface Group {
  readonly id: number;
  readonly counts: [number, number, number];
  allPointCost: boolean;
  name: string | undefined;
}

/** A sorted line: its number (a skill line, or 1..3 for a trade skill trainer) and name. */
export interface FrameXmlTrainerLine {
  readonly id: number;
  readonly name: string | undefined;
}

/**
 * L12 3.29: the skill-line filter (FrameXmlTrainerSkillLines.ts) over the sorted lines (0x594ba0), and
 * who is told that order (GetTrainerSkillLines).
 */
export interface FrameXmlTrainerLineView {
  /** Whether the line at this position of the sorted lines passes the filter. */
  shown(position: number): boolean;
  ordered(lines: readonly FrameXmlTrainerLine[]): void;
}

/** The visible rows, in the client's order, for one list, filter and collapse state. */
export function frameXmlTrainerDisplay<Row extends FrameXmlTrainerGroupRow>(
  rows: readonly Row[], source: FrameXmlTrainerGroupSource<Row>, collapsed: ReadonlySet<number>,
  lines?: FrameXmlTrainerLineView, // L12 3.29
): FrameXmlTrainerEntry<Row>[] {
  const groups = new Map<number, Group>();
  const services: { row: Row; group: number; state: FrameXmlTrainerState }[] = [];
  for (const row of rows) {
    const id = source.group(row);
    if (!(id > 0)) continue;
    const state = source.state(row);
    const pointCost = row.pointCost[0] !== 0 || row.pointCost[1] !== 0;
    let group = groups.get(id);
    if (!group) {
      group = { id, counts: [0, 0, 0], allPointCost: pointCost, name: source.groupName(id) };
      groups.set(id, group);
    } else if (group.allPointCost) {
      group.allPointCost = pointCost;
    }
    group.counts[state] += 1;
    services.push({ row, group: id, state });
  }
  const ordered = [...groups.values()].sort(source.tradeskill
    ? (a, b) => a.id - b.id
    : (a, b) => a.allPointCost !== b.allPointCost ? (a.allPointCost ? 1 : -1)
      : frameXmlQuestLogCompare(a.name ?? "", b.name ?? ""));
  const position = new Map(ordered.map((group, index) => [group.id, index]));
  lines?.ordered(ordered); // L12 3.29
  const showsGroup = (group: Group, at: number): boolean => (lines?.shown(at) ?? true) && // L12 3.29: the line filter
    group.counts.some((count, state) => count > 0 && source.shown(state as FrameXmlTrainerState));
  const shownGroups = new Set(ordered.filter(showsGroup).map((group) => group.id));
  const visible: FrameXmlTrainerEntry<Row>[] = [];
  for (const group of ordered) {
    if (shownGroups.has(group.id)) {
      visible.push({ header: true, group: group.id, name: group.name, expanded: !collapsed.has(group.id) });
    }
  }
  for (const service of services) {
    if (source.shown(service.state) && shownGroups.has(service.group) && !collapsed.has(service.group)) {
      visible.push({ header: false, group: service.group, row: service.row, state: service.state });
    }
  }
  const compareRows = (a: Row, b: Row): number => {
    if (!source.tradeskill && a.requiredLevel !== b.requiredLevel) return a.requiredLevel < b.requiredLevel ? -1 : 1;
    if (a.requiredSkillRank !== b.requiredSkillRank) return a.requiredSkillRank < b.requiredSkillRank ? -1 : 1;
    const byName = frameXmlQuestLogCompare(source.name(a), source.name(b));
    return byName !== 0 || source.tradeskill ? byName : frameXmlQuestLogCompare(source.rank(a) ?? "", source.rank(b) ?? "");
  };
  return visible.sort((a, b) => {
    if (a.group !== b.group) return (position.get(a.group) ?? 0) - (position.get(b.group) ?? 0);
    if (a.header !== b.header) return a.header ? -1 : 1;
    return a.header || b.header ? 0 : compareRows(a.row, b.row);
  });
}

/** The spell id the client selects after a rebuild (0x594ba0's tail); 0 for none. */
export function frameXmlTrainerDefaultSelection<Row extends FrameXmlTrainerGroupRow>(
  entries: readonly FrameXmlTrainerEntry<Row>[],
): number {
  for (const entry of entries) {
    if (!entry.header && entry.row.spellId > 0 && entry.state === TRAINER_STATE_AVAILABLE) return entry.row.spellId;
  }
  const second = entries[1];
  return second && !second.header && second.row.spellId > 0 ? second.row.spellId : 0;
}

/** `GetTrainerServiceInfo`'s four values for one visible row. */
export function frameXmlTrainerEntryInfo<Row extends FrameXmlTrainerGroupRow>(
  entry: FrameXmlTrainerEntry<Row>, source: Pick<FrameXmlTrainerGroupSource<Row>, "name" | "rank">,
): readonly [string, string | undefined, string, boolean] {
  return entry.header
    ? [entry.name ?? "", "", "header", entry.expanded]
    : [source.name(entry.row), source.rank(entry.row), STATE_NAMES[entry.state], true];
}


/** What a seam hands the list: the open trainer's rows and how to read them. */
export interface FrameXmlTrainerListSource<Row extends FrameXmlTrainerGroupRow> extends FrameXmlTrainerGroupSource<Row> {
  /** The open trainer's rows in packet order; the same array until the list changes. */
  readonly rows: () => readonly Row[];
  /** Rows the seam can describe (a spell row known and not hidden); the others are left out. */
  readonly describable: (row: Row) => boolean;
  /** Whether the groups can be told (the tables have landed); otherwise a flat list in packet order. */
  readonly grouped: () => boolean;
}

/**
 * One trainer window's list, collapse state and selection over a seam's rows: the headers and order
 * of `frameXmlTrainerDisplay` once the groups can be told, before that the services alone in packet
 * order (as before 3.29). Built once per change of its inputs, not per C API call.
 */
export class FrameXmlTrainerList<Row extends FrameXmlTrainerGroupRow> {
  readonly #source: FrameXmlTrainerListSource<Row>;
  readonly #collapsed = new Set<number>();
  #revision = 0;
  #key = "";
  #rows: readonly Row[] | undefined;
  /** Whether the last build had the groups; compared by `groupingChanged`. */
  #builtGrouped = false;
  #entries: FrameXmlTrainerEntry<Row>[] = [];
  #groups: readonly number[] = [];
  /** DAT_00c0e49c: the selected service's spell id; 0 for none. */
  #selected = 0;
  /** L12 3.29: DAT_00c0e4ac, the skill-line filter (FrameXmlTrainerSkillLines.ts). */
  readonly #lineFilter = new FrameXmlTrainerLineFilter();
  /** L12 3.29: the sorted lines of the last build; none for the flat list. */
  #lines: readonly FrameXmlTrainerLine[] = [];
  readonly #lineView: FrameXmlTrainerLineView = { // L12 3.29
    shown: (position) => this.#lineFilter.shown(position),
    ordered: (lines) => { this.#lines = lines.map(({ id, name }) => ({ id, name })); },
  };

  constructor(source: FrameXmlTrainerListSource<Row>) {
    this.#source = source;
  }

  entries(): readonly FrameXmlTrainerEntry<Row>[] {
    const source = this.#source;
    const rows = source.rows();
    const grouped = source.grouped();
    let describable = 0;
    for (const row of rows) if (source.describable(row)) describable += 1;
    const key = `${grouped ? 1 : 0}${source.shown(0) ? 1 : 0}${source.shown(1) ? 1 : 0}${source.shown(2) ? 1 : 0}:${describable}:${this.#revision}`
      + `:${this.#lineFilter.mask}`; // L12 3.29
    if (rows === this.#rows && key === this.#key) return this.#entries;
    this.#rows = rows;
    this.#key = key;
    this.#builtGrouped = grouped;
    const known = rows.filter(source.describable);
    this.#lines = []; // L12 3.29: the flat list has no lines; a grouped build tells them below
    if (grouped) {
      this.#entries = frameXmlTrainerDisplay(known, source, this.#collapsed, this.#lineView); // L12 3.29
      const groups = new Set<number>();
      for (const row of known) { const group = source.group(row); if (group > 0) groups.add(group); }
      this.#groups = [...groups];
    } else {
      this.#entries = known.flatMap((row) => {
        const state = source.state(row);
        return source.shown(state) ? [{ header: false as const, group: 0, row, state }] : [];
      });
      this.#groups = [];
    }
    return this.#entries;
  }

  /**
   * True once when the groups became known (the tables landed) after an open trainer's rows were built
   * without them: the row indexes stock holds (ClassTrainerFrame.selectedService) changed meaning, so the
   * seam repaints with TRAINER_UPDATE. Wow.exe has its tables from the start and never needs it. The
   * selection is a spell id and follows its row.
   */
  groupingChanged(): boolean {
    const rows = this.#rows;
    if (!rows || rows.length === 0 || this.#builtGrouped || rows !== this.#source.rows() || !this.#source.grouped()) return false;
    this.entries();
    return true;
  }

  count(): number {
    return this.entries().length;
  }

  entry(index: number): FrameXmlTrainerEntry<Row> | undefined {
    return Number.isInteger(index) && index > 0 ? this.entries()[index - 1] : undefined;
  }

  /** The service row at a visible index; undefined for a header or past the end. */
  service(index: number): Row | undefined {
    const entry = this.entry(index);
    return entry && !entry.header ? entry.row : undefined;
  }

  info(index: number): readonly [string, string | undefined, string, boolean] | undefined {
    const entry = this.entry(index);
    return entry ? frameXmlTrainerEntryInfo(entry, this.#source) : undefined;
  }

  /** `GetTrainerSelectionIndex`: the selected spell's visible row (0x594430 → 0x594170). */
  selectionIndex(): number | undefined {
    if (this.#selected <= 0) return undefined;
    const index = this.entries().findIndex((entry) => !entry.header && entry.row.spellId === this.#selected);
    return index >= 0 ? index + 1 : undefined;
  }

  /** `SelectTrainerService(i)` (0x5943a0): the row's spell, 0 for a header or no row. */
  select(index: number): void {
    const entry = this.entry(index);
    this.#selected = entry && !entry.header && entry.row.spellId > 0 ? entry.row.spellId : 0;
  }

  /** The selection 0x594ba0 leaves after a rebuild (a list, filter or collapse change). */
  reselect(): void {
    this.#selected = frameXmlTrainerDefaultSelection(this.entries());
  }

  /** A new list (0x596450): every group expanded again, and the default selection. */
  listChanged(): void {
    if (this.#collapsed.size > 0) {
      this.#collapsed.clear();
      this.#revision += 1;
    }
    this.#lineFilter.reset(); // L12 3.29: and every line on again
    this.reselect();
  }

  /** L12 3.29: `GetTrainerSkillLines` — every sorted line's name, hidden ones included. */
  skillLineNames(): (string | undefined)[] {
    this.entries();
    return this.#lines.map((line) => line.name);
  }

  /** L12 3.29: `GetTrainerSkillLineFilter` (0x593eb0): position < 0 is «every line on»; undefined past the last. */
  skillLineFilter(position: number): boolean | undefined {
    this.entries();
    if (position < 0) return this.#lineFilter.allShown(this.#lines.length);
    return position < this.#lines.length ? this.#lineFilter.shown(position) : undefined;
  }

  /**
   * L12 3.29: `SetTrainerSkillLineFilter` (0x596010 → 0x595010): the mask, then the rebuild and its default
   * selection (0x594ba0). False past the last line (nothing changes).
   */
  setSkillLineFilter(position: number, on: boolean, exclusive: boolean): boolean {
    this.entries();
    if (position >= this.#lines.length) return false;
    this.#lineFilter.set(position, on, exclusive);
    this.reselect();
    return true;
  }

  /** The window went: nothing selected. */
  clear(): void {
    this.#selected = 0;
  }

  /**
   * `CollapseTrainerSkillLine(i)` / `ExpandTrainerSkillLine(i)`: the header row i's group, or every group
   * for i ≤ 0. A non-header row changes nothing (the client raises a Lua error; stock never asks).
   */
  setExpanded(index: number, expanded: boolean): boolean {
    if (!Number.isInteger(index)) return false;
    const entries = this.entries();
    if (index <= 0) {
      if (expanded) this.#collapsed.clear();
      else for (const group of this.#groups) this.#collapsed.add(group);
    } else {
      const entry = entries[index - 1];
      if (!entry?.header) return false;
      if (expanded) this.#collapsed.delete(entry.group);
      else this.#collapsed.add(entry.group);
    }
    this.#revision += 1;
    this.reselect();
    return true;
  }
}
