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
} from "../../world/ChatProtocol.js";
import { emoteStandState, findEmote } from "../../world/EmoteRules.js";
import type { WorldClient } from "../../world/WorldClient.js";
import { game } from "../game/Context.js";
import { appendChatMessage, selectChatTabByName } from "./ChatDock.js";
import { toggleCalendar } from "./Calendar.js";
import { openGuildWindow } from "./Guild.js";
import { openGuildBank } from "./GuildBank.js";
import { startReadyCheck } from "./ReadyCheck.js";
import { toggleScoreboard } from "./Scoreboard.js";
import { toggleArenaWindow } from "./ArenaWindow.js";
import { openSocialPanel } from "./SocialPanel.js";
import { toggleMacroWindow } from "./Macros.js";
import { toggleSettingsWindow } from "./Settings.js";
import { CHAT_MAX_BYTES, chatByteLength, truncateChat } from "./ChatLink.js";
import { lfgWindow } from "./Dom.js";

export const CHAT_COMMANDS: Record<string, number> = {
  s: CHAT_MSG_SAY, say: CHAT_MSG_SAY,
  y: CHAT_MSG_YELL, yell: CHAT_MSG_YELL,
  p: CHAT_MSG_PARTY, party: CHAT_MSG_PARTY,
  g: CHAT_MSG_GUILD, guild: CHAT_MSG_GUILD,
  o: CHAT_MSG_OFFICER, officer: CHAT_MSG_OFFICER,
  raid: CHAT_MSG_RAID,
  e: CHAT_MSG_EMOTE, em: CHAT_MSG_EMOTE, emote: CHAT_MSG_EMOTE, me: CHAT_MSG_EMOTE,
};

/**
 * A line the client wrote itself.
 *
 * Recorded in the world client's backlog rather than only appended to the DOM: the log is rebuilt
 * from that backlog every time a name reply arrives, so a line that lived only on screen was wiped
 * a second or two after it was written — which is every answer this client ever gives.
 */
export function systemLine(text: string): void {
  const message: ChatMessage = {
    type: CHAT_MSG_SYSTEM, language: 0, senderGuid: 0n, senderName: "", receiverGuid: 0n,
    receiverName: "", channel: "", text, tag: 0, achievementId: 0,
  };
  const world = game.world;
  if (world) world.pushLocalMessage(message);
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
    run() { lfgWindow.hidden = false; },
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
  return dropped;
}

export function moduleCommandList(): readonly ModuleCommand[] {
  return [...moduleCommands.values()];
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

export function submitChat(raw: string): void {
  const world = game.world;
  const input = raw.trim();
  if (!world || !input) return;

  if (!input.startsWith("/")) return sendChecked(world, CHAT_MSG_SAY, input);

  const space = input.indexOf(" ");
  const command = (space < 0 ? input.slice(1) : input.slice(1, space)).toLowerCase();
  const rest = space < 0 ? "" : input.slice(space + 1).trim();

  if (command === "help" || command === "?" || command === "h") {
    for (const line of helpLines()) systemLine(line);
    return;
  }

  const entry = COMMANDS.find((candidate) => candidate.names.includes(command));
  if (entry) return entry.run(rest, world);

  const type = CHAT_COMMANDS[command];
  if (type !== undefined) return sendChecked(world, type, rest);

  // After the client's own two tables and before the emotes: a module may not shadow a command or
  // a channel, and it may shadow an emote, which is the only one of the three whose list is not
  // known when the module loads.
  const fromModule = moduleCommands.get(command);
  if (fromModule) return fromModule.run(rest);

  if (runEmote(command, world)) return;
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
