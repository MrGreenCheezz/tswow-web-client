// The shape of what `/dbc/light/<map>` sends, and of what falls out of sampling it.
//
// Its own file so the browser does not reach into the gateway's module for a type and drag the
// DBC reader into the bundle with it.

export interface LightBand<T> {
  times: number[];
  values: T[];
}

export type LightColourChannel = "diffuse" | "ambient"
  | "skyTop" | "skyUpper" | "skyMiddle" | "skyLower" | "skyHorizon" | "fog"
  | "oceanClose" | "oceanFar" | "riverClose" | "riverFar";

/**
 * 05.10-A7b-5 (7.04 slice 0): LightIntBand channels 8-13, sent since payload v5. Sampled as packed
 * 0xRRGGBB numbers rather than unpacked like the twelve above, so they add no object to a frame.
 * Names are hypotheses (see `LightMetadata.ts` CHANNEL); `extra8`/`extra13` are unestablished.
 */
export type LightSkyChannel = "extra8" | "sunColour" | "sunHalo" | "cloudA" | "cloudB" | "extra13";

export interface LightParamSet {
  /** Packed 0xRRGGBB, the order the file stores. */
  colours: Record<LightColourChannel, LightBand<number>> & Partial<Record<LightSkyChannel, LightBand<number>>>;
  /** Yards. */
  fogEnd: LightBand<number>;
  /** Fraction of `fogEnd` at which the fog begins. */
  fogScale: LightBand<number>;
  /** 05.10-A7b-5 (7.04 slice 0): float channels 2-5; absent from a v4 body (old gateway). */
  celestialThrough?: LightBand<number>;
  cloudDensity?: LightBand<number>;
  float4?: LightBand<number>;
  float5?: LightBand<number>;
  /** `LightParams.HighlightSky` and `CloudTypeID`; absent from a v4 body. */
  highlightSky?: number;
  cloudType?: number;
  /** How opaque water and ocean are at the shore and out of their depth. One value each. */
  waterShallowAlpha: number;
  waterDeepAlpha: number;
  oceanShallowAlpha: number;
  oceanDeepAlpha: number;
  /**
   * `LightParams.Glow`, the strength of the original client's full-screen glow in this zone.
   *
   * Optional on purpose: a gateway built before P4 answers a body without it, and the browser has
   * to read that as no glow rather than as a broken table. The route's `v` query is bumped so a
   * fresh page asks again, but an old answer may still be in an HTTP cache the client does not own.
   */
  glow?: number;
  /** Path from LightSkybox.dbc, when this profile has an authored sky model. */
  skyboxPath?: string;
  /** 05.10-A7b-5 (7.04 slice 0): `LightSkybox.Flags` beside the path; absent from a v4 body. */
  skyboxFlags?: number;
}

/** The four of a `Light.dbc` row's eight slots this client reads; a slot that repeats is absent. */
export interface LightSlots {
  params: number;
  /** Slot 2 of the row's eight — the same place under a storm — when it differs from slot 0. */
  stormParams?: number;
  /** Slot 1 — the same place seen from under water — when it differs from slot 0, i.e. usually. */
  underwaterParams?: number;
  /** Slot 3, the underwater storm, when it differs from the set slot 1 resolves to. */
  underwaterStormParams?: number;
  /** 05.10-A7b-5 (7.15): slot 4, the death light, when it differs from slot 0; absent from v4. */
  deathParams?: number;
}

/** 05.10-A7b-5 (7.10): a `LiquidType` row's light row and darkening; absent fields are zero. */
export interface LiquidLighting {
  lightId?: number;
  /** Yards of depth at which the darkening is full (30 on the oceans). */
  maxDarkenDepth?: number;
  /** The largest share taken off the fog distance, the ambient and the direct light. */
  fogDarken?: number;
  ambDarken?: number;
  dirDarken?: number;
}

export interface LightVolume extends LightSlots {
  id: number;
  x: number;
  y: number;
  z: number;
  innerRadius: number;
  outerRadius: number;
}

export interface LightIndexEntry {
  fallback: number | undefined;
  /** Light.dbc row id of the map fallback (distinct from `fallback`, a LightParams id). */
  fallbackLightId?: number | undefined;
  fallbackStorm?: number | undefined;
  fallbackUnderwater?: number | undefined;
  fallbackUnderwaterStorm?: number | undefined;
  /** 05.10-A7b-5 (7.15): the fallback's death set; absent from a v4 body. */
  fallbackDeath?: number | undefined;
  volumes: LightVolume[];
  params: Record<number, LightParamSet>;
  /** Light.dbc row ids, used by SMSG_OVERRIDE_LIGHT scripted zone transitions. */
  lights?: Record<number, LightSlots>;
  /** 05.10-A7b-5 (7.10): LiquidType rows by id, with their light rows added to `lights`. */
  liquids?: Record<number, LiquidLighting>;
}

export interface ResolvedColour {
  r: number;
  g: number;
  b: number;
}

export interface LightSample {
  colours: Record<LightColourChannel, ResolvedColour>;
  /** Yards, which this project draws as metres. */
  fogEnd: number;
  fogStart: number;
  waterShallowAlpha: number;
  waterDeepAlpha: number;
  oceanShallowAlpha: number;
  oceanDeepAlpha: number;
  /** Authored full-screen glow strength here, blended across volumes like the alphas beside it. */
  glow: number;
  /**
   * 05.10-A7b-5 (7.04 slice 0): what payload v5 adds, sampled and blended like the rest but kept
   * as numbers — packed 0xRRGGBB for the colours — so the sample object is no larger in objects.
   * `skyChannels` is false when the body predates v5 (an old gateway), and every field is 0.
   */
  skyChannels: boolean;
  extra8: number;
  sunColour: number;
  sunHalo: number;
  cloudA: number;
  cloudB: number;
  extra13: number;
  celestialThrough: number;
  cloudDensity: number;
  float4: number;
  float5: number;
  /** The dominant profile's `HighlightSky`, `CloudTypeID` and `LightSkybox.Flags` (0 without a sky). */
  highlightSky: number;
  cloudType: number;
  skyboxFlags: number;
  /**
   * 05.10-A7b-5 review (7.10 overlay hook): whether this sample is the light row a `LiquidType`
   * names (under lava or slime), and whether its liquid darkens the light by depth (the oceans).
   * False on a v4 body. The underwater overlay reads them so the depth is darkened once.
   */
  liquidLight: boolean;
  liquidDarkens: boolean;
  /** Dominant authored sky model, if the selected profile names one. */
  skyboxPath?: string;
}
