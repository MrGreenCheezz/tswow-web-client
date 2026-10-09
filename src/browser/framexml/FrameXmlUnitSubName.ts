/**
 * Plan item 3.12e: the creature's sub-name line `GameTooltip:SetUnit` writes itself under the name.
 *
 * Wow.exe 3.3.5a 12340, the unit tooltip writer 0x00621070 (read 2026-10-02): after the name line (and,
 * for a player, the guild line; with `colorblindMode` on, the standing label), a unit that is not a
 * player gets one more line from 0x00719950 — the creature cache record's sub-name (record + 4), as the
 * realm sent it in SMSG_CREATURE_QUERY_RESPONSE, written as it is (no brackets are added: the client
 * has no "<%s>" format for it), and only when the record has one and the unit's UNIT_FIELD_PETNUMBER
 * is 0 — a hunter's or warlock's pet keeps its template's sub-name off the tooltip. A unit whose
 * record is not cached yet gets no line, as the client's empty record gives none.
 */

import { readField } from "../../world/Fields.js";
import type { WorldObjectState } from "../../world/WorldState.js";

const TYPEID_UNIT = 3;

/** The part of a creature cache record this line reads. */
export interface FrameXmlSubNameTemplate {
  readonly found?: boolean;
  readonly subName?: string;
}

export function frameXmlUnitSubName(
  object: WorldObjectState | undefined,
  template: (entry: number, guid: bigint) => FrameXmlSubNameTemplate | undefined,
): string | undefined {
  // Only a creature: a player (type mask 0x10) gets the guild line instead, other objects nothing.
  if (!object || object.typeId !== TYPEID_UNIT) return undefined;
  if ((readField(object, "UNIT_FIELD_PETNUMBER") ?? 0) !== 0) return undefined;
  const entry = readField(object, "OBJECT_FIELD_ENTRY") ?? 0;
  if (entry <= 0) return undefined;
  const record = template(entry, object.guid);
  if (!record || record.found === false) return undefined;
  const subName = record.subName;
  return typeof subName === "string" && subName.length > 0 ? subName : undefined;
}
