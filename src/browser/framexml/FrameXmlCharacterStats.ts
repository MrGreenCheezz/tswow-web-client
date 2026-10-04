import { isCharacterStatCatalog, type CharacterStatCatalog } from "../../world/CharacterStatData.js";
import { fetchCreationWithClassFlags } from "../ui/CharacterCreation.js";
import { creationClassFilesLearned, learnCreationNames } from "../ui/UnitSnapshot.js";

/**
 * `/dbc/character-creation` at the version the glue screens read (`GlueNames.ts`'s
 * `GLUE_CREATION_VERSION`), so a session that did pass the glue front door reuses the browser's
 * cached answer instead of fetching a second shape of the same route. `tests/` pins the two
 * numbers together; the constant is not imported because `GlueNames.ts` pulls the 3D atlas in.
 */
export const FRAMEXML_CREATION_NAMES_PATH = "/dbc/character-creation?v=4";

/**
 * Make sure the dataset's `ChrClasses.Filename`/`ChrRaces.ClientFileString` rows are learned.
 *
 * A TSWoW class has no compiled token: the owner's HERO is class 13 and ARCHAEOLOGIST class 12 on
 * this dataset, both served by this route and neither known to the compiled ten. Stock
 * `PaperDollFrame_SetStat` (PaperDollFrame.lua:268-269) runs `strupper(select(2,
 * UnitClass("player")))` without a nil guard, so without the list the whole stat pane aborts after
 * «Сила» and the level line prints «nil». The glue and the DOM creation screen already learn it;
 * this covers a world entry that passed neither. Failure is reported, never thrown: the stat catalog
 * beside it must still load.
 */
export async function ensureFrameXmlCreationNames(
  gatewayOrigin: string, doFetch: typeof globalThis.fetch = globalThis.fetch.bind(globalThis),
): Promise<boolean> {
  if (creationClassFilesLearned()) return true;
  try {
    // Past the browser cache once when the answer predates the class flags (review 30.09).
    const value = await fetchCreationWithClassFlags(new URL(FRAMEXML_CREATION_NAMES_PATH, gatewayOrigin).href, doFetch);
    if (!value) return false;
    learnCreationNames(value.races, value.classes);
    return creationClassFilesLearned();
  } catch {
    return false;
  }
}

/**
 * Load before stock PaperDoll initializes its mana-class intellect tooltip.
 *
 * The world mount awaits this before the FrameXML boot, which makes it the one place that also
 * guarantees the class-token list is present when `VARIABLES_LOADED` and the first
 * `PaperDollFrame_UpdateStats` ask `UnitClass("player")`. Both requests run in parallel.
 */
export async function loadFrameXmlCharacterStats(
  gatewayOrigin: string, doFetch: typeof globalThis.fetch = globalThis.fetch.bind(globalThis),
): Promise<CharacterStatCatalog> {
  const names = ensureFrameXmlCreationNames(gatewayOrigin, doFetch);
  try {
    // Version the cache key when adding rating tables; the gateway's public response lives for an hour.
    const response = await doFetch(new URL("/dbc/character-stats?version=2", gatewayOrigin).href);
    if (!response.ok) throw new Error(`Character stat gateway returned ${response.status}`);
    const catalog: unknown = await response.json();
    if (!isCharacterStatCatalog(catalog)) throw new Error("Character stat gateway returned an invalid catalog");
    return catalog;
  } finally {
    await names;
  }
}
