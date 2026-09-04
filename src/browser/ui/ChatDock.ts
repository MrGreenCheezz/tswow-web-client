/**
 * The chat window: its tabs, its dock, and the nodes a line becomes.
 *
 * Three things changed here at once, and they are one change. A tab is a filter over the backlog,
 * so the pane has to be built from `WorldClient.chatLog` rather than from the nodes already on
 * screen — which is also what makes an unread count possible. A line is built from segments
 * rather than assigned to `textContent`, so an item link can be an anchor with a tooltip on it
 * instead of the raw `|cff…|Hitem:` the player used to read. Combat is another tab in this same
 * dock, so it has history without placing a second log over the world.
 *
 * Everything decided here that can be decided without a document lives in `ChatFormat.ts`,
 * `ChatLink.ts` and `CombatLogModel.ts`, which is why those are the files with tests.
 */

import { CHAT_MSG_CHANNEL, type ChatMessage } from "../../world/ChatProtocol.js";
import { game } from "../game/Context.js";
import { chatClass, chatPrefix, channelTab, DEFAULT_CHAT_TABS, tabMessages, type ChatTab } from "./ChatFormat.js";
import { parseChatMarkup, type ChatSegment } from "./ChatLink.js";
import { type CombatLogEntry, COMBAT_LOG_HISTORY, pushCombatEntry } from "./CombatLogModel.js";
import { chatInput, chatLog, chatTabs } from "./Dom.js";
import { unknownLabel } from "./Format.js";
import { itemTooltipFor } from "./ItemTooltip.js";
import { settingOn } from "./Settings.js";
import { attachTooltip, type TooltipContent } from "./Widgets.js";

/** How many lines one pane holds. The model keeps five hundred; this is what is drawn. */
const PANE_LINES = 200;

const tabs: ChatTab[] = [...DEFAULT_CHAT_TABS];
const unread = new Map<string, number>();
const scrollOffsets = new Map<string, number>();
let activeTabId = tabs[0]?.id ?? "general";

/** The combat log's own history, which is not chat and does not live in the chat backlog. */
const combatEntries: CombatLogEntry[] = [];

/** Entries a link named whose row has not arrived, batched so one busy line is one request. */
const wantedItems = new Set<number>();
let itemFetchQueued = false;

function activeTab(): ChatTab {
  return tabs.find((tab) => tab.id === activeTabId) ?? tabs[0] as ChatTab;
}

const atBottom = (): boolean => chatLog.scrollTop + chatLog.clientHeight >= chatLog.scrollHeight - 8;

/** Everything the dock owns, for a new world. */
export function resetChatDock(): void {
  tabs.splice(0, tabs.length, ...DEFAULT_CHAT_TABS);
  unread.clear();
  scrollOffsets.clear();
  combatEntries.length = 0;
  wantedItems.clear();
  activeTabId = tabs[0]?.id ?? "general";
  chatLog.replaceChildren();
  drawChatTabs();
}

export function drawChatTabs(): void {
  chatTabs.replaceChildren(...tabs.map((tab, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.id = `chat-tab-${index}`;
    button.className = tab.id === activeTabId ? "chat-tab is-active" : "chat-tab";
    button.textContent = tab.title;
    button.dataset["chatTab"] = tab.id;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(tab.id === activeTabId));
    button.setAttribute("aria-controls", "chat-log");
    button.tabIndex = tab.id === activeTabId ? 0 : -1;
    if (tab.id === activeTabId) chatLog.setAttribute("aria-labelledby", button.id);
    const count = unread.get(tab.id) ?? 0;
    if (count > 0 && tab.id !== activeTabId) button.dataset["unread"] = String(count);
    button.addEventListener("click", () => { selectChatTab(tab.id); });
    return button;
  }));
}

/** Standard roving-tab keyboard navigation, including the combat page. */
chatTabs.addEventListener("keydown", (event) => {
  if (!(event.target instanceof HTMLButtonElement)) return;
  const buttons = [...chatTabs.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const current = buttons.indexOf(event.target);
  if (current < 0) return;
  let next: number | undefined;
  if (event.key === "ArrowLeft") next = (current - 1 + buttons.length) % buttons.length;
  else if (event.key === "ArrowRight") next = (current + 1) % buttons.length;
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = buttons.length - 1;
  if (next === undefined) return;
  const id = buttons[next]?.dataset["chatTab"];
  if (!id) return;
  selectChatTab(id);
  [...chatTabs.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    .find((button) => button.dataset["chatTab"] === id)?.focus();
  event.preventDefault();
});

/** Switches by id or by the title the player can see. False when neither names a tab. */
export function selectChatTabByName(name: string): boolean {
  const wanted = name.toLowerCase();
  const tab = tabs.find((candidate) =>
    candidate.id.toLowerCase() === wanted || candidate.title.toLowerCase() === wanted);
  if (!tab) return false;
  selectChatTab(tab.id);
  return true;
}

export function selectChatTab(id: string): void {
  if (id === activeTabId) return;
  scrollOffsets.set(activeTabId, chatLog.scrollTop);
  activeTabId = id;
  unread.delete(id);
  redrawChatLog();
  drawChatTabs();
}

/**
 * A tab per channel, made when the server says the player joined one.
 *
 * Built from `WorldClient.channels` rather than from the join command, because a character is put
 * into General and Trade by the server without ever asking.
 */
export function syncChannelTabs(): void {
  const world = game.world;
  if (!world) return;
  let changed = false;
  for (const name of world.channels.keys()) {
    const tab = channelTab(name);
    if (tabs.some((existing) => existing.id === tab.id)) continue;
    tabs.push(tab);
    changed = true;
  }
  for (let index = tabs.length - 1; index >= 0; index--) {
    const tab = tabs[index] as ChatTab;
    if (tab.channel === undefined || world.channels.has(tab.channel)) continue;
    tabs.splice(index, 1);
    if (tab.id === activeTabId) activeTabId = tabs[0]?.id ?? "general";
    changed = true;
  }
  if (changed) {
    drawChatTabs();
    redrawChatLog();
  }
}

function trimPane(): void {
  while (chatLog.childElementCount > PANE_LINES) chatLog.firstElementChild?.remove();
}

export function appendChatMessage(message: ChatMessage): void {
  for (const tab of tabs) {
    if (tab.id === activeTabId || tab.combat) continue;
    if (matches(message, tab)) unread.set(tab.id, (unread.get(tab.id) ?? 0) + 1);
  }
  const tab = activeTab();
  if (!matches(message, tab)) {
    drawChatTabs();
    return;
  }
  const stick = atBottom();
  chatLog.append(renderChatLine(message));
  trimPane();
  if (stick) chatLog.scrollTop = chatLog.scrollHeight;
  drawChatTabs();
  flushItemRequests();
}

function matches(message: ChatMessage, tab: ChatTab): boolean {
  if (tab.combat) return false;
  if (tab.channel !== undefined) return message.type === CHAT_MSG_CHANNEL && message.channel === tab.channel;
  return tab.types === undefined || tab.types.has(message.type);
}

/**
 * The whole pane, again.
 *
 * Runs on every name reply, which is why nothing a pane knows may live only in its nodes: the tab,
 * the unread counts and the scroll offset are all held above, and are all restored here.
 */
export function redrawChatLog(): void {
  const world = game.world;
  const tab = activeTab();
  const stick = atBottom();
  // The combat ring is fed by the packet handlers directly and does not come out of the chat
  // backlog, so it is drawn before the world is asked about — it has entries either way.
  if (tab.combat) {
    chatLog.replaceChildren(...combatEntries.slice(-PANE_LINES).map(renderCombatLine));
  } else if (!world) {
    chatLog.replaceChildren();
    return;
  } else {
    chatLog.replaceChildren(...tabMessages(world.chatLog, tab, PANE_LINES).map(renderChatLine));
  }
  const remembered = scrollOffsets.get(tab.id);
  chatLog.scrollTop = stick || remembered === undefined ? chatLog.scrollHeight : remembered;
  flushItemRequests();
}

function renderCombatLine(entry: CombatLogEntry): HTMLParagraphElement {
  const line = document.createElement("p");
  line.className = `combat-line ${entry.kind}`;
  line.textContent = entry.text;
  return line;
}

/**
 * One line, as nodes.
 *
 * The prefix — the name, the verb, the channel — is a text node and is never scanned for markup:
 * only the body the sender wrote can contain a link.
 */
export function renderChatLine(message: ChatMessage): HTMLParagraphElement {
  const world = game.world;
  const line = document.createElement("p");
  line.className = chatClass(message.type);
  // The clock is the client's own: no chat packet carries a timestamp, so the moment it arrived
  // is the only time there is.
  if (settingOn("chatTimestamps") && message.at !== undefined) {
    const stamp = document.createElement("span");
    stamp.className = "chat-time";
    const when = new Date(message.at);
    stamp.textContent = `${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")} `;
    line.append(stamp);
  }
  const prefix = chatPrefix(message, (guid) => world?.displayName(guid) ?? "");
  if (prefix) line.append(document.createTextNode(prefix));
  for (const segment of parseChatMarkup(message.text)) line.append(renderSegment(segment));
  return line;
}

function renderSegment(segment: ChatSegment): Node {
  if (segment.kind === "text") return document.createTextNode(segment.text);
  if (segment.kind === "colored" || segment.kind === "url") {
    const span = document.createElement("span");
    span.textContent = segment.text;
    if (segment.color) span.style.color = `#${segment.color.slice(2)}`;
    return span;
  }
  return renderLink(segment);
}

function renderLink(segment: ChatSegment): HTMLAnchorElement {
  const anchor = document.createElement("a");
  anchor.className = "chat-link";
  anchor.href = "#";
  anchor.textContent = `[${segment.text}]`;
  if (segment.color) anchor.style.color = `#${segment.color.slice(2)}`;
  if (segment.rawLink) anchor.dataset["link"] = segment.rawLink;

  if (segment.kind === "item" && segment.id > 0 && !game.itemMetadata?.get(segment.id)) {
    wantedItems.add(segment.id);
  }
  attachTooltip(anchor, () => linkTooltip(segment));
  anchor.addEventListener("click", (event) => {
    event.preventDefault();
    // Shift pastes the link into whatever the player is writing, which is the one thing a link in
    // someone else's message is actually for.
    if (event.shiftKey && segment.rawLink) insertIntoChat(segment.rawLink);
  });
  return anchor;
}

function linkTooltip(segment: ChatSegment): TooltipContent {
  if (segment.kind === "item") {
    return itemTooltipFor(segment.id, { footer: ["Shift + щелчок — вставить в чат"] });
  }
  if (segment.kind === "spell") {
    const spell = game.spells.get(segment.id);
    return {
      title: spell?.name ?? unknownLabel("заклинание", segment.id),
      lines: spell?.rank ? [spell.rank] : undefined,
      footer: ["Shift + щелчок — вставить в чат"],
    };
  }
  const kind = segment.kind === "quest" ? "задание" : "предмет";
  return { title: segment.text || unknownLabel(kind, segment.id), footer: ["Shift + щелчок — вставить в чат"] };
}

/** Puts a link where the caret is, the way the original client does. */
export function insertIntoChat(text: string): void {
  const start = chatInput.selectionStart ?? chatInput.value.length;
  const end = chatInput.selectionEnd ?? start;
  chatInput.value = `${chatInput.value.slice(0, start)}${text}${chatInput.value.slice(end)}`;
  const caret = start + text.length;
  chatInput.setSelectionRange(caret, caret);
  chatInput.focus();
}

/**
 * One request for every item a batch of lines named.
 *
 * Deferred to a microtask because a redraw of two hundred lines would otherwise fire two hundred
 * requests, and the metadata client answers with a boolean rather than an event: when it says
 * something new arrived, the pane is drawn again so the names replace «Предмет 4306».
 */
function flushItemRequests(): void {
  if (itemFetchQueued || wantedItems.size === 0) return;
  itemFetchQueued = true;
  queueMicrotask(() => {
    itemFetchQueued = false;
    const client = game.itemMetadata;
    const entries = [...wantedItems];
    wantedItems.clear();
    if (!client || entries.length === 0) return;
    void client.load(entries)
      .then((changed) => { if (changed && game.itemMetadata === client) redrawChatLog(); })
      .catch(() => { /* the client re-arms its own retry; a link keeps its placeholder name */ });
  });
}

/** One line of combat, kept in the tab's history and drawn if that tab is the one on screen. */
export function recordCombatEntry(entry: CombatLogEntry): void {
  pushCombatEntry(combatEntries, entry);
  const tab = activeTab();
  if (!tab.combat) {
    unread.set("combat", Math.min(COMBAT_LOG_HISTORY, (unread.get("combat") ?? 0) + 1));
    drawChatTabs();
    return;
  }
  const stick = atBottom();
  chatLog.append(renderCombatLine(entry));
  trimPane();
  if (stick) chatLog.scrollTop = chatLog.scrollHeight;
}
