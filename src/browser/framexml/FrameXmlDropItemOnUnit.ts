import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import type { WorldObjectState } from "../../world/WorldState.js";
import { game } from "../game/Context.js";
import { armItemTarget, itemBound, sessionEnchantFlags, targetItemWithCursor, type ItemTargetWorld } from "../game/SpellCursor.js";

/**
 * `DropItemOnUnit("unit")` (plan item 1.10, lane L1) — SecureTemplates.lua:406-412 calls it from a unit
 * button's `target` action when the hand holds an item. Wow.exe 12340 0x0051bdd0, read-only Ghidra
 * (`.runtime/re-2026-09-30/m3/d2.c`, `d5.c`; `.runtime/re-2026-10-03/l1-item-cursor/`):
 *
 * Only a bag item on the cursor counts (cursor type 1, `DAT_00bd0748`); the unit must be in view and
 * be a unit (TYPEMASK_UNIT). Then:
 * - **a player** —
 *   - the player himself: the item is worn, exactly as `AutoEquipCursorItem` (both 0x006dfc40(0));
 *   - anyone else the player may trade with (0x00729b30): neither of the two is charmed
 *     (UNIT_FIELD_CHARMEDBY), their FactionTemplate rows share a FactionGroup (when both rows are
 *     known) and the player cannot attack him (CanAttack 0x00729740 false). With his trade window open
 *     (`DAT_00bfa658` the partner) the item goes into it (0x00586b50): a bound item (0x00708520) into
 *     the «will not be traded» slot when that is empty, any other into the first empty slot 1..6 unless
 *     it is offered already; the cursor lets go (0x00519280(0, 1)). With no trade at all, a trade is
 *     proposed (0x00703cf0: CMSG_INITIATE_TRADE, at most once a second); with the player's own
 *     proposal still unanswered, ERR_ALREADY_TRADING (game message 0xd3). Nothing for anyone else.
 * - **the player's pet** (PetInfo's first guid, 0x005d3390(0) — the SMSG_PET_SPELLS guid) — fed
 *   (0x0080dcf0) when it has a pet number (UNIT_FIELD_PETNUMBER), the player created it
 *   (UNIT_FIELD_CREATEDBY) and knows a feeding spell: the last learned spell whose first effect is
 *   SPELL_EFFECT_FEED_PET and that is not a trade spell (0x006e7b00 → 0x007fe1a0 stores it in
 *   `DAT_00d397b8`). That spell is cast (0x0080da40) and given the held item (0x0080bc80): the
 *   item-target cursor's CMSG_CAST_SPELL with TARGET_FLAG_ITEM. When it went out, the cursor lets go.
 *
 * Not modelled: the client-side cast checks of 0x0080da40 (the realm answers them); an incoming
 * proposal still unanswered (Wow.exe's `DAT_00ca0fe8` is the player's own proposal; whether the
 * other side's sets it is not established) — nothing happens then.
 */

/** `SPELL_EFFECT_FEED_PET` (SharedDefines.h). */
export const SPELL_EFFECT_FEED_PET = 101;
/** `SPELL_ATTR0_TRADESPELL` (SharedDefines.h): 0x006e7b00 skips trade spells. */
const SPELL_ATTR0_TRADESPELL = 0x20;
const TYPEID_UNIT = 3;
const TYPEID_PLAYER = 4;
/** `TRADE_SLOT_NONTRADED`: the seventh slot, wire slot 6. */
export const TRADE_SLOT_NONTRADED = 6;
/** 0x00703cf0 sends at most one CMSG_INITIATE_TRADE a second (`DAT_00ca0ff8 = now + 1000`). */
export const INITIATE_TRADE_INTERVAL_MS = 1000;

function guidField(object: WorldObjectState, offset: number): bigint {
  const low = object.fields.get(offset) ?? 0;
  const high = object.fields.get(offset + 1) ?? 0;
  return (BigInt(high >>> 0) << 32n) | BigInt(low >>> 0);
}

/** 0x006e7b00's `DAT_00d397b8`: the last known spell with FEED_PET as its first effect, not a trade spell. */
export function frameXmlFeedPetSpell(
  knownSpells: readonly { readonly id: number }[] | undefined,
  spellOf: (id: number) => { readonly effects?: readonly number[] | undefined; readonly attributes?: readonly number[] | undefined } | undefined,
): number | undefined {
  let found: number | undefined;
  for (const { id } of knownSpells ?? []) {
    const spell = spellOf(id);
    if (spell?.effects?.[0] === SPELL_EFFECT_FEED_PET && ((spell.attributes?.[0] ?? 0) & SPELL_ATTR0_TRADESPELL) === 0) found = id;
  }
  return found;
}

/** 0x00729b30: whether the player (`self`) may trade with `unit`. */
export function frameXmlCanTradeWith(
  self: WorldObjectState | undefined, unit: WorldObjectState | undefined,
  factionGroupOf: (templateId: number) => number | undefined, canAttack: (unit: WorldObjectState) => boolean,
): boolean {
  if (!self || !unit || self.guid === unit.guid) return false;
  const charmedBy = UPDATE_FIELDS.UNIT_FIELD_CHARMEDBY.offset;
  if (guidField(self, charmedBy) !== 0n || guidField(unit, charmedBy) !== 0n) return false;
  const template = UPDATE_FIELDS.UNIT_FIELD_FACTIONTEMPLATE.offset;
  const mine = factionGroupOf(self.fields.get(template) ?? 0);
  const theirs = factionGroupOf(unit.fields.get(template) ?? 0);
  if (mine !== undefined && theirs !== undefined && mine !== theirs) return false;
  return !canAttack(unit);
}

/**
 * 0x00586b50's slot for the held item: wire slot 6 for a bound item when it is empty, otherwise the
 * first empty of 0..5 unless the item is offered already; undefined for nowhere.
 */
export function frameXmlTradeSlotForDrop(bound: boolean, offered: boolean, taken: (wire: number) => boolean): number | undefined {
  if (bound) return taken(TRADE_SLOT_NONTRADED) ? undefined : TRADE_SLOT_NONTRADED;
  if (offered) return undefined;
  for (let wire = 0; wire < TRADE_SLOT_NONTRADED; wire++) if (!taken(wire)) return wire;
  return undefined;
}

/** 0x0080dcf0's conditions on the pet: a pet number, created by the player, and a feeding spell known. */
export function frameXmlCanFeedPet(unit: WorldObjectState, selfGuid: bigint | undefined, feedSpell: number | undefined): boolean {
  if (feedSpell === undefined || selfGuid === undefined) return false;
  if ((unit.fields.get(UPDATE_FIELDS.UNIT_FIELD_PETNUMBER.offset) ?? 0) === 0) return false;
  return guidField(unit, UPDATE_FIELDS.UNIT_FIELD_CREATEDBY.offset) === selfGuid;
}

/** What `DropItemOnUnit` reads and does; LiveWorldSeam builds it over the world and its models. */
export interface FrameXmlDropItemHost {
  /** The bag item on the cursor (type 1 only: not a vault item, a spell, a merchant row). */
  cursorItem(): { readonly guid: bigint; readonly item: WorldObjectState } | undefined;
  unit(token: string): WorldObjectState | undefined;
  self(): WorldObjectState | undefined;
  /** 0x006dfc40(0), the `AutoEquipCursorItem` route. */
  autoEquip(): void;
  canTradeWith(unit: WorldObjectState): boolean;
  /** Whether the item is bound (0x00708520: soulbound or bound by an enchantment). */
  bound(item: WorldObjectState): boolean;
  readonly trade: {
    open(): boolean;
    /** The partner of an open trade or of a proposal either side made; 0 for none. */
    partner(): bigint;
    /** The other side's proposal waits for the player's answer. */
    incoming(): boolean;
    offered(guid: bigint): boolean;
    taken(wire: number): boolean;
    place(wire: number): void;
    propose(guid: bigint): void;
  };
  petGuid(): bigint | undefined;
  feedPetSpell(): number | undefined;
  /** 0x0080da40 + 0x0080bc80: the spell cast at the held item; true when it went out. */
  feed(spellId: number, item: WorldObjectState, guid: bigint): boolean;
  clearCursor(): void;
  /** A UIErrorsFrame message by its GlobalStrings.lua name. */
  error(name: string): void;
  now(): number;
}

/** `DAT_00ca0ff8`: when 0x00703cf0 may send again. */
let proposeAfter = Number.NEGATIVE_INFINITY;

/** Tests start each case with no recent proposal. */
export function resetFrameXmlDropItemThrottle(): void {
  proposeAfter = Number.NEGATIVE_INFINITY;
}

function propose(host: FrameXmlDropItemHost, guid: bigint): void {
  // 0x00703cf0: the player's own proposal still waits → ERR_ALREADY_TRADING; else once a second.
  if (host.trade.partner() !== 0n) {
    if (!host.trade.incoming()) host.error("ERR_ALREADY_TRADING");
    return;
  }
  const now = host.now();
  if (now < proposeAfter) return;
  proposeAfter = now + INITIATE_TRADE_INTERVAL_MS;
  host.trade.propose(guid);
}

/** `DropItemOnUnit(token)` (Wow.exe 0x0051bdd0). */
export function frameXmlDropItemOnUnit(token: string, host: FrameXmlDropItemHost): void {
  const held = host.cursorItem();
  if (!held) return;
  const unit = host.unit(token);
  if (!unit || (unit.typeId !== TYPEID_UNIT && unit.typeId !== TYPEID_PLAYER)) return;
  if (unit.typeId === TYPEID_PLAYER) {
    const self = host.self();
    if (self && unit.guid === self.guid) host.autoEquip();
    else if (self && host.canTradeWith(unit)) {
      if (host.trade.open()) {
        if (host.trade.partner() === unit.guid) {
          const wire = frameXmlTradeSlotForDrop(host.bound(held.item), host.trade.offered(held.guid), host.trade.taken);
          if (wire !== undefined) host.trade.place(wire);
        }
      } else propose(host, unit.guid);
    }
  }
  const petGuid = host.petGuid();
  if (petGuid === undefined || petGuid === 0n || unit.guid !== petGuid) return;
  const spell = host.feedPetSpell();
  if (frameXmlCanFeedPet(unit, host.self()?.guid, spell) && host.feed(spell!, held.item, held.guid)) host.clearCursor();
}

/** The live world's share (`WorldClient` has it). */
export interface FrameXmlDropItemWorld extends ItemTargetWorld {
  readonly tradeOpen: boolean;
  readonly tradePending: boolean;
  readonly tradePartnerGuid: bigint;
  startTrade(guid: bigint): void;
  ownTradeOffer(): { readonly items: readonly { readonly slot: number }[] };
  readonly petSpells?: { readonly guid: bigint } | undefined;
  readonly knownSpells?: readonly { readonly id: number }[] | undefined;
}

/** What LiveWorldSeam lends from its own state; the rest comes from the world and the session. */
export interface FrameXmlDropItemSeamParts {
  readonly world: FrameXmlDropItemWorld;
  cursorItem(): { readonly guid: bigint; readonly item: WorldObjectState } | undefined;
  unit(token: string): WorldObjectState | undefined;
  self(): WorldObjectState | undefined;
  /** CanAttack for the player against this token's unit (the seam's UnitCanAttack). */
  canAttack(token: string): boolean;
  autoEquip(): void;
  /** The stock trade model: the item is in the player's offer already. */
  offered(guid: bigint): boolean;
  /** `ClickTradeButton(stockSlot)` with the held item: CMSG_SET_TRADE_ITEM, and the hand lets go. */
  clickTradeSlot(stockSlot: number): void;
  clearCursor(): void;
  error(name: string): void;
  now(): number;
}

/** `DropItemOnUnit(token)` over the live world (LiveWorldSeam.dropItemOnUnit). */
export function frameXmlLiveDropItemOnUnit(token: string, parts: FrameXmlDropItemSeamParts): void {
  const world = parts.world;
  frameXmlDropItemOnUnit(token, {
    cursorItem: () => parts.cursorItem(),
    unit: (name) => parts.unit(name),
    self: () => parts.self(),
    autoEquip: () => parts.autoEquip(),
    canTradeWith: (unit) => frameXmlCanTradeWith(parts.self(), unit,
      (templateId) => game.factions?.factionGroupOf?.(templateId), () => parts.canAttack(token)),
    bound: (item) => itemBound(item, sessionEnchantFlags),
    trade: {
      open: () => world.tradeOpen,
      partner: () => world.tradePartnerGuid,
      incoming: () => world.tradePending,
      offered: (guid) => parts.offered(guid),
      taken: (wire) => world.ownTradeOffer().items.some((item) => item.slot === wire),
      place: (wire) => parts.clickTradeSlot(wire + 1),
      propose: (guid) => world.startTrade(guid),
    },
    petGuid: () => world.petSpells?.guid,
    feedPetSpell: () => frameXmlFeedPetSpell(world.knownSpells, (id) => game.spells.get(id)),
    // 0x0080da40 arms the pending spell, 0x0080bc80 hands it the item: the item-target cursor's two steps.
    feed: (spellId, item, guid) => armItemTarget(world, spellId)
      && targetItemWithCursor(item, guid, world).kind === "sent",
    clearCursor: () => parts.clearCursor(),
    error: (name) => parts.error(name),
    now: () => parts.now(),
  });
}
