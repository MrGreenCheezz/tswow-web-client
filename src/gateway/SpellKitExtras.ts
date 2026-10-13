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
//
// 13.10 (6.13), Wow.exe 3.3.5a 12340 read-only (.runtime/re-2026-10-11/glue-1110/1013-m4…m8.txt): the kit
// procedure switch 0x007265c0 sends CharProc 0 and 12 alike to 0x007fc950 → 0x007fc5f0 with two flags,
// CharParamTwo ≠ 0 («persistent»: record +0x50 bit 1 — the beam shows for as long as the kit, ignoring its
// time window) and CharParamThree ≠ 0 («fan»: 0x007fa4d0 starts every segment at the caster instead of at
// the previous target). 0x007fc5f0 then builds one beam record for the row and one more for every id of
// the row's Combo string (4 bytes per id, decoded by 0x009a8ce0; at most 12, the walk stops at an id that
// names no row). The whole SpellChainEffects row is carried (Lightning.cpp reads all of it, browser/
// LightningBeam.ts); the client's in-memory row is the file's with the unaligned tail realigned (Combo at
// +0xa4, RenderLayer +0xa8, TextureLength +0xac, WavePhase +0xb0).

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

/** One SpellChainEffects row, every column Lightning.cpp reads (browser/LightningBeam.ts has the arithmetic). */
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
  /** Bytes 156–159 in file order: alpha, red, green, blue (0x009a9900 stores them as one ARGB word). */
  color: [number, number, number, number];
  /** The engine's GxBlend (0x009aa210: render state 6, alpha reference from the table 0x00ad8b7c). */
  blendMode: number;
  renderLayer: number;
  // 13.10 (6.13): the rest of the row, dwords 10–38 and the realigned WavePhase.
  jointOffsetRadius: number;
  jointsPerMinorJoint: number;
  minorJointsPerMajorJoint: number;
  minorJointScale: number;
  majorJointScale: number;
  jointMoveSpeed: number;
  jointSmoothness: number;
  minDurationBetweenJoints: number;
  maxDurationBetweenJoints: number;
  waveHeight: number;
  waveFreq: number;
  waveSpeed: number;
  minWaveAngle: number;
  maxWaveAngle: number;
  minWaveSpin: number;
  maxWaveSpin: number;
  arcHeight: number;
  minArcAngle: number;
  maxArcAngle: number;
  minArcSpin: number;
  maxArcSpin: number;
  delayBetweenEffects: number;
  minFlickerOnDuration: number;
  maxFlickerOnDuration: number;
  minFlickerOffDuration: number;
  maxFlickerOffDuration: number;
  pulseSpeed: number;
  pulseOnLength: number;
  pulseFadeLength: number;
  wavePhase: number;
  /** The Combo string's ids (0x009a8ce0), in order; empty when it names none. */
  combo: number[];
}

/** One beam slot of a kit. */
export interface SpellVisualChain {
  /** The kit's procedure slot, 0…3. */
  slot: number;
  /** CharProc: 0 or 12. */
  proc: number;
  /** CharParamOne[slot] (0 or 1 on most rows; 0x007265c0 does not read it for CharProc 0/12). */
  param1: number;
  effect: SpellChainEffect;
  /** 13.10: CharParamTwo ≠ 0 — shown for as long as the kit, whatever the segment times (record +0x50 bit 1). */
  persistent?: boolean;
  /** 13.10: CharParamThree ≠ 0 — every segment from the caster (0x007fa4d0 `param_5`), not a chain. */
  fan?: boolean;
  /** 13.10: the rows the effect's Combo names, drawn with it as beams of their own (0x007fc5f0). */
  combos?: SpellChainEffect[];
}

/** 0x007fc5f0: a beam builds at most this many records (its row and its combos). */
export const CHAIN_COMBO_LIMIT = 12;

/**
 * 0x009a8ce0: one Combo id from four bytes of the string (read as a little-endian word). The client
 * packs 7 bits a byte; this is its bit shuffle, verbatim.
 */
export function decodeChainComboId(word: number): number {
  const p = word >>> 0;
  const u = (p & 0xfefefefe) >>> 0;
  const high = ((((((((u >>> 7) & 0x200000) | (p & 0x20000000)) >>> 3) | (p & 0x2000000)) >>> 4) | (p & 0x40000000)) >>> 3
    | (p & 0x4000000)) >>> 11;
  return (high | ((((u >>> 4) & 0xff800000) | u) & 0xffffff)) >>> 0;
}

/** The ids of a Combo string, four bytes at a time, up to the first that decodes to 0. */
export function chainComboIds(bytes: Uint8Array): number[] {
  const ids: number[] = [];
  for (let at = 0; at + 4 <= bytes.length && ids.length < CHAIN_COMBO_LIMIT; at += 4) {
    const id = decodeChainComboId(bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16) | (bytes[at + 3]! << 24));
    if (id === 0) break;
    ids.push(id);
  }
  return ids;
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
  const bytesAt = (offset: number): Buffer => {
    if (offset === 0 || offset >= stringsSize) return data.subarray(0, 0);
    const start = stringsOffset + offset;
    const end = data.indexOf(0, start);
    return end < start ? data.subarray(0, 0) : data.subarray(start, end);
  };
  const string = (offset: number): string => bytesAt(offset).toString("utf8");
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
      // 13.10 (6.13)
      jointOffsetRadius: float(10),
      jointsPerMinorJoint: dword(11),
      minorJointsPerMajorJoint: dword(12),
      minorJointScale: float(13),
      majorJointScale: float(14),
      jointMoveSpeed: float(15),
      jointSmoothness: float(16),
      minDurationBetweenJoints: float(17),
      maxDurationBetweenJoints: float(18),
      waveHeight: float(19),
      waveFreq: float(20),
      waveSpeed: float(21),
      minWaveAngle: float(22),
      maxWaveAngle: float(23),
      minWaveSpin: float(24),
      maxWaveSpin: float(25),
      arcHeight: float(26),
      minArcAngle: float(27),
      maxArcAngle: float(28),
      minArcSpin: float(29),
      maxArcSpin: float(30),
      delayBetweenEffects: float(31),
      minFlickerOnDuration: float(32),
      maxFlickerOnDuration: float(33),
      minFlickerOffDuration: float(34),
      maxFlickerOffDuration: float(35),
      pulseSpeed: float(36),
      pulseOnLength: float(37),
      pulseFadeLength: float(38),
      wavePhase: data.readFloatLE(base + 173),
      combo: chainComboIds(bytesAt(data.readUInt32LE(base + 161))),
    };
    const numbers = [effect.width, effect.avgSegLen, effect.noiseScale, effect.texCoordScale, effect.textureLength,
      effect.jointOffsetRadius, effect.minorJointScale, effect.majorJointScale, effect.jointMoveSpeed, effect.jointSmoothness,
      effect.minDurationBetweenJoints, effect.maxDurationBetweenJoints, effect.waveHeight, effect.waveFreq, effect.waveSpeed,
      effect.minWaveAngle, effect.maxWaveAngle, effect.minWaveSpin, effect.maxWaveSpin, effect.arcHeight, effect.minArcAngle,
      effect.maxArcAngle, effect.minArcSpin, effect.maxArcSpin, effect.delayBetweenEffects, effect.minFlickerOnDuration,
      effect.maxFlickerOnDuration, effect.minFlickerOffDuration, effect.maxFlickerOffDuration, effect.pulseSpeed,
      effect.pulseOnLength, effect.pulseFadeLength, effect.wavePhase];
    if (effect.id > 0 && effect.texture !== "" && numbers.every(Number.isFinite)) result.set(effect.id, effect);
  }
  return result;
}

/** The kit columns this reads, as `readKits` hands them over. */
export interface KitProcedures {
  procs: readonly number[];
  param0: readonly number[];
  param1: readonly number[];
  /** 13.10: CharParamTwo / CharParamThree (absent: both 0). */
  param2?: readonly number[];
  param3?: readonly number[];
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
    if (!effect) continue;
    const chain: SpellVisualChain = { slot, proc, param1: kit.param1[slot] ?? 0, effect };
    // 13.10: 0x007265c0 passes (CharParamTwo ≠ 0, CharParamThree ≠ 0); 0x007fc5f0 walks the first row's Combo
    // while each id names a row (row and combos together at most CHAIN_COMBO_LIMIT records).
    if ((kit.param2?.[slot] ?? 0) !== 0) chain.persistent = true;
    if ((kit.param3?.[slot] ?? 0) !== 0) chain.fan = true;
    const combos: SpellChainEffect[] = [];
    for (const comboId of effect.combo) {
      if (combos.length + 1 >= CHAIN_COMBO_LIMIT) break;
      const row = chains.get(comboId);
      if (!row) break;
      combos.push(row);
    }
    if (combos.length > 0) chain.combos = combos;
    result.push(chain);
  }
  return result;
}

function toBuffer(payload: Uint8Array): Buffer {
  return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
}
