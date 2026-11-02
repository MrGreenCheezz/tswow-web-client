/**
 * The craft queue behind whichever window shows it: casting a recipe, following its cast and sending
 * the next one. The stock TradeSkillFrame drives it through FrameXmlTradeSkillLive.ts; the HTML craft
 * windows (Professions.ts) follow it through HtmlWindowHosts.ts. No page here.
 */

import { openFrameXmlTradeSkill } from "../framexml/FrameXmlTradeSkillController.js";
import { game } from "../game/Context.js";
import { requestSpellCast } from "../game/GroundTarget.js";
import { entryOf, playerInventory, stackCount, type ItemSlotState } from "../Inventory.js";
import { spellCastBlockReason } from "../SpellCastGuard.js";
import type { SpellMetadata } from "../SpellMetadata.js";
import { professionWindows } from "./HtmlWindowHosts.js";
import { notice } from "./Notices.js";
import { craftableCount, learnedProfessions, professionRecipe, recipeAcceptsItem, recipeRequiresItem } from "./ProfessionRules.js";
import { readSkills, type SkillEntry } from "./Skills.js";

const craftChanged = (force: boolean): void => professionWindows()?.changed(force);

let craftWorld: typeof game.world;
let craftSubscriptions: Array<() => void> = [];
let pendingCraft: number | undefined;
let craftFeedback = "";
let craftTimeout: ReturnType<typeof setTimeout> | undefined;
/**
 * How many more times the current recipe should be sent after the cast in flight.
 *
 * Set when the player asks for more than one, consumed one per successful finish
 * (`SPELL_CAST_STOP` with success, or `SPELL_GO` for instant recipes). Any refusal —
 * `professionCastStatus`, an interrupted stop, a closed window — clears it, so a queue never
 * outlives the reason it stopped.
 */
let craftQueue: { spellId: number; left: number; target?: bigint | undefined } | undefined;
/** How many times to offer at most in one queue. Enough for a stack, short enough to stay sane. */
export const CRAFT_QUEUE_MAX = 20;
/**
 * The ceiling the queue itself accepts. The native count box clamps to {@link CRAFT_QUEUE_MAX}
 * before it gets here; the stock TradeSkillFrame's three-digit box (`letters="3"`) and its
 * «Создать все» hand over up to 999, clamped to what the bags can complete.
 */
const CRAFT_REPEAT_MAX = 999;

/** The queue as the window sees it, for tests and for the status line. */
export function craftQueueState(): { spellId: number; left: number } | undefined {
  return craftQueue === undefined ? undefined : { spellId: craftQueue.spellId, left: craftQueue.left };
}

export function knownMetadata(): SpellMetadata[] {
  return (game.world?.knownSpells ?? []).map(({ id }) => game.spells.get(id))
    .filter((spell): spell is SpellMetadata => spell !== undefined);
}

export function currentProfessions(): SkillEntry[] {
  const world = game.world;
  const self = world?.state.selfGuid === undefined ? undefined : world.state.objects.get(world.state.selfGuid);
  return self ? learnedProfessions(readSkills(self), knownMetadata(), game.talentData) : [];
}

/** What the windows show of the queue. */
export function professionCraftStatus(): { pending: number | undefined; queue: { spellId: number; left: number } | undefined; feedback: string } {
  return { pending: pendingCraft, queue: craftQueueState(), feedback: craftFeedback };
}

/** The world the queue follows, until {@link closeProfessionCraft}. */
export function craftTrackedWorld(): typeof game.world {
  return craftWorld;
}

/** Leaving the world or the character: the queue, its tracking and the windows with it. */
export function closeProfessionCraft(): void {
  for (const unsubscribe of craftSubscriptions) unsubscribe();
  craftSubscriptions = [];
  if (craftTimeout !== undefined) clearTimeout(craftTimeout);
  craftTimeout = undefined;
  pendingCraft = undefined;
  craftQueue = undefined;
  craftFeedback = "";
  professionWindows()?.closed();
  craftWorld = undefined;
}

/** The realm's normal cast refusal also belongs beside the recipe that initiated it. */
export function professionCastStatus(message: string, error: boolean): void {
  if (pendingCraft === undefined || !error) return;
  pendingCraft = undefined;
  craftQueue = undefined;
  craftFeedback = message;
  if (craftTimeout !== undefined) clearTimeout(craftTimeout);
  craftChanged(true);
}

/** False, and says the one thing that can make it fail while something still lists the line. */
export function professionStillLearned(skillId: number): boolean {
  if (currentProfessions().some((skill) => skill.skillId === skillId)) return true;
  // A silent refusal reads as a dead button.
  notice("Эта профессия больше не изучена");
  return false;
}

/**
 * Every route into a profession ends here: the opener spell from either spellbook or an action
 * button, and the HTML skills pane's «Открыть». The stock TradeSkillFrame answers once the world mount
 * has published it (FrameXmlTradeSkillController.ts); until then nothing the player can see opens.
 */
export function openProfession(skillId: number): boolean {
  if (openFrameXmlTradeSkill(skillId)) return true;
  return professionStillLearned(skillId) && (professionWindows()?.open(skillId) ?? false);
}

/**
 * Follow the current world's craft casts: the START/STOP/GO edges that move the queue on. Shared by
 * the native window and the stock TradeSkillFrame's craft hooks below.
 */
export function ensureCraftTracking(): void {
  if (craftWorld !== undefined && craftWorld !== game.world) closeProfessionCraft();
  craftWorld = game.world;
  if (craftSubscriptions.length === 0 && craftWorld) {
    const world = craftWorld;
    craftSubscriptions.push(world.events.on("SPELL_CAST_START", ({ casterGuid, spellId }) => {
      if (game.world !== world || casterGuid !== world.state.selfGuid || pendingCraft !== spellId) return;
      craftFeedback = "Создание…";
      craftChanged(true);
    }), world.events.on("SPELL_CAST_STOP", ({ casterGuid, spellId, reason }) => {
      if (game.world !== world || casterGuid !== world.state.selfGuid || pendingCraft !== spellId) return;
      pendingCraft = undefined;
      if (craftTimeout !== undefined) clearTimeout(craftTimeout);
      if (reason === "success") continueCraftQueue(spellId);
      else {
        craftQueue = undefined;
        craftFeedback = "Создание прервано.";
        craftChanged(true);
      }
    }), world.events.on("SPELL_GO", ({ casterGuid, casterUnit, spellId }) => {
      // Instant recipes have GO without START and therefore no active cast to stop.
      if (game.world !== world || pendingCraft !== spellId
        || (casterGuid !== world.state.selfGuid && casterUnit !== world.state.selfGuid)) return;
      pendingCraft = undefined;
      if (craftTimeout !== undefined) clearTimeout(craftTimeout);
      continueCraftQueue(spellId);
    }));
  }
}

/** A recipe spell the character knows, which is all the craft hooks below will cast. */
function knownRecipe(spell: SpellMetadata | undefined): spell is SpellMetadata {
  return professionRecipe(spell) && (game.world?.knownSpells.some(({ id }) => id === spell!.id) ?? false);
}

/**
 * The stock TradeSkillFrame's DoTradeSkill (FrameXmlTradeSkill.ts): `count` casts of a known recipe
 * through the same queue, preflight and cast tracking as «Создать», clamped to what the bags can
 * complete. A missing tool is left to the realm's answer, as the stock button leaves it. False when
 * nothing was sent.
 */
export function craftProfessionRecipe(spellId: number, count: number): boolean {
  const spell = game.spells.get(spellId);
  if (!game.world || !knownRecipe(spell) || recipeRequiresItem(spell)) return false;
  ensureCraftTracking();
  const available = craftableCount(spell, carriedCounts(carriedSlots()));
  if (available === undefined || available <= 0) return false;
  const wanted = Math.max(1, Math.min(CRAFT_REPEAT_MAX, Math.floor(count) || 1));
  return sendProfessionCast(spell, undefined, available === Infinity ? wanted : Math.min(wanted, available));
}

/** The stock enchant cursor's click: one cast of an enchant recipe on a carried item. */
export function castProfessionRecipeOnItem(spellId: number, itemGuid: bigint): boolean {
  const spell = game.spells.get(spellId);
  if (!game.world || !knownRecipe(spell) || !recipeRequiresItem(spell)) return false;
  ensureCraftTracking();
  if ((craftableCount(spell, carriedCounts(carriedSlots())) ?? 0) <= 0) return false;
  return sendProfessionCast(spell, itemGuid, 1);
}

/**
 * One known enchant on the trader's «will not be traded» slot (the stock TradeFrame's
 * `ClickTargetTradeButton(7)` with the enchant waiting): `CMSG_CAST_SPELL` with TARGET_FLAG_TRADE_ITEM
 * and slot 6 (WorldClient.castSpellOnTradeSlot). The realm parks it in the trade until both accept.
 */
export function castProfessionRecipeOnTradeSlot(spellId: number): boolean {
  const spell = game.spells.get(spellId);
  if (!game.world?.tradeOpen || !knownRecipe(spell) || !recipeRequiresItem(spell)) return false;
  ensureCraftTracking();
  if ((craftableCount(spell, carriedCounts(carriedSlots())) ?? 0) <= 0) return false;
  return sendProfessionCast(spell, TRADE_SLOT_TARGET, 1);
}

/** StopTradeSkillRepeat: the queue ends after the cast in flight, which stays the server's to finish. */
export function stopProfessionCraftRepeat(): void {
  if (craftQueue === undefined) return;
  craftQueue = undefined;
  craftChanged(true);
}

/** GetTradeskillRepeatCount's source: the casts still to go, the one in flight included. */
export function professionCraftRemaining(): number {
  return (pendingCraft !== undefined ? 1 : 0) + (craftQueue?.left ?? 0);
}

/** «Остановить очередь»: the queue ends, and the cast in flight with it. */
export function cancelProfessionCraftQueue(): void {
  craftQueue = undefined;
  craftFeedback = "Очередь остановлена.";
  game.world?.cancelSpellCast();
  craftChanged(true);
}

export function carriedSlots(): ItemSlotState[] {
  const inventory = game.world && playerInventory(game.world.state);
  return inventory ? [...inventory.equipment, ...inventory.backpack, ...inventory.bags.flatMap((bag) => bag.slots)] : [];
}

export function carriedCounts(slots: readonly ItemSlotState[]): Map<number, number> {
  const owned = new Map<number, number>();
  for (const slot of slots) {
    const entry = entryOf(slot.item);
    if (entry > 0) owned.set(entry, (owned.get(entry) ?? 0) + stackCount(slot));
  }
  return owned;
}

/**
 * Sends the next cast of a finished queue, or finishes it with words.
 *
 * Called with `pendingCraft` already cleared by the STOP/GO handler. The server still owns every
 * verdict — this only revalidates against the fresh inventory so a queue that would instantly
 * fail stops with «реагенты закончились» instead of spending a round trip per missing herb.
 */
function continueCraftQueue(spellId: number): void {
  const queue = craftQueue;
  craftQueue = undefined;
  if (!queue || queue.spellId !== spellId || queue.left <= 0) {
    craftFeedback = "Действие выполнено.";
    craftChanged(true);
    return;
  }
  const world = game.world;
  const spell = game.spells.get(spellId);
  if (!world || !spell) {
    craftFeedback = "Очередь остановлена: рецепт недоступен.";
    craftChanged(true);
    return;
  }
  const counts = carriedCounts(carriedSlots());
  if ((craftableCount(spell, counts) ?? 0) <= 0 || (spell.tools ?? []).some((tool) => !counts.has(tool))) {
    craftFeedback = "Очередь остановлена: недостаточно реагентов.";
    craftChanged(true);
    return;
  }
  if (!sendProfessionCast(spell, queue.target, queue.left)) {
    craftFeedback = "Очередь остановлена.";
    craftChanged(true);
  }
  // On success `sendProfessionCast` armed the fresh queue and refreshed already.
}

/** `sendProfessionCast`'s target for the trader's seventh slot rather than a carried item. */
const TRADE_SLOT_TARGET = "trade-slot";

export function sendProfessionCast(spell: SpellMetadata, target?: bigint | typeof TRADE_SLOT_TARGET, count = 1): boolean {
  const world = game.world;
  if (!world || pendingCraft !== undefined || spellCastBlockReason(world, spell.id) !== undefined
    || (world.state.selfGuid !== undefined && world.casts.has(world.state.selfGuid))) return false;
  const cooldown = Math.max(spell.recoveryTime, spell.categoryRecoveryTime);
  if (target === TRADE_SLOT_TARGET) {
    if (!world.castSpellOnTradeSlot(spell.id, cooldown, spell.cooldownStartedOnEvent)) return false;
    pendingCraft = spell.id;
  } else if (recipeRequiresItem(spell)) {
    const slot = carriedSlots().find((entry) => entry.guid === target);
    const template = slot?.item && world.itemTemplate(entryOf(slot.item));
    if (target === undefined || !template?.found || !recipeAcceptsItem(spell, template)) return false;
    pendingCraft = spell.id;
    world.castSpellOnItem(spell.id, target, cooldown, spell.cooldownStartedOnEvent);
  } else {
    requestSpellCast(spell.id, () => {
      pendingCraft = spell.id;
      world.castSpell(spell.id, cooldown, spell.cooldownStartedOnEvent);
    });
  }
  // A ground-target recipe arms the reticle instead of sending: the closure above never ran, so
  // there is no cast in flight and nothing for a queue to follow.
  if (pendingCraft === spell.id) {
    const left = Math.max(0, Math.min(CRAFT_REPEAT_MAX, Math.floor(count) || 1) - 1);
    craftQueue = left > 0 && target !== TRADE_SLOT_TARGET ? { spellId: spell.id, left, target } : undefined;
  } else craftQueue = undefined;
  craftFeedback = "Запрос отправлен. Ожидаем ответ сервера…";
  craftTimeout = setTimeout(() => {
    if (game.world === world && pendingCraft === spell.id && !world.casts.has(world.state.selfGuid!)) {
      pendingCraft = undefined;
      craftFeedback = "Ответ не получен. Можно повторить создание.";
      craftChanged(false);
    }
  }, 10000);
  craftChanged(false);
  return true;
}
