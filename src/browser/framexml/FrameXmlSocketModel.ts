/**
 * The stock ItemSocketingFrame's C API (Blizzard_ItemSocketingUI.lua) over this client's inventory:
 * the item the player is socketing, the gems staged into its sockets, and `CMSG_SOCKET_GEMS`.
 *
 * 3.3.5 keeps the socketing session in the client. `SocketInventoryItem`/`SocketContainerItem` pick
 * the item and raise SOCKET_INFO_UPDATE (UIParent then loads the add-on and shows the frame);
 * `ClickSocketButton` moves the gem on the cursor into a socket, or a staged gem back onto the
 * cursor; `AcceptSockets` sends the item and the three gem GUIDs; `CloseSocketInfo` ends it with
 * SOCKET_INFO_CLOSE. The server answers `SMSG_SOCKET_GEMS_RESULT` (or an equip error) and updates
 * the item's enchantment fields, and the frame repaints on SOCKET_INFO_UPDATE.
 *
 * Two TrinityCore facts shape the staging (ItemHandler.cpp HandleSocketOpcode):
 * * a normal gem in a meta socket, or a meta gem in a normal one, drops the whole packet in silence,
 *   so the meta rule is enforced when the gem is staged;
 * * the socketed gem item is destroyed whole (`DestroyItem(bag, slot)`), not one of its stack, so a
 *   gem from a stack is first split off into a free bag slot (`CMSG_SPLIT_ITEM`, count 1) and the
 *   separated single is what is staged — the native window (ui/Socketing.ts) does the same.
 *
 * Nothing here is owned until the lazy owner (FrameXmlSocketOwner.ts) publishes a gated frame:
 * `request` answers false while no stock owner is listening, and FrameXmlSocketing.ts's legacy
 * frame and native picker keep the session then.
 */

/** `SOCKET_COLOR_*` (ItemTemplate.h); 14 is the prismatic socket `itemSocketColors` gives a buckle. */
export const FRAMEXML_SOCKET_META = 1;
export const FRAMEXML_SOCKET_PRISMATIC = 14;

/** `ITEM_FIELD_FLAG_BOP_TRADEABLE` (ItemTemplate.h). */
const ITEM_FIELD_FLAG_BOP_TRADEABLE = 0x100;

/** Enchantment slots 2..4 hold the socketed gems (`SOCK_ENCHANTMENT_SLOT`, ItemDefines.h). */
const SOCKET_ENCHANTMENT_SLOT = 2;

/** How long a staged split may wait for its separated gem before the socket gives up on it. */
const SPLIT_TIMEOUT_S = 12;
/**
 * How often an open session re-reads its item and gems between the player's own actions: reading
 * the item walks the inventory projection, so it runs at the native window's cadence (a 300 ms
 * interval in ui/Socketing.ts), not every rendered frame. Every action re-arms it at once.
 */
const RECHECK_INTERVAL_S = 0.25;

/**
 * `GetSocketTypes` wording: the key GEM_TYPE_INFO (Blizzard_ItemSocketingUI.lua:4-9) is indexed by.
 * A prismatic socket is `"Socket"`, the table's own row for it.
 */
export function frameXmlSocketTypeName(color: number): string {
  switch (color) {
    case FRAMEXML_SOCKET_META: return "Meta";
    case 2: return "Red";
    case 4: return "Yellow";
    case 8: return "Blue";
    case FRAMEXML_SOCKET_PRISMATIC: return "Socket";
    default: return "";
  }
}

/** The client's socket bonus test: a gem matches when its colour mask shares a bit with the socket's. */
export function frameXmlGemMatchesSocket(socketColor: number, gemColor: number | undefined): boolean {
  if (!gemColor || !socketColor) return false;
  if (socketColor === FRAMEXML_SOCKET_META || gemColor === FRAMEXML_SOCKET_META) {
    return socketColor === FRAMEXML_SOCKET_META && gemColor === FRAMEXML_SOCKET_META;
  }
  return (socketColor & gemColor) !== 0;
}

/** How the Lua API addresses an item: 0 = equipment slot 1..19, 1 = bag 0..4 and slot 1..n. */
export interface FrameXmlSocketTarget {
  readonly location: number;
  readonly bag: number;
  readonly slot: number;
}

/** The item being socketed, as the host reads it now. */
export interface FrameXmlSocketItem {
  readonly guid: bigint;
  readonly entry: number;
  readonly name?: string | undefined;
  readonly texture?: string | undefined;
  readonly quality?: number | undefined;
  /** Template `Socket[0..2].Color`; undefined until the template is cached. */
  readonly sockets: readonly number[] | undefined;
  /** Enchantment ids by slot, 0 permanent … 6 prismatic (Item.h). */
  readonly enchantments: readonly number[];
  /** `ITEM_FIELD_FLAGS`. */
  readonly flags: number;
  /**
   * 2.10: the client's refund record with time left and no blocking enchantment (Wow.exe
   * 0x005c50e0, `frameXmlItemRefundable`) — what `GetSocketItemRefundable` answers, not the flag.
   */
  readonly refundable?: boolean | undefined;
}

/** One carried item, by GUID and where it lies. */
export interface FrameXmlSocketCarried {
  readonly guid: bigint;
  readonly entry: number;
  readonly count: number;
  readonly bag: number;
  readonly slot: number;
}

/** What a gem item is: its name, picture and `GemProperties.Type` colour mask. */
export interface FrameXmlSocketGemFacts {
  readonly name?: string | undefined;
  readonly texture?: string | undefined;
  readonly quality?: number | undefined;
  /** `GemProperties.Type`; undefined for an item that is not a gem (or not cached yet). */
  readonly color?: number | undefined;
  /** `GemProperties.Enchant_Id`: the enchantment the socket takes. */
  readonly enchantmentId?: number | undefined;
}

export interface FrameXmlSocketHost {
  item(target: FrameXmlSocketTarget): FrameXmlSocketItem | undefined;
  /** A carried (backpack or bag) item by GUID; bank and equipment never hold a gem to socket. */
  carried(guid: bigint): FrameXmlSocketCarried | undefined;
  /** The carried item at a native bag/slot, for a split landing there. */
  carriedAt(bag: number, slot: number): FrameXmlSocketCarried | undefined;
  /** What the bag cursor holds, GUID-checked. */
  cursor(): FrameXmlSocketCarried | undefined;
  clearCursor(): void;
  pickup(guid: bigint): void;
  gem(entry: number): FrameXmlSocketGemFacts | undefined;
  /** `SpellItemEnchantment.SrcItemID`: the gem item an existing socket enchantment came from. */
  enchantmentGem(enchantmentId: number): number | undefined;
  /** An item link for a gem or the socketed item, enchantments in link order when given. */
  itemLink(entry: number, enchantments?: readonly number[]): string | undefined;
  /** `CMSG_SPLIT_ITEM` of one gem into a free slot that takes gems; its native slot, or undefined. */
  splitOne(guid: bigint): { readonly bag: number; readonly slot: number } | undefined;
  /** `CMSG_SOCKET_GEMS`; false when nothing could be sent. */
  socketGems(itemGuid: bigint, gems: readonly [bigint, bigint, bigint]): boolean;
  /** Ask for templates/metadata outside a C-API read; `onChanged` repaints when they land. */
  prefetch?(entries: readonly number[], onChanged: () => void): void;
  /** The set of staged gems changed: the bags repaint their lock state (`staged` is the lock). */
  locksChanged?(): void;
  /** Subscribe to the socketing answers; returns the unsubscribe. */
  subscribe?(model: FrameXmlSocketModel): () => void;
  now(): number;
}

interface SocketPump {
  fire(event: string, ...args: readonly unknown[]): number;
}

interface PendingSplit {
  readonly socket: number;
  readonly sourceGuid: bigint;
  readonly entry: number;
  readonly bag: number;
  readonly slot: number;
  readonly at: number;
}

interface Session {
  readonly target: FrameXmlSocketTarget;
  readonly guid: bigint;
  readonly entry: number;
  /** The staged gem GUID per socket, 0n for none. */
  readonly staged: [bigint, bigint, bigint];
  split: PendingSplit | undefined;
  pending: boolean;
  /** The enchantment ids last painted, compared (not rebuilt) every tick. */
  readonly seen: number[];
}

/** One owner of ItemSocketingFrame's C API and its SOCKET_INFO_* events. */
export class FrameXmlSocketModel {
  readonly #host: FrameXmlSocketHost;
  #pump: SocketPump | undefined;
  #unsubscribe: (() => void) | undefined;
  #session: Session | undefined;
  #owned = false;
  /** When the open session last re-read its item (`tick`); -Infinity re-reads on the next tick. */
  #checkedAt = Number.NEGATIVE_INFINITY;
  /**
   * Set by the lazy stock owner: a request to show the socketing frame (load and gate on the first
   * one). Returns false when the owner cannot take it, which leaves the legacy path in charge.
   */
  onOpenRequest: (() => boolean) | undefined;
  /** The VM's GlobalStrings, for UI_ERROR_MESSAGE wording; bound by the owner. */
  globalString: ((name: string) => string | undefined) | undefined;

  constructor(host: FrameXmlSocketHost) {
    this.#host = host;
  }

  attach(pump: SocketPump): void {
    this.detach();
    this.#pump = pump;
    this.#unsubscribe = this.#host.subscribe?.(this);
  }

  detach(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#pump = undefined;
    this.#drop();
  }

  /** Stock ItemSocketingFrame holds the session; the edge shows a session already requested. */
  get owned(): boolean { return this.#owned; }
  set owned(value: boolean) {
    if (value === this.#owned) return;
    this.#owned = value;
    if (value && this.#session) this.#fire("SOCKET_INFO_UPDATE");
    if (!value) this.#drop();
  }

  /** Whether a stock socketing session is open (the frame is up or loading for it). */
  get active(): boolean { return this.#session !== undefined; }

  /** The GUID of the item being socketed, for tests and the mount. */
  get itemGuid(): bigint | undefined { return this.#session?.guid; }

  /**
   * Whether a carried gem is staged in the open session. The client locks (greys) it in the bags until
   * the socket gives it back, the sockets are accepted or the session ends: LiveWorldSeam's container
   * reads answer it locked and refuse to pick it up or use it.
   */
  staged(guid: bigint): boolean {
    return guid !== 0n && this.#session?.staged.includes(guid) === true;
  }

  /**
   * `SocketInventoryItem`/`SocketContainerItem`: true when the stock route took the request (the
   * frame shows now, or once the add-on has loaded), false to leave it to the legacy path.
   */
  request(target: FrameXmlSocketTarget): boolean {
    const open = this.onOpenRequest;
    if (!open) return false;
    const item = this.#host.item(target);
    const colors = item ? this.#colors(item) : undefined;
    // An empty slot or an item without sockets opens nothing, as in the client; a session already
    // open for another item is ended first. An item whose template is still in flight opens, and
    // its sockets appear with the template (the prefetch below repaints).
    if (!item || (colors && colors.every((color) => color === 0))) {
      this.close();
      return true;
    }
    // A session open for another item gives its staged gems back.
    this.#drop();
    this.#session = {
      target: { location: target.location, bag: target.bag, slot: target.slot },
      guid: item.guid, entry: item.entry, staged: [0n, 0n, 0n], split: undefined,
      pending: false, seen: [...item.enchantments],
    };
    this.#prefetch(item);
    if (!open()) {
      this.#session = undefined;
      return false;
    }
    if (this.#owned) this.#fire("SOCKET_INFO_UPDATE");
    return true;
  }

  /** Drop the session without SOCKET_INFO_CLOSE: a failed load hands its item to the native picker. */
  abandon(): FrameXmlSocketTarget | undefined {
    const target = this.#session?.target;
    this.#drop();
    return target;
  }

  /** `CloseSocketInfo`: ends the session with SOCKET_INFO_CLOSE (the frame's OnHide calls it too). */
  close(): boolean {
    const session = this.#session;
    if (!session) return false;
    this.#drop();
    this.#fire("SOCKET_INFO_CLOSE");
    return true;
  }

  // ---- the C API ---------------------------------------------------------------------------

  socketItemInfo(): readonly unknown[] {
    const item = this.#item();
    return item ? [item.name ?? this.#host.gem(item.entry)?.name, item.texture, item.quality ?? 0] : [];
  }

  /** Wow.exe 0x005c5470 → 0x005c50e0: the refund record, not ITEM_FIELD_FLAG_REFUNDABLE. */
  socketItemRefundable(): boolean {
    return this.#item()?.refundable === true;
  }

  socketItemBoundTradeable(): boolean {
    return ((this.#item()?.flags ?? 0) & ITEM_FIELD_FLAG_BOP_TRADEABLE) !== 0;
  }

  numSockets(): number {
    const item = this.#item();
    if (!item) return 0;
    let count = 0;
    for (const color of this.#colors(item) ?? []) if (color !== 0) count += 1;
    return count;
  }

  socketTypes(index: number): string | undefined {
    const color = this.#socketColor(index);
    return color ? frameXmlSocketTypeName(color) : undefined;
  }

  existingSocketInfo(index: number): readonly unknown[] {
    const entry = this.#existingGem(index);
    if (!entry) return [];
    const facts = this.#host.gem(entry);
    return [facts?.name ?? "", facts?.texture, frameXmlGemMatchesSocket(this.#socketColor(index) ?? 0, facts?.color)];
  }

  existingSocketLink(index: number): string | undefined {
    const entry = this.#existingGem(index);
    return entry ? this.#host.itemLink(entry) : undefined;
  }

  newSocketInfo(index: number): readonly unknown[] {
    const gem = this.#stagedGem(index);
    if (!gem) return [];
    const facts = this.#host.gem(gem.entry);
    return [facts?.name ?? "", facts?.texture, frameXmlGemMatchesSocket(this.#socketColor(index) ?? 0, facts?.color)];
  }

  newSocketLink(index: number): string | undefined {
    const gem = this.#stagedGem(index);
    return gem ? this.#host.itemLink(gem.entry) : undefined;
  }

  /** The socketed item's link with the staged gems in place: ItemSocketingDescription's preview. */
  socketedItemLink(): string | undefined {
    const session = this.#session;
    const item = this.#item();
    if (!session || !item) return undefined;
    const enchantments = [...item.enchantments];
    for (let socket = 0; socket < 3; socket += 1) {
      const gem = this.#stagedGem(socket + 1);
      const enchantmentId = gem ? this.#host.gem(gem.entry)?.enchantmentId : undefined;
      if (enchantmentId) enchantments[SOCKET_ENCHANTMENT_SLOT + socket] = enchantmentId;
    }
    return this.#host.itemLink(item.entry, enchantments);
  }

  /**
   * `ClickSocketButton(index)`: the gem on the cursor goes into the socket (a stack is split first);
   * with an empty cursor a staged gem comes back onto it.
   */
  clickSocket(index: number): void {
    const session = this.#session;
    const color = this.#socketColor(index);
    if (!session || !color || session.pending) return;
    const socket = index - 1;
    const cursor = this.#host.cursor();
    if (!cursor) {
      const staged = session.staged[socket]!;
      if (staged === 0n) return;
      session.staged[socket] = 0n;
      this.#host.locksChanged?.();
      if (this.#host.carried(staged)) this.#host.pickup(staged);
      this.#fire("SOCKET_INFO_UPDATE");
      return;
    }
    if (cursor.guid === session.guid) return;
    const facts = this.#host.gem(cursor.entry);
    if (!facts?.color) {
      this.#host.prefetch?.([cursor.entry], () => this.#repaint());
      this.#error("ERR_SOCKETING_REQUIRES_GEM", "Нужен самоцвет.");
      return;
    }
    if ((color === FRAMEXML_SOCKET_META) !== (facts.color === FRAMEXML_SOCKET_META)) {
      this.#error(color === FRAMEXML_SOCKET_META ? "ERR_SOCKETING_REQUIRES_META_GEM" : "ERR_SOCKETING_META_GEM_ONLY_IN_METASLOT",
        color === FRAMEXML_SOCKET_META ? "Для этого гнезда нужен особый самоцвет." : "Особый самоцвет можно вставить только в особое гнездо.");
      return;
    }
    // One split at a time: splitOne names the first free slot, the one a pending split is still
    // landing in, and the core stores a second split onto that same-entry single (SplitItem), which
    // neither socket then recognises. The gem stays on the cursor.
    if (cursor.count > 1 && session.split) {
      this.#error("ERR_OBJECT_IS_BUSY", "Этот объект занят.");
      return;
    }
    // One gem item per socket: the server refuses the same GUID twice in one packet.
    for (let other = 0; other < 3; other += 1) if (other !== socket && session.staged[other] === cursor.guid) session.staged[other] = 0n;
    // A gem put where a split is still landing replaces it; the separated single stays in the bags.
    if (session.split?.socket === socket) session.split = undefined;
    if (cursor.count > 1) {
      const destination = this.#host.splitOne(cursor.guid);
      this.#host.clearCursor();
      if (!destination) {
        this.#error("ERR_INV_FULL", "Инвентарь заполнен.");
        return;
      }
      session.staged[socket] = 0n;
      session.split = {
        socket, sourceGuid: cursor.guid, entry: cursor.entry,
        bag: destination.bag, slot: destination.slot, at: this.#host.now(),
      };
      this.#host.locksChanged?.();
      this.#fire("SOCKET_INFO_UPDATE");
      return;
    }
    session.staged[socket] = cursor.guid;
    this.#host.clearCursor();
    this.#host.locksChanged?.();
    this.#fire("SOCKET_INFO_UPDATE");
  }

  /** `AcceptSockets`: every staged gem, rechecked as a single carried gem, in one CMSG_SOCKET_GEMS. */
  accept(): void {
    const session = this.#session;
    const item = this.#item();
    if (!session || !item || session.pending || session.split) return;
    const gems: [bigint, bigint, bigint] = [0n, 0n, 0n];
    let any = false;
    for (let socket = 0; socket < 3; socket += 1) {
      const guid = session.staged[socket]!;
      if (guid === 0n) continue;
      const gem = this.#host.carried(guid);
      if (!gem || gem.count !== 1) {
        session.staged[socket] = 0n;
        this.#host.locksChanged?.();
        this.#fire("SOCKET_INFO_UPDATE");
        return;
      }
      gems[socket] = guid;
      any = true;
    }
    if (!any || !this.#host.socketGems(session.guid, gems)) return;
    // No timeout re-arms the button: a late answer may still consume the gems (ui/Socketing.ts says
    // the same). An answer that never comes clears when the window is closed and opened again.
    session.pending = true;
  }

  /** `SMSG_SOCKET_GEMS_RESULT` for an item: the staged gems are spent, the frame shows the new ones. */
  result(itemGuid: bigint): void {
    const session = this.#session;
    if (!session || session.guid !== itemGuid) return;
    session.pending = false;
    session.staged.fill(0n);
    this.#host.locksChanged?.();
    this.#repaint();
  }

  /** An equip error naming the item or one of its staged gems: the send failed, the gems stay staged. */
  failure(itemGuid: bigint, text: string | undefined): void {
    const session = this.#session;
    if (!session || (!session.pending && !session.split)) return;
    if (itemGuid !== 0n && itemGuid !== session.guid && !session.staged.includes(itemGuid)
      && itemGuid !== session.split?.sourceGuid) return;
    session.pending = false;
    session.split = undefined;
    if (text) this.#pump?.fire("UI_ERROR_MESSAGE", text);
    this.#fire("SOCKET_INFO_UPDATE");
  }

  /**
   * Per rendered frame: nothing without an open stock session, and a re-read at most every
   * RECHECK_INTERVAL_S with one — the item moved or went (the session ends), its enchantment fields
   * changed (a result the packet order put first), a split landed, a staged gem left the bags.
   */
  tick(): void {
    const session = this.#session;
    if (!session || !this.#owned) return;
    const now = this.#host.now();
    if (now - this.#checkedAt < RECHECK_INTERVAL_S) return;
    this.#checkedAt = now;
    const item = this.#host.item(session.target);
    if (!item || item.guid !== session.guid) {
      this.close();
      return;
    }
    let changed = false;
    let locks = false;
    for (let slot = 0; slot < session.seen.length; slot += 1) {
      const value = item.enchantments[slot] ?? 0;
      if (session.seen[slot] !== value) {
        session.seen[slot] = value;
        changed = true;
      }
    }
    const split = session.split;
    if (split) {
      const landed = this.#host.carriedAt(split.bag, split.slot);
      if (landed && landed.guid !== split.sourceGuid && landed.entry === split.entry && landed.count === 1) {
        session.split = undefined;
        session.staged[split.socket] = landed.guid;
        changed = true;
        locks = true;
      } else if (this.#host.now() - split.at > SPLIT_TIMEOUT_S) {
        session.split = undefined;
        changed = true;
      }
    }
    if (!session.pending) {
      for (let socket = 0; socket < 3; socket += 1) {
        const guid = session.staged[socket]!;
        if (guid !== 0n && !this.#host.carried(guid)) {
          session.staged[socket] = 0n;
          changed = true;
          locks = true;
        }
      }
    }
    if (locks) this.#host.locksChanged?.();
    if (changed) this.#fire("SOCKET_INFO_UPDATE");
  }

  // ---- internals ---------------------------------------------------------------------------

  /** End the session without an event; gems it had staged are unlocked. */
  #drop(): void {
    const staged = this.#session?.staged;
    this.#session = undefined;
    if (staged && (staged[0] !== 0n || staged[1] !== 0n || staged[2] !== 0n)) this.#host.locksChanged?.();
  }

  #item(): FrameXmlSocketItem | undefined {
    const session = this.#session;
    if (!session) return undefined;
    const item = this.#host.item(session.target);
    return item?.guid === session.guid ? item : undefined;
  }

  #colors(item: FrameXmlSocketItem): readonly number[] | undefined {
    const sockets = item.sockets;
    if (!sockets) return undefined;
    const colors = [sockets[0] ?? 0, sockets[1] ?? 0, sockets[2] ?? 0];
    // A buckle's prismatic socket takes the first free position (TrinityCore's `firstPrismatic`).
    const free = colors.indexOf(0);
    if ((item.enchantments[6] ?? 0) > 0 && free >= 0) colors[free] = FRAMEXML_SOCKET_PRISMATIC;
    return colors;
  }

  #socketColor(index: number): number | undefined {
    if (!Number.isInteger(index) || index < 1 || index > 3) return undefined;
    const item = this.#item();
    const color = item ? this.#colors(item)?.[index - 1] : undefined;
    return color ? color : undefined;
  }

  #existingGem(index: number): number | undefined {
    if (this.#socketColor(index) === undefined) return undefined;
    const enchantmentId = this.#item()?.enchantments[SOCKET_ENCHANTMENT_SLOT + index - 1] ?? 0;
    return enchantmentId > 0 ? this.#host.enchantmentGem(enchantmentId) : undefined;
  }

  #stagedGem(index: number): FrameXmlSocketCarried | undefined {
    const session = this.#session;
    if (!session || this.#socketColor(index) === undefined) return undefined;
    const guid = session.staged[index - 1]!;
    return guid === 0n ? undefined : this.#host.carried(guid);
  }

  #prefetch(item: FrameXmlSocketItem): void {
    const entries = [item.entry];
    for (let socket = 0; socket < 3; socket += 1) {
      const enchantmentId = item.enchantments[SOCKET_ENCHANTMENT_SLOT + socket] ?? 0;
      const gem = enchantmentId > 0 ? this.#host.enchantmentGem(enchantmentId) : undefined;
      if (gem) entries.push(gem);
    }
    this.#host.prefetch?.(entries, () => this.#repaint());
  }

  #repaint(): void {
    if (this.#session) this.#fire("SOCKET_INFO_UPDATE");
  }

  #error(name: string, fallback: string): void {
    this.#pump?.fire("UI_ERROR_MESSAGE", this.globalString?.(name) ?? fallback);
  }

  #fire(event: string): void {
    // Whatever raised an event changed the session: the next tick re-reads it without waiting.
    this.#checkedAt = Number.NEGATIVE_INFINITY;
    if (this.#owned) this.#pump?.fire(event);
  }
}
