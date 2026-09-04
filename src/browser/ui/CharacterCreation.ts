import type { CharacterCreationData, CreationClass, CreationRace } from "../../gateway/CharacterCreation.js";
import { CLASS_NAMES, RACE_NAMES, forgetCreationNames, learnCreationNames } from "./UnitSnapshot.js";

export type { CharacterCreationData, CreationClass, CreationRace };

/** One `<option>`: a number to send and a word to show. */
export interface CreationOption {
  id: number;
  name: string;
}

/**
 * The character-creation lists, worked out away from the DOM.
 *
 * Separated from `Login.ts` so the rules are checkable without a browser, because they are rules
 * and not markup: which races may be picked, which classes that race may take, and what happens
 * when the gateway cannot be reached at all. The last of those is the one that used to be the only
 * behaviour — ten names compiled into the page — and it stays as the floor under the other two.
 */

/**
 * Races the form may offer, in id order.
 *
 * Playability is `ChrRaces.Flags` bit 0, cleared — see `gateway/CharacterCreation.ts`. Measured on
 * this dataset: 21 rows in, ten out, which is the same ten the hardcoded table carried. A row whose
 * name is empty still gets an entry, because a race that exists and cannot be named is still a race
 * the server will accept — it is labelled by its number rather than dropped.
 */
export function creationRaces(data: CharacterCreationData | undefined): CreationOption[] {
  if (!data) return fallbackOptions(RACE_NAMES, "Раса");
  const races = data.races
    .filter((race) => race.playable)
    .map((race) => ({ id: race.id, name: race.name || `Раса ${race.id}` }));
  races.sort((left, right) => left.id - right.id);
  // A dataset that somehow marks nothing playable would leave the form with an empty race list and
  // no way to create anything; the compiled ten are a worse answer than the dataset's own, and a
  // better one than none.
  return races.length > 0 ? races : fallbackOptions(RACE_NAMES, "Раса");
}

/**
 * Classes the form may offer, filtered to what this race may take.
 *
 * `CharBaseInfo` is the whole of that rule — 62 pairs over ten races on this dataset, six or seven
 * classes each — and it is the reason the list is per race rather than global: a night elf offered
 * a shaman is a creation the server refuses with a code the form can only print.
 *
 * An unknown race, or a race the pair table says nothing about, gets every playable class rather
 * than none. A custom race whose author forgot `CharBaseInfo` is then creatable-looking and refused
 * by the server, which is recoverable; an empty list is a form that cannot be used at all.
 */
export function creationClasses(
  data: CharacterCreationData | undefined,
  raceId: number | undefined,
): CreationOption[] {
  if (!data) return fallbackOptions(CLASS_NAMES, "Класс");
  const race = raceId === undefined ? undefined : data.races.find((each) => each.id === raceId);
  const allowed = race && race.classes.length > 0 ? new Set(race.classes) : undefined;
  const classes = data.classes
    .filter((entry) => entry.playable && (!allowed || allowed.has(entry.id)))
    .map((entry) => ({ id: entry.id, name: entry.name || `Класс ${entry.id}` }));
  classes.sort((left, right) => left.id - right.id);
  return classes.length > 0 ? classes : fallbackOptions(CLASS_NAMES, "Класс");
}

function fallbackOptions(names: Readonly<Record<number, string>>, unknown: string): CreationOption[] {
  return Object.entries(names)
    .map(([id, name]) => ({ id: Number(id), name: name || `${unknown} ${id}` }))
    .sort((left, right) => left.id - right.id);
}

/**
 * Which `CreatureDisplayInfo` row a race and sex are drawn from, when this gateway says.
 *
 * `undefined` rather than a guess for the two ways it can be missing, and they are different facts:
 * an older gateway does not carry the columns at all, and a dataset can leave a row's id at 0 —
 * which is not a display, it is an empty column. A caller that wants a model has to have somewhere
 * else to go in both cases, so neither is dressed up as an answer here.
 *
 * `sex` is the protocol's own number: 0 male, 1 female, as `CMSG_CHAR_CREATE` sends it.
 */
export function raceDisplayId(race: CreationRace | undefined, sex: number): number | undefined {
  const id = sex === 1 ? race?.femaleDisplayId : race?.maleDisplayId;
  return typeof id === "number" && Number.isInteger(id) && id > 0 ? id : undefined;
}

/**
 * Whether the answer is shaped like the route's, before anything is built out of it.
 *
 * A gateway serving something else on this path — an error page, an older build — should leave the
 * form on its compiled lists rather than filling it with `undefined`.
 *
 * Deliberately *not* tightened when the race rows grew their display ids. The address is a field on
 * the login screen and an older gateway is a supported answer, so a check that required the new
 * columns would throw away a payload whose race and class lists are perfectly good — the form would
 * fall back to the ten compiled names because a 3D preview could not be framed, which is trading a
 * working screen for a missing one. `raceDisplayId` is where their absence is handled instead.
 */
export function isCreationData(value: unknown): value is CharacterCreationData {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<CharacterCreationData>;
  return Array.isArray(candidate.races) && Array.isArray(candidate.classes);
}

/**
 * Asks one gateway, and answers with what it said and nothing else.
 *
 * `undefined` on any failure rather than a throw: the creation form worked before this endpoint
 * existed and has to go on working when the gateway is down, which is exactly when somebody is
 * most likely to be looking at the login screen.
 *
 * Teaching `learnCreationNames` is deliberately the caller's move rather than this one's. Two
 * answers can be in flight at once — the address is a field on the same screen — and only the
 * caller knows which gateway the player is still on by the time an answer lands; a fetch that
 * learned as it returned would let a slow reply from an abandoned gateway name races on this one.
 */
export async function fetchCharacterCreation(origin: string): Promise<CharacterCreationData | undefined> {
  try {
    // `v=2` is the race rows gaining `maleDisplayId`/`femaleDisplayId`. The route answers
    // `max-age=3600`, so without a new URL a browser that asked an hour ago would go on being served
    // the answer from before those columns existed and the creation preview would have nothing to
    // draw — the same reason `/dbc/areas` is on `v=4` and `/dbc/spells` on `v=8`.
    const response = await fetch(`${origin}/dbc/character-creation?v=2`);
    if (!response.ok) throw new Error(`character creation returned ${response.status}`);
    const value = await response.json() as unknown;
    if (!isCreationData(value)) throw new Error("malformed character creation data");
    return value;
  } catch {
    return undefined;
  }
}

/**
 * One gateway's answer, and the rule for when it stops being an answer at all.
 *
 * A holder rather than two variables beside the form, because the rule is not markup and the two
 * ways it can go wrong are both invisible on a working screen. The address is a field on the login
 * page: a player who mistypes it, or who keeps a second server in the box, changes which dataset
 * is talking — and `learnCreationNames` only ever lays names *over* the compiled ten. So a second
 * gateway with no creation route at all (an older build, which is what `isCreationData` exists to
 * survive) would otherwise be described in the first one's words, its races on the form and its
 * names on every frame, nameplate, guild line and character card. The other way is order: two
 * answers can be in flight at once, and the one that lands second is not always the one being
 * asked for.
 */
export class CreationMemo {
  /** What the form is drawn from right now: one gateway's answer, or nothing yet. */
  data: CharacterCreationData | undefined;

  private origin: string | undefined;

  /**
   * Reads the gateway field and answers which gateway, if any, is worth asking.
   *
   * `undefined` for the gateway already asked — this runs on every visit to the form, not once —
   * and for an address that is not one yet, half typed, which leaves whatever is standing alone.
   * A genuinely new address drops the previous one's answer here, before the form is redrawn from
   * it, so what stands while the new gateway is being asked is the compiled floor and not a
   * stranger's races.
   */
  aimAt(field: string): string | undefined {
    let origin: string;
    try {
      origin = new URL(field.replace(/^ws/, "http")).origin;
    } catch {
      return undefined;
    }
    if (origin === this.origin) return undefined;
    this.origin = origin;
    this.data = undefined;
    forgetCreationNames();
    return origin;
  }

  /**
   * Files an answer, and says whether the form should be redrawn from it.
   *
   * `false` for an answer from a gateway the player has already left — dropped rather than
   * learned — and for a gateway that could not be reached, which also forgets that it was asked,
   * so that coming back to this screen asks it again rather than trusting an empty memo.
   */
  accept(origin: string, answer: CharacterCreationData | undefined): boolean {
    if (this.origin !== origin) return false;
    if (!answer) {
      this.origin = undefined;
      return false;
    }
    this.data = answer;
    learnCreationNames(answer.races, answer.classes);
    return true;
  }
}
