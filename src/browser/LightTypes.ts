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

export interface LightParamSet {
  /** Packed 0xRRGGBB, the order the file stores. */
  colours: Record<LightColourChannel, LightBand<number>>;
  /** Yards. */
  fogEnd: LightBand<number>;
  /** Fraction of `fogEnd` at which the fog begins. */
  fogScale: LightBand<number>;
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
  volumes: LightVolume[];
  params: Record<number, LightParamSet>;
  /** Light.dbc row ids, used by SMSG_OVERRIDE_LIGHT scripted zone transitions. */
  lights?: Record<number, LightSlots>;
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
  /** Dominant authored sky model, if the selected profile names one. */
  skyboxPath?: string;
}
