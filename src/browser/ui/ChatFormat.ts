/**
 * What a chat line says, and which tab it belongs on.
 *
 * Split out of `Chat.ts` for two reasons. The first is that `Chat.ts` imports the DOM handles and
 * therefore could not be tested at all, and this is the part worth testing. The second is that the
 * old renderer decided the shape of a line by comparing the type's Russian **label** against string
 * literals — so translating a label silently changed which lines got a name in front of them.
 * Everything here keys on `message.type`.
 */

import {
  CHAT_MSG_ACHIEVEMENT, CHAT_MSG_BATTLEGROUND, CHAT_MSG_BG_SYSTEM_ALLIANCE, CHAT_MSG_BG_SYSTEM_HORDE,
  CHAT_MSG_BG_SYSTEM_NEUTRAL, CHAT_MSG_CHANNEL, CHAT_MSG_EMOTE, CHAT_MSG_GUILD, CHAT_MSG_GUILD_ACHIEVEMENT,
  CHAT_MSG_MONSTER_EMOTE, CHAT_MSG_MONSTER_PARTY, CHAT_MSG_MONSTER_SAY, CHAT_MSG_MONSTER_WHISPER,
  CHAT_MSG_MONSTER_YELL, CHAT_MSG_OFFICER, CHAT_MSG_PARTY, CHAT_MSG_PARTY_LEADER, CHAT_MSG_RAID,
  CHAT_MSG_RAID_BOSS_EMOTE, CHAT_MSG_RAID_BOSS_WHISPER, CHAT_MSG_RAID_LEADER, CHAT_MSG_RAID_WARNING,
  CHAT_MSG_SAY, CHAT_MSG_SYSTEM, CHAT_MSG_TEXT_EMOTE, CHAT_MSG_WHISPER, CHAT_MSG_WHISPER_FOREIGN,
  CHAT_MSG_WHISPER_INFORM, CHAT_MSG_YELL, type ChatMessage, chatTypeLabel,
} from "../../world/ChatProtocol.js";

/** Chat colouring follows the original client's channel colours closely enough to read at a glance. */
export const CHAT_CLASSES: Record<number, string> = {
  [CHAT_MSG_SAY]: "chat-say",
  [CHAT_MSG_MONSTER_SAY]: "chat-say",
  [CHAT_MSG_YELL]: "chat-yell",
  [CHAT_MSG_MONSTER_YELL]: "chat-yell",
  [CHAT_MSG_WHISPER]: "chat-whisper",
  [CHAT_MSG_WHISPER_INFORM]: "chat-whisper",
  [CHAT_MSG_WHISPER_FOREIGN]: "chat-whisper",
  [CHAT_MSG_MONSTER_WHISPER]: "chat-whisper",
  [CHAT_MSG_RAID_BOSS_WHISPER]: "chat-whisper",
  [CHAT_MSG_PARTY]: "chat-party",
  [CHAT_MSG_PARTY_LEADER]: "chat-party",
  [CHAT_MSG_MONSTER_PARTY]: "chat-party",
  [CHAT_MSG_RAID]: "chat-raid",
  [CHAT_MSG_RAID_LEADER]: "chat-raid",
  [CHAT_MSG_RAID_WARNING]: "chat-raid-warning",
  [CHAT_MSG_GUILD]: "chat-guild",
  [CHAT_MSG_OFFICER]: "chat-officer",
  [CHAT_MSG_CHANNEL]: "chat-channel",
  [CHAT_MSG_EMOTE]: "chat-emote",
  [CHAT_MSG_TEXT_EMOTE]: "chat-emote",
  [CHAT_MSG_MONSTER_EMOTE]: "chat-emote",
  [CHAT_MSG_RAID_BOSS_EMOTE]: "chat-emote",
  [CHAT_MSG_SYSTEM]: "chat-system",
  [CHAT_MSG_BG_SYSTEM_NEUTRAL]: "chat-system",
  [CHAT_MSG_BG_SYSTEM_ALLIANCE]: "chat-system",
  [CHAT_MSG_BG_SYSTEM_HORDE]: "chat-system",
  [CHAT_MSG_BATTLEGROUND]: "chat-party",
  [CHAT_MSG_ACHIEVEMENT]: "chat-achievement",
  [CHAT_MSG_GUILD_ACHIEVEMENT]: "chat-achievement",
};

export function chatClass(type: number): string {
  return CHAT_CLASSES[type] ?? "chat-other";
}

/** Types that read as a sentence about the sender rather than as speech: no name, no colon. */
const NARRATED = new Set([CHAT_MSG_EMOTE, CHAT_MSG_MONSTER_EMOTE, CHAT_MSG_RAID_BOSS_EMOTE]);

/** Types whose whole line is already a sentence, sender included. */
const SELF_CONTAINED = new Set([
  CHAT_MSG_SYSTEM, CHAT_MSG_TEXT_EMOTE, CHAT_MSG_BG_SYSTEM_NEUTRAL, CHAT_MSG_BG_SYSTEM_ALLIANCE,
  CHAT_MSG_BG_SYSTEM_HORDE,
]);

/** Types the original client writes without square brackets, as plain speech. */
const SPOKEN = new Set([CHAT_MSG_SAY, CHAT_MSG_MONSTER_SAY, CHAT_MSG_YELL, CHAT_MSG_MONSTER_YELL]);

const WHISPERED = new Set([CHAT_MSG_WHISPER, CHAT_MSG_WHISPER_FOREIGN, CHAT_MSG_MONSTER_WHISPER,
  CHAT_MSG_RAID_BOSS_WHISPER]);

/** Whispers, in both directions — the tab a player watches for someone talking to them. */
export const WHISPER_TYPES: ReadonlySet<number> = new Set([...WHISPERED, CHAT_MSG_WHISPER_INFORM]);

/**
 * Everything in front of the message body: the name, the channel, the verb and the colon.
 *
 * Separate from the body so the body can be scanned for links without the prefix being scanned
 * too — a player called `|Hitem` is not a thing, but a channel named after one would be.
 */
export function chatPrefix(message: ChatMessage, displayName: (guid: bigint) => string): string {
  if (SELF_CONTAINED.has(message.type)) return "";
  const sender = message.senderName || (message.senderGuid === 0n ? "" : displayName(message.senderGuid));
  if (NARRATED.has(message.type)) return sender ? `${sender} ` : "";
  // The echo of a whisper the player sent names the person it went to, not the person who spoke:
  // the server writes the receiver into the sender slot for this one type. Written as an arrow
  // rather than as «Вы шепчете Иван», which is the nominative where Russian wants the dative and
  // there is no declension of a stranger's name to be had here.
  if (message.type === CHAT_MSG_WHISPER_INFORM) return `Вы → ${sender}: `;
  if (message.channel) return `[${message.channel}] ${sender}: `;
  if (SPOKEN.has(message.type)) return `${sender} ${chatTypeLabel(message.type)}: `;
  if (WHISPERED.has(message.type)) return `${sender} ${chatTypeLabel(message.type)}: `;
  return sender ? `[${chatTypeLabel(message.type)}] ${sender}: ` : `[${chatTypeLabel(message.type)}] `;
}

/** The message itself, still carrying the server's markup. */
export function chatBody(message: ChatMessage): string {
  return message.text;
}

/** The whole line as one string. The dock builds nodes instead; this is for bubbles and tests. */
export function chatLine(message: ChatMessage, displayName: (guid: bigint) => string): string {
  return `${chatPrefix(message, displayName)}${chatBody(message)}`;
}

/**
 * One tab of the dock.
 *
 * A tab is a filter over the backlog, not a second copy of it: switching tabs rebuilds the pane
 * from `WorldClient.chatLog`, so nothing a tab was not showing is lost.
 */
export interface ChatTab {
  readonly id: string;
  readonly title: string;
  /** The types this tab shows. Left out, it shows every type. */
  readonly types?: ReadonlySet<number> | undefined;
  /** Set on a tab bound to one joined channel, by the name the server localised. */
  readonly channel?: string | undefined;
  /** Set on the combat tab, which reads the combat ring instead of the chat backlog. */
  readonly combat?: boolean | undefined;
}

/**
 * The tabs a session starts with.
 *
 * «Общий» shows everything on purpose: a tab that hides a type is a tab that loses a message for
 * a player who never looks at the others.
 */
export const DEFAULT_CHAT_TABS: readonly ChatTab[] = [
  { id: "general", title: "Общий" },
  { id: "whisper", title: "Личное", types: WHISPER_TYPES },
  { id: "combat", title: "Бой", combat: true },
];

export function messageMatchesTab(message: ChatMessage, tab: ChatTab): boolean {
  if (tab.combat) return false;
  if (tab.channel !== undefined) {
    return message.type === CHAT_MSG_CHANNEL && message.channel === tab.channel;
  }
  return tab.types === undefined || tab.types.has(message.type);
}

/**
 * The last `limit` messages this tab shows.
 *
 * Filtering runs over the whole backlog and only then takes the tail. Taking the tail first — which
 * is what the old renderer did with its two hundred nodes — meant a quiet tab showed a handful of
 * lines while the model still held five hundred.
 */
export function tabMessages(log: readonly ChatMessage[], tab: ChatTab, limit: number): ChatMessage[] {
  const matching: ChatMessage[] = [];
  for (const message of log) if (messageMatchesTab(message, tab)) matching.push(message);
  return matching.length > limit ? matching.slice(matching.length - limit) : matching;
}

/** A tab for a channel the player has joined, built on the notice that they joined it. */
export function channelTab(channel: string): ChatTab {
  return { id: `channel:${channel.toLowerCase()}`, title: channel, channel };
}
