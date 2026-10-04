/**
 * L7 1.28: which glyph items in the bags fit one socket of the native talent window, by the same
 * rules the stock glyph frame asks of `GlyphMatchesSocket` (FrameXmlGlyph.ts `matches`):
 *
 * - the socket is open (`PLAYER_GLYPHS_ENABLED`, one bit per zero-based index — `Player::InitGlyphsForLevel`);
 * - the item's use spell inscribes a glyph (`SPELL_EFFECT_APPLY_GLYPH`, the `/dbc/glyphs` catalog's
 *   item-spell map) whose `GlyphSlotFlags` equal the socket's `GlyphSlot.Type`
 *   (`Spell::EffectApplyGlyph`, SpellEffects.cpp:4153-4160: otherwise SPELL_FAILED_INVALID_GLYPH);
 * - the glyph is not inscribed already (`Spell::CheckCast`, Spell.cpp:5840-5849: SPELL_FAILED_UNIQUE_GLYPH).
 *
 * The native window then sends that item's `CMSG_USE_ITEM` with the chosen socket in its glyph field
 * (`WorldClient.useGlyphItem`), as stock `PlaceGlyphInSocket` does — instead of using whichever bag
 * item happened to have «символ» in its name, with socket 0.
 */

import { frameXmlGlyphCatalog, type FrameXmlGlyphCatalog } from "../framexml/FrameXmlGlyph.js";
import { FRAMEXML_GLYPH_CATALOG_PATH, FRAMEXML_GLYPH_CATALOG_VERSION } from "../framexml/FrameXmlGlyphLive.js";

export interface GlyphBagItem {
  readonly guid: bigint;
  readonly bag: number;
  readonly slot: number;
  /** The item's on-use spell (`itemUseSpellId`), undefined when its template is not known yet. */
  readonly useSpellId: number | undefined;
}

export interface GlyphChoice {
  readonly item: GlyphBagItem;
  /** `GlyphProperties` id. */
  readonly glyphId: number;
  /** `GlyphProperties.SpellID`: the glyph's own spell, for its name. */
  readonly spellId: number;
}

export interface GlyphSocketView {
  /** Bit `index` of `PLAYER_GLYPHS_ENABLED`. */
  readonly enabled: boolean;
  /** `PLAYER_FIELD_GLYPH_SLOTS_1 + index`: the socket's `GlyphSlot` id. */
  readonly slotId: number | undefined;
}

/** The glyph items that fit the socket, one per glyph, in bag order. */
export function glyphChoicesForSocket(
  catalog: FrameXmlGlyphCatalog | undefined, items: readonly GlyphBagItem[], socket: GlyphSocketView,
  inscribed: readonly number[],
): GlyphChoice[] {
  if (!catalog || !socket.enabled || socket.slotId === undefined) return [];
  const slotType = catalog.slot(socket.slotId)?.type;
  if (slotType === undefined) return [];
  const choices: GlyphChoice[] = [];
  const seen = new Set<number>();
  for (const item of items) {
    if (item.useSpellId === undefined) continue;
    const glyphId = catalog.glyphForSpell(item.useSpellId);
    if (glyphId === undefined || seen.has(glyphId) || inscribed.includes(glyphId)) continue;
    const row = catalog.glyph(glyphId);
    if (!row || row.slotFlags !== slotType) continue;
    seen.add(glyphId);
    choices.push({ item, glyphId, spellId: row.spellId });
  }
  return choices;
}

let catalog: FrameXmlGlyphCatalog | undefined;
let pending: Promise<FrameXmlGlyphCatalog | undefined> | undefined;

/** The catalog once fetched for the native window; the stock frame fetches its own copy. */
export function nativeGlyphCatalog(): FrameXmlGlyphCatalog | undefined {
  return catalog;
}

/** Fetches `/dbc/glyphs` once; resolves undefined when the route is missing or answers garbage. */
export function loadNativeGlyphCatalog(
  origin: string | undefined, fetcher: typeof globalThis.fetch = globalThis.fetch.bind(globalThis),
): Promise<FrameXmlGlyphCatalog | undefined> {
  if (catalog || !origin) return Promise.resolve(catalog);
  pending ??= (async () => {
    try {
      const response = await fetcher(new URL(FRAMEXML_GLYPH_CATALOG_PATH, origin).href);
      const data = response.ok ? await response.json() as unknown : undefined;
      catalog = frameXmlGlyphCatalog(data, FRAMEXML_GLYPH_CATALOG_VERSION) ?? catalog;
    } catch {
      // No catalog: the socket offers nothing rather than guessing at an item.
    } finally {
      pending = undefined;
    }
    return catalog;
  })();
  return pending;
}
