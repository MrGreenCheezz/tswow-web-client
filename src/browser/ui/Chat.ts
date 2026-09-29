/**
 * The chat box: what the player types, and what the client does about it.
 *
 * The lines themselves are drawn by `ChatDock.ts` and worded by `ChatFormat.ts`; this file is the
 * input. It was a flat chain of twenty-five `if (command === …)` branches with nine of them named
 * in the placeholder and no `/help` at all, so the guild, auction and channel commands existed and
 * were unreachable unless the player had read the source. The chain is now a table, and `/help` is
 * generated from it, which is the only arrangement where the two cannot disagree.
 */

import {
  CHAT_MSG_CHANNEL, CHAT_MSG_EMOTE, CHAT_MSG_GUILD, CHAT_MSG_OFFICER, CHAT_MSG_PARTY, CHAT_MSG_RAID,
  CHAT_MSG_SAY, CHAT_MSG_SYSTEM, CHAT_MSG_WHISPER, CHAT_MSG_YELL, type ChatMessage,
  useLearnedRaceLanguages,
} from "../../world/ChatProtocol.js";
import { raceBaseLanguage } from "./UnitSnapshot.js";
import { emoteStandState, findEmote } from "../../world/EmoteRules.js";
import type { WorldClient } from "../../world/WorldClient.js";
import { game } from "../game/Context.js";
import { appendChatMessage, selectChatTabByName } from "./ChatDock.js";
import { toggleCalendar } from "./Calendar.js";
import { toggleBarberShop } from "./BarberShop.js";
import { toggleChannelRoster } from "./ChannelRoster.js";
import { openGuildWindow } from "./Guild.js";
import { openGuildBank } from "./GuildBank.js";
import { startReadyCheck } from "./ReadyCheck.js";
import { toggleScoreboard } from "./Scoreboard.js";
import { toggleArenaWindow } from "./ArenaWindow.js";
import { openSocialPanel } from "./SocialPanel.js";
import { toggleMacroWindow } from "./Macros.js";
import { toggleSettingsWindow } from "./Settings.js";
import { CHAT_MAX_BYTES, chatByteLength, truncateChat } from "./ChatLink.js";
import { toggleLfgWindow } from "./Social.js";
import { runCastCommand, runUseCommand } from "./CombatCommands.js";

export const CHAT_COMMANDS: Record<string, number> = {
  s: CHAT_MSG_SAY, say: CHAT_MSG_SAY,
  y: CHAT_MSG_YELL, yell: CHAT_MSG_YELL,
  p: CHAT_MSG_PARTY, party: CHAT_MSG_PARTY,
  g: CHAT_MSG_GUILD, guild: CHAT_MSG_GUILD,
  o: CHAT_MSG_OFFICER, officer: CHAT_MSG_OFFICER,
  raid: CHAT_MSG_RAID,
  e: CHAT_MSG_EMOTE, em: CHAT_MSG_EMOTE, emote: CHAT_MSG_EMOTE, me: CHAT_MSG_EMOTE,
};

// Every outbound line this client writes takes its racial language from `languageForRace`, which
// knows only the stock ten races until it is handed the dataset's `ChrRaces.BaseLanguage`. The
// lookup reads the learned table live, so registering it before `/dbc/character-creation` has
// answered is fine: until then it answers undefined and the compiled split stands.
useLearnedRaceLanguages(raceBaseLanguage);

/**
 * A line the client wrote itself.
 *
 * Recorded in the world client's backlog rather than only appended to the DOM: the log is rebuilt
 * from that backlog every time a name reply arrives, so a line that lived only on screen was wiped
 * a second or two after it was written — which is every answer this client ever gives.
 *
 * `markup: true` is for text somebody wrote as WoW markup on purpose — an add-on's Lua `print`,
 * which the real client hands to `DEFAULT_CHAT_FRAME:AddMessage` as it is, so its `|cff…` colours
 * and `|n` breaks must survive. Without it the line is prose and the stock chat shows its pipes
 * as written (`ChatMessage.local`).
 */
export function systemLine(text: string, options?: { readonly markup?: boolean }): void {
  const message: ChatMessage = {
    type: CHAT_MSG_SYSTEM, language: 0, senderGuid: 0n, senderName: "", receiverGuid: 0n,
    receiverName: "", channel: "", text, tag: 0, achievementId: 0,
  };
  const world = game.world;
  if (world) world.pushLocalMessage(message, options?.markup ? { markup: true } : undefined);
  else appendChatMessage(message);
}

interface SlashCommand {
  readonly names: readonly string[];
  /** What to type, shown by `/help` and quoted back when the arguments are wrong. */
  readonly usage: string;
  readonly help: string;
  run(rest: string, world: WorldClient): void;
}

const COMMANDS: readonly SlashCommand[] = [
  {
    names: ["cast"], usage: "/cast ID", help: "применить изученное заклинание к текущей цели",
    run(rest) { runCastCommand(rest); },
  },
  {
    names: ["use"], usage: "/use ID", help: "использовать предмет из экипировки или сумок",
    run(rest) { runUseCommand(rest); },
  },
  {
    names: ["w", "whisper", "t", "tell"],
    usage: "/w Имя текст",
    help: "личное сообщение",
    run(rest, world) {
      const gap = rest.indexOf(" ");
      if (gap < 0) return usage("/w Имя текст");
      sendChecked(world, CHAT_MSG_WHISPER, rest.slice(gap + 1), rest.slice(0, gap));
    },
  },
  {
    names: ["c", "channel"],
    usage: "/c Канал текст",
    help: "написать в канал",
    run(rest, world) {
      const gap = rest.indexOf(" ");
      if (gap < 0) return usage("/c Канал текст");
      sendChecked(world, CHAT_MSG_CHANNEL, rest.slice(gap + 1), rest.slice(0, gap));
    },
  },
  {
    names: ["join", "j"],
    usage: "/join Канал",
    help: "войти в канал",
    run(rest, world) {
      if (!rest) return usage("/join Канал");
      world.joinChannel(rest);
      systemLine(`Вход в канал ${rest}`);
    },
  },
  {
    names: ["leave"],
    usage: "/leave Канал",
    help: "покинуть канал",
    run(rest, world) {
      if (!rest) return usage("/leave Канал");
      world.leaveChannel(rest);
      systemLine(`Выход из канала ${rest}`);
    },
  },
  {
    names: ["groster", "gr"],
    usage: "/groster",
    help: "состав гильдии",
    run(_rest, world) {
      world.requestGuildRoster();
      world.requestGuildInfo();
    },
  },
  {
    names: ["ginvite"],
    usage: "/ginvite Имя",
    help: "пригласить в гильдию",
    run(rest, world) {
      if (!rest) return usage("/ginvite Имя");
      world.inviteToGuild(rest);
    },
  },
  {
    names: ["gpromote"],
    usage: "/gpromote Имя",
    help: "повысить в гильдии",
    run(rest, world) {
      if (!rest) return usage("/gpromote Имя");
      world.promoteGuildMember(rest);
    },
  },
  {
    names: ["gdemote"],
    usage: "/gdemote Имя",
    help: "понизить в гильдии",
    run(rest, world) {
      if (!rest) return usage("/gdemote Имя");
      world.demoteGuildMember(rest);
    },
  },
  {
    names: ["gkick"],
    usage: "/gkick Имя",
    help: "исключить из гильдии",
    run(rest, world) {
      if (!rest) return usage("/gkick Имя");
      world.removeGuildMember(rest);
    },
  },
  {
    names: ["gmotd"],
    usage: "/gmotd текст",
    help: "объявление гильдии",
    run(rest, world) { world.setGuildMotd(rest); },
  },
  {
    // `/gquit` leaves the guild, as it does in the original client. It used to leave the *group*,
    // which is a different thing to lose by mistyping.
    names: ["gquit", "gleave"],
    usage: "/gquit",
    help: "покинуть гильдию",
    run(_rest, world) {
      world.leaveGuild();
      systemLine("Выход из гильдии");
    },
  },
  {
    names: ["invite", "inv"],
    usage: "/invite Имя",
    help: "пригласить в группу",
    run(rest, world) {
      if (!rest) return usage("/invite Имя");
      world.inviteToGroup(rest);
    },
  },
  {
    names: ["leavegroup", "disband"],
    usage: "/leavegroup",
    help: "покинуть группу",
    run(_rest, world) {
      world.leaveGroup();
      systemLine("Выход из группы");
    },
  },
  {
    names: ["trade"],
    usage: "/trade",
    help: "обмен с целью",
    run(_rest, world) {
      if (world.targetGuid === undefined) return systemLine("Сначала выберите игрока целью");
      world.startTrade(world.targetGuid);
    },
  },
  {
    names: ["auction", "ah"],
    usage: "/ah",
    help: "аукцион у выбранного аукционера",
    run(_rest, world) {
      if (world.targetGuid === undefined) return systemLine("Выберите аукционера целью");
      world.openAuctionHouse(world.targetGuid);
    },
  },
  {
    names: ["mail"],
    usage: "/mail",
    help: "почта у выбранного ящика",
    run(_rest, world) {
      if (world.targetGuid === undefined) return systemLine("Выберите почтовый ящик целью");
      world.openMailbox(world.targetGuid);
    },
  },
  {
    names: ["lfg"],
    usage: "/lfg",
    help: "поиск подземелья",
    run() { toggleLfgWindow(); },
  },
  {
    names: ["who"],
    usage: "/who Имя",
    help: "поиск игроков",
    run(rest, world) {
      openSocialPanel("who");
      if (rest) world.requestWho({ name: rest });
    },
  },
  {
    names: ["whois"],
    usage: "/whois Имя",
    help: "подробности об игроке",
    run(rest, world) {
      if (!rest) return usage("/whois Имя");
      world.requestWhois(rest);
    },
  },
  {
    names: ["friend", "friends"],
    usage: "/friend Имя",
    help: "добавить в друзья или открыть список",
    run(rest, world) {
      if (rest) world.addFriend(rest);
      else openSocialPanel("friends");
    },
  },
  {
    names: ["ignore"],
    usage: "/ignore Имя",
    help: "игнорировать игрока",
    run(rest, world) {
      if (rest) world.addIgnore(rest);
      else openSocialPanel("ignore");
    },
  },
  {
    names: ["readycheck", "rc"],
    usage: "/readycheck",
    help: "проверка готовности группы",
    run() { startReadyCheck(); },
  },
  {
    names: ["calendar"],
    usage: "/calendar",
    help: "календарь",
    run() { toggleCalendar(); },
  },
  {
    names: ["barber"],
    usage: "/barber",
    help: "открыть парикмахерскую (нужно сидеть в кресле)",
    run() { toggleBarberShop(); },
  },
  {
    names: ["score", "bg"],
    usage: "/score",
    help: "таблица боя",
    run() { toggleScoreboard(); },
  },
  {
    names: ["arena"],
    usage: "/arena",
    help: "команды арены",
    run() { toggleArenaWindow(); },
  },
  {
    names: ["gbank"],
    usage: "/gbank",
    help: "банк гильдии у выбранного банкира",
    run() { openGuildBank(); },
  },
  {
    names: ["guildwindow", "gw"],
    usage: "/gw",
    help: "окно гильдии",
    run() { openGuildWindow(); },
  },
  {
    names: ["roll"],
    usage: "/roll [макс]",
    help: "бросить кубик",
    run(rest, world) {
      const maximum = Number(rest) || 100;
      world.rollDice(1, maximum);
    },
  },
  {
    names: ["macro", "m"],
    usage: "/macro",
    help: "окно макросов",
    run() { toggleMacroWindow(); },
  },
  {
    names: ["settings", "config"],
    usage: "/settings",
    help: "настройки",
    run() { toggleSettingsWindow(); },
  },
  {
    names: ["logout", "camp"],
    usage: "/logout",
    help: "выйти из мира",
    run(_rest, world) { world.requestLogout(); },
  },
  {
    names: ["kick"],
    usage: "/kick Канал Имя",
    help: "исключить из канала",
    run(rest, world) {
      const gap = rest.indexOf(" ");
      if (gap < 0) return usage("/kick Канал Имя");
      world.kickChannelMember(rest.slice(0, gap), rest.slice(gap + 1));
    },
  },
  {
    names: ["ban"],
    usage: "/ban Канал Имя",
    help: "забанить в канале",
    run(rest, world) {
      const gap = rest.indexOf(" ");
      if (gap < 0) return usage("/ban Канал Имя");
      world.banChannelMember(rest.slice(0, gap), rest.slice(gap + 1));
    },
  },
  {
    names: ["unban"],
    usage: "/unban Канал Имя",
    help: "разбанить в канале",
    run(rest, world) {
      const gap = rest.indexOf(" ");
      if (gap < 0) return usage("/unban Канал Имя");
      world.unbanChannelMember(rest.slice(0, gap), rest.slice(gap + 1));
    },
  },
  {
    names: ["chaninvite", "cinvite"],
    usage: "/chaninvite Канал Имя",
    help: "пригласить в канал",
    run(rest, world) {
      const gap = rest.indexOf(" ");
      if (gap < 0) return usage("/chaninvite Канал Имя");
      world.inviteChannelMember(rest.slice(0, gap), rest.slice(gap + 1));
    },
  },
  {
    names: ["chanowner"],
    usage: "/chanowner Канал Имя",
    help: "сделать владельцем канала",
    run(rest, world) {
      const gap = rest.indexOf(" ");
      if (gap < 0) return usage("/chanowner Канал Имя");
      world.setChannelOwner(rest.slice(0, gap), rest.slice(gap + 1));
    },
  },
  {
    names: ["chanmod"],
    usage: "/chanmod Канал Имя",
    help: "сделать модератором канала",
    run(rest, world) {
      const gap = rest.indexOf(" ");
      if (gap < 0) return usage("/chanmod Канал Имя");
      world.setChannelModerator(rest.slice(0, gap), rest.slice(gap + 1));
    },
  },
  {
    names: ["chanunmod"],
    usage: "/chanunmod Канал Имя",
    help: "снять модератора канала",
    run(rest, world) {
      const gap = rest.indexOf(" ");
      if (gap < 0) return usage("/chanunmod Канал Имя");
      world.unsetChannelModerator(rest.slice(0, gap), rest.slice(gap + 1));
    },
  },
  {
    names: ["chanmute"],
    usage: "/chanmute Канал Имя",
    help: "заглушить в канале",
    run(rest, world) {
      const gap = rest.indexOf(" ");
      if (gap < 0) return usage("/chanmute Канал Имя");
      world.muteChannelMember(rest.slice(0, gap), rest.slice(gap + 1));
    },
  },
  {
    names: ["chanunmute"],
    usage: "/chanunmute Канал Имя",
    help: "снять заглушку в канале",
    run(rest, world) {
      const gap = rest.indexOf(" ");
      if (gap < 0) return usage("/chanunmute Канал Имя");
      world.unmuteChannelMember(rest.slice(0, gap), rest.slice(gap + 1));
    },
  },
  {
    names: ["chanpass"],
    usage: "/chanpass Канал пароль",
    help: "пароль канала",
    run(rest, world) {
      const gap = rest.indexOf(" ");
      if (gap < 0) return usage("/chanpass Канал пароль");
      world.setChannelPassword(rest.slice(0, gap), rest.slice(gap + 1));
    },
  },
  {
    names: ["chanannounce"],
    usage: "/chanannounce Канал",
    help: "переключить объявления канала",
    run(rest, world) {
      if (!rest) return usage("/chanannounce Канал");
      world.toggleChannelAnnounce(rest);
    },
  },
  {
    names: ["roster"],
    usage: "/roster [Канал]",
    help: "участники канала и модерация",
    run(rest) { toggleChannelRoster(rest || undefined); },
  },
  {
    names: ["chanlist", "channellist"],
    usage: "/chanlist Канал",
    help: "список участников канала",
    run(rest, world) {
      if (!rest) return usage("/chanlist Канал");
      world.requestChannelList(rest);
    },
  },
  {
    names: ["vehicle", "veh"],
    usage: "/vehicle enter|leave|next|prev|eject",
    help: "транспорт: сесть на цель, выйти, сменить место, высадить цель",
    run(rest, world) {
      const action = rest.trim().toLowerCase();
      if (action === "leave") world.leaveVehicle();
      else if (action === "next") world.changeVehicleSeat(true);
      else if (action === "prev") world.changeVehicleSeat(false);
      else if (action === "enter") {
        if (world.targetGuid === undefined) return systemLine("Сначала выберите транспорт целью");
        world.enterPlayerVehicle(world.targetGuid);
      } else if (action === "eject") {
        if (world.targetGuid === undefined) return systemLine("Сначала выберите пассажира целью");
        world.ejectPassenger(world.targetGuid);
      } else return usage("/vehicle enter|leave|next|prev|eject");
    },
  },
  {
    names: ["duel"],
    usage: "/duel",
    help: "вызвать выбранную цель на дуэль",
    run(_rest, world) {
      if (world.targetGuid === undefined) return systemLine("Сначала выберите игрока целью");
      if (!world.challengeDuelToSelection()) systemLine("Нельзя вызвать эту цель на дуэль");
    },
  },
  {
    names: ["share"],
    usage: "/share ID",
    help: "поделиться заданием из журнала с группой",
    run(rest, world) {
      const questId = Number(rest);
      if (!Number.isInteger(questId) || questId <= 0) return usage("/share ID");
      world.shareQuest(questId);
    },
  },
  {
    names: ["tab"],
    usage: "/tab имя",
    help: "переключить вкладку чата",
    run(rest) {
      if (!rest) return usage("/tab имя");
      if (!selectChatTabByName(rest)) systemLine(`Нет вкладки «${rest}»`);
    },
  },
];

function usage(text: string): void {
  systemLine(`Использование: ${text}`);
}

/* ---------------------------------------------------------------------------------------------
 * Commands a module adds
 * ------------------------------------------------------------------------------------------- */

/**
 * One slash command a loaded module owns.
 *
 * A second, dynamic table beside {@link COMMANDS} rather than rows pushed into it, and the order
 * the two are consulted in is the whole point: a module may not take `/w`, `/say` or any of the
 * twenty-eight above, because a definition file that could would be able to make «написать другу»
 * mean something else. {@link addModuleCommand} refuses a taken name and says whose it is. What a
 * module *can* shadow is an emote — the emote list arrives later and is consulted last — and that
 * is the one collision this client cannot check when the module loads.
 */
export interface ModuleCommand {
  readonly module: string;
  /** Without the leading slash and already lowercase, the way `submitChat` compares them. */
  readonly name: string;
  readonly help: string;
  run(rest: string): void;
}

const moduleCommands = new Map<string, ModuleCommand>();
const pendingModuleLoads = new WeakMap<WorldClient, symbol>();
/** Told whenever the module table changes, so a stock `SlashCmdList` mirror can be rebuilt. */
const nativeCommandListeners = new Set<() => void>();

function notifyNativeCommandsChanged(): void {
  for (const listener of [...nativeCommandListeners]) {
    try {
      listener();
    } catch (error) {
      console.warn("[chat] a native command listener failed", error);
    }
  }
}

/**
 * Subscribes to {@link addModuleCommand} and {@link removeModuleCommands}; answers the unsubscribe.
 *
 * The compiled-in tables never change, so the module table is the only thing a mirror of these
 * commands — the stock chat's `SlashCmdList["WEBCLIENT_*"]` rows — can fall behind.
 */
export function onNativeSlashCommandsChanged(listener: () => void): () => void {
  nativeCommandListeners.add(listener);
  return () => { nativeCommandListeners.delete(listener); };
}

/** Marks asynchronous addon startup; an old completion must not clear a newer load. */
export function beginModuleCommandLoad(world: WorldClient): () => void {
  const token = Symbol();
  pendingModuleLoads.set(world, token);
  return () => {
    if (pendingModuleLoads.get(world) === token) pendingModuleLoads.delete(world);
  };
}

/** Adds one, or says why the name cannot be had. */
export function addModuleCommand(command: ModuleCommand): string | undefined {
  const name = command.name.toLowerCase();
  if (!name) return "у команды модуля нет имени";
  if (name === "help" || name === "h" || name === "?") return `/${name} — это справка клиента`;
  if (COMMANDS.some((entry) => entry.names.includes(name))) return `/${name} — уже команда клиента`;
  if (CHAT_COMMANDS[name] !== undefined) return `/${name} — уже канал чата`;
  const taken = moduleCommands.get(name);
  if (taken) return `/${name} уже занята модулем «${taken.module}»`;
  moduleCommands.set(name, { ...command, name });
  notifyNativeCommandsChanged();
  return undefined;
}

/** Drops every command one module added, and answers how many that was. */
export function removeModuleCommands(module: string): number {
  let dropped = 0;
  for (const [name, command] of [...moduleCommands]) {
    if (command.module !== module) continue;
    moduleCommands.delete(name);
    dropped++;
  }
  if (dropped > 0) notifyNativeCommandsChanged();
  return dropped;
}

export function moduleCommandList(): readonly ModuleCommand[] {
  return [...moduleCommands.values()];
}

/** One command the native parser answers, as a stock slash-command mirror needs to see it. */
export interface NativeSlashCommand {
  /** The name {@link runNativeCommand} is called with: the first of `aliases`, lowercase. */
  readonly name: string;
  /** Every spelling without the slash, lowercase, in the order `/help` lists them. */
  readonly aliases: readonly string[];
  readonly usage: string;
  readonly help: string;
}

/**
 * Every command this client's own parser answers: {@link COMMANDS}, the chat-type shortcuts of
 * {@link CHAT_COMMANDS} grouped by the type they send, and whatever modules added.
 *
 * Emotes are not listed: their names are a table that arrives from the gateway after login
 * (`world.emotes`), and a mirror asks that table itself.
 */
export function nativeSlashCommands(): NativeSlashCommand[] {
  const byType = new Map<number, string[]>();
  for (const [name, type] of Object.entries(CHAT_COMMANDS)) {
    const names = byType.get(type) ?? [];
    names.push(name);
    byType.set(type, names);
  }
  return [
    ...COMMANDS.map((command) => ({
      name: command.names[0] as string, aliases: command.names, usage: command.usage, help: command.help,
    })),
    ...[...byType.values()].map((names) => ({
      name: names[0] as string, aliases: names, usage: `/${names[0]} текст`, help: "написать в чат",
    })),
    ...moduleCommandList().map((command) => ({
      name: command.name, aliases: [command.name], usage: `/${command.name}`,
      help: `${command.help} (модуль «${command.module}»)`,
    })),
  ];
}

/** Every command this client answers, built from the tables so they cannot drift apart. */
export function helpLines(): string[] {
  const lines = [
    `Каналы: ${Object.keys(CHAT_COMMANDS).map((name) => `/${name}`).join(" ")}`,
    ...COMMANDS.map((command) => `${command.usage} — ${command.help}`),
    ...moduleCommandList().map((command) => `/${command.name} — ${command.help} (модуль «${command.module}»)`),
  ];
  const emotes = game.world?.emotes;
  if (emotes) {
    lines.push(`Эмоции (${emotes.emotes.length}): /dance /wave /bow /cheer … — полный список из EmotesText.dbc`);
  }
  return lines;
}

/**
 * A text emote, when the command names one.
 *
 * Sit, sleep and kneel need a second packet: the server refuses to broadcast an animation for
 * those three and expects the client to change its own stand state, so sending the emote alone
 * produces a sentence about a character who is still standing up.
 */
function runEmote(command: string, world: WorldClient): boolean {
  const entry = findEmote(world.emotes, command);
  if (!entry) return false;
  world.sendTextEmote(entry.id, world.targetGuid ?? 0n);
  const standState = emoteStandState(entry);
  if (standState !== undefined) world.setStandState(standState);
  return true;
}

/**
 * Runs one slash command through this client's own tables, and answers whether any of them knew it.
 *
 * `command` is without the slash; `rest` is the argument text. Split out of {@link submitChat} so
 * that the stock chat can reach the same commands: `FrameXmlChatApi.ts` registers the ones stock
 * `SlashCmdList` does not claim and calls back here, so `/whois` or a module's command typed into
 * `ChatFrame1EditBox` runs exactly the code it runs from the native input. A false answer means
 * the caller owns the «unknown command» wording.
 */
export function runNativeCommand(command: string, rest: string): boolean {
  const world = game.world;
  if (!world) return false;
  const name = command.toLowerCase();
  const argument = rest.trim();

  if (name === "help" || name === "?" || name === "h") {
    for (const line of helpLines()) systemLine(line);
    return true;
  }

  const entry = COMMANDS.find((candidate) => candidate.names.includes(name));
  if (entry) {
    entry.run(argument, world);
    return true;
  }

  const type = CHAT_COMMANDS[name];
  if (type !== undefined) {
    sendChecked(world, type, argument);
    return true;
  }

  // After the client's own two tables and before the emotes: a module may not shadow a command or
  // a channel, and it may shadow an emote, which is the only one of the three whose list is not
  // known when the module loads.
  const fromModule = moduleCommands.get(name);
  if (fromModule) {
    fromModule.run(argument);
    return true;
  }

  return runEmote(name, world);
}

export function submitChat(raw: string): void {
  const world = game.world;
  const input = raw.trim();
  if (!world || !input) return;

  if (!input.startsWith("/")) return sendChecked(world, CHAT_MSG_SAY, input);

  const space = input.indexOf(" ");
  const command = (space < 0 ? input.slice(1) : input.slice(1, space)).toLowerCase();
  const rest = space < 0 ? "" : input.slice(space + 1).trim();

  if (runNativeCommand(command, rest)) return;
  if (pendingModuleLoads.has(world)) {
    systemLine(`Аддоны ещё загружаются. Повторите /${command} через несколько секунд.`);
    return;
  }
  if (!world.emotes) {
    systemLine(`Неизвестная команда /${command}. Список эмоций ещё не загружен — /help`);
    return;
  }
  systemLine(`Неизвестная команда /${command}. Список команд — /help`);
}

/**
 * Sends a line, or says why it will not go.
 *
 * `HandleMessagechatOpcode` drops anything over 255 **bytes** and answers nothing at all, and the
 * input's `maxlength` counts characters — so in a Russian interface a message the player could
 * type, see accepted and watch disappear was about half the allowed length.
 */
function sendChecked(world: WorldClient, type: number, text: string, target = ""): void {
  if (!text) return;
  const bytes = chatByteLength(text);
  if (bytes > CHAT_MAX_BYTES) {
    systemLine(`Сообщение длиннее ${CHAT_MAX_BYTES} байт (${bytes}); сервер такое не принимает.`);
    systemLine(`Влезает: «${truncateChat(text)}»`);
    return;
  }
  world.sendChat(type, text, target);
}
