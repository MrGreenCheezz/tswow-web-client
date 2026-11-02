import type { CharacterCreationData, CreationClass, CreationRace } from "../../gateway/CharacterCreation.js";

export type { CharacterCreationData, CreationClass, CreationRace };

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
 * Deliberately *not* tightened when the race rows grew their display ids: an older gateway is a
 * supported answer, and a check that required the new columns would throw away a payload whose race
 * and class lists are perfectly good. `raceDisplayId` is where their absence is handled instead.
 */
export function isCreationData(value: unknown): value is CharacterCreationData {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<CharacterCreationData>;
  return Array.isArray(candidate.races) && Array.isArray(candidate.classes);
}

/**
 * `/dbc/character-creation?v=4` (the class rows' `flags` and `spellClassSet`), past the browser
 * cache when it has to be. The route answers `max-age=3600` and does not read `?v=`, so a gateway
 * not yet restarted serves the `v=3` shape under the `v=4` key and the browser keeps that answer for
 * an hour after the restart. An answer whose class rows all lack `flags` is asked once more with
 * `cache: "reload"`, as `/dbc/spells` does; a gateway that really is old answers the same again and
 * that answer stands. Undefined when the route fails or answers something that is not the table.
 */
export async function fetchCreationWithClassFlags(
  url: string, doFetch: typeof globalThis.fetch = globalThis.fetch.bind(globalThis),
): Promise<CharacterCreationData | undefined> {
  const ask = async (init?: RequestInit): Promise<CharacterCreationData | undefined> => {
    const response = await doFetch(url, init);
    if (!response.ok) return undefined;
    const value: unknown = await response.json();
    return isCreationData(value) ? value : undefined;
  };
  const first = await ask();
  if (!first || first.classes.length === 0 || first.classes.some((entry) => entry.flags !== undefined)) return first;
  return (await ask({ cache: "reload" }).catch(() => undefined)) ?? first;
}
