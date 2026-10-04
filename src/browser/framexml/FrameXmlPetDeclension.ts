/**
 * L17 3.09: the ruRU pet name declension — stock LocalizationPost.xml's DeclensionFrame and the three
 * C functions it and the rename popup call, as Wow.exe 12340 answers them.
 *
 * * `GetNumDeclensionSets(name, sex)` (0x00511dd0) and `DeclineName(name, sex, set)` (0x00511e80) are the
 *   FrameXML twins of the glue pair GlueApi.ts binds: the sex is a `UnitSex` value looked up in
 *   `{2, 3, 1}` (0x9fe7ec), anything else neutral, the set 1-based. Both go through a locale gate
 *   (0x0076dd40 / 0x0076dd60: only locale index 8, ruRU, reaches the rule engine 0x76e2b0 / 0x76e330):
 *   any other locale answers 0 sets and five nils.
 * * `PetRename(name [, genitive, dative, accusative, instrumental, prepositional])` (0x005d5670), in its
 *   order: no current pet object — UI error ERR_NO_PET; the pet's UNIT_FIELD_SUMMONEDBY is not the
 *   player — ERR_NOTYOURPET; the pet flags byte (UNIT_FIELD_BYTES_2 byte 2) without
 *   UNIT_CAN_BE_RENAMED — ERR_PET_NOT_RENAMEABLE; an empty name — ERR_NAME_NO_NAME (0x005218c0(2)).
 *   Then, when declensions apply to the name (0x0076dd20: a ruRU client and a Cyrillic first letter,
 *   0x76e270), the five forms are read from arguments 2-6 up to the first missing or empty one: all
 *   five send `CMSG_PET_RENAME` with the declined block (0x005d4a00), fewer fire
 *   PET_FORCE_NAME_DECLENSION (event 0x252) with the name — that is what opens DeclensionFrame after
 *   the stock rename popup. Any other name is sent without a declined block.
 * * `SMSG_PET_NAME_INVALID` (case 0x178 of the packet switch that fires 0x252 at 0x006e3038): the error goes to the UI errors
 *   (0x005218c0 maps `PetNameInvalidReason` onto ERR_NAME_*), then, when the packet carries a
 *   declined block, PET_FORCE_NAME_DECLENSION fires with the name and the server's five forms —
 *   the frame opens again with them (DeclensionFrame_OnEvent's `declensions`).
 *
 * 0x00589212, the third site an earlier note listed for 0x252, is `0x005216f0(0x252)`: the UI error
 * ERR_LOOT_CANT_LOOT_THAT, another number space. Renaming is permanent on the server
 * (PetHandler.cpp HandlePetRename clears UNIT_CAN_BE_RENAMED), so nothing here sends without the
 * stock confirm path: the rename popup's accept or DeclensionFrame's «ОК».
 *
 * Before the declension step the name passes the client's own check (0x007e1f00, `frameXmlPetNameReason`);
 * a refusal is its UI error (0x005218c0) and nothing is sent. SMSG_PET_NAME_INVALID's own text is the
 * native notice's (EnterWorld.ts PET_MESSAGE), so the UI error of that packet is not repeated here.
 */
import { globalString } from "../../generated/globalStrings.js";
import { RESPONSE_CODES } from "../../generated/responseCodes.js";
import { checkCharacterName, NAME_ALPHABET_CJK, nameAlphabet } from "../glue/GlueNameRules.js";
import { readByte, readGuidAt } from "../../world/Fields.js";
import type { PetNameRejected } from "../../world/PetProtocol.js";
import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import type { WorldObjectState } from "../../world/WorldState.js";
import {
  frameXmlLuaDeclensionSetCount, frameXmlLuaDeclineName,
} from "../ui/framexml_compat/FrameXmlDeclension.js";
import { FRAMEXML_COMPANION_BINDINGS, type FrameXmlCompanionSeam } from "./FrameXmlCompanions.js";
import type { FrameXmlSeamPump } from "./FrameXmlWorldSeam.js";

/** Event 0x252 of the event-name table at 0x00c24eb0. */
export const FRAMEXML_PET_FORCE_NAME_DECLENSION = "PET_FORCE_NAME_DECLENSION";
/** Genitive, dative, accusative, instrumental, prepositional (`MAX_DECLINED_NAME_CASES`). */
export const FRAMEXML_DECLINED_NAME_CASES = 5;
/** The pet flags byte's UNIT_CAN_BE_RENAMED (UnitDefines.h `UNIT_PET_FLAG_CAN_BE_RENAMED`). */
const UNIT_CAN_BE_RENAMED = 0x01;
const TYPEID_UNIT = 3;
const TYPEID_PLAYER = 4;
const NOTHING: readonly [] = Object.freeze([]);
const NO_FORMS: readonly undefined[] = Object.freeze([undefined, undefined, undefined, undefined, undefined]);

/** 0x76e270: a word that opens with a letter of U+0400–U+04FF. */
function cyrillicFirst(name: string): boolean {
  const first = name.charCodeAt(0);
  return first >= 0x400 && first <= 0x4ff;
}

/** 0x0076dd20: declensions apply only on a ruRU client (locale index 8) to a Cyrillic name. */
export function frameXmlPetDeclensionsApply(locale: string | undefined, name: string): boolean {
  return locale === "ruRU" && cyrillicFirst(name);
}

/** `lua_tostring` of one argument: strings as they are, numbers in Lua's own spelling, else none. */
function luaString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

/**
 * 0x007e1f00: the client's own check of a pet name before PetRename sends it — 0x007e18c0 with no extra
 * characters (no space, no apostrophe), as the character check (0x007e1e90, glue/GlueNameRules.ts) runs
 * it, whose ResponseCodes are this reason plus 87; only the length differs: 12 letters, 8 in Hangul and in
 * CJK alike (the character check allows CJK 6). The name and profanity patterns are the realm's to check
 * (no route serves NamesReserved/NamesProfanity). Answers the `PetNameInvalidReason`, 0 for a good name.
 */
export function frameXmlPetNameReason(name: string): number {
  const code = checkCharacterName(name);
  if (code === RESPONSE_CODES.CHAR_NAME_TOO_LONG && nameAlphabet(name) === NAME_ALPHABET_CJK && name.length <= 8) return 0;
  return code - RESPONSE_CODES.CHAR_NAME_SUCCESS;
}

/** 0x005218c0: a `PetNameInvalidReason` as its UI error; anything unlisted is ERR_NAME_INVALID. */
const PET_NAME_ERRORS: Readonly<Record<number, string>> = Object.freeze({
  2: "ERR_NAME_NO_NAME", 3: "ERR_NAME_TOO_SHORT", 4: "ERR_NAME_TOO_LONG", 6: "ERR_NAME_MIXED_LANGUAGES",
  7: "ERR_NAME_PROFANE", 8: "ERR_NAME_RESERVED", 11: "ERR_NAME_THREE_CONSECUTIVE", 12: "ERR_NAME_INVALID_SPACE",
  13: "ERR_NAME_CONSECUTIVE_SPACES", 14: "ERR_NAME_RUSSIAN_CONSECUTIVE_SILENT_CHARACTERS",
  15: "ERR_NAME_RUSSIAN_SILENT_CHARACTER_AT_BEGINNING_OR_END", 16: "ERR_NAME_DECLENSION_DOESNT_MATCH_BASE_NAME",
});

export function frameXmlPetNameError(reason: number): string {
  return PET_NAME_ERRORS[reason] ?? "ERR_NAME_INVALID";
}

/** What `PetRename` and the packet hook read of the world. */
export interface FrameXmlPetDeclensionWorld {
  readonly state: { readonly selfGuid?: bigint | undefined; readonly objects: ReadonlyMap<bigint, WorldObjectState> };
  /** SMSG_PET_SPELLS' pet: the client's current pet (0x00c23500). */
  readonly petSpells?: { readonly guid: bigint } | undefined;
  renamePet?(name: string, declined?: readonly string[]): void;
  /** L17 3.09: WorldClient's SMSG_PET_NAME_INVALID hook. */
  onPetNameInvalid?: ((rejected: PetNameRejected) => void) | undefined;
}

export interface FrameXmlPetDeclensionOptions {
  readonly world: () => FrameXmlPetDeclensionWorld | undefined;
  readonly locale: () => string | undefined;
}

/** PetRename's checks and send, and the packet's re-opening of the frame. */
export class FrameXmlPetDeclensionModel {
  readonly #options: FrameXmlPetDeclensionOptions;
  #pump: FrameXmlSeamPump | undefined;
  #hooked: FrameXmlPetDeclensionWorld | undefined;
  #hook: ((rejected: PetNameRejected) => void) | undefined;
  #previous: ((rejected: PetNameRejected) => void) | undefined;

  constructor(options: FrameXmlPetDeclensionOptions) {
    this.#options = options;
  }

  /** The client locale the declension gate reads (0x0076dd20/40/60 compare it with ruRU). */
  locale(): string | undefined {
    return this.#options.locale();
  }

  /** Takes the world's SMSG_PET_NAME_INVALID hook, keeping whichever listener held it before. */
  attach(pump: FrameXmlSeamPump): void {
    this.detach();
    this.#pump = pump;
    const world = this.#options.world();
    if (!world) return;
    const previous = world.onPetNameInvalid;
    const hook = (rejected: PetNameRejected): void => {
      try { previous?.(rejected); } finally { this.nameInvalid(rejected); }
    };
    world.onPetNameInvalid = hook;
    this.#hooked = world;
    this.#hook = hook;
    this.#previous = previous;
  }

  detach(): void {
    if (this.#hooked && this.#hooked.onPetNameInvalid === this.#hook) this.#hooked.onPetNameInvalid = this.#previous;
    this.#hooked = undefined;
    this.#hook = undefined;
    this.#previous = undefined;
    this.#pump = undefined;
  }

  /** `PetRename(name, ...)`, 0x005d5670. */
  rename(args: readonly unknown[]): void {
    const world = this.#options.world();
    const guid = world?.petSpells?.guid;
    const pet = world && guid !== undefined && guid !== 0n ? world.state.objects.get(guid) : undefined;
    if (!world || !pet || (pet.typeId !== TYPEID_UNIT && pet.typeId !== TYPEID_PLAYER)) {
      this.#error("ERR_NO_PET");
      return;
    }
    const owner = readGuidAt(pet, UPDATE_FIELDS.UNIT_FIELD_SUMMONEDBY.offset) ?? 0n;
    if (world.state.selfGuid === undefined || owner !== world.state.selfGuid) {
      this.#error("ERR_NOTYOURPET");
      return;
    }
    if (((readByte(pet, "UNIT_FIELD_BYTES_2", 2) ?? 0) & UNIT_CAN_BE_RENAMED) === 0) {
      this.#error("ERR_PET_NOT_RENAMEABLE");
      return;
    }
    const name = luaString(args[0]);
    if (name === undefined || name.length === 0) {
      this.#error("ERR_NAME_NO_NAME");
      return;
    }
    const reason = frameXmlPetNameReason(name);
    if (reason !== 0) {
      this.#error(frameXmlPetNameError(reason));
      return;
    }
    if (!frameXmlPetDeclensionsApply(this.#options.locale(), name)) {
      world.renamePet?.(name);
      return;
    }
    const declined: string[] = [];
    for (let index = 1; index <= FRAMEXML_DECLINED_NAME_CASES; index += 1) {
      const form = luaString(args[index]);
      if (form === undefined || form.length === 0) break;
      declined.push(form);
    }
    if (declined.length === FRAMEXML_DECLINED_NAME_CASES) {
      world.renamePet?.(name, declined);
      return;
    }
    this.#pump?.fire(FRAMEXML_PET_FORCE_NAME_DECLENSION, name);
  }

  /** SMSG_PET_NAME_INVALID: with the server's declined block, the frame again with its forms. */
  nameInvalid(rejected: PetNameRejected): void {
    if (rejected.declined.length !== FRAMEXML_DECLINED_NAME_CASES) return;
    this.#pump?.fire(FRAMEXML_PET_FORCE_NAME_DECLENSION, rejected.name, ...rejected.declined);
  }

  #error(name: string): void {
    this.#pump?.fire("UI_ERROR_MESSAGE", globalString(name) ?? name);
  }
}

/** The part of the world seam these bindings read. */
export type FrameXmlPetDeclensionSeam = FrameXmlCompanionSeam & {
  readonly locale?: string | undefined;
  readonly petDeclension?: FrameXmlPetDeclensionModel | undefined;
};

type Binding = (seam: FrameXmlPetDeclensionSeam, args: readonly unknown[]) => readonly unknown[];

/** The seam's client locale, or the model's for a seam that has none; unknown is not ruRU. */
function russian(seam: FrameXmlPetDeclensionSeam): boolean {
  return (seam.locale ?? seam.petDeclension?.locale()) === "ruRU";
}

function nameArgument(value: unknown): string {
  return luaString(value) ?? "";
}

/**
 * Spread into FRAMEXML_SEAM_BINDINGS after the companion bindings, so `PetRename` is this one: a seam
 * without the model (a canned one) keeps the companion binding's plain send.
 */
export const FRAMEXML_PET_DECLENSION_BINDINGS: Readonly<Record<string, Binding>> = Object.freeze({
  GetNumDeclensionSets: (seam, args) => [russian(seam)
    ? frameXmlLuaDeclensionSetCount(nameArgument(args[0]), args[1]) : 0],
  DeclineName: (seam, args) => (russian(seam)
    ? frameXmlLuaDeclineName(nameArgument(args[0]), args[1], args[2]) : NO_FORMS),
  PetRename: (seam, args) => {
    if (seam.petDeclension) seam.petDeclension.rename(args);
    else FRAMEXML_COMPANION_BINDINGS.PetRename!(seam, args);
    return NOTHING;
  },
});
