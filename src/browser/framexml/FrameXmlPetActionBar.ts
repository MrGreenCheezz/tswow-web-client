import {
  ACT_COMMAND, ACT_DISABLED, ACT_ENABLED, ACT_PASSIVE, ACT_REACTION,
  COMMAND_ABANDON, COMMAND_ATTACK, COMMAND_FOLLOW, COMMAND_STAY,
  PET_ACTION_BAR_SIZE, REACT_AGGRESSIVE, REACT_DEFENSIVE, REACT_PASSIVE,
  petActionOf, petActionTypeOf,
} from "../../world/PetProtocol.js";
import { spellChatLink } from "../ui/ChatLink.js";
import type { FrameXmlSeamBinding, FrameXmlWorldSeam } from "./FrameXmlWorldSeam.js";

/**
 * The stock pet action bar: PetActionBarFrame.xml/.lua (stock TOC, loaded in the vertical because
 * BonusActionBarFrame's stance layout calls its ShowPetActionBar) and the pet commands the rest of
 * the corpus calls. Measured call sites in the 3.3.5 corpus:
 *
 * * PetActionBarFrame.lua:29-313 — `PetHasActionBar`, `GetPetActionInfo`, `IsPetAttackAction`,
 *   `GetPetActionSlotUsable`, `GetPetActionCooldown`, `CastPetAction`, `TogglePetAutocast`,
 *   `PickupPetAction` (FrameXmlCursor.ts), and the events PET_BAR_UPDATE, PET_BAR_UPDATE_COOLDOWN,
 *   PET_BAR_UPDATE_USABLE, PET_BAR_SHOWGRID/HIDEGRID; UNIT_PET is the seam's own.
 * * SecureTemplates.lua:319 — `CastPetAction(action, unit)`, the secure "pet" button type.
 * * ChatFrame.lua:1337-1374 — /petattack (`PetAttack(target)`), /petfollow, /petstay, /petpassive,
 *   /petdefensive, /petaggressive; Bindings.xml:593 — the PETATTACK key (`PetAttack()`).
 * * UnitPopup.lua:808, :1274 — `PetCanBeDismissed()`, `PetDismiss()` on the pet's menu.
 * * FloatingChatFrame.lua:1684 — `PetHasActionBar()` for the chat frame's default height.
 *
 * The bar is `SMSG_PET_SPELLS`' ten words (PetProtocol.ts): commands in slots 0-2 and reactions in
 * 7-9 (`CharmInfo::InitPetActionBar`, Unit.cpp:10485), spells in 3-6, an empty spell slot being
 * action 0 with ACT_PASSIVE rather than a zero word. `GetPetActionInfo` answers a command or a
 * reaction as a token — the global string and texture *names* the stock Lua resolves through `_G`
 * (PetActionBarFrame.lua:111-117): PET_ACTION_ATTACK/FOLLOW/WAIT/DISMISS and PET_MODE_PASSIVE/
 * DEFENSIVE/AGGRESSIVE, whose words are GlobalStrings.lua:5615-5640, with the PET_*_TEXTURE
 * constants of PetActionBarFrame.lua:6-12.
 *
 * Nothing answers a command, a reaction or an autocast toggle — `HandlePetActionHelper` and
 * `HandlePetSpellAutocastOpcode` (PetHandler.cpp) change the server's CharmInfo and send no packet —
 * so a host keeps the pressed command and reaction itself, from the last SMSG_PET_SPELLS on, the
 * way `WorldClient.swapPetActionSlots` keeps a moved button. Attack is the exception: it sets no
 * command state, and its button shows the pet's own melee, SMSG_ATTACK_START until SMSG_ATTACK_STOP.
 *
 * This file is the contract and the C-API table; FrameXmlPetActionBarLive.ts answers it over the
 * WorldClient and FrameXmlPetActionBarCanned.ts over the scripted offline pet.
 */

/** `NUM_PET_ACTION_SLOTS` (PetActionBarFrame.lua:4), the core's `MAX_UNIT_ACTION_BAR_INDEX`. */
export const FRAMEXML_PET_ACTION_SLOTS = PET_ACTION_BAR_SIZE;

/** The pet bar's events this contract fires, beside the seam's UNIT_PET. */
export const FRAMEXML_PET_ACTION_EVENTS = Object.freeze({
  update: "PET_BAR_UPDATE",
  cooldown: "PET_BAR_UPDATE_COOLDOWN",
  /**
   * The pet book's SpellButtons redraw their sweep on SPELL_UPDATE_COOLDOWN and PET_BAR_UPDATE only
   * (SpellBookFrame.lua:295-306), never on PET_BAR_UPDATE_COOLDOWN, so a pet timer raises both.
   */
  spellCooldown: "SPELL_UPDATE_COOLDOWN",
  usable: "PET_BAR_UPDATE_USABLE",
  showGrid: "PET_BAR_SHOWGRID",
  hideGrid: "PET_BAR_HIDEGRID",
});

/** `GetPetActionInfo`'s seven values (PetActionBarFrame.lua:110). */
export type FrameXmlPetActionInfo = readonly [
  name: string, subtext: string | undefined, texture: string | undefined, isToken: boolean,
  isActive: boolean, autoCastAllowed: boolean, autoCastEnabled: boolean,
];

/** `GetPetActionCooldown`'s start (GetTime seconds), duration (seconds) and enable. */
export type FrameXmlPetActionCooldown = readonly [start: number, duration: number, enable: number];

/** An idle slot: the same `0, 0, 0` the seam's `GetActionCooldown` gives an idle action. */
export const FRAMEXML_PET_ACTION_IDLE_COOLDOWN: FrameXmlPetActionCooldown =
  Object.freeze([0, 0, 0]) as FrameXmlPetActionCooldown;

/** The commands the slash commands, the key binding and the unit menu reach without a bar slot. */
export type FrameXmlPetCommand =
  | "attack" | "stopattack" | "follow" | "wait" | "dismiss" | "passive" | "defensive" | "aggressive";

/** A command's or reaction's `[name, texture]` global names, by its CommandStates/ReactStates code. */
const COMMAND_TOKENS: Readonly<Record<number, readonly [string, string]>> = Object.freeze({
  [COMMAND_ATTACK]: ["PET_ACTION_ATTACK", "PET_ATTACK_TEXTURE"],
  [COMMAND_FOLLOW]: ["PET_ACTION_FOLLOW", "PET_FOLLOW_TEXTURE"],
  [COMMAND_STAY]: ["PET_ACTION_WAIT", "PET_WAIT_TEXTURE"],
  [COMMAND_ABANDON]: ["PET_ACTION_DISMISS", "PET_DISMISS_TEXTURE"],
});
const REACTION_TOKENS: Readonly<Record<number, readonly [string, string]>> = Object.freeze({
  [REACT_PASSIVE]: ["PET_MODE_PASSIVE", "PET_PASSIVE_TEXTURE"],
  [REACT_DEFENSIVE]: ["PET_MODE_DEFENSIVE", "PET_DEFENSIVE_TEXTURE"],
  [REACT_AGGRESSIVE]: ["PET_MODE_AGGRESSIVE", "PET_AGGRESSIVE_TEXTURE"],
});

/** The one state a bar's checked buttons are drawn from. */
export interface FrameXmlPetBarState {
  /** The last SMSG_PET_SPELLS command state, or the stay/follow pressed since. */
  readonly commandState: number;
  /** The last SMSG_PET_SPELLS react state, or the reaction pressed since. */
  readonly reactState: number;
  /** The pet's own melee: SMSG_ATTACK_START without its SMSG_ATTACK_STOP. */
  readonly attacking: boolean;
}

/** A spell's presentation; a host answers only from its cache. */
export interface FrameXmlPetActionSpell {
  readonly name: string;
  readonly rank?: string | undefined;
  readonly iconPath?: string | undefined;
}

/** The ACT_* states a spell word can carry (UnitDefines.h `ActiveStates`). */
export function frameXmlPetSpellWord(packed: number): boolean {
  const type = petActionTypeOf(packed);
  return petActionOf(packed) !== 0 && (type === ACT_PASSIVE || type === ACT_DISABLED || type === ACT_ENABLED);
}

/** Whether a word is the attack command, the one button the stock Lua flashes (`IsPetAttackAction`). */
export function frameXmlPetAttackWord(packed: number): boolean {
  return petActionTypeOf(packed) === ACT_COMMAND && petActionOf(packed) === COMMAND_ATTACK;
}

/**
 * `GetPetActionInfo` for one word. Nothing for an empty spell slot, an unknown code, or a spell whose
 * row this host has not cached yet — never a made-up name; the host fires PET_BAR_UPDATE when it lands.
 * A spell's autocast is allowed while its state is ACT_DISABLED or ACT_ENABLED and on under the
 * latter: `CharmInfo::AddSpellToActionBar` writes ACT_PASSIVE for a spell that cannot autocast.
 */
export function frameXmlPetActionInfo(
  packed: number,
  state: FrameXmlPetBarState,
  spell: (id: number) => FrameXmlPetActionSpell | undefined,
): FrameXmlPetActionInfo | undefined {
  const type = petActionTypeOf(packed);
  const action = petActionOf(packed);
  if (type === ACT_COMMAND) {
    const token = COMMAND_TOKENS[action];
    if (!token) return undefined;
    const active = action === COMMAND_ATTACK ? state.attacking : action === state.commandState;
    return [token[0], undefined, token[1], true, active, false, false];
  }
  if (type === ACT_REACTION) {
    const token = REACTION_TOKENS[action];
    return token ? [token[0], undefined, token[1], true, action === state.reactState, false, false] : undefined;
  }
  if (!frameXmlPetSpellWord(packed)) return undefined;
  const row = spell(action);
  if (!row || row.name.length === 0) return undefined;
  return [
    row.name, row.rank ? row.rank : undefined, row.iconPath ? row.iconPath : undefined, false, false,
    type !== ACT_PASSIVE, type === ACT_ENABLED,
  ];
}

/**
 * `HasPetSpells()`'s two values: the pet book's rows and the token SpellBookFrame_SetTabType turns
 * into the tab's title, `_G["PET_TYPE_"..token]` — GlobalStrings.lua:5650-5651 carry PET and DEMON.
 */
export interface FrameXmlPetBook {
  readonly count: number;
  readonly token: "PET" | "DEMON";
}

/** One pet book row as the stock book draws it: the spell, its ACT_* state and its cached presentation. */
export interface FrameXmlPetBookSpell extends FrameXmlPetActionSpell {
  readonly spellId: number;
  /** ACT_ENABLED/ACT_DISABLED: autocastable, on or off; ACT_PASSIVE: never autocast. */
  readonly state: number;
  /** The spell row's own passive flag — ACT_PASSIVE also marks a castable spell with no autocast. */
  readonly passive: boolean;
}

/** `CREATURE_TYPE_DEMON` (SharedDefines.h): a warlock's pet book is titled «Демон». */
export const FRAMEXML_CREATURE_TYPE_DEMON = 3;

/** A ready pet book spell: enabled, so SpellButton_UpdateButton draws it undimmed. */
export const FRAMEXML_PET_BOOK_READY_COOLDOWN: FrameXmlPetActionCooldown =
  Object.freeze([0, 0, 1]) as FrameXmlPetActionCooldown;

/** What the seam answers for the stock pet bar; every read is cache-only and cheap (the bar reads per update). */
export interface FrameXmlPetActionBar {
  /** `PetHasActionBar()`: a pet's (or a charmed unit's) bar — not a vehicle's or a possessed unit's. */
  hasActionBar(): boolean;
  /** `GetPetActionInfo(index)`, 1-based. */
  actionInfo(index: number): FrameXmlPetActionInfo | undefined;
  /** `IsPetAttackAction(index)`. */
  isAttackAction(index: number): boolean;
  /** `GetPetActionSlotUsable(index)`. */
  slotUsable(index: number): boolean;
  /** `GetPetActionCooldown(index)`. */
  cooldown(index: number): FrameXmlPetActionCooldown;
  /** `CastPetAction(index[, unit])`: the slot's word to the realm, a spell or command at `unit`. */
  castAction(index: number, unit?: string): void;
  /** `TogglePetAutocast(index)`: a right click on an autocastable spell. */
  toggleAutocast(index: number): void;
  /** The slash commands, the PETATTACK key and the unit menu's dismiss. */
  command(command: FrameXmlPetCommand, unit?: string): void;
  /** `PetCanBeDismissed()`: a pet the player owns that is not a hunter's (those are abandoned). */
  canBeDismissed(): boolean;
  /** `PickupPetAction` dropped on another slot: the two swap (both 1-based). */
  moveAction(from: number, to: number): void;
  /** The spell a slot holds, for GameTooltip:SetPetAction; nothing for a token or an empty slot. */
  spellAt(index: number): number | undefined;

  // ---- the pet's spellbook (SpellBookFrame with bookType "pet") --------------------------------

  /** `HasPetSpells()`: nothing without a pet book. */
  book(): FrameXmlPetBook | undefined;
  /** The 1-based pet book row; nothing past the end or while its spell row is not cached. */
  bookSpell(index: number): FrameXmlPetBookSpell | undefined;
  /** `GetSpellCooldown(slot, "pet")`: the pet's own timer, or ready (`0, 0, 1`). */
  bookCooldown(index: number): FrameXmlPetActionCooldown;
  /** `CastSpell(slot, "pet")`: the pet casts the row's spell at the current target. */
  castBookSpell(index: number): void;
  /** `ToggleSpellAutocast(slot, "pet")`: the book's right click on an autocastable spell. */
  toggleBookAutocast(index: number): void;
  /** A pet book spell dropped on bar slot `index` (1-based): CMSG_PET_SET_ACTION with its word. */
  placeSpell(index: number, spellId: number): void;
}

const NOTHING: readonly unknown[] = Object.freeze([]);

function indexOf(value: unknown): number {
  const index = Math.trunc(Number(value));
  return Number.isInteger(index) ? index : 0;
}

function unitOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value.toLowerCase() : undefined;
}

/** The pet book's own model when a spellbook call names it, as SpellBookFrame passes `bookType`. */
function petBook(seam: FrameXmlWorldSeam, bookType: unknown): FrameXmlPetActionBar | undefined {
  return typeof bookType === "string" && bookType.toLowerCase() === "pet" ? seam.petActions : undefined;
}

/**
 * The spellbook C API with its `"pet"` book answered by the pet model — `GetSpellName`,
 * `GetSpellTexture`, `GetSpellCooldown`, `GetSpellAutocast`, `IsPassiveSpell`, `IsSelectedSpell`,
 * `GetSpellLink`, `CastSpell`, `ToggleSpellAutocast` and `HasPetSpells` — and every other book
 * handed to the seam's own binding, unchanged. SpellBookFrame.lua passes `SpellBookFrame.bookType`
 * to each (:347-500), SpellBook_GetSpellID counts the pet book's slots plainly (:592-593), and the
 * book's tab appears once `HasPetSpells()` names a token (:127-131). The pet book is SMSG_PET_SPELLS'
 * spell list in the order the realm sent it; it is empty for a temporary pet and for any bar but a
 * pet's (FrameXmlPetActionBarLive.ts).
 */
export function frameXmlWithPetBook(
  bindings: Readonly<Record<string, FrameXmlSeamBinding>>,
): Record<string, FrameXmlSeamBinding> {
  const base = (name: string): FrameXmlSeamBinding => bindings[name] ?? (() => NOTHING);
  /** One book-typed name: the pet model for `"pet"`, the seam's binding otherwise. */
  const booked = (name: string, pet: (model: FrameXmlPetActionBar, index: number) => readonly unknown[]): FrameXmlSeamBinding =>
    (seam, args) => {
      const model = petBook(seam, args[1]);
      return model ? pet(model, indexOf(args[0])) : base(name)(seam, args);
    };
  return {
    ...bindings,
    HasPetSpells: (seam, args) => {
      const book = seam.petActions?.book();
      return book && book.count > 0 ? [book.count, book.token] : base("HasPetSpells")(seam, args);
    },
    GetSpellName: booked("GetSpellName", (model, index) => {
      const spell = model.bookSpell(index);
      return spell ? [spell.name, spell.rank ?? ""] : NOTHING;
    }),
    GetSpellTexture: booked("GetSpellTexture", (model, index) => {
      const icon = model.bookSpell(index)?.iconPath;
      return icon ? [icon] : NOTHING;
    }),
    GetSpellCooldown: booked("GetSpellCooldown", (model, index) =>
      model.bookSpell(index) ? model.bookCooldown(index) : FRAMEXML_PET_ACTION_IDLE_COOLDOWN),
    GetSpellAutocast: booked("GetSpellAutocast", (model, index) => {
      const state = model.bookSpell(index)?.state;
      return [state === ACT_ENABLED || state === ACT_DISABLED, state === ACT_ENABLED];
    }),
    IsPassiveSpell: booked("IsPassiveSpell", (model, index) => {
      const spell = model.bookSpell(index);
      return spell ? [spell.passive] : NOTHING;
    }),
    IsSelectedSpell: booked("IsSelectedSpell", () => [false]),
    GetSpellLink: (seam, args) => {
      const model = typeof args[0] === "number" ? petBook(seam, args[1]) : undefined;
      if (!model) return base("GetSpellLink")(seam, args);
      const spell = model.bookSpell(indexOf(args[0]));
      return spell ? [spellChatLink(spell.spellId, spell.name)] : NOTHING;
    },
    CastSpell: booked("CastSpell", (model, index) => {
      model.castBookSpell(index);
      return NOTHING;
    }),
    // Only the pet book has autocast; the player's own book has nothing to toggle.
    ToggleSpellAutocast: (seam, args) => {
      petBook(seam, args[1])?.toggleBookAutocast(indexOf(args[0]));
      return NOTHING;
    },
  };
}

/** The pet-bar C API, answered by `seam.petActions`; a seam without the model keeps the neutral answers' shapes. */
export const FRAMEXML_PET_ACTION_BINDINGS: Readonly<Record<string, FrameXmlSeamBinding>> = Object.freeze({
  PetHasActionBar: (seam) => [seam.petActions?.hasActionBar() ?? false],
  GetPetActionInfo: (seam, args) => seam.petActions?.actionInfo(indexOf(args[0])) ?? NOTHING,
  IsPetAttackAction: (seam, args) => [seam.petActions?.isAttackAction(indexOf(args[0])) ?? false],
  GetPetActionSlotUsable: (seam, args) => [seam.petActions?.slotUsable(indexOf(args[0])) ?? false],
  GetPetActionCooldown: (seam, args) =>
    seam.petActions?.cooldown(indexOf(args[0])) ?? FRAMEXML_PET_ACTION_IDLE_COOLDOWN,
  CastPetAction: (seam, args) => {
    seam.petActions?.castAction(indexOf(args[0]), unitOf(args[1]));
    return NOTHING;
  },
  TogglePetAutocast: (seam, args) => {
    seam.petActions?.toggleAutocast(indexOf(args[0]));
    return NOTHING;
  },
  // ChatFrame.lua:1337: the slash command hands its target (or "" for the current one) through.
  PetAttack: (seam, args) => {
    seam.petActions?.command("attack", unitOf(args[0]));
    return NOTHING;
  },
  PetStopAttack: (seam) => {
    seam.petActions?.command("stopattack");
    return NOTHING;
  },
  PetFollow: (seam) => {
    seam.petActions?.command("follow");
    return NOTHING;
  },
  PetWait: (seam) => {
    seam.petActions?.command("wait");
    return NOTHING;
  },
  PetPassiveMode: (seam) => {
    seam.petActions?.command("passive");
    return NOTHING;
  },
  PetDefensiveMode: (seam) => {
    seam.petActions?.command("defensive");
    return NOTHING;
  },
  PetAggressiveMode: (seam) => {
    seam.petActions?.command("aggressive");
    return NOTHING;
  },
  PetDismiss: (seam) => {
    seam.petActions?.command("dismiss");
    return NOTHING;
  },
  PetCanBeDismissed: (seam) => [seam.petActions?.canBeDismissed() ?? false],
});
