// 05.10-A7a-E (6.13): what a SpellVisualKit carries beyond its models — camera shakes and chain beams.
//
// Tables (all in the dataset; none in tools/dbd, none loaded by TrinityCore, so each header is checked here):
//
// - SpellEffectCameraShakes.dbc, 4 fields: ID, CameraShake[3] (30 rows). `SpellVisualKit.ShakeID` names a row
//   (336 kits, 28 distinct ids).
// - CameraShakes.dbc, 8 fields: ID, ShakeType, Direction, Amplitude, Frequency, Duration, Phase, Coefficient
//   (78 rows). Wow.exe 3.3.5a 12340 reads them in this order (0x00606410 → 0x00606330 stores them;
//   0x00606970 runs them; 0x005fe6c0 applies one — browser/CameraShake.ts has the arithmetic).
// - SpellChainEffects.dbc, 935 records of 177 bytes (the header says 48 fields): dwords 0–38 (ID, AvgSegLen,
//   Width, NoiseScale, TexCoordScale, SegDuration, SegDelay, Texture, Flags, JointCount, … PulseFadeLength),
//   bytes 156–159 four colour channels, byte 160 BlendMode, then unaligned dwords at 161 Combo (string),
//   165 RenderLayer, 169 TextureLength, 173 WavePhase. Layout confirmed by ranges over all 935 rows
//   (docs/implementation/probes/A7a/probe-chain-layout.mjs); `tools/dbc.mjs` cannot describe it, so it is
//   read raw here.
//
// A kit's four "procedures" (`CharProc[4]`, parameters `CharParamZero..Three[4]`): `CharProc` 0 and 12 name a
// SpellChainEffects row in `CharParamZero[slot]` (the beams of Drain Life 11762 → 719, Mind Flay 11744 → 750,
// Drain Mana 430 → 744, Drain Soul 950 → 723, Chain Lightning's cast kit 321 → 743; probe-charproc-beam.mjs).
// `CharProc` 0 is also the value of an unused slot, so a slot is a beam only when its parameter names a row.
// The other procedures (1, 8, 11, 13, 14, …) are not read.

import { DbcError } from "./Dbc.js";
import { parseFixed, type FixedLayout } from "./DbcFixed.js";

export const SPELL_EFFECT_CAMERA_SHAKES_LAYOUT: FixedLayout = Object.freeze({ fieldCount: 4, recordSize: 16 });
export const CAMERA_SHAKES_LAYOUT: FixedLayout = Object.freeze({ fieldCount: 8, recordSize: 32 });
/** SpellChainEffects: the header's field count and the record size actually used. */
export const SPELL_CHAIN_EFFECTS_FIELDS = 48;
export const SPELL_CHAIN_EFFECTS_RECORD = 177;

/** One CameraShakes row, raw (CameraShake.ts scales the amplitude as Wow.exe does). */
export interface SpellVisualShake {
  /** 0 sine; 1 sine damped by exp(−t · coefficient) (0x005fe6c0). */
  type: number;
  /** 0 along the facing, 1 across it, 2 vertical (0x005fe6c0). */
  direction: number;
  amplitude: number;
  /** Cycles a second. */
  frequency: number;
  /** Seconds. */
  duration: number;
  /** Seconds added to the shake's clock. */
  phase: number;
  coefficient: number;
}

/** What a straight beam needs of one SpellChainEffects row (joints, waves and pulses are not drawn yet). */
export interface SpellChainEffect {
  id: number;
  /** MPQ path, e.g. `Textures\SpellChainEffects\Lightning.blp`. */
  texture: string;
  width: number;
  avgSegLen: number;
  noiseScale: number;
  texCoordScale: number;
  textureLength: number;
  segDuration: number;
  segDelay: number;
  flags: number;
  jointCount: number;
  /** Bytes 156–159 in file order; the first is never 0 and 255 on 761 rows (alpha, by hypothesis). */
  color: [number, number, number, number];
  blendMode: number;
  renderLayer: number;
}

/** One beam slot of a kit. */
export interface SpellVisualChain {
  /** The kit's procedure slot, 0…3. */
  slot: number;
  /** CharProc: 0 or 12. */
  proc: number;
  /** CharParamOne[slot] (0 or 1 on most rows; meaning not settled). */
  param1: number;
  effect: SpellChainEffect;
}

/** ShakeID → its (up to three) CameraShakes rows. */
export function parseCameraShakes(spellShakes: Uint8Array, shakes: Uint8Array): Map<number, SpellVisualShake[]> {
  const sets = parseFixed("SpellEffectCameraShakes", toBuffer(spellShakes), SPELL_EFFECT_CAMERA_SHAKES_LAYOUT);
  const rows = parseFixed("CameraShakes", toBuffer(shakes), CAMERA_SHAKES_LAYOUT);
  const byId = new Map<number, SpellVisualShake>();
  for (let row = 0; row < rows.records; row++) {
    const shake: SpellVisualShake = {
      type: rows.int(row, 1),
      direction: rows.int(row, 2),
      amplitude: rows.float(row, 3),
      frequency: rows.float(row, 4),
      duration: rows.float(row, 5),
      phase: rows.float(row, 6),
      coefficient: rows.float(row, 7),
    };
    if ([shake.amplitude, shake.frequency, shake.duration, shake.phase, shake.coefficient].every(Number.isFinite)) {
      byId.set(rows.int(row, 0), shake);
    }
  }
  const result = new Map<number, SpellVisualShake[]>();
  for (let row = 0; row < sets.records; row++) {
    const list: SpellVisualShake[] = [];
    for (let column = 1; column <= 3; column++) {
      const shake = byId.get(sets.int(row, column));
      if (shake) list.push(shake);
    }
    if (list.length > 0) result.set(sets.int(row, 0), list);
  }
  return result;
}

/** Every SpellChainEffects row, by id. Throws `DbcError` when the file is not the 177-byte layout. */
export function parseSpellChainEffects(payload: Uint8Array): Map<number, SpellChainEffect> {
  const data = toBuffer(payload);
  if (data.byteLength < 20 || data.subarray(0, 4).toString("latin1") !== "WDBC") {
    throw new DbcError("SpellChainEffects: not a WDBC file");
  }
  const records = data.readUInt32LE(4);
  const fields = data.readUInt32LE(8);
  const recordSize = data.readUInt32LE(12);
  const stringsSize = data.readUInt32LE(16);
  const stringsOffset = 20 + records * recordSize;
  if (fields !== SPELL_CHAIN_EFFECTS_FIELDS || recordSize !== SPELL_CHAIN_EFFECTS_RECORD
    || stringsOffset + stringsSize !== data.byteLength) {
    throw new DbcError(`SpellChainEffects: ${fields} fields of ${recordSize} bytes, expected `
      + `${SPELL_CHAIN_EFFECTS_FIELDS} of ${SPELL_CHAIN_EFFECTS_RECORD}`);
  }
  const string = (offset: number): string => {
    if (offset === 0 || offset >= stringsSize) return "";
    const start = stringsOffset + offset;
    const end = data.indexOf(0, start);
    return end < start ? "" : data.subarray(start, end).toString("utf8");
  };
  const result = new Map<number, SpellChainEffect>();
  for (let row = 0; row < records; row++) {
    const base = 20 + row * recordSize;
    const dword = (index: number): number => data.readInt32LE(base + index * 4);
    const float = (index: number): number => data.readFloatLE(base + index * 4);
    const effect: SpellChainEffect = {
      id: dword(0),
      texture: string(data.readUInt32LE(base + 7 * 4)),
      width: float(2),
      avgSegLen: float(1),
      noiseScale: float(3),
      texCoordScale: float(4),
      textureLength: data.readFloatLE(base + 169),
      segDuration: dword(5),
      segDelay: dword(6),
      flags: dword(8),
      jointCount: dword(9),
      color: [data[base + 156]!, data[base + 157]!, data[base + 158]!, data[base + 159]!],
      blendMode: data[base + 160]!,
      renderLayer: data.readInt32LE(base + 165),
    };
    const numbers = [effect.width, effect.avgSegLen, effect.noiseScale, effect.texCoordScale, effect.textureLength];
    if (effect.id > 0 && effect.texture !== "" && numbers.every(Number.isFinite)) result.set(effect.id, effect);
  }
  return result;
}

/** The kit columns this reads, as `readKits` hands them over. */
export interface KitProcedures {
  procs: readonly number[];
  param0: readonly number[];
  param1: readonly number[];
}

/** The beams of one kit: slots whose CharProc is 0 or 12 and whose CharParamZero names a chain row. */
export function kitChains(kit: KitProcedures, chains: ReadonlyMap<number, SpellChainEffect>): SpellVisualChain[] {
  const result: SpellVisualChain[] = [];
  for (let slot = 0; slot < kit.procs.length; slot++) {
    const proc = kit.procs[slot]!;
    if (proc !== 0 && proc !== 12) continue;
    const id = kit.param0[slot]!;
    if (!Number.isInteger(id) || id <= 0) continue;
    const effect = chains.get(id);
    if (effect) result.push({ slot, proc, param1: kit.param1[slot] ?? 0, effect });
  }
  return result;
}

function toBuffer(payload: Uint8Array): Buffer {
  return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
}
