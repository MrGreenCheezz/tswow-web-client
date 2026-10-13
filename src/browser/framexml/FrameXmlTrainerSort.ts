/**
 * 3.29 (13.10): the trainer window's whole row array as Wow.exe 3.3.5a 12340 keeps it (DAT_00c0e4bc,
 * ClassTrainerFrame.cpp; notes .runtime/re-2026-10-01/a1-w4/d1.c–d3.c, re-2026-10-11/glue-1110/1013-q1.txt) —
 * the hidden rows too, after the visible ones — and the order it sorts them in.
 *
 * - A new list (0x00596450) lays the services out in packet order (a service without a group is left out),
 *   then one header per line in the sorted lines' order. Every later rebuild — a type or line filter, a
 *   collapse, a state change (0x00596b00: a learned spell) — sorts that same array again, as it stands
 *   (0x00594ba0 → `qsort` 0x0040be50, FrameXmlMsvcQsort.ts). The visible-row count (DAT_00c0e4a8) is what
 *   GetNumTrainerServices answers; every index function — GetTrainerServiceInfo (0x00594e80, 0x00594f60,
 *   0x00594260, 0x00594300), SelectTrainerService (0x005943a0), BuyTrainerService (0x00594da0),
 *   Collapse/ExpandTrainerSkillLine (0x005942b0) — is bounded by the whole array (DAT_00c0e4a0), so an
 *   index past the visible rows reaches a hidden one.
 * - Visible (0x00594ba0): a line shows when one of its state counts is in a state the type filter shows and
 *   its bit of the line filter is set; a header shows with its line; a service when the type filter shows
 *   its state, its line shows and its line is not collapsed.
 * - The comparator (0x005947d0; a trade skill trainer 0x005949a0): visible before hidden; two hidden rows
 *   are equal (0), so their order is the qsort's; two visible rows by their line's position in the sorted
 *   lines (trade skill: the group number), a header before its services, then services by required level,
 *   required skill rank, name and rank in the client's compare (0x0076ec80) — a trade skill trainer: skill
 *   rank and name.
 * - The default selection (0x00594ba0's tail): the first visible available service of the sorted array,
 *   else the second element of the array when it is a service (hidden or not, any state), else none.
 */
import { frameXmlQuestLogCompare } from "./FrameXmlQuestLog.js";
import { frameXmlMsvcQsort } from "./FrameXmlMsvcQsort.js";
import type {
  FrameXmlTrainerEntry, FrameXmlTrainerGroupRow, FrameXmlTrainerGroupSource, FrameXmlTrainerLine, FrameXmlTrainerLineView,
  FrameXmlTrainerState,
} from "./FrameXmlTrainerGroups.js";

/** TRAINER_STATE_AVAILABLE (type-only import of the groups file: it imports this one). */
const AVAILABLE: FrameXmlTrainerState = 0;

/** The whole array, sorted, and how many of its first elements are visible. */
export interface FrameXmlTrainerSorted<Row> {
  readonly entries: readonly FrameXmlTrainerEntry<Row>[];
  readonly visible: number;
}

interface Line {
  readonly id: number;
  readonly counts: [number, number, number];
  allPointCost: boolean;
  readonly name: string | undefined;
}

interface Item<Row> {
  readonly entry: FrameXmlTrainerEntry<Row>;
  readonly key: string;
  visible: boolean;
  position: number;
}

const keyOf = <Row extends FrameXmlTrainerGroupRow>(entry: FrameXmlTrainerEntry<Row>): string =>
  entry.header ? `h${entry.group}` : `s${entry.row.spellId}`;

/**
 * The array for one list, filter and collapse state. `previous` is the array as it stood (the same list
 * rebuilt): its elements keep their places before the sort, as the client's array does; elements it did not
 * have (a row that became describable) follow in packet order. Without it, the new list's layout.
 */
export function frameXmlTrainerSort<Row extends FrameXmlTrainerGroupRow>(
  rows: readonly Row[], source: FrameXmlTrainerGroupSource<Row>, collapsed: ReadonlySet<number>,
  lines?: FrameXmlTrainerLineView, previous?: readonly FrameXmlTrainerEntry<Row>[],
): FrameXmlTrainerSorted<Row> {
  const groups = new Map<number, Line>();
  const services: FrameXmlTrainerEntry<Row>[] = [];
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
    services.push({ header: false, group: id, row, state });
  }
  const ordered = [...groups.values()].sort(source.tradeskill
    ? (a, b) => a.id - b.id
    : (a, b) => a.allPointCost !== b.allPointCost ? (a.allPointCost ? 1 : -1)
      : frameXmlQuestLogCompare(a.name ?? "", b.name ?? ""));
  lines?.ordered(ordered.map(({ id, name }): FrameXmlTrainerLine => ({ id, name })));
  const position = new Map<number, number>();
  const shownLine = new Set<number>();
  ordered.forEach((group, at) => {
    position.set(group.id, at);
    if ((lines?.shown(at) ?? true)
      && group.counts.some((count, state) => count > 0 && source.shown(state as FrameXmlTrainerState))) {
      shownLine.add(group.id);
    }
  });
  const headers = ordered.map((group): FrameXmlTrainerEntry<Row> =>
    ({ header: true, group: group.id, name: group.name, expanded: !collapsed.has(group.id) }));
  const fresh = new Map<string, FrameXmlTrainerEntry<Row>>();
  for (const entry of services) fresh.set(keyOf(entry), entry);
  for (const entry of headers) fresh.set(keyOf(entry), entry);
  const items: Item<Row>[] = [];
  const taken = new Set<string>();
  const add = (key: string): void => {
    const entry = fresh.get(key);
    if (!entry || taken.has(key)) return;
    taken.add(key);
    const visible = entry.header ? shownLine.has(entry.group)
      : source.shown(entry.state) && shownLine.has(entry.group) && !collapsed.has(entry.group);
    items.push({ entry, key, visible, position: position.get(entry.group) ?? 0 });
  };
  for (const entry of previous ?? []) add(keyOf(entry));
  for (const entry of services) add(keyOf(entry));
  for (const entry of headers) add(keyOf(entry));
  const lineCount = ordered.length;
  const compareServices = (a: Row, b: Row): number => {
    if (!source.tradeskill && a.requiredLevel !== b.requiredLevel) return b.requiredLevel < a.requiredLevel ? 1 : -1;
    if (a.requiredSkillRank !== b.requiredSkillRank) return b.requiredSkillRank < a.requiredSkillRank ? 1 : -1;
    const byName = frameXmlQuestLogCompare(source.name(a), source.name(b));
    return byName !== 0 || source.tradeskill ? byName : frameXmlQuestLogCompare(source.rank(a) ?? "", source.rank(b) ?? "");
  };
  frameXmlMsvcQsort(items, (a, b) => {
    if (a.visible !== b.visible) return a.visible ? -1 : 1;
    if (!a.visible) return 0;
    if (source.tradeskill) {
      if (a.entry.group !== b.entry.group) return b.entry.group < a.entry.group ? 1 : -1;
    } else if (lineCount > 0 && a.position !== b.position) {
      return b.position < a.position ? 1 : -1;
    }
    if (a.entry.header || b.entry.header) return a.entry.header ? -1 : 1;
    return compareServices(a.entry.row, b.entry.row);
  });
  let visible = 0;
  while (visible < items.length && items[visible]!.visible) visible += 1;
  return { entries: items.map((item) => item.entry), visible };
}

/** The spell id 0x00594ba0 selects over the sorted array (`visible` first elements visible); 0 for none. */
export function frameXmlTrainerSortedSelection<Row extends FrameXmlTrainerGroupRow>(
  sorted: FrameXmlTrainerSorted<Row>,
): number {
  const { entries, visible } = sorted;
  for (let index = 0; index < visible; index += 1) {
    const entry = entries[index]!;
    if (!entry.header && entry.row.spellId > 0 && entry.state === AVAILABLE) return entry.row.spellId;
  }
  const second = entries[1];
  return second && !second.header && second.row.spellId > 0 ? second.row.spellId : 0;
}
