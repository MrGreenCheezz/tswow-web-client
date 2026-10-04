import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import { UNIT_FLAG_SKINNABLE } from "../../world/FactionRules.js";
import { unit as unitField } from "../../world/Fields.js";
import type { KnownSpell } from "../../world/SpellProtocol.js";
import type { WorldObjectState } from "../../world/WorldState.js";
import { gatherSkillOf, gatherSpellFor, type GatherSkill, type GatherSpellRow } from "../game/CreatureGather.js";
import { readSkills } from "../ui/Skills.js";

/**
 * The «can be skinned» line the client writes into a unit tooltip itself, inside
 * `GameTooltip:SetUnit` (Wow.exe 3.3.5a 12340: the unit tooltip builder at 0x00621070 calls the
 * line writer at 0x00620EE0; read 2026-09-30). No FrameXML Lua writes these four strings.
 *
 * What the client does, in order:
 * - The line is added when the unit's `UNIT_FIELD_FLAGS` carries `UNIT_FLAG_SKINNABLE` and the unit
 *   is not a player — dead or alive, looted or not; the server only sets the flag on a body.
 * - It goes after the level line and the PvP / resurrectable / beast-lore lines, before the rank and
 *   quest lines — here, after the binder's PvP line and before `OnTooltipSetUnit`.
 * - The word is chosen by the creature template's `type_flags` in the same order `gatherSkillOf`
 *   tests them (0x100 herbalism, 0x200 mining, 0x8000 engineering, otherwise skinning):
 *   `UNIT_SKINNABLE_HERB`, `_ROCK`, `_BOLTS`, `_LEATHER` — GlobalStrings.lua, read by name.
 * - The colour compares the player's skill in that profession with what the body asks for, from
 *   the unit's level: 1 up to level 10, 10 × level − 100 below 20, 5 × level from 20. The skill is
 *   read through the player's known gathering spell of that kind: its effect-95 value is
 *   1 + 5 × ⌊skill / 5⌋ (Spell.dbc: base 0, one die side, 5 per level, the level being the skill
 *   over five). Grey at +100 and above, green at +50, yellow at +25, orange from the requirement,
 *   red below it — and red too when the player knows no spell of that kind.
 * - With the `colorblindMode` CVar on, the text is prefixed with the difficulty's mark ("" grey,
 *   "[+]" green, "[++]" yellow, "[+++]" orange, "[-]" red); a player without the spell gets none.
 */

/** A gathering skill's SkillLine id (SkillLine.dbc), in `GatherSkill` order. */
const SKILL_LINES: Readonly<Record<GatherSkill, number>> = { 0: 393, 1: 182, 2: 186, 3: 202 };

const GLOBAL_NAMES: Readonly<Record<GatherSkill, string>> = {
  0: "UNIT_SKINNABLE_LEATHER",
  1: "UNIT_SKINNABLE_HERB",
  2: "UNIT_SKINNABLE_ROCK",
  3: "UNIT_SKINNABLE_BOLTS",
};

export interface FrameXmlSkinnableColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** The client's five difficulty colours (0xFF808080 … 0xFFFF2020) and colour-blind marks, easiest first. */
const DIFFICULTY: readonly { readonly color: FrameXmlSkinnableColor; readonly mark: string }[] = [
  { color: { r: 0x80 / 255, g: 0x80 / 255, b: 0x80 / 255 }, mark: "" },
  { color: { r: 0x40 / 255, g: 0xc0 / 255, b: 0x40 / 255 }, mark: "[+]" },
  { color: { r: 1, g: 1, b: 0 }, mark: "[++]" },
  { color: { r: 1, g: 0x80 / 255, b: 0x40 / 255 }, mark: "[+++]" },
  { color: { r: 1, g: 0x20 / 255, b: 0x20 / 255 }, mark: "[-]" },
];
const RED = 4;

/** What the line says and how: `prefix` then the GlobalStrings value named `globalName`, in `color`. */
export interface FrameXmlSkinnableLine {
  readonly globalName: string;
  readonly prefix: string;
  readonly color: FrameXmlSkinnableColor;
}

export interface FrameXmlSkinnableInput {
  readonly unitFlags: number;
  readonly isPlayer: boolean;
  /** The creature template's `type_flags`. */
  readonly templateFlags: number;
  readonly unitLevel: number;
  /** The player's skill in the body's profession; undefined when no spell of that kind is known. */
  readonly playerSkill: number | undefined;
  readonly colorblind?: boolean;
}

/** The skill a body of `level` asks for. */
export function frameXmlSkinningRequirement(level: number): number {
  if (level <= 10) return 1;
  if (level < 20) return level * 10 - 100;
  return level * 5;
}

/** The line, or undefined where the client writes none. */
export function frameXmlSkinnableLine(input: FrameXmlSkinnableInput): FrameXmlSkinnableLine | undefined {
  if (input.isPlayer || (input.unitFlags & UNIT_FLAG_SKINNABLE) === 0) return undefined;
  const skill = gatherSkillOf(input.templateFlags);
  const globalName = GLOBAL_NAMES[skill];
  if (input.playerSkill === undefined) return { globalName, prefix: "", color: DIFFICULTY[RED]!.color };
  const value = 1 + 5 * Math.floor(Math.max(0, input.playerSkill) / 5);
  const required = frameXmlSkinningRequirement(input.unitLevel);
  const index = value >= required + 100 ? 0
    : value >= required + 50 ? 1
      : value >= required + 25 ? 2
        : value >= required ? 3
          : RED;
  const difficulty = DIFFICULTY[index]!;
  return { globalName, prefix: input.colorblind === true ? difficulty.mark : "", color: difficulty.color };
}

/**
 * The line for a unit in the world: its flags, level and template, and the player's known
 * gathering spell and skill rank. Undefined for a unit without the flag, and while the creature
 * template is still being queried (no word is guessed).
 */
export function frameXmlUnitSkinnableLine(input: {
  readonly object: WorldObjectState;
  readonly player: WorldObjectState | undefined;
  readonly templateFlags: (entry: number, guid: bigint) => number | undefined;
  readonly knownSpells: readonly Pick<KnownSpell, "id">[];
  readonly spellRow: (spellId: number) => GatherSpellRow | undefined;
  readonly colorblind?: boolean;
}): FrameXmlSkinnableLine | undefined {
  const { object } = input;
  const unitFlags = unitField.flags(object) ?? 0;
  const isPlayer = object.typeId === 4;
  if (isPlayer || object.typeId !== 3 || (unitFlags & UNIT_FLAG_SKINNABLE) === 0) return undefined;
  const entry = object.fields.get(UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset) ?? 0;
  if (entry <= 0) return undefined;
  const templateFlags = input.templateFlags(entry, object.guid);
  if (templateFlags === undefined) return undefined;
  const skill = gatherSkillOf(templateFlags);
  const spellId = gatherSpellFor(input.knownSpells, input.spellRow, skill);
  const rank = spellId === undefined || !input.player ? undefined
    : readSkills(input.player).find((entry) => entry.skillId === SKILL_LINES[skill])?.value;
  return frameXmlSkinnableLine({
    unitFlags,
    isPlayer,
    templateFlags,
    unitLevel: unitField.level(object) ?? 0,
    // A known spell with the skill row not yet in the fields counts as skill 0, not as no spell.
    playerSkill: spellId === undefined ? undefined : rank ?? 0,
    ...(input.colorblind === undefined ? {} : { colorblind: input.colorblind }),
  });
}
