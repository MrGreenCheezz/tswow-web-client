// What the debug pane forces on the picture: the time of day and the weather.
//
// Both are local to this page and to drawing. The server is never told, the clock stock FrameXML
// reads (`GetGameTime`) keeps the realm's time, and taking an override off hands the frame back to
// what the server last said. The render loop asks once a frame; with nothing forced the answers are
// the server's own objects, by identity, so the renderer's change checks see no difference.

import type { GameTime } from "../../world/GameTimeProtocol.js";
import type { LightSample } from "../LightTypes.js";
import {
  WEATHER_BLACK_RAIN, WEATHER_BLACK_SNOW, WEATHER_DRIZZLE, WEATHER_FINE, WEATHER_FOG, WEATHER_HEAVY_RAIN,
  WEATHER_HEAVY_SANDSTORM, WEATHER_HEAVY_SNOW, WEATHER_LIGHT_RAIN, WEATHER_LIGHT_SANDSTORM, WEATHER_LIGHT_SNOW,
  WEATHER_MEDIUM_RAIN, WEATHER_MEDIUM_SANDSTORM, WEATHER_MEDIUM_SNOW, WEATHER_THUNDERS,
  type Weather,
} from "../../world/WorldMessageProtocol.js";

const DAY_MINUTES = 1440;

/** The realm clock's own pace when no packet has said otherwise: one game minute per real minute. */
const SERVER_DEFAULT_SPEED = 1 / 60;

function wrapMinute(minute: number): number {
  return ((minute % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
}

/**
 * A forced clock: where it stood at `anchoredAt` and how fast it runs from there.
 *
 * Anchored rather than stored as a minute, so a running clock costs nothing per frame beyond the
 * one multiplication, and a change of speed re-anchors at the minute on screen — the sky does not
 * jump when the pace changes.
 */
interface TimeOverride {
  minute: number;
  anchoredAt: number;
  /** Game minutes per real second; 0 holds the clock still. */
  speed: number;
}

export class DebugTimeOverride {
  #override: TimeOverride | undefined;

  get active(): boolean {
    return this.#override !== undefined;
  }

  /** Game minutes per real second of the forced clock, or undefined while the server's runs. */
  get speed(): number | undefined {
    return this.#override?.speed;
  }

  /** The forced minute of day at `now`, or undefined while the server's clock runs. */
  minuteAt(now: number): number | undefined {
    const override = this.#override;
    if (!override) return undefined;
    return wrapMinute(override.minute + override.speed * Math.max(0, now - override.anchoredAt) / 1000);
  }

  /**
   * Puts the clock at `minute`, keeping a running clock running at its pace. A clock that was not
   * forced yet starts held still: the usual reason to set a time is to look at it.
   */
  setMinute(minute: number, now: number): void {
    if (!Number.isFinite(minute)) return;
    this.#override = { minute: wrapMinute(minute), anchoredAt: now, speed: this.#override?.speed ?? 0 };
  }

  /**
   * Runs the forced clock at `speed` game minutes per real second (0 stops it), from the minute
   * that is showing now — the server's minute when nothing was forced yet.
   */
  setSpeed(speed: number, now: number, server: GameTime | undefined): void {
    if (!Number.isFinite(speed) || speed < 0) return;
    const minute = this.minuteAt(now) ?? server?.minuteOfDay ?? 12 * 60;
    this.#override = { minute: wrapMinute(minute), anchoredAt: now, speed };
  }

  /** Back to the realm's clock. */
  clear(): void {
    this.#override = undefined;
  }

  /**
   * The time the frame is drawn at: the server's own object while nothing is forced, otherwise a
   * copy with the forced minute. With no server clock yet (a canned page, the bench) the forced
   * minute still makes a clock, so the light can be looked at before anything has logged in.
   */
  apply(server: GameTime | undefined, now: number): GameTime | undefined {
    const minute = this.minuteAt(now);
    if (minute === undefined) return server;
    if (server) return { ...server, minuteOfDay: minute };
    return { minuteOfDay: minute, minutesPerSecond: SERVER_DEFAULT_SPEED, weekday: 0 };
  }
}

/** The weathers the pane offers, by the state number the server would send for them. */
export const DEBUG_WEATHER_CHOICES: ReadonlyArray<{ state: number; label: string }> = [
  { state: WEATHER_FINE, label: "Ясно" },
  { state: WEATHER_FOG, label: "Туман" },
  { state: WEATHER_DRIZZLE, label: "Морось" },
  { state: WEATHER_LIGHT_RAIN, label: "Дождь слабый" },
  { state: WEATHER_MEDIUM_RAIN, label: "Дождь" },
  { state: WEATHER_HEAVY_RAIN, label: "Ливень" },
  { state: WEATHER_THUNDERS, label: "Гроза" },
  { state: WEATHER_BLACK_RAIN, label: "Чёрный дождь" },
  { state: WEATHER_LIGHT_SNOW, label: "Снег слабый" },
  { state: WEATHER_MEDIUM_SNOW, label: "Снег" },
  { state: WEATHER_HEAVY_SNOW, label: "Метель" },
  { state: WEATHER_BLACK_SNOW, label: "Чёрный снег" },
  { state: WEATHER_LIGHT_SANDSTORM, label: "Песчаная буря слабая" },
  { state: WEATHER_MEDIUM_SANDSTORM, label: "Песчаная буря" },
  { state: WEATHER_HEAVY_SANDSTORM, label: "Песчаная буря сильная" },
];

/**
 * A forced weather, handed to the renderer instead of the server's packet.
 *
 * One object per change: `setWeather` tells a new packet from the same one by identity, so the
 * forced weather is rebuilt only when it changes and then fades in like a real one would.
 */
export class DebugWeatherOverride {
  #weather: Weather | undefined;

  get active(): boolean {
    return this.#weather !== undefined;
  }

  get state(): number | undefined {
    return this.#weather?.state;
  }

  get intensity(): number | undefined {
    return this.#weather?.intensity;
  }

  /** Forces `state` at `intensity` (0..1). Unknown states are accepted: the renderer maps them. */
  set(state: number, intensity: number): void {
    if (!Number.isInteger(state) || state < 0 || !Number.isFinite(intensity)) return;
    const clamped = Math.min(1, Math.max(0, intensity));
    // A clear sky the server would send with no intensity; anything else needs some to be seen.
    const value = state === WEATHER_FINE ? 0 : clamped;
    if (this.#weather && this.#weather.state === state && this.#weather.intensity === value) return;
    this.#weather = { state, intensity: value, abrupt: false };
  }

  clear(): void {
    this.#weather = undefined;
  }

  apply(server: Weather | undefined): Weather | undefined {
    return this.#weather ?? server;
  }
}

/** The one set of overrides a page has, and the last light the loop resolved, for the readout. */
export const debugTime = new DebugTimeOverride();
export const debugWeather = new DebugWeatherOverride();

let lastLight: LightSample | undefined;

/** The loop's light sample this frame — a reference kept, nothing copied. */
export function recordDebugLight(sample: LightSample | undefined): void {
  lastLight = sample;
}

export function lastDebugLight(): LightSample | undefined {
  return lastLight;
}

/** Hours as the pane and the console speak them («13.5» or «13:30») into minutes of day. */
export function parseDebugHour(value: number | string): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? wrapMinute(value * 60) : undefined;
  const text = value.trim();
  const clock = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (clock) {
    const hours = Number(clock[1]);
    const minutes = Number(clock[2]);
    return hours < 24 && minutes < 60 ? hours * 60 + minutes : undefined;
  }
  const hours = Number(text.replace(",", "."));
  return text !== "" && Number.isFinite(hours) ? wrapMinute(hours * 60) : undefined;
}
