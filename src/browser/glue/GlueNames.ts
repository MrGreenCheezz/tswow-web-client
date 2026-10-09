import { AreaClient } from "../AreaClient.js";
import { CHARACTER_OPTIONS_VERSION, isCharacterOptions, type CharacterOptions } from "../CharacterAtlas.js";
import { fetchCreationWithClassFlags, raceDisplayId, type CharacterCreationData } from "../ui/CharacterCreation.js";
import { learnCreationNames } from "../ui/UnitSnapshot.js";
import type { StartOutfitItem } from "../../gateway/CharStartOutfit.js";
import type { GlueCreationSource, GlueCreationTables } from "./GlueCreation.js";
import type { GlueNameLookup } from "./GlueSession.js";

/**
 * The words, the display ids and the per-profile answers both glue screens need, from this
 * gateway's own tables.
 *
 * Not a compiled table of ten races: `GetCharacterInfo` hands the corpus a class *name* and a zone
 * *name* — `CHARACTER_SELECT_INFO` prints them — and on a tswow server both can be a custom row
 * that no table written here would know. `/dbc/character-creation` answers the first two and carries
 * `maleDisplayId`/`femaleDisplayId` with them, which is also what the 3D needs; `/dbc/areas` answers
 * the third and is the same request the minimap already makes.
 *
 * The creation screen adds two more, and both are per profile rather than per session, so they are
 * asked when a profile is chosen and cached by `GlueCreation`: `/dbc/character-options` for the five
 * appearance axes and `/dbc/char-start-outfit` for what a new character is wearing.
 *
 * The session-wide tables are asked for once and neither is waited on. Until they land the list
 * draws with an empty zone and a numbered class, and `onLoaded` fires CHARACTER_LIST_UPDATE so the
 * corpus redraws itself — the same shape `Login.ts` uses for its cards.
 */

/**
 * `/dbc/character-creation` version this page reads.
 *
 * `v=3` is the race rows gaining `clientFileString`, `hairCustomization` and
 * `facialHairCustomization` — the three `CharacterCreate.lua` indexes GlueStrings with. The route
 * answers `max-age=3600`, so without a new query string a browser that asked while `v=2` was
 * current would go on being served an answer with no file token, and every race button would look
 * up `RACE_ICON_TCOORDS[nil]`.
 *
 * The race and class rows also carry `nameMale`/`nameFemale` now (10.09): the character list names a
 * character's race and class by its sex, as `GetCharacterInfo` does. Added without a version bump,
 * because `FrameXmlCharacterStats.FRAMEXML_CREATION_NAMES_PATH` shares this version (a test pins
 * the two together) and is another lane's file; both are optional, so a gateway not yet restarted, or
 * a cached answer (`max-age=3600`), just prints `name` for either sex until it refreshes.
 *
 * `v=4` is the class rows gaining `flags` (ChrClasses.Flags — the relic slot, 1.15) and
 * `spellClassSet` (the SPELLMOD family, 1.14b), bumped together with
 * `FRAMEXML_CREATION_NAMES_PATH`. Both are optional: a gateway not yet restarted answers `v=4`
 * with the `v=3` shape (the route does not read the query), and the readers fall back; such an answer
 * cached from before the restart is asked once more past the cache (`fetchCreationWithClassFlags`).
 */
export const GLUE_CREATION_VERSION = 4;

/** A race or class row's names; the sexed two only from a gateway that has 10.09. */
interface SexedName {
  readonly name: string;
  readonly nameMale?: string;
  readonly nameFemale?: string;
}

/**
 * The name the character list prints for a sex: 0 male, 1 female, as the wire says. Without a sex
 * (the creation lists, the world) it is `Name_lang`, which is what those always showed.
 */
export function sexedName(row: SexedName | undefined, sex?: number): string | undefined {
  if (!row) return undefined;
  if (sex === 0) return row.nameMale || row.name;
  if (sex === 1) return row.nameFemale || row.name;
  return row.name;
}

/** `/dbc/char-start-outfit` version. `v=1` is the route's first shape. */
export const CHAR_START_OUTFIT_VERSION = 1;

export class GlueGatewayNames implements GlueNameLookup, GlueCreationSource {
  readonly #areas: AreaClient;
  readonly #origin: string;
  #creation: CharacterCreationData | undefined;
  #pending: Promise<void> | undefined;
  #races = new Map<number, SexedName>();
  #classes = new Map<number, SexedName>();

  /** Called when either table arrives, so whatever is on screen can be drawn again. */
  onLoaded: (() => void) | undefined;

  constructor(gatewayOrigin: string) {
    this.#origin = gatewayOrigin.replace(/\/+$/, "");
    this.#areas = new AreaClient(gatewayOrigin);
    this.#areas.onLoaded = () => { this.onLoaded?.(); };
  }

  /**
   * Starts both fetches. Safe to call more than once; each underlying client asks once.
   *
   * The returned promise settles when the creation tables have landed (or failed), because the
   * creation screen lays its two lists out **once**, inside `CharacterCreate_OnShow` — a screen
   * opened before the tables arrive has no races to enumerate and no way to re-run that OnShow by
   * itself. The caller waits on it with a bound rather than depending on it.
   */
  load(): Promise<void> {
    this.#areas.load();
    this.#pending ??= (async () => {
      const data = await this.fetchCreation();
      if (!data) return;
      this.#creation = data;
      this.#races = new Map(data.races.map((race) => [race.id, race]));
      this.#classes = new Map(data.classes.map((entry) => [entry.id, entry]));
      // The world quest/NPC formatter reads UnitSnapshot's shared class/race names. The stock
      // Glue login has its own lookup, so without this bridge a custom class falls back to its id
      // after entering the world even though Glue already loaded its ChrClasses row.
      learnCreationNames(data.races, data.classes);
      this.onLoaded?.();
    })();
    return this.#pending;
  }

  /**
   * `/dbc/character-creation?v=4` (`GLUE_CREATION_VERSION`).
   *
   * Its own fetch rather than `ui/CharacterCreation.ts`'s, because that one is the DOM login page's
   * and asks at `v=2`; the two pages read different shapes of the same route and must not share a
   * cache entry. The validator and the display-id rule are still that module's — those are the
   * parts that would drift if they were written twice.
   */
  private async fetchCreation(): Promise<CharacterCreationData | undefined> {
    try {
      // Past the browser cache once when the answer predates the class flags (review 30.09).
      return await fetchCreationWithClassFlags(`${this.#origin}/dbc/character-creation?v=${GLUE_CREATION_VERSION}`);
    } catch {
      return undefined;
    }
  }

  /** What the creation screen draws its two lists from; empty until the table lands. */
  tables(): GlueCreationTables {
    return { races: this.#creation?.races ?? [], classes: this.#creation?.classes ?? [] };
  }

  raceName(race: number, sex?: number): string {
    return sexedName(this.#races.get(race), sex) || `Раса ${race}`;
  }

  className(classId: number, sex?: number): string {
    return sexedName(this.#classes.get(classId), sex) || `Класс ${classId}`;
  }

  zoneName(zone: number): string {
    return this.#areas.area(zone)?.name ?? "";
  }

  raceDisplayId(race: number, sex: number): number | undefined {
    return raceDisplayId(this.#creation?.races.find((row) => row.id === race), sex);
  }

  /** `GlueCreationSource`: the same lookup under the name that interface uses. */
  displayId(race: number, sex: number): number | undefined {
    return this.raceDisplayId(race, sex);
  }

  /** The five appearance axes the selected race, sex and class may create. */
  async options(race: number, sex: number, classId?: number): Promise<CharacterOptions | undefined> {
    try {
      const classQuery = classId === undefined ? "" : `&class=${classId}`;
      const response = await fetch(
        `${this.#origin}/dbc/character-options?v=${CHARACTER_OPTIONS_VERSION}&race=${race}&sex=${sex}${classQuery}`);
      if (!response.ok) throw new Error(`character options returned ${response.status}`);
      const answer = await response.json() as unknown;
      // An answer this bundle cannot read is no answer: the five arrows go dead rather than
      // cycling through a shape they do not understand.
      return isCharacterOptions(answer) ? answer : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * What a new character of this profile is wearing.
   *
   * An empty list on any failure and deliberately not a throw: a gateway that predates
   * `/dbc/char-start-outfit` answers 404, and an undressed preview is what this screen looked like
   * before the route existed — a working screen, not a broken one.
   */
  async startOutfit(race: number, classId: number, sex: number): Promise<readonly StartOutfitItem[]> {
    try {
      const response = await fetch(`${this.#origin}/dbc/char-start-outfit`
        + `?v=${CHAR_START_OUTFIT_VERSION}&race=${race}&class=${classId}&sex=${sex}`);
      if (!response.ok) throw new Error(`char start outfit returned ${response.status}`);
      const answer = await response.json() as unknown;
      return isStartOutfit(answer) ? answer : [];
    } catch {
      return [];
    }
  }
}

/**
 * Whether the answer is shaped like the route's, before anything is worn out of it.
 *
 * Tolerant on purpose, the way `isCreationData` is: a row missing a field is dropped and the rest
 * are kept, because half an outfit is closer to the original than none. The bounds are the ones
 * `/dbc/character-appearance` will apply to the same numbers anyway, so a value that could only be
 * refused there is refused here instead of making a request that cannot succeed.
 */
export function isStartOutfit(value: unknown): value is StartOutfitItem[] {
  return Array.isArray(value) && value.every((entry) => {
    if (typeof entry !== "object" || entry === null) return false;
    const item = entry as Partial<StartOutfitItem>;
    return Number.isInteger(item.displayId) && (item.displayId ?? 0) > 0
      && Number.isInteger(item.inventoryType) && (item.inventoryType ?? -1) >= 0
      && Number.isInteger(item.slot) && (item.slot ?? -1) >= 0 && (item.slot ?? 99) <= 18;
  });
}
