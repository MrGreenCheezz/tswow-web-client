import { UPDATE_FIELDS } from "../generated/updateFields.js";
import { REACTION_NEUTRAL } from "./FactionRules.js";
import type { WorldObjectState } from "./WorldState.js";

/*
 * 11.02-tails (5.05): whether a right click may hand a live unit to the interaction chain — Wow.exe
 * 3.3.5a 12340, Ghidra read-only, .runtime/re-2026-10-03/l1102bcd-review/r1.c, r2.c.
 *
 * The right click on a unit (0x00731260): a dead one takes the loot and skinning branch; a live one
 * goes to the interaction chain 0x006ddbb0 (gossip, quests, services, spell click, a group member's
 * vehicle, the mailbox — `interactWithGuid` and VehicleClick.ts) only when 0x00729530(player, unit)
 * answers yes; otherwise it is attacked when 0x00729a70 (CanAttack 0x00729740 plus the mount rules)
 * allows it, and nothing happens when it does not. 0x00729530, in its order:
 * 1. A player who is a ghost (PLAYER_FLAGS 0x10) talks only to a creature whose cached template
 *    carries CREATURE_TYPE_FLAG_VISIBLE_TO_GHOSTS 0x2 — never to a unit without a creature cache
 *    entry (a player). The core refuses the same (Player::GetNPCIfCanInteractWith, Player.cpp:2301).
 * 2. A gossip creature (UNIT_NPC_FLAG_GOSSIP 0x1) whose cached template carries
 *    CREATURE_TYPE_FLAG_INTERACT_ONLY_WITH_CREATOR 0x800000 is the player's to talk to only when its
 *    UNIT_FIELD_CREATEDBY is the player.
 * 3. A unit with UNIT_FLAG_UNINTERACTIBLE 0x02000000 (TrinityCore's name for NOT_SELECTABLE) or with
 *    no NPC flag at all never is.
 * 4. Otherwise yes when both reactions — the unit's to the player and the player's to the unit
 *    (0x007251c0 called both ways) — are neutral or better, or when the unit carries
 *    UNIT_FLAG2_ALLOW_ENEMY_INTERACT 0x4000 whatever the reactions (an NPCBot for hire sets it,
 *    bot_ai.cpp:476, and the core lets anyone talk to a bot, Player.cpp:2316-2318).
 *
 * One deviation: Wow.exe always holds the creature's template once the unit is in view; this client
 * asks for it on demand, so a template not cached yet is not read as "no cache" for rule 1 — the
 * click keeps what it did before (rule 2 needs the template in Wow.exe too).
 */

/** PLAYER_FLAGS_GHOST, Player.h:358. */
const PLAYER_FLAGS_GHOST = 0x0000_0010;
/** UNIT_NPC_FLAG_GOSSIP, UnitDefines.h:237. */
const UNIT_NPC_FLAG_GOSSIP = 0x0000_0001;
/** UNIT_FLAG_UNINTERACTIBLE, UnitDefines.h:160. */
const UNIT_FLAG_UNINTERACTIBLE = 0x0200_0000;
/** UNIT_FLAG2_ALLOW_ENEMY_INTERACT, UnitDefines.h:198. */
const UNIT_FLAG2_ALLOW_ENEMY_INTERACT = 0x0000_4000;
/** CreatureTypeFlags, SharedDefines.h:2726 and :2748. */
export const CREATURE_TYPE_FLAG_VISIBLE_TO_GHOSTS = 0x0000_0002;
export const CREATURE_TYPE_FLAG_INTERACT_ONLY_WITH_CREATOR = 0x0080_0000;

const TYPEID_PLAYER = 4;
const NPC_FLAGS = UPDATE_FIELDS.UNIT_NPC_FLAGS.offset;
const FLAGS = UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset;
const FLAGS_2 = UPDATE_FIELDS.UNIT_FIELD_FLAGS_2.offset;
const CREATED_BY = UPDATE_FIELDS.UNIT_FIELD_CREATEDBY.offset;
const PLAYER_FLAGS = UPDATE_FIELDS.PLAYER_FLAGS.offset;

/** Whether a two-word guid field holds `guid` (asked on a click, never per frame). */
function guidFieldIs(object: WorldObjectState, offset: number, guid: bigint): boolean {
  const low = object.fields.get(offset) ?? 0;
  const high = object.fields.get(offset + 1) ?? 0;
  return (BigInt(high >>> 0) << 32n | BigInt(low >>> 0)) === guid;
}

/** UNIT_FLAG2_IGNORE_REPUTATION, UnitDefines.h:186. */
const UNIT_FLAG2_IGNORE_REPUTATION = 0x0000_0004;

/** The part of the `/dbc/reputation` catalog read here: each reputation list slot's Faction.dbc id. */
export interface ReputationFactionList {
  readonly factions: Readonly<Record<string, { readonly factionId: number }>>;
}

/** The Faction.dbc ids that keep a reputation, once per catalog object (read on a click, never per frame). */
const reputationFactions = new WeakMap<ReputationFactionList, ReadonlySet<number>>();

function factionsWithReputation(catalog: ReputationFactionList): ReadonlySet<number> {
  let ids = reputationFactions.get(catalog);
  if (ids === undefined) {
    const set = new Set<number>();
    for (const key in catalog.factions) {
      const id = catalog.factions[key]?.factionId;
      if (id !== undefined) set.add(id);
    }
    ids = set;
    reputationFactions.set(catalog, ids);
  }
  return ids;
}

/**
 * 11.02-tails-review: whether Wow.exe reads this unit's two reactions off the faction template masks —
 * the only reactions this client has — so that rule 4 may be judged on them.
 *
 * Both directions of 0x007251c0 leave the masks for a faction that keeps a reputation (0x00718b30:
 * Faction.dbc ReputationIndex ≥ 0; .runtime/re-2026-10-03/l1102tails-review/r1.c): the player's view
 * of the unit (the branch at 0x007253ca) is a forced reaction (0x005d06a0), else hostile when the
 * player is at war with the faction (0x005d04b0) and friendly otherwise; the unit's view of the player
 * (0x0071f770) is a forced reaction, else the player's rank with it (0x005d0600). The player's
 * UNIT_FLAG2_IGNORE_REPUTATION 0x4 sends both back to the masks. So for Sons of Hodir, whose template
 * every player race hates, the masks would refuse a player who stands Friendly; for such a unit rule 4
 * is not this client's to answer and the click stays what it was.
 *
 * `factionId` is the unit's FactionTemplate.Faction (undefined without a row: the reactions read
 * neutral then). A forced reaction for the faction (`forced`, keyed by Faction id) is read first by
 * Wow.exe and by `reactionBetween` alike. Without the catalog nothing tells which factions keep a
 * reputation: "not by the masks".
 */
export function reactionsByTemplate(
  self: WorldObjectState | undefined,
  factionId: number | undefined,
  catalog: ReputationFactionList | undefined,
  forced: ReadonlyMap<number, number> | undefined,
): boolean {
  if (factionId === undefined) return true;
  if (forced !== undefined && forced.has(factionId)) return true;
  if (self !== undefined && ((self.fields.get(FLAGS_2) ?? 0) & UNIT_FLAG2_IGNORE_REPUTATION) !== 0) return true;
  if (catalog === undefined) return false;
  return !factionsWithReputation(catalog).has(factionId);
}

/**
 * Wow.exe 0x00729530: whether the player may talk to this unit (see the header).
 *
 * `toUnit` is the player's reaction to it, `fromUnit` its reaction to the player (REACTION_* of
 * FactionRules.ts). `creatureTypeFlags` is the unit's cached creature template's `flags`, undefined
 * when the unit is a player or its template is not cached yet.
 */
export function canInteractWithUnit(
  self: WorldObjectState | undefined,
  object: WorldObjectState,
  toUnit: number,
  fromUnit: number,
  creatureTypeFlags: number | undefined,
): boolean {
  const selfIsPlayer = self?.typeId === TYPEID_PLAYER;
  const unitIsPlayer = object.typeId === TYPEID_PLAYER;
  const npcFlags = object.fields.get(NPC_FLAGS) ?? 0;
  if (selfIsPlayer && ((self!.fields.get(PLAYER_FLAGS) ?? 0) & PLAYER_FLAGS_GHOST) !== 0) {
    if (unitIsPlayer) return false;
    if (creatureTypeFlags !== undefined && (creatureTypeFlags & CREATURE_TYPE_FLAG_VISIBLE_TO_GHOSTS) === 0) return false;
  }
  if ((npcFlags & UNIT_NPC_FLAG_GOSSIP) !== 0 && selfIsPlayer && !unitIsPlayer && creatureTypeFlags !== undefined
    && (creatureTypeFlags & CREATURE_TYPE_FLAG_INTERACT_ONLY_WITH_CREATOR) !== 0
    && !guidFieldIs(object, CREATED_BY, self!.guid)) return false;
  if (((object.fields.get(FLAGS) ?? 0) & UNIT_FLAG_UNINTERACTIBLE) !== 0 || npcFlags === 0) return false;
  if (toUnit >= REACTION_NEUTRAL && fromUnit >= REACTION_NEUTRAL) return true;
  return ((object.fields.get(FLAGS_2) ?? 0) & UNIT_FLAG2_ALLOW_ENEMY_INTERACT) !== 0;
}
