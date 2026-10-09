/**
 * Plan item 3.29 (L12, 04.10): a canned trainer with skill lines — the vertical's header rows, collapsing,
 * line filter and «buy everything» — answered by the same list the live seam uses (FrameXmlTrainerGroups.ts,
 * FrameXmlTrainerSkillLines.ts). A canned trainer without `skillLines` keeps CannedWorldSeam's flat list.
 */
import {
  FrameXmlTrainerList, TRAINER_STATE_AVAILABLE, TRAINER_STATE_UNAVAILABLE, TRAINER_STATE_USED,
  type FrameXmlTrainerGroupRow, type FrameXmlTrainerState,
} from "./FrameXmlTrainerGroups.js";
import { frameXmlTrainerSkillLineModel, type FrameXmlTrainerSkillLineModel } from "./FrameXmlTrainerSkillLines.js";
import { TRAINER_SPELL_AVAILABLE, TRAINER_SPELL_KNOWN } from "../../world/TrainerProtocol.js";

/** The parts of a canned service the list reads. */
export interface FrameXmlCannedTrainerRow extends FrameXmlTrainerGroupRow {
  readonly usable: number;
  readonly name: string;
  readonly rank?: string;
  /** Its skill line: the group the client would file it under; none leaves it out, as in Wow.exe. */
  readonly skillLine?: number;
}

const TYPE_NAMES = ["available", "unavailable", "used"] as const;

export interface FrameXmlCannedTrainerGroups<Row extends FrameXmlCannedTrainerRow> {
  readonly list: FrameXmlTrainerList<Row>;
  readonly skillLines: FrameXmlTrainerSkillLineModel;
}

/**
 * The list over `rows` (the open trainer's services, else none), named by `lines`, filtered by the
 * seam's type filter `shown(type)`; `changed` raises TRAINER_UPDATE after a line-filter write.
 */
export function frameXmlCannedTrainerGroups<Row extends FrameXmlCannedTrainerRow>(
  rows: () => readonly Row[], lines: Readonly<Record<number, string>>, shown: (type: string) => boolean,
  changed: () => void,
): FrameXmlCannedTrainerGroups<Row> {
  const state = (row: Row): FrameXmlTrainerState => row.usable === TRAINER_SPELL_AVAILABLE ? TRAINER_STATE_AVAILABLE
    : row.usable === TRAINER_SPELL_KNOWN ? TRAINER_STATE_USED : TRAINER_STATE_UNAVAILABLE;
  const list = new FrameXmlTrainerList<Row>({
    rows, describable: () => true, grouped: () => true, tradeskill: false, state,
    group: (row) => row.skillLine ?? 0,
    groupName: (group) => lines[group],
    name: (row) => row.name,
    rank: (row) => row.rank,
    shown: (value) => shown(TYPE_NAMES[value]),
  });
  return { list, skillLines: frameXmlTrainerSkillLineModel(list, changed) };
}
