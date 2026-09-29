/**
 * The offline charter windows: a guild master who designs tabards and sells the guild charter, an
 * arena organizer with the three arena charters, and a guild charter to sign — scripted worlds that
 * record every command, for `CannedWorldSeam` and its tests.
 *
 * The lists have SendPetitionShowList's shape (PetitionsHandler.cpp:759-809): one guild row with no
 * team size, or three arena rows whose fifth word is the team size; the entries are the core's
 * charter items (5863, 23560-23562) and the prices its default `Guild`/`ArenaTeam` charter costs (World.cpp:839-842).
 * The wording (item and player names) is illustrative, not copied from a database row.
 */
import type { PetitionInfo, PetitionSignatures, PetitionVendor } from "../../world/PetitionProtocol.js";
import { guildEmblemErrorText } from "../../world/GuildBankProtocol.js";
import { FrameXmlTabardModel, type FrameXmlTabardGuild, type FrameXmlTabardWorld } from "./FrameXmlTabard.js";
import {
  FrameXmlRegistrarModel, type FrameXmlRegistrarItem, type FrameXmlRegistrarWorld,
} from "./FrameXmlRegistrar.js";
import { FrameXmlPetitionModel, type FrameXmlPetitionWorld } from "./FrameXmlPetition.js";

/** The canned guild master (tabard designer and guild registrar) and arena organizer. */
export const FRAMEXML_CANNED_GUILD_MASTER_GUID = 0xF130000134000301n;
export const FRAMEXML_CANNED_ARENA_ORGANIZER_GUID = 0xF13000013A000302n;

/** The canned player, and the charter's owner and first signer. */
export const FRAMEXML_CANNED_CHARTER_SELF = 0x0000000000000011n;
export const FRAMEXML_CANNED_CHARTER_OWNER = 0x0000000000000021n;
export const FRAMEXML_CANNED_CHARTER_SIGNER = 0x0000000000000022n;
export const FRAMEXML_CANNED_CHARTER_GUID = 0x4000000000000501n;

/** `GUILD_CHARTER`, `ARENA_TEAM_CHARTER_2v2/3v3/5v5` and `CHARTER_DISPLAY_ID` (PetitionsHandler.cpp:38-47). */
const GUILD_CHARTER = 5863;
const ARENA_CHARTERS = [23560, 23561, 23562] as const;
const CHARTER_DISPLAY_ID = 16161;

export const FRAMEXML_CANNED_GUILD_LIST: PetitionVendor = Object.freeze({
  vendorGuid: FRAMEXML_CANNED_GUILD_MASTER_GUID,
  offers: [{ index: 1, itemId: GUILD_CHARTER, displayId: CHARTER_DISPLAY_ID, cost: 1000, teamSize: 0, requiredSignatures: 9 }],
});

export const FRAMEXML_CANNED_ARENA_LIST: PetitionVendor = Object.freeze({
  vendorGuid: FRAMEXML_CANNED_ARENA_ORGANIZER_GUID,
  offers: [
    { index: 1, itemId: ARENA_CHARTERS[0], displayId: CHARTER_DISPLAY_ID, cost: 800000, teamSize: 2, requiredSignatures: 2 },
    { index: 2, itemId: ARENA_CHARTERS[1], displayId: CHARTER_DISPLAY_ID, cost: 1200000, teamSize: 3, requiredSignatures: 3 },
    { index: 3, itemId: ARENA_CHARTERS[2], displayId: CHARTER_DISPLAY_ID, cost: 2000000, teamSize: 5, requiredSignatures: 5 },
  ],
});

const ITEM_NAMES = new Map<number, string>([
  [GUILD_CHARTER, "Хартия гильдии"],
  [ARENA_CHARTERS[0], "Хартия команды арены 2 на 2"],
  [ARENA_CHARTERS[1], "Хартия команды арены 3 на 3"],
  [ARENA_CHARTERS[2], "Хартия команды арены 5 на 5"],
]);

/** A guild charter someone else owns: the default `MinPetitionSigns` (9, World.cpp:1011) needed, one signed. */
export const FRAMEXML_CANNED_CHARTER_INFO: PetitionInfo = Object.freeze({
  petitionId: 0x501, ownerGuid: FRAMEXML_CANNED_CHARTER_OWNER, name: "Стражи Златоземья",
  minSignatures: 9, maxSignatures: 9, index: 0, arena: false,
});

export const FRAMEXML_CANNED_CHARTER_SIGNATURES: PetitionSignatures = Object.freeze({
  petitionGuid: FRAMEXML_CANNED_CHARTER_GUID, ownerGuid: FRAMEXML_CANNED_CHARTER_OWNER, petitionId: 0x501,
  signers: [FRAMEXML_CANNED_CHARTER_SIGNER],
});

type Listener = (payload: never) => void;

/** `WorldClient.events`, reduced to what the three models subscribe to. */
class CannedEvents {
  readonly #listeners = new Map<string, Set<Listener>>();
  on(event: string, listener: Listener): () => void {
    let set = this.#listeners.get(event);
    if (!set) this.#listeners.set(event, set = new Set());
    set.add(listener);
    return () => { set?.delete(listener); };
  }
  emit(event: string, payload: unknown): void {
    for (const listener of [...this.#listeners.get(event) ?? []]) (listener as (value: unknown) => void)(payload);
  }
}

export type FrameXmlCannedCharterCall =
  | { readonly kind: "saveEmblem"; readonly emblem: readonly number[] }
  | { readonly kind: "buy"; readonly vendorGuid: bigint; readonly name: string; readonly index: number }
  | { readonly kind: "turnIn"; readonly petitionGuid: bigint; readonly emblem: object | undefined }
  | { readonly kind: "request" | "query" | "sign"; readonly petitionGuid: bigint }
  | { readonly kind: "rename"; readonly petitionGuid: bigint; readonly name: string }
  | { readonly kind: "offer"; readonly petitionGuid: bigint; readonly playerGuid: bigint };

/**
 * `WorldClient`'s tabard, charter-vendor and charter fields and commands. Commands only record;
 * `openTabard`, `openList`, `showCharter`, `answer*` play the server's side.
 */
export class FrameXmlCannedCharterWorld implements FrameXmlTabardWorld, FrameXmlRegistrarWorld, FrameXmlPetitionWorld {
  readonly events = new CannedEvents();
  readonly calls: FrameXmlCannedCharterCall[] = [];
  readonly state: { selfGuid: bigint; objects: Map<bigint, { typeId: number }> } = {
    selfGuid: FRAMEXML_CANNED_CHARTER_SELF, objects: new Map(),
  };
  readonly selfName = "Тестер";
  readonly names = new Map<bigint, string>([
    [FRAMEXML_CANNED_CHARTER_OWNER, "Альдерик"], [FRAMEXML_CANNED_CHARTER_SIGNER, "Бруна"],
  ]);
  tabardVendorGuid = 0n;
  tabardMessage: { text: string; error: boolean } | undefined;
  guildQuery: FrameXmlTabardGuild | undefined = {
    emblemStyle: 12, emblemColor: 3, borderStyle: 1, borderColor: 5, backgroundColor: 20,
  };
  petitionVendor: PetitionVendor | undefined;
  petition: PetitionInfo | undefined;
  petitionSignatures: PetitionSignatures | undefined;
  petitionMessage: { text: string; error: boolean } | undefined;
  targetGuid: bigint | undefined;
  /** The bags' items (guid, entry): what a turn-in looks for. */
  carried: FrameXmlRegistrarItem[] = [];
  /** Entries whose template is not cached yet (itemTemplate answers nothing for them). */
  readonly uncached = new Set<number>();

  // ---- the tabard designer -------------------------------------------------------------------

  openTabard(guid: bigint = FRAMEXML_CANNED_GUILD_MASTER_GUID): void {
    this.tabardVendorGuid = guid;
    this.tabardMessage = undefined;
    this.events.emit("TABARD_VENDOR_CHANGED", { guid });
  }

  saveGuildEmblem(style: number, color: number, borderStyle: number, borderColor: number, background: number): void {
    this.calls.push({ kind: "saveEmblem", emblem: [style, color, borderStyle, borderColor, background] });
  }

  /** `MSG_SAVE_GUILD_EMBLEM`'s answer (`GuildEmblemError`); success also re-queries the guild. */
  answerEmblem(code: number, emblem?: FrameXmlTabardGuild): void {
    this.tabardMessage = { text: guildEmblemErrorText(code), error: code !== 0 };
    if (code === 0 && emblem) this.guildQuery = emblem;
    this.events.emit("TABARD_VENDOR_CHANGED", { guid: this.tabardVendorGuid });
  }

  // ---- the charter vendors -------------------------------------------------------------------

  openList(list: PetitionVendor): void {
    this.petitionVendor = list;
    this.events.emit("PETITION_CHANGED", {});
  }

  itemTemplate(entry: number): { readonly name: string } | undefined {
    if (this.uncached.has(entry)) return undefined;
    const name = ITEM_NAMES.get(entry);
    return name === undefined ? undefined : { name };
  }

  /** An item template lands (`QUERY_CACHE_CHANGED`). */
  cacheItem(entry: number): void {
    this.uncached.delete(entry);
    this.events.emit("QUERY_CACHE_CHANGED", { kind: "item", id: entry });
  }

  buyPetition(vendorGuid: bigint, name: string, index: number): void {
    this.calls.push({ kind: "buy", vendorGuid, name, index });
  }

  turnInPetition(petitionGuid: bigint, emblem?: object): void {
    this.calls.push({ kind: "turnIn", petitionGuid, emblem });
  }

  // ---- the charter ---------------------------------------------------------------------------

  /** `SMSG_PETITION_SHOW_SIGNATURES`, the query already cached unless `queryPending`. */
  showCharter(signatures: PetitionSignatures = FRAMEXML_CANNED_CHARTER_SIGNATURES, queryPending = false): void {
    if (!queryPending) this.petition = FRAMEXML_CANNED_CHARTER_INFO;
    this.petitionSignatures = signatures;
    this.events.emit("PETITION_CHANGED", {});
  }

  /** `SMSG_PETITION_QUERY_RESPONSE`. */
  answerQuery(info: PetitionInfo = FRAMEXML_CANNED_CHARTER_INFO): void {
    this.petition = info;
    this.events.emit("PETITION_CHANGED", {});
  }

  /** Any sign/turn-in/decline/rename answer. */
  answerMessage(text: string, error = false): void {
    this.petitionMessage = { text, error };
    this.events.emit("PETITION_CHANGED", {});
  }

  requestPetition(petitionGuid: bigint): void { this.calls.push({ kind: "request", petitionGuid }); }
  queryPetition(petitionGuid: bigint): void { this.calls.push({ kind: "query", petitionGuid }); }
  signPetition(petitionGuid: bigint): void { this.calls.push({ kind: "sign", petitionGuid }); }
  renamePetition(petitionGuid: bigint, name: string): void { this.calls.push({ kind: "rename", petitionGuid, name }); }
  offerPetition(petitionGuid: bigint, playerGuid: bigint): void { this.calls.push({ kind: "offer", petitionGuid, playerGuid }); }
}

/** The three canned models over one scripted world. */
export function createCannedFrameXmlCharters(): {
  readonly world: FrameXmlCannedCharterWorld;
  readonly tabard: FrameXmlTabardModel;
  readonly registrar: FrameXmlRegistrarModel;
  readonly petition: FrameXmlPetitionModel;
} {
  const world = new FrameXmlCannedCharterWorld();
  return {
    world,
    tabard: new FrameXmlTabardModel({ world: () => world }),
    registrar: new FrameXmlRegistrarModel({ world: () => world, carriedItems: () => world.carried }),
    petition: new FrameXmlPetitionModel({ world: () => world }),
  };
}
