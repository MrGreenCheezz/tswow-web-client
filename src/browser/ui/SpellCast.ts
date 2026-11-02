/**
 * Casting a spell the way the client's own buttons do: the local preflight the book, the bars, the
 * stock CastSpell and the chat's `/cast` share, then the world's request. No page.
 */

import { MELEE_AUTO_ATTACK_SPELL_ID } from "../../world/WorldClient.js";
import { game } from "../game/Context.js";
import { armItemTarget, isItemTargetSpell, spellTargetsObject } from "../game/SpellCursor.js";
import { beginGroundTarget, cancelGroundTarget, isGroundTargetSpell } from "../game/GroundTarget.js";
import { castOnMainHandWeapon } from "../game/MainHandEnchant.js"; // 05.10-2.05
import { spellButtonUsable } from "../SpellMetadata.js";
import { refuseSpellOnCooldown, spellCastBlockReason, spellCastRefusedNotReady } from "../SpellCastGuard.js"; // 3.47: + the refusal
import { notice } from "./Notices.js";
import { openProfession } from "./ProfessionCraft.js";
import { professionOpener, professionSpellSkill } from "./ProfessionRules.js";
import { spellBookStatus } from "./SpellData.js";

export function castSpell(spellId: number, explicitUnitTarget?: bigint): boolean {
  const world = game.world;
  if (!world || world.state.selfGuid === undefined) return false;
  const profession = game.spells.get(spellId);
  // A named macro target is safe only for the DBC shapes the gateway has classified as a single
  // direct unit. Ground/item/mixed casts still use their own selection flow.
  if (explicitUnitTarget !== undefined
    && (profession?.unitTargetContractVersion !== 1 || profession.supportsExplicitUnitTarget !== true)) {
    return false;
  }
  if (explicitUnitTarget !== undefined) {
    const object = world.state.objects.get(explicitUnitTarget);
    if (object?.typeId !== 3 && object?.typeId !== 4) return false;
  }
  if (professionOpener(profession) && profession) {
    const skill = professionSpellSkill(profession, game.talentData);
    return skill !== undefined && openProfession(skill);
  }
  // Attack is a client action, not a learned spell. Trinity does not normally include row 6603 in
  // INITIAL_SPELLS, and it has no metadata preflight: WorldClient maps it to ATTACK_SWING/STOP.
  if (spellId === MELEE_AUTO_ATTACK_SPELL_ID) {
    world.castSpell(spellId);
    return true;
  }
  // Reapplying the active mount is a dismount toggle, not a new spell cast. It must remain
  // clickable while the old mount's recovery or the global cooldown is still visible locally.
  const togglingMount = typeof world.isActiveMountSpell === "function"
    && world.isActiveMountSpell(spellId);
  if (!togglingMount && world.cooldownRemaining(spellId, performance.now()) > 0) {
    refuseSpellOnCooldown(world, spellId); // 5.05 (11.10): the wand rule (0x00808200); 3.47 (12.10): + its words
    return false;
  }
  const metadata = game.spells.get(spellId);
  if (!world.knownSpells.some((spell) => spell.id === spellId)) return false;
  if (!metadata) {
    const message = "Данные заклинания загружаются…";
    spellBookStatus(message, "muted");
    notice(message, "info");
    return false;
  }
  if (!spellButtonUsable(metadata)) {
    const message = "Пассивное заклинание нельзя применить";
    spellBookStatus(message, "error");
    notice(message);
    return false;
  }
  // The book, tracker, talent window and module actions share the same local preflight. WorldClient
  // intentionally cannot inspect DBC/UI metadata, so it must only handle the final wire request.
  const blocked = spellCastBlockReason(world, spellId);
  if (blocked !== undefined) {
    // 5.05 (11.10): a cooldown, a hold or the global cooldown is the client's own NOT_READY, which Wow.exe hands to
    // 0x00808200 like the realm's: a wand's repeat stops, so the next press casts. 3.47 (12.10): and it says so, as
    // 0x00808200 does (SpellCastGuard.ts `refuseSpellOnCooldown`).
    if (spellCastRefusedNotReady(blocked)) refuseSpellOnCooldown(world, spellId, metadata);
    return false;
  }
  // Area spells do not take the selection: arm the reticle and let the click choose the point.
  // Every guard above has already passed, so the targeting mode never opens for a blocked cast.
  if (isGroundTargetSpell(metadata)) {
    if (!beginGroundTarget(spellId)) return false;
    notice("Кликните по земле для выбора точки · правый клик или Esc — отмена", "info");
    return true;
  }
  // Disenchant, Prospecting, Milling, Feed Pet wait for the item they go on (2.05, SpellCursor.ts).
  if (explicitUnitTarget === undefined && isItemTargetSpell(metadata)) {
    cancelGroundTarget();
    // 05.10-2.05: a SPELL_ATTR0_TARGET_MAINHAND_ITEM imbue picks the worn weapon itself (MainHandEnchant.ts).
    if (castOnMainHandWeapon(world, spellId, undefined, metadata)) return true;
    if (!armItemTarget(world, spellId, undefined, spellTargetsObject(metadata))) return false;
    notice("Выберите предмет · правый клик или Esc — отмена", "info");
    return true;
  }
  const cooldown = Math.max(metadata.recoveryTime, metadata.categoryRecoveryTime);
  // The world matches the request and emits SPELL_CAST_ACCEPTED only after the realm accepts it.
  // GCD bookkeeping is bound once when the world is entered; a per-click listener could survive a
  // failure and fire for a later cast of the same spell.
  if (explicitUnitTarget === undefined) world.castSpell(spellId, cooldown, metadata.cooldownStartedOnEvent);
  else world.castSpell(spellId, cooldown, metadata.cooldownStartedOnEvent, explicitUnitTarget);
  return true;
}
