/**
 * The stock charter vendors' C API: GuildRegistrarFrame (GuildRegistrarFrame.lua/.xml, buy and
 * register a guild charter) and ArenaRegistrarFrame with its PVPBannerFrame
 * (ArenaRegistrarFrame.lua/.xml, buy an arena charter, design the banner and register the team),
 * over `SMSG_PETITION_SHOWLIST`, `CMSG_PETITION_BUY` and `CMSG_TURN_IN_PETITION`.
 *
 * Which of the two frames a list opens is on the wire: SendPetitionShowList
 * (PetitionsHandler.cpp:759-809) writes one guild-charter row for a creature that is also a tabard
 * designer — its fifth word zero — and three arena rows otherwise, whose fifth word is the team size
 * (2, 3, 5). A lone row with no team size is GUILD_REGISTRAR_SHOW; anything else is
 * PETITION_VENDOR_SHOW, followed by PETITION_VENDOR_UPDATE, which is what shows the turn-in rows
 * (ArenaRegistrarFrame.lua:23-39).
 *
 * Settled against the selected TrinityCore:
 *
 * * `BuyGuildCharter(name)` and `BuyPetition(id, name)` both send the row's own index, 1 for the
 *   guild charter and 1..3 for 2v2/3v3/5v5 (:77, :117-137); `ArenaRegistrarPurchaseFrame.id` is the
 *   button id, which is that index (ArenaRegistrarFrame.xml:169-194).
 * * A turn-in names the charter item, found in the bags by the row's item entry. The arena turn-in
 *   carries the banner after the guid, read after the item is already destroyed (:709-711), so it is
 *   always written: background colour, emblem, emblem colour, border, border colour.
 * * The banner's colours are ARGB words. PVPBannerFrame_SaveBanner hands `TurnInArenaPetition`
 *   0..1 floats (ArenaRegistrarFrame.lua:190-213); each channel is written as its byte with the alpha
 *   byte opaque, the layout the inspect reader decodes (FrameXmlInspect `rgb`: red in bits 16-23).
 * * There is no close opcode: `CloseGuildRegistrar`/`ClosePetitionVendor` forget the list locally.
 */
import type { PetitionInfo, PetitionOffer, PetitionSignatures, PetitionVendor } from "../../world/PetitionProtocol.js";

export type FrameXmlRegistrarKind = "guild" | "arena";

/** GUILD_REGISTRAR_SHOW for the tabard designer's lone guild row, PETITION_VENDOR_SHOW otherwise. */
export function frameXmlRegistrarKind(vendor: Pick<PetitionVendor, "offers">): FrameXmlRegistrarKind {
  return vendor.offers.length === 1 && vendor.offers[0]?.teamSize === 0 ? "guild" : "arena";
}

/** One 0..1 channel as its byte. */
function channel(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? Math.round(Math.min(1, Math.max(0, number)) * 255) : 0;
}

/** Three 0..1 floats as the banner's ARGB word (opaque alpha, red in bits 16-23). */
export function frameXmlArenaBannerColor(red: unknown, green: unknown, blue: unknown): number {
  return (0xff000000 | (channel(red) << 16) | (channel(green) << 8) | channel(blue)) >>> 0;
}

interface FrameXmlRegistrarEvents {
  on(event: "PETITION_CHANGED", listener: (payload: Record<string, never>) => void): () => void;
  on(event: "QUERY_CACHE_CHANGED", listener: (payload: { kind: string }) => void): () => void;
}

/** The world facts and commands the model reads; `WorldClient` satisfies it structurally. */
export interface FrameXmlRegistrarWorld {
  /** The list the vendor showed; the model forgets it when the vendor frame closes. */
  petitionVendor: PetitionVendor | undefined;
  readonly petition?: PetitionInfo | undefined;
  readonly petitionSignatures?: PetitionSignatures | undefined;
  readonly events?: FrameXmlRegistrarEvents | undefined;
  /** An item's cached template, asking for it when it is not cached (`QUERY_CACHE_CHANGED` answers). */
  itemTemplate(entry: number): { readonly name: string } | undefined;
  buyPetition(vendorGuid: bigint, name: string, clientIndex: number): void;
  turnInPetition(petitionGuid: bigint, emblem?: {
    background: number; icon: number; iconColor: number; border: number; borderColor: number;
  }): void;
}

/** A carried item: its guid and entry. */
export interface FrameXmlRegistrarItem {
  readonly guid: bigint;
  readonly entry: number;
}

export interface FrameXmlRegistrarContext {
  world(): FrameXmlRegistrarWorld | undefined;
  /** The backpack and the four bags, where a charter bought here is stored. */
  carriedItems(): readonly FrameXmlRegistrarItem[];
  /** An item's icon path, when the host resolves one. */
  itemTexture?(entry: number): string | undefined;
}

interface FrameXmlRegistrarPump {
  fire(event: string, ...args: readonly unknown[]): number;
}

/** What the owner's gates show: a list, item names and the carried items. Never sent anywhere. */
export interface FrameXmlRegistrarProbe {
  readonly vendor: PetitionVendor;
  readonly itemNames: ReadonlyMap<number, string>;
  readonly carried: readonly FrameXmlRegistrarItem[];
}

const SHOW: Readonly<Record<FrameXmlRegistrarKind, string>> = { guild: "GUILD_REGISTRAR_SHOW", arena: "PETITION_VENDOR_SHOW" };
const CLOSED: Readonly<Record<FrameXmlRegistrarKind, string>> = { guild: "GUILD_REGISTRAR_CLOSED", arena: "PETITION_VENDOR_CLOSED" };

/** One owner of both charter vendors' C API and of their SHOW/CLOSED/UPDATE events. */
export class FrameXmlRegistrarModel {
  readonly #context: FrameXmlRegistrarContext;
  #pump: FrameXmlRegistrarPump | undefined;
  #unsubscribe: (() => void)[] = [];
  #owned = false;
  #muted = false;
  #probe: FrameXmlRegistrarProbe | undefined;
  /** The list a SHOW was raised for, and which frame it opened. */
  #shown: PetitionVendor | undefined;
  #kind: FrameXmlRegistrarKind | undefined;
  /** What the last PETITION_VENDOR_UPDATE told: a filled charter carried, the rows' names known. */
  #updated: string | undefined;

  constructor(context: FrameXmlRegistrarContext) {
    this.#context = context;
  }

  attach(pump: FrameXmlRegistrarPump): void {
    this.detach();
    this.#pump = pump;
    const world = this.#context.world();
    if (world?.events && typeof world.events.on === "function") {
      this.#unsubscribe.push(world.events.on("PETITION_CHANGED", () => this.sync()));
      // GetPetitionItemInfo answers once the charter's item template is cached; stock waits for UPDATE.
      this.#unsubscribe.push(world.events.on("QUERY_CACHE_CHANGED", ({ kind }) => { if (kind === "item") this.sync(); }));
    }
  }

  detach(): void {
    for (const unsubscribe of this.#unsubscribe.splice(0)) unsubscribe();
    this.#pump = undefined;
    this.#owned = false;
    this.#forget();
  }

  #forget(): void {
    this.#shown = undefined;
    this.#kind = undefined;
    this.#updated = undefined;
  }

  /** Whether the stock vendor frames own charter lists; taking ownership replays an open list. */
  get owned(): boolean { return this.#owned; }
  set owned(owned: boolean) {
    if (owned === this.#owned) return;
    this.#owned = owned;
    this.#forget();
    if (owned) this.sync();
  }

  muted<T>(operation: () => T): T {
    const previous = this.#muted;
    this.#muted = true;
    try { return operation(); } finally { this.#muted = previous; }
  }

  probe<T>(probe: FrameXmlRegistrarProbe, operation: () => T): T {
    const previous = this.#probe;
    this.#probe = probe;
    try { return this.muted(operation); } finally { this.#probe = previous; }
  }

  /**
   * Raise the edge the world's list moved to: the kind's SHOW for a new list (the arena one with its
   * first UPDATE), the kind's CLOSED once it is gone, and UPDATE again while an arena list is open and
   * what it reports changed.
   */
  sync(): void {
    const pump = this.#pump;
    if (!pump || !this.#owned || this.#probe) return;
    const vendor = this.#context.world()?.petitionVendor;
    if (vendor !== this.#shown) {
      const closing = this.#kind;
      this.#forget();
      if (closing) pump.fire(CLOSED[closing]);
      if (!vendor) return;
      const kind = frameXmlRegistrarKind(vendor);
      this.#shown = vendor;
      this.#kind = kind;
      pump.fire(SHOW[kind]);
      if (kind === "arena" && this.#shown === vendor) {
        this.#updated = this.#updateKey();
        pump.fire("PETITION_VENDOR_UPDATE");
      }
      return;
    }
    if (vendor && this.#kind === "arena") {
      const key = this.#updateKey();
      if (key === this.#updated) return;
      this.#updated = key;
      pump.fire("PETITION_VENDOR_UPDATE");
    }
  }

  #updateKey(): string {
    const names = (this.#vendor()?.offers ?? []).map((offer) => this.#itemName(offer.itemId) === undefined ? 0 : 1);
    return `${this.hasFilledPetition() ? 1 : 0}:${names.join("")}`;
  }

  /** Which vendor frame stock was shown for (tests, the owners). */
  get showing(): FrameXmlRegistrarKind | undefined { return this.#kind; }

  // ---- reads ---------------------------------------------------------------------------------

  #vendor(): PetitionVendor | undefined {
    return this.#probe?.vendor ?? this.#shown;
  }

  #offer(index: number): PetitionOffer | undefined {
    return Number.isInteger(index) ? this.#vendor()?.offers.find((offer) => offer.index === index) : undefined;
  }

  #itemName(entry: number): string | undefined {
    const probe = this.#probe;
    if (probe) return probe.itemNames.get(entry);
    return this.#context.world()?.itemTemplate(entry)?.name || undefined;
  }

  #carried(): readonly FrameXmlRegistrarItem[] {
    return this.#probe?.carried ?? this.#context.carriedItems();
  }

  /** `GetGuildCharterCost()`: the guild row's price (copper); nil without a guild list. */
  guildCharterCost(): number | undefined {
    const vendor = this.#vendor();
    return vendor && frameXmlRegistrarKind(vendor) === "guild" ? vendor.offers[0]?.cost : undefined;
  }

  /**
   * `GetPetitionItemInfo(id)`: `name, texture, price` of the row. Nil until the charter item's name
   * is cached — ArenaRegistrar_ShowPurchaseFrame then waits for PETITION_VENDOR_UPDATE (:58-63).
   */
  petitionItemInfo(id: number): readonly unknown[] {
    const offer = this.#offer(id);
    const name = offer ? this.#itemName(offer.itemId) : undefined;
    if (!offer || name === undefined) return [];
    return [name, this.#probe ? undefined : this.#context.itemTexture?.(offer.itemId), offer.cost];
  }

  /** The carried charter a row sells (the entry the list names). */
  #charterFor(offer: PetitionOffer | undefined): FrameXmlRegistrarItem | undefined {
    return offer ? this.#carried().find((item) => item.entry === offer.itemId) : undefined;
  }

  /**
   * `HasFilledPetition()`: an arena charter from this list is carried and is not known to be short of
   * signatures. Its count is only known once its query and signatures were seen; the server refuses a
   * short charter before it destroys it (PetitionsHandler.cpp:662-674).
   */
  hasFilledPetition(): boolean {
    const vendor = this.#vendor();
    if (!vendor || frameXmlRegistrarKind(vendor) !== "arena") return false;
    const world = this.#probe ? undefined : this.#context.world();
    return vendor.offers.some((offer) => {
      const charter = this.#charterFor(offer);
      if (!charter) return false;
      const signatures = world?.petitionSignatures;
      const info = world?.petition;
      if (!signatures || signatures.petitionGuid !== charter.guid || !info || info.petitionId !== signatures.petitionId) return true;
      return signatures.signers.length >= info.minSignatures;
    });
  }

  // ---- commands ------------------------------------------------------------------------------

  /** The list on screen of `kind`, only while it is still the world's. */
  #live(kind: FrameXmlRegistrarKind): { world: FrameXmlRegistrarWorld; vendor: PetitionVendor } | undefined {
    if (this.#muted || this.#probe || this.#kind !== kind) return undefined;
    const world = this.#context.world();
    const vendor = this.#shown;
    return world && vendor && world.petitionVendor === vendor ? { world, vendor } : undefined;
  }

  /** `BuyGuildCharter(name)` — `CMSG_PETITION_BUY` with the guild row's index. */
  buyGuildCharter(name: unknown): void {
    const live = this.#live("guild");
    const offer = live?.vendor.offers[0];
    const text = typeof name === "string" ? name.trim() : "";
    if (live && offer && text) live.world.buyPetition(live.vendor.vendorGuid, text, offer.index);
  }

  /** `BuyPetition(id, name)` — `CMSG_PETITION_BUY` with the arena row's index. */
  buyPetition(id: number, name: unknown): void {
    const live = this.#live("arena");
    const offer = live ? this.#offer(id) : undefined;
    const text = typeof name === "string" ? name.trim() : "";
    if (live && offer && text) live.world.buyPetition(live.vendor.vendorGuid, text, offer.index);
  }

  /** `TurnInGuildCharter()` — `CMSG_TURN_IN_PETITION` for the carried guild charter. */
  turnInGuildCharter(): void {
    const live = this.#live("guild");
    const charter = live ? this.#charterFor(live.vendor.offers[0]) : undefined;
    if (live && charter) live.world.turnInPetition(charter.guid);
  }

  /**
   * `TurnInArenaPetition(teamSize, bgR, bgG, bgB, emblem, emblemR, emblemG, emblemB, border,
   * borderR, borderG, borderB)` (ArenaRegistrarFrame.lua:211) — `CMSG_TURN_IN_PETITION` for the
   * carried charter of that size, with the banner.
   */
  turnInArenaPetition(args: readonly unknown[]): void {
    const live = this.#live("arena");
    const size = Number(args[0]);
    const offer = live?.vendor.offers.find((row) => row.teamSize === size);
    const charter = this.#charterFor(offer);
    const icon = Number(args[4]);
    const border = Number(args[8]);
    if (!live || !charter || !Number.isInteger(icon) || !Number.isInteger(border)) return;
    live.world.turnInPetition(charter.guid, {
      background: frameXmlArenaBannerColor(args[1], args[2], args[3]),
      icon,
      iconColor: frameXmlArenaBannerColor(args[5], args[6], args[7]),
      border,
      borderColor: frameXmlArenaBannerColor(args[9], args[10], args[11]),
    });
  }

  /**
   * `CloseGuildRegistrar()`/`ClosePetitionVendor()` — the frames' OnHide. The world forgets the list
   * stock was shown, and the kind's CLOSED follows through `sync`.
   */
  close(kind: FrameXmlRegistrarKind): void {
    if (this.#muted || this.#probe || this.#kind !== kind) return;
    const world = this.#context.world();
    if (world && this.#shown && world.petitionVendor === this.#shown) world.petitionVendor = undefined;
    this.sync();
  }

  /** The vendor of the open list (`UnitName("npc")`); undefined when none is open. */
  get vendorGuid(): bigint | undefined {
    const guid = this.#shown?.vendorGuid;
    return guid === undefined || guid === 0n ? undefined : guid;
  }
}

/** The part of the world seam the bindings read. */
export interface FrameXmlRegistrarHost {
  readonly registrar?: FrameXmlRegistrarModel | undefined;
}

export type FrameXmlRegistrarBinding = (host: FrameXmlRegistrarHost, args: readonly unknown[]) => readonly unknown[];

const NOTHING: readonly [] = Object.freeze([]);

function integerArg(value: unknown): number {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(number) ? number : 0;
}

const withRegistrar = (answer: (registrar: FrameXmlRegistrarModel, args: readonly unknown[]) => readonly unknown[]): FrameXmlRegistrarBinding =>
  (host, args) => host.registrar ? answer(host.registrar, args) : NOTHING;

const command = (run: (registrar: FrameXmlRegistrarModel, args: readonly unknown[]) => void): FrameXmlRegistrarBinding =>
  withRegistrar((registrar, args) => { run(registrar, args); return NOTHING; });

/** The flat C API GuildRegistrarFrame and ArenaRegistrarFrame/PVPBannerFrame call. */
export const FRAMEXML_REGISTRAR_BINDINGS: Readonly<Record<string, FrameXmlRegistrarBinding>> = Object.freeze({
  GetGuildCharterCost: withRegistrar((registrar) => {
    const cost = registrar.guildCharterCost();
    return cost === undefined ? NOTHING : [cost];
  }),
  BuyGuildCharter: command((registrar, args) => registrar.buyGuildCharter(args[0])),
  TurnInGuildCharter: command((registrar) => registrar.turnInGuildCharter()),
  CloseGuildRegistrar: command((registrar) => registrar.close("guild")),
  GetPetitionItemInfo: withRegistrar((registrar, args) => registrar.petitionItemInfo(integerArg(args[0]))),
  HasFilledPetition: withRegistrar((registrar) => [registrar.hasFilledPetition()]),
  BuyPetition: command((registrar, args) => registrar.buyPetition(integerArg(args[0]), args[1])),
  TurnInArenaPetition: command((registrar, args) => registrar.turnInArenaPetition(args)),
  ClosePetitionVendor: command((registrar) => registrar.close("arena")),
});
