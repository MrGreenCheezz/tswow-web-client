/**
 * The stock GossipFrame's C API (GossipFrame.lua, UIParent.lua's GOSSIP_CONFIRM/ENTER_CODE
 * branch and StaticPopup.lua's two gossip dialogs) over this client's `SMSG_GOSSIP_MESSAGE` page.
 *
 * Four facts shape everything below, each read from the stock 3.3.5 Lua or the selected core:
 *
 * * `GOSSIP_SHOW` is an edge the client raises once per page, and stock acts on it more than once:
 *   a page whose only row is a service option is *selected* by GossipFrame_OnEvent itself
 *   (GossipFrame.lua:13-19). The model therefore fires it exactly once per page object, and only
 *   when the page's NPC text is in the cache — `WorldClient` repaints the native window a second
 *   time when `SMSG_NPC_TEXT_UPDATE` lands, which must not select that option twice.
 * * Reads answer the page Lua was told about, not the newest packet: a second page that arrived
 *   while its text is still being queried must not re-index the rows on screen. A command is sent
 *   only while those two are the same page.
 * * `SelectGossipOption(index, text, confirmed)` is where the client asks before paying or typing:
 *   a coded row raises `GOSSIP_ENTER_CODE(index)` and a row with a box message or a price raises
 *   `GOSSIP_CONFIRM(index, text, cost)`; stock's dialogs call back with the code or `confirmed`.
 *   Both fields are on the wire (GossipDef.cpp:216-220: `IsCoded`, `BoxMoney`, `BoxMessage`).
 * * The quest rows are PrepareQuestMenu's (Player.cpp:14969-14996): icon 4 is an involved quest
 *   (stock "active"), 0 and 2 are quests to take (stock "available"), in wire order per group.
 *
 * The native `#gossip-window` keeps the route until the world mount publishes the stock owner
 * (`owned`); until then no GOSSIP_* event is raised, so the two can never answer one page twice.
 */
import type { GossipMessage, NpcText, QuestMenuEntry } from "../../world/NpcProtocol.js";

/** `QUEST_FLAGS_DAILY` in the selected TrinityCore's QuestDef.h. */
const QUEST_FLAGS_DAILY = 0x00001000;

/**
 * The option-type word `GetGossipOptions` pairs with each row; stock builds the icon path from it
 * (`"Interface\\GossipFrame\\" .. type .. "GossipIcon"`, GossipFrame.lua:161). Indexed by the
 * wire's `GossipOptionIcon` (GossipDef.h:58-70). Every word names a texture present in this client
 * (measured through /texture: 10 of 10; there is no "Auctioneer" icon), and icon 10 — "yellow
 * dot" in the core's comment — is the round `UnlearnGossipIcon`. Icons 11+ are chat bubbles in the
 * same enum, so they answer "gossip", which also keeps GossipFrame_OnEvent's single-row shortcut
 * from selecting a talk row the player has not read.
 */
export const FRAMEXML_GOSSIP_OPTION_TYPES: readonly string[] = Object.freeze([
  "gossip", "vendor", "taxi", "trainer", "healer", "binder", "banker", "petition", "tabard",
  "battlemaster", "unlearn",
]);

export function frameXmlGossipOptionType(icon: number): string {
  return FRAMEXML_GOSSIP_OPTION_TYPES[icon] ?? "gossip";
}

/**
 * The text a page's `npc_text` row shows: the most probable of its eight options with a line to
 * say, the male line before the female one — the choice the native window already made.
 *
 * A text id the world database has no row for is still answered: QueryHandler.cpp:246-259 sends all
 * eight options at probability 0 with «Greetings $N». With no option weighted, the first one with a
 * line is the page's text, so such an NPC greets the player instead of showing an empty page.
 */
export function frameXmlGossipText(text: NpcText | undefined): string | undefined {
  const spoken = text?.options.filter((candidate) => candidate.male || candidate.female) ?? [];
  const option = spoken
    .filter((candidate) => candidate.probability > 0)
    .sort((left, right) => right.probability - left.probability)[0] ?? spoken[0];
  return option ? option.male || option.female : undefined;
}

/**
 * Whether a quest row is drawn trivial (grey icon, TRIVIAL_QUEST_DISPLAY): UIParent.lua's
 * GetQuestDifficultyColor calls a quest trivial once the player is more than `GetQuestGreenRange()`
 * levels above it, the grey the quest log already paints with. The gossip packet carries the level
 * (GossipDef.cpp: `int32(quest->GetQuestLevel())`); a level below 1 is a quest that scales to the
 * player and is never trivial. Unknown player level: nil, as before.
 */
export function frameXmlQuestTrivial(questLevel: number, playerLevel: number | undefined, greenRange: number): boolean | undefined {
  if (playerLevel === undefined || !Number.isFinite(playerLevel) || playerLevel < 1) return undefined;
  if (!Number.isFinite(questLevel) || questLevel < 1) return false;
  return playerLevel - questLevel > greenRange;
}

/** PrepareQuestMenu's two groups, in wire order; an unknown icon keeps the row out of both. */
export function frameXmlGossipQuests(
  page: Pick<GossipMessage, "quests"> | undefined,
  kind: "available" | "active",
): QuestMenuEntry[] {
  return (page?.quests ?? []).filter((quest) => kind === "active"
    ? quest.icon === 4 : quest.icon === 0 || quest.icon === 2);
}

/** The world facts and commands the model reads; `WorldClient` satisfies it structurally. */
export interface FrameXmlGossipWorld {
  readonly gossip?: GossipMessage | undefined;
  readonly npcTexts?: ReadonlyMap<number, NpcText> | undefined;
  selectGossipOption(optionId: number, code?: string): void;
  closeGossip(): void;
  openQuest(guid: bigint, questId: number, completion: boolean): void;
}

/** What the model asks its host (LiveWorldSeam or the canned seam) besides the world. */
export interface FrameXmlGossipContext {
  world(): FrameXmlGossipWorld | undefined;
  /** Resolves `$N`, `$C`, `$R`, `$G…;` and `$B` for this reader (NpcText.ts). */
  formatText?(text: string): string;
  /** PLAYER_QUEST_LOG's complete bit for a logged quest; undefined when the quest is not logged. */
  questComplete?(questId: number): boolean | undefined;
  /** {@link frameXmlQuestTrivial} for this player; absent, triviality stays nil. */
  questTrivial?(questLevel: number): boolean | undefined;
}

interface FrameXmlGossipPump {
  fire(event: string, ...args: readonly unknown[]): number;
}

/** A page the world mount's gate shows to prove the tree, with its text; never sent anywhere. */
export interface FrameXmlGossipProbePage {
  readonly page: GossipMessage;
  readonly text: string;
}

/**
 * One owner of the stock gossip C API. The page itself is the world's; what the model keeps is the
 * page Lua was shown, so every read and command agrees with the rows on screen.
 */
export class FrameXmlGossipModel {
  readonly #context: FrameXmlGossipContext;
  #pump: FrameXmlGossipPump | undefined;
  #owned = false;
  #muted = false;
  /** The page GOSSIP_SHOW was raised for; cleared by GOSSIP_CLOSED. */
  #shown: GossipMessage | undefined;
  #probe: FrameXmlGossipProbePage | undefined;

  constructor(context: FrameXmlGossipContext) {
    this.#context = context;
  }

  attach(pump: FrameXmlGossipPump): void {
    this.detach();
    this.#pump = pump;
  }

  detach(): void {
    this.#pump = undefined;
    this.#owned = false;
    this.#shown = undefined;
  }

  /**
   * Whether the stock frame owns gossip pages. Taking ownership is an edge: a page the native window
   * is showing at that moment is handed over with its own GOSSIP_SHOW (`sync`).
   */
  get owned(): boolean { return this.#owned; }
  set owned(owned: boolean) {
    if (owned === this.#owned) return;
    this.#owned = owned;
    this.#shown = undefined;
    if (owned) this.sync();
  }

  /**
   * Raise the edge the world's page has moved to: GOSSIP_SHOW for a new page whose text is known,
   * GOSSIP_CLOSED once the page Lua was shown is gone. Called from the world's gossip callback
   * (Npc.ts `showGossip` asks the controller first) and at publication.
   */
  sync(): void {
    const pump = this.#pump;
    if (!pump || !this.#owned || this.#probe) return;
    const world = this.#context.world();
    const page = world?.gossip;
    if (page && page !== this.#shown) {
      if (!this.#textReady(world, page)) return;
      this.#shown = page;
      pump.fire("GOSSIP_SHOW");
      return;
    }
    if (!page && this.#shown) {
      this.#shown = undefined;
      pump.fire("GOSSIP_CLOSED");
    }
  }

  /** A world without a text cache (a narrow fake) has nothing to wait for. */
  #textReady(world: FrameXmlGossipWorld | undefined, page: GossipMessage): boolean {
    const texts = world?.npcTexts;
    return !texts || texts.has(page.textId);
  }

  /** Whether stock was shown this page and it is still the world's (`GossipFrame` is up for it). */
  get showing(): boolean { return this.#shown !== undefined; }

  /** Run a transactional probe (the mount's gate) without sending a packet or closing the page. */
  muted<T>(operation: () => T): T {
    const previous = this.#muted;
    this.#muted = true;
    try { return operation(); } finally { this.#muted = previous; }
  }

  /** Answer every read from `page` for the duration of `operation`, muted. */
  probe<T>(page: FrameXmlGossipProbePage, operation: () => T): T {
    const previous = this.#probe;
    this.#probe = page;
    try { return this.muted(operation); } finally { this.#probe = previous; }
  }

  // ---- reads ---------------------------------------------------------------------------------

  #page(): GossipMessage | undefined {
    return this.#probe?.page ?? this.#shown;
  }

  /** The page on screen, only while it is still the one the server holds open. */
  #livePage(): { world: FrameXmlGossipWorld; page: GossipMessage } | undefined {
    if (this.#muted || this.#probe) return undefined;
    const world = this.#context.world();
    const page = this.#shown;
    return world && page && world.gossip === page ? { world, page } : undefined;
  }

  #format(text: string): string {
    return this.#context.formatText?.(text) ?? text;
  }

  text(): string | undefined {
    const probe = this.#probe;
    if (probe) return probe.text;
    const page = this.#shown;
    if (!page) return undefined;
    const raw = frameXmlGossipText(this.#context.world()?.npcTexts?.get(page.textId));
    return raw === undefined ? "" : this.#format(raw);
  }

  numOptions(): number { return this.#page()?.options.length ?? 0; }

  /** `GetGossipOptions`: `text, type` per row. */
  options(): unknown[] {
    const values: unknown[] = [];
    for (const option of this.#page()?.options ?? []) {
      values.push(this.#format(option.text), frameXmlGossipOptionType(option.icon));
    }
    return values;
  }

  numAvailableQuests(): number { return frameXmlGossipQuests(this.#page(), "available").length; }
  numActiveQuests(): number { return frameXmlGossipQuests(this.#page(), "active").length; }

  /** A row's `isTrivial`: the player's grey range ({@link frameXmlQuestTrivial}); nil in a probe. */
  #trivial(level: number): boolean | undefined {
    return this.#probe ? undefined : this.#context.questTrivial?.(level);
  }

  /**
   * `GetGossipAvailableQuests`: `title, level, isTrivial, isDaily, isRepeatable` per quest
   * (GossipFrame.lua:74-80). The packet has no trivial bit; the client greys a row by the player's
   * level, and so does `#trivial`.
   */
  availableQuests(): unknown[] {
    const values: unknown[] = [];
    for (const quest of frameXmlGossipQuests(this.#page(), "available")) {
      values.push(this.#format(quest.title), quest.level, this.#trivial(quest.level),
        (quest.flags & QUEST_FLAGS_DAILY) !== 0, quest.repeatable);
    }
    return values;
  }

  /** `GetGossipActiveQuests`: `title, level, isTrivial, isComplete` per quest (GossipFrame.lua:115-133). */
  activeQuests(): unknown[] {
    const values: unknown[] = [];
    for (const quest of frameXmlGossipQuests(this.#page(), "active")) {
      values.push(this.#format(quest.title), quest.level, this.#trivial(quest.level),
        this.#probe ? false : this.#context.questComplete?.(quest.id));
    }
    return values;
  }

  // ---- commands ------------------------------------------------------------------------------

  /**
   * `SelectGossipOption(index[, text[, confirmed]])`. A coded row sends only with a code (stock's
   * GOSSIP_ENTER_CODE dialog supplies it); a boxed or paid row asks with GOSSIP_CONFIRM first.
   */
  selectOption(index: number, text: unknown, confirmed: boolean): void {
    const probe = this.#probe;
    const page = probe?.page ?? this.#shown;
    const option = Number.isInteger(index) && index >= 1 ? page?.options[index - 1] : undefined;
    if (!option) return;
    const code = typeof text === "string" ? text : undefined;
    const pump = this.#pump;
    if (option.coded && code === undefined) {
      pump?.fire("GOSSIP_ENTER_CODE", index);
      return;
    }
    if (!option.coded && !confirmed && (option.money > 0 || option.boxText.length > 0)) {
      pump?.fire("GOSSIP_CONFIRM", index, this.#format(option.boxText), option.money);
      return;
    }
    const live = this.#livePage();
    if (!live || live.page !== page) return;
    live.world.selectGossipOption(option.id, option.coded ? code : undefined);
  }

  selectQuest(kind: "available" | "active", index: number): void {
    const live = this.#livePage();
    const quest = live && Number.isInteger(index) && index >= 1
      ? frameXmlGossipQuests(live.page, kind)[index - 1] : undefined;
    if (!live || !quest) return;
    live.world.openQuest(live.page.guid, quest.id, kind === "active");
  }

  /**
   * `CloseGossip` — GossipFrame's OnHide. Muted during a probe; otherwise the world forgets the page
   * (there is no close opcode in 3.3.5) and its callback raises GOSSIP_CLOSED through `sync`.
   */
  close(): void {
    if (this.#muted || this.#probe) return;
    const world = this.#context.world();
    if (world?.gossip) world.closeGossip();
  }
}

/** The part of the world seam the bindings read. */
export interface FrameXmlGossipHost {
  readonly gossip?: FrameXmlGossipModel | undefined;
}

export type FrameXmlGossipBinding = (host: FrameXmlGossipHost, args: readonly unknown[]) => readonly unknown[];

const NOTHING: readonly [] = Object.freeze([]);

function integerArg(value: unknown): number {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(number) ? number : 0;
}

/** Lua truthiness: nil and false are false. */
function truthy(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false;
}

const withGossip = (answer: (gossip: FrameXmlGossipModel, args: readonly unknown[]) => readonly unknown[]): FrameXmlGossipBinding =>
  (host, args) => host.gossip ? answer(host.gossip, args) : NOTHING;

const command = (run: (gossip: FrameXmlGossipModel, args: readonly unknown[]) => void): FrameXmlGossipBinding =>
  withGossip((gossip, args) => { run(gossip, args); return NOTHING; });

/**
 * The flat C API, installed into `__fxNeutralImpl` like every seam name. `ForceGossip` answers
 * false: the 3.3.5 client lets GossipFrame_OnEvent select a lone service row, and nothing on the
 * wire asks otherwise.
 */
export const FRAMEXML_GOSSIP_BINDINGS: Readonly<Record<string, FrameXmlGossipBinding>> = Object.freeze({
  GetGossipText: withGossip((gossip) => {
    const text = gossip.text();
    return text === undefined ? NOTHING : [text];
  }),
  GetNumGossipOptions: withGossip((gossip) => [gossip.numOptions()]),
  GetGossipOptions: withGossip((gossip) => gossip.options()),
  GetNumGossipAvailableQuests: withGossip((gossip) => [gossip.numAvailableQuests()]),
  GetGossipAvailableQuests: withGossip((gossip) => gossip.availableQuests()),
  GetNumGossipActiveQuests: withGossip((gossip) => [gossip.numActiveQuests()]),
  GetGossipActiveQuests: withGossip((gossip) => gossip.activeQuests()),
  ForceGossip: () => [false],
  SelectGossipOption: command((gossip, args) => gossip.selectOption(integerArg(args[0]), args[1], truthy(args[2]))),
  SelectGossipAvailableQuest: command((gossip, args) => gossip.selectQuest("available", integerArg(args[0]))),
  SelectGossipActiveQuest: command((gossip, args) => gossip.selectQuest("active", integerArg(args[0]))),
  CloseGossip: command((gossip) => gossip.close()),
});
