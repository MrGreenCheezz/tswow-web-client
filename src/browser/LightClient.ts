// What the sky, the sun and the fog look like here, now.
//
// The gateway sends one map's light volumes whole, so this can answer for any position at any
// time of day without a round trip — which it has to, because the answer changes every frame.
//
// Before this the sky was a compile-time constant, the fog was 180 to 640 metres whatever the
// zone, and the sun was placed once when the scene was built and never moved again.

import type {
  LightBand, LightIndexEntry, LightParamSet, LightSample, LightSlots, LiquidLighting, ResolvedColour,
} from "./LightTypes.js";
import type { BenchmarkAsyncReadinessStats } from "./RenderBenchmarkReadiness.js";
import { RetryLadder } from "./RetryLadder.js"; // 05.10-A7b-0 1.24

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

/**
 * Packed 0xRRGGBB blended channel by channel, which is not the same as blending the packed int.
 * 05.10-A7b-5: written without the per-call closure it used to build — it now also runs for the six
 * sky channels on every sample, and the answer is the same to the bit.
 */
function mixColour(from: number, to: number, t: number): number {
  return (mixByte(from >> 16, to >> 16, t) << 16) | (mixByte(from >> 8, to >> 8, t) << 8) | mixByte(from, to, t);
}

function mixByte(from: number, to: number, t: number): number {
  const a = from & 0xff;
  const b = to & 0xff;
  return Math.round(a + (b - a) * t) & 0xff;
}

/** 05.10-A7b-5 (7.04 slice 0): a band a v4 body lacks samples as 0 instead of throwing. */
function sampleOptional(band: LightBand<number> | undefined, time: number,
  blend: (from: number, to: number, t: number) => number): number {
  return band === undefined ? 0 : sampleBand(band.times, band.values, time, blend) ?? 0;
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
  const sky = set.colours;
  return {
    colours, fogEnd, fogStart: fogEnd * fogScale,
    waterShallowAlpha: set.waterShallowAlpha, waterDeepAlpha: set.waterDeepAlpha,
    oceanShallowAlpha: set.oceanShallowAlpha, oceanDeepAlpha: set.oceanDeepAlpha,
    // A gateway that predates P4 sends no glow at all, and that reads as none — the same tolerance
    // the browser gives every other field a payload version has added.
    glow: set.glow ?? 0,
    // 05.10-A7b-5 (7.04 slice 0): payload v5. Plain numbers, so the sample gains no object; a v4
    // body (an old gateway) has none of them and says so through `skyChannels`.
    skyChannels: sky.sunColour !== undefined,
    extra8: sampleOptional(sky.extra8, time, mixColour),
    sunColour: sampleOptional(sky.sunColour, time, mixColour),
    sunHalo: sampleOptional(sky.sunHalo, time, mixColour),
    cloudA: sampleOptional(sky.cloudA, time, mixColour),
    cloudB: sampleOptional(sky.cloudB, time, mixColour),
    extra13: sampleOptional(sky.extra13, time, mixColour),
    celestialThrough: sampleOptional(set.celestialThrough, time, mixNumber),
    cloudDensity: sampleOptional(set.cloudDensity, time, mixNumber),
    float4: sampleOptional(set.float4, time, mixNumber),
    float5: sampleOptional(set.float5, time, mixNumber),
    highlightSky: set.highlightSky ?? 0,
    cloudType: set.cloudType ?? 0,
    skyboxFlags: set.skyboxPath ? set.skyboxFlags ?? 0 : 0,
    // 05.10-A7b-5 review: set by `resolveLighting` on the frame's own sample (overlay hook).
    liquidLight: false,
    liquidDarkens: false,
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
    // Blended like the scalars around it rather than switched at the volume edge: the strength is
    // read into a uniform every frame, and a step there would pop the whole screen as the player
    // walks out of Stormwind's 0.30 into Elwynn's 0.65.
    glow: between(base.glow, other.glow),
    // 05.10-A7b-5 (7.04 slice 0): colours channel by channel like the twelve, scalars like the
    // alphas, and the per-profile integers with the dominant profile like the sky model below.
    skyChannels: base.skyChannels || other.skyChannels,
    extra8: mixColour(base.extra8, other.extra8, weight),
    sunColour: mixColour(base.sunColour, other.sunColour, weight),
    sunHalo: mixColour(base.sunHalo, other.sunHalo, weight),
    cloudA: mixColour(base.cloudA, other.cloudA, weight),
    cloudB: mixColour(base.cloudB, other.cloudB, weight),
    extra13: mixColour(base.extra13, other.extra13, weight),
    celestialThrough: between(base.celestialThrough, other.celestialThrough),
    cloudDensity: between(base.cloudDensity, other.cloudDensity),
    float4: between(base.float4, other.float4),
    float5: between(base.float5, other.float5),
    highlightSky: weight >= 0.5 ? other.highlightSky : base.highlightSky,
    cloudType: weight >= 0.5 ? other.cloudType : base.cloudType,
    skyboxFlags: weight >= 0.5 ? other.skyboxFlags : base.skyboxFlags,
    liquidLight: base.liquidLight || other.liquidLight, // 05.10-A7b-5 review
    liquidDarkens: base.liquidDarkens || other.liquidDarkens, // 05.10-A7b-5 review
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
  underwater = false, ghost = 0, liquidType?: number, liquidDepth = 0): LightSample | undefined {
  // 05.10-A7b-5 (7.15): a ghost fading in or out is the two lights crossfaded. Only during the
  // two-second turn (`GhostLightFade`) does a frame resolve twice; settled, it is one pass.
  if (ghost > 0 && ghost < 1) {
    const alive = resolveLighting(entry, x, y, time, storm, maxBlended, z, overrideLightId, overrideWeight,
      overrideAreaLightId, overrideFromLightId, underwater, 0, liquidType, liquidDepth);
    const dead = resolveLighting(entry, x, y, time, storm, maxBlended, z, overrideLightId, overrideWeight,
      overrideAreaLightId, overrideFromLightId, underwater, 1, liquidType, liquidDepth);
    return alive && dead ? blendSamples(alive, dead, ghost) : dead ?? alive;
  }
  const dead = ghost >= 1;
  // 05.10-A7b-5 (7.10): under a liquid whose `LiquidType` row names a light, that row's slots
  // stand in for the whole spatial lookup; the darkening applies under any liquid that has one.
  // 05.10-A7b-5 review: a ghost's death light outranks the liquid's light and its darkening, as it
  // outranks the zone's underwater slot (`pair`) — under Kalimdor's lava a ghost read Light 7's
  // slot 4 (set 4) instead of the map's death set 3. Only a v5 body has liquids, so v4 is untouched.
  const liquid: LiquidLighting | undefined = underwater && !dead && liquidType !== undefined
    ? entry.liquids?.[liquidType] : undefined;
  const liquidSlots = liquid?.lightId ? entry.lights?.[liquid.lightId] : undefined;
  const resolved = resolveSpatial(entry, x, y, time, storm, maxBlended, z, overrideLightId, overrideWeight,
    overrideAreaLightId, overrideFromLightId, underwater, dead, liquidSlots);
  if (resolved && liquid?.maxDarkenDepth) {
    // 05.10-A7b-5 review: the overlay reads this to leave the depth darkening to the light alone.
    resolved.liquidDarkens = true;
    darkenUnderLiquid(resolved, liquid, liquidDepth);
  }
  return resolved;
}

/**
 * 05.10-A7b-5 (7.10): the deeper the eye under an ocean, the darker and closer the world.
 *
 * `darkness = clamp(depth / MaxDarkenDepth, 0, 1)`, then the fog distance, the ambient and the
 * direct light each lose up to their `…DarkenIntensity` share. Reading an intensity as "the largest
 * share taken off" is the plan's hypothesis (line-A7b 7.10), not Wow.exe's established formula;
 * the paired frame 14.25 calibrates it. In place: the sample is this frame's own object.
 */
export function darkenUnderLiquid(sample: LightSample, liquid: LiquidLighting, depth: number): void {
  const maxDepth = liquid.maxDarkenDepth ?? 0;
  if (!(maxDepth > 0) || !(depth > 0)) return;
  const darkness = Math.min(1, depth / maxDepth);
  const fog = 1 - clampUnit(liquid.fogDarken ?? 0) * darkness;
  sample.fogEnd *= fog;
  sample.fogStart *= fog;
  scaleColour(sample.colours.ambient, 1 - clampUnit(liquid.ambDarken ?? 0) * darkness);
  scaleColour(sample.colours.diffuse, 1 - clampUnit(liquid.dirDarken ?? 0) * darkness);
}

function clampUnit(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function scaleColour(colour: ResolvedColour, factor: number): void {
  colour.r *= factor;
  colour.g *= factor;
  colour.b *= factor;
}

function resolveSpatial(entry: LightIndexEntry, x: number, y: number, time: number,
  storm: number, maxBlended: number, z: number | undefined, overrideLightId: number | undefined,
  overrideWeight: number, overrideAreaLightId: number | undefined, overrideFromLightId: number | undefined,
  underwater: boolean, dead: boolean, liquidSlots: LightSlots | undefined): LightSample | undefined {
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
    // 05.10-A7b-5 (7.15): the death light has no storm and no water of its own; a body without
    // slot 4 (v4, or a row whose slot 4 repeats slot 0) reads slot 0.
    // 05.10-A7b-5 review: only where the body knows slot 4 — a v5 body (its sets carry the sky
    // channels) or a row naming one. A v4 body (old gateway) keeps the living storm and water
    // pair, so a ghost there sees exactly the light it saw before v5.
    if (dead && (slots.deathParams !== undefined
      || entry.params[slots.params]?.colours.sunColour !== undefined)) {
      return [slots.deathParams ?? slots.params, undefined];
    }
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
    ...(entry.fallbackDeath === undefined ? {} : { deathParams: entry.fallbackDeath }), // 05.10-A7b-5
  };
  if (liquidSlots) {
    // 05.10-A7b-5 (7.10): the liquid's light row replaces the zone; a server override naming the
    // active area still lays over it, through the same layer resolution as the map default.
    const underLiquid = resolveLayer(entry.fallbackLightId, liquidSlots);
    if (underLiquid) {
      underLiquid.liquidLight = true; // 05.10-A7b-5 review: this frame's own sample (overlay hook)
      return underLiquid;
    }
    return resolveLayer(entry.fallbackLightId, fallbackSlots);
  }
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
  /**
   * 05.10-A7b-0 1.24: a map whose request failed (network, 5xx) is asked again after 2 s, 8 s and
   * 30 s instead of never — until now one hiccup left "noon" and a 180–640 fog for the session.
   * A 404 (neither the map nor the global light) and a body that is not a table stay final (`null`).
   */
  readonly #failures: RetryLadder<number>;
  #success = 0;
  #error = 0;
  #generation = 0;

  /** 05.10-A7b-9 (7.18): maps lit by the default until a retry lands (1.24). */
  get retrying(): number {
    return this.#failures.retryingCount();
  }

  /** Immutable exact request counters; lifetime map cache membership is deliberately excluded. */
  get stats(): Readonly<BenchmarkAsyncReadinessStats> {
    return Object.freeze({
      pending: this.#loading.size,
      success: this.#success,
      // 05.10-A7b-0 1.24: plus maps failing now (waiting for a retry or out of retries).
      error: [...this.#maps.values()].filter((entry) => entry === null).length + this.#failures.size,
      generation: this.#generation,
    });
  }

  get generation(): number {
    return this.#generation;
  }

  get revision(): number {
    return this.#generation;
  }

  /** `now` (05.10-A7b-0 1.24) is the retry ladder's clock; tests inject their own. */
  constructor(gatewayWebSocketUrl: string, now?: () => number) {
    const url = new URL(gatewayWebSocketUrl);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    this.#baseUrl = url.origin;
    this.#failures = new RetryLadder<number>(undefined, now);
  }

  /**
   * The lighting at a point, or undefined until the map's table has arrived.
   *
   * `storm` is how far the weather has rolled in, 0 to 1. It is the packet's intensity with the
   * five-second fade applied — the renderer holds the shown value and walks it towards the target
   * — so it is that number over time rather than that number, and clear weather is a hard zero.
   *
   * `underwater` is the camera's eye against the liquid surface, and it is not the swim flag:
   * `stepCharacter` in `game/Physics.ts` compares the water over the character's feet with half its
   * collision height (`SWIM_DEPTH_RATIO`), which is what decides swimming,
   * while the sky changes when the *view* goes under and not a moment before.
   */
  sample(map: number, x: number, y: number, time: number, storm = 0, z?: number,
    overrideLightId?: number, overrideWeight = 1, overrideAreaLightId?: number,
    overrideFromLightId?: number, underwater = false, ghost = 0, liquidType?: number,
    liquidDepth = 0): LightSample | undefined {
    const entry = this.#maps.get(map);
    if (entry === undefined) {
      if (!this.#loading.has(map) && this.#failures.ready(map)) { // 05.10-A7b-0 1.24
        this.#loading.add(map);
        void this.#load(map);
      }
      return undefined;
    }
    return entry === null ? undefined : resolveLighting(entry, x, y, time, storm, 3, z,
      overrideLightId, overrideWeight, overrideAreaLightId, overrideFromLightId, underwater,
      ghost, liquidType, liquidDepth);
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
    let final = false; // 05.10-A7b-0 1.24: a 404 or a junk body is not asked again
    try {
      // The route caches for an hour, and slice R7 changed the payload's shape by adding the
      // storm set. Without a new query a browser that had already fetched this map would keep the
      // old body and quietly have no weather — which looks exactly like the 47% of rows where the
      // weather legitimately changes nothing. v3 is the underwater pair, slots 1 and 3, and the
      // same argument holds twice over: a stale body would look exactly like a client that had
      // never learned to dive.
      // v4 is `LightParams.Glow`, the strength of the full-screen glow. Same argument as v3: the
      // route caches for an hour, and a stale body would look exactly like a client whose zones all
      // happen to author no glow — which 47 of the 850 parameter sets genuinely do.
      // v5 (05.10-A7b-5) is line A7b's slice 5: the eighteen colour and six float channels with
      // HighlightSky, CloudTypeID and LightSkybox.Flags (7.04), slot 4 for a ghost (7.15) and the
      // light under lava and slime with the ocean's darkening (7.10). The shape grows only by
      // optional fields, so a gateway that has not been restarted answers v4 and every new field
      // reads as absent: the sky as before, a ghost under the living light, lava lit like water.
      const response = await fetch(`${this.#baseUrl}/dbc/light/${map}?v=5`);
      if (!response.ok) {
        final = response.status === 404; // 05.10-A7b-0 1.24
        throw new Error(`Light gateway returned ${response.status}`);
      }
      let value: LightIndexEntry;
      try {
        value = await response.json() as LightIndexEntry;
      } catch (error) {
        final = error instanceof SyntaxError; // 05.10-A7b-0 1.24: junk is final, a cut stream is not
        throw error;
      }
      if (!value || typeof value !== "object" || !Array.isArray(value.volumes) || !value.params) {
        final = true; // 05.10-A7b-0 1.24
        throw new Error("Light gateway returned an invalid table");
      }
      this.#failures.clear(map); // 05.10-A7b-0 1.24
      this.#maps.set(map, value);
      settle(true);
      this.onStatus?.(`Свет карты ${map}: ${value.volumes.length} объёмов`, false);
    } catch (error) {
      // 05.10-A7b-0 1.24: final → `null` as before; otherwise the ladder decides when to ask again.
      if (final) {
        this.#failures.clear(map);
        this.#maps.set(map, null);
      } else {
        this.#failures.failed(map);
      }
      settle(false);
      this.onStatus?.(error instanceof Error ? error.message : String(error), true);
    } finally {
      settle(false);
    }
  }
}
