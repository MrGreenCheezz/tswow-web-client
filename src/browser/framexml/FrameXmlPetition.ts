/**
 * The stock PetitionFrame's C API (PetitionFrame.lua, PetitionFrame.xml and StaticPopup.lua's
 * RENAME_GUILD/RENAME_ARENA_TEAM) over this client's charter packets.
 *
 * A charter reaches the client two ways, both as `SMSG_PETITION_SHOW_SIGNATURES`: the owner uses the
 * charter item (the client asks `CMSG_PETITION_SHOW_SIGNATURES`), or another player offers theirs
 * (`CMSG_OFFER_PETITION`, which the server answers to the target with the same packet,
 * PetitionsHandler.cpp:587). Either is PETITION_SHOW. The signatures packet carries no name or type;
 * those are the petition query's (`SMSG_PETITION_QUERY_RESPONSE`, :275-321), asked once when the
 * shown charter is not in the query cache, and PETITION_SHOW waits for it.
 *
 * Settled against the selected TrinityCore (PetitionsHandler.cpp):
 *
 * * `GetPetitionInfo`'s `minSignatures`/`maxSignatures` are the query's two counters — equal in both
 *   branches: the `MinPetitionSigns` setting for a guild, `type - 1` for an arena team (:290-303).
 *   PetitionFrame_Update then titles an arena charter with `minSignatures + 1` players (:38).
 * * The body text is the query's second string, written empty by the core (:288).
 * * Signing answers `SMSG_PETITION_SIGN_RESULTS` to the signer — «close at signer side» (:464-487) —
 *   so the frame closes on the answer to its own SignPetition.
 * * The owner cannot sign (:405-406); the charter is renamed through `MSG_PETITION_RENAME`, whose
 *   answer re-titles it (:378-381, WorldClient updates the query cache's name).
 *
 * The client closes PetitionFrame locally (`ClosePetition`); there is no opcode for it.
 */
import type { PetitionInfo, PetitionSignatures } from "../../world/PetitionProtocol.js";

/** `ITEM_FLAG_PETITION` (ItemTemplate.h): «Item is guild or arena charter». */
export const FRAMEXML_ITEM_FLAG_PETITION = 0x00002000;

/** `TYPEID_PLAYER` (ObjectGuid.h): only a player can be offered a charter (FindConnectedPlayer). */
const TYPEID_PLAYER = 4;

interface FrameXmlPetitionEvents {
  on(event: "PETITION_CHANGED", listener: (payload: Record<string, never>) => void): () => void;
}

/** The world facts and commands the model reads; `WorldClient` satisfies it structurally. */
export interface FrameXmlPetitionWorld {
  readonly state: {
    readonly selfGuid?: bigint | undefined;
    readonly objects?: { get(guid: bigint): { readonly typeId?: number | undefined } | undefined } | undefined;
  };
  readonly selfName?: string | undefined;
  readonly names: { get(guid: bigint): string | undefined };
  /** The petition query cache (the newest answer). */
  readonly petition: PetitionInfo | undefined;
  /** The charter the server showed; the model forgets it when PetitionFrame closes. */
  petitionSignatures: PetitionSignatures | undefined;
  /** Replaced by every sign/turn-in/decline/rename answer. */
  readonly petitionMessage?: object | undefined;
  readonly targetGuid?: bigint | undefined;
  readonly events?: FrameXmlPetitionEvents | undefined;
  /** Query and signatures together: what using the charter item asks. */
  requestPetition(petitionGuid: bigint): void;
  /** The query alone, for a charter already shown. */
  queryPetition(petitionGuid: bigint): void;
  signPetition(petitionGuid: bigint): void;
  renamePetition(petitionGuid: bigint, name: string): void;
  offerPetition(petitionGuid: bigint, playerGuid: bigint): void;
}

export interface FrameXmlPetitionContext {
  world(): FrameXmlPetitionWorld | undefined;
}

interface FrameXmlPetitionPump {
  fire(event: string, ...args: readonly unknown[]): number;
}

/** What the owner's gate shows: a charter, its query and its signers' names. Never sent anywhere. */
export interface FrameXmlPetitionProbe {
  readonly info: PetitionInfo;
  readonly signatures: PetitionSignatures;
  readonly names: ReadonlyMap<bigint, string>;
  readonly self: bigint;
}

/** The query answer that belongs to a signatures packet (the core writes the guid's low half into both). */
export function frameXmlPetitionInfoFor(
  info: PetitionInfo | undefined,
  signatures: PetitionSignatures | undefined,
): PetitionInfo | undefined {
  return info && signatures && info.petitionId === signatures.petitionId ? info : undefined;
}

/** One owner of PetitionFrame's C API and of PETITION_SHOW/PETITION_CLOSED. */
export class FrameXmlPetitionModel {
  readonly #context: FrameXmlPetitionContext;
  #pump: FrameXmlPetitionPump | undefined;
  #unsubscribe: (() => void)[] = [];
  #owned = false;
  #muted = false;
  #probe: FrameXmlPetitionProbe | undefined;
  /** The charter PETITION_SHOW was raised for, and the name it was raised with. */
  #shown: PetitionSignatures | undefined;
  #shownName: string | undefined;
  /** The signatures packet a query was asked for (one query per charter shown). */
  #queried: PetitionSignatures | undefined;
  /** SignPetition went out while this answer was the newest; the next answer closes the frame. */
  #signing: { readonly for: PetitionSignatures; readonly message: object | undefined } | undefined;

  constructor(context: FrameXmlPetitionContext) {
    this.#context = context;
  }

  attach(pump: FrameXmlPetitionPump): void {
    this.detach();
    this.#pump = pump;
    const world = this.#context.world();
    if (world?.events && typeof world.events.on === "function") {
      this.#unsubscribe.push(world.events.on("PETITION_CHANGED", () => this.sync()));
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
    this.#shownName = undefined;
    this.#queried = undefined;
    this.#signing = undefined;
  }

  /** Whether stock PetitionFrame shows charters; taking ownership replays a charter already shown. */
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

  probe<T>(probe: FrameXmlPetitionProbe, operation: () => T): T {
    const previous = this.#probe;
    this.#probe = probe;
    try { return this.muted(operation); } finally { this.#probe = previous; }
  }

  /**
   * Raise the edge the world's charter moved to: PETITION_SHOW for a new signatures packet whose
   * query is known (or a rename of the shown one), PETITION_CLOSED once it is gone or signed.
   */
  sync(): void {
    const pump = this.#pump;
    if (!pump || !this.#owned || this.#probe) return;
    const world = this.#context.world();
    const signing = this.#signing;
    if (world && signing && world.petitionMessage !== signing.message) {
      this.#signing = undefined;
      if (world.petitionSignatures === signing.for) world.petitionSignatures = undefined;
    }
    const signatures = world?.petitionSignatures;
    if (!world || !signatures) {
      if (!this.#shown) return;
      this.#forget();
      pump.fire("PETITION_CLOSED");
      return;
    }
    const info = frameXmlPetitionInfoFor(world.petition, signatures);
    if (!info) {
      if (this.#queried !== signatures && !this.#muted) {
        this.#queried = signatures;
        world.queryPetition(signatures.petitionGuid);
      }
      return;
    }
    if (signatures === this.#shown && info.name === this.#shownName) return;
    this.#shown = signatures;
    this.#shownName = info.name;
    pump.fire("PETITION_SHOW");
  }

  /** Whether stock was shown a charter that is still the world's. */
  get showing(): boolean { return this.#shown !== undefined; }

  // ---- reads ---------------------------------------------------------------------------------

  #view(): { info: PetitionInfo; signatures: PetitionSignatures; self: bigint | undefined } | undefined {
    const probe = this.#probe;
    if (probe) return { info: probe.info, signatures: probe.signatures, self: probe.self };
    const world = this.#context.world();
    const signatures = this.#shown;
    const info = frameXmlPetitionInfoFor(world?.petition, signatures);
    return world && signatures && info ? { info, signatures, self: world.state.selfGuid } : undefined;
  }

  #name(guid: bigint): string | undefined {
    const probe = this.#probe;
    if (probe) return probe.names.get(guid);
    const world = this.#context.world();
    if (!world) return undefined;
    return world.names.get(guid) ?? (guid === world.state.selfGuid ? world.selfName || undefined : undefined);
  }

  /**
   * `GetPetitionInfo()`: `petitionType, title, bodyText, maxSignatures, originatorName, isOriginator,
   * minSignatures` (PetitionFrame.lua:8). An owner whose name is not cached yet answers nil.
   */
  info(): readonly unknown[] {
    const view = this.#view();
    if (!view) return [];
    const { info, signatures, self } = view;
    return [
      info.arena ? "arena" : "guild", info.name, "", info.maxSignatures,
      this.#name(signatures.ownerGuid), self !== undefined && signatures.ownerGuid === self, info.minSignatures,
    ];
  }

  numNames(): number { return this.#view()?.signatures.signers.length ?? 0; }

  /** `GetPetitionNameInfo(i)`: the i-th signer's name; nil until the name query answers. */
  nameInfo(index: number): string | undefined {
    const guid = Number.isInteger(index) && index >= 1 ? this.#view()?.signatures.signers[index - 1] : undefined;
    return guid === undefined ? undefined : this.#name(guid);
  }

  /** `CanSignPetition()`: not the owner's own charter, and not already signed by this character. */
  canSign(): boolean {
    const view = this.#view();
    if (!view || view.self === undefined) return false;
    return view.signatures.ownerGuid !== view.self && !view.signatures.signers.includes(view.self);
  }

  // ---- commands ------------------------------------------------------------------------------

  /** The charter on screen, only while it is still the one the world holds. */
  #live(): { world: FrameXmlPetitionWorld; signatures: PetitionSignatures } | undefined {
    if (this.#muted || this.#probe) return undefined;
    const world = this.#context.world();
    const signatures = this.#shown;
    return world && signatures && world.petitionSignatures === signatures ? { world, signatures } : undefined;
  }

  /** `SignPetition()` — `CMSG_PETITION_SIGN`; its answer closes the frame. */
  sign(): void {
    const live = this.#live();
    if (!live || !this.canSign()) return;
    this.#signing = { for: live.signatures, message: live.world.petitionMessage };
    live.world.signPetition(live.signatures.petitionGuid);
  }

  /**
   * `OfferPetition()` — the owner asks the current target to sign (`CMSG_OFFER_PETITION`). Only a
   * player can be offered; the server re-checks faction, level, guild and team (:537-585).
   */
  offer(): void {
    const live = this.#live();
    const self = live?.world.state.selfGuid;
    const target = live?.world.targetGuid;
    if (!live || target === undefined || target === 0n || target === self) return;
    if (live.signatures.ownerGuid !== self) return;
    const typeId = live.world.state.objects?.get(target)?.typeId;
    const player = typeId !== undefined ? typeId === TYPEID_PLAYER : (target >> 48n) === 0n;
    if (player) live.world.offerPetition(live.signatures.petitionGuid, target);
  }

  /** `RenamePetition(name)` — `MSG_PETITION_RENAME`, from StaticPopup's RENAME_GUILD/RENAME_ARENA_TEAM. */
  rename(name: unknown): void {
    const live = this.#live();
    const text = typeof name === "string" ? name.trim() : "";
    if (!live || !text || live.signatures.ownerGuid !== live.world.state.selfGuid) return;
    live.world.renamePetition(live.signatures.petitionGuid, text);
  }

  /** `ClosePetition()` — PetitionFrame's OnHide: the world forgets the charter, PETITION_CLOSED follows. */
  close(): void {
    if (this.#muted || this.#probe) return;
    const world = this.#context.world();
    if (world && this.#shown && world.petitionSignatures === this.#shown) world.petitionSignatures = undefined;
    this.#signing = undefined;
    this.sync();
  }

  /**
   * UseContainerItem on a charter (`ITEM_FLAG_PETITION`): the client asks for its query and
   * signatures, and PETITION_SHOW follows the answer. False: not a charter, or stock does not own it.
   */
  useItem(itemGuid: bigint, template: { readonly flags: number } | undefined): boolean {
    if (!this.#owned || !template || (template.flags & FRAMEXML_ITEM_FLAG_PETITION) === 0 || itemGuid === 0n) return false;
    if (!this.#muted) this.#context.world()?.requestPetition(itemGuid);
    return true;
  }
}

/** The part of the world seam the bindings read. */
export interface FrameXmlPetitionHost {
  readonly petition?: FrameXmlPetitionModel | undefined;
}

export type FrameXmlPetitionBinding = (host: FrameXmlPetitionHost, args: readonly unknown[]) => readonly unknown[];

const NOTHING: readonly [] = Object.freeze([]);

function integerArg(value: unknown): number {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(number) ? number : 0;
}

const withPetition = (answer: (petition: FrameXmlPetitionModel, args: readonly unknown[]) => readonly unknown[]): FrameXmlPetitionBinding =>
  (host, args) => host.petition ? answer(host.petition, args) : NOTHING;

const command = (run: (petition: FrameXmlPetitionModel, args: readonly unknown[]) => void): FrameXmlPetitionBinding =>
  withPetition((petition, args) => { run(petition, args); return NOTHING; });

/** The flat C API PetitionFrame.lua/.xml and StaticPopup.lua's two rename dialogs call. */
export const FRAMEXML_PETITION_BINDINGS: Readonly<Record<string, FrameXmlPetitionBinding>> = Object.freeze({
  GetPetitionInfo: withPetition((petition) => petition.info()),
  GetNumPetitionNames: withPetition((petition) => [petition.numNames()]),
  GetPetitionNameInfo: withPetition((petition, args) => {
    const name = petition.nameInfo(integerArg(args[0]));
    return name === undefined ? NOTHING : [name];
  }),
  CanSignPetition: withPetition((petition) => [petition.canSign()]),
  SignPetition: command((petition) => petition.sign()),
  OfferPetition: command((petition) => petition.offer()),
  RenamePetition: command((petition, args) => petition.rename(args[0])),
  ClosePetition: command((petition) => petition.close()),
});
