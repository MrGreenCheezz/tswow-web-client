/**
 * The small stock mechanics the boot census listed as called and unanswered, each answered from
 * the data this client already holds — and answered nil where it holds none.
 *
 * Measured call sites in the 3.3.5 corpus, and what each answer is made of:
 *
 * * `HasKey()` — MainMenuBar.lua:244, on BAG_UPDATE: shows the keyring button once a key is
 *   carried. Answered from the seam's own keyring container (bag -2), the one KeyRingFrame reads.
 * * `GetArenaTeam(index)` — PVPFrame.lua:115/128 (22 values), ChatFrame.lua:660, UIParent.lua:658
 *   at PLAYER_ENTERING_WORLD, which the client uses to *ask* for its teams. Index 1..3 is the
 *   player's 2v2/3v3/5v5 slot in `PLAYER_FIELD_ARENA_TEAM_INFO_1_1` (seven words a slot:
 *   ARENA_TEAM_ID, TYPE, MEMBER, GAMES_WEEK, GAMES_SEASON, WINS_SEASON, PERSONAL_RATING —
 *   Player.h's ArenaTeamInfoType). The team's name, tabard and record come from
 *   `SMSG_ARENA_TEAM_QUERY_RESPONSE`/`SMSG_ARENA_TEAM_STATS`, asked for once per team when a slot
 *   names a team the world has not heard of; until both arrive the slot answers nil, and the
 *   `ARENA_TEAM_UPDATE` edge (PVPFrame_OnEvent) repaints when they do.
 * * `IsPossessBarVisible()`/`GetPossessInfo(index)` — BonusActionBarFrame.lua:221/246: the two
 *   possess buttons. Visible while `SMSG_CLIENT_CONTROL_UPDATE` has handed the player a unit that is
 *   not their own character and whose `SMSG_PET_SPELLS` bar is not a vehicle's. Both buttons carry
 *   the possessing spell — the aura on the controlled unit that the player cast — so slot 2's
 *   `CancelUnitBuff("player", name)` names the player's matching buff where one exists.
 * * `GetBattlefieldWinner()` — WorldStateFrame.lua:313/348/515: `MSG_PVP_LOG_DATA`'s winner byte
 *   once its «ended» byte is set (0 Horde, 1 Alliance, as :556 compares), nil during the match.
 * * `RequestBattlefieldPositions()` — `MSG_BATTLEGROUND_PLAYER_POSITIONS`, the flag-carrier poll.
 * * `SendAddonMessage(prefix, message, type, target)` — the add-on channel: `LANG_ADDON` chat with
 *   the prefix and the body joined by a tab, on PARTY, RAID, GUILD, BATTLEGROUND or WHISPER, the
 *   five types ChatHandler.cpp accepts for it; the whisper needs its target, and a body over the
 *   server's 255-byte line is not sent, as the core would drop it.
 * * `GetQuestTimers()`/`GetQuestIndexForTimer(i)` — QuestTimerFrame.lua:42/48: the timed quests'
 *   remaining seconds, in log order, from the seam's `questLogTimeLeft` (the player's
 *   PLAYER_QUEST_LOG_x_4 expiry against the server clock).
 * * `FillLocalizedClassList(table, isFemale)` — Constants.lua:91-92 at load, the source of
 *   LOCALIZED_CLASS_NAMES_MALE/FEMALE. Filled from the class names this client shows everywhere
 *   else (UnitSnapshot.ts: the dataset's ChrClasses names when learned, else the compiled ruRU
 *   ones), keyed by ChrClasses.Filename. The dataset route carries one name per class, so the
 *   female table repeats it; the C client reads ChrClasses' female column, which this client has not
 *   been sent.
 * * `IsMacClient()` (UIParent.lua:3095, Mac key names), `NoPlayTime()`/`PartialPlayTime()`
 *   (PlayerFrame.lua:507/511, the rested-hours nag TrinityCore never sends), `UnitIsTalking(name)`
 *   (PlayerFrame.lua:150, PartyMemberFrame.lua:274; no voice chat) are false; nothing here is
 *   pretending to be a Mac, a play-time limit or a speaker.
 * * `RegisterStaticConstants(STATIC_CONSTANTS)` — Constants.lua:475 hands the C client an empty
 *   table nothing in the corpus reads back; answering nothing is what the table's readers see.
 *
 * `GetAddOnMetadata` is answered by FrameXmlBoot directly from the load-on-demand runtime's TOCs and
 * `GetLFGQueuedList` by FrameXmlLfd's Lua prelude; neither is duplicated here.
 */
import {
  CHAT_MSG_BATTLEGROUND, CHAT_MSG_GUILD, CHAT_MSG_PARTY, CHAT_MSG_RAID, CHAT_MSG_WHISPER,
} from "../../world/ChatProtocol.js";
import type { ArenaTeamInfo, ArenaTeamStats } from "../../world/ArenaProtocol.js";
import type { ActiveAura } from "../../world/AuraProtocol.js";
import { isVehicleActionBar, type PetActionButton } from "../../world/PetProtocol.js";
import type { WorldObjectState } from "../../world/WorldState.js";
import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import { className, classFileName } from "../ui/UnitSnapshot.js";
import { FRAMEXML_THREAT_BINDINGS, FRAMEXML_THREAT_PRELUDE, type FrameXmlThreatHost } from "./FrameXmlThreat.js";
import { FRAMEXML_QUEST_ABANDON_BINDINGS, type FrameXmlQuestAbandonHost } from "./FrameXmlQuestAbandon.js";
import { FRAMEXML_CHAT_WINDOW_FLAG_BINDINGS, type FrameXmlChatWindowFlagsHost } from "./FrameXmlChatWindowFlags.js";

/** The world facts and commands the model reads; `WorldClient` satisfies it structurally. */
export interface FrameXmlMechanicsWorld {
  readonly state: {
    readonly selfGuid?: bigint | undefined;
    readonly objects?: { get(guid: bigint): WorldObjectState | undefined } | undefined;
  };
  readonly events?: {
    on(name: "ARENA_TEAM_CHANGED", listener: (change: { readonly teamId: number | undefined }) => void): () => void;
  } | undefined;
  /** `SMSG_CLIENT_CONTROL_UPDATE`: the unit this client moves. */
  readonly controlledGuid?: bigint | undefined;
  readonly petSpells?: { readonly guid: bigint; readonly bar: readonly PetActionButton[] } | undefined;
  readonly arenaTeams?: ReadonlyMap<number, ArenaTeamInfo> | undefined;
  readonly arenaTeamStats?: ReadonlyMap<number, ArenaTeamStats> | undefined;
  readonly pvpScores?: { readonly ended: boolean; readonly winner: number } | undefined;
  aurasFor?(guid: bigint | undefined): readonly ActiveAura[];
  requestArenaTeam?(teamId: number): void;
  requestFlagCarriers?(): void;
  sendAddonMessage?(type: number, prefix: string, message: string, target?: string): void;
}

export interface FrameXmlMechanicsContext {
  world(): FrameXmlMechanicsWorld | undefined;
  /** The player's own object, for the arena slots in its private fields. */
  self(): WorldObjectState | undefined;
  /** Cache-only spell presentation; a C-API read never starts a fetch. */
  spell?(id: number): { readonly name: string; readonly iconPath?: string | undefined } | undefined;
}

interface FrameXmlMechanicsPump {
  fire(event: string, ...args: readonly unknown[]): number;
}

/** `GetArenaTeam`'s 22 values, in the client's order (PVPFrame.lua:128). */
export type FrameXmlArenaTeam = readonly [
  teamName: string, teamSize: number, teamRating: number, weekPlayed: number, weekWins: number,
  seasonPlayed: number, seasonWins: number, playerPlayed: number, seasonPlayerPlayed: number,
  teamRank: number, playerRating: number,
  backgroundR: number, backgroundG: number, backgroundB: number,
  emblem: number, emblemR: number, emblemG: number, emblemB: number,
  border: number, borderR: number, borderG: number, borderB: number,
];

/** `GetPossessInfo`'s texture, name and enabled. */
export type FrameXmlPossessInfo = readonly [texture: string | undefined, name: string | undefined, enabled: boolean];

/** `NUM_POSSESS_SLOTS` (BonusActionBarFrame.lua:6). */
export const FRAMEXML_POSSESS_SLOTS = 2;
/** `MAX_ARENA_TEAMS`: the three slots of PLAYER_FIELD_ARENA_TEAM_INFO. */
export const FRAMEXML_ARENA_TEAM_SLOTS = 3;
/** Player.h `ARENA_TEAM_END`: words per slot. */
const ARENA_TEAM_WORDS = 7;
const ARENA_TEAM_GAMES_WEEK = 3;
const ARENA_TEAM_GAMES_SEASON = 4;
const ARENA_TEAM_PERSONAL_RATING = 6;

/** The stock type words `SendAddonMessage` accepts and the wire types they are. */
export const FRAMEXML_ADDON_CHAT_TYPES: Readonly<Record<string, number>> = Object.freeze({
  PARTY: CHAT_MSG_PARTY,
  RAID: CHAT_MSG_RAID,
  GUILD: CHAT_MSG_GUILD,
  BATTLEGROUND: CHAT_MSG_BATTLEGROUND,
  WHISPER: CHAT_MSG_WHISPER,
});
/** ChatHandler.cpp's `msg.size() > 255` refusal, over the prefix, the tab and the body together. */
const ADDON_MESSAGE_MAX_BYTES = 255;

/** A tabard colour word as the arena packets carry it (0xAARRGGBB) into the client's 0..1 channels. */
function channels(color: number): readonly [number, number, number] {
  return [((color >>> 16) & 0xff) / 255, ((color >>> 8) & 0xff) / 255, (color & 0xff) / 255];
}

export class FrameXmlMechanicsModel {
  readonly #context: FrameXmlMechanicsContext;
  #pump: FrameXmlMechanicsPump | undefined;
  #unsubscribe: (() => void) | undefined;
  /** Teams already asked for since attach: the client asks once, the answer arrives as an event. */
  readonly #askedTeams = new Set<number>();

  constructor(context: FrameXmlMechanicsContext) {
    this.#context = context;
  }

  attach(pump: FrameXmlMechanicsPump): void {
    this.detach();
    this.#pump = pump;
    const world = this.#context.world();
    if (world?.events && typeof world.events.on === "function") {
      this.#unsubscribe = world.events.on("ARENA_TEAM_CHANGED", () => { this.#pump?.fire("ARENA_TEAM_UPDATE"); });
    }
  }

  detach(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#pump = undefined;
    this.#askedTeams.clear();
  }

  /** `GetArenaTeam(index)`: the player's team in slot 1..3, once the world knows it. */
  arenaTeam(index: number): FrameXmlArenaTeam | undefined {
    const world = this.#context.world();
    const self = this.#context.self();
    if (!world || !self || !Number.isInteger(index) || index < 1 || index > FRAMEXML_ARENA_TEAM_SLOTS) return undefined;
    const base = UPDATE_FIELDS.PLAYER_FIELD_ARENA_TEAM_INFO_1_1.offset + (index - 1) * ARENA_TEAM_WORDS;
    const word = (offset: number): number => self.fields.get(base + offset) ?? 0;
    const teamId = word(0);
    if (teamId === 0) return undefined;
    const info = world.arenaTeams?.get(teamId);
    const stats = world.arenaTeamStats?.get(teamId);
    if (!info || !stats) {
      if (!this.#askedTeams.has(teamId)) {
        this.#askedTeams.add(teamId);
        world.requestArenaTeam?.(teamId);
      }
      return undefined;
    }
    return [
      info.name, info.type, stats.rating, stats.weekGames, stats.weekWins, stats.seasonGames, stats.seasonWins,
      word(ARENA_TEAM_GAMES_WEEK), word(ARENA_TEAM_GAMES_SEASON), stats.rank, word(ARENA_TEAM_PERSONAL_RATING),
      ...channels(info.backgroundColor), info.emblemStyle, ...channels(info.emblemColor),
      info.borderStyle, ...channels(info.borderColor),
    ];
  }

  /** The unit the player possesses: controlled, not their own, with a pet-style (not vehicle) bar. */
  #possessed(): bigint | undefined {
    const world = this.#context.world();
    const controlled = world?.controlledGuid;
    const self = world?.state.selfGuid;
    if (!world || controlled === undefined || controlled === 0n || self === undefined || controlled === self) return undefined;
    const bar = world.petSpells;
    if (!bar || bar.guid !== controlled || isVehicleActionBar(bar.bar)) return undefined;
    return controlled;
  }

  /** `IsPossessBarVisible()`. */
  possessBarVisible(): boolean {
    return this.#possessed() !== undefined;
  }

  /** `GetPossessInfo(index)`, for the two stock slots; nil outside them. */
  possessInfo(index: number): FrameXmlPossessInfo | undefined {
    if (!Number.isInteger(index) || index < 1 || index > FRAMEXML_POSSESS_SLOTS) return undefined;
    const possessed = this.#possessed();
    if (possessed === undefined) return [undefined, undefined, false];
    const world = this.#context.world();
    const self = world?.state.selfGuid;
    const aura = world?.aurasFor?.(possessed).find((candidate) => candidate.casterGuid === self);
    const spell = aura === undefined ? undefined : this.#context.spell?.(aura.spellId);
    return [spell?.iconPath, spell?.name, spell !== undefined];
  }

  /** `GetBattlefieldWinner()`: the scoreboard's winner once the match ended. */
  battlefieldWinner(): number | undefined {
    const scores = this.#context.world()?.pvpScores;
    return scores?.ended ? scores.winner : undefined;
  }

  /** `RequestBattlefieldPositions()`. */
  requestBattlefieldPositions(): void {
    this.#context.world()?.requestFlagCarriers?.();
  }

  /** `SendAddonMessage(prefix, message, type, target)`; false when nothing was sent. */
  sendAddonMessage(prefix: string, message: string, type: string, target: string): boolean {
    const world = this.#context.world();
    const code = FRAMEXML_ADDON_CHAT_TYPES[type.toUpperCase()];
    if (!world?.sendAddonMessage || code === undefined || prefix.length === 0) return false;
    if (code === CHAT_MSG_WHISPER && target.length === 0) return false;
    if (new TextEncoder().encode(`${prefix}\t${message}`).length > ADDON_MESSAGE_MAX_BYTES) return false;
    world.sendAddonMessage(code, prefix, message, code === CHAT_MSG_WHISPER ? target : "");
    return true;
  }
}

/**
 * `FillLocalizedClassList`'s rows: ChrClasses.Filename then the name this client shows for it.
 * The same rows for both tables: one name per class is what the dataset route carries (file comment).
 */
export function frameXmlLocalizedClassPairs(): readonly string[] {
  const pairs: string[] = [];
  for (let classId = 1; classId <= 11; classId++) {
    const token = classFileName(classId);
    if (token !== undefined) pairs.push(token, className(classId));
  }
  return pairs;
}

/** The part of the world seam the bindings read. */
export interface FrameXmlMechanicsHost extends FrameXmlThreatHost, FrameXmlQuestAbandonHost, FrameXmlChatWindowFlagsHost {
  readonly mechanics?: FrameXmlMechanicsModel | undefined;
  containerNumSlots?(bagId: number): number;
  containerItemInfo?(bagId: number, slot: number): readonly unknown[] | undefined;
  questLogEntryCount?(): readonly [number, number];
  questLogTimeLeft?(index?: number): number | undefined;
}

const NOTHING: readonly unknown[] = Object.freeze([]);
const FALSE: readonly unknown[] = Object.freeze([false]);
/** Bag id -2: the keyring (ContainerFrame.lua's KEYRING_CONTAINER). */
const KEYRING_CONTAINER = -2;

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function indexOf(value: unknown): number {
  const index = Number(value);
  return Number.isFinite(index) ? Math.trunc(index) : 0;
}

/** The timed quests' remaining seconds with their 1-based rows, in log order. */
function questTimers(host: FrameXmlMechanicsHost): readonly { readonly index: number; readonly seconds: number }[] {
  const count = host.questLogEntryCount?.()[0] ?? 0;
  const timers: { index: number; seconds: number }[] = [];
  for (let index = 1; index <= count; index++) {
    const seconds = host.questLogTimeLeft?.(index);
    if (seconds !== undefined) timers.push({ index, seconds });
  }
  return timers;
}

export const FRAMEXML_MECHANICS_BINDINGS: Readonly<Record<string,
  (host: FrameXmlMechanicsHost, args: readonly unknown[]) => readonly unknown[]>> = Object.freeze({
  ...FRAMEXML_THREAT_BINDINGS,
  ...FRAMEXML_QUEST_ABANDON_BINDINGS,
  ...FRAMEXML_CHAT_WINDOW_FLAG_BINDINGS,
  HasKey: (host) => {
    const slots = host.containerNumSlots?.(KEYRING_CONTAINER) ?? 0;
    for (let slot = 1; slot <= slots; slot++) {
      if (host.containerItemInfo?.(KEYRING_CONTAINER, slot) !== undefined) return [true];
    }
    return FALSE;
  },
  GetArenaTeam: (host, args) => {
    const team = host.mechanics?.arenaTeam(indexOf(args[0]));
    return team === undefined ? NOTHING : [...team];
  },
  IsPossessBarVisible: (host) => [host.mechanics?.possessBarVisible() ?? false],
  GetPossessInfo: (host, args) => {
    const info = host.mechanics?.possessInfo(indexOf(args[0]));
    return info === undefined ? NOTHING : [...info];
  },
  GetBattlefieldWinner: (host) => {
    const winner = host.mechanics?.battlefieldWinner();
    return winner === undefined ? NOTHING : [winner];
  },
  RequestBattlefieldPositions: (host) => {
    host.mechanics?.requestBattlefieldPositions();
    return NOTHING;
  },
  SendAddonMessage: (host, args) => {
    host.mechanics?.sendAddonMessage(text(args[0]), text(args[1]), text(args[2]), text(args[3]));
    return NOTHING;
  },
  GetQuestTimers: (host) => questTimers(host).map((timer) => timer.seconds),
  GetQuestIndexForTimer: (host, args) => {
    const timer = questTimers(host)[indexOf(args[0]) - 1];
    return timer === undefined ? NOTHING : [timer.index];
  },
  // The Lua half (FRAMEXML_MECHANICS_PRELUDE) writes these pairs into the table stock passes.
  FillLocalizedClassList: () => [...frameXmlLocalizedClassPairs()],
  IsMacClient: () => FALSE,
  NoPlayTime: () => FALSE,
  PartialPlayTime: () => FALSE,
  UnitIsTalking: () => FALSE,
  RegisterStaticConstants: () => NOTHING,
});

/**
 * The Lua half: `FillLocalizedClassList(t, isFemale)` fills the table it is given (a host binding
 * cannot write into a Lua table), and the threat prelude reads the `threatWarning` CVar.
 */
export const FRAMEXML_MECHANICS_PRELUDE = `${FRAMEXML_THREAT_PRELUDE}
do
  local impl = __fxNeutralImpl
  local pairsOf = rawget(_G, "__fxSeam_FillLocalizedClassList")
  if impl ~= nil and pairsOf ~= nil then
    impl.FillLocalizedClassList = function(t, isFemale)
      if type(t) ~= "table" then return end
      local names = { pairsOf(isFemale and true or false) }
      for index = 1, #names, 2 do t[names[index]] = names[index + 1] end
    end
  end
end
`;
