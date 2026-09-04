import { openDbcFile } from "./Dbc.js";

/**
 * The three tables the character-creation screen is made of, which nothing in this client read.
 *
 * `RACE_NAMES` and `CLASS_NAMES` in `ui/UnitSnapshot.ts` were ten hand-written entries each, and
 * the creation form was built from them — so a race or a class a module adds was unselectable,
 * unnamed and, on a frame or a tooltip, printed as its number. `ChrRaces`, `ChrClasses` and
 * `CharBaseInfo` are vendored under `tools/dbd/` and were read by nothing but `ClientPrefix`.
 *
 * Served whole and once, the arrangement `/dbc/talents` and `/dbc/areas` use: re-measured on this
 * dataset after G1 added the two display-id columns, the payload is 4,876 bytes for 21 races, 10
 * classes and 62 pairs — 924 of those bytes are the new columns — and the three tables take 1.74 ms
 * to read. Smaller and cheaper than the question of whether to page it.
 *
 * Three column facts are worth stating because none of them is what its name suggests:
 *
 * * `ChrRaces.Flags` bit 0 means **not** playable rather than playable —
 *   `CHRRACES_FLAGS_NOT_PLAYABLE = 0x01` in the core this server runs (`DBCStructure.h:413-418`).
 *   Measured over all 21 rows of this dataset: the bit is clear on exactly the ten races the
 *   original creation screen offers and set on the other eleven, so reading it the other way round
 *   would offer goblins and fel orcs and hide every playable race.
 * * `ChrRaces.Alliance` is a side and a second playability signal at once: 0 Alliance, 1 Horde,
 *   2 *not playable* (`CHRRACES_ALLIANCE_TYPE_*`, same header). It agrees with the flag on all 21
 *   rows here, which is why `side` is carried as it stands rather than folded into `playable`.
 * * `ChrClasses` in 3.3.5 has **no class mask and no playable flag**. The mask every other table
 *   spells `1 << (id - 1)` — `TalentTab.ClassMask` is read exactly that way — and whether a class
 *   can be created is `CharBaseInfo`'s to say, so both are computed here rather than looked up.
 */

export interface CreationRace {
  id: number;
  /** `Name_lang` in the gateway's locale, which is what the form shows. */
  name: string;
  /** `ClientPrefix`: the two letters a race's own art is named with, e.g. `Hu`, `Ta`. */
  clientPrefix: string;
  /**
   * `ClientFileString`: `Human`, `NightElf`, `Scourge` — the token the creation screen keys on.
   *
   * Not a synonym for `clientPrefix`. `CharacterCreate.lua` upper-cases what `GetNameForRace()`
   * returns second and looks up `RACE_ICON_TCOORDS[fileString.."_"..gender]`, `RACE_INFO_<FILE>`
   * and `ABILITY_INFO_<FILE><n>` with it (`:315`, `:317`, `:319`), and `GlueParent.lua`'s
   * `SetBackgroundModel` builds `Interface\Glues\Models\UI_<name>\UI_<name>.m2` out of it. `Hu`
   * would miss every one of those.
   */
  clientFileString: string;
  /**
   * `HairCustomization` and `FacialHairCustomization[2]`: the words the customisation buttons use.
   *
   * `CharacterCreate_UpdateHairCustomization` (`:511-515`) prints
   * `HAIR_<GetHairCustomization()>_STYLE`, `HAIR_<…>_COLOR` and
   * `FACIAL_HAIR_<GetFacialHairCustomization()>`, so these are keys into `GlueStrings`, not
   * decoration. Measured on this dataset: `NORMAL` for every playable race's hair, and the facial
   * pair runs `NORMAL`/`NORMAL` for humans through `HORNS`/`HORNS` for tauren and
   * `MARKINGS`/`FEATURES` for the two draenei sexes — the array's two elements are male and female.
   */
  hairCustomization: string;
  facialHairCustomization: [string, string];
  /** `(Flags & CHRRACES_FLAGS_NOT_PLAYABLE) === 0`. */
  playable: boolean;
  /** `Alliance`: 0 Alliance, 1 Horde, 2 neither — a race no one can create. */
  side: number;
  factionId: number;
  /** `BaseLanguage`: 7 for Alliance races and 1 for Horde ones, as the core's comment says. */
  baseLanguage: number;
  /** `Required_expansion`: 0 vanilla, 1 Burning Crusade, 2 Wrath. */
  expansion: number;
  /**
   * `MaleDisplayID` and `FemaleDisplayID`: which `CreatureDisplayInfo` row a new character of this
   * race and sex is drawn from.
   *
   * The pair the original creation screen builds its 3D preview out of, and the one thing the form
   * could not do without: everything else here names a race, and these name a *model*. The columns
   * have been in the vendored `ChrRaces` layout all along (`src/generated/dbcLayouts.ts`, indices 4
   * and 5) and nothing read them, so the preview had to be told a display id from somewhere else —
   * which for a race a module adds means being told nothing at all.
   *
   * Carried per race rather than resolved here because resolving is `CreatureDisplayInfo`'s job and
   * that table is already served, whole and by id, on its own routes. Measured on this dataset: all
   * ten playable races carry a non-zero pair — human 49/50 through draenei 16125/16126 — and not one
   * of the 21 rows leaves either column at 0, so the fallback below is for a dataset yet to exist.
   *
   * Optional in the *type* although this loader always writes both, because this interface is also
   * the wire contract the browser validates an answer against: the gateway address is a field on
   * the login screen, so the answer a page holds may have come from a build that predates these two
   * columns, and a consumer that assumed them would read `undefined` as a display id rather than as
   * "this gateway does not know". `?` is that distinction, said once, where both ends can see it.
   */
  maleDisplayId?: number;
  femaleDisplayId?: number;
  /**
   * The classes this race may take, out of `CharBaseInfo`.
   *
   * That table is the pairs and nothing else — two one-byte columns, no id — so it is grouped by
   * race here rather than shipped twice. Sorted, so the form's class list has a stable order.
   */
  classes: number[];
}

export interface CreationClass {
  id: number;
  name: string;
  /**
   * `Filename`, e.g. `WARRIOR` — and the key `CLASS_ICON_TCOORDS` in the client's own FrameXML
   * uses, which is how a class id reaches a cell of the class atlas. tswow writes the same token
   * (`ClassUISettings.ts:54`, `` `["${this.owner.Filename}"] = …` ``).
   */
  fileName: string;
  /** `1 << (id - 1)`, computed: 3.3.5 has no such column. Zero for an id outside 1..32. */
  classMask: number;
  /** `DisplayPower`: 0 mana, 1 rage, 3 energy, 6 runic power. */
  powerType: number;
  expansion: number;
  /** Whether any race may take it, i.e. whether `CharBaseInfo` names it at all. */
  playable: boolean;
}

export interface CharacterCreationData {
  races: CreationRace[];
  classes: CreationClass[];
}

/** `CHRRACES_FLAGS_NOT_PLAYABLE` — see the header. */
const RACE_FLAG_NOT_PLAYABLE = 0x01;

export async function loadCharacterCreation(dbcDirectory: string): Promise<CharacterCreationData> {
  const [raceTable, classTable, baseTable] = await Promise.all([
    openDbcFile(dbcDirectory, "ChrRaces"),
    openDbcFile(dbcDirectory, "ChrClasses"),
    openDbcFile(dbcDirectory, "CharBaseInfo"),
  ]);

  const classes: CreationClass[] = [];
  const classIds = new Set<number>();
  for (const row of classTable.rows()) {
    const id = classTable.id(row);
    classIds.add(id);
    classes.push({
      id,
      name: classTable.locstring(row, "Name_lang"),
      fileName: classTable.string(row, "Filename"),
      classMask: id >= 1 && id <= 32 ? 1 << (id - 1) : 0,
      powerType: classTable.int(row, "DisplayPower"),
      expansion: classTable.int(row, "Required_expansion"),
      playable: false,
    });
  }

  // `CharBaseInfo` is two signed bytes per row and carries no id of its own, so neither `id()` nor
  // the usual four-byte read applies. The mask is what makes a custom race work: tswow allocates
  // ids upwards from 22 and the column holds 256 of them, but read as `int8` everything from 128
  // arrives negative and its pairs would be dropped as unknown.
  const pairs = new Map<number, Set<number>>();
  for (const row of baseTable.rows()) {
    const raceId = baseTable.int(row, "RaceID") & 0xff;
    const classId = baseTable.int(row, "ClassID") & 0xff;
    if (!classIds.has(classId)) continue;
    let taken = pairs.get(raceId);
    if (!taken) pairs.set(raceId, taken = new Set());
    taken.add(classId);
  }
  for (const entry of classes) {
    for (const taken of pairs.values()) {
      if (taken.has(entry.id)) { entry.playable = true; break; }
    }
  }

  const races: CreationRace[] = [];
  for (const row of raceTable.rows()) {
    const id = raceTable.id(row);
    races.push({
      id,
      name: raceTable.locstring(row, "Name_lang"),
      clientPrefix: raceTable.string(row, "ClientPrefix"),
      clientFileString: raceTable.string(row, "ClientFileString"),
      hairCustomization: raceTable.string(row, "HairCustomization"),
      facialHairCustomization: [
        raceTable.string(row, "FacialHairCustomization", 0),
        raceTable.string(row, "FacialHairCustomization", 1),
      ],
      playable: (raceTable.int(row, "Flags") & RACE_FLAG_NOT_PLAYABLE) === 0,
      side: raceTable.int(row, "Alliance"),
      factionId: raceTable.int(row, "FactionID"),
      baseLanguage: raceTable.int(row, "BaseLanguage"),
      expansion: raceTable.int(row, "Required_expansion"),
      maleDisplayId: raceTable.int(row, "MaleDisplayID"),
      femaleDisplayId: raceTable.int(row, "FemaleDisplayID"),
      classes: [...(pairs.get(id) ?? [])].sort((left, right) => left - right),
    });
  }

  return { races, classes };
}
