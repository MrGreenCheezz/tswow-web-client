/**
 * The stock chat's C-API, its slash commands and its keyboard owner, bound to the world client.
 *
 * `ChatEdit_ParseText` and the ~70 `SlashCmdList` bodies in stock `ChatFrame.lua` call about 150
 * client functions. When this was written the world seam bound 17 of them (`SendChatMessage`,
 * `GetChatWindow*`, `TargetUnit`, …); every other name answered from the stub floor with nothing,
 * so measured on the live fixture `/dance`, `/wave`, `/roll`, `/invite Foo`, `/cast` and `/script`
 * sent nothing and printed nothing, `/join test` printed «Неправильное название канала» and `/who`
 * raised `chatframe.lua:1949` on the absent `WhoFrameEditBox`. This module is the chat half:
 *
 * - {@link installFrameXmlChatApi} registers the chat and social functions those bodies call, each
 *   mapped onto a `WorldClient` method that already exists. It never takes a name the seam binding
 *   table owns ({@link FRAMEXML_SEAM_NAMES}): one name, one owner.
 * - {@link installFrameXmlNativeSlash} mirrors this client's own commands (`Chat.ts`) into
 *   `SlashCmdList["WEBCLIENT_*"]`, but only the spellings no stock `SLASH_*`, secure command, chat
 *   type or `EMOTE*_CMD` claims, so `/whois`, `/vehicle`, `/chanlist` and a module's commands work
 *   from the stock edit box without shadowing one stock command. `/who` is stock's (`SendWho`,
 *   and `ShowWhoPanel` for a bare one) wherever FriendsFrame.xml's `WhoFrameEditBox` is loaded and
 *   the native who panel only in a TOC without it, and stock `/help` is followed by the lines for
 *   what was mirrored.
 * - {@link installFrameXmlStockChat} composes both with a `ChatInputOwner` that opens
 *   `ChatFrame1EditBox` for Enter, `/` and the reply key, after proving the edit box and the Lua
 *   that opens it are really there.
 *
 * `/script` and `/run`: stock `SlashCmdList.SCRIPT` calls `RunScript(msg)`, and here `RunScript`
 * compiles and runs that text in this FrameXML VM, as the original client does. It is reachable
 * only from what the player types into the stock edit box (or from Lua that could already run
 * anything): chat a module sends goes through `Chat.submitChat`, which has no script command, so no
 * module-sent line can reach it. The VM has no `js` library, so the script sees the UI and nothing
 * of the page. `/reload` is `ConsoleExec("reloadui")` and reaches the world mount's `ReloadUI`; any
 * other `/console` command answers that the console does not exist in the browser rather than doing
 * nothing.
 */

import type { WorldClient } from "../../world/WorldClient.js";
import { emoteStandState, findEmote, type EmoteData } from "../../world/EmoteRules.js";
import { SOCIAL_FLAG_FRIEND, SOCIAL_FLAG_IGNORED, type WhoRequest } from "../../world/ContactProtocol.js";
import type { GlueLuaRef, GlueLuaVm } from "../glue/GlueLua.js";
import type { FrameXmlFrame } from "../ui/framexml_compat/FrameXmlTypes.js";
import { installChatInputOwner, type ChatInputOwner } from "../ui/ChatInputOwner.js";
import { className, raceName } from "../ui/UnitSnapshot.js";
import {
  evaluateMacroOptions, installMacroOptionErrorSink, macroOptions, type MacroContext,
} from "../macro/MacroOptions.js";
import { installMacroClickFrames, installMacroLineExecutor } from "../macro/MacroRunner.js";
import { FRAMEXML_SEAM_NAMES } from "./FrameXmlWorldSeam.js";

/** The part of `WorldClient` this module reads and calls; tests pass a recording fake. */
export type FrameXmlChatWorld = Pick<WorldClient,
  | "emotes" | "targetGuid" | "state" | "channels" | "group" | "contacts" | "raidTargets"
  | "playedTime" | "events" | "displayName" | "selectTarget" | "sendTextEmote" | "setStandState"
  | "joinChannel" | "leaveChannel" | "requestChannelList" | "kickChannelMember" | "banChannelMember"
  | "unbanChannelMember" | "inviteChannelMember" | "setChannelOwner" | "setChannelPassword"
  | "setChannelModerator" | "unsetChannelModerator" | "muteChannelMember" | "unmuteChannelMember"
  | "toggleChannelAnnounce" | "rollDice" | "inviteToGroup" | "removeFromGroup" | "leaveGroup"
  | "setGroupLeader" | "resetInstances" | "inviteToGuild"
  | "removeGuildMember" | "promoteGuildMember" | "demoteGuildMember" | "setGuildMotd" | "leaveGuild"
  | "requestGuildInfo" | "setGuildLeader" | "addFriend" | "removeFriend" | "addIgnore"
  | "removeIgnore" | "requestWho" | "challengeDuelToSelection" | "startTrade" | "requestPlayedTime"
  | "leaveVehicle" | "setRaidTarget" | "startReadyCheck" | "requestLogout" | "startAttack" | "stopAttack">;

export interface FrameXmlChatApiDeps {
  /** The world the calls go to; undefined between worlds, when every call answers nothing. */
  readonly world: () => FrameXmlChatWorld | undefined;
  /** A line the client writes itself (`Chat.systemLine`); the seam delivers it to ChatFrame1. */
  readonly notice: (text: string) => void;
  /** The native `/cast` and `/use` argument parsers (`CombatCommands.ts`). */
  readonly cast: (argument: string) => void;
  readonly use: (argument: string) => void;
  /** A macro unit token — `target`, `focus`, `player`, `pet`, `mouseover` — to its GUID. */
  readonly unitGuid: (unit: string) => bigint | undefined;
  /** Fires one stock event into the running FrameXML, inside a mutation batch. */
  readonly dispatchEvent?: (event: string, ...args: unknown[]) => void;
  /** Names another owner binds. Defaults to the world seam's binding table. */
  readonly reserved?: Iterable<string>;
  /**
   * What `SecureCmdOptionParse` evaluates macro conditions against — the world seam's
   * `macroContext()`. Absent, it decides only what needs no state, as before macro conditions.
   */
  readonly macroContext?: () => MacroContext | undefined;
}

export interface FrameXmlChatApiInstall {
  readonly installed: readonly string[];
  /** Names left alone because {@link FrameXmlChatApiDeps.reserved} already owns them. */
  readonly skipped: readonly string[];
  /** Drops the pending `/played` subscription; the bindings themselves die with the VM. */
  dispose(): void;
}

type Binding = (args: readonly unknown[]) => readonly unknown[];

/** `CHANNEL_FLAG_CUSTOM` from `SMSG_CHANNEL_LIST`: a player-made channel, not a server one. */
const CHANNEL_FLAG_CUSTOM = 0x01;

function text(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

function whole(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(text(value).trim());
  return Number.isInteger(number) ? number : undefined;
}

/** The server may prefix a channel with its number and suffix a zone; `LiveWorldSeam`'s rule. */
function shortChannelName(raw: string): string {
  return raw.trim().replace(/^\d+\.\s*/, "").replace(/\s+-\s+[^-]+$/, "").trim();
}

/** Joined channels in `WorldClient.channels` order, which is the 1-based order the seam numbers. */
function channelNames(world: FrameXmlChatWorld): string[] {
  return world.channels instanceof Map
    ? [...world.channels.keys()].filter((name): name is string => typeof name === "string") : [];
}

/** A channel argument as the player typed it — a number, a short name or a full name. */
function resolveChannel(world: FrameXmlChatWorld, value: unknown): string | undefined {
  const typed = text(value).trim();
  if (!typed) return undefined;
  const names = channelNames(world);
  if (/^\d+$/.test(typed)) return names[Number(typed) - 1];
  const wanted = typed.toLowerCase();
  return names.find((name) => name.toLowerCase() === wanted
    || shortChannelName(name).toLowerCase() === shortChannelName(typed).toLowerCase()) ?? typed;
}

/** `partyN` and the macro unit tokens to a GUID. */
function unitToken(world: FrameXmlChatWorld, deps: FrameXmlChatApiDeps, unit: string): bigint | undefined {
  const token = unit.trim().toLowerCase();
  const party = /^party([1-4])$/.exec(token);
  if (party) {
    const self = world.state.selfGuid;
    const others = (world.group?.members ?? []).filter((member) => member.guid !== self);
    return others[Number(party[1]) - 1]?.guid;
  }
  return deps.unitGuid(token);
}

const UNIT_TOKEN = /^(?:target|focus|player|self|pet|mouseover|party[1-4])$/i;

/** A visible player or creature whose shown name is `name`, exactly or as a prefix. */
function guidByName(world: FrameXmlChatWorld, name: string, exact = true): bigint | undefined {
  const wanted = name.trim().toLowerCase();
  if (!wanted || !(world.state.objects instanceof Map)) return undefined;
  let prefixMatch: bigint | undefined;
  for (const [guid, object] of world.state.objects) {
    if (object.typeId !== 3 && object.typeId !== 4) continue;
    const shown = world.displayName(guid).toLowerCase();
    if (shown === wanted) return guid;
    if (!exact && prefixMatch === undefined && shown.startsWith(wanted)) prefixMatch = guid;
  }
  return prefixMatch;
}

/** A unit token or a name, as the stock functions accept either, to a GUID. */
function unitOrNameGuid(world: FrameXmlChatWorld, deps: FrameXmlChatApiDeps, value: unknown): bigint | undefined {
  const typed = text(value).trim();
  if (!typed) return undefined;
  return UNIT_TOKEN.test(typed) ? unitToken(world, deps, typed) : guidByName(world, typed);
}

/** A unit token or a name to the name the server's by-name opcodes want. */
function unitOrName(world: FrameXmlChatWorld, deps: FrameXmlChatApiDeps, value: unknown): string {
  const typed = text(value).trim();
  if (!UNIT_TOKEN.test(typed)) return typed;
  const guid = unitToken(world, deps, typed);
  return guid === undefined ? "" : world.displayName(guid);
}

function contactGuid(world: FrameXmlChatWorld, name: string, flag: number): bigint | undefined {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return undefined;
  return world.contacts?.contacts.find((contact) => (contact.flags & flag) !== 0
    && world.displayName(contact.guid).toLowerCase() === wanted)?.guid;
}

/** The player's current target's name, when the target is a player; the social calls' default. */
function targetPlayerName(world: FrameXmlChatWorld): string {
  const guid = world.targetGuid;
  if (guid === undefined) return "";
  return world.state.objects.get(guid)?.typeId === 4 ? world.displayName(guid) : "";
}

/**
 * The ChrRaces/ChrClasses ids named `value` (the dataset's names, `raceName`/`className`), as a
 * `CMSG_WHO` mask: the core tests `classmask & (1 << class)` and `racemask & (1 << race)`
 * (MiscHandler.cpp:403-411). Zero when no id is named so.
 */
function whoMask(value: string, nameOf: (id: number) => string): number {
  const wanted = value.trim().toLowerCase();
  let mask = 0;
  for (let id = 1; id < 32 && wanted; id += 1) {
    if (nameOf(id).toLowerCase() === wanted) mask = (mask | (1 << id)) >>> 0;
  }
  return mask;
}

/**
 * The `/who` query language, far enough for `CMSG_WHO`.
 *
 * `n-"name"` and `g-"guild"` are fields of their own; a level or `min-max` range is the level
 * filter; a race or class value is the packet's race or class mask; everything else is a free word,
 * which `WorldSession::HandleWhoOpcode` matches against a player's name, guild and zone name only
 * (MiscHandler.cpp:443-450). One bare word is a name, as the native `/who Имя` has it.
 *
 * The tags are GlobalStrings' `WHO_TAG_*`, which the client localises: enUS `n- g- z- r- c-`, ruRU
 * `и- g- з- р- к-` (GlobalStrings.lua:8941-8945). Stock builds its own queries from them — a bare
 * /who is `з-"<zone>" 57-63` (WhoFrame_GetDefaultWhoCommand, FriendsFrame.lua:1502) — so both
 * spellings are read here. A zone is a free word (the core matches the zone's name); a race or class
 * this client cannot name — a female ruRU form, say — stays one too.
 */
export function frameXmlWhoRequest(query: string): WhoRequest {
  let name: string | undefined;
  let guild: string | undefined;
  let levelMin: number | undefined;
  let levelMax: number | undefined;
  let raceMask: number | undefined;
  let classMask: number | undefined;
  const words: string[] = [];
  // A zone, race or class word came with its tag, so it is never the lone bare word taken as a name.
  let tagged = false;
  const pattern = /([nиgzзrрcк])-"([^"]*)"|([nиgzзrрcк])-(\S+)|(\d+)\s*-\s*(\d+)|"([^"]*)"|(\S+)/giu;
  for (const match of query.matchAll(pattern)) {
    const field = (match[1] ?? match[3])?.toLowerCase();
    const value = match[2] ?? match[4];
    if (field !== undefined && value !== undefined) {
      const race = field === "r" || field === "р";
      const mask = race || field === "c" || field === "к" ? whoMask(value, race ? raceName : className) : 0;
      if (field === "n" || field === "и") name = value;
      else if (field === "g") guild = value;
      else if (mask !== 0 && race) raceMask = ((raceMask ?? 0) | mask) >>> 0;
      else if (mask !== 0) classMask = ((classMask ?? 0) | mask) >>> 0;
      else if (value) {
        words.push(value);
        tagged = true;
      }
      continue;
    }
    if (match[5] !== undefined && match[6] !== undefined) {
      levelMin = Number(match[5]);
      levelMax = Number(match[6]);
      continue;
    }
    const word = match[7] ?? match[8];
    if (!word) continue;
    if (/^\d+$/.test(word)) {
      levelMin = Number(word);
      levelMax = Number(word);
      continue;
    }
    words.push(word);
  }
  if (name === undefined && words.length === 1 && !tagged) name = words.shift();
  return {
    ...(name === undefined ? {} : { name }),
    ...(guild === undefined ? {} : { guild }),
    ...(levelMin === undefined ? {} : { levelMin }),
    ...(levelMax === undefined ? {} : { levelMax }),
    ...(raceMask === undefined ? {} : { raceMask }),
    ...(classMask === undefined ? {} : { classMask }),
    // The client is limited to four words; the server refuses more.
    ...(words.length === 0 ? {} : { words: words.slice(0, 4) }),
  };
}

/**
 * `SecureCmdOptionParse(options)`: the action its macro conditions choose and that clause's target.
 *
 * With a context this is the client's evaluation (macro/MacroOptions.ts): clauses in order, bracket
 * groups as alternatives with their own targets, conditions within a group all holding; no clause
 * holding answers `nil`. Every stock `SecureCmdList` body calls it (ChatFrame.lua:1013-1416), and so
 * does `SecureStateDriver`, five times a second per registered driver (SecureStateDriver.lua:89).
 *
 * Without a context only what needs no state is decided, as before conditions were evaluated: the
 * first clause, answered when its first group holds nothing but a target (`[@focus][@target] X` is
 * X on focus), `nil` when that group has any other condition. An empty string answers `""`, which
 * the stock handlers treat as «go» (`if SecureCmdOptionParse(msg) then`).
 */
export function frameXmlSecureCmdOptionParse(
  options: string,
  context?: MacroContext,
): readonly [string, string?] | readonly [] {
  const parsed = macroOptions(options);
  if (context) {
    const chosen = evaluateMacroOptions(parsed, context);
    return chosen === undefined ? [] : chosen.target === undefined ? [chosen.text] : [chosen.text, chosen.target];
  }
  const first = parsed.clauses[0];
  if (!first || first.error !== undefined) return [];
  const group = first.groups[0];
  if (group === undefined) return [first.text];
  if (group.conditions.length > 0) return [];
  return group.target === undefined ? [first.text] : [first.text, group.target];
}

/**
 * Registers the stock chat's world-facing C-API into a loaded FrameXML VM.
 *
 * Called after `boot.load()`: registration replaces whatever the stub floor put under the same
 * name, and stock calls these as globals at call time, so the later binding is the one they reach.
 */
export function installFrameXmlChatApi(
  vm: Pick<GlueLuaVm, "registerGlobal" | "execute">,
  deps: FrameXmlChatApiDeps,
): FrameXmlChatApiInstall {
  const reserved = new Set(deps.reserved ?? FRAMEXML_SEAM_NAMES);
  const cleanups = new Set<() => void>();
  const withWorld = (call: (world: FrameXmlChatWorld, args: readonly unknown[]) => void): Binding => (args) => {
    const world = deps.world();
    if (world) call(world, args);
    return [];
  };
  const byChannel = (send: (world: FrameXmlChatWorld, channel: string, value: string) => void): Binding =>
    withWorld((world, [channel, value]) => {
      const resolved = resolveChannel(world, channel);
      if (resolved) send(world, resolved, text(value).trim());
    });
  const channelIndex = (world: FrameXmlChatWorld, value: unknown): readonly unknown[] => {
    const names = channelNames(world);
    const number = whole(value);
    const index = number !== undefined && number > 0
      ? number - 1
      : names.findIndex((name) => shortChannelName(name).toLowerCase()
        === shortChannelName(text(value)).toLowerCase());
    const name = names[index];
    return name === undefined ? [0] : [index + 1, shortChannelName(name), 0];
  };
  const join: Binding = (args) => {
    const world = deps.world();
    const name = text(args[0]).trim();
    if (!world || !name) return [];
    world.joinChannel(name, text(args[1]));
    // `zoneChannel` 0 is «a custom channel»; stock only needs it non-nil to record the join.
    return [0, name];
  };

  const api: Record<string, Binding> = {
    DoEmote: withWorld((world, [token, target]) => {
      const command = text(token).trim().toLowerCase();
      if (!command) return;
      const entry = findEmote(world.emotes, command);
      if (!entry) {
        deps.notice(world.emotes
          ? `Эмоции «${command}» нет в EmotesText.dbc`
          : "Список эмоций ещё не загружен. Повторите через несколько секунд.");
        return;
      }
      const named = text(target).trim();
      const guid = named ? unitOrNameGuid(world, deps, named) ?? 0n : world.targetGuid ?? 0n;
      world.sendTextEmote(entry.id, guid);
      // Sit, sleep and kneel need the stand-state packet too; `Chat.runEmote` has the same rule.
      const standState = emoteStandState(entry);
      if (standState !== undefined) world.setStandState(standState);
    }),

    JoinChannelByName: join,
    JoinPermanentChannel: join,
    JoinTemporaryChannel: join,
    LeaveChannelByName: withWorld((world, [channel]) => {
      const resolved = resolveChannel(world, channel);
      if (resolved) world.leaveChannel(resolved);
    }),
    ListChannelByName: withWorld((world, [channel]) => {
      const resolved = resolveChannel(world, channel);
      if (resolved) world.requestChannelList(resolved);
    }),
    ListChannels: withWorld((world) => {
      const names = channelNames(world);
      deps.notice(names.length === 0 ? "Вы не состоите ни в одном канале."
        : `Каналы: ${names.map((name, index) => `[${index + 1}. ${shortChannelName(name)}]`).join(" ")}`);
    }),
    GetChannelList: () => {
      const world = deps.world();
      return world ? channelNames(world).flatMap((name, index) => [index + 1, shortChannelName(name)]) : [];
    },
    GetChannelName: (args) => {
      const world = deps.world();
      return world ? channelIndex(world, args[0]) : [0];
    },
    // Only the server channels the player is in: `ChatChannels.dbc` is not loaded by this client,
    // so the ones not joined cannot be named truthfully.
    EnumerateServerChannels: () => {
      const world = deps.world();
      if (!world || !(world.channels instanceof Map)) return [];
      return [...world.channels.entries()]
        .filter(([name, channel]) => typeof name === "string" && (channel.flags & CHANNEL_FLAG_CUSTOM) === 0)
        .map(([name]) => shortChannelName(name));
    },
    ChannelInvite: byChannel((world, channel, name) => { if (name) world.inviteChannelMember(channel, name); }),
    ChannelKick: byChannel((world, channel, name) => { if (name) world.kickChannelMember(channel, name); }),
    ChannelBan: byChannel((world, channel, name) => { if (name) world.banChannelMember(channel, name); }),
    ChannelUnban: byChannel((world, channel, name) => { if (name) world.unbanChannelMember(channel, name); }),
    ChannelModerator: byChannel((world, channel, name) => { if (name) world.setChannelModerator(channel, name); }),
    ChannelUnmoderator: byChannel((world, channel, name) => {
      if (name) world.unsetChannelModerator(channel, name);
    }),
    ChannelMute: byChannel((world, channel, name) => { if (name) world.muteChannelMember(channel, name); }),
    ChannelUnmute: byChannel((world, channel, name) => { if (name) world.unmuteChannelMember(channel, name); }),
    SetChannelOwner: byChannel((world, channel, name) => { if (name) world.setChannelOwner(channel, name); }),
    SetChannelPassword: byChannel((world, channel, password) => world.setChannelPassword(channel, password)),
    ChannelToggleAnnouncements: byChannel((world, channel) => world.toggleChannelAnnounce(channel)),

    RandomRoll: withWorld((world, [low, high]) => {
      const first = whole(low) ?? 1;
      const second = whole(high) ?? 100;
      world.rollDice(Math.min(first, second), Math.max(first, second));
    }),
    InviteUnit: withWorld((world, [who]) => {
      const name = unitOrName(world, deps, who) || targetPlayerName(world);
      if (name) world.inviteToGroup(name);
      else deps.notice("Укажите имя или выберите игрока целью.");
    }),
    UninviteUnit: withWorld((world, [who]) => {
      const typed = text(who).trim();
      const guid = UNIT_TOKEN.test(typed) ? unitToken(world, deps, typed)
        : world.group?.members.find((member) => member.name.toLowerCase() === typed.toLowerCase())?.guid;
      if (guid !== undefined) world.removeFromGroup(guid);
      else deps.notice(typed ? `${typed} нет в вашей группе.` : "Укажите имя участника группы.");
    }),
    // The player menu's «Покинуть группу» (UnitPopup.lua:1271-1272) is stock's only way out of a
    // party, and it reached the stub floor: on 2026-09-28 a dungeon-finder group of four bots could
    // not be left. No `world.group` check here: the core reads nothing, decides who is leaving, and
    // cancels a pending invite the player leads with the same opcode (GroupHandler.cpp:396-422).
    LeaveParty: withWorld((world) => world.leaveGroup()),
    // The menus' PROMOTE (UnitPopup.lua:1248, :1331) and `/promote` (ChatFrame.lua:1478): a unit
    // token or a member's name, as UninviteUnit takes them.
    PromoteToLeader: withWorld((world, [who]) => {
      const typed = text(who).trim();
      const guid = UNIT_TOKEN.test(typed) ? unitToken(world, deps, typed)
        : world.group?.members.find((member) => member.name.toLowerCase() === typed.toLowerCase())?.guid;
      if (guid !== undefined) world.setGroupLeader(guid);
      else deps.notice(typed ? `${typed} нет в вашей группе.` : "Укажите имя участника группы.");
    }),
    // StaticPopup's CONFIRM_RESET_INSTANCES (StaticPopup.lua:418); the core decides whose saves.
    ResetInstances: withWorld((world) => world.resetInstances()),
    GuildInvite: withWorld((world, [who]) => {
      const name = unitOrName(world, deps, who) || targetPlayerName(world);
      if (name) world.inviteToGuild(name);
    }),
    GuildUninvite: withWorld((world, [who]) => {
      const name = unitOrName(world, deps, who) || targetPlayerName(world);
      if (name) world.removeGuildMember(name);
    }),
    GuildPromote: withWorld((world, [who]) => {
      const name = unitOrName(world, deps, who);
      if (name) world.promoteGuildMember(name);
    }),
    GuildDemote: withWorld((world, [who]) => {
      const name = unitOrName(world, deps, who);
      if (name) world.demoteGuildMember(name);
    }),
    GuildSetLeader: withWorld((world, [who]) => {
      const name = unitOrName(world, deps, who);
      if (name) world.setGuildLeader(name);
    }),
    GuildSetMOTD: withWorld((world, [motd]) => world.setGuildMotd(text(motd))),
    GuildLeave: withWorld((world) => world.leaveGuild()),
    GuildInfo: withWorld((world) => world.requestGuildInfo()),

    AddFriend: withWorld((world, [who, note]) => {
      const name = unitOrName(world, deps, who) || targetPlayerName(world);
      if (name) world.addFriend(name, text(note));
    }),
    RemoveFriend: withWorld((world, [who]) => {
      const name = unitOrName(world, deps, who) || targetPlayerName(world);
      const guid = contactGuid(world, name, SOCIAL_FLAG_FRIEND);
      if (guid !== undefined) world.removeFriend(guid);
      else if (name) deps.notice(`${name} нет в списке друзей.`);
    }),
    // Stock `/friend` with no argument passes nil here (its own `player ~= ""` test is true for
    // nil), which the original client reads as «the target».
    AddOrRemoveFriend: withWorld((world, [who, note]) => {
      const name = unitOrName(world, deps, who) || targetPlayerName(world);
      if (!name) return deps.notice("Укажите имя или выберите игрока целью.");
      const guid = contactGuid(world, name, SOCIAL_FLAG_FRIEND);
      if (guid !== undefined) world.removeFriend(guid);
      else world.addFriend(name, text(note));
    }),
    AddIgnore: withWorld((world, [who]) => {
      const name = unitOrName(world, deps, who) || targetPlayerName(world);
      if (name) world.addIgnore(name);
    }),
    DelIgnore: withWorld((world, [who]) => {
      const name = unitOrName(world, deps, who) || targetPlayerName(world);
      const guid = contactGuid(world, name, SOCIAL_FLAG_IGNORED);
      if (guid !== undefined) world.removeIgnore(guid);
      else if (name) deps.notice(`${name} нет в списке игнорируемых.`);
    }),
    AddOrDelIgnore: withWorld((world, [who]) => {
      const name = unitOrName(world, deps, who) || targetPlayerName(world);
      if (!name) return deps.notice("Укажите имя или выберите игрока целью.");
      const guid = contactGuid(world, name, SOCIAL_FLAG_IGNORED);
      if (guid !== undefined) world.removeIgnore(guid);
      else world.addIgnore(name);
    }),
    SendWho: withWorld((world, [query]) => world.requestWho(frameXmlWhoRequest(text(query)))),

    // The duel is the `Duel` spell cast at the current target (`challengeDuelToSelection`); a name
    // that is not the target cannot be challenged without changing the player's selection.
    StartDuel: withWorld((world, [who]) => {
      const typed = text(who).trim();
      const guid = typed ? unitOrNameGuid(world, deps, typed) : world.targetGuid;
      if (guid === undefined || guid !== world.targetGuid) {
        deps.notice("Сначала выберите игрока целью.");
        return;
      }
      if (!world.challengeDuelToSelection()) deps.notice("Нельзя вызвать эту цель на дуэль.");
    }),
    InitiateTrade: withWorld((world, [who]) => {
      const guid = unitOrNameGuid(world, deps, text(who) || "target");
      if (guid === undefined) deps.notice("Сначала выберите игрока целью.");
      else world.startTrade(guid);
    }),
    RequestTimePlayed: withWorld((world) => {
      const before = world.playedTime;
      world.requestPlayedTime();
      const dispatch = deps.dispatchEvent;
      if (!dispatch || typeof world.events?.on !== "function") return;
      // `SMSG_PLAYED_TIME` lands as `CHARACTER_SHEET_CHANGED`; stock ChatFrame prints /played on
      // `TIME_PLAYED_MSG`, which nothing else fires in this client.
      const off = world.events.on("CHARACTER_SHEET_CHANGED", () => {
        const played = world.playedTime;
        if (!played || played === before) return;
        off();
        cleanups.delete(off);
        dispatch("TIME_PLAYED_MSG", played.total, played.atLevel);
      });
      cleanups.add(off);
    }),
    VehicleExit: withWorld((world) => world.leaveVehicle()),
    // Stock indices run 1–8 and 0 clears; the wire's icons run 0–7, and a zero GUID clears one.
    SetRaidTarget: withWorld((world, [unit, index]) => {
      const guid = unitOrNameGuid(world, deps, unit);
      const icon = whole(index);
      if (guid === undefined || icon === undefined || icon < 0 || icon > 8) return;
      if (icon > 0) {
        world.setRaidTarget(icon - 1, guid);
        return;
      }
      for (const [held, marked] of world.raidTargets) if (marked === guid) world.setRaidTarget(held, 0n);
    }),
    DoReadyCheck: withWorld((world) => world.startReadyCheck()),
    Logout: withWorld((world) => world.requestLogout()),

    CastSpellByName: (args) => {
      const spell = text(args[0]).trim();
      const unit = text(args[1]).trim();
      if (spell) deps.cast(unit ? `[@${unit}] ${spell}` : spell);
      return [];
    },
    UseItemByName: (args) => {
      const item = text(args[0]).trim();
      if (item) deps.use(item);
      return [];
    },
    TargetByName: withWorld((world, [name, exact]) => {
      const guid = guidByName(world, text(name), exact === true || exact === 1);
      if (guid !== undefined) world.selectTarget(guid);
    }),
    // Stock `/startattack [@unit]` passes the unit, `/startattack Name` the name and a bare
    // `/startattack` an empty string, which is the current target (ChatFrame.lua:1013-1021). Melee
    // swings at the selection (`CMSG_ATTACK_SWING`), so another unit is selected first, as the
    // original client does; a unit or name that is not there attacks nothing.
    StartAttack: withWorld((world, [unit]) => {
      const typed = text(unit).trim();
      if (typed && typed.toLowerCase() !== "target") {
        const guid = unitOrNameGuid(world, deps, typed);
        if (guid === undefined) return;
        if (guid !== world.targetGuid) world.selectTarget(guid);
      }
      world.startAttack();
    }),
    StopAttack: withWorld((world) => world.stopAttack()),
    SecureCmdOptionParse: (args) => frameXmlSecureCmdOptionParse(text(args[0]), deps.macroContext?.()),
  };

  const installed: string[] = [];
  const skipped: string[] = [];
  for (const [name, binding] of Object.entries(api)) {
    if (reserved.has(name)) {
      skipped.push(name);
      continue;
    }
    vm.registerGlobal(name, binding);
    installed.push(name);
  }
  if (reserved.has("RunScript")) skipped.push("RunScript");
  else {
    const loaded = vm.execute(RUN_SCRIPT_SOURCE, "@webclient/chat-api:RunScript");
    if (loaded.ok) installed.push("RunScript");
  }
  if (reserved.has("ConsoleExec")) skipped.push("ConsoleExec");
  else {
    vm.registerGlobal("__webclientConsoleUnavailable", (args) => {
      const command = text(args[0]).trim();
      deps.notice(`Консоль клиента недоступна в браузере${command ? `: «${command}»` : ""}.`);
      return [];
    });
    const loaded = vm.execute(CONSOLE_EXEC_SOURCE, "@webclient/chat-api:ConsoleExec");
    if (loaded.ok) installed.push("ConsoleExec");
  }
  return {
    installed,
    skipped,
    dispose() {
      for (const off of cleanups) off();
      cleanups.clear();
    },
  };
}

/** `RunScript` in Lua, so errors reach the corpus' own handler exactly as `/script` would. */
const RUN_SCRIPT_SOURCE = `
RunScript = function(source)
  if type(source) ~= "string" or source == "" then return end
  local chunk, failure = loadstring(source, "RunScript")
  if not chunk then
    geterrorhandler()(failure)
    return
  end
  local ok, message = pcall(chunk)
  if not ok then geterrorhandler()(message) end
end
`;

/**
 * `ConsoleExec` in Lua: `reloadui` is the one console command this client has, and stock `/reload`
 * is nothing but `ConsoleExec("reloadui")` (ChatFrame.lua:2265-2267). `ReloadUI` is looked up at
 * call time because the world mount binds it after the chat install (`installFrameXmlReloadUi`).
 * Every other command tells the player the console does not exist here. A page without that binding
 * (framexml.html) reaches the stub floor's silent `ReloadUI`, which is also a function.
 */
const CONSOLE_EXEC_SOURCE = `
ConsoleExec = function(command)
  local wanted = type(command) == "string" and string.lower(string.match(command, "^%s*(.-)%s*$")) or ""
  if wanted == "reloadui" and type(ReloadUI) == "function" then
    ReloadUI()
    return
  end
  __webclientConsoleUnavailable(command)
end
`;

/* ---------------------------------------------------------------------------------------------
 * This client's own commands, mirrored into stock SlashCmdList
 * ------------------------------------------------------------------------------------------- */

/** The shape `Chat.nativeSlashCommands()` answers. */
export interface FrameXmlNativeCommand {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly usage: string;
  readonly help: string;
}

export interface FrameXmlNativeSlashDeps {
  readonly commands: () => readonly FrameXmlNativeCommand[];
  /** The `EmotesText.dbc` table, which arrives after login; stock covers all but a few rows. */
  readonly emotes: () => EmoteData | undefined;
  /** `Chat.runNativeCommand`: false when nothing answered. */
  readonly run: (name: string, rest: string) => boolean;
  readonly onCommandsChanged?: (listener: () => void) => () => void;
  readonly notice: (text: string) => void;
}

export interface FrameXmlNativeSlashInstall {
  /** Native command names that currently have at least one stock-free spelling registered. */
  registered(): readonly string[];
  /** Server emote names registered because no `EMOTE*_CMD` spells them. */
  registeredEmotes(): readonly string[];
  /** Rebuild now if the module table or the emote table changed since the last build. */
  sync(): void;
  dispose(): void;
}

/**
 * Registers the native commands no stock spelling claims, the native `/who`, and the `/help` tail.
 *
 * The claim set is read from the loaded corpus itself — every `SLASH_<key><n>` of `SlashCmdList`
 * and `ChatTypeInfo`, every `EMOTE<i>_CMD<j>` up to stock's `MAXEMOTEINDEX` (452, a local at
 * `ChatFrame.lua:613`), and whatever the global `IsSecureCmd` accepts (the secure command table is
 * a local at `ChatFrame.lua:964`) — so a localisation that adds a spelling takes it away from the
 * mirror rather than being shadowed by it. A rebuild drops the previous `WEBCLIENT_*` rows and
 * empties `hash_SlashCmdList`, the cache `ChatEdit_ParseText` would otherwise answer from.
 */
export function installFrameXmlNativeSlash(
  vm: Pick<GlueLuaVm, "registerGlobal" | "execute" | "globalFunction" | "call" | "release">,
  deps: FrameXmlNativeSlashDeps,
): FrameXmlNativeSlashInstall | undefined {
  let registered: string[] = [];
  let registeredEmotes: string[] = [];
  let dirty = true;
  let builtEmotes: EmoteData | undefined;
  let disposed = false;

  vm.registerGlobal("__webclientSlash", (args) => {
    const name = text(args[0]);
    const rest = text(args[1]);
    // A native command that throws must not abort `ChatEdit_ParseText` half-way: the stock parser
    // closes and clears the edit box only after the handler returns, and a raised error left the
    // typed line in an open box that every following Enter re-sent.
    try {
      if (!deps.run(name, rest)) deps.notice(`Команда /${name} сейчас недоступна.`);
    } catch (error) {
      console.error(`[chat] /${name} failed`, error);
      deps.notice(`Команда /${name} не выполнена: ${error instanceof Error ? error.message : String(error)}`);
    }
    return [];
  });
  vm.registerGlobal("__webclientSlashSync", () => {
    sync();
    return [];
  });
  vm.registerGlobal("__webclientSlashHelp", () => helpLines());
  const loaded = vm.execute(NATIVE_SLASH_SOURCE, "@webclient/chat-api:slash");
  if (!loaded.ok) return undefined;
  const installRef: GlueLuaRef | undefined = vm.globalFunction("__webclientInstallSlash");
  if (!installRef) return undefined;

  function build(): void {
    if (disposed) return;
    const commands = deps.commands();
    const emotes = deps.emotes();
    const nativeNames = new Set(commands.map((command) => command.name));
    const rows = [
      ...commands.map((command) => ({
        name: command.name, slashes: command.aliases.map((alias) => `/${alias}`),
      })),
      ...(emotes?.emotes ?? []).filter((entry) => !nativeNames.has(entry.command))
        .map((entry) => ({ name: entry.command, slashes: [`/${entry.command}`] })),
    ].map((row, index) => ({
      ...row, key: `WEBCLIENT_${index + 1}_${row.name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`,
    }));
    const [answer] = vm.call(installRef as GlueLuaRef, [rows], 1);
    const names = typeof answer === "string" && answer ? answer.split("\n") : [];
    registered = names.filter((name) => nativeNames.has(name));
    registeredEmotes = names.filter((name) => !nativeNames.has(name));
    builtEmotes = emotes;
    dirty = false;
  }

  function sync(): void {
    if (dirty || deps.emotes() !== builtEmotes) build();
  }

  function helpLines(): string[] {
    const commands = deps.commands();
    const byName = new Map(commands.map((command) => [command.name, command]));
    const lines = registered.flatMap((name) => {
      const command = byName.get(name);
      return command ? [`${command.usage} — ${command.help}`] : [];
    });
    if (registeredEmotes.length > 0) {
      lines.push(`Эмоции сервера: ${registeredEmotes.map((name) => `/${name}`).join(" ")}`);
    }
    if (lines.length === 0) return [];
    // A stock FontString reads `|` as an escape (`|n` is a line break, which is how
    // «/vehicle enter|leave|next» used to break in two); the original client writes a literal pipe
    // as `||`.
    return ["Команды WebClient:", ...lines].map((line) => line.replaceAll("|", "||"));
  }

  const unsubscribe = deps.onCommandsChanged?.(() => { dirty = true; });
  build();
  return {
    registered: () => registered,
    registeredEmotes: () => registeredEmotes,
    sync,
    dispose() {
      disposed = true;
      unsubscribe?.();
      vm.release(installRef);
    },
  };
}

const NATIVE_SLASH_SOURCE = `
do
  local MAX_EMOTE_INDEX = 452
  local PREFIX = "WEBCLIENT_"
  local upper, sub, concat = string.upper, string.sub, table.concat
  local rawget, rawset, pairs, type = rawget, rawset, pairs, type
  -- ChatFrame.lua's own SlashCmdList.WHO, kept from the first install (false: there was none).
  local stockWho

  local function claim(set, key)
    local index = 1
    local slash = rawget(_G, "SLASH_" .. key .. index)
    while slash ~= nil do
      if type(slash) == "string" then set[upper(slash)] = true end
      index = index + 1
      slash = rawget(_G, "SLASH_" .. key .. index)
    end
  end

  local function claimed()
    local set = {}
    for key in pairs(SlashCmdList) do
      if type(key) == "string" and sub(key, 1, #PREFIX) ~= PREFIX then claim(set, key) end
    end
    if type(ChatTypeInfo) == "table" then
      for key in pairs(ChatTypeInfo) do if type(key) == "string" then claim(set, key) end end
    end
    for index = 1, MAX_EMOTE_INDEX do
      local variant = 1
      local slash = rawget(_G, "EMOTE" .. index .. "_CMD" .. variant)
      while slash ~= nil do
        if type(slash) == "string" then set[upper(slash)] = true end
        variant = variant + 1
        slash = rawget(_G, "EMOTE" .. index .. "_CMD" .. variant)
      end
    end
    return set
  end

  local function drop()
    local keys = {}
    for key in pairs(SlashCmdList) do
      if type(key) == "string" and sub(key, 1, #PREFIX) == PREFIX then keys[#keys + 1] = key end
    end
    for _, key in pairs(keys) do
      SlashCmdList[key] = nil
      local index = 1
      while rawget(_G, "SLASH_" .. key .. index) ~= nil do
        rawset(_G, "SLASH_" .. key .. index, nil)
        index = index + 1
      end
    end
  end

  function __webclientInstallSlash(rows)
    if type(SlashCmdList) ~= "table" then return "" end
    drop()
    local taken = claimed()
    local installed = {}
    for index = 1, #rows do
      local row = rows[index]
      local count = 0
      for alias = 1, #row.slashes do
        local slash = row.slashes[alias]
        local spelled = upper(slash)
        -- SecureCmdList is a local of ChatFrame.lua (:964); its global IsSecureCmd is the only
        -- way to ask whether /cast, /target, /stopattack … are taken.
        if not taken[spelled] and not (type(IsSecureCmd) == "function" and IsSecureCmd(slash)) then
          count = count + 1
          rawset(_G, "SLASH_" .. row.key .. count, slash)
          taken[spelled] = true
        end
      end
      if count > 0 then
        local name = row.name
        SlashCmdList[row.key] = function(msg) __webclientSlash(name, msg or "") end
        installed[#installed + 1] = name
      end
    end
    -- Stock /who fills WhoFrameEditBox (FriendsFrame.xml's who tab) and calls SendWho; a bare
    -- /who also runs ShowWhoPanel (chatframe.lua:1944-1951). Only a TOC without FriendsFrame.xml
    -- lacks the box, and there the stock body raised on every /who (chatframe.lua:1949), so the
    -- native who panel answers instead. Once the box exists the stock body is put back.
    if stockWho == nil then stockWho = SlashCmdList["WHO"] or false end
    if WhoFrameEditBox then
      if stockWho then SlashCmdList["WHO"] = stockWho end
    else
      SlashCmdList["WHO"] = function(msg) __webclientSlash("who", msg or "") end
    end
    hash_SlashCmdList = {}
    return concat(installed, "\\n")
  end

  if type(ChatEdit_ParseText) == "function" then
    local parse = ChatEdit_ParseText
    ChatEdit_ParseText = function(editBox, send, ...)
      if send == 1 then __webclientSlashSync() end
      return parse(editBox, send, ...)
    end
  end

  if type(hooksecurefunc) == "function" and type(ChatFrame_DisplayHelpText) == "function" then
    hooksecurefunc("ChatFrame_DisplayHelpText", function(frame)
      if not frame then return end
      local info = type(ChatTypeInfo) == "table" and ChatTypeInfo["SYSTEM"] or nil
      local lines = { __webclientSlashHelp() }
      for index = 1, #lines do
        if info then
          frame:AddMessage(lines[index], info.r, info.g, info.b, info.id)
        else
          frame:AddMessage(lines[index])
        end
      end
    end)
  end
end
`;

/* ---------------------------------------------------------------------------------------------
 * The keyboard owner and the composition the world mount calls
 * ------------------------------------------------------------------------------------------- */

/** What the stock chat install needs from the mounted FrameXML. */
export interface FrameXmlStockChatHost {
  readonly vm: Pick<GlueLuaVm, "registerGlobal" | "execute" | "globalFunction" | "call" | "release">;
  readonly bridge: {
    getFrame(name: string): FrameXmlFrame | undefined;
    runInMutationBatch<T>(operation: () => T): T;
    isVisible(frame: FrameXmlFrame): boolean;
    dispatchEvent(event: string, ...args: readonly unknown[]): number;
    AddMessage(frame: FrameXmlFrame, text: unknown, r?: number, g?: number, b?: number): boolean;
  };
  /** The rendered `<input>` of an EditBox, from the DOM renderer. */
  readonly inputFor: (frame: FrameXmlFrame) => HTMLInputElement | undefined;
  /** The next animation frame; injectable for tests. */
  readonly schedule?: (callback: () => void) => void;
}

/** One combat line as `ChatDock.recordCombatEntry` records it. */
export interface FrameXmlCombatLine {
  readonly text: string;
  readonly kind: string;
}

export interface FrameXmlStockChatDeps extends FrameXmlChatApiDeps, FrameXmlNativeSlashDeps {
  /** `ChatDock.onCombatEntry`, for the interim combat window. */
  readonly onCombatEntry?: (listener: (entry: FrameXmlCombatLine) => void) => () => void;
  /** `ChatDock.combatHistory`: what the native combat tab already held when the stock chat took over. */
  readonly combatHistory?: () => readonly FrameXmlCombatLine[];
  /**
   * Whether the seam reports chat window 2 as shown or docked. The native combat tab is hidden
   * with `#chat-log`; its lines go to `ChatFrame2` only while the seam gives that window a tab,
   * because `FloatingChatFrame_Update` re-applies `GetChatWindowInfo(2)` on every
   * `UPDATE_CHAT_WINDOWS` and would hide a window forced open from here.
   */
  readonly combatWindowEnabled?: () => boolean;
}

/** `#chat-log .combat-line` colours from `style.css`, so the stock window reads the same. */
const COMBAT_COLOURS: Readonly<Record<string, readonly [number, number, number]>> = {
  taken: [0xe0 / 255, 0x8a / 255, 0x7a / 255],
  crit: [0xff / 255, 0xd7 / 255, 0x6a / 255],
  avoided: [0x9f / 255, 0xb0 / 255, 0xc4 / 255],
  reward: [0x9a / 255, 0xd1 / 255, 0x7a / 255],
  muted: [0x9b / 255, 0x91 / 255, 0x7a / 255],
};
const COMBAT_DEFAULT: readonly [number, number, number] = [0xd8 / 255, 0xcb / 255, 0xa6 / 255];

const OPEN_CHAT_SOURCE = `
function __webclientOpenChat(text)
  return ChatFrame_OpenChat(text or "")
end
function __webclientInsertChatLink(text)
  if ChatEdit_InsertLink(text) then return ChatEdit_GetActiveWindow() or true end
  ChatFrame_OpenChat(text)
  return ChatEdit_GetActiveWindow()
end
function __webclientReplyTell()
  ChatFrame_ReplyTell()
  return ChatEdit_GetActiveWindow()
end
`;

/**
 * The macro half of the stock chat (FrameXmlChatApi.ts `installFrameXmlStockChat`):
 *
 * - `__webclientMacroSay(text)`: a macro's line without `/`, said in SAY as the client's MacroEditBox
 *   says it, whatever type the chat box sticks to.
 * - `__webclientMacroOptionText(word)`: ERR_UNKNOWN_MACRO_OPTION_S for a word the client does not know.
 * - `__webclientInstallItemParse()` / `__webclientRestoreItemParse()`: this client's IDs in stock
 *   `/cast` and `/use`. Their one body (ChatFrame.lua:1029-1040, a local of ChatFrame.lua like the
 *   hash that dispatches it) reads a bare number through the global `SecureCmdItemParse` as an
 *   inventory slot. The wrapper keeps that for a bag slot, an equipment slot (0–19) and a slot that
 *   holds an item; any other bare number is handed back as the action itself, so the body asks
 *   `GetItemInfo` — an item the client knows is used (`UseItemByName`), anything else is cast
 *   (`CastSpellByName`) — and both reach this client's `/use` and `/cast`, which read IDs.
 */
const MACRO_SOURCE = `
function __webclientMacroSay(text)
  SendChatMessage(text, "SAY")
end
function __webclientMacroOptionText(word)
  return format(ERR_UNKNOWN_MACRO_OPTION_S or "%s", tostring(word))
end
function __webclientInstallItemParse()
  local stock = SecureCmdItemParse
  if type(stock) ~= "function" or __webclientStockItemParse then return false end
  local lastEquipped = INVSLOT_LAST_EQUIPPED or 19
  __webclientStockItemParse = stock
  __webclientItemParse = function(item)
    local name, bag, slot = stock(item)
    local id = not bag and not name and tonumber(slot)
    if id and id > lastEquipped then return slot, nil, nil end
    return name, bag, slot
  end
  SecureCmdItemParse = __webclientItemParse
  return true
end
function __webclientRestoreItemParse()
  if __webclientStockItemParse and SecureCmdItemParse == __webclientItemParse then
    SecureCmdItemParse = __webclientStockItemParse
  end
  __webclientStockItemParse, __webclientItemParse = nil, nil
end
`;


/**
 * Makes the stock chat the one the keys reach, or answers undefined and changes nothing.
 *
 * The gate is concrete: `ChatFrame1EditBox` exists as an EditBox with a rendered `<input>`, and the
 * stock functions the owner calls — `ChatFrame_OpenChat`, `ChatEdit_InsertLink`,
 * `ChatFrame_ReplyTell`, `ChatEdit_GetActiveWindow`, `ChatEdit_ParseText` — are functions in the
 * VM. Only then are the C-API, the command mirror and the owner installed, and `onFailure` is what
 * the owner calls if a later open fails, so the mount can show the native form again.
 */
export function installFrameXmlStockChat(
  host: FrameXmlStockChatHost,
  deps: FrameXmlStockChatDeps,
  onFailure: () => void,
): (() => void) | undefined {
  const { vm, bridge } = host;
  const editBox = bridge.getFrame("ChatFrame1EditBox");
  if (!editBox || editBox.type !== "EditBox" || !host.inputFor(editBox)) return undefined;
  for (const name of [
    "ChatFrame_OpenChat", "ChatEdit_InsertLink", "ChatFrame_ReplyTell", "ChatEdit_GetActiveWindow",
    "ChatEdit_ParseText",
  ]) {
    const ref = vm.globalFunction(name);
    if (!ref) return undefined;
    vm.release(ref);
  }
  if (!vm.execute(OPEN_CHAT_SOURCE, "@webclient/chat-api:owner").ok) return undefined;
  const openRef = vm.globalFunction("__webclientOpenChat");
  const insertRef = vm.globalFunction("__webclientInsertChatLink");
  const replyRef = vm.globalFunction("__webclientReplyTell");
  if (!openRef || !insertRef || !replyRef) return undefined;

  const api = installFrameXmlChatApi(vm, {
    ...deps,
    dispatchEvent: deps.dispatchEvent ?? ((event, ...args) => {
      bridge.runInMutationBatch(() => bridge.dispatchEvent(event, ...args));
    }),
  });
  const slash = installFrameXmlNativeSlash(vm, deps);
  // Macros (macro/MacroRunner.ts), and this client's IDs in stock /cast and /use (MACRO_SOURCE).
  const macroLoaded = vm.execute(MACRO_SOURCE, "@webclient/chat-api:macro").ok;
  const sayRef = macroLoaded ? vm.globalFunction("__webclientMacroSay") : undefined;
  const errorTextRef = macroLoaded ? vm.globalFunction("__webclientMacroOptionText") : undefined;
  const restoreItemParseRef = macroLoaded ? vm.globalFunction("__webclientRestoreItemParse") : undefined;
  const installItemParseRef = macroLoaded ? vm.globalFunction("__webclientInstallItemParse") : undefined;
  if (installItemParseRef) {
    bridge.runInMutationBatch(() => vm.call(installItemParseRef, [], 1));
    vm.release(installItemParseRef);
  }
  // A line runs as in the client: a slash line through EXECUTE_CHAT_LINE to stock MacroEditBox and
  // ChatEdit_ParseText (ChatFrame.lua:2461-2482), a line without / said in SAY — the client's
  // MacroEditBox, never the chat box's sticky type. Only once SecureCmdOptionParse has a context to
  // evaluate conditions against: until then the native commands, which evaluate their own, keep the
  // lines. `/click` reaches this UI's named frames.
  const macroEditBox = bridge.getFrame("MacroEditBox");
  const evaluatesConditions = deps.macroContext?.() !== undefined;
  const stopMacroLines = evaluatesConditions && macroEditBox?.registeredEvents.has("EXECUTE_CHAT_LINE")
    ? installMacroLineExecutor((line) => {
      if (line.startsWith("/")) bridge.runInMutationBatch(() => bridge.dispatchEvent("EXECUTE_CHAT_LINE", line));
      else if (sayRef) bridge.runInMutationBatch(() => vm.call(sayRef, [line], 0));
    })
    : undefined;
  const stopClickFrames = installMacroClickFrames((name) => bridge.getFrame(name));
  // ERR_UNKNOWN_MACRO_OPTION_S goes where the client's ERR_* lines go: UIErrorsFrame's UI_ERROR_MESSAGE.
  const stopOptionErrors = errorTextRef ? installMacroOptionErrorSink((word) => {
    const [message] = bridge.runInMutationBatch(() => vm.call(errorTextRef, [word], 1));
    if (typeof message === "string" && message) {
      bridge.runInMutationBatch(() => bridge.dispatchEvent("UI_ERROR_MESSAGE", message));
    }
  }) : undefined;
  const schedule = host.schedule ?? ((callback: () => void) => {
    if (typeof window.requestAnimationFrame === "function") window.requestAnimationFrame(() => callback());
    else setTimeout(callback, 16);
  });

  /**
   * Keyboard focus follows the Lua edit box. `EditBox:SetFocus()` already focuses the rendered
   * input when the renderer syncs, but the text `ChatFrame_OpenChat` passes is applied by
   * `ChatEdit_OnUpdate` on the *next* OnUpdate — so the caret is put at its end again after the
   * next two frames, and only while the box is still shown (Escape may have closed it).
   */
  const focusSoon = (frame: FrameXmlFrame): void => {
    const focus = (): void => {
      if (!bridge.isVisible(frame)) return;
      const input = host.inputFor(frame);
      if (!input) return;
      if (input.ownerDocument?.activeElement !== input) input.focus();
      const end = input.value.length;
      input.setSelectionRange?.(end, end);
    };
    focus();
    schedule(() => { focus(); schedule(focus); });
  };
  const edited = (answer: readonly unknown[], required: boolean): void => {
    const frame = answer[0];
    if (frame && typeof frame === "object" && "type" in frame) {
      focusSoon(frame as FrameXmlFrame);
      return;
    }
    // `vm.call` answers nothing only when the Lua raised; the error already went to the corpus'
    // handler, and throwing hands this press — and the chat keys — back to the native input.
    if (required) throw new Error("ChatFrame_OpenChat answered no edit box");
  };
  const owner: ChatInputOwner = {
    openChat(value) {
      edited(bridge.runInMutationBatch(() => vm.call(openRef, [value ?? ""], 1)), true);
    },
    insertLink(value) {
      const answer = bridge.runInMutationBatch(() => vm.call(insertRef, [value], 1));
      // `true` with no chat box open: stock `ChatEdit_InsertLink` (ChatFrame.lua:3496-3526) sent the
      // link to a visible Auction House `BrowseName` or `MacroFrameText` instead, as the original
      // client does. That is a handled link, not a failed owner — treating it as one uninstalled the
      // stock chat, brought the native form back over ChatFrame1 and typed the link there as well.
      if (answer[0] === true) return;
      edited(answer, true);
    },
    reply() {
      // No last tell is not a failure: stock answers nothing, as the original client does.
      edited(bridge.runInMutationBatch(() => vm.call(replyRef, [], 1)), false);
    },
  };
  const releaseOwner = installChatInputOwner(owner, onFailure);

  // The interim combat window: native combat lines, batched to one mutation per frame.
  const pending: FrameXmlCombatLine[] = [];
  let flushQueued = false;
  const flush = (): void => {
    flushQueued = false;
    const frame = bridge.getFrame("ChatFrame2");
    const lines = pending.splice(0, pending.length);
    if (!frame || lines.length === 0 || deps.combatWindowEnabled?.() !== true) return;
    bridge.runInMutationBatch(() => {
      for (const line of lines) {
        const [r, g, b] = COMBAT_COLOURS[line.kind] ?? COMBAT_DEFAULT;
        bridge.AddMessage(frame, line.text.replaceAll("|", "||"), r, g, b);
      }
    });
  };
  const queue = (entry: FrameXmlCombatLine): void => {
    if (deps.combatWindowEnabled?.() !== true) return;
    pending.push({ text: entry.text, kind: entry.kind });
    if (pending.length > 200) pending.splice(0, pending.length - 200);
    if (flushQueued) return;
    flushQueued = true;
    schedule(flush);
  };
  const stopCombat = deps.onCombatEntry?.(queue);
  // The newest lines the native tab already held, bounded as the chat replay is (128).
  if (stopCombat) for (const entry of deps.combatHistory?.().slice(-128) ?? []) queue(entry);

  // The typed text starts right after «Сказать:» through stock alone: ChatEdit_UpdateHeader ends
  // with `SetTextInsets(15 + header:GetWidth(), 13, 0, 0)` (ChatFrame.lua:3627), which writes the
  // frame model the renderer pads the <input> with; an EditBox is LEFT-justified; and the header's
  // GetWidth answers the new text before it is painted. A ChatEdit_UpdateHeader post-hook here used
  // to write the same insets while SetTextInsets was a stub. Measured with and without it on the
  // index.html route at 1920×919: «Сказать:» 63.95/13 and «Шепнуть Bob:» 91.45/13, LEFT, the typed
  // text's first pixel on the header's right edge (108.83 vs 108.84 px, 141.74 vs 141.74 px), and
  // screenshots equal within 1/255 (background dithering right of the text); the MPQ corpus in Node
  // agreed. So it was removed.
  let released = false;

  return () => {
    if (released) return;
    released = true;
    releaseOwner();
    stopCombat?.();
    pending.length = 0;
    stopMacroLines?.();
    stopClickFrames();
    stopOptionErrors?.();
    if (restoreItemParseRef) bridge.runInMutationBatch(() => vm.call(restoreItemParseRef, [], 0));
    api.dispose();
    slash?.dispose();
    for (const ref of [openRef, insertRef, replyRef]) vm.release(ref);
    for (const ref of [sayRef, errorTextRef, restoreItemParseRef]) if (ref) vm.release(ref);
  };
}
