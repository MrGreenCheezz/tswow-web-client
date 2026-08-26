import { PacketReader } from "../protocol/PacketReader.js";
import { PacketWriter } from "../protocol/PacketWriter.js";

// Layouts follow the active TrinityCore source: Player.cpp (`PetSpellInitialize`,
// `PossessSpellInitialize`, `VehicleSpellInitialize`, `CharmSpellInitialize`, `RemovePet`,
// `SendTameFailure`), Unit.cpp (`CharmInfo::BuildActionBar`, `SendPetActionFeedback`,
// `SendPetTalk`, `SendComboPoints`), SpellHistory.cpp `WritePacket<Pet>`, PetHandler.cpp
// (`SendQueryPetNameResponse`, `SendPetNameInvalid`, and every handler the client drives) and
// PetPackets.cpp.
//
// This fork has no `Pet::SendPetSpellsMessage`: every `SMSG_PET_SPELLS` is built inline at one of
// six places in Player.cpp, and the four full variants agree on the layout below.

/** `MAX_UNIT_ACTION_BAR_INDEX` in Unit.h. Always written in full, never counted. */
export const PET_ACTION_BAR_SIZE = 10;
/** Slots 3 to 6 hold the pet's own spells; 0 to 2 are commands and 7 to 9 are reactions. */
export const PET_SPELL_SLOT_START = 3;
export const PET_SPELL_SLOT_END = 7;
/** `MAX_DECLINED_NAME_CASES` in UnitDefines.h: five, always all five when present. */
export const DECLINED_NAME_CASES = 5;

/** `ActiveStates` in UnitDefines.h — the high byte of an action-bar word. */
export const ACT_PASSIVE = 0x01;
export const ACT_DISABLED = 0x81;
export const ACT_ENABLED = 0xc1;
export const ACT_COMMAND = 0x07;
export const ACT_REACTION = 0x06;

/** `CommandStates` in UnitDefines.h — the low half of a command button. */
export const COMMAND_STAY = 0;
export const COMMAND_FOLLOW = 1;
export const COMMAND_ATTACK = 2;
export const COMMAND_ABANDON = 3;

/** `ReactStates` in UnitDefines.h. */
export const REACT_PASSIVE = 0;
export const REACT_DEFENSIVE = 1;
export const REACT_AGGRESSIVE = 2;

/**
 * `MAKE_UNIT_ACTION_BUTTON` in Unit.h: the action in the low 24 bits and the state in the high 8.
 * The player's own bar packs the same way, which is why `ActionBarProtocol` splits it identically.
 */
export const petActionOf = (packed: number): number => packed & 0x00ff_ffff;
export const petActionTypeOf = (packed: number): number => (packed >>> 24) & 0xff;
export const packPetAction = (action: number, type: number): number => (((type & 0xff) << 24) | (action & 0x00ff_ffff)) >>> 0;

export interface PetActionButton {
  slot: number;
  packed: number;
  /** A spell id on a spell slot, a `COMMAND_*` or `REACT_*` code on the others. */
  action: number;
  /** An `ACT_*` state — except on a vehicle bar, where it is the slot index offset by eight. */
  type: number;
}

export interface PetSpellEntry {
  spellId: number;
  /** `ACT_ENABLED` means autocast is on, `ACT_DISABLED` off, `ACT_PASSIVE` not castable at all. */
  active: number;
}

export interface PetCooldownEntry {
  spellId: number;
  categoryId: number;
  /** Milliseconds left, or zero when the category timer is the one running. */
  cooldown: number;
  categoryCooldown: number;
  /**
   * True when the packet stopped after the category id. The core writes nothing more for a
   * cooldown that is on hold and puts no marker on the wire saying so — see `parsePetSpells`.
   */
  onHold: boolean;
}

export interface PetSpells {
  guid: bigint;
  /** A zero guid is the whole packet: it means "take the pet bar down". */
  closed: boolean;
  creatureFamily: number;
  /** Milliseconds a temporary pet has left. Signed at the source, so it can arrive very large. */
  duration: number;
  reactState: number;
  commandState: number;
  flags: number;
  /** Exactly ten, in slot order. */
  bar: PetActionButton[];
  /** Empty for a temporary pet: the core only sends a spellbook for a permanent one. */
  spells: PetSpellEntry[];
  cooldowns: PetCooldownEntry[];
}

/**
 * The pet's bar, its book and its timers, in one packet.
 *
 * Two things here are not derivable from the packet alone. The ten action-bar words are a fixed
 * array with no count, so they are read by position — and on a vehicle the high byte is the bar
 * slot index rather than an `ACT_*` state, which is the only way to tell the two bars apart.
 *
 * And the cooldown entries are genuinely ambiguous. `SpellHistory::WritePacket<Pet>` writes the
 * spell id and the category, then writes the two durations *only* when the cooldown is not on
 * hold — and "on hold" never reaches the wire. So an entry is fourteen bytes or six, with nothing
 * saying which. The rule below resolves every case except one: a held cooldown emitted before a
 * running one cannot be told from a running one, because both readings consume the same bytes.
 * Since this block is last, a wrong guess costs the cooldowns and nothing else, and the reader
 * stops rather than throwing.
 */
export function parsePetSpells(payload: Uint8Array): PetSpells {
  const reader = new PacketReader(payload);
  const guid = reader.u64();
  const empty: PetSpells = {
    guid, closed: true, creatureFamily: 0, duration: 0, reactState: 0, commandState: 0, flags: 0,
    bar: [], spells: [], cooldowns: [],
  };
  // `Player::RemovePet` sends a bare zero guid and nothing else. It is a close instruction, not a
  // truncated packet, so it is answered rather than treated as an error.
  if (guid === 0n || reader.remaining === 0) return empty;

  const creatureFamily = reader.u16();
  const duration = reader.u32();
  const reactState = reader.u8();
  const commandState = reader.u8();
  const flags = reader.u16();

  const bar: PetActionButton[] = [];
  for (let slot = 0; slot < PET_ACTION_BAR_SIZE; slot++) {
    const packed = reader.u32();
    bar.push({ slot, packed, action: petActionOf(packed), type: petActionTypeOf(packed) });
  }

  const spellCount = reader.u8();
  const spells: PetSpellEntry[] = [];
  for (let index = 0; index < spellCount; index++) {
    const packed = reader.u32();
    spells.push({ spellId: petActionOf(packed), active: petActionTypeOf(packed) });
  }

  const cooldownCount = reader.u8();
  const cooldowns: PetCooldownEntry[] = [];
  for (let index = 0; index < cooldownCount; index++) {
    if (reader.remaining < 6) break;
    const spellId = reader.u32();
    const categoryId = reader.u16();
    // If the durations were read here, would what is left still hold the shortest possible tail
    // for every entry after this one? If not, this entry must be a held one.
    const shortestRest = (cooldownCount - 1 - index) * 6;
    if (reader.remaining >= 8 + shortestRest) {
      cooldowns.push({ spellId, categoryId, cooldown: reader.u32(), categoryCooldown: reader.u32(), onHold: false });
    } else {
      cooldowns.push({ spellId, categoryId, cooldown: 0, categoryCooldown: 0, onHold: true });
    }
  }

  return {
    guid, closed: false, creatureFamily, duration, reactState, commandState, flags,
    bar, spells, cooldowns,
  };
}

/** How long a cooldown entry really has left: whichever of the two timers is running. */
export function petCooldownRemaining(entry: PetCooldownEntry): number {
  return Math.max(entry.cooldown, entry.categoryCooldown);
}

/**
 * True when this bar came from `VehicleSpellInitialize` rather than from a pet. That builder
 * writes `MAKE_UNIT_ACTION_BUTTON(spellId, i + 8)` for the eight creature spells, so the high
 * byte is the bar slot offset by eight rather than an `ACT_*` state — and 8 to 15 is a range no
 * `ACT_*` value occupies.
 */
export function isVehicleActionBar(bar: readonly PetActionButton[]): boolean {
  return bar.some((button) => button.packed !== 0 && button.type >= 8 && button.type <= 15);
}

/** The spell the pet just learned. No guid: it belongs to whichever pet is out. */
export function parsePetLearnedSpell(payload: Uint8Array): number {
  const reader = new PacketReader(payload);
  const spellId = reader.u32();
  reader.assertFinished();
  return spellId;
}

export const parsePetUnlearnedSpell = parsePetLearnedSpell;

export interface PetComboPoints {
  /** The pet or charm holding the points. */
  guid: bigint;
  /** Who they are on. Empty when there is no target, written as a lone zero mask byte. */
  targetGuid: bigint;
  points: number;
}

/** Two packed guids here, where the rest of this family writes full ones. */
export function parsePetComboPoints(payload: Uint8Array): PetComboPoints {
  const reader = new PacketReader(payload);
  const guid = reader.packedGuid();
  const targetGuid = reader.packedGuid();
  const points = reader.u8();
  reader.assertFinished();
  return { guid, targetGuid, points };
}

/** `ActionFeedback` in PetDefines.h. This build only ever sends `FEEDBACK_PET_DEAD`. */
export const FEEDBACK_NONE = 0;
export const FEEDBACK_PET_DEAD = 1;
export const FEEDBACK_NOTHING_TO_ATTACK = 2;
export const FEEDBACK_CANT_ATTACK_TARGET = 3;

export function parsePetActionFeedback(payload: Uint8Array): number {
  const reader = new PacketReader(payload);
  const feedback = reader.u8();
  reader.assertFinished();
  return feedback;
}

/** `PetTalk` in PetDefines.h: two values, written as a full word. */
export const PET_TALK_SPECIAL_SPELL = 0;
export const PET_TALK_ATTACK = 1;

export interface PetTalk {
  guid: bigint;
  talk: number;
}

/**
 * Only a summoned pet ever says anything, and only about one time in ten — every other case sends
 * `SMSG_AI_REACTION`, which has the identical shape. A hunter pet never sends this at all.
 */
export function parsePetActionSound(payload: Uint8Array): PetTalk {
  const reader = new PacketReader(payload);
  const guid = reader.u64();
  const talk = reader.u32();
  reader.assertFinished();
  return { guid, talk };
}

export interface PetCastFailure {
  /**
   * Zero whenever the failure came from the pet bar rather than from a cast the client counted:
   * that path never assigns the counter. Treat zero as "not correlated".
   */
  castCount: number;
  spellId: number;
  result: number;
}

/**
 * The same three-field header the player's own `SMSG_CAST_FAILED` carries — the core builds both
 * through one helper — followed by a per-reason tail whose length depends on the reason and, for
 * three of them, on data that is not counted. The tail is left unread, exactly as the player's
 * cast failure is.
 *
 * Not sent while possessing or riding: those answer on `SMSG_CAST_FAILED` instead.
 */
export function parsePetCastFailed(payload: Uint8Array): PetCastFailure {
  const reader = new PacketReader(payload);
  return { castCount: reader.u8(), spellId: reader.u32(), result: reader.u8() };
}

/** `PetTameFailure` in SharedDefines.h. The enum starts at one; there is no zero. */
export function parsePetTameFailure(payload: Uint8Array): number {
  const reader = new PacketReader(payload);
  const result = reader.u8();
  reader.assertFinished();
  return result;
}

export interface PetName {
  petNumber: number;
  name: string;
  /** Unix seconds when the pet was last renamed; zero for one that never was. */
  timestamp: number;
  /** Empty unless the pet carries declined forms, and then always five of them. */
  declined: string[];
}

/**
 * No guid anywhere: the pet number is the only correlator, which is why the request carries it.
 *
 * A pet the server cannot see answers with the same shape and an empty name, so no special case is
 * needed as long as the name is read as a string rather than assumed non-empty.
 */
export function parsePetNameQueryResponse(payload: Uint8Array): PetName {
  const reader = new PacketReader(payload);
  const petNumber = reader.u32();
  const name = reader.cString();
  const timestamp = reader.u32();
  const declined: string[] = [];
  if (reader.u8() !== 0) {
    for (let index = 0; index < DECLINED_NAME_CASES; index++) declined.push(reader.cString());
  }
  reader.assertFinished();
  return { petNumber, name, timestamp, declined };
}

export interface PetNameRejected {
  /** `PetNameInvalidReason` in SharedDefines.h — a plain enum, carried as a full word. */
  error: number;
  name: string;
  declined: string[];
}

/** In practice the declined block only arrives on the one error that is about declined names. */
export function parsePetNameInvalid(payload: Uint8Array): PetNameRejected {
  const reader = new PacketReader(payload);
  const error = reader.u32();
  const name = reader.cString();
  const declined: string[] = [];
  if (reader.u8() !== 0) {
    for (let index = 0; index < DECLINED_NAME_CASES; index++) declined.push(reader.cString());
  }
  reader.assertFinished();
  return { error, name, declined };
}

/** Pressing a button on the pet bar: the word from that slot, and whatever it should act on. */
export function buildPetAction(petGuid: bigint, packed: number, targetGuid = 0n): Uint8Array {
  return new PacketWriter().u64(petGuid).u32(packed).u64(targetGuid).toUint8Array();
}

/**
 * Moving a button, or clearing one. The count is not on the wire — the server infers it from the
 * body length, so one pair is sixteen bytes and a swap is exactly twenty-four. Any other length is
 * read as one pair and a short body throws on the server.
 *
 * A command or reaction button may be moved but never removed, and on a swap the server checks
 * both words against what it believes is in those slots, so both must be the real current contents.
 */
export function buildPetSetAction(petGuid: bigint, slot: number, packed: number): Uint8Array {
  if (slot < 0 || slot >= PET_ACTION_BAR_SIZE) throw new RangeError(`Pet action slot ${slot} is out of range`);
  return new PacketWriter().u64(petGuid).u32(slot).u32(packed).toUint8Array();
}

export function buildPetSwapAction(
  petGuid: bigint,
  firstSlot: number,
  firstPacked: number,
  secondSlot: number,
  secondPacked: number,
): Uint8Array {
  if (firstSlot < 0 || firstSlot >= PET_ACTION_BAR_SIZE) throw new RangeError(`Pet action slot ${firstSlot} is out of range`);
  if (secondSlot < 0 || secondSlot >= PET_ACTION_BAR_SIZE) throw new RangeError(`Pet action slot ${secondSlot} is out of range`);
  return new PacketWriter()
    .u64(petGuid)
    .u32(firstSlot).u32(firstPacked)
    .u32(secondSlot).u32(secondPacked)
    .toUint8Array();
}

/**
 * The server reads this byte as a signed char and tests it against zero, so 0x80 and above mean
 * *off* — the idiomatic 0xFF would turn autocast off while looking like "on".
 */
export function buildPetSpellAutocast(petGuid: bigint, spellId: number, enabled: boolean): Uint8Array {
  return new PacketWriter().u64(petGuid).u32(spellId).u8(enabled ? 1 : 0).toUint8Array();
}

export function buildPetCancelAura(petGuid: bigint, spellId: number): Uint8Array {
  return new PacketWriter().u64(petGuid).u32(spellId).toUint8Array();
}

/** "Send me the pet bar again." The server picks the right variant and answers with a full one. */
export function buildRequestPetInfo(): Uint8Array {
  return new Uint8Array(0);
}

export function buildPetStopAttack(petGuid: bigint): Uint8Array {
  return new PacketWriter().u64(petGuid).toUint8Array();
}

export function buildPetAbandon(petGuid: bigint): Uint8Array {
  return new PacketWriter().u64(petGuid).toUint8Array();
}

export function buildDismissCritter(critterGuid: bigint): Uint8Array {
  return new PacketWriter().u64(critterGuid).toUint8Array();
}

/** The number comes before the guid here, which is the reverse of every other query. */
export function buildPetNameQuery(petNumber: number, petGuid: bigint): Uint8Array {
  return new PacketWriter().u32(petNumber).u64(petGuid).toUint8Array();
}

/**
 * Renaming is not atomic on the server: it sets the name before it reads the declined forms, so a
 * rejected declined block still leaves the new name in place.
 */
export function buildPetRename(petGuid: bigint, name: string, declined?: readonly string[]): Uint8Array {
  const writer = new PacketWriter().u64(petGuid).cString(name);
  if (!declined || declined.length === 0) return writer.u8(0).toUint8Array();
  if (declined.length !== DECLINED_NAME_CASES) {
    throw new RangeError(`A declined pet name is exactly ${DECLINED_NAME_CASES} forms`);
  }
  writer.u8(1);
  for (const form of declined) writer.cString(form);
  return writer.toUint8Array();
}

const TAME_FAILURES: Record<number, string> = {
  1: "Это существо нельзя приручить",
  2: "У вас уже слишком много питомцев",
  3: "У существа уже есть хозяин",
  4: "Существо не приручается",
  5: "У вас уже есть призванный спутник",
  6: "Это существо нельзя приручить",
  7: "Нет свободного места для питомца",
  8: "Внутренняя ошибка",
  9: "Существо слишком высокого уровня",
  10: "Существо мертво",
  11: "Существо живо",
  12: "Нужна специализация «Повелитель зверей»",
  13: "Неизвестная ошибка",
};

export function petTameFailureText(result: number): string {
  return TAME_FAILURES[result] ?? `Приручение не удалось (код ${result})`;
}

const FEEDBACK_TEXT: Record<number, string> = {
  1: "Питомец мёртв",
  2: "Питомцу некого атаковать",
  3: "Питомец не может атаковать эту цель",
};

export function petFeedbackText(feedback: number): string {
  return FEEDBACK_TEXT[feedback] ?? `Питомец: код ${feedback}`;
}

// `PetNameInvalidReason` in SharedDefines.h. The numbering has gaps at 5, 9 and 10.
const NAME_ERRORS: Record<number, string> = {
  1: "Недопустимое имя",
  2: "Имя не указано",
  3: "Имя слишком короткое",
  4: "Имя слишком длинное",
  6: "Смешение языков в имени",
  7: "Недопустимое имя",
  8: "Это имя зарезервировано",
  11: "Три одинаковые буквы подряд",
  12: "Недопустимый пробел",
  13: "Два пробела подряд",
  14: "Подряд идущие мягкие знаки",
  15: "Мягкий знак в начале или в конце",
  16: "Склонения не совпадают с именем",
};

export function petNameErrorText(error: number): string {
  return NAME_ERRORS[error] ?? `Имя питомца отклонено (код ${error})`;
}

export function petCommandText(command: number): string {
  switch (command) {
    case COMMAND_STAY: return "Ждать";
    case COMMAND_FOLLOW: return "Следовать";
    case COMMAND_ATTACK: return "Атаковать";
    case COMMAND_ABANDON: return "Отпустить";
    default: return `Команда ${command}`;
  }
}

export function petReactText(react: number): string {
  switch (react) {
    case REACT_PASSIVE: return "Пассивно";
    case REACT_DEFENSIVE: return "Защита";
    case REACT_AGGRESSIVE: return "Агрессия";
    default: return `Поведение ${react}`;
  }
}
