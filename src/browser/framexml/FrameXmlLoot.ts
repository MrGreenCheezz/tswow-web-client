/**
 * The stock loot window's C API: `LootFrame.lua` (LootFrame, LootButton1-4, GroupLootFrame1-4,
 * GroupLootDropDown) and UIParent's loot events over this client's loot packets.
 *
 * Every packet already lands in `WorldClient` (`loot`, `lootRolls`, `masterLootCandidates`); the
 * real client's own share — what the engine does between the packets and the Lua — lives here:
 *
 * * **Slots are client numbers.** `GetNumLootItems` counts the money as slot 1 when the corpse
 *   carries any, then the wire's items in wire order. The numbering is frozen per opening: taking
 *   the money or an item raises `LOOT_SLOT_CLEARED(slot)` and never renumbers what is left
 *   (LootFrame.lua:23-54 hides that one button and pages down when a page runs empty).
 * * **Bind confirmation is the slot type.** TrinityCore marks a slot `LOOT_SLOT_TYPE_OWNER` exactly
 *   when the binding confirmation is to be skipped (Loot.h:122, "for single player looting"); an
 *   `ALLOW_LOOT` slot holding a bind-on-pickup item raises `LOOT_BIND_CONFIRM` and waits for
 *   `ConfirmLootSlot`. A roll on a bind-on-pickup item likewise raises `CONFIRM_LOOT_ROLL`
 *   (`CONFIRM_DISENCHANT_ROLL` for disenchant) and waits for `ConfirmLootRoll`; a pass never asks.
 * * **Roll ids are client numbers too.** The wire's roll key is a minted 64-bit item guid, which
 *   Lua cannot carry; `START_LOOT_ROLL(rollID, rollTime)` hands out small integers, and
 *   `CANCEL_LOOT_ROLL(rollID)` takes a frame down once the player answered (their own vote comes
 *   back as `SMSG_LOOT_ROLL`), the roll was won or passed, or its countdown ran out — the server
 *   sends nothing when a roll simply expires.
 * * **The window closes itself.** TrinityCore releases a creature's loot only when the client asks
 *   (`CMSG_LOOT_RELEASE`, LootHandler.cpp:303) — never when the last item is taken or the player
 *   walks off (it releases on its own only for containers, disallowed items, logout and leaving the
 *   map). So, as the client does, the model releases an opening whose every slot was cleared, and
 *   one whose creature source is farther than the server's own looting radius (LootHandler.cpp:91:
 *   `INTERACTION_DISTANCE` 5 yd plus both combat reaches) and farther than it was when opened.
 *
 * Events are raised from `tick` (every rendered frame) by diffing the world, never from inside a
 * C-API call: `CloseLoot` runs inside LootFrame's OnHide, and a synchronous `LOOT_CLOSED` there
 * would re-enter it. Events a C API itself causes (`LOOT_BIND_CONFIRM`, `OPEN_MASTER_LOOT_LIST`,
 * `CONFIRM_LOOT_ROLL`) are queued and delivered at the next tick for the same reason; a
 * confirmation whose slot or roll is gone by then is dropped (`#outlived`).
 *
 * Nothing is raised, and no command is sent, until the world mount publishes the stock owner
 * (`owned`): before that the native `#loot-window` and `LootRolls.ts` answer every packet.
 */
import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import { GROUPTYPE_RAID, type GroupState } from "../../world/GroupProtocol.js";
import {
  LOOT_FISHING,
  LOOT_SLOT_ALLOW_LOOT,
  LOOT_SLOT_LOCKED,
  LOOT_SLOT_MASTER,
  LOOT_SLOT_ROLL_ONGOING,
  lootErrorText,
  type LootSlot,
  type LootWindow,
} from "../../world/LootProtocol.js";
import {
  ROLL_DISENCHANT,
  ROLL_FLAG_DISENCHANT,
  ROLL_FLAG_GREED,
  ROLL_FLAG_NEED,
  ROLL_FLAG_PASS,
  ROLL_GREED,
  ROLL_NEED,
  ROLL_PASS,
  type LootRollStart,
  type LootRollVote,
  type LootRollWon,
} from "../../world/LootRollProtocol.js";
import type { ItemTemplate } from "../../world/QueryCacheProtocol.js";
import { fieldFloat, type WorldObjectState } from "../../world/WorldState.js";

/** `BIND_WHEN_PICKED_UP` in ItemTemplate.h. */
const BIND_WHEN_PICKED_UP = 1;
/** `ITEM_FLAG2_CAN_ONLY_ROLL_GREED` (ItemTemplate.h:200): Group.cpp:1525 strips need for everyone. */
const ITEM_FLAG2_CAN_ONLY_ROLL_GREED = 0x100;
/** `INTERACTION_DISTANCE` (ObjectDefines.h:24), the radius LootHandler.cpp checks a creature against. */
const INTERACTION_DISTANCE = 5;
/** `TYPEID_UNIT`: the only loot source with a position the looter walks away from. */
const TYPEID_UNIT = 3;
/**
 * How long a roll waits for its item's name before it is announced anyway. GroupLootFrame_OnShow
 * hides a frame whose name is nil (LootFrame.lua:342), so a roll announced before the item query
 * answered would be a roll the player never sees; after this it shows RETRIEVING_ITEM_INFO.
 */
const ROLL_NAME_GRACE_MS = 1000;
/**
 * How long auto-loot keeps waiting for a slot's template before leaving it to the player. The
 * template decides whether the slot needs a bind confirmation, so it cannot be taken blind.
 */
const AUTO_LOOT_TEMPLATE_WAIT_MS = 3000;
/** The client's own icon for an item it has no picture for yet. */
export const FRAMEXML_LOOT_UNKNOWN_ICON = "Interface\\Icons\\INV_Misc_QuestionMark";
/** Stock `ITEM_QUALITY_COLORS` hex (UIParent.lua), for the item links. */
const QUALITY_HEX: readonly string[] = [
  "ff9d9d9d", "ffffffff", "ff1eff00", "ff0070dd", "ffa335ee", "ffff8000", "ffe6cc80", "ffe6cc80",
];
/** `LootError` (Loot.h:98-113) to the client's own GlobalStrings wording. */
const LOOT_ERROR_STRINGS: Readonly<Record<number, string>> = Object.freeze({
  0: "ERR_LOOT_DIDNT_KILL",
  4: "ERR_LOOT_TOO_FAR",
  5: "ERR_LOOT_BAD_FACING",
  6: "ERR_LOOT_LOCKED",
  8: "ERR_LOOT_NOTSTANDING",
  9: "ERR_LOOT_STUNNED",
  10: "ERR_LOOT_PLAYER_NOT_FOUND",
  11: "ERR_PLAY_TIME_EXCEEDED",
  12: "ERR_LOOT_MASTER_INV_FULL",
  13: "ERR_LOOT_MASTER_UNIQUE_ITEM",
  14: "ERR_LOOT_MASTER_OTHER",
  15: "ERR_ALREADY_PICKPOCKETED",
  16: "ERR_NOT_WHILE_SHAPESHIFTED",
});
/** `LOOT_ROLL_INELIGIBLE_REASON1..5` (GlobalStrings.lua:4820-4824). */
const REASON_CLASS = 1;
const REASON_NOT_DISENCHANTABLE = 3;
const REASON_NO_ENCHANTER = 4;
const REASON_NEED_DISABLED = 5;

/**
 * The coin icon for an amount. 3.3.5 picks it in the engine, out of reach of the Lua; this is the
 * later client's own `GetCoinIcon` table (MoneyFrame.lua): a gold pile, silver, then copper.
 */
export function frameXmlLootCoinIcon(copper: number): string {
  if (copper >= 10000) return "Interface\\Icons\\INV_Misc_Coin_01";
  if (copper >= 100) return "Interface\\Icons\\INV_Misc_Coin_03";
  return "Interface\\Icons\\INV_Misc_Coin_05";
}

/** One roll as `WorldClient.lootRolls` keeps it; entries are never deleted there. */
export interface FrameXmlLootRollEntry {
  readonly start: LootRollStart;
  readonly startedAt: number;
  readonly votes: readonly LootRollVote[];
  readonly won?: LootRollWon | undefined;
  readonly passed?: boolean | undefined;
}

/** The world facts and commands the model reads; `WorldClient` satisfies it structurally. */
export interface FrameXmlLootWorld {
  readonly loot: LootWindow | undefined;
  readonly lootRolls: ReadonlyMap<bigint, FrameXmlLootRollEntry>;
  readonly masterLootCandidates: readonly bigint[];
  readonly group?: GroupState | undefined;
  readonly state: {
    readonly selfGuid: bigint | undefined;
    readonly objects: ReadonlyMap<bigint, WorldObjectState>;
  };
  readonly itemTemplates: ReadonlyMap<number, ItemTemplate>;
  /** Answers the cache and asks the server on a miss; called from `tick` only, never a C API. */
  itemTemplate(entry: number): ItemTemplate | undefined;
  displayName?(guid: bigint): string;
  takeLootSlot(index: number): void;
  takeLootMoney(): void;
  closeLoot(): void;
  rollForLoot(itemGuid: bigint, rollType: number): void;
  giveMasterLoot(slot: number, targetGuid: bigint): void;
}

/** Cached item facts (the gateway's metadata), for items the server has not described yet. */
export interface FrameXmlLootItem {
  readonly name?: string | undefined;
  readonly texture?: string | undefined;
  readonly quality?: number | undefined;
}

/** What the model asks its host (LiveWorldSeam or the canned seam) besides the world. */
export interface FrameXmlLootContext {
  world(): FrameXmlLootWorld | undefined;
  /** Cache-only metadata by item entry; must not perform network I/O. */
  item?(entry: number): FrameXmlLootItem | undefined;
  /** The picture for a loot packet's `displayId` (`/item-icon/<displayId>`), when a host has one. */
  displayIcon?(displayId: number): string | undefined;
  playerLevel(): number;
  /** The client's `autoLootDefault`: the native «Автоподбор добычи» switch. */
  autoLootDefault(): boolean;
  /** Whether the auto-loot toggle modifier (Shift, `AUTOLOOTTOGGLE`) is held right now. */
  autoLootModifier?(): boolean;
  playSound?(name: string): void;
  /** Wall-clock milliseconds, the clock `lootRolls[].startedAt` was stamped with (Date.now). */
  now?(): number;
}

/** The live page's share of the context (FrameXmlLootHost.ts builds it for the world mount). */
export type FrameXmlLootHostContext = Partial<Pick<FrameXmlLootContext, "displayIcon" | "autoLootDefault" | "autoLootModifier">>;

interface FrameXmlLootPump {
  fire(event: string, ...args: readonly unknown[]): number;
}

/** One opening as stock numbers it: the money first when there is any, then the wire's items. */
interface LootLayout {
  readonly window: LootWindow;
  readonly coin: boolean;
  readonly slots: readonly LootSlot[];
}

type LootEntry = { readonly kind: "coin" } | { readonly kind: "item"; readonly slot: LootSlot };

interface RollState {
  readonly itemGuid: bigint;
  readonly seenAt: number;
  announced: boolean;
  answered: boolean;
  cancelled: boolean;
}

/** The gate's synthetic opening and roll, answered only while a probe runs. */
export interface FrameXmlLootProbeFixture {
  readonly loot: LootWindow;
  readonly items: ReadonlyMap<number, FrameXmlLootItem>;
  readonly roll?: { readonly entry: FrameXmlLootRollEntry; readonly id: number } | undefined;
}

/** `GetLootSlotInfo`'s five values, plus the copper a coin slot's name is formatted from in Lua. */
export type FrameXmlLootSlotInfo = readonly [
  texture: string, name: string | undefined, quantity: number, quality: number, locked: true | undefined,
  copper: number | undefined,
];

/** `GetLootRollItemInfo`'s twelve values (LootFrame.lua:341). */
export type FrameXmlLootRollItemInfo = readonly [
  texture: string, name: string | undefined, count: number, quality: number, bindOnPickUp: boolean,
  canNeed: boolean, canGreed: boolean, canDisenchant: boolean,
  reasonNeed: number, reasonGreed: number, reasonDisenchant: number, deSkillRequired: number,
];

function distance(left: WorldObjectState | undefined, right: WorldObjectState | undefined): number | undefined {
  const a = left?.position;
  const b = right?.position;
  return a && b ? Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) : undefined;
}

function combatReach(object: WorldObjectState | undefined): number {
  const reach = object ? fieldFloat(object, UPDATE_FIELDS.UNIT_FIELD_COMBATREACH.offset) : undefined;
  return reach !== undefined && reach >= 0 ? reach : 0;
}

/**
 * One owner of the stock loot C API. Server state is read from the world on every call; the
 * client's own bookkeeping — the frozen slot numbering, which clears were announced, roll ids,
 * which rolls the player answered — lives here, as the real client keeps it in its own memory.
 */
export class FrameXmlLootModel {
  readonly #context: FrameXmlLootContext;
  #pump: FrameXmlLootPump | undefined;
  #owned = false;
  #muted = false;
  #probe: FrameXmlLootProbeFixture | undefined;
  #strings: ((name: string) => string | undefined) | undefined;
  readonly #queue: (readonly [string, readonly unknown[]])[] = [];
  // ---- the opening ----
  #shown: LootWindow | undefined;
  #layout: LootLayout | undefined;
  #refused: LootWindow | undefined;
  #handover: LootWindow | undefined;
  readonly #cleared = new Set<number>();
  #signatures: string[] = [];
  #candidates: readonly bigint[] | undefined;
  #source: WorldObjectState | undefined;
  #openDistance = 0;
  readonly #autoPending = new Set<number>();
  #autoSince = 0;
  // ---- rolls ----
  #rollWorld: FrameXmlLootWorld | undefined;
  #nextRollId = 1;
  readonly #rollIds = new Map<bigint, number>();
  readonly #rolls = new Map<number, RollState>();

  constructor(context: FrameXmlLootContext) {
    this.#context = context;
  }

  // ---- lifecycle -------------------------------------------------------------------------

  attach(pump: FrameXmlLootPump): void {
    this.detach();
    this.#pump = pump;
  }

  /** A closed VM took its frames with it: nothing is shown, nothing announced, nothing owned. */
  detach(): void {
    this.#pump = undefined;
    this.owned = false;
  }

  /**
   * Whether the stock LootFrame and GroupLootFrames answer loot. Taking ownership is an edge: an
   * opening and the rolls already in flight are announced to stock at the next tick (the native
   * window and dialogs step aside at the same moment, `frameXmlLootPublished`), and an opening
   * handed over that way is not auto-looted twice. Giving it up forgets what stock was shown,
   * so `CloseLoot` from the stock frame's OnHide during teardown releases nothing.
   */
  get owned(): boolean { return this.#owned; }
  set owned(next: boolean) {
    if (next === this.#owned) return;
    this.#owned = next;
    this.#queue.length = 0;
    this.#resetOpening();
    for (const roll of this.#rolls.values()) roll.announced = false;
    // What the world holds now was the native window's: an open corpse is handed over (no second
    // auto-loot), a refusal was already shown there and is not repeated.
    const held = next ? this.#context.world()?.loot : undefined;
    this.#handover = held;
    this.#refused = held?.error !== undefined ? held : undefined;
  }

  /** The client's GlobalStrings, for `UI_ERROR_MESSAGE` wording; set by the owner once published. */
  useGlobalStrings(resolve: ((name: string) => string | undefined) | undefined): void {
    this.#strings = resolve;
  }

  /** Run `operation` without sending a packet or raising an event (the mount's gate). */
  muted<T>(operation: () => T): T {
    const previous = this.#muted;
    this.#muted = true;
    try { return operation(); } finally { this.#muted = previous; }
  }

  /** Answer the C API from `fixture` while `operation` runs, muted; the gate's synthetic opening. */
  probe<T>(fixture: FrameXmlLootProbeFixture, operation: () => T): T {
    const previous = this.#probe;
    this.#probe = fixture;
    try { return this.muted(operation); } finally { this.#probe = previous; }
  }

  #fire(event: string, ...args: readonly unknown[]): void {
    if (!this.#muted && this.#owned && this.#pump) this.#queue.push([event, args]);
  }

  #flush(): void {
    const pump = this.#pump;
    if (!pump) return;
    while (this.#queue.length > 0) {
      const [event, args] = this.#queue.shift()!;
      if (this.#outlived(event, args)) continue;
      pump.fire(event, ...args);
    }
  }

  /**
   * A confirmation queued by a click whose slot or roll is gone by the frame it is delivered in.
   * The client raises these inside the click, so its handlers never meet an empty slot: UIParent's
   * LOOT_BIND_CONFIRM reads GetLootSlotInfo(slot) and indexes ITEM_QUALITY_COLORS[quality]
   * (UIParent.lua:582-583), CONFIRM_LOOT_ROLL/CONFIRM_DISENCHANT_ROLL the same over
   * GetLootRollItemInfo (:842-857) — nil there is a Lua error. Here a frame passes in between, and
   * another looter's SMSG_LOOT_REMOVED (free-for-all, round robin) or a new world can land in it.
   * Such a confirmation is dropped; the LOOT_SLOT_CLEARED or CANCEL_LOOT_ROLL that follows takes
   * the button or the frame down.
   */
  #outlived(event: string, args: readonly unknown[]): boolean {
    const id = typeof args[0] === "number" ? args[0] : 0;
    if (event === "LOOT_BIND_CONFIRM") return !this.slotIsItem(id);
    if (event === "CONFIRM_LOOT_ROLL" || event === "CONFIRM_DISENCHANT_ROLL") return this.rollItemInfo(id) === undefined;
    return false;
  }

  #world(): FrameXmlLootWorld | undefined {
    return this.#muted ? undefined : this.#context.world();
  }

  #now(): number {
    return this.#context.now?.() ?? Date.now();
  }

  // ---- the opening's C API ---------------------------------------------------------------

  #view(): LootLayout | undefined {
    const probe = this.#probe;
    if (probe) return { window: probe.loot, coin: probe.loot.gold > 0, slots: probe.loot.slots };
    return this.#layout;
  }

  #entry(slot: number): LootEntry | undefined {
    const layout = this.#view();
    if (!layout || !Number.isInteger(slot) || slot < 1) return undefined;
    if (layout.coin && slot === 1) return { kind: "coin" };
    const item = layout.slots[slot - (layout.coin ? 2 : 1)];
    return item ? { kind: "item", slot: item } : undefined;
  }

  #template(entry: number): ItemTemplate | undefined {
    const template = this.#probe ? undefined : this.#context.world()?.itemTemplates.get(entry);
    return template?.found ? template : undefined;
  }

  #itemName(entry: number): string | undefined {
    const probe = this.#probe?.items.get(entry);
    if (probe) return probe.name;
    const template = this.#template(entry);
    if (template && template.name.length > 0) return template.name;
    const name = this.#context.item?.(entry)?.name;
    return name !== undefined && name.length > 0 ? name : undefined;
  }

  #itemQuality(entry: number): number {
    const probe = this.#probe?.items.get(entry);
    const quality = probe?.quality ?? this.#template(entry)?.quality ?? this.#context.item?.(entry)?.quality;
    return quality !== undefined && Number.isInteger(quality) && quality >= 0 && quality < QUALITY_HEX.length ? quality : 1;
  }

  #itemTexture(entry: number, displayId: number | undefined): string {
    const probe = this.#probe?.items.get(entry);
    if (probe) return probe.texture ?? FRAMEXML_LOOT_UNKNOWN_ICON;
    const display = displayId ?? this.#template(entry)?.displayInfoId;
    return (display !== undefined && display > 0 ? this.#context.displayIcon?.(display) : undefined)
      || this.#context.item?.(entry)?.texture
      || FRAMEXML_LOOT_UNKNOWN_ICON;
  }

  #link(entry: number, randomPropertyId: number, randomSuffix: number): string {
    const name = this.#itemName(entry) ?? `Item ${entry}`;
    const color = QUALITY_HEX[this.#itemQuality(entry)] ?? "ffffffff";
    // `item:id:enchant:gem1..4:suffixId:uniqueId:level`: a rolled suffix is a negative property id.
    return `|c${color}|Hitem:${entry}:0:0:0:0:0:${randomPropertyId | 0}:${randomSuffix | 0}:${this.#context.playerLevel()}|h[${name}]|h|r`;
  }

  #bindOnPickup(entry: number): boolean {
    return this.#template(entry)?.bonding === BIND_WHEN_PICKED_UP;
  }

  numItems(): number {
    const layout = this.#view();
    return layout ? layout.slots.length + (layout.coin ? 1 : 0) : 0;
  }

  /** `LootSlotIsCoin`: slot 1 while the money is still on the corpse. */
  slotIsCoin(slot: number): boolean {
    const layout = this.#view();
    return this.#entry(slot)?.kind === "coin" && (layout?.window.gold ?? 0) > 0;
  }

  /** `LootSlotIsItem`: an item slot nobody has taken yet. */
  slotIsItem(slot: number): boolean {
    const entry = this.#entry(slot);
    return entry?.kind === "item" && !entry.slot.taken;
  }

  /**
   * `GetLootSlotInfo`, flat. The name is nil while the item is unknown and for the coin slot; the
   * Lua shim below puts in RETRIEVING_ITEM_INFO and the client's GOLD/SILVER/COPPER_AMOUNT lines.
   * `locked` is the red slot: another player's roll is running, or TrinityCore locked it for this
   * looter (a master looter's own slots are not locked — clicking one opens the candidate list).
   */
  slotInfo(slot: number): FrameXmlLootSlotInfo | undefined {
    const entry = this.#entry(slot);
    const layout = this.#view();
    if (!entry || !layout) return undefined;
    if (entry.kind === "coin") {
      const copper = layout.window.gold;
      return copper > 0 ? [frameXmlLootCoinIcon(copper), undefined, 0, 0, undefined, copper] : undefined;
    }
    const item = entry.slot;
    if (item.taken) return undefined;
    const locked = item.slotType === LOOT_SLOT_ROLL_ONGOING || item.slotType === LOOT_SLOT_LOCKED;
    return [
      this.#itemTexture(item.itemId, item.displayId), this.#itemName(item.itemId), item.count,
      this.#itemQuality(item.itemId), locked ? true : undefined, undefined,
    ];
  }

  slotLink(slot: number): string | undefined {
    const entry = this.#entry(slot);
    if (entry?.kind !== "item" || entry.slot.taken) return undefined;
    return this.#link(entry.slot.itemId, entry.slot.randomPropertyId, entry.slot.randomSuffix);
  }

  isFishingLoot(): boolean {
    return this.#view()?.window.lootType === LOOT_FISHING;
  }

  /**
   * `LootSlot(slot)`: what a click on a loot button does. The money is taken; a master looter's
   * slot opens the candidate list; a slot another player's roll holds says so; a bind-on-pickup
   * item on an `ALLOW_LOOT` slot asks first; anything else is stored.
   */
  lootSlot(slot: number): void {
    const world = this.#owned ? this.#world() : undefined;
    const entry = this.#entry(slot);
    if (!world || !entry) return;
    if (entry.kind === "coin") {
      if (this.slotIsCoin(slot)) world.takeLootMoney();
      return;
    }
    const item = entry.slot;
    if (item.taken) return;
    if (item.slotType === LOOT_SLOT_MASTER) {
      if (world.masterLootCandidates.length > 0) this.#fire("OPEN_MASTER_LOOT_LIST");
      return;
    }
    if (item.slotType === LOOT_SLOT_ROLL_ONGOING) {
      this.#fire("UI_ERROR_MESSAGE", this.#strings?.("ERR_LOOT_ROLL_PENDING") ?? "Этот предмет пока не разыграли.");
      return;
    }
    if (item.slotType === LOOT_SLOT_LOCKED) return;
    if (item.slotType === LOOT_SLOT_ALLOW_LOOT && this.#bindOnPickup(item.itemId)) {
      this.#fire("LOOT_BIND_CONFIRM", slot);
      return;
    }
    world.takeLootSlot(item.index);
  }

  /** `ConfirmLootSlot(slot)`: the LOOT_BIND popup's OK — the stored item binds. */
  confirmLootSlot(slot: number): void {
    const world = this.#owned ? this.#world() : undefined;
    const entry = this.#entry(slot);
    if (world && entry?.kind === "item" && !entry.slot.taken) world.takeLootSlot(entry.slot.index);
  }

  /**
   * `CloseLoot()`: release the opening stock is showing, and only that one. LOOT_CLOSED is raised by
   * the next tick, when the world has let it go. A replacement opening the server already sent (it
   * releases the previous loot itself, Player::SendLoot) is never released by the OnHide the old
   * one's LOOT_CLOSED causes: by then `#shown` no longer names the world's current loot.
   */
  closeLoot(): void {
    const world = this.#owned ? this.#world() : undefined;
    if (world?.loot !== undefined && world.loot === this.#shown) world.closeLoot();
  }

  // ---- master loot ------------------------------------------------------------------------

  /**
   * The guid behind `GetMasterLootCandidate(index)`. In a party the index is the candidate's place
   * in `SMSG_LOOT_MASTER_LIST` (the server walks the group in order). In a raid the stock dropdown
   * groups indices by five (LootFrame.lua:266-281), so the index is the raid slot, subgroup × 5 +
   * place in it; the player sits first in their own subgroup, the others in group-list order.
   */
  #candidate(index: number): bigint | undefined {
    const world = this.#context.world();
    if (!world || !Number.isInteger(index) || index < 1) return undefined;
    const candidates = world.masterLootCandidates;
    const group = world.group;
    if (!group || (group.groupType & GROUPTYPE_RAID) === 0) return candidates[index - 1];
    const bySubgroup = new Map<number, bigint[]>();
    const add = (subGroup: number, guid: bigint): void => {
      const list = bySubgroup.get(subGroup) ?? [];
      list.push(guid);
      bySubgroup.set(subGroup, list);
    };
    const self = world.state.selfGuid;
    if (self !== undefined) add(group.ownSubGroup, self);
    for (const member of group.members) add(member.subGroup, member.guid);
    const subGroup = Math.floor((index - 1) / 5);
    const guid = bySubgroup.get(subGroup)?.[(index - 1) % 5];
    return guid !== undefined && candidates.includes(guid) ? guid : undefined;
  }

  masterLootCandidate(index: number): string | undefined {
    const guid = this.#candidate(index);
    if (guid === undefined) return undefined;
    const world = this.#context.world();
    const name = world?.displayName?.(guid)
      || world?.group?.members.find((member) => member.guid === guid)?.name;
    return name || undefined;
  }

  /** `GiveMasterLoot(slot, candidateIndex)` → CMSG_LOOT_MASTER_GIVE with the wire slot. */
  giveMasterLoot(slot: number, index: number): void {
    const world = this.#owned ? this.#world() : undefined;
    const entry = this.#entry(slot);
    const target = this.#candidate(index);
    if (!world || entry?.kind !== "item" || entry.slot.taken || target === undefined) return;
    world.giveMasterLoot(entry.slot.index, target);
  }

  // ---- rolls' C API ------------------------------------------------------------------------

  #rollEntry(id: number): FrameXmlLootRollEntry | undefined {
    const probe = this.#probe?.roll;
    if (probe) return probe.id === id ? probe.entry : undefined;
    const roll = this.#rolls.get(id);
    if (!roll || roll.cancelled) return undefined;
    return this.#context.world()?.lootRolls.get(roll.itemGuid);
  }

  /**
   * `GetLootRollItemInfo(rollID)`. The buttons come from the wire's vote mask; the reasons are what
   * TrinityCore's Group.cpp strips each for: need goes for everyone when the item may only be rolled
   * greed (reason 5) and for one player under the dungeon finder's class rules (reason 1);
   * disenchant is offered only when the item can be disenchanted (else reason 3) and the group has
   * an enchanter of its RequiredDisenchantSkill (else reason 4, with that skill).
   */
  rollItemInfo(id: number): FrameXmlLootRollItemInfo | undefined {
    const entry = this.#rollEntry(id);
    if (!entry) return undefined;
    const { itemId, count, voteMask } = entry.start;
    const template = this.#template(itemId);
    const canNeed = (voteMask & ROLL_FLAG_NEED) !== 0;
    const canGreed = (voteMask & ROLL_FLAG_GREED) !== 0;
    const canDisenchant = (voteMask & ROLL_FLAG_DISENCHANT) !== 0;
    const greedOnly = template !== undefined && (template.flags2 & ITEM_FLAG2_CAN_ONLY_ROLL_GREED) !== 0;
    // The core writes RequiredDisenchantSkill as int32 -1 for "cannot be disenchanted"; the query
    // parser reads it unsigned (QueryCacheProtocol.ts:304), so it is re-signed here.
    const skill = (template?.requiredDisenchantSkill ?? -1) | 0;
    return [
      this.#itemTexture(itemId, undefined), this.#itemName(itemId), count, this.#itemQuality(itemId),
      this.#bindOnPickup(itemId), canNeed, canGreed, canDisenchant,
      canNeed ? 0 : greedOnly ? REASON_NEED_DISABLED : REASON_CLASS,
      0,
      canDisenchant ? 0 : skill < 0 ? REASON_NOT_DISENCHANTABLE : REASON_NO_ENCHANTER,
      Math.max(0, skill),
    ];
  }

  rollItemLink(id: number): string | undefined {
    const entry = this.#rollEntry(id);
    return entry ? this.#link(entry.start.itemId, entry.start.randomPropertyId, entry.start.randomSuffix) : undefined;
  }

  /** Milliseconds left, on the clock the start packet was stamped with; 0 once over. */
  rollTimeLeft(id: number): number {
    const entry = this.#rollEntry(id);
    if (!entry) return 0;
    if (this.#probe?.roll) return entry.start.countdown;
    return Math.max(0, entry.startedAt + entry.start.countdown - this.#now());
  }

  #rollAllowed(entry: FrameXmlLootRollEntry, rollType: number): boolean {
    const flag = rollType === ROLL_PASS ? ROLL_FLAG_PASS : rollType === ROLL_NEED ? ROLL_FLAG_NEED
      : rollType === ROLL_GREED ? ROLL_FLAG_GREED : rollType === ROLL_DISENCHANT ? ROLL_FLAG_DISENCHANT : 0;
    // The server always accepts a pass; the mask's pass bit is informational.
    return rollType === ROLL_PASS || (entry.start.voteMask & flag) !== 0;
  }

  /** `RollOnLoot(rollID, rollType)`: a bind-on-pickup need/greed/disenchant asks first. */
  rollOnLoot(id: number, rollType: number): void {
    const world = this.#owned ? this.#world() : undefined;
    const roll = this.#rolls.get(id);
    const entry = this.#rollEntry(id);
    if (!world || !roll || roll.answered || !entry || !this.#rollAllowed(entry, rollType)) return;
    if (rollType !== ROLL_PASS && this.#bindOnPickup(entry.start.itemId)) {
      this.#fire(rollType === ROLL_DISENCHANT ? "CONFIRM_DISENCHANT_ROLL" : "CONFIRM_LOOT_ROLL", id, rollType);
      return;
    }
    this.#sendRoll(world, roll, rollType);
  }

  /** `ConfirmLootRoll(rollID, rollType)`: the CONFIRM_LOOT_ROLL popup's OK. */
  confirmLootRoll(id: number, rollType: number): void {
    const world = this.#owned ? this.#world() : undefined;
    const roll = this.#rolls.get(id);
    const entry = this.#rollEntry(id);
    if (!world || !roll || roll.answered || !entry || !this.#rollAllowed(entry, rollType)) return;
    this.#sendRoll(world, roll, rollType);
  }

  #sendRoll(world: FrameXmlLootWorld, roll: RollState, rollType: number): void {
    world.rollForLoot(roll.itemGuid, rollType);
    // The frame comes down at the next tick (CANCEL_LOOT_ROLL); the server's echo of this vote
    // would do the same a round trip later.
    roll.answered = true;
  }

  // ---- events ----------------------------------------------------------------------------

  /** Once per rendered frame: deliver queued events, then diff the world against what stock was told. */
  tick(): void {
    if (!this.#pump) return;
    this.#flush();
    if (!this.#owned) return;
    const world = this.#context.world();
    this.#reconcileLoot(world);
    this.#reconcileRolls(world);
    this.#flush();
  }

  #resetOpening(): void {
    this.#shown = undefined;
    this.#layout = undefined;
    this.#cleared.clear();
    this.#signatures = [];
    this.#candidates = undefined;
    this.#source = undefined;
    this.#openDistance = 0;
    this.#autoPending.clear();
  }

  #errorText(error: number): string {
    const name = LOOT_ERROR_STRINGS[error];
    return (name !== undefined ? this.#strings?.(name) : undefined) ?? lootErrorText(error);
  }

  #signature(slot: number): string {
    const info = this.slotInfo(slot);
    return info ? `${info[0]}\u0001${info[1] ?? ""}\u0001${info[3]}\u0001${info[4] ? 1 : 0}` : "";
  }

  #reconcileLoot(world: FrameXmlLootWorld | undefined): void {
    const loot = world?.loot;
    if (loot !== this.#shown) {
      if (this.#shown) {
        this.#resetOpening();
        this.#fire("LOOT_CLOSED");
        // Delivered before a replacement is recorded: LOOT_CLOSED hides LootFrame, whose OnHide
        // calls CloseLoot, which must find nothing shown rather than release the new opening.
        this.#flush();
      }
      if (loot?.error !== undefined) {
        if (loot !== this.#refused) {
          this.#refused = loot;
          this.#fire("UI_ERROR_MESSAGE", this.#errorText(loot.error));
        }
      } else if (loot && world) {
        this.#open(world, loot);
      }
      return;
    }
    const layout = this.#layout;
    if (!loot || !world || !layout) return;
    const offset = layout.coin ? 1 : 0;
    if (layout.coin && loot.gold <= 0 && !this.#cleared.has(1)) {
      this.#cleared.add(1);
      this.#fire("LOOT_SLOT_CLEARED", 1);
      this.#context.playSound?.("LOOTWINDOWCOINSOUND");
    }
    layout.slots.forEach((slot, index) => {
      const number = index + 1 + offset;
      if (slot.taken && !this.#cleared.has(number)) {
        this.#cleared.add(number);
        this.#fire("LOOT_SLOT_CLEARED", number);
      }
    });
    // A late item query (name, quality, icon) repaints just that button.
    for (let number = 1 + offset; number <= layout.slots.length + offset; number += 1) {
      if (this.#cleared.has(number)) continue;
      const signature = this.#signature(number);
      if (signature !== this.#signatures[number]) {
        this.#signatures[number] = signature;
        this.#fire("LOOT_SLOT_CHANGED", number);
      }
    }
    if (world.masterLootCandidates !== this.#candidates) {
      this.#candidates = world.masterLootCandidates;
      this.#fire("UPDATE_MASTER_LOOT_LIST");
    }
    if (this.#autoPending.size > 0) this.#autoLoot(world);
    const total = layout.slots.length + offset;
    if (total > 0 && this.#cleared.size >= total) {
      // Everything taken: the client lets the corpse go, as it does after the last click.
      world.closeLoot();
      return;
    }
    if (this.#walkedAway(world, loot)) world.closeLoot();
  }

  #open(world: FrameXmlLootWorld, loot: LootWindow): void {
    this.#shown = loot;
    this.#layout = { window: loot, coin: loot.gold > 0, slots: [...loot.slots] };
    this.#cleared.clear();
    this.#candidates = world.masterLootCandidates;
    // The looted unit, if it is one: walking away from it closes the window (see the header).
    const source = world.state.objects.get(loot.guid);
    this.#source = source?.typeId === TYPEID_UNIT && loot.lootType !== LOOT_FISHING ? source : undefined;
    const self = world.state.selfGuid === undefined ? undefined : world.state.objects.get(world.state.selfGuid);
    this.#openDistance = distance(self, this.#source) ?? 0;
    // Item queries leave from here, never from a C-API read; their answers repaint through
    // LOOT_SLOT_CHANGED.
    for (const slot of loot.slots) if (!slot.taken) world.itemTemplate(slot.itemId);
    const handover = loot === this.#handover;
    this.#handover = undefined;
    const auto = !handover && this.#context.autoLootDefault() !== (this.#context.autoLootModifier?.() ?? false);
    this.#signatures = [];
    for (let number = 1; number <= this.numItems(); number += 1) this.#signatures[number] = this.#signature(number);
    this.#fire("LOOT_OPENED", auto ? 1 : 0);
    if (auto) {
      for (let number = 1; number <= this.numItems(); number += 1) this.#autoPending.add(number);
      this.#autoSince = this.#now();
      this.#autoLoot(world);
    }
  }

  /**
   * Auto-loot takes what a click would take: money and free slots. A bind-on-pickup item on an
   * `ALLOW_LOOT` slot still asks (LOOT_BIND_CONFIRM, one popup — StaticPopup's LOOT_BIND is
   * exclusive); master, locked and running-roll slots stay for the player. A slot whose template has
   * not arrived waits for it, at most AUTO_LOOT_TEMPLATE_WAIT_MS, because the template decides that.
   */
  #autoLoot(world: FrameXmlLootWorld): void {
    const waited = this.#now() - this.#autoSince >= AUTO_LOOT_TEMPLATE_WAIT_MS;
    let asked = false;
    for (const number of [...this.#autoPending]) {
      const entry = this.#entry(number);
      if (!entry) { this.#autoPending.delete(number); continue; }
      if (entry.kind === "coin") {
        this.#autoPending.delete(number);
        if (this.slotIsCoin(number)) world.takeLootMoney();
        continue;
      }
      const item = entry.slot;
      if (item.taken || item.slotType === LOOT_SLOT_MASTER || item.slotType === LOOT_SLOT_ROLL_ONGOING
        || item.slotType === LOOT_SLOT_LOCKED) {
        this.#autoPending.delete(number);
        continue;
      }
      if (item.slotType === LOOT_SLOT_ALLOW_LOOT) {
        if (!this.#template(item.itemId)) {
          if (waited) this.#autoPending.delete(number);
          continue;
        }
        if (this.#bindOnPickup(item.itemId)) {
          this.#autoPending.delete(number);
          if (!asked) this.#fire("LOOT_BIND_CONFIRM", number);
          asked = true;
          continue;
        }
      }
      this.#autoPending.delete(number);
      world.takeLootSlot(item.index);
    }
  }

  /**
   * The looted creature is gone from the world, or the player is out of the server's own looting
   * radius and farther than when the window opened (an opening at the edge does not close itself).
   */
  #walkedAway(world: FrameXmlLootWorld, loot: LootWindow): boolean {
    const source = this.#source;
    if (!source) return false;
    const current = world.state.objects.get(loot.guid);
    if (current !== source) return true;
    const self = world.state.selfGuid === undefined ? undefined : world.state.objects.get(world.state.selfGuid);
    const now = distance(self, current);
    if (now === undefined) return false;
    const radius = INTERACTION_DISTANCE + combatReach(self) + combatReach(current);
    return now > Math.max(radius, this.#openDistance);
  }

  #selfVoted(world: FrameXmlLootWorld, entry: FrameXmlLootRollEntry): boolean {
    const self = world.state.selfGuid;
    return self !== undefined && entry.votes.some((vote) => vote.playerGuid === self);
  }

  #reconcileRolls(world: FrameXmlLootWorld | undefined): void {
    if (world !== this.#rollWorld) {
      // A new world (relog, reconnect): the old one's rolls are over for this client.
      for (const [id, roll] of this.#rolls) {
        if (roll.announced && !roll.cancelled) this.#fire("CANCEL_LOOT_ROLL", id);
      }
      this.#rolls.clear();
      this.#rollIds.clear();
      this.#rollWorld = world;
    }
    if (!world) return;
    const now = this.#now();
    for (const [itemGuid, entry] of world.lootRolls) {
      let id = this.#rollIds.get(itemGuid);
      const live = !entry.won && !entry.passed && now < entry.startedAt + entry.start.countdown;
      if (id === undefined) {
        // Finished before this client saw it: never announced, never tracked.
        if (!live) continue;
        id = this.#nextRollId;
        this.#nextRollId += 1;
        this.#rollIds.set(itemGuid, id);
        this.#rolls.set(id, { itemGuid, seenAt: now, announced: false, answered: false, cancelled: false });
        world.itemTemplate(entry.start.itemId);
      }
      const roll = this.#rolls.get(id);
      if (!roll || roll.cancelled) continue;
      if (!roll.answered && this.#selfVoted(world, entry)) roll.answered = true;
      if (!live || roll.answered) {
        roll.cancelled = true;
        if (roll.announced) this.#fire("CANCEL_LOOT_ROLL", id);
        continue;
      }
      if (!roll.announced && (this.#itemName(entry.start.itemId) !== undefined || now - roll.seenAt >= ROLL_NAME_GRACE_MS)) {
        roll.announced = true;
        this.#fire("START_LOOT_ROLL", id, entry.start.countdown);
      }
    }
  }

  /** Rolls stock currently shows, for the owner's Escape/diagnostics answers. */
  announcedRolls(): number[] {
    return [...this.#rolls].filter(([, roll]) => roll.announced && !roll.cancelled).map(([id]) => id);
  }

  /** Whether stock was told about an opening that is still open. */
  shownOpening(): boolean {
    return this.#shown !== undefined;
  }
}

/** The part of the world seam the bindings read. */
export interface FrameXmlLootHost {
  readonly loot?: FrameXmlLootModel | undefined;
}

export type FrameXmlLootBinding = (host: FrameXmlLootHost, args: readonly unknown[]) => readonly unknown[];

const NOTHING: readonly [] = Object.freeze([]);

function integerArg(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(number) ? number : undefined;
}

function optional(value: unknown): readonly unknown[] {
  return value === undefined ? NOTHING : [value];
}

const withLoot = (answer: (loot: FrameXmlLootModel, args: readonly unknown[]) => readonly unknown[]): FrameXmlLootBinding =>
  (host, args) => host.loot ? answer(host.loot, args) : NOTHING;

const command = (run: (loot: FrameXmlLootModel, args: readonly unknown[]) => void): FrameXmlLootBinding =>
  withLoot((loot, args) => { run(loot, args); return NOTHING; });

/**
 * The flat C API. Names here are installed into `__fxNeutralImpl` like every seam name.
 * `GetLootSlotInfo` and `GetLootRollItemInfo` are the Lua shim below over `WebClientLoot*`: the
 * coin name is the client's GOLD/SILVER/COPPER_AMOUNT lines and an unknown item reads
 * RETRIEVING_ITEM_INFO, both GlobalStrings the host does not hold.
 */
export const FRAMEXML_LOOT_BINDINGS: Readonly<Record<string, FrameXmlLootBinding>> = Object.freeze({
  GetNumLootItems: withLoot((loot) => [loot.numItems()]),
  LootSlotIsItem: withLoot((loot, args) => [loot.slotIsItem(integerArg(args[0]) ?? 0)]),
  LootSlotIsCoin: withLoot((loot, args) => [loot.slotIsCoin(integerArg(args[0]) ?? 0)]),
  GetLootSlotLink: withLoot((loot, args) => optional(loot.slotLink(integerArg(args[0]) ?? 0))),
  LootSlot: command((loot, args) => loot.lootSlot(integerArg(args[0]) ?? 0)),
  ConfirmLootSlot: command((loot, args) => loot.confirmLootSlot(integerArg(args[0]) ?? 0)),
  CloseLoot: command((loot) => loot.closeLoot()),
  IsFishingLoot: withLoot((loot) => [loot.isFishingLoot()]),
  GetMasterLootCandidate: withLoot((loot, args) => optional(loot.masterLootCandidate(integerArg(args[0]) ?? 0))),
  GiveMasterLoot: command((loot, args) => loot.giveMasterLoot(integerArg(args[0]) ?? 0, integerArg(args[1]) ?? 0)),
  GetLootRollItemLink: withLoot((loot, args) => optional(loot.rollItemLink(integerArg(args[0]) ?? 0))),
  GetLootRollTimeLeft: withLoot((loot, args) => [loot.rollTimeLeft(integerArg(args[0]) ?? 0)]),
  RollOnLoot: command((loot, args) => loot.rollOnLoot(integerArg(args[0]) ?? 0, integerArg(args[1]) ?? -1)),
  ConfirmLootRoll: command((loot, args) => loot.confirmLootRoll(integerArg(args[0]) ?? 0, integerArg(args[1]) ?? -1)),
  WebClientLootSlotInfo: withLoot((loot, args) => loot.slotInfo(integerArg(args[0]) ?? 0) ?? NOTHING),
  WebClientLootRollItemInfo: withLoot((loot, args) => loot.rollItemInfo(integerArg(args[0]) ?? 0) ?? NOTHING),
});

/** The GlobalStrings half, appended to FRAMEXML_SEAM_PRELUDE. */
export const FRAMEXML_LOOT_PRELUDE = `
do
  local impl = __fxNeutralImpl
  local slotInfo = rawget(_G, "__fxSeam_WebClientLootSlotInfo")
  local rollInfo = rawget(_G, "__fxSeam_WebClientLootRollItemInfo")
  if impl ~= nil and slotInfo ~= nil and rollInfo ~= nil then
    local floor, format, concat = math.floor, string.format, table.concat
    local function coins(copper)
      local lines = {}
      local gold, silver, rest = floor(copper / 10000), floor(copper / 100) % 100, copper % 100
      if gold > 0 then lines[#lines + 1] = format(GOLD_AMOUNT, gold) end
      if silver > 0 then lines[#lines + 1] = format(SILVER_AMOUNT, silver) end
      if rest > 0 then lines[#lines + 1] = format(COPPER_AMOUNT, rest) end
      return concat(lines, "\\n")
    end
    impl.GetLootSlotInfo = function(slot)
      local texture, name, quantity, quality, locked, copper = slotInfo(slot)
      if texture == nil then return end
      if copper ~= nil then name = coins(copper) elseif name == nil then name = RETRIEVING_ITEM_INFO end
      return texture, name, quantity, quality, locked
    end
    impl.GetLootRollItemInfo = function(id)
      local texture, name, count, quality, bop, need, greed, de, reasonNeed, reasonGreed, reasonDe, skill = rollInfo(id)
      if texture == nil then return end
      return texture, name or RETRIEVING_ITEM_INFO, count, quality, bop, need, greed, de, reasonNeed, reasonGreed, reasonDe, skill
    end
  end
end
`;
