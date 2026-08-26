import { openDbcFile } from "./Dbc.js";

/**
 * The three tables the character-creation screen is made of, which nothing in this client read.
 *
 * `RACE_NAMES` and `CLASS_NAMES` in `ui/UnitSnapshot.ts` were ten hand-written entries each, and
 * the creation form was built from them — so a race or a class a module adds was unselectable,
 * unnamed and, on a frame or a tooltip, printed as its number. `ChrRaces`, `ChrClasses` and
 * `CharBaseInfo` are vendored under `tools/dbd/` and were read by nothing but `ClientPrefix`.
 *
 * Served whole and once, the arrangement `/dbc/talents` and `/dbc/areas` use: measured on this
 * dataset the payload is 4,178 bytes for 21 races, 10 classes and 62 pairs, and the three tables
 * take 2.9 ms to read — smaller and cheaper than the question of whether to page it.
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
      playable: (raceTable.int(row, "Flags") & RACE_FLAG_NOT_PLAYABLE) === 0,
      side: raceTable.int(row, "Alliance"),
      factionId: raceTable.int(row, "FactionID"),
      baseLanguage: raceTable.int(row, "BaseLanguage"),
      expansion: raceTable.int(row, "Required_expansion"),
      classes: [...(pairs.get(id) ?? [])].sort((left, right) => left - right),
    });
  }

  return { races, classes };
}
