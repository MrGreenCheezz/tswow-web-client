import { unit, worldObject } from "../../world/Fields.js";
import { REACTION_FRIENDLY, REACTION_HOSTILE, REACTION_NEUTRAL } from "../../world/FactionRules.js";
import {
  collectTabCandidates, enemiesAround, isAttackableUnit, isTabEnemy, TabCycle,
  type TabSource, type TargetCandidate,
} from "../../world/TargetSearch.js";
import type { WorldObjectState } from "../../world/WorldState.js";
import type { FactionClient } from "../FactionClient.js";
import { createCamera } from "../SimpleScene.js";
import { cameraPivotHeight, game } from "./Context.js";
import { viewSubjectPosition } from "./ViewSubject.js"; // 11.02-I
import { canInteractWithUnit } from "../../world/UnitInteractGate.js"; // 11.02-tails
import { drawnUnitPosition } from "../VehiclePassengerOverlay.js"; // 11.02-tails
import { reactionsByTemplate } from "../../world/UnitInteractGate.js"; // 11.02-tails-review
import { isPlayerGhost } from "../../world/Fields.js"; // 11.02-tails-review
import { isTabIgnoredCreatureType } from "../../world/TargetSearch.js"; // L2 1.10
import { GROUPTYPE_RAID } from "../../world/GroupProtocol.js"; // L2 1.10
import { setTargetHistoryJudge, type TargetHistoryKind } from "../../world/TargetHistory.js"; // L2 1.10
import { actionRangeCanAssist, type ActionRangeHost } from "../framexml/FrameXmlActionRange.js"; // L2 1.10
import { NEAREST_ENEMY, nearestModeAccepts, type NearestMode, type NearestModeHost } from "./TargetNearestModes.js"; // L2 1.10
import { targetLast, type TargetLastKind } from "./TargetLast.js"; // L2 1.10
import { // L15 5.05
  FACTION_FLAG_AT_WAR, interactionReactionOfRank, reputationBaseFor, reputationListIdOf, reputationRank, // L15 5.05
  setReputationBaseSource, // L15 5.05
} from "../../world/ReputationReaction.js"; // L15 5.05
import { actionRangeLimits } from "../framexml/FrameXmlActionRange.js"; // L15 5.05
import { player as playerFields } from "../../world/Fields.js"; // L15-review
import { contestedGuardHostile } from "../../world/ContestedGuard.js"; // L18 5.05

// L18 5.05: PLAYER_FLAGS_CONTESTED_PVP (L15-review's constant here) lives in world/ContestedGuard.ts now.

/** ReputationRank, SharedDefines.h:206-210: HOSTILE 1 and below read hostile, FRIENDLY 4 and up friendly. */
const REP_HOSTILE = 1;
const REP_FRIENDLY = 4;

/**
 * Who the player can point at.
 *
 * The reaction is not on the wire in 3.3.5 — the server publishes a faction template id and the
 * client is expected to look the rest up itself — so this is where the table the gateway serves
 * meets the units in view. Until it lands everything reads neutral, which costs Tab and a plate
 * colour and nothing else.
 *
 * A forced reaction (`SMSG_SET_FORCED_REACTIONS`, 5.16) wins over the table, as
 * `WorldObject::GetReactionTo` checks `GetForcedRankIfAny` first (Object.cpp:2830-2842): the map
 * belongs to the player and is keyed by the other side's `FactionTemplate.Faction`
 * (ReputationMgr.h:112-116), so it answers only when one of the two is the player.
 */
export function reactionBetween(
  self: WorldObjectState | undefined,
  object: WorldObjectState,
  factions: FactionClient | undefined,
  forced: ReadonlyMap<number, number> | undefined = game.world?.forcedReactions,
): number {
  const mine = self ? unit.factionTemplate(self) : undefined;
  const theirs = unit.factionTemplate(object);
  if (mine === undefined || theirs === undefined) return REACTION_NEUTRAL;
  if (forced !== undefined && forced.size > 0 && factions) {
    const player = game.world?.state.selfGuid;
    const other = self?.guid === player ? theirs : object.guid === player ? mine : undefined;
    const faction = other === undefined ? undefined : factions.factionOf(other);
    const rank = faction === undefined ? undefined : forced.get(faction);
    if (rank !== undefined) {
      return rank <= REP_HOSTILE ? REACTION_HOSTILE : rank >= REP_FRIENDLY ? REACTION_FRIENDLY : REACTION_NEUTRAL;
    }
  }
  return factions?.reaction(mine, theirs) ?? REACTION_NEUTRAL;
}

/** The live wrapper retains the current world and faction client. */
export function reactionTo(object: WorldObjectState): number {
  const world = game.world;
  const self = world?.state.selfGuid === undefined ? undefined : world.state.objects.get(world.state.selfGuid);
  return reactionBetween(self, object, game.factions);
}

/** The player's character, or nothing outside the world. */
function player(): WorldObjectState | undefined {
  const world = game.world;
  const guid = world?.state.selfGuid;
  return guid === undefined ? undefined : world?.state.objects.get(guid);
}

/**
 * Whether the player may swing at this unit (Wow.exe CanAttack 0x729740, `isAttackableUnit`), with
 * this client's reactions. The world client asks it on a target change (5.05) and a right click
 * asks it before attacking.
 *
 * Until the faction table lands the answer is "no": every reaction would read neutral, and
 * neutral is attackable, so a right click on a guard, a party member or a dungeon bot would swing
 * at it and a click on a friend mid-fight would carry the swing over. Wow.exe always has the table;
 * refusing keeps the click and the target change as they were before 5.05. Tab, which only
 * selects, keeps taking neutrals meanwhile (`isTabTarget`).
 */
export function canAttackUnit(object: WorldObjectState): boolean {
  if (game.factions?.ready !== true) return false;
  return isAttackableUnit(player(), object, attackReactionTo(object)); // L15 5.05: was reactionTo
}

/**
 * L15 5.05: the player's view of a unit as CanAttack reads it (Wow.exe 0x00729740 → 0x00514050 →
 * 0x007251c0): for a faction that keeps a reputation, hostile while the player is at war with it and
 * friendly otherwise (ReputationReaction.ts) — a Friendly Sons of Hodir NPC or a Booty Bay bruiser is no
 * target — else the masks and forced reactions of `reactionTo`. Display colours keep `reactionTo`: Wow.exe
 * paints by the unit's view (the rank). Map lookups only — asked per hover.
 */
export function attackReactionTo(object: WorldObjectState): number {
  const self = player();
  const list = self === undefined ? undefined : reputationListFor(object, self);
  if (list === undefined) return reactionTo(object);
  // L18 5.05: 0x007253ca — a CONTESTED_GUARD template is hostile to a contested player before the at-war flag.
  if (self !== undefined && contestedGuardOf(object, self) === true) return REACTION_HOSTILE; // L18 5.05
  return factionAtWar(list) ? REACTION_HOSTILE : REACTION_FRIENDLY;
}

/**
 * L18 5.05: world/ContestedGuard.ts for this unit's template and the player — true when the template is a
 * CONTESTED_GUARD one and the player has PLAYER_FLAGS_CONTESTED_PVP; undefined for a contested player while
 * the template flags are unknown (`FactionClient.templateFlagsOf`: a gateway before /dbc/factions v=3).
 */
function contestedGuardOf(object: WorldObjectState, self: WorldObjectState): boolean | undefined {
  const template = unit.factionTemplate(object);
  return contestedGuardHostile(Number(playerFields.flags(self) ?? 0),
    template === undefined ? undefined : game.factions?.templateFlagsOf?.(template));
}

/**
 * L15 5.05: the reputation list id Wow.exe reads this unit's reactions off (0x00718b30: the unit's
 * faction keeps a reputation; no forced reaction for it, no UNIT_FLAG2_IGNORE_REPUTATION on the player —
 * UnitInteractGate.ts `reactionsByTemplate`), when the catalog has landed; undefined for the masks.
 */
function reputationListFor(object: WorldObjectState, self: WorldObjectState): number | undefined {
  const factions = game.factions;
  const catalog = factions?.reputationCatalog;
  if (catalog === undefined) return undefined;
  const template = unit.factionTemplate(object);
  const faction = template === undefined ? undefined : factions?.factionOf(template);
  if (faction === undefined || reactionsByTemplate(self, faction, catalog, game.world?.forcedReactions)) return undefined;
  // L15-review: a PvP-contested player (PLAYER_FLAGS_CONTESTED_PVP) meets 0x007253ca's CONTESTED_GUARD test
  // (FactionTemplate flags 0x1000 → hostile) before the at-war flag, and /dbc/factions carries no template
  // flags: such a player keeps the masks (the pre-5.05 reading) and can hit back at a Booty Bay bruiser.
  // L18 5.05: Wow.exe's rule itself now (`attackReactionTo`, `rightClickInteracts`) — the masks only while
  // the template flags are unknown (a gateway before /dbc/factions v=3, i.e. until its restart).
  if (contestedGuardOf(object, self) === undefined) return undefined; // L15-review; L18 5.05: was the player flag alone
  const listId = reputationListIdOf(catalog, faction); // L15-review
  // L15-review: no row for it yet (before SMSG_INITIALIZE_FACTIONS, or a slot it did not carry) — Wow.exe
  // always has the rows before a unit is in view; this client keeps the masks rather than read "friend".
  return listId !== undefined && game.world?.factions?.has(listId) === true ? listId : undefined; // L15-review
}

/** L15 5.05: FACTION_FLAG_AT_WAR of the player's row (0x005d04b0); a row not sent yet is at peace. */
function factionAtWar(listId: number): boolean {
  return ((game.world?.factions?.get(listId)?.flags ?? 0) & FACTION_FLAG_AT_WAR) !== 0;
}

/** L15 5.05: 0x005d0600 — the player's rank with a reputation list id: the race/class base plus the wire's standing. */
function playerRankWith(listId: number, self: WorldObjectState): number {
  const base = reputationBaseFor(game.factions?.reputationCatalog?.factions[listId], unit.race(self) ?? 0, unit.classId(self) ?? 0);
  return reputationRank(base + (game.world?.factions?.get(listId)?.standing ?? 0));
}

/** L15 5.05: the forced rank the player holds for this unit's faction (0x005d06a0), read first both ways. */
function forcedRankOf(object: WorldObjectState): number | undefined {
  const forced = game.world?.forcedReactions;
  if (forced === undefined || forced.size === 0) return undefined;
  const template = unit.factionTemplate(object);
  const faction = template === undefined ? undefined : game.factions?.factionOf(template);
  return faction === undefined ? undefined : forced.get(faction);
}

// L15 5.05: the world client's SMSG_SET_FACTION_STANDING reads the player's base standing from the catalog.
setReputationBaseSource((listId) => { // L15 5.05
  const catalog = game.factions?.reputationCatalog;
  const self = player();
  if (catalog === undefined || self === undefined) return undefined;
  return reputationBaseFor(catalog.factions[listId], unit.race(self) ?? 0, unit.classId(self) ?? 0);
}); // L15 5.05

/**
 * Whether a right click on this unit swings at it (5.05) rather than asking for its services: a
 * unit the player may attack, when it is hostile or offers no NPC service. A neutral unit with a
 * service — the yellow innkeeper — is talked to, so a neutral reaction never suppresses a service.
 */
export function rightClickAttacks(object: WorldObjectState): boolean {
  if ((object.typeId !== 3 && object.typeId !== 4) || !canAttackUnit(object)) return false;
  // 11.02-tails-review: a ghost never swings — the realm's Unit::Attack refuses a dead attacker
  // (Unit.cpp:5930) — so a talk the ghost gate refused does not turn into an attack.
  const self = player();
  if (self !== undefined && isPlayerGhost(self)) return false;
  // L15 5.05: with the catalog a reputation faction is read as Wow.exe reads it — at war or not for
  // CanAttack (above), the rank for the talk — so the 0x00731260 rule below holds for it too.
  if (self !== undefined && reputationListFor(object, self) !== undefined) return !rightClickInteracts(object); // L15 5.05
  // 11.02-tails-review: a faction that keeps a reputation is not judged on the template masks
  // (UnitInteractGate.ts `reactionsByTemplate`): the 5.05 rule stays — hostile from the player's side,
  // or nothing to talk about.
  if (!reactionsByMasks(object, self)) return reactionTo(object) === REACTION_HOSTILE || !rightClickInteracts(object);
  // 11.02-tails: Wow.exe 0x00731260 fights a live unit only when 0x00729530 will not let the player
  // talk to it — a hostile unit with UNIT_FLAG2_ALLOW_ENEMY_INTERACT and an NPC flag (an NPCBot for
  // hire) is talked to; a hostile one without it, or a neutral one with no NPC flag, is fought.
  return !rightClickInteracts(object);
}

/**
 * 11.02-tails: Wow.exe 0x00729530 for the player and this unit (UnitInteractGate.ts): NPC flags, not
 * UNIT_FLAG_UNINTERACTIBLE, both reactions neutral or better or UNIT_FLAG2_ALLOW_ENEMY_INTERACT, and
 * the ghost and the "only with its creator" gates on the creature's cached template.
 */
export function rightClickInteracts(object: WorldObjectState): boolean {
  const self = player();
  // `?.` on the map too: test worlds and stand-ins without the cache read "not cached".
  const template = object.typeId === 3
    ? game.world?.creatureTemplates?.get(worldObject.entry(object) ?? 0)
    : undefined;
  // 11.02-tails-review: the reactions only where Wow.exe reads the same masks; otherwise rule 4 passes.
  const byMasks = reactionsByMasks(object, self); // 11.02-tails-review
  let fromUnit = self === undefined || !byMasks ? REACTION_NEUTRAL : reactionBetween(object, self, game.factions); // 11.02-tails-review; L15 5.05: let
  let toUnit = byMasks ? reactionTo(object) : REACTION_NEUTRAL; // L15 5.05
  // L15 5.05: the ranks 0x007251c0 gives both ways where Wow.exe reads ranks, not masks — a forced
  // reaction's own rank, or a reputation faction's at-war flag (the player's view) and the player's rank
  // (the unit's view); 0x00729530 talks at neutral (3) or better, so an Unfriendly (2) refuses.
  const forcedRank = forcedRankOf(object); // L15 5.05
  const list = self === undefined || forcedRank !== undefined ? undefined : reputationListFor(object, self); // L15 5.05
  if (forcedRank !== undefined) toUnit = fromUnit = interactionReactionOfRank(forcedRank); // L15 5.05
  else if (list !== undefined && self !== undefined) { // L15 5.05
    toUnit = factionAtWar(list) ? REACTION_HOSTILE : REACTION_FRIENDLY; // L15 5.05
    fromUnit = interactionReactionOfRank(playerRankWith(list, self)); // L15 5.05
  } // L15 5.05
  // L18 5.05: CONTESTED_GUARD (world/ContestedGuard.ts) against a contested player — the unit's view reads it
  // first of all (0x0071f770: before the forced rank, with or without a reputation), the player's view after
  // the forced rank and for a reputation faction only, before the at-war flag (0x007253ca).
  if (self !== undefined && contestedGuardOf(object, self) === true) { // L18 5.05
    fromUnit = REACTION_HOSTILE; // L18 5.05
    if (forcedRank === undefined && list !== undefined) toUnit = REACTION_HOSTILE; // L18 5.05
  } // L18 5.05
  return canInteractWithUnit(self, object, toUnit, fromUnit, // 11.02-tails-review; L15 5.05: toUnit
    template?.found === true ? template.flags : undefined);
}

/**
 * 11.02-tails-review: whether Wow.exe judges this unit on the faction template masks this client's
 * reactions come from — not for a faction that keeps a reputation, unless a forced reaction names it
 * (UnitInteractGate.ts `reactionsByTemplate`).
 */
function reactionsByMasks(object: WorldObjectState, self: WorldObjectState | undefined): boolean {
  const factions = game.factions;
  const template = unit.factionTemplate(object);
  const faction = template === undefined ? undefined : factions?.factionOf(template);
  return reactionsByTemplate(self, faction, factions?.reputationCatalog, game.world?.forcedReactions);
}

/**
 * 11.02-tails: whether a right click on a live unit that offers a service (any NPC flag) must not
 * reach it — no gossip, quest, vendor or seat — because Wow.exe's 0x00729530 refuses the player:
 * a ghost and a creature that does not show itself to ghosts, a creator-only gossip creature, an
 * uninteractible unit, a hostile one without UNIT_FLAG2_ALLOW_ENEMY_INTERACT. A unit with no NPC
 * flag offers nothing to refuse, and its click stays as it was.
 */
export function rightClickRefusesService(object: WorldObjectState): boolean {
  if (object.typeId !== 3 && object.typeId !== 4) return false;
  return (unit.npcFlags(object) ?? 0) !== 0 && !rightClickInteracts(object);
}

/** TargetNearestEnemy's filter (0x518e40 mode 1) with the creature's CreatureType when it is cached. */
function isTabTarget(object: WorldObjectState): boolean {
  const world = game.world;
  const creatureType = object.typeId === 3
    ? world?.creatureTemplates.get(worldObject.entry(object) ?? 0)?.creatureType
    : undefined;
  return isTabEnemy(player(), object, attackReactionTo(object), creatureType); // L15 5.05: was reactionTo (0x518e40 mode 1 is CanAttack)
}

/** Where the search stands and looks from: the controlled body (vehicle, charm), else the player. */
function mover(): WorldObjectState | undefined {
  const world = game.world;
  const guid = world?.controlledGuid ?? world?.state.selfGuid;
  return guid === undefined ? undefined : world?.state.objects.get(guid);
}

/**
 * L2 1.10: the mode of the shared list — 1 for Tab, else the TargetNearest* that built it
 * (0x00bd08d4; game/TargetNearestModes.ts). Read by the filter, so no press allocates one.
 */
let tabMode: NearestMode = NEAREST_ENEMY;

/** L2 1.10: 0x518e40 for the list's mode, with 0x524440's creature-type net; Tab's own as it was. */
function acceptsTabMode(object: WorldObjectState): boolean {
  if (tabMode === NEAREST_ENEMY) return isTabTarget(object);
  if (object.typeId === 3) {
    const type = game.world?.creatureTemplates.get(worldObject.entry(object) ?? 0)?.creatureType;
    if (isTabIgnoredCreatureType(type)) return false;
  }
  return nearestModeAccepts(tabMode, object, nearestModeHost);
}

const tabSource: TabSource = {
  collect(out: TargetCandidate[]): number {
    const world = game.world;
    const origin = mover();
    if (!world || !origin?.position) {
      out.length = 0;
      return 0;
    }
    return collectTabCandidates(world.state.objects.values(), origin.position, origin.guid, acceptsTabMode, out); // L2 1.10: was isTabTarget
  },
  valid(guid: bigint): boolean {
    const object = game.world?.state.objects.get(guid);
    return object !== undefined && acceptsTabMode(object); // L2 1.10: was isTabTarget
  },
};

const tabCycle = new TabCycle();
let tabWorld: unknown;
let tabClears = 0;

/**
 * Who Tab can take, in the order it takes them (a fresh list; Tab itself keeps its own, see
 * {@link cycleEnemyTarget}). Wow.exe 0x524440: within ±30° of the mover's facing out to 41 yards,
 * anywhere within 10; the cone first, then distance. Neutral (yellow) units are in — CanAttack
 * refuses only the friendly — and nothing dead is, corpses with loot included: loot is reached by
 * clicking the body.
 */
export function enemyCandidates(): TargetCandidate[] {
  const world = game.world;
  const origin = mover();
  if (!world || !origin?.position) return [];
  return enemiesAround(world.state.objects.values(), origin.position, origin.guid, isTabTarget);
}

/**
 * Tab (and shift-Tab with `step` -1): TargetNearestEnemy 0x525ad0 → 0x524fc0 — the list is kept
 * while presses come within 3 s, a press steps on from the entry still selected, and each pick is
 * re-checked. Nothing to pick leaves the selection where it is.
 */
export function cycleEnemyTarget(step: 1 | -1 = 1): void {
  const world = game.world;
  if (!world) return;
  if (tabWorld !== world || tabClears !== world.selectionClears) {
    tabWorld = world;
    tabClears = world.selectionClears;
    tabCycle.invalidate();
  }
  // L2 1.10: one list for every TargetNearest* mode; a press in another mode rebuilds it (0x524fc0).
  if (tabMode !== NEAREST_ENEMY) {
    tabMode = NEAREST_ENEMY;
    tabCycle.invalidate();
  }
  const guid = tabCycle.next(performance.now(), world.targetGuid, step === -1, tabSource);
  if (guid === undefined) return;
  world.selectTarget(guid);
}

/**
 * L2 1.10: `TargetNearest*(reverse)` — 0x524fc0(reverse, mode) over the list Tab keeps
 * (game/TargetNearestModes.ts names the modes); mode 1 is what {@link cycleEnemyTarget} runs. Answers
 * whether a unit was picked; nothing to pick leaves the selection where it is.
 */
export function targetNearestUnit(mode: NearestMode, reverse: boolean): boolean {
  const world = game.world;
  if (!world) return false;
  if (tabWorld !== world || tabClears !== world.selectionClears) {
    tabWorld = world;
    tabClears = world.selectionClears;
    tabCycle.invalidate();
  }
  if (tabMode !== mode) {
    tabMode = mode;
    tabCycle.invalidate();
  }
  const guid = tabCycle.next(performance.now(), world.targetGuid, reverse, tabSource);
  if (guid === undefined) return false;
  world.selectTarget(guid);
  return true;
}

/** L2 1.10: `TargetLastTarget`/`TargetLastEnemy`/`TargetLastFriend` (game/TargetLast.ts) on the world. */
export function targetLastUnit(kind: TargetLastKind): boolean {
  const world = game.world;
  return world !== undefined && targetLast(world, kind);
}

// ---- L2 1.10: who the player can help, and how a new selection is remembered ----

/** L2 1.10: the creature's cached template, when the cache has an answer. */
function creatureTemplateOf(object: WorldObjectState): { readonly flags: number; readonly creatureType: number } | undefined {
  if (object.typeId !== 3) return undefined;
  const template = game.world?.creatureTemplates.get(worldObject.entry(object) ?? 0);
  return template?.found === true ? template : undefined;
}

const NO_MODIFIERS: readonly never[] = []; // L2 1.10

/**
 * L2 1.10: what FrameXmlActionRange's 0x7293d0 asks of the world, over the browser's own tables:
 * the reaction once the faction table is there (none before — nothing reads friendly), the
 * creature's type flags (CAN_ASSIST, TREAT_AS_RAID_UNIT). The range members are never read by it.
 */
const assistHost: ActionRangeHost = {
  object: (guid) => game.world?.state.objects.get(guid),
  reaction: (left, right) => (game.factions?.ready === true ? reactionBetween(left, right, game.factions) : undefined),
  creatureType: (unit) => (unit.typeId === 4 ? 7 : creatureTemplateOf(unit)?.creatureType ?? 0),
  creatureTypeFlags: (unit) => creatureTemplateOf(unit)?.flags ?? 0,
  get selfGuid() { return game.world?.state.selfGuid; },
  inParty: (guid) => groupMemberIn(guid, true),
  inRaid: (guid) => groupMemberIn(guid, false),
  rangedModRange: () => undefined,
  playerSpellFamily: () => undefined,
  spellModifiers: () => NO_MODIFIERS,
};

/** L2 1.10: a member of the player's group (not the player); `party` narrows a raid to the subgroup. */
function groupMemberIn(guid: bigint, party: boolean): boolean {
  const group = game.world?.group;
  if (!group) return false;
  for (const member of group.members) {
    if (member.guid !== guid) continue;
    return !party || (group.groupType & GROUPTYPE_RAID) === 0 || member.subGroup === group.ownSubGroup;
  }
  return false;
}

/**
 * L15 5.05: the autoRangedCombat spell's range for the player against a target (WorldClient
 * `autoRangedLimits`, world/AutoRangedCombat.ts) — Wow.exe 0x00802c30 → 0x007ff480 as
 * FrameXmlActionRange.ts reads it, over the spell row and this file's reactions. `assistHost` knows no
 * ranged weapon (RangedModRange) and no SPELLMOD_RANGE, so a talent that lengthens Auto Shot is not
 * counted. Returns the range module's scratch object: no allocation per tick.
 */
export function autoRangedLimits(
  spellId: number, caster: WorldObjectState, target: WorldObjectState,
): { readonly min: number; readonly max: number } | undefined {
  const row = game.spells.get(spellId);
  return row === undefined ? undefined : actionRangeLimits(row, caster, target, assistHost);
}

/** L2 1.10: 0x7293d0(player, unit, 0) — the player can assist the unit, immunities in force. */
export function canAssistUnit(object: WorldObjectState): boolean {
  const self = player();
  return self !== undefined && (object.typeId === 3 || object.typeId === 4)
    && actionRangeCanAssist(self, object, false, assistHost);
}

/** L2 1.10: what the TargetNearest* filters ask (game/TargetNearestModes.ts), over the browser game. */
const nearestModeHost: NearestModeHost = {
  tabEnemy: isTabTarget,
  canAssist: canAssistUnit,
  get selfGuid() { return game.world?.state.selfGuid; },
  inParty: (guid) => groupMemberIn(guid, true),
  inGroup: (guid) => groupMemberIn(guid, false),
};

/**
 * L2 1.10: SetTarget 0x524bf0's judgement of a new selection for the history (world/TargetHistory.ts):
 * an enemy when the player may attack it (0x729a70: alive and CanAttack — `canAttackUnit`), else a
 * friend when the player can assist it (0x7293d0), else neither.
 */
export function targetSelectionKind(object: WorldObjectState): TargetHistoryKind {
  if (object.typeId !== 3 && object.typeId !== 4) return undefined;
  if (canAttackUnit(object)) return "enemy";
  return canAssistUnit(object) ? "friend" : undefined;
}

// L2 1.10: the world client judges every selection with the browser's tables from now on.
setTargetHistoryJudge(targetSelectionKind);

/** The focus target: a second unit the player keeps an eye on, kept here until a frame shows it. */
export function setFocusToTarget(): void {
  game.focusGuid = game.world?.targetGuid;
}

/** The stock UI's `FocusUnit`/`ClearFocus` (FrameXmlTargetingApi.ts): the same focus, by guid. */
export function setFocusGuid(guid: bigint | undefined): void {
  game.focusGuid = guid;
}

export function focusUnit(): WorldObjectState | undefined {
  const world = game.world;
  if (!world || game.focusGuid === undefined) return undefined;
  return world.state.objects.get(game.focusGuid);
}

/**
 * Lets go of a unit that has just told the people around it to stop keeping an eye on it.
 *
 * `SMSG_BREAK_TARGET`, which the world client cannot answer itself: the focus is a thing the
 * interface keeps and the world client has never heard of, so the packet is announced and answered
 * here. The two halves of `SPELL_EFFECT_FORCE_DESELECT` have to move together — a fear that took
 * the selection and left the focus pointed at the same caster is the half-done version of the
 * effect — and this is the half that is the focus's. The selection is the other packet's,
 * `SMSG_CLEAR_TARGET`, because this one is broadcast to bystanders as well when a passenger boards
 * a vehicle (`Unit::SendClearTarget`, `Vehicle.cpp:933`).
 */
export function clearFocusOn(guid: bigint): void {
  if (game.focusGuid === guid) game.focusGuid = undefined;
}

/**
 * How far short of a body the sight line stops, in yards.
 *
 * A unit standing against a wall, in a doorway or on a bridge has that geometry within arm's reach
 * of its own chest, and a line drawn all the way to the chest meets it. Stopping short is the
 * difference between "there is a building between us" and "they are standing next to a building".
 */
const SIGHT_MARGIN = 1.2;

/**
 * Whether a straight line from the camera to this unit is clear of the world.
 *
 * There has never been a visibility test here at all, and the forgiving click made its absence
 * worse rather than better: with a 12px slop around every box, a miss near a wall now reaches
 * more eagerly for whoever is standing behind it. One ray per click, not per frame — this runs
 * when a button is released and nowhere else.
 *
 * The line is aimed at the chest rather than the feet, because the feet are inside the floor the
 * unit is standing on, and every shot at them would report the floor.
 *
 * Anything unknown answers "visible". The collision world is streamed and it is empty for the
 * first seconds in a zone; a veto that fired on missing data would make the client unclickable
 * exactly when the player is most likely to be clicking.
 */
export function inSightFromCamera(guid: bigint): boolean {
  const world = game.world;
  const collision = game.collision?.world;
  if (!world || !collision || collision.size === 0) return true;
  const target = world.state.objects.get(guid);
  // 11.02-tails: a vehicle passenger is aimed at where its model sits on the seat (one call per click).
  const position = target === undefined ? undefined : drawnUnitPosition(target, { x: 0, y: 0, z: 0 });
  if (!position) return true;
  const self = world.state.selfGuid;
  if (guid === self) return true;
  // 11.02-I: the camera's subject (ViewSubject.ts): a possessed unit or a far sight eye once in view.
  const player = viewSubjectPosition(world);
  if (!player) return true;

  // The camera the world was last drawn with, down to the tilt a floor granted: the ray has to
  // leave from where the click was aimed from, not from where the drag asked to be.
  const camera = createCamera(player, game.camera.yaw, game.camera.viewPitch, game.camera.view,
    { pivotHeight: cameraPivotHeight() });
  const height = game.renderer?.unitHeight(guid) ?? 2;
  const chest = { x: position.x, y: position.y, z: position.z + height * 0.6 };
  const dx = chest.x - camera.position.x;
  const dy = chest.y - camera.position.y;
  const dz = chest.z - camera.position.z;
  const length = Math.hypot(dx, dy, dz);
  // Nose to nose with it. There is nothing left of the segment to test and no room for a wall.
  if (length <= SIGHT_MARGIN) return true;
  const stop = 1 - SIGHT_MARGIN / length;
  const to = {
    x: camera.position.x + dx * stop,
    y: camera.position.y + dy * stop,
    z: camera.position.z + dz * stop,
  };
  return collision.firstHit(camera.position, to) === undefined;
}
