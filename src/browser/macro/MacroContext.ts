/**
 * The world behind macro conditions: one builder, {@link createMacroContext}, for the stock
 * interface and the native one.
 *
 * A source hands in what it already answers and the builder reads the rest from the world. The stock
 * seams hand in their own unit, group and bar methods ({@link frameXmlSeamMacroSource}), so
 * `[dead]`, `[harm]` or `[bonusbar:1]` agree with what `UnitIsDead`, `UnitCanAttack` and
 * `GetBonusBarOffset` tell the stock UI; the native commands hand in the world, a unit resolver and
 * the faction reaction (CombatCommands.ts). What the world answers directly, as Wow.exe 12340's
 * handlers read it (0x5ef040-0x5efeb0):
 *
 * - `combat` — `UNIT_FLAG_IN_COMBAT` on the player or on the pet (0x5ef710).
 * - `mounted` — UNIT_FIELD_MOUNTDISPLAYID is not zero.
 * - `swimming`, `flying` — MOVEMENTFLAG_SWIMMING (0x00200000) and MOVEMENTFLAG_FLYING (0x02000000) of
 *   the last movement the player sent or received (UnitDefines.h:292, :296).
 * - `stealth` — UNIT_VIS_FLAGS_CREEP, byte 2 of UNIT_FIELD_BYTES_1, which the core sets and clears
 *   only in `AuraEffect::HandleModStealth` (SpellAuraEffects.cpp:1481, :1493), the bit 0x5efb70 reads.
 * - `spec` — the talent packet's active group, 1-based; 0 until the packet arrives.
 * - `channeling` — the player's cast of the channel kind, by its spell row's name.
 * - `stance` — `GetShapeshiftForm(true)` (0x53d4b0): 0 while byte 3 of UNIT_FIELD_BYTES_2 is 0 — a
 *   paladin aura or a death knight presence is on the stance bar but is no form — else the 1-based
 *   stance bar slot of that form, or one past the last for a form the bar does not show.
 * - `pet` — the pet's name and its CreatureFamily name (0x5efbd0).
 * - `equipped`/`worn` — an equipped item (the player's visible item entries) whose item class or
 *   subclass has that name, in the names AuctionUI shows (FrameXmlAuction.ts).
 * - `mod` — `IsModifiedClick` (0x55f940): keys joined with `-`, all held, else the keys of a
 *   modified-click action (SELFCAST is ALT); `btn` — the button the running macro was started with.
 *
 * What nobody answers yet, and so answers «no» until a source does: `flyable`, `indoors` (AreaTable
 * and WMO flags this client does not read — so `outdoors`, its opposite, answers yes),
 * `vehicleui`/`unithasvehicleui` (vehicles, line A9) and `cursor`. Those answers are stand-ins, not
 * facts about the player. Modified clicks are the client's defaults: a session's `SetModifiedClick`
 * lives in the Lua table (FrameXmlNeutralApi.ts) and is not read here.
 */

import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import { REACTION_FRIENDLY, UNIT_FLAG_IN_COMBAT } from "../../world/FactionRules.js";
import { isPlayerGhost, unit as unitField, UNIT_VIS_FLAG_CREEP } from "../../world/Fields.js";
import { MOVEMENT_FLAGS } from "../../world/MovementProtocol.js";
import type { KnownSpell } from "../../world/SpellProtocol.js";
import { isWorldObjectDead, type WorldObjectState } from "../../world/WorldState.js";
import type { SpellSkillAbilityInfo } from "../../gateway/TalentMetadata.js";
import type { SpellMetadata } from "../SpellMetadata.js";
import { FRAMEXML_AUCTION_CLASSES } from "../framexml/FrameXmlAuction.js";
import { FRAMEXML_MODIFIED_CLICK_DEFAULTS } from "../framexml/FrameXmlNeutralApi.js";
import { frameXmlShapeshiftForms, type FrameXmlShapeshiftForm } from "../framexml/FrameXmlShapeshiftForms.js";
import type { FrameXmlWorldSeam } from "../framexml/FrameXmlWorldSeam.js";
import { pageModifiers, type ModifierSource, type ModifierState } from "../input/Modifiers.js";
import type { MacroContext, MacroPet } from "./MacroOptions.js";
import { macroRunButton } from "./MacroRunner.js";

/** `GROUPTYPE_RAID` (Group.h). */
const GROUPTYPE_RAID = 0x02;
/** The player's nineteen visible equipment entries, two fields apart. */
const VISIBLE_ITEM = UPDATE_FIELDS.PLAYER_VISIBLE_ITEM_1_ENTRYID.offset;
const VISIBLE_ITEMS = 19;

/** The part of `WorldClient` the world-read answers use. */
export interface MacroWorld {
  readonly state: {
    readonly selfGuid: bigint | undefined;
    readonly objects: ReadonlyMap<bigint, WorldObjectState>;
  };
  readonly group?: { readonly groupType: number; readonly members: readonly { readonly guid: bigint }[] } | undefined;
  readonly casts?: ReadonlyMap<bigint, { readonly spellId: number; readonly channel: boolean }>;
  readonly talents?: { readonly activeSpec: number } | undefined;
  readonly petSpells?: { readonly guid: bigint; readonly creatureFamily?: number } | undefined;
  readonly knownSpells?: readonly KnownSpell[];
  readonly names?: { get(guid: bigint): string | undefined };
  readonly itemTemplates?: ReadonlyMap<number, { readonly found: boolean; readonly itemClass: number; readonly subClass: number }>;
  aurasFor?(guid: bigint): readonly { readonly spellId: number; readonly casterGuid?: bigint | undefined }[];
}

/** What a caller hands {@link createMacroContext}: its own answers, and what the rest is read from. */
export interface MacroContextSource extends MacroContext {
  /** The world the player is in. */
  world?(): MacroWorld | undefined;
  /** A lower-case unit token to its GUID in {@link world}. */
  unitGuid?(unit: string): bigint | undefined;
  /** The faction reaction of `self` to `other`: -1 hostile, 0 neutral, 1 friendly (FactionRules.ts). */
  reaction?(self: WorldObjectState | undefined, other: WorldObjectState): number | undefined;
  /** Resolved spell rows: a channel's name, the stance bar's forms. */
  spell?(id: number): SpellMetadata | undefined;
  spellAbilities?(id: number): readonly Pick<SpellSkillAbilityInfo, "supercededBySpell">[] | undefined;
  /** The stance bar's forms, when the source already builds them; else they are built from the world. */
  shapeshiftForms?(): readonly FrameXmlShapeshiftForm[];
  /** A number that changes as spell rows resolve: with the learned spells and the form, the memo key. */
  spellRevision?(): number | undefined;
  /** CreatureFamily.dbc's name of a family id. */
  familyName?(family: number): string | undefined;
  /** The held keys; the page's own tracker when absent. */
  readonly modifiers?: ModifierSource;
}

// ---- mod: IsModifiedClick -------------------------------------------------------------------------

/** The key names a binding is made of (0x55d860, compared case-insensitively), as bits. */
const MODIFIER_TOKENS: readonly (readonly [token: string, bits: number])[] = [
  ["LSHIFT", 1], ["RSHIFT", 2], ["SHIFT", 3], ["LCTRL", 4], ["RCTRL", 8], ["CTRL", 12],
  ["LALT", 16], ["RALT", 32], ["ALT", 48],
];
const MODIFIER_KEYS: readonly (keyof ModifierState)[] = ["LSHIFT", "RSHIFT", "LCTRL", "RCTRL", "LALT", "RALT"];
const MODIFIED_CLICKS: ReadonlyMap<string, string> = new Map(
  FRAMEXML_MODIFIED_CLICK_DEFAULTS.map(([action, binding]) => [action.toUpperCase(), binding]),
);

/** The keys of `text` (`ALT-SHIFT`, `LCTRL` …): each known token, `-` between, up to the first unknown one. */
function modifierMask(text: string): number {
  let rest = text.toUpperCase();
  let mask = 0;
  for (;;) {
    const token = MODIFIER_TOKENS.find(([name]) => rest.startsWith(name));
    if (!token) return mask;
    mask |= token[1];
    rest = rest.slice(token[0].length);
    if (rest.startsWith("-")) rest = rest.slice(1);
  }
}

/** `IsModifiedClick(key)` as `[mod:key]` reads it; without a key, any modifier held. */
export function modifiedClickHeld(held: ModifierState, key: string | undefined): boolean {
  if (key === undefined) return MODIFIER_KEYS.some((name) => held[name]);
  const mask = modifierMask(key);
  if (mask !== 0) {
    // Every key group named must be held; a group named by both sides is either side.
    for (let group = 0; group < 3; group += 1) {
      const bits = (mask >> (group * 2)) & 3;
      if (bits === 0) continue;
      const left = held[MODIFIER_KEYS[group * 2]!];
      const right = held[MODIFIER_KEYS[group * 2 + 1]!];
      if (!(bits === 1 ? left : bits === 2 ? right : left || right)) return false;
    }
    return true;
  }
  // A modified-click action: any key of its binding (0x55d6b0). NONE has none.
  const binding = MODIFIED_CLICKS.get(key.toUpperCase());
  const actionMask = binding === undefined ? 0 : modifierMask(binding);
  for (let bit = 0; bit < MODIFIER_KEYS.length; bit += 1) {
    if ((actionMask & (1 << bit)) !== 0 && held[MODIFIER_KEYS[bit]!]) return true;
  }
  return false;
}

// ---- stance and the form memo --------------------------------------------------------------------

/**
 * `GetShapeshiftForm(true)` (0x53d4b0) over the stance bar's `forms`: 0 while the player's form byte
 * is 0, else the slot of the form with that id, or one past the last when the bar does not show it.
 */
export function shapeshiftStance(
  self: WorldObjectState | undefined,
  forms: readonly Pick<FrameXmlShapeshiftForm, "formId">[],
): number {
  const form = self ? unitField.shapeshiftForm(self) ?? 0 : 0;
  if (form === 0) return 0;
  for (let index = forms.length - 1; index >= 0; index -= 1) if (forms[index]!.formId === form) return index + 1;
  return forms.length + 1;
}

function selfOf(world: MacroWorld | undefined): WorldObjectState | undefined {
  const guid = world?.state.selfGuid;
  return guid === undefined ? undefined : world?.state.objects.get(guid);
}

/**
 * Remember a lookup that walks the learned spells — the stance bar's forms, the bonus bar — until
 * the world, its learned spells, the player's form byte or the spell rows (`revision`) change: the key
 * `currentBonusBarOffset` uses (game/BonusBar.ts). A walk costs 72–176 µs with 1 500–4 000 learned
 * spells, and the state driver asks five times a second for every driver registered.
 */
export function macroFormMemo(
  world: () => MacroWorld | undefined,
  revision?: () => number | undefined,
): <T>(compute: () => T) => () => T {
  return <T>(compute: () => T) => {
    let cached: { world: MacroWorld | undefined; known: unknown; form: number; rows: number | undefined; value: T }
      | undefined;
    return () => {
      const current = world();
      const self = selfOf(current);
      const known = current?.knownSpells;
      const form = self ? unitField.shapeshiftForm(self) ?? 0 : 0;
      const rows = revision?.();
      if (cached && cached.world === current && cached.known === known && cached.form === form && cached.rows === rows) {
        return cached.value;
      }
      const value = compute();
      cached = { world: current, known, form, rows, value };
      return value;
    };
  };
}

// ---- equipped ------------------------------------------------------------------------------------

/** Item class and subclass names by `class` and `class:subclass`, as AuctionUI names them. */
const ITEM_TYPE_NAMES: ReadonlyMap<string, string> = new Map(FRAMEXML_AUCTION_CLASSES.flatMap((itemClass) => [
  [String(itemClass.id), itemClass.name] as const,
  ...itemClass.subclasses.map((sub) => [`${itemClass.id}:${sub.id}`, sub.name] as const),
]));

function equippedAs(world: MacroWorld | undefined, self: WorldObjectState | undefined, type: string): boolean {
  if (!world || !self) return false;
  const wanted = type.toLowerCase();
  for (let slot = 0; slot < VISIBLE_ITEMS; slot += 1) {
    const entry = self.fields.get(VISIBLE_ITEM + slot * 2);
    const template = entry ? world.itemTemplates?.get(entry) : undefined;
    if (!template?.found) continue;
    const names = [ITEM_TYPE_NAMES.get(String(template.itemClass)), ITEM_TYPE_NAMES.get(`${template.itemClass}:${template.subClass}`)];
    if (names.some((name) => name !== undefined && name.toLowerCase() === wanted)) return true;
  }
  return false;
}

// ---- the builder ---------------------------------------------------------------------------------

function inCombat(object: WorldObjectState | undefined): boolean {
  return object !== undefined && ((unitField.flags(object) ?? 0) & UNIT_FLAG_IN_COMBAT) !== 0;
}

/**
 * A macro context over `source`: each answer is the source's own when it has one, else read from
 * its world, else «no». The context reads everything at the moment it is asked, so one context
 * serves for the life of its source.
 */
export function createMacroContext(source: MacroContextSource): MacroContext {
  const modifiers = source.modifiers ?? pageModifiers();
  const world = (): MacroWorld | undefined => source.world?.();
  const self = (): WorldObjectState | undefined => selfOf(world());
  const guidOf = (unit: string): bigint | undefined => {
    const guid = source.unitGuid?.(unit);
    return guid === undefined || guid === 0n ? undefined : guid;
  };
  const unitObject = (unit: string): WorldObjectState | undefined => {
    const guid = guidOf(unit);
    const object = guid === undefined ? undefined : world()?.state.objects.get(guid);
    return object && (object.typeId === 3 || object.typeId === 4) ? object : undefined;
  };
  const pet = (): WorldObjectState | undefined => {
    const current = world();
    const guid = current?.petSpells?.guid;
    return guid === undefined || guid === 0n ? undefined : current?.state.objects.get(guid);
  };
  const reaction = (unit: string): number | undefined => {
    const other = unitObject(unit);
    if (!other) return undefined;
    const me = self();
    return me !== undefined && me.guid === other.guid ? REACTION_FRIENDLY : source.reaction?.(me, other);
  };
  const party = (unit: string): boolean => {
    const current = world();
    const group = current?.group;
    const guid = guidOf(unit);
    return group !== undefined && guid !== undefined && guid !== current?.state.selfGuid
      && group.members.some((member) => member.guid === guid);
  };
  const raid = (unit: string): boolean => {
    const current = world();
    const group = current?.group;
    const guid = guidOf(unit);
    if (party(unit)) return true;
    if (!group || guid === undefined || (group.groupType & GROUPTYPE_RAID) === 0) return false;
    return guid === current?.state.selfGuid || group.members.some((member) => member.guid === guid);
  };
  const moving = (flag: number): boolean => ((self()?.movementFlags ?? 0) & flag) !== 0;
  const memo = macroFormMemo(world, () => source.spellRevision?.());
  const forms = (): readonly FrameXmlShapeshiftForm[] => {
    if (source.shapeshiftForms) return source.shapeshiftForms();
    const current = world();
    if (!current || !source.spell) return [];
    return frameXmlShapeshiftForms(current.knownSpells ?? [], (id) => source.spell?.(id),
      source.spellAbilities ? (id) => source.spellAbilities?.(id) : undefined);
  };
  const stance = source.stance ? () => source.stance!() : memo(() => shapeshiftStance(self(), forms()));
  const indoors = (): boolean => (source.indoors ? source.indoors() : source.outdoors ? !source.outdoors() : false);
  return {
    modifier: (key?: string) => (source.modifier ? source.modifier(key) : modifiedClickHeld(modifiers.state(), key)),
    button: () => (source.button ? source.button() : macroRunButton()),
    combat: () => (source.combat ? source.combat() : inCombat(self()) || inCombat(pet())),
    exists: (unit) => (source.exists ? source.exists(unit) : unitObject(unit) !== undefined),
    dead: (unit) => {
      if (source.dead) return source.dead(unit);
      const object = unitObject(unit);
      return object !== undefined && (isWorldObjectDead(object) || isPlayerGhost(object));
    },
    harm: (unit) => {
      if (source.harm) return source.harm(unit);
      const relation = reaction(unit);
      return relation !== undefined && relation !== REACTION_FRIENDLY;
    },
    help: (unit) => (source.help ? source.help(unit) : reaction(unit) === REACTION_FRIENDLY),
    inParty: (unit) => (source.inParty ? source.inParty(unit) : party(unit)),
    inRaid: (unit) => (source.inRaid ? source.inRaid(unit) : raid(unit)),
    group: () => {
      if (source.group) return source.group();
      const group = world()?.group;
      if (!group) return undefined;
      if ((group.groupType & GROUPTYPE_RAID) !== 0) return "raid";
      return group.members.length > 0 ? "party" : undefined;
    },
    stance,
    // The source's own: the native bar's offset is remembered where it is read (game/BonusBar.ts), the
    // live seam's by the seam (LiveWorldSeam.macroContext), which know what it depends on.
    bonusBar: () => source.bonusBar?.() ?? 0,
    actionBar: () => source.actionBar?.() ?? 0,
    spec: () => {
      if (source.spec) return source.spec();
      const talents = world()?.talents;
      return talents ? talents.activeSpec + 1 : 0;
    },
    channeling: () => {
      if (source.channeling) return source.channeling();
      const current = world();
      const guid = current?.state.selfGuid;
      const cast = guid === undefined ? undefined : current?.casts?.get(guid);
      return cast?.channel ? source.spell?.(cast.spellId)?.name ?? "" : undefined;
    },
    pet: (): MacroPet | undefined => {
      if (source.pet) return source.pet();
      const current = world();
      const pets = current?.petSpells;
      if (!pets || pets.guid === 0n) return undefined;
      const family = pets.creatureFamily;
      return {
        name: current?.names?.get(pets.guid),
        family: family === undefined || family <= 0 ? undefined : source.familyName?.(family),
      };
    },
    mounted: () => {
      if (source.mounted) return source.mounted();
      const me = self();
      return me !== undefined && (unitField.mountDisplayId(me) ?? 0) > 0;
    },
    swimming: () => (source.swimming ? source.swimming() : moving(MOVEMENT_FLAGS.swimming)),
    flying: () => (source.flying ? source.flying() : moving(MOVEMENT_FLAGS.flying)),
    stealth: () => {
      if (source.stealth) return source.stealth();
      const me = self();
      return me !== undefined && ((unitField.visFlags(me) ?? 0) & UNIT_VIS_FLAG_CREEP) !== 0;
    },
    equipped: (type) => (source.equipped ? source.equipped(type) : equippedAs(world(), self(), type)),
    // No data in this client yet: «no» unless a source knows better, and outdoors is indoors' opposite.
    flyable: () => source.flyable?.() ?? false,
    indoors,
    outdoors: () => !indoors(),
    vehicleUi: () => source.vehicleUi?.() ?? false,
    unitHasVehicleUi: (unit) => source.unitHasVehicleUi?.(unit) ?? false,
    cursor: () => source.cursor?.() ?? false,
  };
}

/** The seam methods a macro context reads: the stock interface's own answers to the same questions. */
export type MacroSeam = Pick<FrameXmlWorldSeam,
  | "unitExists" | "unitIsDead" | "unitIsGhost" | "unitIsFriend" | "unitCanAttack" | "unitIsUnit"
  | "inCombatLockdown" | "unitAffectingCombat" | "unitInParty" | "unitInRaid" | "partyMemberCount"
  | "raidMemberCount" | "bonusBarOffset" | "actionBarPage" | "unitChannelInfo" | "unitName"
  | "talentSnapshot" | "stable">;

/**
 * A seam's answers as a {@link MacroContextSource}: `[harm]` is `UnitCanAttack("player", unit)`,
 * `[help]` `UnitCanAssist`'s friendly reaction, `[dead]` `UnitIsDeadOrGhost`, `[combat]` the player's
 * or the pet's `UnitAffectingCombat`, `[bonusbar]` `GetBonusBarOffset`, `[actionbar]`
 * `GetActionBarPage`, `[channeling]` `UnitChannelInfo("player")`, `[spec]` `GetActiveTalentGroup`,
 * `[pet]` the pet unit's name and `UnitCreatureFamily`. `[stance]` needs the form byte, which no
 * public seam method gives: a seam with a world passes its forms and world instead (LiveWorldSeam).
 */
export function frameXmlSeamMacroSource(seam: MacroSeam): MacroContextSource {
  const party = (unit: string): boolean => (seam.unitInParty?.(unit) ?? false) && !seam.unitIsUnit(unit, "player");
  return {
    combat: () => (seam.inCombatLockdown?.() ?? false) || (seam.unitAffectingCombat?.("pet") ?? false),
    exists: (unit) => seam.unitExists(unit),
    dead: (unit) => seam.unitIsDead(unit) || seam.unitIsGhost(unit),
    harm: (unit) => seam.unitCanAttack("player", unit),
    help: (unit) => seam.unitIsFriend("player", unit),
    inParty: party,
    inRaid: (unit) => party(unit) || seam.unitInRaid?.(unit) !== undefined,
    group: () => (seam.raidMemberCount() > 0 ? "raid" : seam.partyMemberCount() > 0 ? "party" : undefined),
    bonusBar: () => seam.bonusBarOffset(),
    actionBar: () => seam.actionBarPage(),
    spec: () => seam.talentSnapshot()?.activeTalentGroup ?? 0,
    channeling: () => seam.unitChannelInfo("player")?.[0],
    pet: () => (seam.unitExists("pet") ? { name: seam.unitName("pet"), family: seam.stable?.petFamilyName() } : undefined),
  };
}
