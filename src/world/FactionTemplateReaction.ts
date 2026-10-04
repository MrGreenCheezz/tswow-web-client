/**
 * D3 (04.10, the owner's decision on 5.05): how Wow.exe 3.3.5a 12340 compares two FactionTemplate rows —
 * 0x00715440(viewer, target) (Ghidra read-only: .runtime/re-2026-10-04/l18-wiring/h1.c; callers and
 * directions .runtime/re-2026-10-04/d3-factions/g1.c-g3.c). FactionRules.ts `reactionBetween` asks it.
 *
 * The answer is a ReputationRank — hostile 1, neutral 3, friendly 4 — decided by the first test that holds:
 * 1. the viewer's EnemyGroup meets the target's FactionGroup → hostile. Before any list, so a Friend entry
 *    cannot cancel it (TrinityCore's IsHostileTo reads the lists first, DBCStructure.h:715-726);
 * 2. the viewer's Enemies name the target's faction → hostile;
 * 3. the viewer's FriendGroup meets the target's FactionGroup → friendly;
 * 4. the viewer's Friend list names the target's faction → friendly;
 * 5. the target's FriendGroup meets the viewer's FactionGroup → friendly;
 * 6. the target's Friend list names the viewer's faction → friendly (the target's Enemies are never read);
 * 7. otherwise hostile when the VIEWER's row has HOSTILE_BY_DEFAULT, else neutral.
 * Every list is read from its first slot and stops at the first empty one (a 0 never matches). The realm's
 * template part (Object.cpp:2967-2976) has steps 6 and 7 too and differs only in step 1's order.
 *
 * Who asks: 0x007251c0(viewer unit, target unit) → 0x0071f770(the viewer's template id, target unit) → here,
 * once nothing about a player target decided first (CONTESTED_GUARD, a forced rank, a reputation's rank);
 * 0x00718c20 (a unit's template against the active player's) the same. So UnitReaction 0x0060d280 is a's
 * view of b, UnitIsEnemy 0x0060d330 and UnitIsFriend 0x0060d3d0 (via 0x00514050) likewise, CanAttack
 * 0x00729740 the attacker's view, and the selection colour 0x00521bf0 / the plate 0x0098ee30 the unit's view
 * of the player.
 *
 * No allocation: asked for every unit in view on every frame (plates, Tab, the ring).
 */
import type { FactionTemplate } from "./FactionRules.js";

/** DBCEnums.h:323: nothing else decided — the template is hostile (Wow.exe: bit 13 of the row's Flags, +8). */
export const FACTION_TEMPLATE_FLAG_HOSTILE_BY_DEFAULT = 0x0000_2000;

/** The ranks 0x00715440 answers (SharedDefines.h ReputationRank: REP_HOSTILE, REP_NEUTRAL, REP_FRIENDLY). */
export const TEMPLATE_RANK_HOSTILE = 1;
export const TEMPLATE_RANK_NEUTRAL = 3;
export const TEMPLATE_RANK_FRIENDLY = 4;

/** At most four ids per list (MAX_FACTION_RELATIONS); the walk ends at the first empty slot. */
function names(list: readonly number[], faction: number): boolean {
  const count = list.length < 4 ? list.length : 4;
  for (let index = 0; index < count; index++) {
    const id = list[index];
    if (id === 0) return false;
    if (id === faction) return true;
  }
  return false;
}

/**
 * 0x00715440: the viewer's rank towards the target. `viewer.flags` undefined (a gateway that serves
 * /dbc/factions before v=3, without FactionTemplate.Flags) leaves step 7 neutral, as before D3.
 */
export function factionTemplateRank(viewer: FactionTemplate, target: FactionTemplate): number {
  if ((viewer.enemyGroup & target.factionGroup) !== 0) return TEMPLATE_RANK_HOSTILE;
  if (names(viewer.enemies, target.faction)) return TEMPLATE_RANK_HOSTILE;
  if ((viewer.friendGroup & target.factionGroup) !== 0) return TEMPLATE_RANK_FRIENDLY;
  if (names(viewer.friends, target.faction)) return TEMPLATE_RANK_FRIENDLY;
  if ((target.friendGroup & viewer.factionGroup) !== 0) return TEMPLATE_RANK_FRIENDLY;
  if (names(target.friends, viewer.faction)) return TEMPLATE_RANK_FRIENDLY;
  return ((viewer.flags ?? 0) & FACTION_TEMPLATE_FLAG_HOSTILE_BY_DEFAULT) !== 0 ? TEMPLATE_RANK_HOSTILE : TEMPLATE_RANK_NEUTRAL;
}
