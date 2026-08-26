// What the world says to everyone standing in it: weather, banners, cinematics, phasing.
//
// These are the packets that make a zone feel like a place rather than a set of coordinates, and
// every one of them was being dropped. Three of the ten expect the client to answer, and the
// answer is not decoration: until `CMSG_COMPLETE_CINEMATIC` arrives the player's view stays bound
// to the server's camera creature (`MiscHandler.cpp:996`), and until `CMSG_COMPLETE_MOVIE` does,
// any script waiting on the movie stalls (`MiscHandler.cpp:1008`).

import { PacketReader } from "../protocol/PacketReader.js";
import { PacketWriter } from "../protocol/PacketWriter.js";

export interface Weather {
  /** `WeatherState`: fine, rain, snow, sandstorm and their intensities. */
  state: number;
  /** 0 to 1. Zero with a state of fine is how the server says "it stopped". */
  intensity: number;
  /** Whether it changes at once rather than fading in — set when the player has just zoned in. */
  abrupt: boolean;
}

/**
 * `WeatherState` in `Weather.h`. The value is not a scale: light and heavy rain are separate
 * states, and the intensity float modulates within one.
 *
 * Three of these the weather system itself can never produce. `Weather::GetWeatherState` returns
 * `FINE` below an intensity of 0.27 and otherwise one of the three rains, the three snows, the
 * three sandstorms, `BLACKRAIN` or `THUNDERS` — fog, drizzle and black snow are not in that
 * switch at all. They arrive from scripts, through `Map::SetZoneWeather`, and two of them are in
 * places a player goes: the Trial of the Crusader and Icecrown Citadel both call for fog, and the
 * Lich King's own encounter calls for black snow. A client that only handled what the weather
 * timer can send would go clear in the middle of both.
 */
export const WEATHER_FINE = 0;
export const WEATHER_FOG = 1;
export const WEATHER_DRIZZLE = 2;
export const WEATHER_LIGHT_RAIN = 3;
export const WEATHER_MEDIUM_RAIN = 4;
export const WEATHER_HEAVY_RAIN = 5;
export const WEATHER_LIGHT_SNOW = 6;
export const WEATHER_MEDIUM_SNOW = 7;
export const WEATHER_HEAVY_SNOW = 8;
export const WEATHER_LIGHT_SANDSTORM = 22;
export const WEATHER_MEDIUM_SANDSTORM = 41;
export const WEATHER_HEAVY_SANDSTORM = 42;
export const WEATHER_THUNDERS = 86;
export const WEATHER_BLACK_RAIN = 90;
export const WEATHER_BLACK_SNOW = 106;

/** What is actually falling out of the sky, which is all a renderer needs out of the state. */
export type WeatherKind = "fine" | "rain" | "snow" | "sand" | "fog";

/**
 * The state's number turned into the thing to draw.
 *
 * `Thunders` is rain with a soundtrack — the server has no separate visual for it, and the client
 * has no lightning — and `black rain` and `black snow` are the ordinary two, tinted. Drizzle is
 * the lightest rain there is.
 */
export function weatherKind(state: number): WeatherKind {
  if (state === WEATHER_FINE) return "fine";
  if (state === WEATHER_FOG) return "fog";
  if (state === WEATHER_LIGHT_SNOW || state === WEATHER_MEDIUM_SNOW || state === WEATHER_HEAVY_SNOW
    || state === WEATHER_BLACK_SNOW) return "snow";
  if (state === WEATHER_LIGHT_SANDSTORM || state === WEATHER_MEDIUM_SANDSTORM
    || state === WEATHER_HEAVY_SANDSTORM) return "sand";
  return "rain";
}

/** Whether the state tints what falls, which only the two black weathers do. */
export function weatherIsBlack(state: number): boolean {
  return state === WEATHER_BLACK_RAIN || state === WEATHER_BLACK_SNOW;
}

/**
 * Which of the eight `LightParams` slots on a `Light.dbc` row a weather reads.
 *
 * There is one storm slot and not one per precipitation type. This used to be a function that said
 * otherwise — snow read slot 2, sandstorm slot 3 and everything else slot 1, which would have
 * drawn rain under the *underwater* sky — and it is two constants now because nothing chooses:
 * both sets are sent and crossfaded, so the state decides the weight and never the slot.
 *
 * Measured over all 715 rows this client resolves: slot 0 and slot 2 hold the same parameter set
 * on 47.1% of rows and slot 1 and slot 3 on 57.2%, while every cross pairing is under 1.5% — so
 * the slots pair up as two states of the same place. Which pair is underwater is settled by the
 * fog: at noon, averaged over every row whose profile has a fog band at all, slot 0 closes at
 * 501.9 yards and slot 2 at 468.2 over all 715, while slot 1 closes at 184.1 over 695 and slot 3
 * at 215.6 over 715 — and slots 1 and 3 are the ones that go teal. (The 20 rows missing from slot
 * 1's average name a profile whose `LightFloatBand` row carries a key count of zero; the client's
 * own answer for those is `sampleSet`'s 500-yard default.) Slot 4 is the death light — six
 * distinct sets across all 715 rows — slot 5 is filled on 18 rows, slot 6 on none and slot 7 on
 * one.
 *
 * So: 0 is clear above water, 2 is stormy above water, and 1 and 3 are their underwater
 * counterparts. All four are published: 709 of the 715 rows name a different set in slot 1 than in
 * slot 0, so without them a swimming player keeps the sky of the shore they left, in every zone
 * without exception.
 */
export const LIGHT_SLOT_CLEAR = 0;
export const LIGHT_SLOT_UNDERWATER = 1;
export const LIGHT_SLOT_STORM = 2;
export const LIGHT_SLOT_UNDERWATER_STORM = 3;

/** `SMSG_WEATHER`: `u32 state, f32 intensity, u8 abrupt` — `MiscPackets.cpp:105-109`. */
export function parseWeather(payload: Uint8Array): Weather {
  const reader = new PacketReader(payload);
  const state = reader.u32();
  const intensity = reader.f32();
  return {
    state,
    intensity: Number.isFinite(intensity) ? Math.min(1, Math.max(0, intensity)) : 0,
    abrupt: reader.u8() !== 0,
  };
}

/** `SMSG_OVERRIDE_LIGHT`: `i32 area, i32 override, i32 milliseconds`. A zone lit by a script. */
export function parseOverrideLight(payload: Uint8Array): { areaLightId: number; overrideLightId: number; milliseconds: number } {
  const reader = new PacketReader(payload);
  const areaLightId = reader.i32();
  const overrideLightId = reader.i32();
  return { areaLightId, overrideLightId, milliseconds: reader.i32() };
}

/**
 * `SMSG_AREA_TRIGGER_MESSAGE`: `u32 length, cstring text`.
 *
 * The length counts the string's own bytes including its terminator, so it is not a count to
 * read past — the string reads itself. It is the big yellow banner across the middle of the
 * screen: "You have discovered Goldshire", and the warnings a zone gives before it kills you.
 */
export function parseAreaTriggerMessage(payload: Uint8Array): string {
  const reader = new PacketReader(payload);
  reader.u32();
  return reader.cString();
}

/** `SMSG_DEFENSE_MESSAGE`: `u32 zone, u32 length, cstring text`. */
export function parseDefenseMessage(payload: Uint8Array): { zoneId: number; text: string } {
  const reader = new PacketReader(payload);
  const zoneId = reader.u32();
  reader.u32();
  return { zoneId, text: reader.cString() };
}

/** `SMSG_ZONE_UNDER_ATTACK`: the area id, which the client turns into a name itself. */
export function parseZoneUnderAttack(payload: Uint8Array): number {
  return new PacketReader(payload).u32();
}

/** `SMSG_TRIGGER_CINEMATIC` and `SMSG_TRIGGER_MOVIE`: one id, from two different tables. */
export function parseCinematicId(payload: Uint8Array): number {
  return new PacketReader(payload).u32();
}

/** `SMSG_SET_PHASE_SHIFT`: a bitmask of the phases the player can see. */
export function parsePhaseShift(payload: Uint8Array): number {
  return new PacketReader(payload).u32();
}

export interface BuildingDamage {
  /** The destructible building itself. */
  target: bigint;
  attacker: bigint;
  /** Whoever owns the attacker — the vehicle's driver, usually. */
  controller: bigint;
  damage: number;
  spellId: number;
}

/**
 * `SMSG_DESTRUCTIBLE_BUILDING_DAMAGE`: three **packed** guids, then the damage and the spell.
 *
 * Three in a row is what makes this one worth its own parser: each is one to nine bytes, so
 * nothing after them sits at a fixed offset.
 */
export function parseBuildingDamage(payload: Uint8Array): BuildingDamage {
  const reader = new PacketReader(payload);
  const target = reader.packedGuid();
  const attacker = reader.packedGuid();
  const controller = reader.packedGuid();
  const damage = reader.u32();
  return { target, attacker, controller, damage, spellId: reader.u32() };
}

export interface SummonRequest {
  /** Who is summoning; a **full** guid here, unlike the building damage above. */
  summoner: bigint;
  zoneId: number;
  /** How long the player has to answer before the offer lapses. */
  timeoutMilliseconds: number;
}

/** `SMSG_SUMMON_REQUEST`: `u64 summoner, u32 zone, u32 timeout`. */
export function parseSummonRequest(payload: Uint8Array): SummonRequest {
  const reader = new PacketReader(payload);
  const summoner = reader.u64();
  const zoneId = reader.u32();
  return { summoner, zoneId, timeoutMilliseconds: reader.u32() };
}

/** `CMSG_SUMMON_RESPONSE`: `u64 summoner, u8 accept` — the guid has to come back byte for byte. */
export function buildSummonResponse(summoner: bigint, accept: boolean): Uint8Array {
  return new PacketWriter().u64(summoner).u8(accept ? 1 : 0).toUint8Array();
}

/**
 * `CMSG_NEXT_CINEMATIC_CAMERA` and `CMSG_COMPLETE_CINEMATIC`, both empty.
 *
 * The first says the cinematic has begun and starts the server's camera walk; the second says it
 * is over and unbinds the player's sight. This client skips cinematics — that is the plan's
 * decision, not an oversight — so it sends both at once and gets its own eyes back immediately.
 */
export function buildCinematicAck(): Uint8Array {
  return new Uint8Array(0);
}
