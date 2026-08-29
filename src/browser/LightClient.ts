// What the sky, the sun and the fog look like here, now.
//
// The gateway sends one map's light volumes whole, so this can answer for any position at any
// time of day without a round trip — which it has to, because the answer changes every frame.
//
// Before this the sky was a compile-time constant, the fog was 180 to 640 metres whatever the
// zone, and the sun was placed once when the scene was built and never moved again.

import type {
  LightIndexEntry, LightParamSet, LightSample, LightSlots, ResolvedColour,
} from "./LightTypes.js";
import type { BenchmarkAsyncReadinessStats } from "./RenderBenchmarkReadiness.js";

export type { LightSample };

/** Half-minutes in a game day; every band's key times are in these. */
export const DAY_HALF_MINUTES = 2880;

/**
 * Converts the game clock used by Light.dbc into an authored sky clip time.
 *
 * LightSkybox clips are not real-time weather loops: Dalaran's 320-second clip contains the
 * day/sunset/night texture keys for one game day.  Keeping this as a pure helper also makes it
 * difficult for a renderer to accidentally advance a sky on wall-clock time.
 */
export function skyboxAnimationTimeMs(time: number, durationMs: number): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 0;
  const day = ((Number.isFinite(time) ? time : 0) % DAY_HALF_MINUTES + DAY_HALF_MINUTES) % DAY_HALF_MINUTES;
  return day / DAY_HALF_MINUTES * durationMs;
}

/** Progress for an SMSG_OVERRIDE_LIGHT transition, including a target id of zero (clear). */
export function lightOverrideWeight(now: number, receivedAt: number, milliseconds: number): number {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return 1;
  return Math.max(0, Math.min(1, (now - receivedAt) / milliseconds));
}

const CHANNELS = ["diffuse", "ambient", "skyTop", "skyUpper", "skyMiddle", "skyLower", "skyHorizon", "fog",
  "oceanClose", "oceanFar", "riverClose", "riverFar"] as const;

/**
 * Samples one band at a time of day.
 *
 * The bands wrap: a curve whose last key is at 22:00 and whose first is at 00:00 has to run
 * through midnight rather than stop, so the interval before the first key is the one that ends at
 * it, measured the long way round the clock.
 */
function sampleBand(times: readonly number[], values: readonly number[], time: number,
  blend: (from: number, to: number, t: number) => number): number | undefined {
  if (times.length === 0) return undefined;
  if (times.length === 1) return values[0];
  let beforeIndex = times.length - 1;
  let afterIndex = 0;
  for (let index = 0; index < times.length; index++) {
    if (times[index]! <= time) beforeIndex = index;
  }
  afterIndex = (beforeIndex + 1) % times.length;
  const span = (times[afterIndex]! - times[beforeIndex]! + DAY_HALF_MINUTES) % DAY_HALF_MINUTES;
  if (span === 0) return values[beforeIndex];
  const progress = ((time - times[beforeIndex]! + DAY_HALF_MINUTES) % DAY_HALF_MINUTES) / span;
  return blend(values[beforeIndex]!, values[afterIndex]!, Math.min(1, Math.max(0, progress)));
}

const mixNumber = (from: number, to: number, t: number) => from + (to - from) * t;

/** Packed 0xRRGGBB blended channel by channel, which is not the same as blending the packed int. */
function mixColour(from: number, to: number, t: number): number {
  const channel = (shift: number) => {
    const a = (from >> shift) & 0xff;
    const b = (to >> shift) & 0xff;
    return Math.round(a + (b - a) * t) & 0xff;
  };
  return (channel(16) << 16) | (channel(8) << 8) | channel(0);
}

function unpack(colour: number): ResolvedColour {
  return { r: ((colour >> 16) & 0xff) / 255, g: ((colour >> 8) & 0xff) / 255, b: (colour & 0xff) / 255 };
}

function sampleSet(set: LightParamSet, time: number): LightSample {
  const colours = {} as LightSample["colours"];
  for (const channel of CHANNELS) {
    const band = set.colours[channel];
    const value = sampleBand(band.times, band.values, time, mixColour);
    colours[channel] = unpack(value ?? 0);
  }
  const fogEnd = sampleBand(set.fogEnd.times, set.fogEnd.values, time, mixNumber) ?? 500;
  const fogScale = sampleBand(set.fogScale.times, set.fogScale.values, time, mixNumber) ?? 0.25;
  return {
    colours, fogEnd, fogStart: fogEnd * fogScale,
    waterShallowAlpha: set.waterShallowAlpha, waterDeepAlpha: set.waterDeepAlpha,
    oceanShallowAlpha: set.oceanShallowAlpha, oceanDeepAlpha: set.oceanDeepAlpha,
    ...(set.skyboxPath ? { skyboxPath: set.skyboxPath } : {}),
  };
}

/** Blends two samples; `weight` is how much of `other` to take. */
function blendSamples(base: LightSample, other: LightSample, weight: number): LightSample {
  if (weight <= 0) return base;
  if (weight >= 1) return other;
  const colours = {} as LightSample["colours"];
  for (const channel of CHANNELS) {
    const from = base.colours[channel];
    const to = other.colours[channel];
    colours[channel] = {
      r: from.r + (to.r - from.r) * weight,
      g: from.g + (to.g - from.g) * weight,
      b: from.b + (to.b - from.b) * weight,
    };
  }
  const between = (from: number, to: number) => from + (to - from) * weight;
  return {
    colours,
    fogEnd: between(base.fogEnd, other.fogEnd),
    fogStart: between(base.fogStart, other.fogStart),
    waterShallowAlpha: between(base.waterShallowAlpha, other.waterShallowAlpha),
    waterDeepAlpha: between(base.waterDeepAlpha, other.waterDeepAlpha),
    oceanShallowAlpha: between(base.oceanShallowAlpha, other.oceanShallowAlpha),
    oceanDeepAlpha: between(base.oceanDeepAlpha, other.oceanDeepAlpha),
    // A model cannot be blended in the same shader as the procedural sky. Keep only the profile
    // that owns the greater weight; the absence of a path is meaningful and must clear an authored
    // dome when the procedural profile wins. Falling back to the other side here made a Dalaran
    // dome survive at zero weight, or appear before its volume had actually taken over.
    ...(weight >= 0.5
      ? (other.skyboxPath ? { skyboxPath: other.skyboxPath } : {})
      : (base.skyboxPath ? { skyboxPath: base.skyboxPath } : {})),
  };
}

/** Smoothstep, which is how a volume's falloff fades rather than stepping at its edge. */
function falloffWeight(distance: number, inner: number, outer: number): number {
  if (distance <= inner) return 1;
  if (distance >= outer || outer <= inner) return 0;
  const t = (distance - inner) / (outer - inner);
  return 1 - t * t * (3 - 2 * t);
}

/**
 * Resolves the lighting at one point of one map.
 *
 * The map's own default is the floor, and every volume that reaches the point is laid over it in
 * order of how tightly it holds the point. Only the nearest few are blended: standing in Stormwind
 * there is one volume, and nowhere in the client are there many.
 */
export function resolveLighting(entry: LightIndexEntry, x: number, y: number, time: number,
  storm = 0, maxBlended = 3, z?: number, overrideLightId?: number, overrideWeight = 1,
  overrideAreaLightId?: number, overrideFromLightId?: number,
  underwater = false): LightSample | undefined {
  /**
   * Which pair of the row's four slots this camera reads.
   *
   * Under water the clear layer is slot 1 and the storm layer slot 3, and the gateway sends each
   * only where it differs from the slot it would otherwise repeat — so "absent" resolves to that
   * slot rather than to nothing. Slot 1 is genuinely different on 709 of the 715 rows, which is
   * why swimming looked identical to standing on the shore in every zone before this.
   */
  const pair = (slots: LightSlots | undefined): [number | undefined, number | undefined] => {
    if (!slots) return [undefined, undefined];
    if (!underwater) return [slots.params, slots.stormParams];
    const clear = slots.underwaterParams ?? slots.params;
    const stormy = slots.underwaterStormParams ?? clear;
    return [clear, stormy === clear ? undefined : stormy];
  };
  // Each layer is resolved twice and crossfaded, rather than the whole thing being resolved twice
  // and crossfaded at the end. `Light.dbc` has no intensity axis at all — a row names a clear set
  // and a storm set and nothing between them — so the fade has to be made here, and making it per
  // layer is what keeps a town's own weather from being averaged against the zone's clear sky.
  const layer = (clearId: number | undefined, stormId: number | undefined): LightSample | undefined => {
    const clear = clearId === undefined ? undefined : entry.params[clearId];
    if (!clear) return undefined;
    const base = sampleSet(clear, time);
    const stormSet = storm <= 0 || stormId === undefined ? undefined : entry.params[stormId];
    return stormSet ? blendSamples(base, sampleSet(stormSet, time), storm) : base;
  };
  // SMSG_OVERRIDE_LIGHT names a Light.dbc row rather than a LightParams row. It is sent by
  // scripted zones (the Dalaran/raid transitions are common examples). The area id is important:
  // the same packet can coexist with a tighter town volume, and applying its target to the whole
  // resolved sample would wash that inner volume out. Resolve the target row as a replacement for
  // only the matching active layer below.
  const reached = [];
  for (const volume of entry.volumes) {
    // Light.dbc stores a full (x, y, z) GameCoords point.  The 2D fallback is kept for callers
    // that only have a map coordinate; the world loop always supplies the player's z, which is
    // essential on stacked spaces such as Dalaran and the Crystalsong airships.
    const distance = z === undefined
      ? Math.hypot(volume.x - x, volume.y - y)
      : Math.hypot(volume.x - x, volume.y - y, volume.z - z);
    const weight = falloffWeight(distance, volume.innerRadius, volume.outerRadius);
    if (weight > 0) reached.push({ volume, weight });
  }
  const areaId = overrideAreaLightId && overrideAreaLightId > 0
    ? overrideAreaLightId
    // Callers predating area-id plumbing can still override the map fallback, but never an
    // arbitrary active volume. A packet's explicit zero means that no area is selected.
    : overrideAreaLightId === undefined ? entry.fallbackLightId : undefined;
  const activeArea = areaId === entry.fallbackLightId
    || reached.some(({ volume }) => volume.id === areaId);
  const target = activeArea && overrideLightId ? entry.lights?.[overrideLightId] : undefined;
  const source = activeArea && overrideFromLightId ? entry.lights?.[overrideFromLightId] : undefined;
  const targetSample = target ? layer(...pair(target)) : undefined;
  const sourceSample = source ? layer(...pair(source)) : undefined;
  const transition = Math.max(0, Math.min(1, overrideWeight));
  const resolveLayer = (lightId: number | undefined, slots: LightSlots | undefined): LightSample | undefined => {
    const base = layer(...pair(slots));
    if (areaId === undefined || lightId !== areaId || (!targetSample && !sourceSample)) return base;
    // A transition can be A -> B or A -> the ordinary spatial layer (clear id 0). When there is no
    // prior scripted row, the ordinary layer is the source. This preserves the server's duration
    // instead of snapping back to the volume on a clear packet.
    const from = sourceSample ?? base;
    const to = targetSample ?? base;
    if (!from) return transition >= 1 ? to : from;
    return to ? blendSamples(from, to, transition) : from;
  };
  const fallbackSlots: LightSlots | undefined = entry.fallback === undefined ? undefined : {
    params: entry.fallback,
    ...(entry.fallbackStorm === undefined ? {} : { stormParams: entry.fallbackStorm }),
    ...(entry.fallbackUnderwater === undefined ? {} : { underwaterParams: entry.fallbackUnderwater }),
    ...(entry.fallbackUnderwaterStorm === undefined
      ? {} : { underwaterStormParams: entry.fallbackUnderwaterStorm }),
  };
  if (reached.length === 0) {
    return resolveLayer(entry.fallbackLightId, fallbackSlots);
  }
  // The tighter volume wins, so a town inside a zone is not averaged away by the zone around it.
  // Ties break on the smaller radius and then on the id, both of which are fixed by the data —
  // ordering on weight alone makes the choice flicker as the player walks.
  reached.sort((left, right) => right.weight - left.weight
    || left.volume.outerRadius - right.volume.outerRadius
    || left.volume.id - right.volume.id);

  let sample = resolveLayer(entry.fallbackLightId, fallbackSlots);
  // Select the tightest layers, then composite them from broad to tight. The previous single sort
  // selected the right rows but blended a broad outer volume last, so an outer transition could
  // repaint a town/room at the exact point where both volumes had weight 1.
  const selected = reached.slice(0, maxBlended).sort((left, right) =>
    right.volume.outerRadius - left.volume.outerRadius
    || left.volume.innerRadius - right.volume.innerRadius
    || left.volume.id - right.volume.id);
  for (const { volume, weight } of selected) {
    const resolvedLayer = resolveLayer(volume.id, volume);
    if (!resolvedLayer) continue;
    sample = sample ? blendSamples(sample, resolvedLayer, weight) : resolvedLayer;
  }
  return sample;
}

/** Downloads and caches one map's lighting, and answers for a position while it is in flight. */
export class LightClient {
  onStatus: ((message: string, error: boolean) => void) | undefined;
  readonly #baseUrl: string;
  readonly #maps = new Map<number, LightIndexEntry | null>();
  readonly #loading = new Set<number>();
  #success = 0;
  #error = 0;
  #generation = 0;

  /** Immutable exact request counters; lifetime map cache membership is deliberately excluded. */
  get stats(): Readonly<BenchmarkAsyncReadinessStats> {
    return Object.freeze({
      pending: this.#loading.size,
      success: this.#success,
      error: [...this.#maps.values()].filter((entry) => entry === null).length,
      generation: this.#generation,
    });
  }

  get generation(): number {
    return this.#generation;
  }

  get revision(): number {
    return this.#generation;
  }

  constructor(gatewayWebSocketUrl: string) {
    const url = new URL(gatewayWebSocketUrl);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    this.#baseUrl = url.origin;
  }

  /**
   * The lighting at a point, or undefined until the map's table has arrived.
   *
   * `storm` is how far the weather has rolled in, 0 to 1. It is the packet's intensity with the
   * five-second fade applied — the renderer holds the shown value and walks it towards the target
   * — so it is that number over time rather than that number, and clear weather is a hard zero.
   *
   * `underwater` is the camera's eye against the liquid surface, and it is not the swim flag:
   * `Physics.ts:224` measures submersion at the character's feet, which is what decides swimming,
   * while the sky changes when the *view* goes under and not a moment before.
   */
  sample(map: number, x: number, y: number, time: number, storm = 0, z?: number,
    overrideLightId?: number, overrideWeight = 1, overrideAreaLightId?: number,
    overrideFromLightId?: number, underwater = false): LightSample | undefined {
    const entry = this.#maps.get(map);
    if (entry === undefined) {
      if (!this.#loading.has(map)) {
        this.#loading.add(map);
        void this.#load(map);
      }
      return undefined;
    }
    return entry === null ? undefined : resolveLighting(entry, x, y, time, storm, 3, z,
      overrideLightId, overrideWeight, overrideAreaLightId, overrideFromLightId, underwater);
  }

  async #load(map: number): Promise<void> {
    let settled = false;
    const settle = (success: boolean): void => {
      if (settled) return;
      settled = true;
      this.#loading.delete(map);
      this.#generation++;
      if (success) this.#success++;
      else this.#error++;
    };
    try {
      // The route caches for an hour, and slice R7 changed the payload's shape by adding the
      // storm set. Without a new query a browser that had already fetched this map would keep the
      // old body and quietly have no weather — which looks exactly like the 47% of rows where the
      // weather legitimately changes nothing. v3 is the underwater pair, slots 1 and 3, and the
      // same argument holds twice over: a stale body would look exactly like a client that had
      // never learned to dive.
      const response = await fetch(`${this.#baseUrl}/dbc/light/${map}?v=3`);
      if (!response.ok) throw new Error(`Light gateway returned ${response.status}`);
      const value = await response.json() as LightIndexEntry;
      if (!value || typeof value !== "object" || !Array.isArray(value.volumes) || !value.params) {
        throw new Error("Light gateway returned an invalid table");
      }
      this.#maps.set(map, value);
      settle(true);
      this.onStatus?.(`Свет карты ${map}: ${value.volumes.length} объёмов`, false);
    } catch (error) {
      this.#maps.set(map, null);
      settle(false);
      this.onStatus?.(error instanceof Error ? error.message : String(error), true);
    } finally {
      settle(false);
    }
  }
}
