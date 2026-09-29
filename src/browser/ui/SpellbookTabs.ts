import { game } from "../game/Context.js";
import { unit } from "../../world/Fields.js";

/**
 * The spellbook's tab model, apart from the book's DOM.
 *
 * The wire carries no tabs: `SMSG_INITIAL_SPELLS` is a flat id list, and which tab a spell
 * belongs to is entirely `SkillLineAbility` / `SkillLine` data the gateway already serves through
 * `/dbc/talents`. This module is that mapping, DOM-free, so both the native book (`Spellbook.ts`)
 * and the stock FrameXML provider (`framexml/FrameXmlSpellBookTabs.ts`) answer with one model.
 *
 * The model is the original client's: class skill lines are tabs of their own, and everything
 * else — professions, racials, mounts, and spells the realm taught with no `SkillLineAbility` row
 * at all — lives in General. One tab per skill line was what made the strip grow out of hand.
 *
 * One tab is the realm's and not the original's: spells from other classes' ability lines. A TSWoW
 * class has no class line of its own in the stock tables, so everything it borrows from the ten
 * stock classes — the owner's class 13 knows Greater Heal, Fel Armor, Cone of Cold, two totems,
 * Corpse Explosion — used to crowd General, where only everyone's rows (racials, professions,
 * Attack) belong. The owner's ruling (2026-09-28): those spells go to one separate tab, the last.
 */

/** Trinity's private SkillLine for internal/debug abilities (SkillLine.dbc: SKILL_INTERNAL). */
export const SKILL_INTERNAL = 769;

/**
 * `SkillLine` 183, "GENERIC (DND)" in the table and the General tab on the screen.
 *
 * Every character has spells in it — Attack and the other everyone-has-them rows — and the real
 * client always draws it as tab one.
 */
export const SPELLBOOK_GENERAL_TAB = 183;
/** `SkillLineCategory` 7 covers the class ability lines; any other category is a General row. */
const SKILL_CATEGORY_CLASS = 7;
/** `SpellIcon` 2610 is `INV_Misc_Book_09`, the General tab's own picture. */
export const GENERAL_TAB_ICON = 2610;
/**
 * The key of the tab for other classes' spells. Not a `SkillLine` id — those are positive — so it
 * can never collide with a real line in either book's tab maps.
 */
export const SPELLBOOK_OTHER_CLASS_TAB = -7;

export interface SpellbookActorContext {
  classId?: number;
  raceId?: number;
}

export interface SpellbookSkillAbility {
  skillLine: number;
  raceMask: number;
  classMask: number;
  excludeRace?: number;
  excludeClass?: number;
  acquireMethod: number;
  supercededBySpell: number;
}

/** The 3.3.5 acquire methods are the authoritative learn/visibility states. */
export function spellAbilityVisible(ability: SpellbookSkillAbility): boolean {
  return ability.skillLine > 0
    && ability.skillLine !== SKILL_INTERNAL
    && Number.isFinite(ability.acquireMethod)
    && ability.acquireMethod >= 0
    && ability.acquireMethod <= 2;
}

function maskAllows(mask: number, id: number | undefined): boolean {
  if (mask === 0 || mask === -1 || mask === 0xffffffff || id === undefined) return true;
  if (!Number.isInteger(id) || id <= 0 || id > 31) return false;
  return (mask & (1 << (id - 1))) !== 0;
}

/** The class and race of the character whose book is being drawn, from the live world. */
export function spellbookActor(): SpellbookActorContext {
  const world = game.world;
  const selfGuid = world?.state.selfGuid;
  const self = selfGuid === undefined ? undefined : world?.state.objects.get(selfGuid);
  if (!self) return {};
  const classId = unit.classId(self);
  const raceId = unit.race(self);
  return {
    ...(classId === undefined ? {} : { classId }),
    ...(raceId === undefined ? {} : { raceId }),
  };
}

/** Apply the SkillLineAbility class/race masks without using spell names or passive heuristics. */
export function spellAbilityMatchesActor(
  ability: SpellbookSkillAbility,
  actor: SpellbookActorContext,
): boolean {
  if (!spellAbilityVisible(ability)) return false;
  if (!maskAllows(ability.classMask, actor.classId)) return false;
  if (!maskAllows(ability.raceMask, actor.raceId)) return false;
  if (ability.classMask !== 0 && ability.classMask !== -1 && actor.classId !== undefined
    && (ability.classMask & (1 << (actor.classId - 1))) === 0) return false;
  // Exclusion masks are added by the gateway in future-compatible rows; older test fixtures simply
  // omit them, which is the same as zero.  Read them structurally rather than inventing a name
  // list for service spells.
  if ((ability.excludeClass ?? 0) !== 0 && actor.classId !== undefined
    && (ability.excludeClass! & (1 << (actor.classId - 1))) !== 0) return false;
  if ((ability.excludeRace ?? 0) !== 0 && actor.raceId !== undefined
    && (ability.excludeRace! & (1 << (actor.raceId - 1))) !== 0) return false;
  return true;
}

/** The `/dbc/talents` surface the tabs are classified from. */
export interface SpellbookTabData {
  skillOfSpell(id: number): number | undefined;
  spellAbilitiesOf?(id: number): readonly SpellbookSkillAbility[] | undefined;
  skillLine(id: number): { categoryId?: number; name?: string; iconId?: number } | undefined;
  /** The class a class-category line belongs to (TalentClient.skillLineClass); undefined for any other line. */
  skillLineClass?(line: number): number | undefined;
}

/** A line with no category row at all is treated as a class line only when it carries a class mask. */
function isClassCategory(categoryId: number | undefined): boolean {
  return categoryId === undefined || categoryId === 0 || categoryId === SKILL_CATEGORY_CLASS;
}

/**
 * The actor's own class lines among the known spells — the tabs the book draws after General.
 *
 * A line qualifies when at least one `SkillLineAbility` row for a known spell matches the actor,
 * names a real class mask and lives in the class category. That keeps the mount and companion
 * lines (category 7 but maskless), the racial lines, the professions and the custom rows with no
 * category data out of the tab strip.
 */
export function spellbookClassLines(
  data: SpellbookTabData, knownIds: readonly number[], actor: SpellbookActorContext,
): Set<number> {
  const lines = new Set<number>();
  for (const id of knownIds) {
    const rows = data.spellAbilitiesOf?.(id);
    if (rows !== undefined) {
      for (const row of rows) {
        if (!spellAbilityMatchesActor(row, actor)) continue;
        if (!isClassCategory(data.skillLine(row.skillLine)?.categoryId)) continue;
        // A maskless row counts once its line is the actor's own class line: a talent spell's row
        // carries no class mask, and its tree is still the class's tab.
        const ownLine = actor.classId !== undefined && data.skillLineClass?.(row.skillLine) === actor.classId;
        if (!ownLine && (row.classMask === 0 || row.classMask === -1 || row.classMask === 0xffffffff)) continue;
        lines.add(row.skillLine);
      }
      continue;
    }
    // Snapshots from before the complete endpoint carry only the first line per spell. Their class
    // tabs are the lines the category table calls class lines; everything else falls to General.
    const line = data.skillOfSpell(id);
    if (line === undefined || line <= 0 || line === SKILL_INTERNAL) continue;
    if (isClassCategory(data.skillLine(line)?.categoryId)) lines.add(line);
  }
  return lines;
}

/**
 * The tab a known spell belongs to: its own class line, or General for everything else.
 *
 * A profession, a racial, a mount and a spell the realm taught without any `SkillLineAbility` row
 * all land in General — which is what lets an item- or quest-taught spell appear instead of
 * vanishing for having no tab of its own.
 */
export function spellbookTabFor(
  id: number, data: SpellbookTabData, classLines: ReadonlySet<number>, actor: SpellbookActorContext,
): number {
  const rows = data.spellAbilitiesOf?.(id);
  const line = rows !== undefined
    ? rows.find((row) => spellAbilityMatchesActor(row, actor))?.skillLine
    : data.skillOfSpell(id);
  if (line !== undefined && line > 0 && line !== SKILL_INTERNAL && classLines.has(line)) return line;
  return spellbookOtherClassSpell(id, data, actor) ? SPELLBOOK_OTHER_CLASS_TAB : SPELLBOOK_GENERAL_TAB;
}

/**
 * Whether a known spell is another class's ability, by the line `skillLineClass` gives a class.
 * A row that matches the actor decides alone — a maskless talent row, Corpse Explosion's in
 * Unholy, is the DK's all the same, while a general row keeps its spell general whatever other rows
 * it has. With no matching row (Greater Heal's is the priest's, masked 0x10), any visible row in
 * another class's line makes it that class's spell. Unknown until the actor's class is known.
 */
export function spellbookOtherClassSpell(id: number, data: SpellbookTabData, actor: SpellbookActorContext): boolean {
  const classOf = data.skillLineClass;
  const classId = actor.classId;
  if (classId === undefined || classOf === undefined) return false;
  const foreign = (line: number | undefined): boolean => {
    if (line === undefined || line <= 0 || line === SKILL_INTERNAL) return false;
    const owner = classOf.call(data, line);
    return owner !== undefined && owner !== classId;
  };
  const rows = data.spellAbilitiesOf?.(id);
  if (rows === undefined) return foreign(data.skillOfSpell(id));
  const own = rows.find((row) => spellAbilityMatchesActor(row, actor));
  if (own) return foreign(own.skillLine);
  return rows.some((row) => spellAbilityVisible(row) && foreign(row.skillLine));
}

/**
 * The other classes' tab's label: the character's own class name when its class has no class line
 * of its own — a TSWoW class, whose whole kit is borrowed, reads «Герой» — and «Другие классы»
 * beside a stock class's own trees, where the class name would say the opposite of what is in it.
 */
export function spellbookOtherClassTabName(actorClassName: string | undefined, hasOwnClassLines: boolean): string {
  return !hasOwnClassLines && actorClassName ? actorClassName : "Другие классы";
}

/** The live classifier both books use, or undefined until `/dbc/talents` has landed. */
export function liveSpellbookTabs(): { data: SpellbookTabData; actor: SpellbookActorContext } | undefined {
  const talents = game.talentData;
  if (!talents?.ready) return undefined;
  return {
    data: {
      skillOfSpell: (id) => talents.skillOfSpell(id),
      spellAbilitiesOf: (id) => talents.spellAbilitiesOf?.(id),
      skillLine: (id) => talents.skillLine(id),
      skillLineClass: (line) => talents.skillLineClass?.(line),
    },
    actor: spellbookActor(),
  };
}
