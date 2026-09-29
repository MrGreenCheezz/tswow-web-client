import {
  ACT_COMMAND, ACT_DISABLED, ACT_ENABLED, ACT_PASSIVE, ACT_REACTION,
  COMMAND_ATTACK, COMMAND_FOLLOW, COMMAND_STAY, REACT_AGGRESSIVE, REACT_DEFENSIVE, REACT_PASSIVE,
  packPetAction, petActionOf, petActionTypeOf,
} from "../../world/PetProtocol.js";
import {
  FRAMEXML_PET_ACTION_EVENTS, FRAMEXML_PET_ACTION_IDLE_COOLDOWN, FRAMEXML_PET_ACTION_SLOTS,
  FRAMEXML_PET_BOOK_READY_COOLDOWN, frameXmlPetActionInfo, frameXmlPetAttackWord, frameXmlPetSpellWord,
  type FrameXmlPetActionBar, type FrameXmlPetActionCooldown, type FrameXmlPetActionInfo,
  type FrameXmlPetActionSpell, type FrameXmlPetBook, type FrameXmlPetBookSpell, type FrameXmlPetCommand,
} from "./FrameXmlPetActionBar.js";
import type { FrameXmlSeamPump } from "./FrameXmlWorldSeam.js";

/**
 * The offline pet bar for the canned world: a hunter's wolf with the core's default layout
 * (`CharmInfo::InitPetActionBar`: attack, follow, stay; four spell slots; aggressive, defensive,
 * passive) and three measured spells, plus a stand-in realm that answers a press the way the core
 * does — a stay/follow/reaction changes the held state, attack starts the pet's swing, a spell with
 * a recovery starts its cooldown — so PetActionBarFrame can be driven with no server.
 *
 * The bar starts dismissed: the canned PetFrame has shown a pet since before this bar existed, and
 * the vertical tests measure the default HUD's layout, which a shown pet bar moves
 * (UIParent_ManageFramePositions). `petActionWorld.summon()` brings it up.
 */

export interface CannedPetActionSpell extends FrameXmlPetActionSpell {
  readonly id: number;
  /** `RecoveryTime` or `CategoryRecoveryTime`, whichever is longer, in milliseconds. */
  readonly cooldownMs: number;
  /** `SPELL_ATTR0_PASSIVE` (0x40) on the row. */
  readonly passive: boolean;
}

/**
 * Measured (tools/dbc.mjs over the configured dataset's Spell.dbc/SpellIcon.dbc, 2026-09-28):
 * Name_lang, NameSubtext_lang, the icon's TextureFilename, the two recovery times and the passive
 * bit — «Рефлексы кобры» (61682) is the wolf's passive talent, Attributes 0x150.
 */
export const CANNED_PET_ACTION_SPELLS: readonly CannedPetActionSpell[] = Object.freeze([
  Object.freeze({ id: 17253, name: "Укус", rank: "Уровень 1", iconPath: "Interface\\Icons\\Ability_Druid_FerociousBite", cooldownMs: 0, passive: false }),
  Object.freeze({ id: 2649, name: "Рык", rank: "Уровень 1", iconPath: "Interface\\Icons\\Ability_Physical_Taunt", cooldownMs: 5000, passive: false }),
  Object.freeze({ id: 24604, name: "Неистовый вой", rank: "Уровень 1", iconPath: "Interface\\Icons\\Ability_Hunter_Pet_Wolf", cooldownMs: 40000, passive: false }),
  Object.freeze({ id: 61682, name: "Рефлексы кобры", rank: "Уровень 1", iconPath: "Interface\\Icons\\Spell_Nature_GuardianWard", cooldownMs: 0, passive: true }),
]);

/** The wolf's book as the stand-in realm's SMSG_PET_SPELLS lists it: the three bar spells and the passive. */
export const CANNED_PET_BOOK: readonly { readonly spellId: number; readonly state: number }[] = Object.freeze([
  Object.freeze({ spellId: 17253, state: ACT_ENABLED }),
  Object.freeze({ spellId: 2649, state: ACT_ENABLED }),
  Object.freeze({ spellId: 24604, state: ACT_DISABLED }),
  Object.freeze({ spellId: 61682, state: ACT_PASSIVE }),
]);

/** The ten words the stand-in realm sends: bite and growl on autocast, the howl off, one empty slot. */
export const CANNED_PET_ACTION_BAR: readonly number[] = Object.freeze([
  packPetAction(COMMAND_ATTACK, ACT_COMMAND),
  packPetAction(COMMAND_FOLLOW, ACT_COMMAND),
  packPetAction(COMMAND_STAY, ACT_COMMAND),
  packPetAction(17253, ACT_ENABLED),
  packPetAction(2649, ACT_ENABLED),
  packPetAction(24604, ACT_DISABLED),
  packPetAction(0, ACT_PASSIVE),
  packPetAction(REACT_AGGRESSIVE, ACT_REACTION),
  packPetAction(REACT_DEFENSIVE, ACT_REACTION),
  packPetAction(REACT_PASSIVE, ACT_REACTION),
]);

export type CannedPetActionRequest =
  | readonly ["action", number, number, string | undefined]
  | readonly ["autocast", number, boolean]
  | readonly ["swap", number, number]
  | readonly ["command", FrameXmlPetCommand, string | undefined]
  | readonly ["book", number]
  | readonly ["place", number, number];

export interface CannedFrameXmlPetActionWorld {
  /** What the stand-in realm was asked, in order. */
  readonly sent: readonly CannedPetActionRequest[];
  /** The ten words as they stand now. */
  bar(): readonly number[];
  /** SMSG_PET_SPELLS for the wolf: the default bar, follow and defensive; PET_BAR_UPDATE. */
  summon(): void;
  /** The bare zero-guid SMSG_PET_SPELLS: the bar goes; PET_BAR_UPDATE. */
  dismiss(): void;
  /** SMSG_ATTACK_START / SMSG_ATTACK_STOP naming the pet. */
  setAttacking(attacking: boolean): void;
  /** A spell the pet cannot afford or cast now; PET_BAR_UPDATE_USABLE. */
  setUsable(spellId: number, usable: boolean): void;
}

export interface CannedFrameXmlPetActionBar {
  readonly model: CannedFrameXmlPetActionBarModel;
  readonly world: CannedFrameXmlPetActionWorld;
}

export class CannedFrameXmlPetActionBarModel implements FrameXmlPetActionBar {
  #pump: FrameXmlSeamPump | undefined;
  #present = false;
  readonly #bar: number[] = [...CANNED_PET_ACTION_BAR];
  readonly #book: { spellId: number; state: number }[] = CANNED_PET_BOOK.map((entry) => ({ ...entry }));
  #commandState = COMMAND_FOLLOW;
  #reactState = REACT_DEFENSIVE;
  #attacking = false;
  readonly #unusable = new Set<number>();
  /** Cooldowns by spell, in GetTime seconds. */
  readonly #cooldowns = new Map<number, { start: number; duration: number }>();
  readonly sent: CannedPetActionRequest[] = [];

  attach(pump: FrameXmlSeamPump): void {
    this.#pump = pump;
  }

  detach(): void {
    this.#pump = undefined;
  }

  // ---- the stand-in realm ------------------------------------------------------------------

  summon(): void {
    this.#present = true;
    this.#bar.splice(0, this.#bar.length, ...CANNED_PET_ACTION_BAR);
    this.#book.splice(0, this.#book.length, ...CANNED_PET_BOOK.map((entry) => ({ ...entry })));
    this.#commandState = COMMAND_FOLLOW;
    this.#reactState = REACT_DEFENSIVE;
    this.#attacking = false;
    this.#cooldowns.clear();
    this.#fire(FRAMEXML_PET_ACTION_EVENTS.update);
  }

  dismiss(): void {
    this.#present = false;
    this.#attacking = false;
    this.#fire(FRAMEXML_PET_ACTION_EVENTS.update);
  }

  setAttacking(attacking: boolean): void {
    if (this.#attacking === attacking) return;
    this.#attacking = attacking;
    if (this.#present) this.#fire(FRAMEXML_PET_ACTION_EVENTS.update);
  }

  setUsable(spellId: number, usable: boolean): void {
    if (usable) this.#unusable.delete(spellId);
    else this.#unusable.add(spellId);
    if (this.#present) this.#fire(FRAMEXML_PET_ACTION_EVENTS.usable);
  }

  bar(): readonly number[] {
    return [...this.#bar];
  }

  // ---- the C API ---------------------------------------------------------------------------

  hasActionBar(): boolean {
    return this.#present;
  }

  actionInfo(index: number): FrameXmlPetActionInfo | undefined {
    const word = this.#word(index);
    return word === undefined ? undefined : frameXmlPetActionInfo(word, {
      commandState: this.#commandState, reactState: this.#reactState, attacking: this.#attacking,
    }, spellRow);
  }

  isAttackAction(index: number): boolean {
    const word = this.#word(index);
    return word !== undefined && frameXmlPetAttackWord(word);
  }

  slotUsable(index: number): boolean {
    const word = this.#word(index);
    if (word === undefined) return false;
    return !frameXmlPetSpellWord(word) || !this.#unusable.has(petActionOf(word));
  }

  cooldown(index: number): FrameXmlPetActionCooldown {
    const word = this.#word(index);
    const now = this.#pump?.now();
    const timer = word === undefined ? undefined : this.#cooldowns.get(petActionOf(word));
    if (!timer || now === undefined || timer.start + timer.duration <= now) return FRAMEXML_PET_ACTION_IDLE_COOLDOWN;
    return [timer.start, timer.duration, 1];
  }

  castAction(index: number, unit?: string): void {
    const word = this.#word(index);
    if (word === undefined) return;
    const type = petActionTypeOf(word);
    const action = petActionOf(word);
    if (!frameXmlPetSpellWord(word) && type !== ACT_COMMAND && type !== ACT_REACTION) return;
    this.sent.push(["action", index, word, unit]);
    if (type === ACT_COMMAND) this.#order(action === COMMAND_ATTACK ? "attack" : action === COMMAND_STAY ? "wait" : "follow");
    else if (type === ACT_REACTION) this.#react(action);
    else this.#cast(action);
  }

  toggleAutocast(index: number): void {
    const word = this.#word(index);
    if (word === undefined) return;
    const type = petActionTypeOf(word);
    if (type !== ACT_ENABLED && type !== ACT_DISABLED) return;
    const enabled = type === ACT_DISABLED;
    this.sent.push(["autocast", petActionOf(word), enabled]);
    this.#setAutocast(petActionOf(word), enabled);
  }

  /** The core flips the pet's spell and its first bar slot together (HandlePetSpellAutocastOpcode). */
  #setAutocast(spellId: number, enabled: boolean): void {
    const state = enabled ? ACT_ENABLED : ACT_DISABLED;
    const slot = this.#bar.findIndex((word) => petActionOf(word) === spellId
      && (petActionTypeOf(word) === ACT_ENABLED || petActionTypeOf(word) === ACT_DISABLED));
    if (slot >= 0) this.#bar[slot] = packPetAction(spellId, state);
    for (const entry of this.#book) if (entry.spellId === spellId) entry.state = state;
    this.#fire(FRAMEXML_PET_ACTION_EVENTS.update);
  }

  command(command: FrameXmlPetCommand, unit?: string): void {
    if (!this.#present) return;
    this.sent.push(["command", command, unit]);
    if (command === "passive") this.#react(REACT_PASSIVE);
    else if (command === "defensive") this.#react(REACT_DEFENSIVE);
    else if (command === "aggressive") this.#react(REACT_AGGRESSIVE);
    else if (command !== "dismiss") this.#order(command);
  }

  /** The wolf is a hunter's pet: it is abandoned (PetAbandon), never dismissed. */
  canBeDismissed(): boolean {
    return false;
  }

  moveAction(from: number, to: number): void {
    const first = this.#word(from);
    const second = this.#word(to);
    if (first === undefined || second === undefined || from === to) return;
    this.sent.push(["swap", from, to]);
    this.#bar[from - 1] = second;
    this.#bar[to - 1] = first;
    this.#fire(FRAMEXML_PET_ACTION_EVENTS.update);
  }

  spellAt(index: number): number | undefined {
    const word = this.#word(index);
    return word !== undefined && frameXmlPetSpellWord(word) ? petActionOf(word) : undefined;
  }

  // ---- the pet's spellbook -----------------------------------------------------------------

  book(): FrameXmlPetBook | undefined {
    return this.#present && this.#book.length > 0 ? { count: this.#book.length, token: "PET" } : undefined;
  }

  bookSpell(index: number): FrameXmlPetBookSpell | undefined {
    const entry = this.#bookEntry(index);
    const row = entry ? CANNED_PET_ACTION_SPELLS.find((spell) => spell.id === entry.spellId) : undefined;
    if (!entry || !row) return undefined;
    return {
      spellId: entry.spellId, state: entry.state, name: row.name, rank: row.rank || undefined,
      iconPath: row.iconPath, passive: row.passive,
    };
  }

  bookCooldown(index: number): FrameXmlPetActionCooldown {
    const entry = this.#bookEntry(index);
    const now = this.#pump?.now();
    const timer = entry ? this.#cooldowns.get(entry.spellId) : undefined;
    if (!timer || now === undefined || timer.start + timer.duration <= now) return FRAMEXML_PET_BOOK_READY_COOLDOWN;
    return [timer.start, timer.duration, 1];
  }

  castBookSpell(index: number): void {
    const spell = this.bookSpell(index);
    if (!spell || spell.passive) return;
    this.sent.push(["book", spell.spellId]);
    this.#cast(spell.spellId);
  }

  toggleBookAutocast(index: number): void {
    const entry = this.#bookEntry(index);
    if (!entry || (entry.state !== ACT_ENABLED && entry.state !== ACT_DISABLED)) return;
    const enabled = entry.state === ACT_DISABLED;
    this.sent.push(["autocast", entry.spellId, enabled]);
    this.#setAutocast(entry.spellId, enabled);
  }

  placeSpell(index: number, spellId: number): void {
    const word = this.#word(index);
    const entry = this.#book.find((candidate) => candidate.spellId === spellId);
    const row = CANNED_PET_ACTION_SPELLS.find((spell) => spell.id === spellId);
    if (word === undefined || !entry || row?.passive === true) return;
    const type = petActionTypeOf(word);
    if (type === ACT_COMMAND || type === ACT_REACTION) return;
    this.sent.push(["place", index, spellId]);
    this.#bar[index - 1] = packPetAction(spellId, entry.state);
    this.#fire(FRAMEXML_PET_ACTION_EVENTS.update);
  }

  #bookEntry(index: number): { spellId: number; state: number } | undefined {
    return this.#present && Number.isInteger(index) && index >= 1 ? this.#book[index - 1] : undefined;
  }

  // ---- internals ---------------------------------------------------------------------------

  #word(index: number): number | undefined {
    if (!this.#present || !Number.isInteger(index) || index < 1 || index > FRAMEXML_PET_ACTION_SLOTS) return undefined;
    return this.#bar[index - 1];
  }

  #order(command: "attack" | "stopattack" | "follow" | "wait"): void {
    if (command === "attack" || command === "stopattack") {
      this.setAttacking(command === "attack");
      return;
    }
    const state = command === "wait" ? COMMAND_STAY : COMMAND_FOLLOW;
    if (state === this.#commandState) return;
    this.#commandState = state;
    this.#fire(FRAMEXML_PET_ACTION_EVENTS.update);
  }

  #react(state: number): void {
    if (state === this.#reactState) return;
    this.#reactState = state;
    this.#fire(FRAMEXML_PET_ACTION_EVENTS.update);
  }

  #cast(spellId: number): void {
    const cooldown = CANNED_PET_ACTION_SPELLS.find((spell) => spell.id === spellId)?.cooldownMs ?? 0;
    const now = this.#pump?.now();
    if (cooldown <= 0 || now === undefined) return;
    this.#cooldowns.set(spellId, { start: now, duration: cooldown / 1000 });
    this.#fire(FRAMEXML_PET_ACTION_EVENTS.cooldown);
    this.#fire(FRAMEXML_PET_ACTION_EVENTS.spellCooldown);
  }

  #fire(event: string): void {
    this.#pump?.fire(event);
  }
}

function spellRow(id: number): FrameXmlPetActionSpell | undefined {
  return CANNED_PET_ACTION_SPELLS.find((spell) => spell.id === id);
}

export function createCannedFrameXmlPetActionBar(): CannedFrameXmlPetActionBar {
  const model = new CannedFrameXmlPetActionBarModel();
  const world: CannedFrameXmlPetActionWorld = {
    get sent() { return model.sent; },
    bar: () => model.bar(),
    summon: () => model.summon(),
    dismiss: () => model.dismiss(),
    setAttacking: (attacking) => model.setAttacking(attacking),
    setUsable: (spellId, usable) => model.setUsable(spellId, usable),
  };
  return { model, world };
}
