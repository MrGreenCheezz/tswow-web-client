/**
 * The stock PaperDoll title picker's C API (PlayerTitleFrame, PaperDollFrame.lua:2591-2690) and
 * CharacterFrame's `UnitPVPName` (CharacterFrame.lua:77-88) over the player's title fields and the
 * CharTitles catalog (`/dbc/char-titles`, gateway/CharTitleMetadata.ts).
 *
 * * A title is its CharTitles `Mask_ID`: `PLAYER_CHOSEN_TITLE` holds the worn one (0 for none) and
 *   the six words from `PLAYER__FIELD_KNOWN_TITLES` one bit per mask (`Player::SetTitle`: word
 *   MaskID / 32, bit MaskID % 32). Stock iterates `for i = 1, GetNumTitles()` and asks
 *   `IsTitleKnown(i)` for each (:2604), so GetNumTitles is the loop bound that reaches every bit:
 *   the catalog's highest mask plus one; an index no row carries is simply not known.
 * * `IsTitleKnown(i) ~= 0` is the test at :2605 — a number, never a boolean.
 * * `GetTitleName(i)` is the row by the player's sex (`Name1_lang` is the declined female form,
 *   filled where the language has one) with the `%s` name placeholder taken out, spaces and all:
 *   :2608 and :2680 `strtrim` exactly that leftover («Рядовой » → «Рядовой»). The placeholder is
 *   what `UnitPVPName` fills: «Рядовой Игрок», «Игрок, Чемпион Наару».
 * * `GetCurrentTitle()` is -1 for none: the picker's «Нет» row carries -1 (:2601) and choosing it
 *   sends `SetCurrentTitle(-1)`; the core clears the field on anything it cannot wear
 *   (MiscHandler.cpp HandleSetTitleOpcode, «-1 at none»). CMSG_SET_TITLE carries an int32.
 * * KNOWN_TITLES_UPDATE when the known words or the catalog change, UNIT_NAME_UPDATE("player")
 *   when the worn title changes: PaperDollFrame_OnEvent (:176) redraws the picker on both,
 *   CharacterFrame_OnEvent (:76) the name line on the second.
 *
 * Anything not established — no player object yet, no catalog yet, a mask no row carries — is nil.
 */
import type { CharTitleRow } from "../CharTitleClient.js";

export const FRAMEXML_TITLE_EVENTS = Object.freeze({
  known: "KNOWN_TITLES_UPDATE",
  name: "UNIT_NAME_UPDATE",
});

/** `KNOWN_TITLES_SIZE` (Player.h): three uint64 fields, six words, 192 bits. */
export const FRAMEXML_KNOWN_TITLE_WORDS = 6;
/** `MAX_TITLE_INDEX` (Player.h): the mask the core refuses at and above. */
export const FRAMEXML_MAX_TITLE_INDEX = 32 * FRAMEXML_KNOWN_TITLE_WORDS;
/** What `GetCurrentTitle` answers for a bare name: the picker's «Нет» row (PaperDollFrame.lua:2601). */
export const FRAMEXML_NO_TITLE = -1;
const NAME_PLACEHOLDER = "%s";

/** The catalog keyed as the fields key it. */
export interface FrameXmlTitleCatalog {
  title(maskId: number): CharTitleRow | undefined;
  /** The highest mask plus one: the bound stock loops to. */
  readonly count: number;
}

export function frameXmlTitleCatalog(rows: readonly CharTitleRow[]): FrameXmlTitleCatalog {
  const byMask = new Map<number, CharTitleRow>();
  let highest = 0;
  for (const row of rows) {
    if (!Number.isSafeInteger(row.maskId) || row.maskId <= 0 || row.maskId >= FRAMEXML_MAX_TITLE_INDEX) continue;
    if (!byMask.has(row.maskId)) byMask.set(row.maskId, row);
    highest = Math.max(highest, row.maskId);
  }
  return Object.freeze({ title: (maskId: number) => byMask.get(maskId), count: highest === 0 ? 0 : highest + 1 });
}

/** The two fields a title is worn by, of any player object (PLAYER_CHOSEN_TITLE is public). */
export interface FrameXmlTitleWearer {
  /** `PLAYER_CHOSEN_TITLE`; undefined without the object. */
  readonly chosen: number | undefined;
  /** UNIT_FIELD_BYTES_0's gender byte read as «female»; undefined without the object. */
  readonly female: boolean | undefined;
}

export interface FrameXmlTitleHost {
  catalog(): FrameXmlTitleCatalog | undefined;
  /** The six words from `PLAYER__FIELD_KNOWN_TITLES`; undefined without the player's own object. */
  knownWords(): readonly number[] | undefined;
  /** The player's own chosen title and sex. */
  wearer(): FrameXmlTitleWearer;
  /** `CMSG_SET_TITLE`, int32; -1 clears. */
  setTitle(index: number): void;
  /** Changes identity when the world session is replaced: the compare restarts without events. */
  session?(): unknown;
  /** Fetch the catalog once (the live host's `/dbc/char-titles`); absent when it is already in hand. */
  prepare?(): Promise<void>;
}

interface TitlePump {
  fire(event: string, ...args: readonly unknown[]): number;
}

const NOTHING: readonly [] = Object.freeze([]);

function maskOf(value: unknown): number | undefined {
  const mask = Number(value);
  return Number.isInteger(mask) && mask >= 1 && mask < FRAMEXML_MAX_TITLE_INDEX ? mask : undefined;
}

/** The catalog row's text for a wearer: the female form where the language declines it. */
function textFor(row: CharTitleRow, female: boolean | undefined): string {
  return female === true && row.nameFemale.length > 0 ? row.nameFemale : row.name;
}

/** One owner of the title C API, the KNOWN_TITLES_UPDATE / UNIT_NAME_UPDATE edges and the name line. */
export class FrameXmlTitleModel {
  readonly #host: FrameXmlTitleHost;
  #pump: TitlePump | undefined;
  /** The known words, the worn mask and the catalog as last seen: compared, not rebuilt, every tick. */
  #seen: string | undefined;
  #seenChosen: number | undefined;
  #catalog: FrameXmlTitleCatalog | undefined;
  #session: unknown;

  constructor(host: FrameXmlTitleHost) {
    this.#host = host;
  }

  attach(pump: TitlePump): void {
    this.detach();
    this.#pump = pump;
    // The baseline is what the world holds now, not the first frame's: an edge in between is not lost.
    this.tick();
    // The catalog is wanted the moment the sheet opens; asking here keeps the fetch out of every C-API read.
    void this.prepare();
  }

  detach(): void {
    this.#pump = undefined;
    this.#seen = undefined;
    this.#seenChosen = undefined;
  }

  /** Ask the host for its catalog. Never rejects. */
  async prepare(): Promise<void> {
    try { await this.#host.prepare?.(); } catch { /* without the catalog every title value stays nil */ }
  }

  /** `GetNumTitles()`: the loop bound that reaches every known bit. */
  count(): number {
    return this.#host.catalog()?.count ?? 0;
  }

  /** `IsTitleKnown(index)`: the mask's bit in the known words. */
  isKnown(indexArg: unknown): boolean {
    const mask = maskOf(indexArg);
    const words = this.#host.knownWords();
    if (mask === undefined || !words) return false;
    const word = words[Math.floor(mask / 32)];
    return word !== undefined && ((word >>> (mask % 32)) & 1) === 1;
  }

  /** `GetTitleName(index)`: the wearer's form with the `%s` placeholder taken out; nil for no row. */
  name(indexArg: unknown): string | undefined {
    const mask = maskOf(indexArg);
    const row = mask === undefined ? undefined : this.#host.catalog()?.title(mask);
    return row === undefined ? undefined : textFor(row, this.#host.wearer().female).replace(NAME_PLACEHOLDER, "");
  }

  /** `GetCurrentTitle()`: the worn mask, or -1 for none (also before the player's object exists). */
  current(): number {
    const chosen = this.#host.wearer().chosen;
    return chosen !== undefined && Number.isInteger(chosen) && chosen > 0 ? chosen : FRAMEXML_NO_TITLE;
  }

  /** `SetCurrentTitle(index)`: -1 clears; a known mask is worn; anything else the core would refuse, so nothing goes out. */
  setCurrent(indexArg: unknown): void {
    const index = Number(indexArg);
    if (index === FRAMEXML_NO_TITLE) this.#host.setTitle(FRAMEXML_NO_TITLE);
    else if (this.isKnown(index)) this.#host.setTitle(index);
  }

  /**
   * `UnitPVPName`: the name in the worn title's placeholder («Рядовой Игрок»), for any player
   * object whose fields the caller read; the bare name without a title or a catalog.
   */
  displayName(name: string, wearer: FrameXmlTitleWearer): string {
    const chosen = wearer.chosen;
    const row = chosen !== undefined && chosen > 0 ? this.#host.catalog()?.title(chosen) : undefined;
    if (!row) return name;
    const text = textFor(row, wearer.female);
    return text.includes(NAME_PLACEHOLDER) ? text.replace(NAME_PLACEHOLDER, name) : `${text.trim()} ${name}`;
  }

  /** Per-frame: the catalog's arrival, the known words' and the worn title's edges. */
  tick(): void {
    const pump = this.#pump;
    if (!pump) return;
    const session = this.#host.session?.();
    const catalog = this.#host.catalog();
    const words = this.#host.knownWords();
    const chosen = this.#host.wearer().chosen;
    const seen = `${words ? words.join(",") : ""}|${catalog === undefined ? 0 : 1}`;
    const catalogChanged = catalog !== this.#catalog;
    this.#catalog = catalog;
    const first = this.#seen === undefined || session !== this.#session;
    this.#session = session;
    const wordsChanged = seen !== this.#seen;
    const chosenChanged = chosen !== this.#seenChosen;
    this.#seen = seen;
    this.#seenChosen = chosen;
    // The first look is the baseline; a catalog that lands later is the one edge worth redrawing on.
    if (first) return;
    if (wordsChanged || catalogChanged) pump.fire(FRAMEXML_TITLE_EVENTS.known);
    if (chosenChanged) pump.fire(FRAMEXML_TITLE_EVENTS.name, "player");
  }
}

export interface FrameXmlTitleSeam {
  readonly titles?: FrameXmlTitleModel | undefined;
}

export type FrameXmlTitleBinding = (host: FrameXmlTitleSeam, args: readonly unknown[]) => readonly unknown[];

const withTitles = (answer: (titles: FrameXmlTitleModel, args: readonly unknown[]) => readonly unknown[],
  fallback: readonly unknown[] = NOTHING): FrameXmlTitleBinding =>
  (host, args) => host.titles ? answer(host.titles, args) : fallback;

/** The flat C API, spread into FRAMEXML_SEAM_BINDINGS; a seam without the model answers as the neutral world. */
export const FRAMEXML_TITLE_BINDINGS: Readonly<Record<string, FrameXmlTitleBinding>> = Object.freeze({
  GetNumTitles: withTitles((titles) => [titles.count()], [0]),
  IsTitleKnown: withTitles((titles, args) => [titles.isKnown(args[0]) ? 1 : 0], [0]),
  GetTitleName: withTitles((titles, args) => {
    const name = titles.name(args[0]);
    return name === undefined ? NOTHING : [name];
  }),
  GetCurrentTitle: withTitles((titles) => [titles.current()], [FRAMEXML_NO_TITLE]),
  SetCurrentTitle: withTitles((titles, args) => { titles.setCurrent(args[0]); return NOTHING; }),
});
