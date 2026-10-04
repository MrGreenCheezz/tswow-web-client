/**
 * Plan item 3.23A: `UnitCreatureType(unit)` and `UnitCreatureFamily(unit)` as Wow.exe answers them,
 * over the creature type table (`/dbc/creature-types`, CreatureTypeClient.ts).
 *
 * - Type (0x611780 → 0x71f300): the unit's shapeshift form (UNIT_FIELD_BYTES_2 byte 3) when its
 *   SpellShapeshiftForm row has a creature type above 0; otherwise the creature cache's type (a
 *   creature — `creature_template.type`, `SMSG_CREATURE_QUERY_RESPONSE`); otherwise, for a player,
 *   the race's `ChrRaces.CreatureType`. The answer is that CreatureType row's name, nil without one.
 * - Family (0x611820 → 0x7153e0): the creature cache's family, named by CreatureFamily; a player,
 *   whose object has no creature cache, answers nil.
 *
 * Until the table lands (or against a gateway that predates the route) both answer nil, except the
 * pet's family, which the stable model already names from the talent tables (FrameXmlStable.ts).
 */

import { readByte, readField } from "../../world/Fields.js";
import type { WorldObjectState } from "../../world/WorldState.js";

const TYPEID_UNIT = 3;
const TYPEID_PLAYER = 4;

export interface FrameXmlCreatureTypeNames {
  typeName(id: number): string | undefined;
  familyName(id: number): string | undefined;
  raceType(race: number): number | undefined;
  formType(form: number): number | undefined;
}

export interface FrameXmlCreatureTemplateTypes {
  readonly found?: boolean;
  readonly creatureType: number;
  readonly creatureFamily: number;
}

/** The CreatureType id 0x71f300 picks, or undefined. */
export function frameXmlCreatureTypeId(
  object: WorldObjectState, template: FrameXmlCreatureTemplateTypes | undefined, names: FrameXmlCreatureTypeNames,
): number | undefined {
  const form = readByte(object, "UNIT_FIELD_BYTES_2", 3) ?? 0;
  const formType = form > 0 ? names.formType(form) : undefined;
  if (formType !== undefined && formType > 0) return formType;
  if (object.typeId === TYPEID_UNIT) return template?.found === false ? undefined : template?.creatureType;
  if (object.typeId === TYPEID_PLAYER) {
    const race = readByte(object, "UNIT_FIELD_BYTES_0", 0) ?? 0;
    const type = names.raceType(race);
    return type !== undefined && type > 0 ? type : undefined;
  }
  return undefined;
}

export function frameXmlUnitCreatureType(
  object: WorldObjectState | undefined, template: FrameXmlCreatureTemplateTypes | undefined,
  names: FrameXmlCreatureTypeNames | undefined,
): string | undefined {
  if (!object || !names) return undefined;
  const id = frameXmlCreatureTypeId(object, template, names);
  return id === undefined ? undefined : names.typeName(id);
}

export function frameXmlUnitCreatureFamily(
  object: WorldObjectState | undefined, template: FrameXmlCreatureTemplateTypes | undefined,
  names: FrameXmlCreatureTypeNames | undefined,
): string | undefined {
  if (!object || !names || object.typeId !== TYPEID_UNIT || !template || template.found === false) return undefined;
  return template.creatureFamily > 0 ? names.familyName(template.creatureFamily) : undefined;
}

/** The creature template entry of a unit object, for the cache lookups above. */
export function frameXmlCreatureEntry(object: WorldObjectState): number | undefined {
  return object.typeId === TYPEID_UNIT ? readField(object, "OBJECT_FIELD_ENTRY") : undefined;
}

export interface FrameXmlCreatureTypeHost {
  /** `UnitCreatureType`/`UnitCreatureFamily` over the live world; absent on the canned seam. */
  readonly creatureTypes?: {
    type(unit: string): string | undefined;
    /** undefined while the table is not here, so the stable model can still name the pet. */
    family(unit: string): string | undefined | null;
  } | undefined;
  readonly stable?: { petFamilyName(): string | undefined } | undefined;
}

const NOTHING: readonly unknown[] = Object.freeze([]);
const optional = (value: string | undefined | null): readonly unknown[] => (value ? [value] : NOTHING);

export const FRAMEXML_CREATURE_TYPE_BINDINGS: Readonly<Record<string,
  (host: FrameXmlCreatureTypeHost, args: readonly unknown[]) => readonly unknown[]>> = Object.freeze({
  UnitCreatureType: (host, args) => optional(typeof args[0] === "string" ? host.creatureTypes?.type(args[0]) : undefined),
  UnitCreatureFamily: (host, args) => {
    const unit = typeof args[0] === "string" ? args[0] : "";
    const answer = host.creatureTypes?.family(unit);
    // null: the table is here and the unit has no family. undefined: no table yet — the pet's
    // family still comes from the stable model, as before 3.23A.
    if (answer !== undefined) return optional(answer);
    return unit.toLowerCase() === "pet" ? optional(host.stable?.petFamilyName()) : NOTHING;
  },
});
