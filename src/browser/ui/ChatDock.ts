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

import { CHAT_MSG_CHANNEL, CHAT_MSG_WHISPER, type ChatMessage } from "../../world/ChatProtocol.js";
import { game } from "../game/Context.js";
import { chatClass, chatPrefix, channelTab, DEFAULT_CHAT_TABS, tabMessages, type ChatTab } from "./ChatFormat.js";
import { insertChatLink, setNativeChatInputOwner } from "./ChatInputOwner.js";
import { parseChatMarkup, type ChatSegment } from "./ChatLink.js";
import {
  COMBAT_LOG_CATEGORIES, combatLogVisible, type CombatLogCategory, type CombatLogEntry,
  COMBAT_LOG_HISTORY, pushCombatEntry,
} from "./CombatLogModel.js";
import { chatInput, chatLog, chatTabs } from "./Dom.js";
import { unknownLabel } from "./Format.js";
import { itemTooltipFor } from "./ItemTooltip.js";
import { setSetting, settingOn } from "./Settings.js";
import { setTip, attachTooltip, type TooltipContent } from "./Widgets.js";

/** How many lines one pane holds. The model keeps five hundred; this is what is drawn. */
const PANE_LINES = 200;

const tabs: ChatTab[] = [...DEFAULT_CHAT_TABS];
const unread = new Map<string, number>();
const scrollOffsets = new Map<string, number>();
let activeTabId = tabs[0]?.id ?? "general";

/** The combat log's own history, which is not chat and does not live in the chat backlog. */
const combatEntries: CombatLogEntry[] = [];

/** Which combat category each account switch hides. Off by default everywhere, like the log. */
const COMBAT_SETTING: Readonly<Record<CombatLogCategory, string>> = {
  dealt: "combatDealt", taken: "combatTaken", crit: "combatCrit",
  avoided: "combatAvoided", other: "combatOther",
};

/** The categories the player switched off. History keeps everything regardless. */
export function combatHiddenCategories(): Set<CombatLogCategory> {
  const hidden = new Set<CombatLogCategory>();
  for (const { id } of COMBAT_LOG_CATEGORIES) {
    if (!settingOn(COMBAT_SETTING[id])) hidden.add(id);
  }
  return hidden;
}

let combatFilterBar: HTMLElement | undefined;

/**
 * The combat tab's own filter row, built at runtime beside the pane.
 *
 * Runtime-built rather than static markup: `Dom.ts` resolves every id at import and throws on a
 * missing one, and an optional toolbar must never break a page that predates it. Removed whenever
 * the combat tab is not the one on screen.
 */
function syncCombatFilterBar(): void {
  if (!activeTab().combat) {
    combatFilterBar?.remove();
    combatFilterBar = undefined;
    return;
  }
  const hidden = combatHiddenCategories();
  if (!combatFilterBar) {
    combatFilterBar = document.createElement("div");
    combatFilterBar.className = "combat-filters";
    combatFilterBar.setAttribute("role", "toolbar");
    combatFilterBar.setAttribute("aria-label", "Фильтры журнала боя");
    chatLog.parentNode?.insertBefore(combatFilterBar, chatLog);
  }
  combatFilterBar.replaceChildren(...COMBAT_LOG_CATEGORIES.map(({ id, label }) => {
    const box = document.createElement("label");
    box.className = "combat-filter";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = !hidden.has(id);
    input.setAttribute("aria-label", label);
    input.addEventListener("change", () => {
      setSetting(COMBAT_SETTING[id], input.checked);
      redrawChatLog();
    });
    box.append(input, document.createTextNode(label));
    return box;
  }));
}

/** Entries a link named whose row has not arrived, batched so one busy line is one request. */
const wantedItems = new Set<number>();
let itemFetchQueued = false;

function activeTab(): ChatTab {
  return tabs.find((tab) => tab.id === activeTabId) ?? tabs[0] as ChatTab;
}

/** The channel the active tab shows, if it is a channel tab. */
export function activeChannelTab(): string | undefined {
  return activeTab().channel;
}

const atBottom = (): boolean => chatLog.scrollTop + chatLog.clientHeight >= chatLog.scrollHeight - 8;

/** The body class the stock chat sets while it display-owns `#chat-tabs` and `#chat-log`. */
const NATIVE_CHAT_REPLACED_CLASS = "framexml-world-replaces-chat";

/**
 * Whether the stock chat has taken the pane over.
 *
 * While it has, the pane is `display: none` (`FrameXmlWorldMount`'s NATIVE_CHAT_HIDE_SELECTOR):
 * nothing drawn into it can be seen, and every scroll metric read to decide how to draw it forced
 * a layout of whatever the packet had just changed elsewhere on the page — per chat line, per combat
 * line, per name answer. The unmount that hands the pane back redraws it whole from the backlog
 * (`redrawChatLog` in `cleanupPublishedMount`), so skipping the per-line appends meanwhile loses
 * nothing. The tab bar keeps its unread counts either way; the unmount does not redraw it.
 */
function paneReplaced(): boolean {
  return typeof document !== "undefined" && document.body?.classList.contains(NATIVE_CHAT_REPLACED_CLASS) === true;
}

/**
 * Whether the lines appended since the last frame stick to the bottom.
 *
 * Measured at the first append after a frame and kept until that frame: the old per-line pair —
 * read whether the pane was at the bottom, then write the scroll after reading its height — forced
 * two layouts per line, and a busy channel or a combat tab in a raid appends dozens of lines between
 * two frames. The scroll itself is written once, by the frame (`flushPaneScroll`), before the page
 * is painted, so the player sees the same pane at the same moment. Anything the player does to the
 * pane in between (wheel, drag, keys) forgets the decision, so their scroll is never overridden.
 */
let paneStick: boolean | undefined;
let paneScrollQueued = false;

function flushPaneScroll(): void {
  paneScrollQueued = false;
  const stick = paneStick;
  paneStick = undefined;
  if (stick) chatLog.scrollTop = chatLog.scrollHeight;
}

/** Called before a line is appended to the pane: the stick decision, and its scroll next frame. */
function beforePaneAppend(): void {
  paneStick ??= atBottom();
  if (paneScrollQueued) return;
  paneScrollQueued = true;
  const nextFrame = (globalThis as { requestAnimationFrame?: (callback: () => void) => unknown }).requestAnimationFrame;
  if (typeof nextFrame === "function") nextFrame(flushPaneScroll);
  else setTimeout(flushPaneScroll, 0);
}

/** The player took hold of the pane: whatever was decided for the pending lines no longer holds. */
function forgetPaneStick(): void {
  paneStick = undefined;
}

for (const type of ["wheel", "pointerdown", "keydown", "touchstart"] as const) {
  chatLog.addEventListener(type, forgetPaneStick, { passive: true });
}

/**
 * The name-dependent part of every chat line on screen, by message.
 *
 * A name answer used to redraw the whole pane — two hundred lines and two forced layouts — for
 * every player in view, forty at a time. The pane only changes when a line on it reads differently:
 * its sender's name (`chatPrefix`, `whisperTarget`) or an emote sentence `refreshEmoteLines`
 * rewrote. `refreshChatNames` compares exactly that and redraws only when something moved.
 */
const drawnLines = new Map<ChatMessage, string>();

function lineNameSignature(message: ChatMessage): string {
  const world = game.world;
  return `${chatPrefix(message, (guid) => world?.displayName(guid) ?? "")}\u0000${whisperTarget(message) ?? ""}\u0000${message.text}`;
}

function rememberDrawnLine(message: ChatMessage): void {
  drawnLines.set(message, lineNameSignature(message));
  // The pane holds PANE_LINES; the oldest record goes with the oldest line (`trimPane`).
  while (drawnLines.size > PANE_LINES) {
    const oldest = drawnLines.keys().next().value;
    if (oldest === undefined) break;
    drawnLines.delete(oldest);
  }
}

/** Everything the dock owns, for a new world. */
export function resetChatDock(): void {
  tabs.splice(0, tabs.length, ...DEFAULT_CHAT_TABS);
  unread.clear();
  scrollOffsets.clear();
  combatEntries.length = 0;
  combatFilterBar?.remove();
  combatFilterBar = undefined;
  wantedItems.clear();
  drawnLines.clear();
  // A scroll still queued for the old pane has nothing left to scroll; the next line queues its own.
  paneStick = undefined;
  paneScrollQueued = false;
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

/**
 * The unread badges alone, on the buttons already drawn.
 *
 * A line for another tab only moves a count, and rebuilding the whole bar for it — on every chat
 * line and on every combat line of every unit in view — built the same buttons again and again. The
 * attribute written here is the one `drawChatTabs` writes; a bar that no longer matches the tabs
 * (which only a tab change does, and those redraw) is simply drawn again.
 */
function syncChatTabBadges(): void {
  const buttons = [...chatTabs.children] as HTMLElement[];
  if (buttons.length !== tabs.length) {
    drawChatTabs();
    return;
  }
  for (let index = 0; index < tabs.length; index += 1) {
    const tab = tabs[index] as ChatTab;
    const button = buttons[index] as HTMLElement;
    if (button.dataset["chatTab"] !== tab.id) {
      drawChatTabs();
      return;
    }
  }
  for (let index = 0; index < tabs.length; index += 1) {
    const tab = tabs[index] as ChatTab;
    const button = buttons[index] as HTMLElement;
    const count = unread.get(tab.id) ?? 0;
    const badge = count > 0 && tab.id !== activeTabId ? String(count) : undefined;
    if (button.dataset["unread"] === badge) continue;
    if (badge === undefined) delete button.dataset["unread"];
    else button.dataset["unread"] = badge;
  }
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
  // Lines appended since the last frame are scrolled into place first, so the offset remembered
  // for this tab is the one the player was looking at.
  if (paneScrollQueued) flushPaneScroll();
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
  syncChatTabBadges();
  const tab = activeTab();
  // Hidden behind the stock chat, the line would be drawn for nobody; the pane is rebuilt from the
  // backlog when it comes back (`paneReplaced`).
  if (!matches(message, tab) || paneReplaced()) return;
  beforePaneAppend();
  chatLog.append(renderChatLine(message));
  rememberDrawnLine(message);
  trimPane();
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
  // Lines appended since the last frame are not scrolled yet; their pending decision is the pane's.
  const stick = paneStick ?? atBottom();
  paneStick = undefined;
  syncCombatFilterBar();
  drawnLines.clear();
  // The combat ring is fed by the packet handlers directly and does not come out of the chat
  // backlog, so it is drawn before the world is asked about — it has entries either way.
  if (tab.combat) {
    const hidden = combatHiddenCategories();
    chatLog.replaceChildren(...combatEntries
      .filter((entry) => combatLogVisible(entry, hidden)).slice(-PANE_LINES).map(renderCombatLine));
  } else if (!world) {
    chatLog.replaceChildren();
    return;
  } else {
    const messages = tabMessages(world.chatLog, tab, PANE_LINES);
    chatLog.replaceChildren(...messages.map(renderChatLine));
    for (const message of messages) rememberDrawnLine(message);
  }
  const remembered = scrollOffsets.get(tab.id);
  chatLog.scrollTop = stick || remembered === undefined ? chatLog.scrollHeight : remembered;
  flushItemRequests();
}

/**
 * The redraw a name answer asks for, and only when it changes something on screen.
 *
 * Called once a frame however many answers arrived (`EnterWorld`). A line reads differently only
 * when its sender's name, its whisper target or its emote sentence moved (`drawnLines`); when none
 * of the lines on screen did, the pane is already what a redraw would draw. Nothing is drawn while
 * the stock chat owns the pane, and the combat tab names nobody that a later answer could change.
 */
export function refreshChatNames(): void {
  if (!game.world) {
    redrawChatLog();
    return;
  }
  if (paneReplaced() || activeTab().combat) return;
  for (const [message, signature] of drawnLines) {
    if (lineNameSignature(message) !== signature) {
      redrawChatLog();
      return;
    }
  }
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
  if (prefix) line.append(...renderPrefix(message, prefix));
  for (const segment of parseChatMarkup(message.text)) line.append(renderSegment(segment));
  return line;
}

/**
 * The prefix, with the sender's name clickable when it names a player.
 *
 * Clicking inserts `/w Name ` at the caret, which is how the original client answers a whisper
 * with a whisper. Monsters and the player's own echoes are left as text: the server would
 * refuse the whisper, so offering it teaches a broken gesture. Timestamps (`chatTimestamps`)
 * stay out of this either way — `chatPrefix` never includes them.
 */
function renderPrefix(message: ChatMessage, prefix: string): Node[] {
  const target = whisperTarget(message);
  if (!target) return [document.createTextNode(prefix)];
  const at = prefix.lastIndexOf(target);
  if (at < 0) return [document.createTextNode(prefix)];
  const sender = document.createElement("span");
  sender.className = "chat-sender";
  sender.textContent = target;
  setTip(sender, `Написать в личку: /w ${target}`);
  sender.addEventListener("click", () => insertIntoChat(`/w ${target} `));
  return [
    document.createTextNode(prefix.slice(0, at)),
    sender,
    document.createTextNode(prefix.slice(at + target.length)),
  ];
}

/** The name a sender click would whisper to, or undefined when the click must stay text. */
export function whisperTarget(message: ChatMessage): string | undefined {
  const world = game.world;
  const name = message.senderName
    || (message.senderGuid === 0n ? "" : world?.displayName(message.senderGuid) ?? "");
  if (!name || message.senderGuid === world?.state.selfGuid) return undefined;
  // A creature's name resolves the same way a player's does; the whisper would fail
  // server-side, so only players (and guids the client has never seen) stay clickable.
  const object = message.senderGuid === 0n
    ? undefined
    : world?.state.objects.get(message.senderGuid);
  if (object && object.typeId !== 4) return undefined;
  return name;
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

/**
 * Puts a link where the caret is, the way the original client does.
 *
 * Routed through `ChatInputOwner`: while the stock chat owns the keyboard the link goes into
 * `ChatFrame1EditBox` through `ChatEdit_InsertLink`, and the native input below is the fallback.
 */
export function insertIntoChat(text: string): void {
  if (!insertChatLink(text)) insertIntoNativeChat(text);
}

function insertIntoNativeChat(text: string): void {
  const start = chatInput.selectionStart ?? chatInput.value.length;
  const end = chatInput.selectionEnd ?? start;
  chatInput.value = `${chatInput.value.slice(0, start)}${text}${chatInput.value.slice(end)}`;
  const caret = start + text.length;
  chatInput.setSelectionRange(caret, caret);
  chatInput.focus();
}

/** The name the last inbound whisper came from, read from the backlog the pane is drawn from. */
export function lastWhisperSender(): string | undefined {
  const log = game.world?.chatLog;
  if (!log) return undefined;
  for (let index = log.length - 1; index >= 0; index -= 1) {
    const message = log[index];
    if (message?.type !== CHAT_MSG_WHISPER) continue;
    const name = whisperTarget(message);
    if (name) return name;
  }
  return undefined;
}

// The native input's verbs. Registered at load, which is before any key can be pressed: `Actions`
// reaches this module through `Chat.ts`, and the world mount only ever installs a replacement.
setNativeChatInputOwner({
  openChat(text) {
    if (text !== undefined) {
      chatInput.value = text;
      chatInput.setSelectionRange(text.length, text.length);
    }
    chatInput.focus();
  },
  insertLink: insertIntoNativeChat,
  reply() {
    // The native parser has no `/r`; `/w Имя ` is the same draft the sender-name click writes.
    const name = lastWhisperSender();
    if (!name) return;
    chatInput.value = `/w ${name} `;
    chatInput.setSelectionRange(chatInput.value.length, chatInput.value.length);
    chatInput.focus();
  },
});

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

/** Everyone who mirrors the combat lines somewhere else — the stock chat's combat window. */
const combatEntryListeners = new Set<(entry: CombatLogEntry) => void>();

/**
 * Subscribes to every combat line as it is recorded; answers the unsubscribe.
 *
 * The native combat tab lives in `#chat-log`, which the stock chat hides, so this is the one feed a
 * stock `ChatFrame2` can be filled from without a second copy of the combat packet handlers.
 */
export function onCombatEntry(listener: (entry: CombatLogEntry) => void): () => void {
  combatEntryListeners.add(listener);
  return () => { combatEntryListeners.delete(listener); };
}

/** The combat history the native tab holds, oldest first, for a mirror that starts late. */
export function combatHistory(): readonly CombatLogEntry[] {
  return combatEntries;
}

/** One line of combat, kept in the tab's history and drawn if that tab is the one on screen. */
export function recordCombatEntry(entry: CombatLogEntry): void {
  pushCombatEntry(combatEntries, entry);
  for (const listener of combatEntryListeners) {
    try {
      listener(entry);
    } catch (error) {
      console.warn("[chat] a combat line mirror failed", error);
    }
  }
  const tab = activeTab();
  if (!tab.combat) {
    unread.set("combat", Math.min(COMBAT_LOG_HISTORY, (unread.get("combat") ?? 0) + 1));
    syncChatTabBadges();
    return;
  }
  // Behind the stock chat the pane is rebuilt from `combatEntries` when it comes back.
  if (paneReplaced()) return;
  // A filtered-out line still counts in history and in the unread badge; it simply is not drawn.
  if (!combatLogVisible(entry, combatHiddenCategories())) return;
  beforePaneAppend();
  chatLog.append(renderCombatLine(entry));
  trimPane();
}
