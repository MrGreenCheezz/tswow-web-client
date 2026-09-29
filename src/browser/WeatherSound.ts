/**
 * What the weather sounds like (`experimentalWeatherSounds`, «Звуки грозы и ветра»).
 *
 * Only the client's own sounds, found in its `SoundEntries.dbc` and checked against its archives
 * (`Sound\Ambience\Weather\` holds exactly nine files, all in common.MPQ):
 *
 * - the weather loops — `Weather - RainLight/RainMedium/RainHeavy` (8533–8535),
 *   `Weather - SnowLight/SnowMedium/SnowHeavy` (8536–8538) and
 *   `Weather - SandstormLight/Medium/Heavy` (8556–8558), one tier per the server's own thresholds;
 * - the wind under a rainstorm — the client has no separate wind loop in that directory, and its
 *   snow loops are exactly that (snow falls silently: what they carry is wind, 43–57% of their
 *   energy below 250 Hz), so a stiff wind borrows `SnowLight` and a gale `SnowMedium`;
 * - thunder — `LightningBolt - ZulGurub` (8439), the client's sky-lightning doodad kit:
 *   `Sound\Doodad\BlastedLandsLightningbolt01Stand-Bolt{,1,2,3}.wav`. `-Bolt` is a crack with its
 *   rumble (peak at 0.28 s); `Bolt1..3` are 4–6 s rolls that build for a second (63–74% of their
 *   energy below 250 Hz), which is what thunder from a far bolt sounds like.
 *
 * Thunder follows the strike it belongs to (Lightning.ts): the flash is seen at once and the clap
 * arrives after the time sound takes to cover the distance — 343 m/s is 375 yd/s, so a bolt 240–500
 * yards away is heard 0.64–1.33 s later — quieter and duller the further off it is.
 *
 * Everything plays on the ambience channel, so the «Окружение» slider and its switch govern it,
 * and OFF plays nothing at all. Pure functions for the numbers; one small driver for the state.
 */

import type { SoundKit } from "./Sound.js";
import type { AtmosphereAudioState } from "./AtmosphereEffects.js";
import type { WeatherKind } from "../world/WorldMessageProtocol.js";

/** `SoundEntries` ids of the client's weather loops, light / medium / heavy. */
export const WEATHER_LOOP_KITS: Readonly<Record<"rain" | "snow" | "sand", readonly [number, number, number]>> =
  Object.freeze({
    rain: Object.freeze([8533, 8534, 8535] as const),
    snow: Object.freeze([8536, 8537, 8538] as const),
    sand: Object.freeze([8556, 8557, 8558] as const),
  });
/** `LightningBolt - ZulGurub`: the four BlastedLands lightning-bolt files. */
export const THUNDER_KIT = 8439;
/** The wind: `Weather - SnowLight` for a stiff wind, `Weather - SnowMedium` (gustier) for a gale. */
export const WIND_STIFF_KIT = 8536;
export const WIND_GALE_KIT = 8537;

/** 343 m/s in yards per second (1 yd = 0.9144 m). */
export const SPEED_OF_SOUND_YARDS = 343 / 0.9144;
/** Beyond this a bolt is heard only as a roll: the crack variant is left out. */
export const THUNDER_ROLL_ONLY_YARDS = 330;
/** How often the loops are retargeted (their ramps are longer than this). */
export const WEATHER_SOUND_PUSH_MS = 200;

const clamp01 = (value: number): number => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
const smoothstep = (a: number, b: number, x: number): number => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/**
 * Which of the three loops, 0 light … 2 heavy. The renderer's density is the packet's intensity
 * (floored at 0.15), and TrinityCore's `Weather::GetWeatherState` splits light/medium/heavy at 0.40
 * and 0.70 — so these are the server's own tiers. A thunderstorm is the heavy loop. `previous`
 * adds a little hysteresis on the way down so a fading storm does not flip between two files.
 */
export function weatherLoopTier(density: number, thunder: boolean, previous = -1): 0 | 1 | 2 {
  if (thunder) return 2;
  const d = clamp01(density);
  const down = 0.06;
  if (d >= 0.7 || (previous === 2 && d >= 0.7 - down)) return 2;
  if (d >= 0.4 || (previous >= 1 && d >= 0.4 - down)) return 1;
  return 0;
}

/** The `SoundEntries` id of the loop for this weather, or undefined for none (fine, fog). */
export function weatherLoopKit(kind: WeatherKind, tier: 0 | 1 | 2): number | undefined {
  return kind === "rain" || kind === "snow" || kind === "sand" ? WEATHER_LOOP_KITS[kind][tier] : undefined;
}

/**
 * How loud the loop is, 0..1 of its kit volume: it follows the weather's own five-second fade in and
 * out, is muffled to 40% under a roof and silent under water.
 */
export function weatherLoopLevel(kind: WeatherKind, density: number, indoors: boolean, underwater: boolean): number {
  if (underwater || weatherLoopKit(kind, 0) === undefined) return 0;
  return clamp01(density / 0.3) * (indoors ? 0.4 : 1);
}

/**
 * How loud the wind is, 0..1: nothing in a calm (the zone's own ambience already carries a breeze)
 * and in snow or sand (their loops are wind), rising from a stiff wind to a gale and breathing with
 * the gusts. Quieter indoors, silent under water.
 */
export function windLevel(kind: WeatherKind, wind: number, gust: number, indoors: boolean, underwater: boolean): number {
  if (underwater || kind === "snow" || kind === "sand") return 0;
  return smoothstep(0.55, 0.95, wind) * (0.5 + 0.5 * clamp01(gust)) * (indoors ? 0.35 : 1);
}

export function windKit(wind: number): number {
  return wind >= 0.85 ? WIND_GALE_KIT : WIND_STIFF_KIT;
}

/** Seconds between a strike `distance` yards away being seen and heard. */
export function thunderDelaySeconds(distance: number): number {
  return Math.max(0, Number.isFinite(distance) ? distance : 0) / SPEED_OF_SOUND_YARDS;
}

/**
 * How loud a clap is, 0..1 of the kit's volume: inverse distance (softened) from the nearest bolt
 * the storm throws (240 yd), the storm's strength, and a wall in between.
 */
export function thunderLevel(distance: number, strength: number, indoors: boolean): number {
  const d = Math.max(60, Number.isFinite(distance) ? distance : 240);
  const attenuation = Math.min(1, Math.pow(240 / d, 0.75));
  return clamp01((0.55 + 0.45 * clamp01(strength)) * attenuation * (indoors ? 0.5 : 1));
}

/** Air takes the crack first: ~7 kHz left at 240 yd, ~2.5 kHz at 500; a wall leaves the rumble. */
export function thunderLowpassHz(distance: number, indoors: boolean): number {
  const d = Math.max(60, Number.isFinite(distance) ? distance : 240);
  const hz = Math.min(12000, 7000 * Math.pow(240 / d, 1.4));
  return indoors ? Math.min(hz, 700) : hz;
}

/** The files a clap may use: all of the kit near, only the rolls (`Bolt1..3`) far. */
export function thunderFiles(kit: SoundKit, distance: number): readonly string[] {
  if (distance <= THUNDER_ROLL_ONLY_YARDS) return kit.files;
  const rolls = kit.files.filter((file) => /bolt\d\.wav$/i.test(file));
  return rolls.length > 0 ? rolls : kit.files;
}

/** Where the driver sends its sounds (SoundPlayer implements it). */
export interface WeatherSoundOutput {
  setAmbientLayer(slot: string, kit: SoundKit | undefined, level: number,
    options?: { rampSeconds?: number; lowpassHz?: number }): void;
  playAmbientShot(kit: SoundKit, options?: {
    delaySeconds?: number; level?: number; lowpassHz?: number; pan?: number; file?: string;
  }): void;
  stopAmbientLayers(fadeSeconds?: number): void;
}

/** Where the driver finds kits (SoundClient implements it: undefined until the batch lands). */
export interface WeatherSoundKits {
  kit(id: number): SoundKit | undefined;
}

/** One scheduled clap, kept for diagnostics and the evidence log. */
export interface ThunderEvent {
  readonly atMs: number;
  readonly distance: number;
  readonly delaySeconds: number;
  readonly level: number;
  readonly lowpassHz: number;
  readonly pan: number;
  readonly file: string;
}

export class WeatherSoundDriver {
  #seenStrikes = 0;
  #tier = -1;
  #lastPush = Number.NEGATIVE_INFINITY;
  #active = false;
  #random: () => number;
  /** The last few claps scheduled, newest last. */
  readonly thunder: ThunderEvent[] = [];

  constructor(random: () => number = Math.random) {
    this.#random = random;
  }

  /**
   * One frame. `state` is the atmosphere's audio snapshot (undefined: the renderer has none);
   * `enabled` the account switch. `now` in milliseconds.
   */
  update(now: number, state: Readonly<AtmosphereAudioState> | undefined, enabled: boolean,
    out: WeatherSoundOutput, kits: WeatherSoundKits): void {
    if (!enabled || !state) {
      if (this.#active) out.stopAmbientLayers(1.5);
      this.#active = false;
      this.#tier = -1;
      this.#seenStrikes = state?.strikes ?? 0;
      return;
    }
    if (!this.#active) {
      // Switched on mid-storm: strikes before this moment are history, not a queue of claps.
      this.#seenStrikes = state.strikes;
      this.#active = true;
    }
    if (state.strikes < this.#seenStrikes) this.#seenStrikes = state.strikes;
    if (state.strikes > this.#seenStrikes) {
      this.#seenStrikes = state.strikes;
      // Asked for as soon as a storm is on (below), so the kit is normally here by the first bolt.
      const kit = kits.kit(THUNDER_KIT);
      if (kit && !state.underwater) this.#thunder(now, state, kit, out);
    }
    if (now - this.#lastPush < WEATHER_SOUND_PUSH_MS && now >= this.#lastPush) return;
    this.#lastPush = now;
    if (state.thunder) kits.kit(THUNDER_KIT);
    const tier = weatherLoopTier(state.density, state.thunder, this.#tier);
    this.#tier = tier;
    const loopId = weatherLoopKit(state.kind, tier);
    const loopLevel = weatherLoopLevel(state.kind, state.density, state.indoors, state.underwater);
    if (loopId === undefined || loopLevel <= 0) out.setAmbientLayer("weather", undefined, 0, { rampSeconds: 1.5 });
    else {
      const kit = kits.kit(loopId);
      if (kit) out.setAmbientLayer("weather", kit, loopLevel, { rampSeconds: 1.5, lowpassHz: state.indoors ? 1200 : 20000 });
    }
    const gustLevel = windLevel(state.kind, state.wind, state.gust, state.indoors, state.underwater);
    if (gustLevel <= 0) out.setAmbientLayer("wind", undefined, 0, { rampSeconds: 2 });
    else {
      const kit = kits.kit(windKit(state.wind));
      // A short ramp, so a gust is heard as a gust; muffled more than the rain indoors.
      if (kit) out.setAmbientLayer("wind", kit, gustLevel, { rampSeconds: 0.6, lowpassHz: state.indoors ? 700 : 20000 });
    }
  }

  #thunder(now: number, state: Readonly<AtmosphereAudioState>, kit: SoundKit, out: WeatherSoundOutput): void {
    const distance = state.strikeDistance;
    const files = thunderFiles(kit, distance);
    const file = files[Math.min(files.length - 1, Math.floor(this.#random() * files.length))]!;
    const event: ThunderEvent = {
      atMs: now,
      distance,
      delaySeconds: thunderDelaySeconds(distance),
      level: thunderLevel(distance, state.strikeStrength, state.indoors),
      lowpassHz: thunderLowpassHz(distance, state.indoors),
      pan: Math.max(-1, Math.min(1, state.strikePan * 0.7)),
      file,
    };
    this.thunder.push(event);
    if (this.thunder.length > 8) this.thunder.shift();
    out.playAmbientShot(kit, {
      delaySeconds: event.delaySeconds, level: event.level, lowpassHz: event.lowpassHz, pan: event.pan, file,
    });
  }

  /** Leaving a world: forget the storm (the player's layers are stopped by the caller). */
  reset(): void {
    this.#seenStrikes = 0;
    this.#tier = -1;
    this.#lastPush = Number.NEGATIVE_INFINITY;
    this.#active = false;
    this.thunder.length = 0;
  }
}
