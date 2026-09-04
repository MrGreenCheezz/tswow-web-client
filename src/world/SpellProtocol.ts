import { PacketReader } from "../protocol/PacketReader.js";
import { PacketWriter } from "../protocol/PacketWriter.js";
import { SPELL_CAST_RESULT_NAMES, globalString } from "../generated/globalStrings.js";

/** `TARGET_FLAG_NONE`: no explicit target, which is what makes the server pick one. */
export const TARGET_FLAG_NONE = 0x0000_0000;
export const TARGET_FLAG_UNIT = 0x0000_0002;
export const TARGET_FLAG_UNIT_MINIPET = 0x0001_0000;
export const TARGET_FLAG_ITEM = 0x0000_0010;
export const TARGET_FLAG_TRADE_ITEM = 0x0000_1000;
export const TARGET_FLAG_SOURCE_LOCATION = 0x0000_0020;
export const TARGET_FLAG_DEST_LOCATION = 0x0000_0040;
export const TARGET_FLAG_CORPSE_ENEMY = 0x0000_0200;
export const TARGET_FLAG_GAMEOBJECT = 0x0000_0800;
export const TARGET_FLAG_STRING = 0x0000_2000;
export const TARGET_FLAG_CORPSE_ALLY = 0x0000_8000;

/** Mutually-exclusive primary object target kinds in the 3.3.5 SpellCastTargets block. */
const OBJECT_TARGET_FLAGS = TARGET_FLAG_UNIT | TARGET_FLAG_UNIT_MINIPET
  | TARGET_FLAG_GAMEOBJECT | TARGET_FLAG_CORPSE_ENEMY | TARGET_FLAG_CORPSE_ALLY;
/** Mutually-exclusive item target kinds in the 3.3.5 SpellCastTargets block. */
const ITEM_TARGET_FLAGS = TARGET_FLAG_ITEM | TARGET_FLAG_TRADE_ITEM;

export interface KnownSpell {
  id: number;
  slot: number;
}

export interface InitialSpells {
  spells: KnownSpell[];
  cooldowns: SpellCooldown[];
}

export interface SpellCooldown {
  spellId: number;
  itemId: number;
  categoryId: number;
  cooldown: number;
  categoryCooldown: number;
}

export interface CastFailure {
  castCount: number;
  spellId: number;
  result: number;
}

export interface SpellCastHeader {
  casterGuid: bigint;
  casterUnit: bigint;
  castId: number;
  spellId: number;
  castFlags: number;
  castTime: number;
}

/**
 * `SMSG_SPELL_GO`, far enough in to know who was hit.
 *
 * The header alone says a spell went off and stops there, which left the renderer guessing the
 * target from `UNIT_FIELD_TARGET` — a field that is empty for every area spell, stale for any
 * caster mid-swap, and simply absent for anything a totem or a trap does. The hit list is the
 * server's own answer and it is eleven bytes further in.
 *
 * The trailing `SpellCastTargets` block is optional in captures made by older tests and private
 * servers, so it is read only when at least its four-byte mask is present. The target mask is not
 * the cast flags in the header. In particular, `TARGET_FLAG_DEST_LOCATION` is bit 0x40 here.
 */
export interface SpellCastTargets {
  targetFlags: number;
  unitTarget?: bigint;
  gameObjectTarget?: bigint;
  itemTarget?: bigint;
  source?: { x: number; y: number; z: number };
  destination?: { x: number; y: number; z: number };
  targetString?: string;
}

export interface SpellGo extends SpellCastHeader {
  /** Everything the spell landed on, in the order the server resolved them. */
  hits: bigint[];
  /** Everything it did not, with the reason. A miss still shows the bolt arriving. */
  misses: { guid: bigint; reason: number }[];
  /** The optional target block; absent when a legacy/private packet ended after the miss list. */
  targets?: SpellCastTargets;
}

export interface SpellCooldownPacket {
  guid: bigint;
  flags: number;
  cooldowns: Array<{ spellId: number; duration: number }>;
}

export function parseInitialSpells(payload: Uint8Array): InitialSpells {
  const reader = new PacketReader(payload);
  reader.u8();
  const spellCount = reader.u16();
  const spells: KnownSpell[] = [];
  for (let index = 0; index < spellCount; index++) {
    spells.push({ id: reader.u32(), slot: reader.u16() });
  }

  const cooldownCount = reader.u16();
  const cooldowns: SpellCooldown[] = [];
  for (let index = 0; index < cooldownCount; index++) {
    cooldowns.push({
      spellId: reader.u32(),
      itemId: reader.u16(),
      categoryId: reader.u16(),
      cooldown: reader.u32(),
      categoryCooldown: reader.u32(),
    });
  }
  reader.assertFinished();
  return { spells, cooldowns };
}

/**
 * `CMSG_CAST_SPELL` naming no unit, so that the server chooses one, but naming a point, so that a
 * ground spell still lands where the player is looking.
 *
 * Writing `TARGET_FLAG_UNIT` and the selected guid is what stopped a heal or a buff landing while
 * an enemy was selected: the explicit target the client names wins, and a friendly spell aimed at
 * a hostile unit simply fails. With no unit flag in the mask the server takes its own selection
 * (`Spell.cpp:687-707`: `playerCaster->GetTarget()` on `:694`), runs it through
 * `CheckExplicitTarget` (`:695`) and falls back to the caster when that refuses (`:703-704`) —
 * which is the original client's behaviour for every self-or-friendly spell in the game, and it
 * needs no table of implicit targets on this side. `buildUseItem` in `ItemProtocol.ts` has always
 * written the mask as a bare zero, and bandages and potions have always worked with an enemy
 * selected.
 *
 * `destination` is why the mask is not a bare zero here as well, and it is the correction the
 * review made to the first attempt at this. A mask of zero makes `SpellCastTargets::Read` return
 * before it fills src or dst (`Spell.cpp:148-149`), and `InitExplicitTargets` then fills them from
 * the caster (`:710-733`) — which sounds harmless and is not. For a spell that needs a ground
 * point, `:714-721` prefers the point the client sent, falls back to the object the client named,
 * and reaches `SetDst(*m_caster)` on `:721` only when given neither. Sending nothing at all
 * moved every area spell from the target's feet to the caster's own: measured on this dataset,
 * 1,148 of the 49,842 `Spell.dbc` rows carry `Targets & TARGET_FLAG_DEST_LOCATION`, not one of
 * them names a unit flag in the same column, and 86 of them — 23 distinct names — are learnable
 * through `SkillLineAbility` and not passive: Blizzard, Flamestrike, Rain of Fire, Volley,
 * Hurricane, Typhoon, Force of Nature, Death and Decay, Mass Dispel, Lightwell and the rest of
 * the ground-targeted kit. Writing the point keeps them on the target: `HasDst()` is true on
 * `:714`, so the client's point survives. A spell that has no use for it loses it on the same
 * pass — `:725` calls `RemoveDst()` when `TARGET_FLAG_DEST_LOCATION` is not in the spell's needed
 * mask — and `InitExplicitTargets` runs first thing in `Spell::prepare` (`:3189`), before anything
 * else can see the extra point. The dst carries the packed transport guid WotLK puts before every
 * location; zero means the three floats are world coordinates.
 *
 * With no `destination` the mask is a bare zero and the packet is the ten bytes it was. That is
 * the shape for a caller that does not yet know where anybody is standing — before the first
 * `SMSG_UPDATE_OBJECT`, in a test — and it is a worse answer than a point, not an equal one.
 *
 * Three things are still paid for the empty unit flag, and none of them is invisible:
 * (a) the packet no longer matches what the original client sends when the target is legitimate;
 * (b) «на себя / на выбранную цель» in `WorldClient.castSpell` is now a guess — only
 *     `SMSG_SPELL_GO` knows where the cast actually went;
 * (c) auto-repeat restarts instead of being ignored, and that breaks today rather than later.
 *     `HandleCastSpellOpcode` (`SpellHandler.cpp:388-398`) drops a repeat of an auto-repeat
 *     ranged spell only when the incoming block's `GetUnitTargetGUID` equals the running spell's
 *     (`:392`) — and the running spell's is the selection the server itself wrote there on
 *     `Spell.cpp:706`, while ours is now always zero. So the guard the core's own comment says is
 *     there "to prevent 'interrupt' message" (`:386-387`) never fires: `Spell::prepare` runs
 *     again, `Unit::SetCurrentCastSpell` replaces the running auto-repeat (`Unit.cpp:3290-3294`,
 *     `:3350-3355`) and sets `m_AutoRepeatFirstCast` (`:3341`), which `_UpdateAutoRepeatSpell`
 *     turns into a forced 500 ms ranged timer for everything that is not Auto Shot
 *     (`:3256-3257`). Two auto-repeat ranged spells in this dataset are reachable from the book —
 *     75 Auto Shot and 5019 Shoot, measured over the six that carry
 *     `SPELL_ATTR2_AUTOREPEAT_FLAG` — and `spellButtonUsable` greys out only passives, so pressing
 *     either a second time while it runs is one click away. Fixing it needs the guid back for
 *     exactly those two spells, which needs an attribute this gateway does not serve yet.
 */
export function buildCastSpell(
  spellId: number,
  castCount: number,
  destination?: { x: number; y: number; z: number },
): Uint8Array {
  const writer = new PacketWriter()
    .u8(castCount)
    .u32(spellId)
    .u8(0)
    .u32(destination === undefined ? TARGET_FLAG_NONE : TARGET_FLAG_DEST_LOCATION);
  if (destination === undefined) return writer.toUint8Array();
  return writer
    .packedGuid(0n)
    .f32(destination.x)
    .f32(destination.y)
    .f32(destination.z)
    .toUint8Array();
}

/**
 * Starts the server-owned ranged repeat container against one explicit unit.
 *
 * TrinityCore's duplicate guard compares this incoming guid with the active repeat target. A
 * targetless ordinary cast packet therefore restarts Auto Shot/Shoot on every press; keep this
 * unit-bearing shape dedicated to spells carrying `SPELL_ATTR2_AUTOREPEAT_FLAG`.
 */
export function buildAutoRepeatCastSpell(spellId: number, castCount: number, targetGuid: bigint): Uint8Array {
  return new PacketWriter()
    .u8(castCount)
    .u32(spellId)
    .u8(0)
    .u32(TARGET_FLAG_UNIT)
    .packedGuid(targetGuid)
    .toUint8Array();
}

/**
 * Casts at a game object rather than at a creature — the only way a chest, an ore vein or a herb
 * is ever opened.
 *
 * The server does not have a "use" path for those: they are not in its `GameObject::Use` switch at
 * all. It does compute the right spell itself and will accept it even from a player who does not
 * know it, but only when the spell matches exactly what it worked out, so the client has to reach
 * the same answer from `Lock.dbc`. The one difference from a unit cast is the target flag.
 */
export function buildCastSpellOnGameObject(spellId: number, castCount: number, guid: bigint): Uint8Array {
  return new PacketWriter()
    .u8(castCount)
    .u32(spellId)
    .u8(0)
    .u32(TARGET_FLAG_GAMEOBJECT)
    .packedGuid(guid)
    .toUint8Array();
}

/** Enchanting and other crafting spells target an owned item with the ordinary ITEM mask. */
export function buildCastSpellOnItem(spellId: number, castCount: number, guid: bigint): Uint8Array {
  return new PacketWriter().u8(castCount).u32(spellId).u8(0)
    .u32(TARGET_FLAG_ITEM).packedGuid(guid).toUint8Array();
}

/** A valid packet has a four-byte target mask; older fixtures may omit the whole block. */
function parseSpellCastTargets(reader: PacketReader): SpellCastTargets | undefined {
  if (reader.remaining < 4) return undefined;
  const targetFlags = reader.u32();
  const targets: SpellCastTargets = { targetFlags };
  try {
    // These groups each carry one GUID, even when the mask contains an unusual combination of
    // flags.  Keeping the groups separate is important: an item GUID before DEST_LOCATION must
    // be consumed or the three destination floats are decoded from the wrong byte.
    if (targetFlags & OBJECT_TARGET_FLAGS) {
      const guid = reader.packedGuid();
      if (targetFlags & TARGET_FLAG_GAMEOBJECT) targets.gameObjectTarget = guid;
      else targets.unitTarget = guid;
    }
    if (targetFlags & ITEM_TARGET_FLAGS) targets.itemTarget = reader.packedGuid();
    // WotLK writes a packed transport GUID before each location's three floats.  It is not part
    // of the visual-facing shape, but it is part of the wire and must be consumed before DEST.
    if (targetFlags & TARGET_FLAG_SOURCE_LOCATION) {
      reader.packedGuid();
      if (reader.remaining < 12) return targets;
      targets.source = { x: reader.f32(), y: reader.f32(), z: reader.f32() };
    }
    if (targetFlags & TARGET_FLAG_DEST_LOCATION) {
      reader.packedGuid();
      if (reader.remaining < 12) return targets;
      targets.destination = { x: reader.f32(), y: reader.f32(), z: reader.f32() };
    }
    if (targetFlags & TARGET_FLAG_STRING) {
      if (reader.remaining === 0) return targets;
      targets.targetString = reader.cString();
    }
  } catch {
    // A malformed optional tail must not make the already parsed hit/miss lists disappear.
  }
  return targets;
}

/** `TARGET_FLAG_GAMEOBJECT`. The unit flag is 0x02; this is a different word entirely. */

export function parseCastFailure(payload: Uint8Array): CastFailure {
  const reader = new PacketReader(payload);
  return { castCount: reader.u8(), spellId: reader.u32(), result: reader.u8() };
}

export function parseSpellCastHeader(payload: Uint8Array): SpellCastHeader {
  const reader = new PacketReader(payload);
  return {
    casterGuid: reader.packedGuid(),
    casterUnit: reader.packedGuid(),
    castId: reader.u8(),
    spellId: reader.u32(),
    castFlags: reader.u32(),
    castTime: reader.u32(),
  };
}

/**
 * `SPELL_MISS_REFLECT`: the only miss reason that writes a second byte after itself.
 *
 * Eleven, not three. Three is a dodge — this repository's own `MISS_REASONS` says so, and the
 * reference client's `spell_defines.hpp` agrees. Reading it as three eats a byte after every
 * dodged attack and shifts the rest of the miss list.
 */
const SPELL_MISS_REFLECT = 11;
/** A cast cannot land on more of the world than this; anything larger is a misread packet. */
const MAX_SPELL_TARGETS = 512;

export function parseSpellGo(payload: Uint8Array): SpellGo {
  const reader = new PacketReader(payload);
  const header: SpellCastHeader = {
    casterGuid: reader.packedGuid(),
    casterUnit: reader.packedGuid(),
    castId: reader.u8(),
    spellId: reader.u32(),
    castFlags: reader.u32(),
    castTime: reader.u32(),
  };
  const hits: bigint[] = [];
  const misses: { guid: bigint; reason: number }[] = [];
  // Full guids here, not packed: the two lists are the one place in this packet that writes them
  // whole, and reading them packed eats the byte after and loses the rest of the list.
  const hitCount = reader.remaining > 0 ? reader.u8() : 0;
  for (let index = 0; index < hitCount && index < MAX_SPELL_TARGETS && reader.remaining >= 8; index++) {
    hits.push(reader.u64());
  }
  const missCount = reader.remaining > 0 ? reader.u8() : 0;
  for (let index = 0; index < missCount && index < MAX_SPELL_TARGETS && reader.remaining >= 9; index++) {
    const guid = reader.u64();
    const reason = reader.u8();
    // A reflect writes the result of the reflection after the reason, and nothing else does.
    if (reason === SPELL_MISS_REFLECT && reader.remaining > 0) reader.u8();
    misses.push({ guid, reason });
  }
  const targets = parseSpellCastTargets(reader);
  return targets === undefined ? { ...header, hits, misses } : { ...header, hits, misses, targets };
}

export function parseSpellCooldown(payload: Uint8Array): SpellCooldownPacket {
  const reader = new PacketReader(payload);
  const guid = reader.u64();
  const flags = reader.u8();
  const cooldowns = [];
  while (reader.remaining > 0) cooldowns.push({ spellId: reader.u32(), duration: reader.u32() });
  return { guid, flags, cooldowns };
}

export function parseCooldownEvent(payload: Uint8Array): { spellId: number; guid: bigint } {
  const reader = new PacketReader(payload);
  const result = { spellId: reader.u32(), guid: reader.u64() };
  reader.assertFinished();
  return result;
}

export function parseClearCooldown(payload: Uint8Array): { spellId: number; guid: bigint } {
  return parseCooldownEvent(payload);
}

/**
 * `SMSG_SPELL_FAILURE` and `SMSG_SPELL_FAILED_OTHER` have the same four fields: the first is sent
 * to the caster, the second to everyone else watching, and both mean the cast stopped.
 */
export interface SpellFailure {
  casterGuid: bigint;
  castCount: number;
  spellId: number;
  result: number;
}

export function parseSpellFailure(payload: Uint8Array): SpellFailure {
  const reader = new PacketReader(payload);
  const failure = {
    casterGuid: reader.packedGuid(),
    castCount: reader.u8(),
    spellId: reader.u32(),
    result: reader.u8(),
  };
  reader.assertFinished();
  return failure;
}

/**
 * `SMSG_SPELL_DELAYED`: a cast was pushed back, by damage taken. The delay is added to the time
 * still to run, so a cast bar has to grow rather than restart.
 */
export function parseSpellDelayed(payload: Uint8Array): { casterGuid: bigint; delay: number } {
  const reader = new PacketReader(payload);
  const delayed = { casterGuid: reader.packedGuid(), delay: reader.u32() };
  reader.assertFinished();
  return delayed;
}

export interface ChannelStart {
  casterGuid: bigint;
  spellId: number;
  duration: number;
}

/** `MSG_CHANNEL_START`, from `Spell::SendChannelStart`. */
export function parseChannelStart(payload: Uint8Array): ChannelStart {
  const reader = new PacketReader(payload);
  const start = { casterGuid: reader.packedGuid(), spellId: reader.u32(), duration: reader.u32() };
  reader.assertFinished();
  return start;
}

/** `MSG_CHANNEL_UPDATE`: how much of the channel is left. Zero means it has ended. */
export function parseChannelUpdate(payload: Uint8Array): { casterGuid: bigint; remaining: number } {
  const reader = new PacketReader(payload);
  const update = { casterGuid: reader.packedGuid(), remaining: reader.u32() };
  reader.assertFinished();
  return update;
}

/**
 * `SMSG_MODIFY_COOLDOWN`: a cooldown was shortened or lengthened while it ran. The delta is
 * signed — talents and procs both cut cooldowns short.
 */
export interface CooldownModification {
  spellId: number;
  guid: bigint;
  delta: number;
}

export function parseModifyCooldown(payload: Uint8Array): CooldownModification {
  const reader = new PacketReader(payload);
  const change = { spellId: reader.u32(), guid: reader.u64(), delta: reader.i32() };
  reader.assertFinished();
  return change;
}

/** `SMSG_ITEM_COOLDOWN`: an item's use cooldown started. */
export function parseItemCooldown(payload: Uint8Array): { itemGuid: bigint; spellId: number } {
  const reader = new PacketReader(payload);
  const cooldown = { itemGuid: reader.u64(), spellId: reader.u32() };
  reader.assertFinished();
  return cooldown;
}

/** How many runes a death knight has. `MAX_RUNES` in the core. */
export const MAX_RUNES = 6;

export interface RuneState {
  /** Blood, unholy, frost or death, per `RuneType`. */
  type: number;
  /**
   * 0 to 255, and it counts the wrong way round: the core sends
   * `255 - cooldown * 255 / RUNE_BASE_COOLDOWN`, so 255 is a rune that is ready.
   */
  readiness: number;
}

/** `SMSG_RESYNC_RUNES`, from `Player::ResyncRunes`. */
export function parseResyncRunes(payload: Uint8Array): RuneState[] {
  const reader = new PacketReader(payload);
  const count = reader.u32();
  if (count > 32) throw new RangeError(`Rune resync names ${count} runes`);
  const runes: RuneState[] = [];
  for (let index = 0; index < count; index++) runes.push({ type: reader.u8(), readiness: reader.u8() });
  reader.assertFinished();
  return runes;
}

/** `SMSG_CONVERT_RUNE`: one rune changed type, which is what death runes are. */
export function parseConvertRune(payload: Uint8Array): { index: number; type: number } {
  const reader = new PacketReader(payload);
  const converted = { index: reader.u8(), type: reader.u8() };
  reader.assertFinished();
  return converted;
}

/** `SMSG_ADD_RUNE_POWER`: a bit mask of the runes that just came off cooldown. */
export function parseAddRunePower(payload: Uint8Array): number {
  const reader = new PacketReader(payload);
  const mask = reader.u32();
  reader.assertFinished();
  return mask;
}

/**
 * `SMSG_SET_PROJECTILE_POSITION`: where a thrown or fired spell is in flight, so the missile can
 * be drawn along the right line rather than straight at the target.
 */
export interface ProjectilePosition {
  casterGuid: bigint;
  castCount: number;
  x: number;
  y: number;
  z: number;
}

export function parseProjectilePosition(payload: Uint8Array): ProjectilePosition {
  const reader = new PacketReader(payload);
  const position = {
    casterGuid: reader.u64(),
    castCount: reader.u8(),
    x: reader.f32(),
    y: reader.f32(),
    z: reader.f32(),
  };
  reader.assertFinished();
  return position;
}

export interface SpellModifier {
  /** Which of the 96 spell-family bits this modifier applies to. */
  effectIndex: number;
  /** `SpellModOp`: what about the spell it changes — its cost, its duration, its damage. */
  op: number;
  /** Flat points or whole percent, depending on which of the two opcodes carried it. */
  value: number;
}

/** `SMSG_SET_FLAT_SPELL_MODIFIER` and `SMSG_SET_PCT_SPELL_MODIFIER` share this shape. */
export function parseSpellModifier(payload: Uint8Array): SpellModifier {
  const reader = new PacketReader(payload);
  const modifier = { effectIndex: reader.u8(), op: reader.u8(), value: reader.i32() };
  reader.assertFinished();
  return modifier;
}

export interface TotemCreated {
  slot: number;
  guid: bigint;
  duration: number;
  spellId: number;
}

/** `SMSG_TOTEM_CREATED`: which of the four totem slots was filled, and for how long. */
export function parseTotemCreated(payload: Uint8Array): TotemCreated {
  const reader = new PacketReader(payload);
  const totem = { slot: reader.u8(), guid: reader.u64(), duration: reader.u32(), spellId: reader.u32() };
  reader.assertFinished();
  return totem;
}

/**
 * `SMSG_MOUNT_RESULT`: why the mount was refused. Success is never sent.
 *
 * The comment this replaces said zero was success, and it is not: `MountResult::Ok` is **10**
 * (`SharedDefines.h:3813-3826`, marked «never sent» in the core itself) and zero is
 * `InvalidMountee`. `Spell::SendMountResult` (`Spell.cpp:4391-4406`) returns before writing a byte
 * on `Ok`, on a non-player caster and on a caster still loading, so every packet that arrives here
 * is a refusal.
 */
export function parseMountResult(payload: Uint8Array): number {
  const reader = new PacketReader(payload);
  const result = reader.i32();
  reader.assertFinished();
  return result;
}

/**
 * Why a cast was refused, in the realm's own words.
 *
 * The wire carries a `SpellCastResult` byte and nothing else — the sentence has always been the
 * client's job, and this build's dataset holds 265 of them. What the interface printed instead was
 * «Заклинание 133 отклонено сервером, код 50», into a status line inside the spellbook window,
 * which is hidden unless the player happens to have it open.
 *
 * `SPELL_FAILED_DONT_REPORT` is the server saying "show nothing"; it is the one answer that must
 * produce no message at all.
 */
export function spellFailureText(result: number): string | undefined {
  const name = SPELL_CAST_RESULT_NAMES[result];
  if (name === "DONT_REPORT" || name === "SUCCESS") return undefined;
  // A code this build's enum does not know still gets said out loud: a refusal the player cannot
  // see is a spell that silently did nothing.
  if (name === undefined) return `Заклинание отклонено (код ${result})`;
  return globalString(`SPELL_FAILED_${name}`) ?? `Заклинание отклонено (код ${result})`;
}
