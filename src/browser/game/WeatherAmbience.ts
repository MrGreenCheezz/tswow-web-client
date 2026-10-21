import { game } from "./Context.js";
import { WeatherSoundDriver } from "../WeatherSound.js";

/**
 * The weather's own sounds, once a frame beside the zone's (`experimentalWeatherSounds`).
 *
 * The renderer's atmosphere controller already knows everything the ear needs — what is falling
 * and how much, the wind field, whether the camera is under a roof or under water, and every
 * lightning strike with its distance — so this only hands that snapshot to the driver
 * (WeatherSound.ts), which plays the client's own loops and thunder on the ambience channel.
 * With the switch off the snapshot is withheld and the driver fades anything it started.
 */
const driver = new WeatherSoundDriver();

export function updateWeatherSound(now: number): void {
  const sound = game.sound;
  const kits = game.soundKits;
  if (!sound || !kits) return;
  // 22.10 ARC-2 S3a: the profile and a copy of the audio snapshot from the renderer's record (RenderResults.ts).
  const results = game.renderer?.results;
  const enabled = results?.atmosphereProfile.weatherSounds === true;
  driver.update(now, enabled ? results?.atmosphereAudio : undefined, enabled, sound, kits);
}

/** The driver's recent claps (diagnostics). */
export function weatherSoundThunder(): readonly Readonly<{ distance: number; delaySeconds: number; file: string }>[] {
  return driver.thunder;
}
