import { game } from "./Context.js";
import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import { worldObject } from "../../world/Fields.js";
import type { WorldObjectState } from "../../world/WorldState.js";
import { itemEnchantments } from "../ItemEnchantments.js";
import { itemRefundSecondsLeft, type ItemRefundInfo } from "../../world/ItemRefundProtocol.js";
import { enchantEndsBoundTrade } from "./BoundTradeable.js"; // L1 (2.05/3.22)

/**
 * The item-target spell cursor (plan item 2.05, mechanism M3): a spell or an item's own spell that
 * waits for the item it goes on — poisons, sharpening stones, oils, enchanting scrolls (the item's
 * spell, `CMSG_USE_ITEM`), Disenchant, Prospecting, Milling, Feed Pet (a book spell,
 * `CMSG_CAST_SPELL`). DOM-free; the stock seam, the native windows and the world canvas finish it.
 *
 * In the original client this is the one pending spell (Wow.exe `DAT_00d3f4e4`, asked by
 * 0x007fd620) with the target flags still missing (`DAT_00d3f4e0`). `SpellCanTargetItem` is that
 * pending spell with `mask & (ITEM | GAMEOBJECT_ITEM)` (0x007fdd10, 0x007fd760); a click on an item
 * fills TARGET_FLAG_ITEM and, the mask then empty, sends (0x0080bc80 → 0x0080ac90); the trade slot
 * fills TARGET_FLAG_TRADE_ITEM with slot 6 (0x0080c5f0). Before that send the client refuses some
 * items itself, keeping the cursor (0x005210d0) — the two rules this client can check without
 * guessing are {@link itemTargetRefusal}'s.
 *
 * The cursor enters only through the targeting contract (`requiredTargetMode === Item`, the gateway's
 * reading of `Spell.dbc` Targets 0x10, or `itemOrObject`), never an id list. Nothing goes to the
 * server until the click: cancelling sends nothing.
 *
 * `itemOrObject` (`/dbc/spells?v=14`) is «Взлом замка» and the keys and picks: OPEN_LOCK (33) with
 * ImplicitTargetA 26, TARGET_GAMEOBJECT_ITEM_TARGET, for which the client ORs TARGET_FLAG_GAMEOBJECT_ITEM
 * (0x4000) into the pending mask (0x00809610). Such a cursor also takes a game object in the world
 * (0x0080bc80: mask & 0x4800 → TARGET_FLAG_GAMEOBJECT), {@link targetGameObjectWithCursor}; a carried
 * item goes as TARGET_FLAG_ITEM (mask & 0x4010), like any other.
 */

/** Mirrors `SPELL_REQUIRED_TARGET_MODE.Item` from the gateway targeting contract (SpellMetadata.ts). */
export const ITEM_TARGET_MODE = 2;

/** `SPELL_EFFECT_PROSPECTING` and `SPELL_EFFECT_MILLING` (SharedDefines.h). */
const EFFECT_PROSPECTING = 127;
const EFFECT_MILLING = 158;
/** `ITEM_FLAG_IS_PROSPECTABLE` and `ITEM_FLAG_IS_MILLABLE` (ItemTemplate.h). */
const ITEM_FLAG_IS_PROSPECTABLE = 0x0004_0000;
const ITEM_FLAG_IS_MILLABLE = 0x2000_0000;
/** `SPELL_EFFECT_ENCHANT_ITEM`, `_ENCHANT_ITEM_TEMPORARY`, `_ENCHANT_ITEM_PRISMATIC` (SharedDefines.h). */
const EFFECT_ENCHANT_ITEM = 53;
const EFFECT_ENCHANT_ITEM_TEMPORARY = 54;
const EFFECT_ENCHANT_ITEM_PRISMATIC = 156;
/** `ENCHANTMENT_CAN_SOULBOUND` (DBCEnums.h:396): SpellItemEnchantment.Flags bit 0, record offset 0x40. */
export const ENCHANTMENT_CAN_SOULBOUND = 0x01;
/** `ITEM_FIELD_FLAG_SOULBOUND` (ItemTemplate.h): ITEM_FIELD_FLAGS bit 0. */
export const ITEM_FIELD_FLAG_SOULBOUND = 0x01;
/** `MAX_ENCHANTMENT_SLOT`: the twelve ITEM_FIELD_ENCHANTMENT_n triples 0x007073e0 walks. */
const ITEM_ENCHANTMENT_SLOTS = 12;
/** `TYPEID_GAMEOBJECT`. */
const TYPEID_GAMEOBJECT = 5;
/** `TRADE_SLOT_NONTRADED`: the trader's seventh slot, the one a trade enchant goes on. */
const TRADE_SLOT_NONTRADED = 6;

export interface ItemTargetSource {
  readonly bag: number;
  readonly slot: number;
  readonly guid: bigint;
}

export interface ItemTargetCursor {
  /** `item-use`: the source item's own spell (CMSG_USE_ITEM); `spell`: a known spell (CMSG_CAST_SPELL). */
  readonly kind: "item-use" | "spell";
  readonly spellId: number;
  readonly source?: ItemTargetSource | undefined;
  /** The pending mask holds TARGET_FLAG_GAMEOBJECT_ITEM: a game object in the world is a target too. */
  readonly orObject?: boolean | undefined;
}

interface ArmedCursor extends ItemTargetCursor {
  readonly world: object;
  readonly mapId: number | undefined;
}

/** What the world has to offer for the click; the live `WorldClient` has all of it. */
export interface ItemTargetWorld {
  readonly mapId?: number | undefined;
  readonly itemTemplates?: { get(entry: number): { flags?: number; inventoryType?: number } | undefined } | undefined;
  /** The world's objects, for the item a BIND_ENCHANT / REPLACE_ENCHANT prompt named. */
  readonly state?: {
    readonly objects: { get(guid: bigint): WorldObjectState | undefined };
    /** L1 (2.05/3.22): the player, the owner END_BOUND_TRADEABLE's trade window needs (0x00708b40). */
    readonly selfGuid?: bigint | undefined;
  } | undefined;
  useItemOnItem?(bag: number, slot: number, itemGuid: bigint, spellId: number, targetGuid: bigint): boolean;
  castSpellOnItem?(spellId: number, itemGuid: bigint, cooldownDuration?: number, cooldownStartedOnEvent?: boolean): void;
  castSpellOnTradeSlot?(spellId: number, cooldownDuration?: number, cooldownStartedOnEvent?: boolean): boolean;
  /** A known spell on a game object (TARGET_FLAG_GAMEOBJECT); false when nothing was sent. */
  castSpellOnGameObject?(spellId: number, objectGuid: bigint, cooldownDuration?: number, cooldownStartedOnEvent?: boolean): boolean;
  /** An item's own spell on a game object (CMSG_USE_ITEM, TARGET_FLAG_GAMEOBJECT). */
  useItemOnGameObject?(bag: number, slot: number, itemGuid: bigint, spellId: number, objectGuid: bigint): boolean;
  /** The trader's side of an open trade (`SMSG_TRADE_STATUS_EXTENDED`): its slot 6 item's enchant. */
  readonly theirOffer?: { readonly items: readonly { readonly slot: number; readonly enchantId: number }[] } | undefined;
  /** 2.10: purchase refund records (`WorldClient.itemRefunds`), for END_REFUND. */
  readonly itemRefunds?: { readonly info: { get(guid: bigint): ItemRefundInfo | undefined } } | undefined;
  /** Played seconds now (0x006cf440), for the refund window. */
  playedSecondsNow?(now?: number): number | undefined;
}

export interface ItemTargetSpellFacts {
  readonly requiredTargetMode?: number | undefined;
  /** OPEN_LOCK with ImplicitTargetA 26 (`/dbc/spells?v=14`): a carried item or a game object. */
  readonly itemOrObject?: boolean | undefined;
  readonly effects?: readonly number[] | undefined;
  readonly effectMiscValue?: readonly number[] | undefined;
  readonly recoveryTime?: number | undefined;
  readonly categoryRecoveryTime?: number | undefined;
  readonly cooldownStartedOnEvent?: boolean | undefined;
}

/**
 * The click's result: `none` — not the cursor's (nothing armed, an empty slot, a stale source):
 * the caller goes on with the click; `sent` — the spell went out and the cursor is down; `refused` —
 * the click is eaten and `error` names the GlobalStrings.lua message to show; the cursor stays,
 * except on the trade slot (see {@link targetTradeSlotWithCursor}); `confirm` — the client asks
 * first (`BIND_ENCHANT` and `REPLACE_ENCHANT` over an item, `TRADE_REPLACE_ENCHANT` over the trade
 * slot), nothing is sent, the cursor stays, and the answer is {@link bindEnchantWithCursor} /
 * {@link replaceEnchantWithCursor} / `targetTradeSlotWithCursor(…, true)`. BIND_ENCHANT carries no
 * names (its two are empty strings).
 */
export type ItemTargetOutcome =
  | { readonly kind: "none" }
  | { readonly kind: "sent" }
  | { readonly kind: "refused"; readonly error: string }
  | {
    readonly kind: "confirm";
    // L1 (2.05/3.22): END_BOUND_TRADEABLE, kind "itemenchant" (game/BoundTradeable.ts).
    readonly event: "BIND_ENCHANT" | "REPLACE_ENCHANT" | "TRADE_REPLACE_ENCHANT" | "END_REFUND" | "END_BOUND_TRADEABLE";
    readonly oldName: string;
    readonly newName: string;
  };

const NONE: ItemTargetOutcome = Object.freeze({ kind: "none" });
const SENT: ItemTargetOutcome = Object.freeze({ kind: "sent" });

let armed: ArmedCursor | undefined;
/**
 * The item the last REPLACE_ENCHANT prompt was raised for — the client's one stored guid
 * (Wow.exe `DAT_00bd08d8`, written by 0x005210d0 before 0x0081b530(0x18a)) that `ReplaceEnchant`
 * (0x005167a0) hands to 0x0080bc80 with whatever spell is pending then.
 */
let prompted: { readonly world: object; readonly guid: bigint } | undefined;
const observers = new Set<(armed: boolean) => void>();

function notify(value: boolean): void {
  for (const observer of [...observers]) {
    try { observer(value); } catch { /* a cursor picture is presentation; the state goes on */ }
  }
}

function drop(): boolean {
  if (!armed) return false;
  armed = undefined;
  notify(false);
  return true;
}

/** Whether the contract says the spell waits for an item — or, `itemOrObject`, an item or an object. */
export function isItemTargetSpell(
  metadata: { requiredTargetMode?: number | undefined; itemOrObject?: boolean | undefined } | undefined,
): boolean {
  return metadata?.requiredTargetMode === ITEM_TARGET_MODE || metadata?.itemOrObject === true;
}

/** Whether the spell's cursor also takes a game object (TARGET_FLAG_GAMEOBJECT_ITEM, «Взлом замка»). */
export function spellTargetsObject(metadata: { itemOrObject?: boolean | undefined } | undefined): boolean {
  return metadata?.itemOrObject === true;
}

/**
 * Raise the cursor for a spell (no `source`) or an item's own spell (`source`). A cursor already up
 * is replaced: the client has one pending spell.
 */
export function armItemTarget(world: object | undefined, spellId: number, source?: ItemTargetSource, orObject = false): boolean {
  if (!world || !Number.isSafeInteger(spellId) || spellId <= 0) return false;
  if (source && (source.guid === 0n || !Number.isInteger(source.bag) || !Number.isInteger(source.slot))) return false;
  const mapId = (world as { mapId?: unknown }).mapId;
  armed = {
    kind: source ? "item-use" : "spell",
    spellId,
    ...(source ? { source: { bag: source.bag, slot: source.slot, guid: source.guid } } : {}),
    ...(orObject ? { orObject: true } : {}),
    world,
    mapId: typeof mapId === "number" ? mapId : undefined,
  };
  // L1-review: the item an earlier BIND_ENCHANT / END_REFUND / END_BOUND_TRADEABLE / REPLACE_ENCHANT
  // question named belongs to the spell pending then, never to this one: its answer now does nothing.
  prompted = undefined;
  // L1-review: every arm is an edge, a replacing one too (Wow.exe 0x0080cce0 → 0x0053b480:
  // ACTIONBAR_UPDATE_STATE + CURRENT_SPELL_CAST_CHANGED, on which UIParent hides those popups).
  notify(true);
  return true;
}

/**
 * The armed cursor, if it still belongs to the world in play: a new world or a new map drops it,
 * as the client's pending spell does not outlive either.
 */
export function pendingItemTarget(world: object | undefined = game.world): ItemTargetCursor | undefined {
  const current = armed;
  if (!current) return undefined;
  const mapId = world === undefined ? undefined : (world as { mapId?: unknown }).mapId;
  if (world !== current.world || (typeof mapId === "number" ? mapId : undefined) !== current.mapId) {
    drop();
    return undefined;
  }
  return current;
}

/** `SpellStopTargeting` for this cursor: true when one was up. Nothing is sent. */
export function cancelItemTarget(): boolean {
  return drop();
}

/** Follow the cursor going up (true) and down; the returned function stops following. */
export function observeItemTarget(observer: (armed: boolean) => void): () => void {
  observers.add(observer);
  return () => { observers.delete(observer); };
}

/**
 * The client's own refusals before the send, as 0x005210d0 makes them for a spell with a
 * prospecting or milling effect: an item without `ITEM_FLAG_IS_PROSPECTABLE` / `_IS_MILLABLE`
 * gives SPELL_FAILED_CANT_BE_PROSPECTED / _MILLED and the cursor stays. Undefined when the rule
 * does not apply or a fact is missing (the realm judges then: `Spell::CheckItems`).
 */
export function itemTargetRefusal(
  spell: ItemTargetSpellFacts | undefined, template: { flags?: number } | undefined,
): string | undefined {
  const effects = spell?.effects;
  if (!effects || !template || typeof template.flags !== "number") return undefined;
  if (effects.includes(EFFECT_PROSPECTING) && (template.flags & ITEM_FLAG_IS_PROSPECTABLE) === 0) {
    return "SPELL_FAILED_CANT_BE_PROSPECTED";
  }
  if (effects.includes(EFFECT_MILLING) && (template.flags & ITEM_FLAG_IS_MILLABLE) === 0) {
    return "SPELL_FAILED_CANT_BE_MILLED";
  }
  return undefined;
}

function spellFacts(spellId: number): ItemTargetSpellFacts | undefined {
  return game.spells.get(spellId);
}

/** An enchantment's name (`SpellItemEnchantment.Name_lang`) from the gateway's table, if loaded. */
export type EnchantNameOf = (enchantId: number) => string | undefined;

/**
 * The session's enchantment names. The table is the one item tooltips load; when it has not come
 * yet it is asked for and nothing is named, so no prompt is raised (the client asks only with both
 * rows in hand, 0x005210d0).
 */
export const sessionEnchantName: EnchantNameOf = (enchantId) => {
  const origin = game.gatewayOrigin;
  if (origin === undefined || enchantId <= 0) return undefined;
  const table = itemEnchantments(origin);
  if (!table.ready) {
    void table.load().catch(() => undefined);
    return undefined;
  }
  const name = table.enchantments.get(enchantId)?.name;
  return name ? name : undefined;
};

/** `SpellItemEnchantment.Flags` of an enchantment (`/dbc/item-enchantments?v=2`); undefined when unknown. */
export type EnchantFlagsOf = (enchantId: number) => number | undefined;

/**
 * The session's enchantment flags, from the table item tooltips load. Undefined while it has not come
 * and for a gateway older than the column — then no BIND_ENCHANT is asked (the realm binds anyway).
 */
export const sessionEnchantFlags: EnchantFlagsOf = (enchantId) => {
  const origin = game.gatewayOrigin;
  if (origin === undefined || enchantId <= 0) return undefined;
  const table = itemEnchantments(origin);
  if (!table.ready) {
    void table.load().catch(() => undefined);
    return undefined;
  }
  return table.enchantments.get(enchantId)?.flags;
};

/**
 * Wow.exe 0x007073e0: an enchantment on the item binds it — one of its twelve enchantment slots holds
 * a row with ENCHANTMENT_CAN_SOULBOUND. (The client first skips the walk for an item whose flags word
 * has bit 0x2000; that word is not modelled here.)
 */
export function itemBoundByEnchantment(item: WorldObjectState, flagsOf: EnchantFlagsOf): boolean {
  for (let slot = 0; slot < ITEM_ENCHANTMENT_SLOTS; slot++) {
    const enchant = item.fields.get(UPDATE_FIELDS.ITEM_FIELD_ENCHANTMENT_1_1.offset + slot * 3) ?? 0;
    if (enchant !== 0 && ((flagsOf(enchant) ?? 0) & ENCHANTMENT_CAN_SOULBOUND) !== 0) return true;
  }
  return false;
}

/** Wow.exe 0x00708520: soulbound (ITEM_FIELD_FLAGS bit 0) or bound by an enchantment (0x007073e0). */
export function itemBound(item: WorldObjectState, flagsOf: EnchantFlagsOf): boolean {
  const flags = item.fields.get(UPDATE_FIELDS.ITEM_FIELD_FLAGS.offset) ?? 0;
  return (flags & ITEM_FIELD_FLAG_SOULBOUND) !== 0 || itemBoundByEnchantment(item, flagsOf);
}

/**
 * Whether Wow.exe 0x005210d0 asks BIND_ENCHANT (event 0x189) before this spell goes on this item: an
 * enchanting effect (53, 54, 156) whose enchantment row carries ENCHANTMENT_CAN_SOULBOUND, on an item
 * that is not bound yet (0x00708520) and has an InventoryType (0x00707280, Item.dbc +0x18 — the
 * template's here). `BindEnchant()` (0x00522f70) re-runs the check with the question answered.
 * False when a fact is missing — no table, an old gateway without Flags, no template: the spell goes
 * out, and `Spell::EffectEnchantItemPerm` binds the item on the server as before.
 */
export function enchantBindsItem(
  spell: ItemTargetSpellFacts | undefined, item: WorldObjectState | undefined, inventoryType: number | undefined,
  flagsOf: EnchantFlagsOf,
): boolean {
  const effects = spell?.effects;
  if (!effects || !item || !inventoryType) return false;
  for (let index = 0; index < effects.length; index++) {
    const effect = effects[index];
    if (effect !== EFFECT_ENCHANT_ITEM && effect !== EFFECT_ENCHANT_ITEM_TEMPORARY && effect !== EFFECT_ENCHANT_ITEM_PRISMATIC) continue;
    const flags = flagsOf(spell.effectMiscValue?.[index] ?? 0);
    if (flags !== undefined && (flags & ENCHANTMENT_CAN_SOULBOUND) !== 0) return !itemBound(item, flagsOf);
  }
  return false;
}

/**
 * 2.10, Wow.exe 0x005210d0 after the BIND_ENCHANT question: an enchanting effect that is not
 * ENCHANT_ITEM_TEMPORARY (54) on an item with a refund record and refund time left
 * (`stamp − played + 7200 > 0`) raises END_REFUND (event 0x28c, argument 1) and keeps the item's
 * guid; `EndRefund(1)` (0x00523370) re-runs the check answered, as `BindEnchant` does.
 */
export function enchantEndsRefund(
  spell: ItemTargetSpellFacts | undefined, world: Pick<ItemTargetWorld, "itemRefunds" | "playedSecondsNow"> | undefined,
  guid: bigint,
): boolean {
  const effects = spell?.effects;
  const info = world?.itemRefunds?.info.get(guid);
  if (!effects || !info) return false;
  const effect = effects.find((candidate) =>
    candidate === EFFECT_ENCHANT_ITEM || candidate === EFFECT_ENCHANT_ITEM_TEMPORARY || candidate === EFFECT_ENCHANT_ITEM_PRISMATIC);
  if (effect === undefined || effect === EFFECT_ENCHANT_ITEM_TEMPORARY) return false;
  return itemRefundSecondsLeft(info, world?.playedSecondsNow?.()) !== undefined;
}

/**
 * `REPLACE_ENCHANT`'s two names, as Wow.exe 0x005210d0 decides them for an item target: the first of
 * the spell's effects that enchants (ENCHANT_ITEM 53 → the permanent slot 0; ENCHANT_ITEM_TEMPORARY
 * 54 and ENCHANT_ITEM_PRISMATIC 156 → the temporary slot 1, the client's own reading) whose slot on
 * the item already holds an enchantment, when both that one and the new one (the effect's misc
 * value) have a row. Undefined otherwise: the spell goes out without asking.
 *
 * The client's BIND_ENCHANT question comes before this one ({@link enchantBindsItem}). Not
 * modelled: END_BOUND_TRADEABLE / END_REFUND (0x28d, 0x28c).
 */
export function enchantReplaceNames(
  spell: ItemTargetSpellFacts | undefined, item: WorldObjectState | undefined, nameOf: EnchantNameOf,
): readonly [string, string] | undefined {
  const effects = spell?.effects;
  if (!effects || !item) return undefined;
  for (let index = 0; index < effects.length; index++) {
    const effect = effects[index];
    if (effect !== EFFECT_ENCHANT_ITEM && effect !== EFFECT_ENCHANT_ITEM_TEMPORARY && effect !== EFFECT_ENCHANT_ITEM_PRISMATIC) continue;
    const slot = effect === EFFECT_ENCHANT_ITEM ? 0 : 1;
    const current = item.fields.get(UPDATE_FIELDS.ITEM_FIELD_ENCHANTMENT_1_1.offset + slot * 3) ?? 0;
    if (current === 0) continue;
    const oldName = nameOf(current);
    const newName = nameOf(spell.effectMiscValue?.[index] ?? 0);
    if (oldName !== undefined && newName !== undefined) return [oldName, newName];
  }
  return undefined;
}

/**
 * `TRADE_REPLACE_ENCHANT`'s two names, as Wow.exe 0x005198a0 decides them before the trade slot
 * takes a spell: the first ENCHANT_ITEM (53) effect, when the trader's seventh-slot item already
 * carries a permanent enchantment (0x0050f470(6)) and both rows are there.
 */
export function tradeEnchantReplaceNames(
  spell: ItemTargetSpellFacts | undefined, traderEnchantId: number, nameOf: EnchantNameOf,
): readonly [string, string] | undefined {
  const effects = spell?.effects;
  if (!effects || traderEnchantId === 0) return undefined;
  for (let index = 0; index < effects.length; index++) {
    if (effects[index] !== EFFECT_ENCHANT_ITEM) continue;
    const oldName = nameOf(traderEnchantId);
    const newName = nameOf(spell.effectMiscValue?.[index] ?? 0);
    if (oldName !== undefined && newName !== undefined) return [oldName, newName];
  }
  return undefined;
}

/** The permanent enchantment on the trader's seventh-slot item; 0 for none. */
export function traderSlotEnchant(world: Pick<ItemTargetWorld, "theirOffer"> | undefined): number {
  return world?.theirOffer?.items.find((item) => item.slot === TRADE_SLOT_NONTRADED)?.enchantId ?? 0;
}

function sendOnItem(cursor: ItemTargetCursor, world: ItemTargetWorld, guid: bigint, facts: ItemTargetSpellFacts | undefined): ItemTargetOutcome {
  if (cursor.kind === "item-use") {
    const source = cursor.source!;
    drop();
    // The source left its slot meanwhile: the client's pending spell dies with its item, and the
    // click is an ordinary one again.
    return world.useItemOnItem?.(source.bag, source.slot, source.guid, cursor.spellId, guid) === true ? SENT : NONE;
  }
  drop();
  const cooldown = Math.max(facts?.recoveryTime ?? 0, facts?.categoryRecoveryTime ?? 0);
  world.castSpellOnItem?.(cursor.spellId, guid, cooldown, facts?.cooldownStartedOnEvent ?? false);
  return SENT;
}

/**
 * `ReplaceEnchant()` (Wow.exe 0x005167a0): the item the last REPLACE_ENCHANT named takes the spell
 * pending now, with no further question (straight to 0x0080bc80). Nothing without a cursor or once
 * the world changed.
 */
export function replaceEnchantWithCursor(
  world: ItemTargetWorld | undefined = game.world as ItemTargetWorld | undefined,
  spells: (spellId: number) => ItemTargetSpellFacts | undefined = spellFacts,
): ItemTargetOutcome {
  const cursor = pendingItemTarget(world);
  const target = prompted;
  if (!cursor || !world || !target || target.world !== world) return NONE;
  return sendOnItem(cursor, world, target.guid, spells(cursor.spellId));
}

/**
 * `BindEnchant()` (Wow.exe 0x00522f70): 0x005210d0 again for the item the last BIND_ENCHANT named,
 * with the bind question answered — so REPLACE_ENCHANT may still follow. Nothing without a cursor,
 * once the world changed or when the item is gone.
 */
export function bindEnchantWithCursor(
  world: ItemTargetWorld | undefined = game.world as ItemTargetWorld | undefined,
  spells: (spellId: number) => ItemTargetSpellFacts | undefined = spellFacts,
  nameOf: EnchantNameOf = sessionEnchantName,
  flagsOf: EnchantFlagsOf = sessionEnchantFlags,
): ItemTargetOutcome {
  const target = prompted;
  if (!pendingItemTarget(world) || !world || !target || target.world !== world) return NONE;
  const item = world.state?.objects.get(target.guid);
  return targetItemWithCursor(item, target.guid, world, spells, nameOf, flagsOf, true);
}

/**
 * A click on an item while the cursor may be up (UseContainerItem, PickupInventoryItem,
 * SpellTargetItem, the native slots). `item` is the object standing at the clicked place, `guid`
 * its guid. The live world is `game.world`; tests pass their own.
 */
export function targetItemWithCursor(
  item: WorldObjectState | undefined,
  guid: bigint | undefined,
  world: ItemTargetWorld | undefined = game.world as ItemTargetWorld | undefined,
  spells: (spellId: number) => ItemTargetSpellFacts | undefined = spellFacts,
  nameOf: EnchantNameOf = sessionEnchantName,
  flagsOf: EnchantFlagsOf = sessionEnchantFlags,
  bindConfirmed = false,
): ItemTargetOutcome {
  const cursor = pendingItemTarget(world);
  if (!cursor || !world) return NONE;
  // An empty place under the cursor does nothing, and the cursor stays (0x005d8650, 0x005e85d0).
  if (!item || guid === undefined || guid === 0n) return NONE;
  const facts = spells(cursor.spellId);
  const entry = worldObject.entry(item) ?? 0;
  const template = entry > 0 ? world.itemTemplates?.get(entry) : undefined;
  const refusal = itemTargetRefusal(facts, template);
  if (refusal) return { kind: "refused", error: refusal };
  // A binding enchantment on an item not bound yet: the client asks first (0x005210d0 → 0x189) and
  // keeps the item's guid in the same one place REPLACE_ENCHANT does (DAT_00bd08d8).
  if (!bindConfirmed && enchantBindsItem(facts, item, template?.inventoryType, flagsOf)) {
    prompted = { world, guid };
    return { kind: "confirm", event: "BIND_ENCHANT", oldName: "", newName: "" };
  }
  // A refundable purchase would stop being one (2.10): END_REFUND, answered by EndRefund(1).
  if (!bindConfirmed && enchantEndsRefund(facts, world, guid)) {
    prompted = { world, guid };
    return { kind: "confirm", event: "END_REFUND", oldName: "", newName: "" };
  }
  // L1 (2.05/3.22): a soulbound item still in its trade window would leave it (0x005210d0 → 0x28d,
  // "itemenchant"); EndBoundTradeable("itemenchant") is BindEnchant's answered re-run.
  if (!bindConfirmed && enchantEndsBoundTrade(facts?.effects, facts?.effectMiscValue, item,
    world.playedSecondsNow?.(), world.state?.selfGuid, flagsOf)) {
    prompted = { world, guid };
    return { kind: "confirm", event: "END_BOUND_TRADEABLE", oldName: "", newName: "" };
  }
  // An enchantment already in the slot: the client asks before replacing it, the spell still pending.
  const replace = enchantReplaceNames(facts, item, nameOf);
  if (replace) {
    prompted = { world, guid };
    return { kind: "confirm", event: "REPLACE_ENCHANT", oldName: replace[0], newName: replace[1] };
  }
  return sendOnItem(cursor, world, guid, facts);
}

/**
 * A click on a game object in the world while the cursor is up (Wow.exe 0x00524bf0 → 0x0080bc80):
 * a cursor whose mask holds TARGET_FLAG_GAMEOBJECT_ITEM (`orObject`, «Взлом замка», a key) sends its
 * spell at the object with TARGET_FLAG_GAMEOBJECT and goes down — an item's own spell through
 * CMSG_USE_ITEM. `none` for any other cursor or anything but a game object: an items-only cursor
 * stays up, as the client's does (its mask has nothing an object fills).
 */
export function targetGameObjectWithCursor(
  objectGuid: bigint | undefined,
  world: ItemTargetWorld | undefined = game.world as ItemTargetWorld | undefined,
  spells: (spellId: number) => ItemTargetSpellFacts | undefined = spellFacts,
): ItemTargetOutcome {
  const cursor = pendingItemTarget(world);
  if (!cursor || !world || !cursor.orObject || objectGuid === undefined || objectGuid === 0n) return NONE;
  if (world.state?.objects.get(objectGuid)?.typeId !== TYPEID_GAMEOBJECT) return NONE;
  if (cursor.kind === "item-use") {
    const source = cursor.source!;
    drop();
    return world.useItemOnGameObject?.(source.bag, source.slot, source.guid, cursor.spellId, objectGuid) === true ? SENT : NONE;
  }
  const facts = spells(cursor.spellId);
  drop();
  const cooldown = Math.max(facts?.recoveryTime ?? 0, facts?.categoryRecoveryTime ?? 0);
  return world.castSpellOnGameObject?.(cursor.spellId, objectGuid, cooldown, facts?.cooldownStartedOnEvent ?? false) === true
    ? SENT : NONE;
}

/**
 * `ClickTargetTradeButton(7)` while the cursor is up (0x00586c80 → 0x005198a0 → 0x0080c5f0): the
 * spell goes on the trader's «will not be traded» slot as TARGET_FLAG_TRADE_ITEM with slot 6. An
 * item's own spell cannot go there: the core refuses any cast with a cast item on that slot
 * (SPELL_FAILED_ITEM_ENCHANT_TRADE_WINDOW, Spell.cpp:6404-6407). The original client leaves that
 * verdict to the realm; this one gives the same message without the doomed packet and lets the
 * cursor go, as the refused send would have.
 *
 * A permanent enchantment already on the trader's item raises TRADE_REPLACE_ENCHANT first
 * (0x005198a0) and nothing is sent; `ReplaceTradeEnchant()` (0x00510b80 → 0x0080c5f0) is this call
 * with `confirmed`.
 */
export function targetTradeSlotWithCursor(
  world: ItemTargetWorld | undefined = game.world as ItemTargetWorld | undefined,
  spells: (spellId: number) => ItemTargetSpellFacts | undefined = spellFacts,
  confirmed = false,
  nameOf: EnchantNameOf = sessionEnchantName,
): ItemTargetOutcome {
  const cursor = pendingItemTarget(world);
  if (!cursor || !world) return NONE;
  if (cursor.kind === "item-use") {
    drop();
    return { kind: "refused", error: "SPELL_FAILED_ITEM_ENCHANT_TRADE_WINDOW" };
  }
  const facts = spells(cursor.spellId);
  const replace = confirmed ? undefined : tradeEnchantReplaceNames(facts, traderSlotEnchant(world), nameOf);
  if (replace) return { kind: "confirm", event: "TRADE_REPLACE_ENCHANT", oldName: replace[0], newName: replace[1] };
  const cooldown = Math.max(facts?.recoveryTime ?? 0, facts?.categoryRecoveryTime ?? 0);
  if (world.castSpellOnTradeSlot?.(cursor.spellId, cooldown, facts?.cooldownStartedOnEvent ?? false) !== true) return NONE;
  drop();
  return SENT;
}
