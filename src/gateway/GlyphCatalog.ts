// What the stock glyph window (Blizzard_GlyphUI) reads from the client's own tables.
//
// `SMSG_TALENTS_INFO` and the player's update fields carry numbers only: a `GlyphProperties` id per
// socket (PLAYER_FIELD_GLYPHS_1, the packet's glyph section) and a `GlyphSlot` id per socket
// (PLAYER_FIELD_GLYPH_SLOTS_1, which `Player::InitGlyphsForLevel` fills from GlyphSlot.dbc). What the
// client answers GetGlyphSocketInfo with — major or minor, the glyph's spell and its rune picture —
// is those two tables plus SpellIcon.dbc. Which bag item is a glyph is Spell.dbc: an item's use spell
// with `SPELL_EFFECT_APPLY_GLYPH` names its glyph in the effect's MiscValue (SpellEffects.cpp
// `Spell::EffectApplyGlyph`). The browser asks for all of it once, the first time a world opens.
//
// GlyphProperties and GlyphSlot are not in the generated DBC_LAYOUTS; they are read with the layouts
// TrinityCore's DBCfmt.h declares for build 12340 (`GlyphPropertiesfmt = "niii"`, `GlyphSlotfmt =
// "nii"`) and each header is checked against them. The field order is DBCStructure.h's:
// GlyphPropertiesEntry {ID, SpellID, GlyphSlotFlags, SpellIconID}, GlyphSlotEntry {ID, Type, Tooltip}.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DbcError, openDbcFile } from "./Dbc.js";

/** The route's shape; the browser asks `?v=` this and refuses another. */
export const GLYPH_CATALOG_VERSION = 1;

/** `SPELL_EFFECT_APPLY_GLYPH` (SharedDefines.h). */
export const SPELL_EFFECT_APPLY_GLYPH = 74;
const SPELL_EFFECTS = 3;

export interface GlyphCatalogGlyph {
  /** `GlyphProperties.ID`: what the socket fields and the talents packet carry. */
  id: number;
  /** The aura the glyph casts on the player (`SpellID`); its name is the glyph's. */
  spellId: number;
  /** `GlyphSlotFlags`: compared with `GlyphSlot.Type` by the core (0 major, 1 minor). */
  slotFlags: number;
  /** `SpellIcon.TextureFilename` of `SpellIconID`; empty when the row has none. */
  icon: string;
}

export interface GlyphCatalogSlot {
  /** `GlyphSlot.ID`: what PLAYER_FIELD_GLYPH_SLOTS_1..6 hold. */
  id: number;
  /** 0 major, 1 minor (`GlyphSlotEntry::Type`). */
  type: number;
  /** `Tooltip`: the socket's one-based position (`SetGlyphSlot(gs->Tooltip - 1, gs->ID)`). */
  order: number;
}

export interface GlyphCatalog {
  version: number;
  glyphs: GlyphCatalogGlyph[];
  slots: GlyphCatalogSlot[];
  /** `[spellId, glyphId]` for every spell with `SPELL_EFFECT_APPLY_GLYPH`: a glyph item's use spell. */
  itemSpells: [number, number][];
}

/** `GlyphPropertiesfmt` "niii": ID, SpellID, GlyphSlotFlags, SpellIconID. */
export const GLYPH_PROPERTIES_LAYOUT = Object.freeze({ fieldCount: 4, recordSize: 16 });
/** `GlyphSlotfmt` "nii": ID, Type, Tooltip. */
export const GLYPH_SLOT_LAYOUT = Object.freeze({ fieldCount: 3, recordSize: 12 });

interface RawRows {
  readonly records: number;
  int(row: number, field: number): number;
}

async function readFixed(
  dbcDirectory: string, table: string, layout: { fieldCount: number; recordSize: number },
): Promise<RawRows | undefined> {
  const data = await readFile(join(dbcDirectory, `${table}.dbc`)).catch(() => undefined);
  if (!data) return undefined;
  if (data.byteLength < 20 || data.subarray(0, 4).toString("latin1") !== "WDBC") {
    throw new DbcError(`${table}: not a WDBC file`);
  }
  const records = data.readUInt32LE(4);
  const fields = data.readUInt32LE(8);
  const recordSize = data.readUInt32LE(12);
  if (fields !== layout.fieldCount || recordSize !== layout.recordSize
    || data.byteLength < 20 + records * recordSize) {
    throw new DbcError(`${table}: the file has ${fields} fields of ${recordSize} bytes, but DBCfmt.h `
      + `declares ${layout.fieldCount} of ${layout.recordSize} for build 12340`);
  }
  return {
    records,
    int: (row, field) => data.readInt32LE(20 + row * recordSize + field * 4),
  };
}

export async function loadGlyphCatalog(dbcDirectory: string): Promise<GlyphCatalog> {
  const [properties, slots, spellIcon, spell] = await Promise.all([
    readFixed(dbcDirectory, "GlyphProperties", GLYPH_PROPERTIES_LAYOUT),
    readFixed(dbcDirectory, "GlyphSlot", GLYPH_SLOT_LAYOUT),
    openDbcFile(dbcDirectory, "SpellIcon"),
    openDbcFile(dbcDirectory, "Spell"),
  ]);
  const icons = new Map<number, string>();
  for (const row of spellIcon.rows()) icons.set(spellIcon.id(row), spellIcon.string(row, "TextureFilename"));

  const glyphs: GlyphCatalogGlyph[] = [];
  for (let row = 0; row < (properties?.records ?? 0); row++) {
    const id = properties!.int(row, 0);
    if (id <= 0) continue;
    glyphs.push({
      id,
      spellId: properties!.int(row, 1),
      slotFlags: properties!.int(row, 2),
      icon: icons.get(properties!.int(row, 3)) ?? "",
    });
  }
  const slotRows: GlyphCatalogSlot[] = [];
  for (let row = 0; row < (slots?.records ?? 0); row++) {
    const id = slots!.int(row, 0);
    if (id > 0) slotRows.push({ id, type: slots!.int(row, 1), order: slots!.int(row, 2) });
  }
  const itemSpells: [number, number][] = [];
  for (const row of spell.rows()) {
    for (let effect = 0; effect < SPELL_EFFECTS; effect++) {
      if (spell.int(row, "Effect", effect) !== SPELL_EFFECT_APPLY_GLYPH) continue;
      const glyph = spell.int(row, "EffectMiscValue", effect);
      if (glyph > 0) itemSpells.push([spell.id(row), glyph]);
    }
  }
  return { version: GLYPH_CATALOG_VERSION, glyphs, slots: slotRows, itemSpells };
}
