/**
 * The published game-state view a window expression reads, assembled once per frame.
 *
 * Every binding in a module window — the studio's twelve named ones and every `{…}` an author
 * writes — is an expression over one object, and this is where that object comes from. Three
 * properties are the whole point:
 *
 * * **One snapshot per tick, frozen.** The bindings of every live window are evaluated against the
 *   *same* object, taken once on the `drainWorldState` tick the rest of the interface already
 *   coalesces onto (`WorldView.ts`). A window whose bar reads `player.health` and whose label
 *   reads `fmt(player.health)` cannot show two different numbers, and a value cannot change
 *   between two widgets of the same frame. Frozen because that promise is worth an assertion:
 *   nothing downstream may write into the view, and `Object.freeze` makes an attempt fail rather
 *   than quietly rewrite what the next widget will read.
 * * **A path nobody publishes is `undefined`, never an error.** A window written against next
 *   month's view has to degrade to blanks. `WindowExpression` never throws on a missing path and
 *   `formatExpressionValue` never writes "undefined" to the screen, so an absent root costs an
 *   empty label and nothing else.
 * * **Only the roots somebody reads are built.** The view is fourteen roots deep and several of
 *   them are lists: a raid of forty, five bags of thirty-six, the quest log, the aura strip. A
 *   client whose one module window shows the clock must not pay for any of that sixty times a
 *   second, so {@link WindowSnapshotSources} takes the expensive roots as *suppliers* and
 *   {@link buildWindowSnapshot} calls only the ones `roots` names. The renderer collects that set
 *   from the expressions it actually evaluates (`WindowRender.ts`), so it cannot fall behind a
 *   binding: if a window reads a root, the pass that reads it registered it.
 *
 *   That has one hard requirement, and it was broken once: the set has to be *finished* when the
 *   window is registered, because `WindowRegistry` unions the sets then. A `repeat`'s rows are
 *   copies of a template, and a template built on the first non-empty list added its roots to a
 *   set the snapshot builder had already been handed — so `{aura[0].name}` inside a repeated row
 *   read blank for the whole session with its supplier never called. `buildRepeat` builds one row
 *   while it builds the window, and says so where it does it.
 *
 *   Gating rather than lazy properties, and the reason is one line in the renderer: `update` builds
 *   its scope as `{ ...snapshot, state }`, and spreading an object *reads* every accessor on it —
 *   so a lazy top-level root would be materialised by the very copy that was meant to skip it.
 *   Accessors are safe one level down, which is where `player.buff` and `player.debuff` are.
 *
 * ## What the view publishes
 *
 * * `player.` `exists guid name level health maxHealth power maxPower powerType powerScale race
 *   class gender displayId xp maxXp money dead combat mounted shapeshiftForm resting x y z o
 *   buff[имя] debuff[имя]` — `power`/`maxPower` are divided by `powerScale` before they are
 *   published, so they read as the HUD reads them.
 * * `target.` the same unit fields plus `hostile friendly`; `focus.` and `pet.` the unit fields.
 * * `party[i]` `raid[i]` `boss[i]` `arena[i]` — the unit fields plus `online away inGrid raidMark
 *   subGroup`. `party` leaves the player out and `raid` puts them in, exactly as `party1..4` and
 *   `raid1..40` do in the original client.
 * * `bag[b].slot[s].` `itemId count icon quality name guid bag index` — `bag[0]` is the backpack.
 * * `quest[i].` `id title complete failed timer objectives[].{text have need done}`
 * * `aura[i].` `spellId name icon stacks remaining harmful`
 * * `msg.<имя>.<поле>` — the last value each declared message decoded to.
 * * `setting.<id>` — the options the settings window writes.
 * * `world.` `zone subzone clock inGroup inRaid inInstance mapId fps`
 *
 * `state.<key>` is not here at all: it belongs to one window, and `WindowRender` folds each
 * window's own state into the scope as it updates.
 */

import {
  PLAYER_FLAGS_GHOST,
  POWER_COUNT, POWER_DISPLAY_SCALE, player as playerFields, readField, unit,
  type UnitAuraAppearance,
} from "../../world/Fields.js";
import { GROUPTYPE_RAID } from "../../world/GroupProtocol.js";
import { REACTION_FRIENDLY, REACTION_HOSTILE } from "../../world/FactionRules.js";
import { formatGameTime } from "../../world/GameTimeProtocol.js";
import { buildCarriedItemCounts, buildQuestLogView, questObjectiveLabel } from "../../world/QuestProtocol.js";
import type { WorldObjectState } from "../../world/WorldState.js";
import type { WorldClient } from "../../world/WorldClient.js";
import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import { entryOf, playerInventory, stackCount, type ItemSlotState } from "../Inventory.js";
import { game } from "../game/Context.js";
import { reactionTo } from "../game/Targeting.js";
import { allMembers } from "./GroupModel.js";
import { SETTING_DEFINITIONS, type SettingValues } from "./SettingsModel.js";
import { unitSnapshot, type UnitSnapshot } from "./UnitSnapshot.js";
import { arenaOpponentGuids, engagedBossGuids } from "../game/Encounters.js";
import type { ExpressionScope } from "./WindowExpression.js";
import { WINDOW_STATE_ROOTS } from "./WindowSchema.js";
import { patchRegistry, windowRegistry } from "./WindowRegistry.js";
import { liveAreaIdAt } from "../AreaLocatorLive.js"; // 05.10-A7b-4

/**
 * `UNIT_FLAG_IN_COMBAT`, `UnitDefines.h:154`. The only thing on the wire that says "in combat".
 */
export const UNIT_FLAG_IN_COMBAT = 0x0008_0000;
/**
 * `PLAYER_FLAGS_GHOST`, `Player.h:354`, re-exported so this block still names every player bit the
 * interface reads.
 *
 * The definition moved to `world/Fields.ts` when the renderer gained a second reader for it: it
 * draws *other* players' ghosts translucent, and the renderer cannot import this module — one line
 * of it reaches `game/Context.js` and the window registries, and the renderer is imported by node
 * tests with no DOM at all. Re-exporting rather than redeclaring keeps `DeathScreenEffect`'s import
 * path and its test working against exactly one definition of the bit.
 */
export { PLAYER_FLAGS_GHOST };
/**
 * `PLAYER_FLAGS_RESTING`, `Player.h:355` — and it is `0x20`, not `0x10`.
 *
 * `0x10` next to it is `PLAYER_FLAGS_GHOST` (`:354`), so the off-by-one-bit reading of this field
 * makes «отдыхает» mean «мёртв»: an inn condition would fire in a graveyard and nowhere else.
 */
export const PLAYER_FLAGS_RESTING = 0x0000_0020;

/** `AURA_FLAGS.negative`: the bit the aura strip already reads to pick the red border. */
const AURA_FLAG_NEGATIVE = 0x80;

/**
 * `SPELL_AURA_MOD_STEALTH` and `SPELL_AURA_MOD_INVISIBILITY` in `SpellAuraDefines.h`.
 *
 * Declared here rather than in `SpellMetadata.ts` for the same reason `Tracking.ts` declares its
 * three: the number means nothing to the metadata client, and the one place that asks what an aura
 * *does* is the reader that acts on it.
 */
const SPELL_AURA_MOD_STEALTH = 16;
const SPELL_AURA_MOD_INVISIBILITY = 18;

/**
 * The see-through auras on one unit, out of the metadata the interface has already loaded.
 *
 * This is the *fallback* half of `unitAppearance` and not its authority — `UNIT_FIELD_BYTES_1`
 * byte 2 is, and it wins wherever it arrives. What this covers is the gap the byte leaves: the
 * viewer's own character, whose stealth aura is in `world.auras` from the moment the cast lands
 * while its own `BYTES_1` update may be a round trip behind or, on some builds, never sent.
 *
 * Metadata is what makes the answer possible and also what delays it: `game.spells` is filled by
 * `loadAuraMetadata`, so a spell nobody has ever seen is unknown for one gateway round trip.
 * That is not a hole, because `loadAuraMetadata` re-runs `showAuras` when the batch lands and the
 * whole map is pushed again — the same batch-boundary refresh `syncMountSpellIds` relies on.
 */
export function unitAppearanceAuras(guid: bigint): UnitAuraAppearance {
  const auras = game.world?.auras.get(guid);
  const appearance: UnitAuraAppearance = { stealth: false, invisibility: false };
  if (!auras) return appearance;
  for (const aura of auras.values()) {
    const effectAura = game.spells.get(aura.spellId)?.effectAura;
    if (!Array.isArray(effectAura)) continue;
    if (effectAura.includes(SPELL_AURA_MOD_STEALTH)) appearance.stealth = true;
    if (effectAura.includes(SPELL_AURA_MOD_INVISIBILITY)) appearance.invisibility = true;
  }
  return appearance;
}

/**
 * Every unit the client currently holds auras for, for the renderer's per-unit appearance.
 *
 * Only the units that carry one of the two auras are in the map: the renderer's own default is
 * "as authored", and a map with an entry per aura-bearing unit in view costs less than one per
 * unit in the world. Pushed rather than pulled, exactly as `setStateVisuals` is, because the
 * renderer must stay free of the DOM application's context object.
 */
export function unitAuraAppearances(): Map<bigint, UnitAuraAppearance> {
  const byGuid = new Map<bigint, UnitAuraAppearance>();
  const world = game.world;
  if (!world) return byGuid;
  for (const guid of world.auras.keys()) {
    const appearance = unitAppearanceAuras(guid);
    if (appearance.stealth || appearance.invisibility) byGuid.set(guid, appearance);
  }
  return byGuid;
}

/** Every root the view can publish. What a caller that wants the whole thing passes. */
export const ALL_WINDOW_ROOTS: ReadonlySet<string> = new Set(WINDOW_STATE_ROOTS);

/** A root that is only assembled when a window reads it. */
export type WindowViewSupplier<T> = () => T;

/** One unit as an expression sees it. Every field may be `undefined`: the server sends in pieces. */
export interface WindowUnitView {
  readonly exists: boolean;
  /**
   * The guid as decimal text, not as a `bigint`.
   *
   * A `bigint` would be poison in this view: `compare` refuses to order it against a number, and
   * `formatExpressionValue` has no case for it and would print an empty string. Text compares with
   * `==` — which is what a window ever does with a guid — and prints as itself.
   */
  readonly guid: string;
  readonly name: string;
  readonly level: number | undefined;
  readonly health: number | undefined;
  readonly maxHealth: number | undefined;
  /**
   * The resource as the player reads it, already divided by {@link WindowUnitView.powerScale}.
   *
   * Rage and runic power arrive from the server at ten times what any interface shows — a warrior
   * at 57 rage sends 570 — and `Frames.ts:186` divides before it prints. The studio's own
   * `playerPower` binding is `fmt(player.power) + " / " + fmt(player.maxPower)` and has nowhere to
   * put a division, so publishing the wire pair here would write «570 / 1000» into a module window
   * standing beside a HUD reading 57/100. The scale is published next to it, so a widget that
   * genuinely wants the wire number multiplies back.
   */
  readonly power: number | undefined;
  readonly maxPower: number | undefined;
  readonly powerType: number | undefined;
  readonly powerScale: number;
  readonly race: number | undefined;
  readonly class: number | undefined;
  readonly gender: number | undefined;
  readonly displayId: number | undefined;
  readonly dead: boolean;
  readonly combat: boolean;
  readonly mounted: boolean;
  /**
   * `UNIT_FIELD_BYTES_2` byte 3: which shape the unit is in, or 0 for its own.
   *
   * Published beside `mounted` and for the same reason — a module window asking «is this druid a
   * bear» had no way to find out, and `Fields.unit.shapeshiftForm` was read by nobody at all.
   * `displayId` is not that answer: it moves for a polymorph, a transform aura and a costume too,
   * and the cat form alone is ten display ids for one form — five night-elf ones chosen by hair
   * colour and five tauren ones by skin colour (`Unit::GetModelForForm`, `Unit.cpp:13268-13652`,
   * whose hardcoded block ends at `:13629`). The numbers are the core's `ShapeshiftForm`
   * (`SpellAuraDefines.h:409-439`), and this is the whole druid set read off that enum rather than
   * from memory: 1 cat, 2 tree, 3 travel, 4 aquatic, 5 bear, 8 dire bear, 16 ghost wolf,
   * 27 flight (epic), 29 flight, 31 moonkin. The five that are easy to guess wrong are all real
   * forms, so a window written against a wrong number shows the wrong shape rather than nothing.
   */
  readonly shapeshiftForm: number | undefined;
}

/** One aura on the player, as `aura[i]` and as `player.buff[имя]`. */
export interface WindowAuraView {
  readonly spellId: number;
  /** The spell's name, when the metadata client has it. Empty until it lands. */
  readonly name: string;
  /** The icon id, which an `ItemButton` widget turns into `/icons/<id>.png` on its own. */
  readonly icon: number;
  readonly stacks: number;
  /** Seconds left, or `undefined` for an aura with no duration. */
  readonly remaining: number | undefined;
  readonly harmful: boolean;
}

export interface WindowPlayerView extends WindowUnitView {
  readonly xp: number | undefined;
  readonly maxXp: number | undefined;
  readonly money: number | undefined;
  readonly resting: boolean;
  readonly x: number | undefined;
  readonly y: number | undefined;
  readonly z: number | undefined;
  /** Facing in radians, as the movement packets carry it. */
  readonly o: number | undefined;
  /**
   * The player's own buffs by *name*, which is what the `hasBuff` condition asks about.
   *
   * An accessor rather than a field: the grammar has no `find` and no `any`, so the only spelling
   * of «is there an aura called X on me» is a lookup by key, and building the map costs a pass over
   * the aura list plus a spell-metadata lookup each. A window with no `hasBuff` condition must not
   * pay for that every frame, and one level below the root the copy `WindowRender.update` makes
   * cannot reach it.
   */
  readonly buff: Readonly<Record<string, WindowAuraView>>;
  readonly debuff: Readonly<Record<string, WindowAuraView>>;
}

export interface WindowTargetView extends WindowUnitView {
  readonly hostile: boolean;
  readonly friendly: boolean;
}

/**
 * A unit in a group, a raid, a boss list or an arena.
 *
 * Wider than {@link WindowUnitView} by exactly what a group knows and an object does not: half a
 * raid is out of the client's grid entirely and reaches the screen through
 * `SMSG_PARTY_MEMBER_STATS`, which carries no flags, no race and no display — so those read
 * `undefined` for them, and `inGrid` is how a window tells «out of range» from «not sent yet».
 */
export interface WindowGroupUnitView extends WindowUnitView {
  readonly online: boolean;
  readonly away: boolean;
  readonly inGrid: boolean;
  readonly raidMark: number | undefined;
  readonly subGroup: number | undefined;
}

/** One inventory square, as `bag[b].slot[s]`. */
export interface WindowItemView {
  readonly itemId: number;
  readonly count: number;
  readonly icon: number;
  readonly quality: number | undefined;
  readonly name: string;
  readonly guid: string;
  /** The container number the item opcodes want: 255 for the backpack, 19..22 for a worn bag. */
  readonly bag: number;
  /** The slot number inside that container, again as the opcodes address it. */
  readonly index: number;
}

export interface WindowBagView {
  /** The container number: 255 for the backpack, 19..22 for the four worn bags. */
  readonly id: number;
  readonly size: number;
  readonly free: number;
  readonly slot: readonly WindowItemView[];
}

export interface WindowQuestObjectiveView {
  readonly text: string;
  readonly have: number;
  readonly need: number;
  readonly done: boolean;
}

export interface WindowQuestView {
  readonly id: number;
  readonly title: string;
  readonly complete: boolean;
  readonly failed: boolean;
  /** Absolute expiry in the server's seconds; 0 when the quest is not timed. */
  readonly timer: number;
  readonly objectives: readonly WindowQuestObjectiveView[];
}

/** What {@link buildWindowSnapshot} needs, so that it can be built without a browser. */
export interface WindowSnapshotSources {
  /**
   * Which roots to assemble. Absent means every one of them.
   *
   * The suppliers below are called only for the roots named here, and each at most once — so a
   * test can hand in a counting supplier and assert that a window reading `player.health` never
   * asked for the bags.
   */
  readonly roots?: ReadonlySet<string> | undefined;
  readonly self?: WorldObjectState | undefined;
  readonly target?: WorldObjectState | undefined;
  readonly selfName?: string | undefined;
  readonly targetName?: string | undefined;
  /** `REACTION_HOSTILE` / `REACTION_NEUTRAL` / `REACTION_FRIENDLY`, when the caller knows one. */
  readonly targetReaction?: number | undefined;
  readonly zone?: string | undefined;
  readonly subzone?: string | undefined;
  /** The game clock as `ЧЧ:ММ`, already formatted: see the `time` binding in `WindowSchema`. */
  readonly clock?: string | undefined;
  readonly mapId?: number | undefined;
  readonly groupType?: number | undefined;
  readonly groupSize?: number | undefined;
  /** `Map.InstanceType` is non-zero: the answer the original client's `IsInInstance()` gives. */
  readonly inInstance?: boolean | undefined;
  readonly fps?: number | undefined;
  readonly focus?: WindowViewSupplier<WindowUnitView | undefined> | undefined;
  readonly pet?: WindowViewSupplier<WindowUnitView | undefined> | undefined;
  readonly party?: WindowViewSupplier<readonly WindowGroupUnitView[]> | undefined;
  readonly raid?: WindowViewSupplier<readonly WindowGroupUnitView[]> | undefined;
  readonly boss?: WindowViewSupplier<readonly WindowGroupUnitView[]> | undefined;
  readonly arena?: WindowViewSupplier<readonly WindowGroupUnitView[]> | undefined;
  readonly bag?: WindowViewSupplier<readonly WindowBagView[]> | undefined;
  readonly quest?: WindowViewSupplier<readonly WindowQuestView[]> | undefined;
  readonly aura?: WindowViewSupplier<readonly WindowAuraView[]> | undefined;
  /** The last decoded value of each declared message, by name. */
  readonly messages?: WindowViewSupplier<ReadonlyMap<string, unknown>> | undefined;
  readonly settings?: WindowViewSupplier<SettingValues> | undefined;
}

const EMPTY_UNIT: WindowUnitView = {
  exists: false, guid: "", name: "", level: undefined, health: undefined, maxHealth: undefined,
  power: undefined, maxPower: undefined, powerType: undefined, powerScale: 1,
  race: undefined, class: undefined, gender: undefined, displayId: undefined,
  dead: false, combat: false, mounted: false, shapeshiftForm: undefined,
};

const scaleOf = (powerType: number | undefined): number =>
  powerType === undefined || powerType >= POWER_COUNT ? 1 : POWER_DISPLAY_SCALE[powerType] ?? 1;

// Rounded, and rounded the same way `Frames.ts:186` rounds: two places printing one resource from
// one snapshot have to print the same figure, and «57» beside «56,6» is the kind of disagreement a
// player reports as a bug in the window that is new.
const scaled = (value: number | undefined, scale: number): number | undefined =>
  value === undefined ? undefined : Math.round(value / scale);

function unitView(object: WorldObjectState | undefined, name: string): WindowUnitView {
  if (!object) return EMPTY_UNIT;
  const powerType = unit.powerType(object);
  const health = unit.health(object);
  const flags = unit.flags(object) ?? 0;
  const powerScale = scaleOf(powerType);
  return {
    exists: true,
    guid: object.guid.toString(),
    name,
    level: unit.level(object),
    health,
    maxHealth: unit.maxHealth(object),
    power: scaled(unit.power(object), powerScale),
    maxPower: scaled(unit.maxPower(object), powerScale),
    powerType,
    powerScale,
    race: unit.race(object),
    class: unit.classId(object),
    gender: unit.gender(object),
    displayId: unit.displayId(object),
    // Zero health is a corpse; health that has not arrived is not. Conflating them makes every
    // unit dead for the frame after it appears, which a `dead` condition would flicker on.
    dead: health === 0,
    combat: (flags & UNIT_FLAG_IN_COMBAT) !== 0,
    mounted: (unit.mountDisplayId(object) ?? 0) !== 0,
    shapeshiftForm: unit.shapeshiftForm(object),
  };
}

/**
 * One member of a group, a raid, a boss list or an arena, from the frames' own snapshot.
 *
 * Built on `UnitSnapshot` rather than straight off the object grid, and that is the whole reason it
 * exists: the twenty-five raid members in the other wing have no `WorldObjectState` at all, and a
 * view that read only the grid would show twelve people out of forty and blank the rest.
 */
export function groupUnitView(snapshot: UnitSnapshot, subGroup?: number): WindowGroupUnitView {
  return {
    exists: snapshot.guid !== 0n,
    guid: snapshot.guid.toString(),
    name: snapshot.name,
    level: snapshot.level,
    health: snapshot.health,
    maxHealth: snapshot.maxHealth,
    power: scaled(snapshot.power, snapshot.powerScale),
    maxPower: scaled(snapshot.maxPower, snapshot.powerScale),
    powerType: snapshot.powerType,
    powerScale: snapshot.powerScale,
    race: undefined,
    class: snapshot.classId,
    gender: undefined,
    displayId: undefined,
    dead: snapshot.dead,
    // None of the three is knowable from `SMSG_PARTY_MEMBER_STATS`, and the frames do not draw
    // them either. Published as `false`/`undefined` rather than left out so that a party row and
    // `target` have the same shape: an expression written against one works against the other.
    combat: false,
    mounted: false,
    shapeshiftForm: undefined,
    online: snapshot.online,
    away: snapshot.away,
    inGrid: snapshot.inGrid,
    raidMark: snapshot.raidMark,
    subGroup,
  };
}

/**
 * The whole view, from things a test can build by hand.
 *
 * Pure and DOM-free on purpose: the reading of the update fields is the part with decisions in it
 * — which flag means combat, which bit means resting, what a missing maximum does to a bar — and
 * it should be checkable without a browser, a socket or a login.
 */
export function buildWindowSnapshot(sources: WindowSnapshotSources): ExpressionScope {
  const wanted = sources.roots;
  const asked = (root: string): boolean => wanted === undefined || wanted.has(root);

  const self = sources.self;
  const base = unitView(self, sources.selfName ?? "");
  const playerFlags = self ? readField(self, "PLAYER_FLAGS") ?? 0 : 0;
  const position = self?.position;
  // Memoised in a closure rather than on the object: the view is frozen, so there is nowhere on it
  // to write a cache, and two widgets asking `hasBuff` in one tick have to be given one answer.
  let auraList: readonly WindowAuraView[] | undefined;
  // One pass over the aura strip per snapshot, however many readers there are: the list is also
  // published as `aura[i]`, and asking the supplier twice would walk the strip twice and — worse —
  // could hand the two readers two different lists if anything ever moved between the calls.
  const auras = (): readonly WindowAuraView[] => (auraList ??= sources.aura?.() ?? []);
  let auraMaps: AuraMaps | undefined;
  const byName = (): AuraMaps => (auraMaps ??= auraMapsOf(auras()));
  const player: WindowPlayerView = {
    ...base,
    xp: self ? playerFields.experience(self) : undefined,
    maxXp: self ? playerFields.nextLevelExperience(self) : undefined,
    money: self ? playerFields.money(self) : undefined,
    resting: (playerFlags & PLAYER_FLAGS_RESTING) !== 0,
    x: position?.x,
    y: position?.y,
    z: position?.z,
    o: position?.orientation,
    get buff() { return byName().buff; },
    get debuff() { return byName().debuff; },
  };
  const targetBase = unitView(sources.target, sources.targetName ?? "");
  const target: WindowTargetView = {
    ...targetBase,
    hostile: targetBase.exists && sources.targetReaction === REACTION_HOSTILE,
    friendly: targetBase.exists && sources.targetReaction === REACTION_FRIENDLY,
  };
  const world: Record<string, unknown> = {
    zone: sources.zone ?? "",
    subzone: sources.subzone ?? "",
    clock: sources.clock ?? "",
    inGroup: (sources.groupSize ?? 0) > 0,
    inRaid: ((sources.groupType ?? 0) & GROUPTYPE_RAID) !== 0,
    inInstance: sources.inInstance ?? false,
    fps: Math.round(sources.fps ?? 0),
  };
  if (sources.mapId !== undefined) world["mapId"] = sources.mapId;

  const view: Record<string, unknown> = {
    player: Object.freeze(player),
    target: Object.freeze(target),
    world: Object.freeze(world),
  };
  // A root nobody reads is not built and not published, and that reads exactly as a root this
  // client has not got: `undefined`, an empty label, a condition that never fires. Publishing an
  // empty list instead would make «this window does not read the raid» look like «the raid is
  // empty», which is a different answer and a confidently wrong one.
  if (asked("focus")) view["focus"] = Object.freeze(sources.focus?.() ?? EMPTY_UNIT);
  if (asked("pet")) view["pet"] = Object.freeze(sources.pet?.() ?? EMPTY_UNIT);
  if (asked("party")) view["party"] = frozenRows(sources.party?.() ?? []);
  if (asked("raid")) view["raid"] = frozenRows(sources.raid?.() ?? []);
  if (asked("boss")) view["boss"] = frozenRows(sources.boss?.() ?? []);
  if (asked("arena")) view["arena"] = frozenRows(sources.arena?.() ?? []);
  if (asked("bag")) view["bag"] = frozenBags(sources.bag?.() ?? []);
  if (asked("quest")) view["quest"] = frozenQuests(sources.quest?.() ?? []);
  if (asked("aura")) view["aura"] = frozenRows(auras());
  if (asked("msg")) view["msg"] = messageView(sources.messages?.() ?? new Map());
  if (asked("setting")) view["setting"] = settingView(sources.settings?.());

  // Frozen one level at a time. `Object.freeze` is shallow, and the promise this view makes is that
  // a widget cannot change what the next widget reads — which means the unit objects, the rows of
  // every list and the squares inside a bag, not only the box they all sit in.
  return Object.freeze(view);
}

interface AuraMaps {
  readonly buff: Readonly<Record<string, WindowAuraView>>;
  readonly debuff: Readonly<Record<string, WindowAuraView>>;
}

/**
 * The auras keyed by name, split into the two the conditions ask about.
 *
 * Null prototypes, and that is not decoration: the key is a spell name out of the dataset, so an
 * ordinary object would answer `player.buff["constructor"]` with a live function. `WindowExpression`
 * refuses inherited keys and functions on its own — this is the second lock on the same door, in
 * the file that owns the map.
 */
function auraMapsOf(auras: readonly WindowAuraView[]): AuraMaps {
  const buff = Object.create(null) as Record<string, WindowAuraView>;
  const debuff = Object.create(null) as Record<string, WindowAuraView>;
  for (const aura of auras) {
    if (!aura.name) continue;
    const into = aura.harmful ? debuff : buff;
    // First writer wins, so two applications of one aura leave the earlier — and longer-standing —
    // record in place rather than flickering between them.
    if (into[aura.name] === undefined) into[aura.name] = aura;
  }
  return { buff: Object.freeze(buff), debuff: Object.freeze(debuff) };
}

function frozenRows<T>(rows: readonly T[]): readonly T[] {
  for (const row of rows) Object.freeze(row);
  return Object.freeze([...rows]);
}

function frozenBags(bags: readonly WindowBagView[]): readonly WindowBagView[] {
  for (const bag of bags) {
    frozenRows(bag.slot);
    Object.freeze(bag.slot);
    Object.freeze(bag);
  }
  return Object.freeze([...bags]);
}

function frozenQuests(quests: readonly WindowQuestView[]): readonly WindowQuestView[] {
  for (const quest of quests) {
    frozenRows(quest.objectives);
    // `frozenRows` freezes the rows and hands back a frozen *copy* of the list; the list on the
    // quest is the one a widget reads, and it is the one that has to be frozen — exactly as
    // `frozenBags` does for `bag.slot`. It was the one array in the whole view that could still be
    // pushed to.
    Object.freeze(quest.objectives);
    Object.freeze(quest);
  }
  return Object.freeze([...quests]);
}

/**
 * The declared messages by name, spelled both ways a definition can reach one.
 *
 * A message name is module-qualified by convention — the studio writes `shop.State` — so
 * `msg.shop.State.gold` is the spelling an author reaches for, and it needs `msg.shop` to be a
 * container. The flat key is kept beside it because `msg["shop.State"]` is the only spelling left
 * when a module ships both a `shop` message and a `shop.State` one: the two cannot both own the key
 * `shop`, and the plain value wins, because it is the one somebody named exactly.
 *
 * The containers are this function's own objects and are tracked in a set, so that walking into one
 * can never write a field into a *decoded value* the registry still owns.
 */
function messageView(latest: ReadonlyMap<string, unknown>): Readonly<Record<string, unknown>> {
  const root = Object.create(null) as Record<string, unknown>;
  const containers = new Set<object>([root]);
  for (const [name, value] of latest) root[name] = value;
  for (const [name, value] of latest) {
    const segments = name.split(".");
    if (segments.length < 2) continue;
    let node = root;
    let reached = true;
    for (const segment of segments.slice(0, -1)) {
      const next = node[segment];
      if (next === undefined) {
        const made = Object.create(null) as Record<string, unknown>;
        containers.add(made);
        node[segment] = made;
        node = made;
        continue;
      }
      if (typeof next !== "object" || next === null || !containers.has(next)) {
        reached = false;
        break;
      }
      node = next as Record<string, unknown>;
    }
    const leaf = segments[segments.length - 1] as string;
    if (reached && node[leaf] === undefined) node[leaf] = value;
  }
  for (const container of containers) Object.freeze(container);
  return root;
}

/**
 * The settings, restricted to the ids the settings window declares.
 *
 * Restricted rather than copied whole, because the blob is read back from the server and from
 * `localStorage`: an id nothing declares is either a leftover from an older client or something a
 * page wrote, and neither is state this client publishes to a module. A declared id that is missing
 * reads as its own default, which is what every other reader of the blob does.
 */
function settingView(values: SettingValues | undefined): Readonly<Record<string, boolean | number>> {
  const view = Object.create(null) as Record<string, boolean | number>;
  if (!values) return Object.freeze(view);
  for (const definition of SETTING_DEFINITIONS) {
    const value = values[definition.id];
    view[definition.id] = value === undefined ? definition.fallback : value;
  }
  return Object.freeze(view);
}

/* ---------------------------------------------------------------------------------------------
 * The live view
 * ------------------------------------------------------------------------------------------- */

export interface LiveSnapshotOptions {
  readonly now?: number | undefined;
  /**
   * Which roots to build. Absent means all of them, which is what an action press wants: it runs
   * once and its expressions were never seen by the binding pass.
   */
  readonly roots?: ReadonlySet<string> | undefined;
  /**
   * The settings, handed in rather than imported.
   *
   * `Settings.ts` reaches the action bar, the minimap and `Dom.ts`, and this file is imported by a
   * test that has no page; taking the values as an argument is what keeps the pure half pure.
   */
  readonly settings?: WindowViewSupplier<SettingValues> | undefined;
}

/**
 * The same view, taken from whatever the session currently holds.
 *
 * Every source is optional, so this answers between worlds too: no world client is an empty view,
 * not a throw, and a window left open across a logout empties rather than freezing on the last
 * numbers it saw.
 */
export function liveWindowSnapshot(options: LiveSnapshotOptions = {}): ExpressionScope {
  const now = options.now ?? performance.now();
  const world = game.world;
  const selfGuid = world?.state.selfGuid;
  const self = selfGuid === undefined ? undefined : world?.state.objects.get(selfGuid);
  const target = world?.targetGuid === undefined ? undefined : world.state.objects.get(world.targetGuid);
  const time = world?.currentGameTime(now);
  const areas = game.areas;
  // The same answer the minimap prints, taken the same way. The server names a *zone* on entering
  // one and never names a sub-area at all (`Minimap.ts:430`), so the area under the character is
  // counted from the map tile's own 16×16 area grid — a `Map` lookup and one `getUint16`, which is
  // cheap enough to do on every frame rather than on a timer. Reading the server's last
  // `SMSG_INIT_WORLD_STATES` instead would have been cheaper still and would have made a window's
  // zone label disagree with the minimap two feet away from it.
  // 05.10-A7b-4 (7.13): the located area (a WMO room's WMOAreaTable area, the grid, then the map's).
  const areaId = liveAreaIdAt(world?.mapId, self?.position?.x ?? 0, self?.position?.y ?? 0);
  const area = areas?.area(areaId);
  const zone = areas?.zoneOf(areaId);
  const members = world?.group?.members ?? [];
  // Inverted once for the whole snapshot rather than once per member, exactly as the frames do it:
  // the server indexes by icon because an icon is unique and a unit is not.
  const marks = new Map<bigint, number>();
  for (const [icon, guid] of world?.raidTargets ?? []) marks.set(guid, icon);
  const groupRow = (guid: bigint, subGroup?: number, name?: string, online?: boolean): WindowGroupUnitView => {
    const object = world?.state.objects.get(guid);
    const stats = world?.partyStats.get(guid);
    const snapshot = unitSnapshot(guid, name ?? world?.displayName(guid) ?? "", {
      object,
      stats,
      raidMark: marks.get(guid),
      reaction: object ? reactionTo(object) : undefined,
      ...(online === undefined ? {} : { online }),
    });
    // The group list is the authority on the name and on being connected at all; the stats packet
    // carries neither, and an offline member has no object to read a name from.
    if (name) snapshot.name = name;
    return groupUnitView(snapshot, subGroup);
  };

  return buildWindowSnapshot({
    ...(options.roots === undefined ? {} : { roots: options.roots }),
    self,
    target,
    selfName: world?.selfName ?? (selfGuid === undefined ? undefined : world?.displayName(selfGuid)),
    targetName: target === undefined ? undefined : world?.displayName(target.guid),
    targetReaction: target === undefined ? undefined : reactionTo(target),
    zone: zone?.name ?? areas?.map(world?.mapId ?? 0)?.name ?? "",
    subzone: area && zone && area.id !== zone.id ? area.name : "",
    clock: time ? formatGameTime(time) : "",
    mapId: world?.mapId,
    groupType: world?.group?.groupType,
    groupSize: members.length,
    // `Map.InstanceType` is where the original client's `IsInInstance()` comes from. A map this
    // client has no row for reads `false`, which is the same answer it gives outside a world.
    inInstance: (areas?.map(world?.mapId ?? 0)?.instanceType ?? 0) !== 0,
    fps: game.renderer?.fps ?? 0,
    focus: () => (game.focusGuid === undefined ? undefined
      : unitView(world?.state.objects.get(game.focusGuid), world?.displayName(game.focusGuid) ?? "")),
    pet: () => {
      // The pet's guid comes from the bar the server sent for it, which is the only packet naming
      // it: `UNIT_FIELD_SUMMON` on the player carries the same guid and arrives later.
      const petGuid = world?.petSpells?.guid;
      if (petGuid === undefined || petGuid === 0n) return undefined;
      return unitView(world?.state.objects.get(petGuid), world?.displayName(petGuid) ?? "");
    },
    // `party` leaves the player out and `raid` puts them in, exactly as `party1..4` and `raid1..40`
    // do in the original client — and `SMSG_GROUP_LIST` leaves the receiving player out of its own
    // member list, so the raid form is the one that has to put them back.
    party: () => members
      .filter((member) => member.guid !== selfGuid)
      .map((member) => groupRow(member.guid, member.subGroup, member.name, member.online)),
    raid: () => {
      const group = world?.group;
      if (!group || selfGuid === undefined) return [];
      return allMembers(group, selfGuid, world?.selfName ?? "")
        .map((member) => groupRow(member.guid, member.subGroup, member.name, member.online));
    },
    boss: () => engagedBossGuids().map((guid) => groupRow(guid)),
    arena: () => arenaOpponentGuids().map((guid) => groupRow(guid)),
    bag: () => bagViews(),
    quest: () => {
      if (!world || !self) return [];
      return buildQuestLogView(
        playerFields.quests(self), world.questTemplates, questCarriedItemCounts(world),
      ).map((entry) => ({
        id: entry.questId,
        // Empty until `SMSG_QUEST_QUERY_RESPONSE` lands: the log knows a quest is there before it
        // knows its name, and a placeholder here would be a name on the screen that is not one.
        title: entry.template?.title ?? "",
        complete: entry.complete,
        failed: entry.failed,
        timer: entry.timer,
        objectives: entry.objectives.map((objective) => {
          const resolvedName = objective.kind === "item"
            ? game.itemMetadata?.get(objective.id)?.name ?? world.itemTemplates.get(objective.id)?.name
            : objective.kind === "gameObject"
              ? world.gameObjectTemplates.get(objective.id)?.name
              : game.creatureMetadata?.get(objective.id)?.name ?? world.creatureTemplates.get(objective.id)?.name;
          return {
            text: questObjectiveLabel(objective, resolvedName),
            have: objective.have,
            need: objective.need,
            done: objective.done,
          };
        }),
      }));
    },
    aura: () => (world?.aurasFor(selfGuid) ?? []).map((aura) => {
      const metadata = game.spells.get(aura.spellId);
      return {
        spellId: aura.spellId,
        name: metadata?.name ?? "",
        icon: metadata?.iconId ?? 0,
        stacks: aura.applications,
        remaining: aura.expiresAt === undefined ? undefined : Math.max(0, (aura.expiresAt - now) / 1000),
        harmful: (aura.flags & AURA_FLAG_NEGATIVE) !== 0,
      };
    }),
    messages: () => {
      const values = new Map<string, unknown>();
      const registry = world?.customPackets;
      for (const message of registry?.messages() ?? []) {
        const value = registry?.latest(message.name);
        if (value !== undefined) values.set(message.name, value);
      }
      return values;
    },
    ...(options.settings === undefined ? {} : { settings: options.settings }),
  });
}

/**
 * The player's own bags, backpack first, as `bag[0..4]`.
 *
 * Only the five the character carries: the bank, the keyring and the buyback shelves are addressed
 * by the same opcodes, but they are not what `bag[b]` means anywhere else, and a list whose first
 * five entries are bags and whose sixth is a bank shelf is a list nothing can index safely.
 */
function bagViews(): readonly WindowBagView[] {
  const world = game.world;
  const inventory = world ? playerInventory(world.state) : undefined;
  if (!inventory) return [];
  const bags: WindowBagView[] = [bagView(255, inventory.backpack)];
  for (const bag of inventory.bags) bags.push(bagView(bag.bagSlot, bag.slots));
  return bags;
}

/** The carried-only inventory boundary used by both quest screens and module-window snapshots. */
function questCarriedItemCounts(world: WorldClient): ReadonlyMap<number, number> | undefined {
  const inventory = playerInventory(world.state);
  if (!inventory) return undefined;
  const stacks: Array<{ itemId: number; count: number }> = [];
  const slots = [
    ...inventory.equipment,
    ...inventory.backpack,
    ...inventory.keyring,
    ...inventory.bags.flatMap((bag) => bag.slots),
  ];
  for (const slot of slots) {
    if (slot.guid !== 0n && !slot.item) return undefined;
    const itemId = entryOf(slot.item);
    if (slot.item && itemId <= 0) return undefined;
    if (itemId > 0) stacks.push({ itemId, count: stackCount(slot) });
  }
  return buildCarriedItemCounts(stacks);
}

function bagView(id: number, slots: readonly ItemSlotState[]): WindowBagView {
  const items = slots.map((slot) => itemView(slot));
  return {
    id,
    size: items.length,
    free: items.reduce((free, item) => free + (item.itemId === 0 ? 1 : 0), 0),
    slot: items,
  };
}

function itemView(slot: ItemSlotState): WindowItemView {
  // The same two reads `ItemSlots.ts:44` makes, so a module window and the bags agree about which
  // item is in a square and how many of it there are.
  const entry = slot.item?.fields.get(UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset) ?? 0;
  const metadata = entry ? game.itemMetadata?.get(entry) : undefined;
  return {
    itemId: entry,
    count: stackCount(slot),
    icon: metadata?.iconId ?? 0,
    quality: metadata?.quality,
    name: metadata?.name ?? "",
    guid: slot.guid.toString(),
    bag: slot.bag,
    index: slot.slot,
  };
}

/**
 * The once-a-frame binding pass, called from `drainWorldState`.
 *
 * Guarded on the registry being empty, which is the ordinary case: a client with no modules loaded
 * pays one `Map.size` comparison a frame and builds no snapshot at all. The registry also answers
 * which roots its windows read, so a client whose one window shows the clock builds three roots
 * rather than fourteen.
 */
export function refreshModuleWindows(options: LiveSnapshotOptions = {}): void {
  if (windowRegistry.size === 0 && patchRegistry.size === 0) return;
  // One snapshot for both registries, over the union of what they read. A patch's widget sits in a
  // built-in window rather than in one of its own, and it follows the game exactly as a module
  // window does — so it has to be on the same frozen view, or a bar in the target frame and the
  // label beside it could disagree by a frame.
  const roots = new Set([...windowRegistry.roots(), ...patchRegistry.roots()]);
  const snapshot = liveWindowSnapshot({ ...options, roots });
  windowRegistry.update(snapshot);
  patchRegistry.update(snapshot);
}
