/**
 * The offline glyph fixture for the canned world: an arcane mage's two sockets filled, measured rows
 * of this dataset's GlyphProperties.dbc / GlyphSlot.dbc / Spell.dbc (the `/dbc/glyphs` catalog, read
 * through gateway/GlyphCatalog.ts), and a realm stand-in that answers PlaceGlyphInSocket and
 * RemoveGlyphFromSocket with the core's own rules (`Spell::EffectApplyGlyph`,
 * `WorldSession::HandleRemoveGlyph`), so the stock window can be driven with no server.
 */
import {
  FRAMEXML_GLYPH_SOCKETS, FrameXmlGlyphModel, frameXmlGlyphCatalog, type FrameXmlGlyphCatalogData,
} from "./FrameXmlGlyph.js";

/** Measured rows (GlyphProperties 319/322/451, GlyphSlot 21-26, the three glyph items' use spells). */
export const CANNED_GLYPH_CATALOG: FrameXmlGlyphCatalogData = Object.freeze({
  version: 1,
  glyphs: Object.freeze([
    Object.freeze({ id: 319, spellId: 56370, slotFlags: 0, icon: "Interface\\Spellbook\\UI-Glyph-Rune-11" }),
    Object.freeze({ id: 322, spellId: 56377, slotFlags: 0, icon: "Interface\\Spellbook\\UI-Glyph-Rune-20" }),
    Object.freeze({ id: 451, spellId: 57925, slotFlags: 1, icon: "Interface\\Spellbook\\UI-Glyph-Rune-20" }),
  ]),
  slots: Object.freeze([
    Object.freeze({ id: 21, type: 0, order: 1 }), Object.freeze({ id: 22, type: 1, order: 2 }),
    Object.freeze({ id: 23, type: 1, order: 3 }), Object.freeze({ id: 24, type: 0, order: 4 }),
    Object.freeze({ id: 25, type: 1, order: 5 }), Object.freeze({ id: 26, type: 0, order: 6 }),
  ]),
  itemSpells: Object.freeze([
    Object.freeze([56590, 319] as const), Object.freeze([56593, 322] as const), Object.freeze([58241, 451] as const),
  ]),
});

/** Spell.dbc `Name_lang` (ruRU) of the three glyph spells. */
const CANNED_GLYPH_SPELL_NAMES: ReadonlyMap<number, string> = new Map([
  [56370, "Символ ледяной стрелы"],
  [56377, "Символ ледяного копья"],
  [57925, "Символ замедленного падения"],
]);

/** `Player::InitGlyphsForLevel`: the sockets a level opens (15: 0,1; 30: 3; 50: 2; 70: 4; 80: 5). */
export function frameXmlGlyphEnabledMask(level: number): number {
  let value = 0;
  if (level >= 15) value |= 0x01 | 0x02;
  if (level >= 30) value |= 0x08;
  if (level >= 50) value |= 0x04;
  if (level >= 70) value |= 0x10;
  if (level >= 80) value |= 0x20;
  return value;
}

export interface CannedFrameXmlGlyphWorld {
  /** What the stand-in realm was asked, in order. */
  readonly sent: readonly (readonly ["place", number, number] | readonly ["remove", number])[];
  /** Use the canned glyph item whose use spell is `spellId` (56590, 56593, 58241). */
  use(spellId: number): boolean;
  /** The glyph ids of the active group's six sockets. */
  sockets(): readonly number[];
}

export interface CannedFrameXmlGlyphs {
  readonly model: FrameXmlGlyphModel;
  readonly world: CannedFrameXmlGlyphWorld;
}

export function createCannedFrameXmlGlyphs(level: () => number | undefined): CannedFrameXmlGlyphs {
  const catalog = frameXmlGlyphCatalog(CANNED_GLYPH_CATALOG, CANNED_GLYPH_CATALOG.version);
  const slots = CANNED_GLYPH_CATALOG.slots.map((slot) => slot.id);
  const glyphs = [319, 451, 0, 0, 0, 0];
  const sent: (readonly ["place", number, number] | readonly ["remove", number])[] = [];
  const mask = (): number | undefined => {
    const value = level();
    return value === undefined ? undefined : frameXmlGlyphEnabledMask(value);
  };
  const model = new FrameXmlGlyphModel({
    catalog: () => catalog,
    enabledMask: mask,
    slotId: (index) => slots[index],
    activeGroup: () => 1,
    glyph: (index, group) => group === 1 && index >= 0 && index < FRAMEXML_GLYPH_SOCKETS ? glyphs[index] : undefined,
    spellName: (spellId) => CANNED_GLYPH_SPELL_NAMES.get(spellId),
    holds: () => true,
    place: (item, index) => {
      sent.push(["place", item.glyphId, index]);
      // Spell::EffectApplyGlyph: the level lock, then the kind; a refused glyph changes nothing.
      const open = ((mask() ?? 0) >>> index) & 1;
      const row = catalog?.glyph(item.glyphId);
      const slot = catalog?.slot(slots[index] ?? 0);
      if (open !== 1 || !row || !slot || row.slotFlags !== slot.type) return;
      glyphs[index] = item.glyphId;
    },
    remove: (index) => {
      sent.push(["remove", index]);
      if (index >= 0 && index < FRAMEXML_GLYPH_SOCKETS) glyphs[index] = 0;
    },
  });
  let guid = 0x4700n;
  return {
    model,
    world: {
      sent,
      use: (spellId) => model.useItem({ guid: guid++, bag: 0, slot: 1, spellId }),
      sockets: () => [...glyphs],
    },
  };
}
