/**
 * The stock GlyphFrame's C API (Blizzard_GlyphUI, the «Символы» tab of PlayerTalentFrame) over the
 * player's glyph sockets, and the glyph cursor a glyph item raises.
 *
 * * A socket is the core's zero-based glyph index plus one — the `id` of GlyphFrameGlyph1..6
 *   (Blizzard_GlyphUI.xml). `PLAYER_GLYPHS_ENABLED` holds one bit per index, set by
 *   `Player::InitGlyphsForLevel` from the level; `PLAYER_FIELD_GLYPH_SLOTS_1 + index` the socket's
 *   `GlyphSlot.dbc` row, whose `Type` is 0 major / 1 minor — stock's GLYPHTYPE_MAJOR = 1 and
 *   GLYPHTYPE_MINOR = 2 (Blizzard_GlyphUI.lua:1-2, `isMinor = glyphType == 2` at :67).
 * * The glyph in a socket is a `GlyphProperties.dbc` id: `PLAYER_FIELD_GLYPHS_1 + index` for the
 *   active talent group (`Player::SetGlyph`), and `SMSG_TALENTS_INFO`'s glyph section for each group
 *   (`Player::BuildPlayerTalentsInfoData`), which is what the second group's page reads. Its spell and
 *   rune picture are the row's `SpellID` and `SpellIconID` (the `/dbc/glyphs` catalog,
 *   gateway/GlyphCatalog.ts); stock falls back to UI-Glyph-Rune1 when the icon is nil (:113-117).
 * * There is no «insert» opcode. Using a glyph item — an item whose use spell has
 *   `SPELL_EFFECT_APPLY_GLYPH` — puts the client in targeting mode and raises USE_GLYPH, whose UIParent
 *   handler opens this frame (UIParent.lua:1053-1054). `PlaceGlyphInSocket(id)` then sends that item's
 *   `CMSG_USE_ITEM` with the socket in its glyph field; `RemoveGlyphFromSocket(id)` is
 *   `CMSG_REMOVE_GLYPH` (CharacterHandler.cpp HandleRemoveGlyph). The realm validates both and answers
 *   with the update fields and a fresh SMSG_TALENTS_INFO; the per-frame compare below turns a changed
 *   socket into GLYPH_ADDED / GLYPH_REMOVED / GLYPH_UPDATED with its socket id (:337-366).
 * * `GetGlyphLink` is TrinityCore's glyph hyperlink (Hyperlinks.cpp `LinkValidator<LinkTags::glyph>`,
 *   HyperlinkTags.cpp `glyph::StoreTo`): colour `CHAT_LINK_COLOR_GLYPH` (0xff66bbff),
 *   `glyph:<GlyphSlot id>:<GlyphProperties id>`, and the glyph spell's name as its text.
 *
 * Anything not established — no player yet, a group the packet did not carry, a row the catalog does
 * not have, a spell name not yet resolved — is Lua nil, never a stand-in.
 */
import {
  FRAMEXML_TRADESKILL_BINDINGS, type FrameXmlTradeSkillHost,
} from "./FrameXmlTradeSkill.js";

/** `MAX_GLYPH_SLOT_INDEX` (SharedDefines.h) and stock `NUM_GLYPH_SLOTS` (Blizzard_GlyphUI.lua:19). */
export const FRAMEXML_GLYPH_SOCKETS = 6;
/** `CHAT_LINK_COLOR_GLYPH` (SharedDefines.h), as a chat colour escape. */
const GLYPH_LINK_COLOR = "|cff66bbff";

export const FRAMEXML_GLYPH_EVENTS = Object.freeze({
  added: "GLYPH_ADDED",
  removed: "GLYPH_REMOVED",
  updated: "GLYPH_UPDATED",
  use: "USE_GLYPH",
});

export interface FrameXmlGlyphRow {
  /** `GlyphProperties.SpellID`. */
  readonly spellId: number;
  /** `GlyphProperties.GlyphSlotFlags`, compared with `GlyphSlot.Type` exactly as the core does. */
  readonly slotFlags: number;
  /** `SpellIcon.TextureFilename`; empty when the row has no icon. */
  readonly icon: string;
}

export interface FrameXmlGlyphSlotRow {
  /** `GlyphSlot.Type`: 0 major, 1 minor. */
  readonly type: number;
}

/** The three client tables the frame reads, keyed as the wire keys them. */
export interface FrameXmlGlyphCatalog {
  glyph(id: number): FrameXmlGlyphRow | undefined;
  slot(id: number): FrameXmlGlyphSlotRow | undefined;
  /** The glyph a use spell with `SPELL_EFFECT_APPLY_GLYPH` inscribes; undefined for any other spell. */
  glyphForSpell(spellId: number): number | undefined;
}

/** The `/dbc/glyphs` answer (gateway/GlyphCatalog.ts `GlyphCatalog`) as the browser receives it. */
export interface FrameXmlGlyphCatalogData {
  readonly version: number;
  readonly glyphs: readonly { readonly id: number; readonly spellId: number; readonly slotFlags: number; readonly icon: string }[];
  readonly slots: readonly { readonly id: number; readonly type: number; readonly order: number }[];
  readonly itemSpells: readonly (readonly [number, number])[];
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Validate a catalog answer; undefined when its shape is not the route's. */
export function frameXmlGlyphCatalog(data: unknown, version: number): FrameXmlGlyphCatalog | undefined {
  if (!data || typeof data !== "object") return undefined;
  const value = data as Partial<FrameXmlGlyphCatalogData>;
  if (value.version !== version || !Array.isArray(value.glyphs) || !Array.isArray(value.slots)
    || !Array.isArray(value.itemSpells)) return undefined;
  const glyphs = new Map<number, FrameXmlGlyphRow>();
  for (const row of value.glyphs) {
    if (!row || !positiveInteger(row.id) || typeof row.spellId !== "number" || typeof row.slotFlags !== "number") continue;
    glyphs.set(row.id, Object.freeze({
      spellId: row.spellId, slotFlags: row.slotFlags, icon: typeof row.icon === "string" ? row.icon : "",
    }));
  }
  const slots = new Map<number, FrameXmlGlyphSlotRow>();
  for (const row of value.slots) {
    if (row && positiveInteger(row.id) && typeof row.type === "number") slots.set(row.id, Object.freeze({ type: row.type }));
  }
  const spells = new Map<number, number>();
  for (const pair of value.itemSpells) {
    if (Array.isArray(pair) && positiveInteger(pair[0]) && positiveInteger(pair[1])) spells.set(pair[0], pair[1]);
  }
  return Object.freeze({
    glyph: (id: number) => glyphs.get(id),
    slot: (id: number) => slots.get(id),
    glyphForSpell: (spellId: number) => spells.get(spellId),
  });
}

/** A glyph item in the bags, waiting for its socket. */
export interface FrameXmlGlyphItem {
  readonly guid: bigint;
  readonly bag: number;
  readonly slot: number;
  /** The `GlyphProperties` id its use spell inscribes. */
  readonly glyphId: number;
}

export interface FrameXmlGlyphHost {
  catalog(): FrameXmlGlyphCatalog | undefined;
  /** `PLAYER_GLYPHS_ENABLED`; undefined without the player's own object. */
  enabledMask(): number | undefined;
  /** `PLAYER_FIELD_GLYPH_SLOTS_1 + index`: the socket's `GlyphSlot` id. */
  slotId(index: number): number | undefined;
  /** The one-based active talent group (`SMSG_TALENTS_INFO` activeSpec + 1). */
  activeGroup(): number | undefined;
  /** The `GlyphProperties` id in socket `index` of one-based `group`; 0 empty, undefined unknown. */
  glyph(index: number, group: number): number | undefined;
  /** A resolved spell name (GetSpellInfo's first value). */
  spellName(spellId: number): string | undefined;
  /** The item is still in that bag slot. */
  holds(item: FrameXmlGlyphItem): boolean;
  /** `CMSG_USE_ITEM` with the zero-based socket in its glyph field. */
  place(item: FrameXmlGlyphItem, index: number): void;
  /** `CMSG_REMOVE_GLYPH` for the zero-based socket. */
  remove(index: number): void;
  /** Changes identity when the world session is replaced: the compare restarts without events. */
  session?(): unknown;
  /** Fetch the catalog once (the live host's `/dbc/glyphs`); absent when it is already in hand. */
  prepare?(): Promise<void>;
}

interface GlyphPump {
  fire(event: string, ...args: readonly unknown[]): number;
}

const NOTHING: readonly [] = Object.freeze([]);

function socketOf(value: unknown): number | undefined {
  const socket = Number(value);
  return Number.isInteger(socket) && socket >= 1 && socket <= FRAMEXML_GLYPH_SOCKETS ? socket : undefined;
}

/** Stock passes `PlayerTalentFrame.talentGroup`, nil before the talent UI exists: the active group. */
function groupOf(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const group = Number(value);
  return Number.isInteger(group) && group >= 1 ? group : 0;
}

/** One owner of the glyph C API, the glyph cursor and the GLYPH_* events. */
export class FrameXmlGlyphModel {
  readonly #host: FrameXmlGlyphHost;
  #pump: GlyphPump | undefined;
  #pending: FrameXmlGlyphItem | undefined;
  /** The active group's six glyph ids as last seen, compared (not rebuilt) every tick. */
  #seen: (number | undefined)[] | undefined;
  #session: unknown;
  #catalog: FrameXmlGlyphCatalog | undefined;
  /**
   * Stock GlyphFrame answers a glyph cursor (the lazy owner sets this true once the add-on is
   * reachable). While false a glyph item is used as any other item, with socket zero, as before.
   */
  owned = false;
  /** Set by the owner: the catalog landed while the frame may already be drawn from nils. */
  onCatalog: (() => void) | undefined;

  constructor(host: FrameXmlGlyphHost) {
    this.#host = host;
  }

  attach(pump: GlyphPump): void {
    this.detach();
    this.#pump = pump;
    this.#seen = undefined;
  }

  detach(): void {
    this.#pump = undefined;
    this.#pending = undefined;
    this.#seen = undefined;
  }

  /** Ask the host for its tables; the owner calls it once it hosts the glyph tab. Never rejects. */
  async prepare(): Promise<void> {
    try { await this.#host.prepare?.(); } catch { /* without the catalog every glyph value stays nil */ }
  }

  /** `GetGlyphSocketInfo(socket[, talentGroup])`: enabled, glyphType, glyphSpell, iconFilename. */
  socketInfo(socketArg: unknown, groupArg?: unknown): readonly unknown[] {
    const socket = socketOf(socketArg);
    const mask = this.#host.enabledMask();
    if (socket === undefined || mask === undefined) return NOTHING;
    const index = socket - 1;
    const enabled = ((mask >>> index) & 1) === 1;
    const catalog = this.#host.catalog();
    const slotType = this.#slotType(index, catalog);
    const glyphId = this.#glyphId(index, groupArg);
    const row = glyphId !== undefined && glyphId > 0 ? catalog?.glyph(glyphId) : undefined;
    return [
      enabled,
      slotType === undefined ? undefined : slotType + 1,
      row && row.spellId > 0 ? row.spellId : undefined,
      row && row.icon.length > 0 ? row.icon : undefined,
    ];
  }

  /** `GlyphMatchesSocket(socket)`: the waiting glyph is the socket's kind and the socket is open. */
  matches(socketArg: unknown): boolean {
    const socket = socketOf(socketArg);
    const pending = this.#pending;
    if (socket === undefined || !pending) return false;
    const mask = this.#host.enabledMask();
    if (mask === undefined || ((mask >>> (socket - 1)) & 1) !== 1) return false;
    const catalog = this.#host.catalog();
    const slotType = this.#slotType(socket - 1, catalog);
    const row = catalog?.glyph(pending.glyphId);
    // Spell::EffectApplyGlyph: `gp->GlyphSlotFlags != gs->Type` is SPELL_FAILED_INVALID_GLYPH.
    return slotType !== undefined && row !== undefined && row.slotFlags === slotType;
  }

  /** `PlaceGlyphInSocket(socket)`: inscribe the waiting glyph item; the realm decides the rest. */
  place(socketArg: unknown): void {
    const socket = socketOf(socketArg);
    const pending = this.#pending;
    if (socket === undefined || !pending) return;
    this.#pending = undefined;
    if (this.#host.holds(pending)) this.#host.place(pending, socket - 1);
  }

  /** `RemoveGlyphFromSocket(socket)`: CMSG_REMOVE_GLYPH; the core ignores an empty socket. */
  remove(socketArg: unknown): void {
    const socket = socketOf(socketArg);
    if (socket !== undefined) this.#host.remove(socket - 1);
  }

  /** `GetGlyphLink(socket[, talentGroup])`; nil for an empty socket or an unresolved name. */
  link(socketArg: unknown, groupArg?: unknown): string | undefined {
    const socket = socketOf(socketArg);
    if (socket === undefined) return undefined;
    const slotId = this.#host.slotId(socket - 1);
    const glyphId = this.#glyphId(socket - 1, groupArg);
    const row = glyphId !== undefined && glyphId > 0 ? this.#host.catalog()?.glyph(glyphId) : undefined;
    const name = row && row.spellId > 0 ? this.#host.spellName(row.spellId) : undefined;
    if (!positiveInteger(slotId) || !row || !name) return undefined;
    return `${GLYPH_LINK_COLOR}|Hglyph:${slotId}:${glyphId}|h[${name}]|h|r`;
  }

  /** A glyph item is waiting for its socket: stock's SpellIsTargeting. */
  get targeting(): FrameXmlGlyphItem | undefined { return this.#pending; }

  /**
   * UseContainerItem on a bag item: a glyph item raises the glyph cursor and USE_GLYPH instead of a
   * cast. False (the ordinary use goes out) while stock is not the owner, or for any other item.
   */
  useItem(item: { readonly guid: bigint; readonly bag: number; readonly slot: number; readonly spellId: number | undefined }): boolean {
    if (!this.owned || !this.#pump || item.spellId === undefined) return false;
    const glyphId = this.#host.catalog()?.glyphForSpell(item.spellId);
    if (glyphId === undefined) return false;
    this.#pending = Object.freeze({ guid: item.guid, bag: item.bag, slot: item.slot, glyphId });
    this.#pump.fire(FRAMEXML_GLYPH_EVENTS.use);
    return true;
  }

  /** SpellStopTargeting for the glyph cursor; true when there was one. */
  cancelTargeting(): boolean {
    if (!this.#pending) return false;
    this.#pending = undefined;
    return true;
  }

  /** Per-frame: the cursor's item is still there, the catalog's arrival, the active sockets' edges. */
  tick(): void {
    const pump = this.#pump;
    if (!pump) return;
    if (this.#pending && !this.#host.holds(this.#pending)) this.#pending = undefined;
    const catalog = this.#host.catalog();
    if (catalog !== this.#catalog) {
      this.#catalog = catalog;
      if (catalog) {
        try { this.onCatalog?.(); } catch { /* the next GlyphFrame_Update redraws from the same answers */ }
      }
    }
    const session = this.#host.session?.();
    const group = this.#host.activeGroup();
    const now: (number | undefined)[] = [];
    for (let index = 0; index < FRAMEXML_GLYPH_SOCKETS; index++) {
      now.push(group === undefined ? undefined : this.#host.glyph(index, group));
    }
    const seen = this.#seen;
    this.#seen = now;
    if (!seen || session !== this.#session) {
      this.#session = session;
      return;
    }
    for (let index = 0; index < FRAMEXML_GLYPH_SOCKETS; index++) {
      const before = seen[index];
      const after = now[index];
      // An unknown on either side (no packet yet) is not an edge: nothing was added or removed.
      if (before === undefined || after === undefined || before === after) continue;
      const event = before === 0 ? FRAMEXML_GLYPH_EVENTS.added
        : after === 0 ? FRAMEXML_GLYPH_EVENTS.removed : FRAMEXML_GLYPH_EVENTS.updated;
      pump.fire(event, index + 1);
    }
  }

  #slotType(index: number, catalog: FrameXmlGlyphCatalog | undefined): number | undefined {
    const slotId = this.#host.slotId(index);
    const type = positiveInteger(slotId) ? catalog?.slot(slotId)?.type : undefined;
    return type === 0 || type === 1 ? type : undefined;
  }

  #glyphId(index: number, groupArg: unknown): number | undefined {
    const requested = groupOf(groupArg);
    const group = requested ?? this.#host.activeGroup();
    if (group === undefined || group === 0) return undefined;
    const glyph = this.#host.glyph(index, group);
    return glyph !== undefined && Number.isSafeInteger(glyph) && glyph >= 0 ? glyph : undefined;
  }
}

export interface FrameXmlGlyphSeam extends FrameXmlTradeSkillHost {
  readonly glyphs?: FrameXmlGlyphModel | undefined;
}

export type FrameXmlGlyphBinding = (host: FrameXmlGlyphSeam, args: readonly unknown[]) => readonly unknown[];

const withGlyphs = (answer: (glyphs: FrameXmlGlyphModel, args: readonly unknown[]) => readonly unknown[],
  fallback: readonly unknown[] = NOTHING): FrameXmlGlyphBinding =>
  (host, args) => host.glyphs ? answer(host.glyphs, args) : fallback;

/**
 * The flat C API, spread into FRAMEXML_SEAM_BINDINGS after the trade skill's: the glyph cursor is the
 * client's one spell cursor too, so SpellIsTargeting/SpellStopTargeting answer for it first and hand
 * everything else to the enchant cursor and the native reticle (FrameXmlTradeSkill.ts). Stock
 * ToggleGameMenu stops at SpellStopTargeting, so Escape drops a waiting glyph before the menu opens.
 */
export const FRAMEXML_GLYPH_BINDINGS: Readonly<Record<string, FrameXmlGlyphBinding>> = Object.freeze({
  GetNumGlyphSockets: withGlyphs(() => [FRAMEXML_GLYPH_SOCKETS], [0]),
  GetGlyphSocketInfo: withGlyphs((glyphs, args) => glyphs.socketInfo(args[0], args[1])),
  GlyphMatchesSocket: withGlyphs((glyphs, args) => [glyphs.matches(args[0])], [false]),
  PlaceGlyphInSocket: withGlyphs((glyphs, args) => { glyphs.place(args[0]); return NOTHING; }),
  RemoveGlyphFromSocket: withGlyphs((glyphs, args) => { glyphs.remove(args[0]); return NOTHING; }),
  GetGlyphLink: withGlyphs((glyphs, args) => {
    const link = glyphs.link(args[0], args[1]);
    return link === undefined ? NOTHING : [link];
  }),
  SpellIsTargeting: (host, args) => host.glyphs?.targeting !== undefined
    ? [1] : FRAMEXML_TRADESKILL_BINDINGS.SpellIsTargeting!(host, args),
  SpellStopTargeting: (host, args) => host.glyphs?.cancelTargeting() === true
    ? [1] : FRAMEXML_TRADESKILL_BINDINGS.SpellStopTargeting!(host, args),
});
