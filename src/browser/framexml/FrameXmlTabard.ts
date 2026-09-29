/**
 * The stock TabardFrame's C API (TabardFrame.lua, TabardFrame.xml) over this client's tabard
 * designer: `MSG_TABARDVENDOR_ACTIVATE` opens it, `MSG_SAVE_GUILD_EMBLEM` saves the design.
 *
 * TabardFrame reads almost nothing through global functions. Its design lives in the TabardModel
 * widget: OPEN_TABARD_FRAME calls `TabardModel:InitializeTabardColors()`, the five arrows call
 * `TabardModel:CycleVariation(id, ±1)` (TabardFrame.lua:77-87), the four watermark textures take
 * `TabardModel:GetUpperEmblemTexture(t)`/`GetLowerEmblemTexture(t)` (:89-94), the Accept button asks
 * `TabardModel:CanSaveTabardNow()` (:103) and runs `TabardModel:Save()` (TabardFrame.xml:572). The
 * owner (FrameXmlTabardOwner.ts) installs those six on the one TabardModel instance; they call the
 * hidden `WebClientTabard*` names below, which answer from this model.
 *
 * Settled against the selected TrinityCore:
 *
 * * The design is five numbers, sent style, colour, border style, border colour, background
 *   (`EmblemInfo::ReadPacket`; GuildBankProtocol.ts `buildSaveGuildEmblem`). Their ranges are the
 *   GuildEmblems files this client carries, measured through the MPQ chain: `Emblem_000..169`,
 *   emblem colours 00..16, `Border_00..09` with colours 00..16 for styles 0-5 and 00..03 for 6-9,
 *   `Background_00..50` — the same ranges the native designer (Npc.ts) steps through.
 * * The price is `EMBLEM_PRICE = 10 * GOLD` (Guild.cpp:44; `GetTabardCreationCost` is
 *   FrameXmlServices.ts's); the server charges it and answers one of
 *   the six `GuildEmblemError` codes (Guild.h:212-217), each a client GlobalString `ERR_GUILDEMBLEM_*`.
 * * The designer only echoes its own guid; the current emblem is the guild query's, which
 *   `WorldClient` re-announces as TABARD_VENDOR_CHANGED when it lands.
 *
 * `ERR_GUILDEMBLEM_SAME` («your tabard hasn't changed») has no code on the wire — TrinityCore never
 * sends it — so the client refuses an unchanged design itself; `Save` does the same here.
 */
import { guildEmblemErrorText } from "../../world/GuildBankProtocol.js";

/** The highest index of each part, measured over the client's `Textures\GuildEmblems` files. */
export const FRAMEXML_TABARD_RANGES = Object.freeze({ style: 169, color: 16, borderStyle: 9, background: 50 });

/** Border colours: 00..16 for border styles 0-5, 00..03 for the later 6-9 set (measured). */
export function frameXmlTabardBorderColorMaximum(borderStyle: number): number {
  return borderStyle <= 5 ? 16 : 3;
}

/** The five parts, in the order the save packet carries them. */
export interface FrameXmlTabardEmblem {
  readonly style: number;
  readonly color: number;
  readonly borderStyle: number;
  readonly borderColor: number;
  readonly background: number;
}

/**
 * `GuildEmblemError` (Guild.h:212-217) and the client's GlobalString for each, in code order.
 * `WorldClient` keeps only the native wording, so the owner matches it back through the same table
 * `guildEmblemErrorText` builds it from.
 */
export const FRAMEXML_TABARD_RESULTS: readonly string[] = Object.freeze([
  "ERR_GUILDEMBLEM_SUCCESS", "ERR_GUILDEMBLEM_INVALID_TABARD_COLORS", "ERR_GUILDEMBLEM_NOGUILD",
  "ERR_GUILDEMBLEM_NOTGUILDMASTER", "ERR_GUILDEMBLEM_NOTENOUGHMONEY", "ERR_GUILDEMBLEM_INVALIDVENDOR",
]);

const EMBLEM_ROOT = "Textures\\GuildEmblems\\";

function code(value: number): string {
  return String(Math.max(0, Math.trunc(value))).padStart(2, "0");
}

/**
 * The watermark halves TabardFrame shows at 40 % (TabardFrame.lua:12-16): the emblem symbol's upper
 * and lower tabard pieces, `Emblem_SS_CC_TU_U` and `_TL_U` — the naming GetGuildTabardFileNames
 * answers for the same halves (FrameXmlGuildBank.ts).
 */
export function frameXmlTabardEmblemTexture(emblem: FrameXmlTabardEmblem, half: "upper" | "lower"): string {
  return `${EMBLEM_ROOT}Emblem_${code(emblem.style)}_${code(emblem.color)}_${half === "upper" ? "TU" : "TL"}_U`;
}

/** The five `TabardFrameCustomization<id>` rows (TabardFrame.xml:475-541), each wrapping around. */
export function frameXmlTabardCycle(emblem: FrameXmlTabardEmblem, id: number, delta: number): FrameXmlTabardEmblem {
  const step = (value: number, maximum: number): number => {
    const next = value + (delta < 0 ? -1 : 1);
    return next < 0 ? maximum : next > maximum ? 0 : next;
  };
  switch (id) {
    case 1: return { ...emblem, style: step(emblem.style, FRAMEXML_TABARD_RANGES.style) };
    case 2: return { ...emblem, color: step(emblem.color, FRAMEXML_TABARD_RANGES.color) };
    case 3: {
      const borderStyle = step(emblem.borderStyle, FRAMEXML_TABARD_RANGES.borderStyle);
      return { ...emblem, borderStyle,
        borderColor: Math.min(emblem.borderColor, frameXmlTabardBorderColorMaximum(borderStyle)) };
    }
    case 4: return { ...emblem, borderColor: step(emblem.borderColor, frameXmlTabardBorderColorMaximum(emblem.borderStyle)) };
    case 5: return { ...emblem, background: step(emblem.background, FRAMEXML_TABARD_RANGES.background) };
    default: return emblem;
  }
}

/** The guild query's emblem, clamped into the measured ranges. */
export function frameXmlTabardFromGuild(guild: FrameXmlTabardGuild): FrameXmlTabardEmblem {
  const clamp = (value: number, maximum: number): number => Math.min(maximum, Math.max(0, Math.trunc(value)));
  const borderStyle = clamp(guild.borderStyle, FRAMEXML_TABARD_RANGES.borderStyle);
  return {
    style: clamp(guild.emblemStyle, FRAMEXML_TABARD_RANGES.style),
    color: clamp(guild.emblemColor, FRAMEXML_TABARD_RANGES.color),
    borderStyle,
    borderColor: clamp(guild.borderColor, frameXmlTabardBorderColorMaximum(borderStyle)),
    background: clamp(guild.backgroundColor, FRAMEXML_TABARD_RANGES.background),
  };
}

function sameEmblem(left: FrameXmlTabardEmblem, right: FrameXmlTabardEmblem): boolean {
  return left.style === right.style && left.color === right.color && left.borderStyle === right.borderStyle
    && left.borderColor === right.borderColor && left.background === right.background;
}

/** `SMSG_GUILD_QUERY_RESPONSE`'s emblem fields. */
export interface FrameXmlTabardGuild {
  readonly emblemStyle: number;
  readonly emblemColor: number;
  readonly borderStyle: number;
  readonly borderColor: number;
  readonly backgroundColor: number;
}

interface FrameXmlTabardEvents {
  on(event: "TABARD_VENDOR_CHANGED", listener: (payload: { guid: bigint }) => void): () => void;
}

/** The world facts and commands the model reads; `WorldClient` satisfies it structurally. */
export interface FrameXmlTabardWorld {
  /** The designer that answered `MSG_TABARDVENDOR_ACTIVATE`; 0 when none is open. */
  tabardVendorGuid: bigint;
  readonly tabardMessage?: { readonly text: string; readonly error: boolean } | undefined;
  readonly guildQuery?: FrameXmlTabardGuild | undefined;
  readonly events?: FrameXmlTabardEvents | undefined;
  saveGuildEmblem(style: number, color: number, borderStyle: number, borderColor: number, background: number): void;
}

export interface FrameXmlTabardContext {
  world(): FrameXmlTabardWorld | undefined;
}

/** The native wording of a save answer back to its `GuildEmblemError` code. */
function tabardResultCode(text: string): number | undefined {
  const code = FRAMEXML_TABARD_RESULTS.findIndex((_, result) => guildEmblemErrorText(result) === text);
  return code < 0 ? undefined : code;
}

interface FrameXmlTabardPump {
  fire(event: string, ...args: readonly unknown[]): number;
}

/** What the owner's gate shows: a guild emblem to start from. Never sent anywhere. */
export interface FrameXmlTabardProbe {
  readonly guild: FrameXmlTabardGuild;
}

/** One owner of the tabard designer's C API and of its four events. */
export class FrameXmlTabardModel {
  readonly #context: FrameXmlTabardContext;
  #pump: FrameXmlTabardPump | undefined;
  #unsubscribe: (() => void)[] = [];
  #owned = false;
  #muted = false;
  #probe: FrameXmlTabardProbe | undefined;
  #strings: ((name: string) => string | undefined) | undefined;
  /** The designer OPEN_TABARD_FRAME was raised for; 0 once CLOSE_TABARD_FRAME was. */
  #shown = 0n;
  /** The design on screen; undefined until InitializeTabardColors found the guild's emblem. */
  #design: FrameXmlTabardEmblem | undefined;
  /** InitializeTabardColors ran before the guild query was in; its arrival re-opens the frame. */
  #waitingForGuild = false;
  /** A save is on the wire; its answer clears it (TABARD_SAVE_PENDING / TABARD_CANSAVE_CHANGED). */
  #pending = false;
  #answered: object | undefined;
  #canSave = false;

  constructor(context: FrameXmlTabardContext) {
    this.#context = context;
  }

  attach(pump: FrameXmlTabardPump): void {
    this.detach();
    this.#pump = pump;
    const world = this.#context.world();
    if (world?.events && typeof world.events.on === "function") {
      this.#unsubscribe.push(world.events.on("TABARD_VENDOR_CHANGED", () => this.sync()));
    }
  }

  detach(): void {
    for (const unsubscribe of this.#unsubscribe.splice(0)) unsubscribe();
    this.#pump = undefined;
    this.#owned = false;
    this.#forget();
  }

  #forget(): void {
    this.#shown = 0n;
    this.#design = undefined;
    this.#waitingForGuild = false;
    this.#pending = false;
    this.#canSave = false;
  }

  /** Whether stock TabardFrame is the designer; taking ownership replays an open designer. */
  get owned(): boolean { return this.#owned; }
  set owned(owned: boolean) {
    if (owned === this.#owned) return;
    this.#owned = owned;
    this.#forget();
    if (owned) this.sync();
  }

  /** The client's GlobalStrings, for the `ERR_GUILDEMBLEM_*` wording; set by the owner once published. */
  useGlobalStrings(resolve: ((name: string) => string | undefined) | undefined): void {
    this.#strings = resolve;
  }

  muted<T>(operation: () => T): T {
    const previous = this.#muted;
    this.#muted = true;
    try { return operation(); } finally { this.#muted = previous; }
  }

  /** Answer every read from `probe` for the duration of `operation`, muted and with no edge raised. */
  probe<T>(probe: FrameXmlTabardProbe, operation: () => T): T {
    const previous = { probe: this.#probe, design: this.#design, pending: this.#pending, waiting: this.#waitingForGuild };
    this.#probe = probe;
    this.#design = undefined;
    this.#pending = false;
    try { return this.muted(operation); } finally {
      this.#probe = previous.probe;
      this.#design = previous.design;
      this.#pending = previous.pending;
      this.#waitingForGuild = previous.waiting;
    }
  }

  #guild(): FrameXmlTabardGuild | undefined {
    return this.#probe?.guild ?? this.#context.world()?.guildQuery;
  }

  /**
   * Raise the edge the world's designer moved to: OPEN_TABARD_FRAME for a new designer,
   * CLOSE_TABARD_FRAME once it is gone, and for the open one TABARD_CANSAVE_CHANGED when a save was
   * answered (with the answer in UIErrorsFrame) or the guild's emblem arrived.
   */
  sync(): void {
    const pump = this.#pump;
    if (!pump || !this.#owned || this.#probe) return;
    const world = this.#context.world();
    const guid = world?.tabardVendorGuid ?? 0n;
    if (guid !== 0n && guid !== this.#shown) {
      this.#forget();
      this.#shown = guid;
      this.#answered = world?.tabardMessage;
      pump.fire("OPEN_TABARD_FRAME");
      return;
    }
    if (guid === 0n) {
      if (this.#shown === 0n) return;
      this.#forget();
      pump.fire("CLOSE_TABARD_FRAME");
      return;
    }
    const message = world?.tabardMessage;
    if (this.#pending && message && message !== this.#answered) {
      this.#answered = message;
      this.#pending = false;
      this.#say(message);
    }
    if (this.#waitingForGuild && this.#guild()) {
      // TabardFrame draws the design only from OPEN_TABARD_FRAME; raised again, it initializes from
      // the emblem that has just arrived (ShowUIPanel of the shown frame is a no-op).
      this.#waitingForGuild = false;
      pump.fire("OPEN_TABARD_FRAME");
    }
    this.#announceCanSave();
  }

  #say(message: { readonly text: string; readonly error: boolean }): void {
    const code = tabardResultCode(message.text);
    const name = code === undefined ? undefined : FRAMEXML_TABARD_RESULTS[code];
    const text = (name !== undefined ? this.#strings?.(name) : undefined) ?? message.text;
    this.#pump?.fire(message.error ? "UI_ERROR_MESSAGE" : "UI_INFO_MESSAGE", text);
  }

  #announceCanSave(): void {
    const canSave = this.canSave();
    if (canSave === this.#canSave) return;
    this.#canSave = canSave;
    this.#pump?.fire("TABARD_CANSAVE_CHANGED");
  }

  /** Whether stock was shown a designer that is still the world's. */
  get showing(): boolean { return this.#shown !== 0n; }

  // ---- TabardModel ---------------------------------------------------------------------------

  /** `TabardModel:InitializeTabardColors()`: start from the guild's current emblem. */
  initialize(): void {
    const guild = this.#guild();
    this.#design = guild ? frameXmlTabardFromGuild(guild) : undefined;
    this.#waitingForGuild = !guild && !this.#probe;
  }

  /** `TabardModel:CycleVariation(id, delta)`. Nothing to cycle before the emblem is known. */
  cycle(id: number, delta: number): void {
    if (this.#design) this.#design = frameXmlTabardCycle(this.#design, id, delta);
  }

  /** The design on screen (tests, the owner's probe). */
  get design(): FrameXmlTabardEmblem | undefined { return this.#design; }

  /** `GetUpperEmblemTexture`/`GetLowerEmblemTexture`'s file; nil before the emblem is known. */
  emblemTexture(half: "upper" | "lower"): string | undefined {
    return this.#design ? frameXmlTabardEmblemTexture(this.#design, half) : undefined;
  }

  /**
   * `TabardModel:CanSaveTabardNow()`: a design is on screen for an open designer and no save is on
   * the wire. Whether the player may (guild master, ten gold) is the server's answer, said in
   * UIErrorsFrame; TabardFrame_UpdateButtons already keeps the button off outside a guild's rank 0.
   */
  canSave(): boolean {
    if (!this.#design || this.#pending) return false;
    return this.#probe !== undefined || this.#shown !== 0n;
  }

  /** `TabardModel:Save()`: `MSG_SAVE_GUILD_EMBLEM` to the open designer, then TABARD_SAVE_PENDING. */
  save(): void {
    const design = this.#design;
    if (!design || !this.canSave()) return;
    const guild = this.#guild();
    if (guild && sameEmblem(design, frameXmlTabardFromGuild(guild))) {
      const refusal = this.#strings?.("ERR_GUILDEMBLEM_SAME");
      if (!this.#muted && refusal) this.#pump?.fire("UI_ERROR_MESSAGE", refusal);
      return;
    }
    if (this.#muted || this.#probe) return;
    const world = this.#context.world();
    if (!world || world.tabardVendorGuid === 0n || world.tabardVendorGuid !== this.#shown) return;
    this.#answered = world.tabardMessage;
    this.#pending = true;
    world.saveGuildEmblem(design.style, design.color, design.borderStyle, design.borderColor, design.background);
    this.#pump?.fire("TABARD_SAVE_PENDING");
    this.#announceCanSave();
  }

  /**
   * `CloseTabardCreation()` — TabardFrame's OnHide. There is no close opcode in 3.3.5: the world
   * forgets the designer (only the one stock was shown) and CLOSE_TABARD_FRAME follows through `sync`.
   */
  close(): void {
    if (this.#muted || this.#probe) return;
    const world = this.#context.world();
    if (world && this.#shown !== 0n && world.tabardVendorGuid === this.#shown) world.tabardVendorGuid = 0n;
    this.sync();
  }
}

/** The part of the world seam the bindings read. */
export interface FrameXmlTabardHost {
  readonly tabard?: FrameXmlTabardModel | undefined;
}

export type FrameXmlTabardBinding = (host: FrameXmlTabardHost, args: readonly unknown[]) => readonly unknown[];

const NOTHING: readonly [] = Object.freeze([]);

function integerArg(value: unknown): number {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(number) ? Math.trunc(number) : 0;
}

const withTabard = (answer: (tabard: FrameXmlTabardModel, args: readonly unknown[]) => readonly unknown[]): FrameXmlTabardBinding =>
  (host, args) => host.tabard ? answer(host.tabard, args) : NOTHING;

const command = (run: (tabard: FrameXmlTabardModel, args: readonly unknown[]) => void): FrameXmlTabardBinding =>
  withTabard((tabard, args) => { run(tabard, args); return NOTHING; });

/**
 * The flat C API. `GetTabardCreationCost` is FrameXmlServices.ts's (the same `EMBLEM_PRICE`, and it
 * answers without a model, which TabardFrame's OnLoad needs at boot, TabardFrame.lua:10). The
 * `WebClientTabard*` names are the TabardModel methods' host half (FrameXmlTabardOwner.ts).
 */
export const FRAMEXML_TABARD_BINDINGS: Readonly<Record<string, FrameXmlTabardBinding>> = Object.freeze({
  CloseTabardCreation: command((tabard) => tabard.close()),
  WebClientTabardInitialize: command((tabard) => tabard.initialize()),
  WebClientTabardCycle: command((tabard, args) => tabard.cycle(integerArg(args[0]), integerArg(args[1]))),
  WebClientTabardEmblem: withTabard((tabard, args) => {
    const texture = tabard.emblemTexture(args[0] === "lower" ? "lower" : "upper");
    return texture === undefined ? NOTHING : [texture];
  }),
  WebClientTabardCanSave: withTabard((tabard) => [tabard.canSave()]),
  WebClientTabardSave: command((tabard) => tabard.save()),
});
