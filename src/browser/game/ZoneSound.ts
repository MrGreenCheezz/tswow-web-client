import { game } from "./Context.js";

/**
 * The zone's own music, the wind under it, and the sting on walking into it.
 *
 * `AreaTable.ZoneMusic` names a `ZoneMusic` row, and that row names two `SoundEntries` kits: one
 * for day and one for night. A sub-area usually names nothing and inherits the zone above it,
 * which is why this walks up the parents rather than falling silent in a tavern.
 *
 * `AreaTable.AmbienceID` is the same arrangement one column over, on its own channel: a
 * `SoundAmbience` row, a day kit, a night kit and the same walk. Music is a track that starts and
 * ends; ambience is the room tone underneath it, so it loops and it crossfades. 445 of the 2,307
 * areas name a row, between them 86 distinct ones, and not one of the 86 is missing from the
 * table.
 */

/** How often the zone is looked up. The area itself is counted on the minimap's own slower clock. */
const ZONE_MUSIC_INTERVAL = 2_000;
/** Between six in the morning and eight at night the zone plays its day track. */
const DAY_START = 6 * 60;
const DAY_END = 20 * 60;

let checkedAt = 0;
let musicRow = 0;
let musicKey = "";
let musicGeneration = 0;
let musicState: "idle" | "active" | "ended" | "silence" = "idle";
let musicAfterEnd = 0;
let musicReadyAt = 0;
let introArea = 0;
let introRow = 0;
let introKit = 0;
let introGeneration = 0;
let introState: "done" | "waiting" | "active" = "done";

/** A normalised random silence in milliseconds, kept pure so the scheduler is deterministic in tests. */
export function zoneMusicSilence(
  first: number,
  second: number,
  random: () => number = Math.random,
): number {
  const finiteFirst = Number.isFinite(first) ? Math.max(0, first) : 0;
  const finiteSecond = Number.isFinite(second) ? Math.max(0, second) : 0;
  const lower = Math.min(finiteFirst, finiteSecond);
  const upper = Math.max(finiteFirst, finiteSecond);
  // Math.random is below one, but accepting an injected function makes clamping part of this
  // helper's contract rather than a hidden requirement of every test and future caller.
  const draw = Math.max(0, Math.min(1, random()));
  return lower + (upper - lower) * draw;
}

/** Forget every pending/playing zone track without touching the independently-owned intro state. */
function resetMusicSequence(): void {
  musicGeneration++;
  musicState = "idle";
  musicAfterEnd = 0;
  musicReadyAt = 0;
}

/**
 * Which row an area inherits, walking up until a zone above it names one.
 *
 * Exported through the two wrappers below because the walk is the part with a mistake available in
 * it, and because a dataset whose parents loop would otherwise hang the frame.
 */
function inheritedRow(
  areaId: number,
  parentOf: (id: number) => number | undefined,
  valueOf: (id: number) => number,
): number {
  let id = areaId;
  // Eight is past any real chain — the deepest in the shipped table is three — and it is what
  // stops a dataset with a cycle in it from spinning here for ever.
  for (let step = 0; step < 8 && id > 0; step++) {
    const value = valueOf(id);
    if (value > 0) return value;
    const parent = parentOf(id);
    if (parent === undefined || parent === id) break;
    id = parent;
  }
  return 0;
}

/** Which `ZoneMusic` row this area's music is, walking up to the zone that has one. */
export function zoneMusicOf(
  areaId: number,
  parentOf: (id: number) => number | undefined,
  musicOf: (id: number) => number,
): number {
  return inheritedRow(areaId, parentOf, musicOf);
}

/**
 * Which `SoundAmbience` row this area's wind is, by the same walk.
 *
 * The same walk and not a copy of it: only 445 of the 2,307 areas carry an `AmbienceID`, so
 * inheriting is the usual case rather than the exception, and a sub-area that fell silent would be
 * most of the indoor world going quiet.
 */
export function zoneAmbienceOf(
  areaId: number,
  parentOf: (id: number) => number | undefined,
  ambienceOf: (id: number) => number,
): number {
  return inheritedRow(areaId, parentOf, ambienceOf);
}

/** Whether the world clock is in the half of the day that gets the day track. */
export function isDaytime(minuteOfDay: number): boolean {
  return minuteOfDay >= DAY_START && minuteOfDay < DAY_END;
}

/**
 * `areaId` is handed in rather than fetched, and that is not a style choice: the only thing that
 * knows it is the minimap, whose module builds DOM the moment it is imported, and nothing that
 * cannot be loaded in a test is worth putting an area walk behind.
 */
export function updateZoneSound(now: number, minuteOfDay: number | undefined, areaId: number): void {
  const sound = game.sound;
  const kits = game.soundKits;
  const areas = game.areas;
  if (!sound || !kits || !areas) return;
  if (now - checkedAt < ZONE_MUSIC_INTERVAL) return;
  checkedAt = now;

  if (areaId === 0) return;
  const parentOf = (id: number): number | undefined => areas.area(id)?.parentId;
  const daytime = minuteOfDay === undefined || isDaytime(minuteOfDay);
  const musicId = zoneMusicOf(areaId, parentOf, (id) => areas.area(id)?.zoneMusic ?? 0);

  // The wind, first, because it is the one that is always there. Its own channel, its own slider
  // and its own kit: a zone can have ambience and no music (a field), music and no ambience (an
  // instance), or both.
  const ambienceId = zoneAmbienceOf(areaId, parentOf, (id) => areas.area(id)?.ambienceId ?? 0);
  if (ambienceId === 0) {
    // Silence, and not the last zone's wind following the player indoors. Asked of the player's
    // ears rather than of a flag kept here: a flag can say «playing» when a loop failed to decode
    // and «silent» when one is running — a teleport resets this module and not the audio graph —
    // and `playingAmbience` is the only answer that is always the true one.
    if (sound.playingAmbience !== undefined) sound.stopAmbience();
  } else {
    const ambience = kits.ambience(ambienceId);
    // Nothing yet means «asked for, and the batch answers on the turn after this one», which is
    // the same thing `zoneMusic` does two paragraphs down. The next look is two seconds away.
    const ambienceTrack = ambience
      ? (daytime ? ambience.day : ambience.night)
      : 0;
    if (ambienceTrack > 0 && sound.playingAmbience !== ambienceTrack) {
      const ambienceKit = kits.kit(ambienceTrack);
      if (ambienceKit) sound.playAmbience(ambienceKit);
    }
  }

  /*
   * Music is a small state machine rather than `loop = true` on a source. A `SoundEntries` music
   * kit contains alternative complete tracks: Elwynn's row, for example, is three files of 55–72
   * seconds. `ZoneMusic` then says to leave 180–300 seconds of silence after one of them. Looping
   * the one random file selected by `SoundPlayer` discarded both the other tracks and that pause.
   */
  let stopForTransition = false;
  if (areaId !== introArea) {
    const abandonedIntro = introState !== "done";
    introGeneration++;
    introArea = areaId;
    introRow = areas.area(areaId)?.introSound ?? 0;
    introKit = 0;
    introState = introRow > 0 ? "waiting" : "done";
    // A new sting owns the music channel first. It also starts a fresh zone programme afterwards;
    // an intro from the area just left must not finish over the destination.
    if (abandonedIntro || introRow > 0) {
      resetMusicSequence();
      stopForTransition = true;
    }
  }

  if (musicId !== musicRow) {
    musicRow = musicId;
    musicKey = "";
    resetMusicSequence();
    stopForTransition = true;
  }
  if (stopForTransition) sound.stopMusic();

  const tracks = musicId > 0 ? kits.zoneMusic(musicId) : undefined;
  const programme = tracks ? (daytime ? tracks.day : tracks.night) : undefined;
  if (programme) {
    const nextKey = `${musicId}:${programme.kit}:${programme.silenceMin}:${programme.silenceMax}`;
    if (nextKey !== musicKey) {
      const replacesKnownProgramme = musicKey !== "";
      musicKey = nextKey;
      resetMusicSequence();
      // A day/night change should replace a zone track, but an intro already in progress retains
      // priority and the newly selected programme begins only after it ends.
      if (replacesKnownProgramme && introState === "done") sound.stopMusic();
    }
  }

  // The sting is per area and must finish before its zone programme starts. Do not mark it played
  // until both metadata lookups have answered: the old code marked the area before either request
  // landed, so a cold-cache intro was silently lost forever.
  if (introState === "waiting") {
    const soundId = kits.zoneIntro(introRow);
    if (soundId === undefined) {
      if (kits.zoneIntroAnswered(introRow)) introState = "done";
    } else {
      const sting = kits.kit(soundId);
      if (!sting) {
        if (kits.kitAnswered(soundId)) introState = "done";
      } else {
        introState = "active";
        introKit = soundId;
        const generation = ++introGeneration;
        const wantedArea = introArea;
        const current = (): boolean => generation === introGeneration
          && introState === "active" && introArea === wantedArea;
        const finish = (): void => {
          if (!current()) return;
          introState = "done";
          introKit = 0;
        };
        sound.play(sting, {
          channel: "music",
          guard: current,
          onEnded: finish,
          onFailed: finish,
        });
      }
    }
  } else if (introState === "active" && sound.playingMusic !== introKit) {
    // Something outside the zone scheduler replaced it. Its source no longer owns the channel, so
    // its guarded ended callback correctly does nothing; release the sequence here instead.
    introGeneration++;
    introState = "done";
    introKit = 0;
  }
  if (introState !== "done") return;

  if (!programme || programme.kit <= 0) return;
  const track = kits.kit(programme.kit);
  if (!track) return;

  if (musicState === "active") {
    if (sound.playingMusic === programme.kit) return;
    // The source was replaced without reaching its guarded natural-end callback.
    resetMusicSequence();
  }
  if (musicState === "ended") {
    musicReadyAt = now + musicAfterEnd;
    musicState = "silence";
    return;
  }
  if (musicState === "silence") {
    if (now < musicReadyAt) return;
    musicState = "idle";
  }

  const generation = ++musicGeneration;
  const wantedKey = musicKey;
  musicState = "active"; // Includes fetch/decode: the next two-second poll must not duplicate it.
  const current = (): boolean => generation === musicGeneration
    && musicState === "active" && musicKey === wantedKey && introState === "done";
  sound.play(track, {
    channel: "music",
    guard: current,
    onEnded: () => {
      if (!current()) return;
      musicAfterEnd = zoneMusicSilence(programme.silenceMin, programme.silenceMax);
      musicState = "ended";
    },
    onFailed: () => {
      if (!current()) return;
      musicState = "idle";
    },
  });
}

/**
 * Leaving a realm: the next one must not inherit a zone's track, its wind or its sting.
 *
 * The wind is *stopped* here and not merely forgotten, because forgetting is what let it run on:
 * a teleport lands in an instance, and 86 of the 2,307 areas end the parent walk with no
 * `AmbienceID` at all — the Stockade, Wailing Caverns, the Deadmines, Scarlet Monastery, Uldaman,
 * Maraudon, Blackrock Depths. Zeroing a flag here left the audio graph running, and the first
 * frames after a teleport have no area id to compare against either, so Elwynn's forest used to
 * loop over the dungeon for the rest of the session.
 */
export function forgetZoneSound(): void {
  const hadMusic = musicRow !== 0 || musicState !== "idle" || introState !== "done";
  checkedAt = 0;
  musicRow = 0;
  musicKey = "";
  resetMusicSequence();
  introGeneration++;
  introArea = 0;
  introRow = 0;
  introKit = 0;
  introState = "done";
  if (hadMusic) game.sound?.stopMusic();
  game.sound?.stopAmbience();
}
