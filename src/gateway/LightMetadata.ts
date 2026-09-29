// The sky, the sun and the fog of one map, as the client's own tables describe them.
//
// `Light.dbc` is a list of spheres. One row per map carries no position and no radius at all and
// is that map's default; the rest sit somewhere in the world with an inner and an outer radius and
// take over as the camera walks into them. Each row names eight `LightParams` rows — one per
// weather and water state — and a `LightParams` row is the head of a run of band tables that say
// what every colour and distance is at each time of day.
//
// The bands are addressed by arithmetic rather than by a foreign key: `LightIntBand` holds
// eighteen rows per parameter set and `LightFloatBand` six, both one-based. Measured on this
// dataset, `LightIntBand` has 15,300 rows for 850 `LightParams` rows and `LightFloatBand` 5,100,
// which is exactly 18 and 6.
//
// Sent to the browser whole, per map, because there is nothing to ask per position that the
// browser cannot decide itself: map 0 is 82 spheres over 30 distinct parameter sets.

import { openDbcFile } from "./Dbc.js";
import {
  LIGHT_SLOT_CLEAR, LIGHT_SLOT_STORM, LIGHT_SLOT_UNDERWATER, LIGHT_SLOT_UNDERWATER_STORM,
} from "../world/WorldMessageProtocol.js";

/** Colour channels per parameter set in `LightIntBand`. */
const INT_CHANNELS = 18;
/** Float channels per parameter set in `LightFloatBand`. */
const FLOAT_CHANNELS = 6;
/** Half-minutes in a game day. Every band's key times are in these. */
export const DAY_HALF_MINUTES = 2880;

/**
 * `Light.dbc` stores positions and radii in thirty-sixths of a yard.
 *
 * Not a guess: light 2's inner radius of 19,200 is 533.33 yards, which is one ADT tile to the
 * digit, and at this scale Stormwind's own volume lands 115 yards from Stormwind with a 495 yard
 * radius. Left at 1.0 no volume on any map contains any point, so every zone falls back to the
 * map default and looks like an ordinary bright day.
 */
const UNITS_PER_YARD = 36;
/** The tile grid's origin corner, which is where the stored coordinates are measured from. */
const ZEROPOINT = 32 * 533.3333333333334;

/**
 * Which colour each `LightIntBand` channel is.
 *
 * Read off the file rather than from a wiki page, and then read off it again: the first reading
 * here put the fog one channel early, on the strength of a brightness test that turned out to be
 * the weaker evidence.
 *
 * What holds. Over the 844 parameter sets that carry both, channel 0 is brighter than channel 1
 * at noon in 83.6%, so 0 is the sun's own colour and 1 the ambient fill and not the reverse.
 *
 * Where the sky ends. Channels 2 to 6 are one gradient: measured over every parameter set at five
 * times of day, the mean distance between 5 and 6 is 33.0 and between 4 and 5 is 39.6, while 6 to
 * 7 is 65.2 — so 6 belongs with the band above it and 7 stands apart, which makes 7 the fog. A
 * brightness test said otherwise, because the band at the horizon is a haze and is not reliably
 * brighter than the one above it; colour distance is the better question to ask of a gradient.
 *
 * Where the water is. Deep open ocean on the minimap is the water colour and nothing else, the
 * surface texture being black with all its detail in the alpha. Across 553 tiles of open ocean —
 * every Azeroth and Kalimdor minimap tile that is uniformly blue — channel 15 sits 6.2 away and
 * the next nearest channel 35.6. Channels 14 and 15 are also the most correlated adjacent pair in
 * the file at 0.576, with 15 the darker, and 16 and 17 are the next at 0.438 and greener: ocean
 * close and far, then river close and far.
 */
const CHANNEL = {
  diffuse: 0,
  ambient: 1,
  skyTop: 2,
  skyUpper: 3,
  skyMiddle: 4,
  skyLower: 5,
  skyHorizon: 6,
  fog: 7,
  oceanClose: 14,
  oceanFar: 15,
  riverClose: 16,
  riverFar: 17,
} as const;

/** Which distance each `LightFloatBand` channel is. */
const FLOAT_CHANNEL = { fogEnd: 0, fogScale: 1 } as const;

export type LightColourChannel = keyof typeof CHANNEL;

/** One band: key times in half-minutes, and a value for each. */
export interface LightBand<T> {
  times: number[];
  values: T[];
}

/** One parameter set: every band this client reads, already resolved. */
export interface LightParamSet {
  /** Packed 0xRRGGBB, the order the file stores. */
  colours: Record<LightColourChannel, LightBand<number>>;
  /** Yards. */
  fogEnd: LightBand<number>;
  /** Fraction of `fogEnd` at which the fog begins. */
  fogScale: LightBand<number>;
  /**
   * How opaque water is at the shore and out of its depth, and the same pair for ocean.
   *
   * Not bands — one value each, and they vary by zone rather than by hour: 675 of the 850
   * parameter sets say 0.50 and 1.00 for water, and Stormwind's own says 0.85.
   */
  waterShallowAlpha: number;
  waterDeepAlpha: number;
  oceanShallowAlpha: number;
  oceanDeepAlpha: number;
  /**
   * `LightParams.Glow`: how strongly the original client's full-screen glow (`ffxGlow`) adds the
   * blurred frame back over itself here.
   *
   * Not a band either — one number per parameter set, varying by zone rather than by hour, exactly
   * like the four water alphas above it. Measured over this dataset's 850 rows: every value is in
   * [0, 1] with none outside, the median is 0.50 (214 rows) and the mean 0.5288; 152 rows sit at
   * exactly 1 and 47 at exactly 0. Read since the first extractor and thrown away until P4.
   */
  glow: number;
  /** `LightSkybox.Name` for this profile, when one is authored. */
  skyboxPath?: string;
}

export interface LightVolume {
  id: number;
  /** World coordinates and radii in yards; absent on the map's default row. */
  x: number;
  y: number;
  z: number;
  innerRadius: number;
  outerRadius: number;
  /** Index into `params`. Slot 0 of the row's eight, which is clear weather above water. */
  params: number;
  /**
   * The same volume under a storm — slot 2 of the eight — and only when it differs from slot 0.
   *
   * Left out on the 47.1% of rows where the two name the same parameter set, because there the
   * weather genuinely changes nothing about the light and sending it would double the payload for
   * a value the browser would blend into itself.
   */
  stormParams?: number;
  /**
   * The same place seen from under the water — slot 1 — and only when it differs from slot 0.
   *
   * Almost always, unlike the storm slot: 709 of the 715 rows name a different set here. That is
   * the whole reason the two slots are worth their bytes. A swimming player used to keep the sky
   * of the shore they left in every zone without exception, because nothing but slots 0 and 2 was
   * ever read out of this table.
   */
  underwaterParams?: number;
  /** Slot 3, the underwater storm, when it differs from slot 1 — which it does on 42.8% of rows. */
  underwaterStormParams?: number;
}

export interface MapLighting {
  /**
   * Applied wherever no volume reaches: the map's own default row when it has one, and `Light`
   * row 1 when it has not.
   *
   * Measured on this dataset, 9 of the 73 maps with any lighting at all carry no default row —
   * 33, 37, 129, 169, 209, 451, 489, 572 and 573. It was 53 until Ж0 stopped requiring a default
   * row's falloff to be zero as well as its position; Northrend was one of the 44 that regained
   * one, which is what split its 97 `Light.dbc` rows into 96 volumes and a default (row 752).
   * Without a last resort those 96 would have left nine tenths of the continent with no sky: they
   * reach 8.1% of it — 5,851 of 72,384 sample points, an 8x8 grid over each of the 1,131 tiles
   * Northrend ships, and the same 1,131 whether they are counted from the map files or from the
   * client's own minimap. (9.3% stood here from the slice that first read these tables until З1's
   * sign-off remeasured it; no grid this repository can build reproduces that number.) The row
   * that stopped being one of the 96 took nothing off the share — it is a 1.28-yard circle at the
   * corner of the tile grid, and putting it back leaves both counts to the point.
   */
  fallback: number | undefined;
  /** Light.dbc row id of the map fallback; kept separate from its LightParams id. */
  fallbackLightId?: number | undefined;
  /** The fallback's own storm set, when it has one distinct from its clear one. */
  fallbackStorm?: number | undefined;
  /** The fallback seen from under water, and that seen under a storm; same rule as a volume's. */
  fallbackUnderwater?: number | undefined;
  fallbackUnderwaterStorm?: number | undefined;
  volumes: LightVolume[];
  params: Record<number, LightParamSet>;
  /** Every Light.dbc row on this map, keyed by row id for SMSG_OVERRIDE_LIGHT. */
  lights: Record<number, LightSlots>;
}

/** The four of a `Light.dbc` row's eight slots this client reads, absent where they repeat. */
export interface LightSlots {
  params: number;
  stormParams?: number;
  underwaterParams?: number;
  underwaterStormParams?: number;
}

/** The row every map falls back to. It carries no position, no radius and no continent of its own. */
const GLOBAL_DEFAULT_LIGHT = 1;

/**
 * Index key holding the global default alone, for maps that own no `Light.dbc` row at all.
 *
 * Measured on this dataset: `Light.dbc` names 73 distinct continents while `Map.dbc` has 135 rows,
 * so **62 maps** have no row of any kind and never reach the loop that hands the global default to
 * the entries that exist — Gnomeregan (90), Molten Core (409), Blackrock Depths (230), Uldaman
 * (70), Maraudon (349), Gundrak (604) and the 28 `Transport*` maps among them.
 *
 * Negative because the light route matches `(\d{1,4})`, so this key cannot arrive from a URL: it
 * is reachable only through the gateway's own `?? get(GLOBAL_FALLBACK_MAP)`.
 */
export const GLOBAL_FALLBACK_MAP = -1;

/**
 * The DBC keeps the author's model extension (`.mdx`/`.mdl`), while the archive extractor and
 * `/visual/model` route publish the converted file as `.m2`.  Leaving the authoring suffix here
 * makes the browser ask for a path the route must reject, which is particularly visible on map
 * 571 where Dalaran's skybox is `ENVIRONMENTS\\Stars\\DalaranSkyBox.mdx`.
 */
function normalizeSkyboxPath(value: string): string {
  return value.replaceAll("/", "\\").replace(/\.(?:mdx|mdl)$/i, ".m2");
}

export type LightIndex = Map<number, MapLighting>;

export async function loadLightMetadata(dbcDirectory: string): Promise<LightIndex> {
  const [light, params, ints, floats, skybox] = await Promise.all([
    openDbcFile(dbcDirectory, "Light"),
    openDbcFile(dbcDirectory, "LightParams"),
    openDbcFile(dbcDirectory, "LightIntBand"),
    openDbcFile(dbcDirectory, "LightFloatBand"),
    // LightSkybox.dbc was added to the client data after the first lighting extractor. Keep the
    // table optional: old datasets still get all colour/fog/weather lighting.
    openDbcFile(dbcDirectory, "LightSkybox").catch(() => undefined),
  ]);

  const skyboxPaths = new Map<number, string>();
  if (skybox) {
    for (const row of skybox.rows()) {
      const id = skybox.id(row);
      const path = skybox.string(row, "Name");
      if (id > 0 && path) skyboxPaths.set(id, normalizeSkyboxPath(path));
    }
  }

  // Both band tables have the same shape — an id, a key count, sixteen times and sixteen values —
  // so one reader serves them; only what a value means differs.
  type BandTable = {
    rowOf(id: number): number | undefined;
    int(row: number, field: "Num" | "Time", element?: number): number;
  };
  const band = <T>(table: BandTable, id: number, read: (row: number, key: number) => T): LightBand<T> => {
    const row = table.rowOf(id);
    if (row === undefined) return { times: [], values: [] };
    const count = Math.min(table.int(row, "Num"), 16);
    const times: number[] = [];
    const values: T[] = [];
    for (let key = 0; key < count; key++) {
      times.push(table.int(row, "Time", key));
      values.push(read(row, key));
    }
    return { times, values };
  };

  const resolved = new Map<number, LightParamSet>();
  const parameterSet = (id: number): LightParamSet | undefined => {
    if (id <= 0) return undefined;
    const existing = resolved.get(id);
    if (existing) return existing;
    if (params.rowOf(id) === undefined) return undefined;
    const intBase = (id - 1) * INT_CHANNELS + 1;
    const floatBase = (id - 1) * FLOAT_CHANNELS + 1;
    const colours = {} as Record<LightColourChannel, LightBand<number>>;
    for (const [name, channel] of Object.entries(CHANNEL) as [LightColourChannel, number][]) {
      // Masked to the low 24 bits: the top byte is unused and reading it signed would make every
      // colour negative in JSON for no reason.
      colours[name] = band(ints, intBase + channel, (row, key) => ints.int(row, "Data", key) & 0xffffff);
    }
    const set: LightParamSet = {
      colours,
      fogEnd: band(floats, floatBase + FLOAT_CHANNEL.fogEnd, (row, key) => floats.float(row, "Data", key) / UNITS_PER_YARD),
      fogScale: band(floats, floatBase + FLOAT_CHANNEL.fogScale, (row, key) => floats.float(row, "Data", key)),
      waterShallowAlpha: params.float(params.rowOf(id)!, "WaterShallowAlpha"),
      waterDeepAlpha: params.float(params.rowOf(id)!, "WaterDeepAlpha"),
      oceanShallowAlpha: params.float(params.rowOf(id)!, "OceanShallowAlpha"),
      oceanDeepAlpha: params.float(params.rowOf(id)!, "OceanDeepAlpha"),
      // Sent as authored; a NaN in a hand-edited table becomes no glow rather than a NaN uniform.
      // The clamp lives in the browser, next to the pass it feeds, because that is where a number
      // outside the measured [0, 1] range has to stop being a number and start being a decision.
      glow: Number.isFinite(params.float(params.rowOf(id)!, "Glow"))
        ? params.float(params.rowOf(id)!, "Glow") : 0,
      ...(skyboxPaths.has(params.int(params.rowOf(id)!, "LightSkyboxID"))
        ? { skyboxPath: skyboxPaths.get(params.int(params.rowOf(id)!, "LightSkyboxID"))! }
        : {}),
    };
    resolved.set(id, set);
    return set;
  };

  const index: LightIndex = new Map();
  for (const row of light.rows()) {
    const map = light.int(row, "ContinentID");
    const id = light.id(row);
    const stored = [0, 1, 2].map((element) => light.float(row, "GameCoords", element));
    const inner = light.float(row, "GameFalloffStart") / UNITS_PER_YARD;
    const outer = light.float(row, "GameFalloffEnd") / UNITS_PER_YARD;
    // Slot 0 of the eight is clear weather above water and slot 2 is the same place under a
    // storm; 1 and 3 are their underwater counterparts and 4 is the death light. Which is which
    // was measured rather than looked up — see `weatherLightSlot`.
    const setId = light.int(row, "LightParamsID", LIGHT_SLOT_CLEAR);
    if (!parameterSet(setId)) continue;
    const stormId = light.int(row, "LightParamsID", LIGHT_SLOT_STORM);
    const storm = stormId !== setId && parameterSet(stormId) ? stormId : undefined;
    // The underwater pair, on the same rule and each measured against the slot it would otherwise
    // repeat: slot 1 against slot 0, which it differs from on 709 of the 715 rows, and slot 3
    // against slot 1, which it differs from on 306. Sending a repeat would double a payload for a
    // value the browser can read off the slot it already has.
    const underwaterId = light.int(row, "LightParamsID", LIGHT_SLOT_UNDERWATER);
    const underwater = underwaterId !== setId && parameterSet(underwaterId) ? underwaterId : undefined;
    const underwaterStormId = light.int(row, "LightParamsID", LIGHT_SLOT_UNDERWATER_STORM);
    // Measured against the set the underwater layer would otherwise resolve to, not against slot
    // 1 alone: on a row where slot 1 repeats slot 0 the browser reads the underwater clear layer
    // as slot 0, so a slot 3 that merely repeats slot 1 must be dropped against *that*.
    const underwaterStorm = underwaterStormId !== (underwater ?? setId) && parameterSet(underwaterStormId)
      ? underwaterStormId : undefined;

    let entry = index.get(map);
    if (!entry) {
      entry = { fallback: undefined, fallbackLightId: undefined, volumes: [], params: {}, lights: {} };
      index.set(map, entry);
    }
    const slots: LightSlots = {
      params: setId,
      ...(storm === undefined ? {} : { stormParams: storm }),
      ...(underwater === undefined ? {} : { underwaterParams: underwater }),
      ...(underwaterStorm === undefined ? {} : { underwaterStormParams: underwaterStorm }),
    };
    entry.params[setId] = resolved.get(setId)!;
    if (storm !== undefined) entry.params[storm] = resolved.get(storm)!;
    if (underwater !== undefined) entry.params[underwater] = resolved.get(underwater)!;
    if (underwaterStorm !== undefined) entry.params[underwaterStorm] = resolved.get(underwaterStorm)!;
    entry.lights[id] = slots;
    // A row standing at the grid origin is the map's default, and the falloff it carries means
    // nothing — there is no volume to fall off from. Requiring a zero radius as well threw away
    // the default of 44 maps: Northrend, Ulduar, Hellfire, Isle of Conquest and 40 more sent their
    // light off to the corner of the tile grid where it reached nothing, and the map then
    // inherited Light 1, the sky over Elwynn. Measured on this dataset's `Light.dbc` (715 rows):
    // 64 rows sit at (0,0,0), 20 of them with a zero radius and 44 with 0.28 to 987.20 yards
    // (Northrend's row 752 carries 1.28 — a member of that range, not its floor), and rows with a
    // non-zero position and a zero radius number **0** — so the half being dropped
    // never filtered anything, and the count of maps holding their own default goes 20 → 64 of 73.
    // The two sets do not even overlap: the 20 are ids 1…379, the 44 are ids 415…2538. After id
    // ~400 the artists simply stopped zeroing the falloff.
    //
    // The price, so that nobody files it as a new defect: 34 of the 44 rows name the same
    // LightParams in the clear slot and the storm slot, so those maps get no `fallbackStorm` and
    // weather stops changing the light outside a volume. Northrend's row 752 is one of them
    // (both slots 569). Today it changes the light by inheriting a stranger's row, which is worse.
    if (stored.every((value) => value === 0)) {
      entry.fallback = setId;
      entry.fallbackLightId = id;
      entry.fallbackStorm = storm;
      entry.fallbackUnderwater = underwater;
      entry.fallbackUnderwaterStorm = underwaterStorm;
      continue;
    }
    // The stored triple runs (y, height, x) on the tile grid's own axes, the same layout the ADT
    // placement chunks use, so it converts the same way.
    entry.volumes.push({
      id,
      x: ZEROPOINT - stored[2]! / UNITS_PER_YARD,
      y: ZEROPOINT - stored[0]! / UNITS_PER_YARD,
      z: stored[1]! / UNITS_PER_YARD,
      innerRadius: inner,
      outerRadius: outer,
      ...slots,
    });
  }

  const globalRow = light.rowOf(GLOBAL_DEFAULT_LIGHT);
  const globalSet = globalRow === undefined ? 0 : light.int(globalRow, "LightParamsID", LIGHT_SLOT_CLEAR);
  const globalStormSet = globalRow === undefined ? 0 : light.int(globalRow, "LightParamsID", LIGHT_SLOT_STORM);
  const globalUnderwaterSet = globalRow === undefined ? 0 : light.int(globalRow, "LightParamsID", LIGHT_SLOT_UNDERWATER);
  const globalUnderwaterStormSet = globalRow === undefined ? 0
    : light.int(globalRow, "LightParamsID", LIGHT_SLOT_UNDERWATER_STORM);
  const globalParams = parameterSet(globalSet);
  const globalStorm = globalStormSet !== globalSet ? parameterSet(globalStormSet) : undefined;
  const globalUnderwater = globalUnderwaterSet !== globalSet ? parameterSet(globalUnderwaterSet) : undefined;
  const globalUnderwaterStorm = globalUnderwaterStormSet !== (globalUnderwater ? globalUnderwaterSet : globalSet)
    ? parameterSet(globalUnderwaterStormSet) : undefined;
  if (globalParams) {
    for (const entry of index.values()) {
      if (entry.fallback !== undefined) continue;
      // The last resort needs its storm set as much as a volume does: without this the weather
      // would change the light only inside a volume and snap back the moment the player walked out
      // of one. Ж0 cut the maps that need this from 53 of 73 to 9 by no longer requiring the
      // default row's falloff to be zero; the nine left are 33, 37, 129, 169, 209, 451, 489, 572
      // and 573.
      entry.fallback = globalSet;
      entry.fallbackLightId = GLOBAL_DEFAULT_LIGHT;
      entry.params[globalSet] = globalParams;
      if (globalStorm) {
        entry.fallbackStorm = globalStormSet;
        entry.params[globalStormSet] = globalStorm;
      }
      // And the underwater pair with it, for the same reason: a map that inherits its sky has to
      // inherit the water over its head too, or diving on one of those nine maps snaps back to the
      // sky of the shore. Light 1 names LightParams 13 in both underwater slots.
      if (globalUnderwater) {
        entry.fallbackUnderwater = globalUnderwaterSet;
        entry.params[globalUnderwaterSet] = globalUnderwater;
      }
      if (globalUnderwaterStorm) {
        entry.fallbackUnderwaterStorm = globalUnderwaterStormSet;
        entry.params[globalUnderwaterStormSet] = globalUnderwaterStorm;
      }
    }
    // And the same default once more, standing alone, for the 62 maps that have no entry here to
    // hand it to (see `GLOBAL_FALLBACK_MAP`). Without it the route answers 404, `LightClient`
    // remembers `null` and prints a red status line, and the renderer keeps the compiled-in sky —
    // `SKY_COLOR` 0x35506a with fog 180…640 — and freezes its clock at zero
    // (`WorldRenderer3D.ts:1510`, `:1538`). Light 1 is not Gnomeregan's real sky, which is not in
    // the data at all, but it moves: on LightParams 12 the fog reads #000e21 at midnight, #5d7d6d
    // at dawn, #4d788f at noon and #565162 at dusk, and runs 125…500 yards at noon and midnight.
    // The distance moves too, and not with the colour: set 12's `fogScale` key at 720 is exactly
    // 0, so at dawn the fog starts in the camera plane and the range is 0…444 (`fogStart =
    // fogEnd * fogScale`, `LightClient.ts:85-87`); at dusk it is 120…481.
    //
    // A fresh object rather than a shared one: the loop mutates the entries it visits, so an entry
    // reachable from two keys would be filled in twice. Where it sits relative to the loop is not
    // load-bearing, and it would be a fiction to write that it is — moved above the loop this fails
    // no test in the suite, because the loop skips whatever already carries a `fallback`, and this
    // record carries one from the moment it is built.
    const globalLights: MapLighting["lights"] = {
      [GLOBAL_DEFAULT_LIGHT]: {
        params: globalSet,
        ...(globalStorm ? { stormParams: globalStormSet } : {}),
        ...(globalUnderwater ? { underwaterParams: globalUnderwaterSet } : {}),
        ...(globalUnderwaterStorm ? { underwaterStormParams: globalUnderwaterStormSet } : {}),
      },
    };
    index.set(GLOBAL_FALLBACK_MAP, {
      fallback: globalSet,
      fallbackLightId: GLOBAL_DEFAULT_LIGHT,
      fallbackStorm: globalStorm ? globalStormSet : undefined,
      fallbackUnderwater: globalUnderwater ? globalUnderwaterSet : undefined,
      fallbackUnderwaterStorm: globalUnderwaterStorm ? globalUnderwaterStormSet : undefined,
      volumes: [],
      params: {
        [globalSet]: globalParams,
        ...(globalStorm ? { [globalStormSet]: globalStorm } : {}),
        ...(globalUnderwater ? { [globalUnderwaterSet]: globalUnderwater } : {}),
        ...(globalUnderwaterStorm ? { [globalUnderwaterStormSet]: globalUnderwaterStorm } : {}),
      },
      lights: globalLights,
    });
  }
  return index;
}
