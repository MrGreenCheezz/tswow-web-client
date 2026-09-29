// The icons a macro can wear, as the stock macro window lists them.
//
// Blizzard_MacroUI's icon picker walks `GetMacroIconInfo(1..GetNumMacroIcons())` and the guild bank
// tab picker `GetMacroItemIconInfo`; both lists are client data, so they are read here from the
// dataset's own tables and sent whole, once, when the window first opens. Measured on the tswow
// dataset: SpellIcon.dbc's 3,342 rows hold 3,182 distinct `Interface\Icons\` textures (137 repeat
// one another, 23 point elsewhere) and ItemDisplayInfo.dbc's 58,101 rows 4,761 distinct inventory
// icons. Names travel without the `Interface\Icons\` prefix: both lists are 187,401 bytes of JSON,
// where the spell list with its prefixes was 138,983 bytes alone.
//
// Order is the tables' row order, first spelling of a name kept, with the question mark moved to the
// front: the client's first macro icon is INV_Misc_QuestionMark (a new macro starts on index 1,
// MacroPopupFrame_OnShow → MacroPopupButton_SelectTexture(1)).

import { openDbcFile } from "./Dbc.js";

const ICON_PREFIX = /^interface\\icons\\/i;
const QUESTION_MARK = "INV_Misc_QuestionMark";

export interface MacroIconCatalog {
  /** Spell icons, texture names under `Interface\Icons\`, the question mark first. */
  spell: string[];
  /** Item inventory icons, same form. */
  item: string[];
}

function distinct(names: Iterable<string>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const name of names) {
    // A name must survive the trip back into a texture path: one path segment, printable.
    if (!/^[\x21-\x7e][\x20-\x7e]{0,127}$/.test(name) || /[\\/]/.test(name)) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(name);
  }
  return result;
}

export async function loadMacroIcons(dbcDirectory: string): Promise<MacroIconCatalog> {
  const [spellIcon, display] = await Promise.all([
    openDbcFile(dbcDirectory, "SpellIcon"),
    openDbcFile(dbcDirectory, "ItemDisplayInfo"),
  ]);
  const spell = distinct((function* () {
    yield QUESTION_MARK;
    for (const row of spellIcon.rows()) {
      const path = spellIcon.string(row, "TextureFilename");
      if (ICON_PREFIX.test(path)) yield path.replace(ICON_PREFIX, "");
    }
  })());
  const item = distinct((function* () {
    for (const row of display.rows()) {
      const name = display.string(row, "InventoryIcon", 0);
      if (name) yield name;
    }
  })());
  return { spell, item };
}
