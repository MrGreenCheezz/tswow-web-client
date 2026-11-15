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
import { zoneOutlineWeights } from "./ZoneLightOutlines.js"; // 15.11 (light7)
import type { LightOverride } from "../world/LightOverrideList.js"; // 15.11 (sky8, 7.67)

export type { LightSample };
export type { LightOverride };

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

/**
 * Progress for an SMSG_OVERRIDE_LIGHT transition. 15.11 (sky8, 7.67): the world keeps Wow.exe's list instead
 * (`LightOverrideList`), which steps each entry's weight by the same elapsed / duration; kept for callers of the
 * single-transition form.
 */
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

/** 11.11 (7.65): Wow.exe 0x007ecd80 never lets a set's fog end come nearer than this (0x009e30cc). */
export const LIGHT_FOG_END_FLOOR_YARDS = 10;

function sampleSet(set: LightParamSet, time: number): LightSample {
  const colours = {} as LightSample["colours"];
  for (const channel of CHANNELS) {
    const band = set.colours[channel];
    const value = sampleBand(band.times, band.values, time, mixColour);
    colours[channel] = unpack(value ?? 0);
  }
  // 11.11 (7.65): Wow.exe samples a set's fog the same way wherever it comes from — the zone, a
  // liquid's own set (0x007f3230 → 0x007ecd80) or the death slot: band 0 times 1/36 (0x007eaef0,
  // 0x00a3f854, the gateway's `/ 36`), at least 10 yards (0x007ecd80, 0x009e30cc), and band 1, the
  // start's share, clamped to [-1, 1] (0x007ebff0). 0x007f16f0 then takes the nearer of it and the
  // far clip and puts the start at end × share.
  const fogEnd = Math.max(LIGHT_FOG_END_FLOOR_YARDS,
    sampleBand(set.fogEnd.times, set.fogEnd.values, time, mixNumber) ?? 500);
  const fogScale = Math.min(1, Math.max(-1,
    sampleBand(set.fogScale.times, set.fogScale.values, time, mixNumber) ?? 0.25));
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

/**
 * A volume's weight across its falloff. 15.11 (light7): linear, as Wow.exe 0x007ee5d0 has it —
 * 1 − (distance − inner) / (outer − inner), 1 inside the inner radius, 0 from the outer one (0x007f1360 takes a
 * volume only while distance² < outer²). It was a smoothstep, which agrees at both ends and at the middle.
 */
function falloffWeight(distance: number, inner: number, outer: number): number {
  if (distance <= inner) return 1;
  if (distance >= outer || outer <= inner) return 0;
  return 1 - (distance - inner) / (outer - inner);
}

/**
 * Resolves the lighting at one point of one map.
 *
 * The map's own default is the floor; the zone outlines, then every volume that reaches the point, then the
 * server's scripted lights are laid over it, as Wow.exe 0x007f1360 builds the frame's light.
 *
 * 15.11 (sky8, 7.67): `overrides` is the world's `LightOverrideList` (SMSG_OVERRIDE_LIGHT). The single-transition
 * arguments that stood after it and the `maxBlended` cap are gone: Wow.exe blends every volume that reaches the point.
 */
export function resolveLighting(entry: LightIndexEntry, x: number, y: number, time: number,
  storm = 0, z?: number, overrides?: readonly LightOverride[],
  underwater = false, ghost = 0, liquidType?: number, liquidDepth = 0): LightSample | undefined {
  // 05.10-A7b-5 (7.15): a weight between 0 and 1 is the two lights crossfaded. 11.11: Wow.exe
  // switches in one frame (`GhostLightFade`), so the world loop no longer asks for one.
  if (ghost > 0 && ghost < 1) {
    const alive = resolveLighting(entry, x, y, time, storm, z, overrides, underwater, 0, liquidType, liquidDepth);
    const dead = resolveLighting(entry, x, y, time, storm, z, overrides, underwater, 1, liquidType, liquidDepth);
    return alive && dead ? blendSamples(alive, dead, ghost) : dead ?? alive;
  }
  // 05.10-A7b-5 (7.10): under a liquid whose `LiquidType` row names a light, that row's slots
  // stand in for the whole spatial lookup; the darkening applies under any liquid that has one.
  // 06.11 (7.65): the row's LightID is a LightParams set read whole (Wow.exe under Onyxia's lava fogs to
  // set 7's 200,52,0); a gateway before 7.65 sent it as `lightId`, a Light row, and is read as before.
  // 11.11 (7.15): and it outranks the death light, as Wow.exe 0x007f3230 orders its branches — a
  // liquid with a light is read before the death slot is ever looked at; the darkening by depth
  // follows either (the block after both branches).
  const liquid: LiquidLighting | undefined = underwater && liquidType !== undefined
    ? entry.liquids?.[liquidType] : undefined;
  const liquidSlots = liquid?.paramsId !== undefined
    ? (entry.params[liquid.paramsId] ? { params: liquid.paramsId } : undefined)
    : liquid?.lightId ? entry.lights?.[liquid.lightId] : undefined;
  const dead = ghost >= 1 && liquidSlots === undefined;
  const alive = resolveSpatial(entry, x, y, time, storm, z, overrides, underwater, liquidSlots);
  const resolved = dead ? deathLight(entry, time, alive) ?? alive : alive;
  if (resolved && liquid?.maxDarkenDepth) {
    // 05.10-A7b-5 review: the overlay reads this to leave the depth darkening to the light alone.
    resolved.liquidDarkens = true;
    darkenUnderLiquid(resolved, liquid, liquidDepth);
  }
  return resolved;
}

/**
 * 11.11 (7.15): a ghost's light, as Wow.exe 0x007f3230 builds it.
 *
 * The slot comes from `ScreenEffect` — 0x004f7020 hands the row's word at +0x1c to 0x007ecec0, and
 * row 1 "Ghost Screen Effect" says 4 — and it is read from the first `Light` row of the map's list
 * alone (0x007eb180 on `*0x00d3900c`): the map's own default row, or row 1 for a map that has none
 * (0x007ecb30), whatever volume the ghost stands in. A zero slot leaves the living light. The set
 * then replaces the colours, the fog and the sky floats outright — no storm, no underwater slot, no
 * blend — while the living sample keeps its glow, its four water alphas, its cloud type and its
 * skybox, unless the death set names a skybox of its own (`DeathSkybox`). A v4 body (an old
 * gateway, no sky channels and no slot 4) keeps the living light, as it always did.
 */
function deathLight(entry: LightIndexEntry, time: number, alive: LightSample | undefined): LightSample | undefined {
  if (entry.fallback === undefined) return undefined;
  const v5 = entry.fallbackDeath !== undefined || entry.params[entry.fallback]?.colours.sunColour !== undefined;
  if (!v5) return undefined;
  // The gateway sends slot 4 only where it differs from slot 0; absent, the slot names the clear set.
  const set = entry.params[entry.fallbackDeath ?? entry.fallback];
  if (!set) return undefined;
  const death = sampleSet(set, time);
  if (!alive) return death;
  death.glow = alive.glow;
  death.waterShallowAlpha = alive.waterShallowAlpha;
  death.waterDeepAlpha = alive.waterDeepAlpha;
  death.oceanShallowAlpha = alive.oceanShallowAlpha;
  death.oceanDeepAlpha = alive.oceanDeepAlpha;
  death.cloudType = alive.cloudType;
  if (death.skyboxPath === undefined) {
    death.skyboxFlags = alive.skyboxFlags;
    if (alive.skyboxPath !== undefined) death.skyboxPath = alive.skyboxPath;
  }
  return death;
}

/**
 * 05.10-A7b-5 (7.10): the deeper the eye under an ocean, the darker and closer the world.
 *
 * `darkness = clamp(depth / MaxDarkenDepth, 0, 1)`, then the ambient and the direct light each lose
 * `darkness × …DarkenIntensity` of their brightness. 11.11 (7.65): that is Wow.exe's own formula —
 * 0x007f3230 scales the HSV value of the ambient (0x00d38cac) and direct (0x00d38ca8) colours by
 * `1 + (−darkness) · intensity` (0x007ed790), and an HSV value scale is the RGB scale below. The fog
 * distance is not darkened: nothing there writes the fog end (0x00d38c1c); 7.10 had shortened it by
 * `FogDarkenIntensity`, which 0x007f3230 applies to the fog colour 0x00d38b8c instead — and 0x007f16f0,
 * run after it in the same frame (0x007816f0), sets that colour afresh from the light, so it is
 * not taken here either. In place: the sample is this frame's own object.
 */
export function darkenUnderLiquid(sample: LightSample, liquid: LiquidLighting, depth: number): void {
  const maxDepth = liquid.maxDarkenDepth ?? 0;
  if (!(maxDepth > 0) || !(depth > 0)) return;
  const darkness = Math.min(1, depth / maxDepth);
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

/** 0x009ebbc4: Wow.exe leaves out a volume whose outer radius is under 3 yards (0x007f1360, gate 0x00af4a68 = 1). */
export const LIGHT_VOLUME_MIN_OUTER = 3;
/** 0x00af4da8: two volumes whose centres are within a third of a yard are ordered by their inner radius (0x007ed0a0). */
export const LIGHT_VOLUME_SAME_CENTRE = 0.3333333432674408;

/** A volume that reaches the point, with the key Wow.exe's heap orders it by. */
export interface ReachedVolume<V extends { x: number; y: number; z: number; innerRadius: number }> {
  readonly volume: V;
  /** The point's squared distance from the centre (0x007f1360). */
  readonly key: number;
  readonly weight: number;
}

/**
 * 15.11 (sky8, 7.67): the order Wow.exe blends the volumes in. 0x007f1360 pushes every reaching volume, in the map's
 * Light.dbc order, into a binary heap (0x007f0dc0) and pops it empty (0x007f1280), blending each popped volume over
 * the frame (0x007ee5d0). The comparator 0x007ed0a0 puts `a` above `b` when b's squared distance is not greater
 * than a's, or — for two centres within a third of a yard — when b's inner radius is not greater than a's. So the
 * farthest volume is blended first and the nearest last, and around one centre the widest inner radius first and
 * the tightest last. The heap is run as Wow.exe runs it, ties and all, rather than replaced by a sort.
 */
export function wowVolumeBlendOrder<V extends { x: number; y: number; z: number; innerRadius: number }>(
  reached: readonly ReachedVolume<V>[],
): ReachedVolume<V>[] {
  const above = (a: ReachedVolume<V>, b: ReachedVolume<V>): boolean => {
    const centres = Math.hypot(b.volume.x - a.volume.x, b.volume.y - a.volume.y, b.volume.z - a.volume.z);
    return centres > LIGHT_VOLUME_SAME_CENTRE ? b.key <= a.key : b.volume.innerRadius <= a.volume.innerRadius;
  };
  const heap: ReachedVolume<V>[] = [reached[0]!]; // slot 0 unused: the heap is 1-based
  for (const item of reached) {
    let index = heap.length;
    heap.push(item);
    while (index > 1) {
      const parent = index >> 1;
      if (!above(item, heap[parent]!)) break;
      heap[index] = heap[parent]!;
      index = parent;
    }
    heap[index] = item;
  }
  const order: ReachedVolume<V>[] = [];
  while (heap.length > 1) {
    order.push(heap[1]!);
    const last = heap.pop()!;
    const count = heap.length - 1;
    if (count < 1) break;
    const half = count >> 1;
    let index = 1;
    if (half !== 0) {
      let child: number;
      do {
        child = index * 2;
        if (child < count && above(heap[child + 1]!, heap[child]!)) child++;
        if (above(last, heap[child]!)) break;
        heap[index] = heap[child]!;
        index = child;
      } while (child <= half);
    }
    heap[index] = last;
  }
  return order;
}

/**
 * 15.11 (sky8, 7.67): where an area light stands and how far it reaches, as 0x007f10a0 copies it into the scripted
 * entry. A Light row at the grid origin keeps its stored radii unscaled (0x007eaf60 converts only rows with a
 * position), so a map's default reaches tens of thousands of yards from the world's origin — all of Icecrown Citadel
 * from 2488 — while Light 1 reaches nothing. `fallbackReach` is the gateway's stored pair; a gateway before it sends
 * none, and the default is then taken to reach everywhere, which is what the rows TrinityCore names do.
 */
function areaLightReach(entry: LightIndexEntry, areaLightId: number):
  { x: number; y: number; z: number; innerRadius: number; outerRadius: number } | undefined {
  if (areaLightId === entry.fallbackLightId) {
    const reach = entry.fallbackReach;
    return reach === undefined
      ? { x: 0, y: 0, z: 0, innerRadius: Number.POSITIVE_INFINITY, outerRadius: Number.POSITIVE_INFINITY }
      : { x: 0, y: 0, z: 0, innerRadius: reach[0], outerRadius: reach[1] };
  }
  return entry.volumes.find((volume) => volume.id === areaLightId);
}

function resolveSpatial(entry: LightIndexEntry, x: number, y: number, time: number,
  storm: number, z: number | undefined, overrides: readonly LightOverride[] | undefined,
  underwater: boolean, liquidSlots: LightSlots | undefined): LightSample | undefined {
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
    // 11.11 (7.15): the death slot is not read per volume here; `deathLight` takes it from the
    // map's default row alone, as Wow.exe 0x007f3230 does.
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
  // Light.dbc stores a full (x, y, z) GameCoords point. The 2D fallback is kept for callers that only have a map
  // coordinate; the world loop always supplies the player's z, which is essential on stacked spaces such as Dalaran
  // and the Crystalsong airships.
  const distanceTo = (volume: { x: number; y: number; z: number }): number => z === undefined
    ? Math.hypot(volume.x - x, volume.y - y)
    : Math.hypot(volume.x - x, volume.y - y, volume.z - z);
  const resolveLayer = (slots: LightSlots | undefined): LightSample | undefined => layer(...pair(slots));
  const fallbackSlots: LightSlots | undefined = entry.fallback === undefined ? undefined : {
    params: entry.fallback,
    ...(entry.fallbackStorm === undefined ? {} : { stormParams: entry.fallbackStorm }),
    ...(entry.fallbackUnderwater === undefined ? {} : { underwaterParams: entry.fallbackUnderwater }),
    ...(entry.fallbackUnderwaterStorm === undefined
      ? {} : { underwaterStormParams: entry.fallbackUnderwaterStorm }),
    ...(entry.fallbackDeath === undefined ? {} : { deathParams: entry.fallbackDeath }), // 05.10-A7b-5
  };
  if (liquidSlots) {
    // 05.10-A7b-5 (7.10): the liquid's light row replaces the zone. 15.11 (sky8, 7.67): and nothing is laid over
    // it — Wow.exe 0x007f3230 runs the outlines, the volumes and the scripted lights (0x007f1360) only on the
    // branch without a liquid light.
    const underLiquid = resolveLayer(liquidSlots);
    if (underLiquid) {
      underLiquid.liquidLight = true; // 05.10-A7b-5 review: this frame's own sample (overlay hook)
      return underLiquid;
    }
    return resolveLayer(fallbackSlots);
  }
  // 15.11 (light7): Wow.exe's zone outlines (Northrend's eleven) lay their lights over the map default before any
  // volume does (0x007f1360 → 0x007ee6b0; `ZoneLightOutlines.ts`).
  let sample = resolveLayer(fallbackSlots);
  for (const { lightId, weight } of zoneOutlineWeights(entry.zoneOutlines, undefined, x, y)) {
    if (weight <= 0) continue;
    const zoneLayer = resolveLayer(entry.lights?.[lightId]);
    if (zoneLayer) sample = sample ? blendSamples(sample, zoneLayer, weight) : zoneLayer;
  }
  // 15.11 (sky8, 7.67): every volume whose outer radius reaches the point (and is at least 3 yards), blended in
  // Wow.exe's heap order — farthest centre first, nearest last (`wowVolumeBlendOrder`). There is no cap on their
  // number. It was the three of greatest weight, blended from the widest outer radius to the tightest.
  const reached: ReachedVolume<(typeof entry.volumes)[number]>[] = [];
  for (const volume of entry.volumes) {
    if (!(volume.outerRadius >= LIGHT_VOLUME_MIN_OUTER)) continue;
    const distance = distanceTo(volume);
    if (!(distance < volume.outerRadius)) continue;
    const weight = falloffWeight(distance, volume.innerRadius, volume.outerRadius);
    if (weight > 0) reached.push({ volume, key: distance * distance, weight });
  }
  for (const { volume, weight } of wowVolumeBlendOrder(reached)) {
    const resolvedLayer = resolveLayer(volume);
    if (!resolvedLayer) continue;
    sample = sample ? blendSamples(sample, resolvedLayer, weight) : resolvedLayer;
  }
  // 15.11 (sky8, 7.67): SMSG_OVERRIDE_LIGHT, last (0x007f1360's third step). Each live entry lays its override
  // light's sets over the frame with the smaller of its fade and the falloff of the area light's place; a point
  // outside that place takes nothing. Both rows have to be Light.dbc rows of this map (0x007f10a0 needs both).
  for (const override of overrides ?? []) {
    if (!(override.weight > 0)) continue;
    const slots = entry.lights?.[override.overrideLightId];
    const area = areaLightReach(entry, override.areaLightId);
    if (!slots || !area) continue;
    const distance = distanceTo(area);
    if (!(distance < area.outerRadius)) continue;
    const weight = Math.min(falloffWeight(distance, area.innerRadius, area.outerRadius), override.weight);
    const scripted = resolveLayer(slots);
    if (scripted && weight > 0) sample = sample ? blendSamples(sample, scripted, weight) : scripted;
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
    url.protocol = url.protocol === "wss:" || url.protocol === "https:" ? "https:" : "http:";
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
    overrides?: readonly LightOverride[], underwater = false, ghost = 0, liquidType?: number,
    liquidDepth = 0): LightSample | undefined {
    const entry = this.#maps.get(map);
    if (entry === undefined) {
      if (!this.#loading.has(map) && this.#failures.ready(map)) { // 05.10-A7b-0 1.24
        this.#loading.add(map);
        void this.#load(map);
      }
      return undefined;
    }
    return entry === null ? undefined : resolveLighting(entry, x, y, time, storm, z,
      overrides, underwater, ghost, liquidType, liquidDepth);
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
      // v7 (15.11, light7): `zoneOutlines`, Northrend's zone lights from the user's Wow.exe. Optional like the rest:
      // an older gateway answers without it and Northrend keeps its default outside the volumes.
      // v8 (15.11, sky8, 7.67): `fallbackReach`, the default row's stored radii for SMSG_OVERRIDE_LIGHT; without it
      // a scripted light over the map default reaches everywhere, as it does for the rows TrinityCore names.
      const response = await fetch(`${this.#baseUrl}/dbc/light/${map}?v=8`);
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
