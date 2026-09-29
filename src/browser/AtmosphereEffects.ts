/**
 * Wind, weather and ambient life: the renderer's single entry point for the "alive world" leaves.
 *
 * Every leaf here is an account setting that the «Улучшенная графика» preset turns on and the
 * comparison profile turns off. With the whole profile OFF (the renderer default and teardown
 * state) nothing is created, nothing is added to a scene, no material is wrapped and the shared
 * uniforms stay at their OFF values — the faithful frame is untouched.
 *
 * - windGusts      — one wind field for trees and grass (WindField.ts / VegetationWind.ts).
 * - rainStreaks    — rain/snow/sand ride that wind: slanted streaks lit by the sky and by a low sun
 *                    behind them, a dense mid layer, distant curtains, and the veil — the zone fog
 *                    pulled in while it rains (`haze`, applied by the renderer through
 *                    `applyPrecipitationHaze`, published as `WET_SURFACE_UNIFORMS.haze`).
 * - rainSplashes   — the client's splash flipbook on the ground, rings on water and puddles.
 * - wetSurfaces    — terrain soaks during rain and dries after (WetSurfaces.ts).
 * - lightning      — flashes and bolts, only for the server's THUNDERS state.
 * - ambientMotes   — pollen in sunlit meadows (occasional, in drifting patches), fireflies at
 *                    night, drifting leaves under trees.
 * - weatherSounds  — nothing is drawn: the controller publishes `audio`, what the weather sounds
 *                    like this frame, and WeatherSound.ts plays the client's own loops and thunder.
 *
 * Hook for a post pass (CinematicPost.ts belongs to another lane and is not edited here): read
 * `WET_SURFACE_UNIFORMS.haze` (0..1 veil) and `WET_SURFACE_UNIFORMS.wetness` (0..1 soaked ground),
 * or `renderer.atmosphere?.haze` / `.wetness` on the CPU. Both stay at exactly 0 while their leaves
 * are OFF.
 */

import * as THREE from "three";
import type { WeatherFade, WeatherEffect } from "./WeatherEffect.js";
import { WindField, weatherWindTarget } from "./WindField.js";
import {
  PrecipitationLayer, RAIN_FAR_LAYER, RAIN_MID_LAYER, SNOW_MID_LAYER, advancePrecipitationOffset,
  advancePrecipitationPhase, createEnhancedWeatherMaterial, createEnhancedWeatherUniforms,
  enhancedWeatherParams, rainBacklight,
  type EnhancedWeatherParams, type EnhancedWeatherUniforms, type PrecipitationOffset,
} from "./WeatherEnhanced.js";
import { RAIN_SPLASH_TEXTURE, RainSplashes } from "./RainSplashes.js";
import { WET_SURFACE_UNIFORMS, advanceWetness } from "./WetSurfaces.js";
import { Lightning } from "./Lightning.js";
import { AmbientMotes, moteDustPatch, type MoteConditions } from "./AmbientMotes.js";
import { visitGeometryBuffers, visitMaterialTextures, type RetainedResourceVisitor } from "./ResourceAccounting.js";
import type { HeightSampler } from "./SimpleScene.js";
import { WEATHER_THUNDERS, type WeatherKind } from "../world/WorldMessageProtocol.js";

/** The one server state that means a thunderstorm (`WEATHER_STATE_THUNDERS` in Weather.h). */
export function isThunderState(state: number | undefined): boolean {
  return state === WEATHER_THUNDERS;
}

export interface AtmosphereProfile {
  readonly windGusts: boolean;
  readonly rainStreaks: boolean;
  readonly rainSplashes: boolean;
  readonly wetSurfaces: boolean;
  readonly lightning: boolean;
  readonly ambientMotes: boolean;
  readonly weatherSounds: boolean;
}

export const DEFAULT_ATMOSPHERE_PROFILE: Readonly<AtmosphereProfile> = Object.freeze({
  windGusts: false,
  rainStreaks: false,
  rainSplashes: false,
  wetSurfaces: false,
  lightning: false,
  ambientMotes: false,
  weatherSounds: false,
});

export function normaliseAtmosphereProfile(
  profile: Readonly<Partial<AtmosphereProfile>> | undefined,
): Readonly<AtmosphereProfile> {
  return Object.freeze({
    windGusts: profile?.windGusts === true,
    rainStreaks: profile?.rainStreaks === true,
    rainSplashes: profile?.rainSplashes === true,
    wetSurfaces: profile?.wetSurfaces === true,
    lightning: profile?.lightning === true,
    ambientMotes: profile?.ambientMotes === true,
    weatherSounds: profile?.weatherSounds === true,
  });
}

export function sameAtmosphereProfile(a: Readonly<AtmosphereProfile>, b: Readonly<AtmosphereProfile>): boolean {
  return a.windGusts === b.windGusts && a.rainStreaks === b.rainStreaks && a.rainSplashes === b.rainSplashes
    && a.wetSurfaces === b.wetSurfaces && a.lightning === b.lightning && a.ambientMotes === b.ambientMotes
    && a.weatherSounds === b.weatherSounds;
}

export function atmosphereProfileActive(profile: Readonly<AtmosphereProfile>): boolean {
  return profile.windGusts || profile.rainStreaks || profile.rainSplashes || profile.wetSurfaces
    || profile.lightning || profile.ambientMotes || profile.weatherSounds;
}

/** A render-scale-derived tier: full counts at ≥85%, fewer as AutoQuality lowers resolution. */
export function atmosphereQuality(renderScale: number): number {
  if (!Number.isFinite(renderScale)) return 1;
  return renderScale >= 0.85 ? 1 : renderScale >= 0.65 ? 0.7 : 0.45;
}

/** Seconds for the rain veil to cover ~63% of a change (the weather itself fades in over 5 s). */
export const PRECIPITATION_HAZE_TIME_CONSTANT = 3;

/** How thick a veil each kind of weather draws at full density, 0..1. Pure; tested. */
export function precipitationHazeTarget(kind: WeatherKind, density: number): number {
  const d = Math.max(0, Math.min(1, Number.isFinite(density) ? density : 0));
  // Rain is the reference; a snowfall mutes the distance a little less; sand and fog carry their
  // own look in the weather cloud and are left alone.
  return kind === "rain" ? d : kind === "snow" ? 0.75 * d : 0;
}

/**
 * Pulls the zone fog in for a veil of `haze` 0..1: at the heaviest rain the fog starts at 38% of
 * its authored distance and closes at 55%, which is what turns a far hillside into a grey shape and
 * then into nothing. The renderer restores the zone fog from Light.dbc at the start of every
 * submission, so this is applied to a fresh copy once per frame and never accumulates.
 */
export function applyPrecipitationHaze(fog: THREE.Fog, haze: number): void {
  const h = Math.max(0, Math.min(1, Number.isFinite(haze) ? haze : 0));
  if (h <= 0) return;
  const near = fog.near * (1 - 0.62 * h);
  const far = Math.max(near + 1, fog.far * (1 - 0.45 * h));
  fog.near = near;
  fog.far = far;
}

/** What the weather sounds like this frame (WeatherSound.ts). Reused; never allocated per frame. */
export interface AtmosphereAudioState {
  /** Falling weather on screen and how much of it (the renderer's own fade, 0..1). */
  kind: WeatherKind;
  density: number;
  /** The server's THUNDERS state. */
  thunder: boolean;
  indoors: boolean;
  underwater: boolean;
  /** The wind field, 0..1 each. */
  wind: number;
  gust: number;
  /** Lightning strikes so far (a counter) and the last one's distance (yd), pan (-1..1), strength. */
  strikes: number;
  strikeDistance: number;
  strikePan: number;
  strikeStrength: number;
}

/** Everything one frame hands over. Reused by the renderer; never allocated per frame. */
export interface AtmosphereFrame {
  camera: THREE.PerspectiveCamera;
  /** The character's feet, scene space. */
  feet: THREE.Vector3;
  heightAt: HeightSampler | undefined;
  /** Frame clock in seconds (deterministic under the bench) and the step. */
  seconds: number;
  elapsed: number;
  map: number | undefined;
  weather: WeatherEffect | undefined;
  fade: WeatherFade;
  thunder: boolean;
  indoors: boolean;
  underwater: boolean;
  /** Scene-space unit vector towards the sun, and the light colours (linear). */
  sunDirection: THREE.Vector3;
  sunColour: THREE.Color;
  ambient: THREE.Color;
  daylight: number;
  skyColour: THREE.Color;
  /** projection[1][1] × half the drawing-buffer height. */
  pixelScale: number;
  quality: number;
  /** 0..1 vegetation around the character, sampled by the renderer about once a second. */
  meadow: number;
  forest: number;
}

export class AtmosphereEffects {
  readonly wind = new WindField();
  readonly #scene: THREE.Scene;
  readonly #load: (path: string) => THREE.Texture | undefined;
  #profile: Readonly<AtmosphereProfile> = DEFAULT_ATMOSPHERE_PROFILE;
  #enhancedFor: WeatherEffect | undefined;
  #enhancedMaterial: THREE.ShaderMaterial | undefined;
  #enhancedUniforms: EnhancedWeatherUniforms | undefined;
  #midLayer: PrecipitationLayer | undefined;
  #farLayer: PrecipitationLayer | undefined;
  #splashes: RainSplashes | undefined;
  #splashTexture: THREE.Texture | undefined;
  #lightning: Lightning | undefined;
  #motes: AmbientMotes | undefined;
  #wetness = 0;
  #haze = 0;
  #backlight = 0;
  /** The faithful cloud's travel under the enhanced material: integrated wind and fall, wrapped. */
  readonly #enhancedOffset: PrecipitationOffset = { x: 0, y: 0, z: 0 };
  #enhancedPhase = 0;
  readonly #params: EnhancedWeatherParams = {
    windX: 0, windZ: 0, nearStart: 0, nearEnd: 0, streak: 1, width: 1, alphaScale: 1, gain: 1,
  };
  readonly #light = new THREE.Color();
  readonly #rainLight = new THREE.Color();
  readonly #conditions: MoteConditions = {
    daylight: 1, meadow: 0, forest: 0, precipitation: 0, snowing: false, wind: 0, outdoors: true,
    sunHeight: 1, patch: 0,
  };
  readonly audio: AtmosphereAudioState = {
    kind: "fine", density: 0, thunder: false, indoors: false, underwater: false, wind: 0, gust: 0,
    strikes: 0, strikeDistance: 0, strikePan: 0, strikeStrength: 0,
  };

  constructor(scene: THREE.Scene, load: (path: string) => THREE.Texture | undefined) {
    this.#scene = scene;
    this.#load = load;
  }

  get profile(): Readonly<AtmosphereProfile> { return this.#profile; }
  get wetness(): number { return this.#wetness; }
  /** 0..1 rain/snow veil the renderer pulls the zone fog in by (0 while rainStreaks is OFF). */
  get haze(): number { return this.#haze; }
  get lightningFlash(): number { return this.#lightning?.flash ?? 0; }
  get lightning(): Lightning | undefined { return this.#lightning; }
  /** Procedural rain/snow quads drawn this frame beyond the faithful cloud (diagnostics). */
  get layerQuads(): number { return (this.#midLayer?.drawn ?? 0) + (this.#farLayer?.drawn ?? 0); }

  /** Returns whether anything changed. Objects for leaves turned off are released at once. */
  setProfile(profile: Readonly<Partial<AtmosphereProfile>> | undefined): boolean {
    const next = normaliseAtmosphereProfile(profile);
    if (sameAtmosphereProfile(next, this.#profile)) return false;
    this.#profile = next;
    this.wind.setEnabled(next.windGusts);
    if (!next.rainStreaks) {
      this.#releaseEnhanced();
      this.#haze = 0;
      WET_SURFACE_UNIFORMS.haze.value = 0;
    }
    if (!next.rainSplashes) this.#releaseSplashes();
    if (!next.lightning) this.#releaseLightning();
    if (!next.ambientMotes) this.#releaseMotes();
    if (!next.wetSurfaces) {
      this.#wetness = 0;
      WET_SURFACE_UNIFORMS.wetness.value = 0;
    }
    if (!next.rainSplashes) WET_SURFACE_UNIFORMS.rain.value = 0;
    if (!atmosphereProfileActive(next)) this.wind.reset();
    return true;
  }

  update(frame: AtmosphereFrame): void {
    const profile = this.#profile;
    if (!atmosphereProfileActive(profile)) return;
    const fade = frame.fade;
    const raining = fade.kind === "rain" ? Math.max(0, fade.density) : 0;
    this.wind.update(frame.seconds, frame.elapsed, frame.map,
      weatherWindTarget(fade.kind, fade.density, frame.thunder));
    // Scene light for particles: ambient plus a share of the sun, clamped so night rain is dim but
    // never invisible and a noon sun does not make it glow.
    const ambient = frame.ambient;
    const sun = frame.sunColour;
    this.#light.setRGB(
      Math.max(0.2, Math.min(1.25, ambient.r + sun.r * 0.6)),
      Math.max(0.2, Math.min(1.25, ambient.g + sun.g * 0.6)),
      Math.max(0.22, Math.min(1.3, ambient.b + sun.b * 0.6)),
    );
    // Rain is water: it shows the sky it falls through. Mostly the scene light, pulled towards the
    // zone's fog colour so a grey storm gives grey-white streaks and a sunset gives warm ones.
    const sky = frame.skyColour;
    this.#rainLight.setRGB(
      Math.min(1.35, this.#light.r * 0.8 + sky.r * 0.9),
      Math.min(1.35, this.#light.g * 0.8 + sky.g * 0.9),
      Math.min(1.4, this.#light.b * 0.8 + sky.b * 0.9),
    );
    const sunLuminance = 0.2126 * sun.r + 0.7152 * sun.g + 0.0722 * sun.b;
    this.#backlight = frame.indoors || frame.underwater ? 0 : rainBacklight(frame.sunDirection.y, sunLuminance);

    this.#updateEnhancedWeather(frame);
    const outdoors = !frame.indoors && !frame.underwater;
    const outdoorsRain = outdoors ? raining : 0;
    if (profile.rainStreaks) {
      this.#updateLayers(frame, outdoors);
      const target = frame.underwater ? 0 : precipitationHazeTarget(fade.kind, fade.density);
      const step = Number.isFinite(frame.elapsed) ? Math.max(0, Math.min(0.25, frame.elapsed)) : 0;
      this.#haze += (target - this.#haze) * (1 - Math.exp(-step / PRECIPITATION_HAZE_TIME_CONSTANT));
      if (this.#haze < 1e-3 && target <= 0) this.#haze = 0;
      WET_SURFACE_UNIFORMS.haze.value = this.#haze;
    }
    if (profile.rainSplashes) {
      this.#splashes ??= this.#adopt(new RainSplashes());
      if (outdoorsRain > 0 && !this.#splashTexture) this.#splashTexture = this.#load(RAIN_SPLASH_TEXTURE);
      this.#splashes.update(frame.feet, frame.heightAt, frame.elapsed, outdoorsRain,
        this.#splashTexture ?? null, this.#rainLight, frame.quality);
      WET_SURFACE_UNIFORMS.rain.value = raining;
    }
    WET_SURFACE_UNIFORMS.time.value = frame.seconds;
    WET_SURFACE_UNIFORMS.sky.value.copy(frame.skyColour);
    if (profile.wetSurfaces) {
      this.#wetness = advanceWetness(this.#wetness, raining, frame.elapsed);
      WET_SURFACE_UNIFORMS.wetness.value = this.#wetness;
    }
    if (profile.lightning) {
      this.#lightning ??= this.#adopt(new Lightning(), (l) => l.group);
      this.#lightning.update(frame.camera, frame.elapsed, frame.thunder ? raining : 0, frame.indoors);
    }
    if (profile.ambientMotes) {
      this.#motes ??= this.#adopt(new AmbientMotes(), (m) => m.group);
      const c = this.#conditions;
      c.daylight = frame.daylight;
      c.meadow = frame.meadow;
      c.forest = frame.forest;
      c.precipitation = fade.kind === "fine" ? 0 : Math.max(0, fade.density);
      c.snowing = fade.kind === "snow" && fade.density > 0.05;
      c.wind = this.wind.strength;
      c.outdoors = outdoors;
      c.sunHeight = frame.sunDirection.y;
      c.patch = moteDustPatch(frame.seconds, frame.feet.x, frame.feet.z);
      const drift = 0.6 + 2.2 * this.wind.strength;
      this.#motes.update(frame.camera.position, frame.feet.y, frame.elapsed, c,
        this.wind.direction.x * drift, this.wind.direction.y * drift,
        frame.sunDirection, frame.sunColour, this.#light, frame.pixelScale, frame.quality);
    }
    const audio = this.audio;
    audio.kind = fade.kind;
    audio.density = Math.max(0, fade.density);
    audio.thunder = frame.thunder;
    audio.indoors = frame.indoors;
    audio.underwater = frame.underwater;
    audio.wind = this.wind.strength;
    audio.gust = this.wind.gust;
    const lightning = this.#lightning;
    audio.strikes = lightning?.strikes ?? 0;
    audio.strikeDistance = lightning?.strikeDistance ?? 0;
    audio.strikePan = lightning?.strikePan ?? 0;
    audio.strikeStrength = lightning?.strikeStrength ?? 0;
  }

  /** The mid layer (rain or snow) and the distant rain curtain, only while it falls outdoors. */
  #updateLayers(frame: AtmosphereFrame, outdoors: boolean): void {
    const fade = frame.fade;
    const drawn = frame.weather?.drawnKind;
    const density = outdoors && (drawn === "rain" || drawn === "snow") && fade.kind === drawn
      ? Math.max(0, fade.density) : 0;
    const mid = drawn === "rain" ? RAIN_MID_LAYER : drawn === "snow" ? SNOW_MID_LAYER : undefined;
    const far = drawn === "rain" ? RAIN_FAR_LAYER : undefined;
    if (density > 0) {
      this.#midLayer ??= this.#adopt(new PrecipitationLayer());
      if (far) this.#farLayer ??= this.#adopt(new PrecipitationLayer());
    }
    const kind: WeatherKind = drawn === "snow" ? "snow" : "rain";
    enhancedWeatherParams(kind, this.wind.direction.x, this.wind.direction.y, this.wind.strength,
      this.wind.gust, this.#params);
    const light = kind === "rain" ? this.#rainLight : this.#light;
    this.#midLayer?.update(frame.camera.position, frame.elapsed, mid, density,
      this.#params.windX, this.#params.windZ, light, frame.sunDirection, this.#backlight, frame.quality);
    this.#farLayer?.update(frame.camera.position, frame.elapsed, far, density,
      this.#params.windX, this.#params.windZ, light, frame.sunDirection, this.#backlight, frame.quality);
  }

  #updateEnhancedWeather(frame: AtmosphereFrame): void {
    const weather = frame.weather;
    if (!this.#profile.rainStreaks || !weather) {
      if (this.#enhancedFor && this.#enhancedFor !== weather) this.#releaseEnhanced();
      return;
    }
    if (this.#enhancedFor !== weather) {
      this.#releaseEnhanced();
      this.#enhancedUniforms = createEnhancedWeatherUniforms();
      this.#enhancedMaterial = createEnhancedWeatherMaterial(weather.uniforms, this.#enhancedUniforms);
      this.#enhancedFor = weather;
      weather.setMaterialOverride(this.#enhancedMaterial);
    }
    const kind = weather.drawnKind;
    enhancedWeatherParams(kind, this.wind.direction.x, this.wind.direction.y, this.wind.strength,
      this.wind.gust, this.#params);
    const u = this.#enhancedUniforms!;
    u.uWind.value.set(this.#params.windX, this.#params.windZ);
    // The cloud's travel is integrated here, frame by frame, from the wind the quads are aligned
    // to; the shader never multiplies a velocity by the clock (see `uOffset`).
    const box = weather.uniforms["uBox"]!.value as THREE.Vector3;
    const fall = weather.uniforms["uFall"]!.value as number;
    advancePrecipitationOffset(this.#enhancedOffset, this.#params.windX, this.#params.windZ, fall,
      frame.elapsed, box);
    this.#enhancedPhase = advancePrecipitationPhase(this.#enhancedPhase, frame.elapsed);
    u.uOffset.value.set(this.#enhancedOffset.x, this.#enhancedOffset.y, this.#enhancedOffset.z);
    u.uPhase.value = this.#enhancedPhase;
    u.uNear.value.set(this.#params.nearStart, this.#params.nearEnd);
    u.uStreak.value = this.#params.streak;
    u.uWidth.value = this.#params.width;
    u.uAlphaScale.value = this.#params.alphaScale;
    u.uGain.value = this.#params.gain;
    u.uSun.value.copy(frame.sunDirection);
    // Sand and fog are lit volumes already tinted by their preset; only rain and snow take the
    // scene light, which is what dims them at night. Rain takes the sky-lit colour and the low sun
    // behind it; snow the plain scene light, a little brighter than the surfaces around it.
    if (kind === "rain") {
      u.uLight.value.copy(this.#rainLight);
      u.uBacklight.value = this.#backlight;
    } else if (kind === "snow") {
      u.uLight.value.setRGB(Math.min(1.35, this.#light.r * 1.25), Math.min(1.35, this.#light.g * 1.25),
        Math.min(1.4, this.#light.b * 1.3));
      u.uBacklight.value = 0.35 * this.#backlight;
    } else {
      u.uLight.value.setRGB(1, 1, 1);
      u.uBacklight.value = 0;
    }
  }

  #adopt<T>(owner: T, object: (owner: T) => THREE.Object3D = (o) => (o as { object: THREE.Object3D }).object): T {
    this.#scene.add(object(owner));
    return owner;
  }

  #releaseEnhanced(): void {
    if (this.#enhancedFor) this.#enhancedFor.setMaterialOverride(undefined);
    this.#enhancedMaterial?.dispose();
    this.#enhancedMaterial = undefined;
    this.#enhancedUniforms = undefined;
    this.#enhancedFor = undefined;
    this.#enhancedOffset.x = 0;
    this.#enhancedOffset.y = 0;
    this.#enhancedOffset.z = 0;
    this.#enhancedPhase = 0;
    for (const layer of [this.#midLayer, this.#farLayer]) {
      if (!layer) continue;
      this.#scene.remove(layer.object);
      layer.dispose();
    }
    this.#midLayer = undefined;
    this.#farLayer = undefined;
  }

  #releaseSplashes(): void {
    if (this.#splashes) {
      this.#scene.remove(this.#splashes.object);
      this.#splashes.dispose();
      this.#splashes = undefined;
    }
    this.#splashTexture?.dispose();
    this.#splashTexture = undefined;
  }

  #releaseLightning(): void {
    if (!this.#lightning) return;
    this.#scene.remove(this.#lightning.group);
    this.#lightning.dispose();
    this.#lightning = undefined;
  }

  #releaseMotes(): void {
    if (!this.#motes) return;
    this.#scene.remove(this.#motes.group);
    this.#motes.dispose();
    this.#motes = undefined;
  }

  /** Objects currently owned, for warmup registration and diagnostics. */
  get objects(): THREE.Object3D[] {
    const objects: THREE.Object3D[] = [];
    if (this.#midLayer) objects.push(this.#midLayer.object);
    if (this.#farLayer) objects.push(this.#farLayer.object);
    if (this.#splashes) objects.push(this.#splashes.object);
    if (this.#lightning) objects.push(this.#lightning.group);
    if (this.#motes) objects.push(this.#motes.group);
    return objects;
  }

  visitRetainedResources(visitor: RetainedResourceVisitor): void {
    if (this.#enhancedMaterial) visitMaterialTextures(visitor, this.#enhancedMaterial);
    if (this.#splashTexture) visitor.referenceGpuTexture(this, this.#splashTexture);
    if (this.#splashes) {
      visitGeometryBuffers(visitor, this.#splashes, this.#splashes.geometry);
      visitor.referenceGpuTexture(this.#splashes, this.#splashes.heightTexture);
    }
    if (this.#midLayer) visitGeometryBuffers(visitor, this.#midLayer, this.#midLayer.geometry);
    if (this.#farLayer) visitGeometryBuffers(visitor, this.#farLayer, this.#farLayer.geometry);
  }

  /** Deterministic replay restart: clocks and fades back to zero, objects kept. */
  reset(): void {
    this.wind.reset();
    this.#wetness = 0;
    this.#haze = 0;
    this.#enhancedOffset.x = 0;
    this.#enhancedOffset.y = 0;
    this.#enhancedOffset.z = 0;
    this.#enhancedPhase = 0;
    if (this.#enhancedUniforms) {
      this.#enhancedUniforms.uOffset.value.set(0, 0, 0);
      this.#enhancedUniforms.uPhase.value = 0;
    }
    WET_SURFACE_UNIFORMS.wetness.value = 0;
    WET_SURFACE_UNIFORMS.rain.value = 0;
    WET_SURFACE_UNIFORMS.time.value = 0;
    WET_SURFACE_UNIFORMS.haze.value = 0;
    this.#midLayer?.reset();
    this.#farLayer?.reset();
    this.#splashes?.reset();
    this.#lightning?.reset();
    this.#motes?.reset();
  }

  /** Releases everything and returns to the exact OFF state. */
  dispose(): void {
    this.#releaseEnhanced();
    this.#releaseSplashes();
    this.#releaseLightning();
    this.#releaseMotes();
    this.#profile = DEFAULT_ATMOSPHERE_PROFILE;
    this.wind.setEnabled(false);
    this.reset();
  }
}
