/**
 * The stock PetPaperDollFrame's C API — the «Питомцы» tab of CharacterFrame with its pet page and
 * its «Спутники»/«Транспорт» sub-tabs — over this client's known spells, and the companion cursor.
 *
 * * A companion is a known spell on `SkillLineAbility` skill line 777 (mounts) or 778
 *   (companions), or one that carries a `SPELL_AURA_MOUNTED` (78) effect: the native «Коллекции»
 *   page's classifier (ui/CharacterSheet.ts), unchanged. The client lists each kind by name; here
 *   that is the locale's collation, the spell id as the tie, a name that has not resolved last.
 * * `GetCompanionInfo` answers `creatureID, creatureName, spellID, icon, isSummoned`
 *   (PetPaperDollFrame.lua:37-40, :302-337). The creature is the spell's own: the misc value of its
 *   SUMMON (28) effect for a critter, of its MOUNTED aura for a mount — `Spell.dbc`
 *   `EffectMiscValue`, measured on this dataset: 4055 «Механическая белка» → 2671, 458 «Гнедой
 *   конь» → 284. The name is the spell's, the icon its `SpellIcon` path;
 *   `CompanionModelFrame:SetCreature(creatureID)` then records that entry for the model stage
 *   (FrameXmlModelPreview.ts), which resolves it through the creature template's display.
 * * A mount is summoned while the player is mounted (`UNIT_FLAG_MOUNT` or a mount display) and
 *   wears the spell's aura — `WorldClient.isActiveMountSpell`'s rule. A critter is summoned while
 *   a unit the player summoned (`UNIT_FIELD_SUMMONEDBY`) and this spell created
 *   (`UNIT_CREATED_BY_SPELL`) is in view.
 * * `CallCompanion` casts the spell as the book does. `DismissCompanion("MOUNT")` casts the summoned
 *   mount's spell again, which is this client's dismount: `WorldClient.castSpell` sends
 *   `CMSG_CANCEL_MOUNT_AURA` for the active mount instead of a cast (ui/Spellbook.ts, its
 *   `togglingMount`). `DismissCompanion("CRITTER")` is `CMSG_DISMISS_CRITTER` with the summoned
 *   unit's guid (`WorldClient.dismissCritter`), the opcode the client sends for it.
 * * `PickupCompanion` puts the spell on the one cursor as the `companion` shape — `GetCursorInfo`
 *   is `"companion", index, type` — and a bar drop places it as an ordinary spell action, which is
 *   what the client's bar holds for a companion (FrameXmlCursor.ts).
 * * `GetCompanionCooldown` is the spell's cooldown in `GetSpellCooldown`'s shape.
 * * Events: COMPANION_LEARNED / COMPANION_UNLEARNED when a known set that already had spells gains
 *   or loses a companion; COMPANION_UPDATE(type) when a summon state, a name or an icon of that kind
 *   changes. The stock handlers (PetPaperDollFrame.lua:125-168) repaint the page and the tab on
 *   exactly these. The first reconcile after attach, and the initial spell list, publish
 *   COMPANION_UPDATE alone: the stock OnLoad read the list before any seam existed
 *   (`idMount`/`idCritter` nil, :33-36), and that handler is what fills them (:161-166); a login's
 *   spell list is not a learning and must not pulse the micro button (:132-137).
 *
 * The pet page's own C API rides along. `PetCanBeAbandoned`/`PetCanBeRenamed` read the pet's
 * `UNIT_FIELD_BYTES_2` pet-flags byte (`UNIT_CAN_BE_ABANDONED` 0x02, `UNIT_CAN_BE_RENAMED` 0x01,
 * UnitDefines.h), `PetAbandon`/`PetRename` send the two pet opcodes. `GetPetFoodTypes` answers what a
 * seam carries, which today is nothing: the diet is `CreatureFamily.PetFoodMask` over
 * `ItemPetFood.dbc`, and this client has neither table's names (FrameXmlStable.ts, the same rule
 * for the stable's tooltip).
 */
import { readByte, unit as unitField } from "../../world/Fields.js";
import type { WorldObjectState } from "../../world/WorldState.js";
import { SPELL_AURA_MOUNTED, type SpellMetadata } from "../SpellMetadata.js";
import type { FrameXmlSpellCooldown } from "./FrameXmlWorldSeam.js";

/** Stock WotLK `SkillLine` rows: the same two ui/CharacterSheet.ts reads for its «Коллекции». */
export const FRAMEXML_SKILL_LINE_MOUNTS = 777;
export const FRAMEXML_SKILL_LINE_COMPANIONS = 778;
/** `SPELL_EFFECT_SUMMON`: a critter's spell summons its creature through this effect. */
const SPELL_EFFECT_SUMMON = 28;
/** `UNIT_FLAG_MOUNT` (UnitDefines.h), the flag `Unit::Mount` sets beside the mount display. */
const UNIT_FLAG_MOUNT = 0x08000000;
/** `UNIT_CAN_BE_RENAMED` in `UNIT_BYTES_2_OFFSET_PET_FLAGS` (= 2); cleared once the pet is named. */
const UNIT_PET_FLAG_CAN_BE_RENAMED = 0x01;

export const FRAMEXML_COMPANION_EVENTS = Object.freeze({
  learned: "COMPANION_LEARNED",
  unlearned: "COMPANION_UNLEARNED",
  update: "COMPANION_UPDATE",
});

/** The two companion kinds, spelled as the stock frame passes them (`PetPaperDollFrameCompanionFrame.mode`). */
export type FrameXmlCompanionType = "CRITTER" | "MOUNT";

export interface FrameXmlCompanionEntry {
  readonly type: FrameXmlCompanionType;
  readonly spellId: number;
  /** The summoned creature's template entry; 0 until the spell's row has arrived or when it names none. */
  readonly creatureId: number;
  /** The spell's name; empty until its row has arrived. */
  readonly name: string;
  readonly icon: string;
}

/** What classification and the info tuple read of a spell's row; the effect arrays are optional for older caches. */
export type FrameXmlCompanionSpell = Pick<SpellMetadata, "name" | "iconPath">
  & Partial<Pick<SpellMetadata, "effects" | "effectAura" | "effectMiscValue">>;

/** What the model reads from a seam's world; every answer is the world's now. */
export interface FrameXmlCompanionHost {
  /** The known spells; WorldClient replaces the array on every change, so its identity is the change signal. Undefined without a world. */
  knownSpells(): readonly { readonly id: number }[] | undefined;
  /** The spell's cached row; undefined until it has arrived. */
  spell(id: number): FrameXmlCompanionSpell | undefined;
  /** The spell's `SkillLineAbility` skill lines (empty when it has none); undefined while the catalog is not ready. */
  skillLines(id: number): readonly number[] | undefined;
  /** The player is mounted: `UNIT_FLAG_MOUNT` or a mount display (`frameXmlUnitMounted`). */
  mounted(): boolean;
  /** The player wears this spell's aura. */
  hasAura(spellId: number): boolean;
  /** Every unit in view the player summoned, with the spell that created it (`UNIT_CREATED_BY_SPELL`). */
  forEachSummon(visit: (spellId: number, guid: bigint) => void): void;
  /** Cast the spell as the book does; for the active mount this is the client's dismount. */
  cast(spellId: number): void;
  /** `CMSG_DISMISS_CRITTER`. */
  dismissCritter(guid: bigint): void;
  /** The spell's cooldown in `GetSpellCooldown`'s shape. */
  cooldown(spellId: number): FrameXmlSpellCooldown;
  /** Put the companion's spell on the cursor as the `companion` shape. */
  pickup(spellId: number, type: FrameXmlCompanionType, index: number): void;
  /** The client locale, for the name order; the host's default when absent. */
  locale?(): string;
}

interface CompanionPump {
  fire(event: string, ...args: readonly unknown[]): number;
}

const NOTHING: readonly [] = Object.freeze([]);
const TYPES: readonly FrameXmlCompanionType[] = Object.freeze(["CRITTER", "MOUNT"]);

/** `"CRITTER"`/`"MOUNT"` as stock passes them, in any case; undefined for anything else. */
export function frameXmlCompanionType(value: unknown): FrameXmlCompanionType | undefined {
  if (typeof value !== "string") return undefined;
  const upper = value.toUpperCase();
  return upper === "CRITTER" || upper === "MOUNT" ? upper : undefined;
}

/** `Unit::IsMounted`'s two signs, the pair WorldClient reads for its own mount toggle. */
export function frameXmlUnitMounted(object: WorldObjectState | undefined): boolean {
  if (!object) return false;
  if (((unitField.flags(object) ?? 0) & UNIT_FLAG_MOUNT) !== 0) return true;
  return (unitField.mountDisplayId(object) ?? 0) > 0;
}

/** `PetCanBeRenamed`: the pet's rename flag; false without a pet or once the pet has been named. */
export function frameXmlPetCanBeRenamed(pet: WorldObjectState | undefined): boolean {
  if (!pet) return false;
  return ((readByte(pet, "UNIT_FIELD_BYTES_2", 2) ?? 0) & UNIT_PET_FLAG_CAN_BE_RENAMED) !== 0;
}

/** Classify one known spell; undefined for a spell that is neither. */
export function frameXmlCompanionKind(
  spell: FrameXmlCompanionSpell | undefined,
  skillLines: readonly number[] | undefined,
): FrameXmlCompanionType | undefined {
  if (skillLines?.includes(FRAMEXML_SKILL_LINE_MOUNTS) || spell?.effectAura?.includes(SPELL_AURA_MOUNTED)) return "MOUNT";
  if (skillLines?.includes(FRAMEXML_SKILL_LINE_COMPANIONS)) return "CRITTER";
  return undefined;
}

/** The creature the spell's summon effect (critter) or mounted aura (mount) names; 0 when it names none. */
export function frameXmlCompanionCreature(type: FrameXmlCompanionType, spell: FrameXmlCompanionSpell | undefined): number {
  if (!spell) return 0;
  const effects = spell.effects ?? NOTHING;
  const auras = spell.effectAura ?? NOTHING;
  const misc = spell.effectMiscValue ?? NOTHING;
  for (let index = 0; index < 3; index += 1) {
    const matches = type === "MOUNT" ? auras[index] === SPELL_AURA_MOUNTED : effects[index] === SPELL_EFFECT_SUMMON;
    const value = misc[index] ?? 0;
    if (matches && Number.isSafeInteger(value) && value > 0) return value;
  }
  return 0;
}

function indexOf(value: unknown): number {
  const index = Math.trunc(Number(value));
  return Number.isInteger(index) && index >= 1 ? index : 0;
}

/** Set membership by id, order-free: what LEARNED/UNLEARNED compare. */
function membershipOf(entries: readonly FrameXmlCompanionEntry[]): string {
  return entries.map((entry) => entry.spellId).sort((left, right) => left - right).join(",");
}

/** What GetCompanionInfo answers for a page, in order: what COMPANION_UPDATE compares. */
function detailsOf(entries: readonly FrameXmlCompanionEntry[]): string {
  return entries.map((entry) => `${entry.spellId}:${entry.creatureId}:${entry.name}:${entry.icon}`).join("\u0001");
}

/** One owner of the companion C API and of the COMPANION_* events. */
export class FrameXmlCompanionModel {
  readonly #host: FrameXmlCompanionHost;
  #pump: CompanionPump | undefined;
  readonly #lists: Record<FrameXmlCompanionType, readonly FrameXmlCompanionEntry[]> = { CRITTER: NOTHING, MOUNT: NOTHING };
  readonly #critterIds = new Set<number>();
  /** The known-spell array the lists were built from; a new identity is a changed list. */
  #builtFrom: readonly { readonly id: number }[] | undefined;
  /** Known spells whose row or skill lines had not arrived; rebuilt every reconcile while any remain. */
  #pending = 0;
  readonly #membership: Record<FrameXmlCompanionType, string> = { CRITTER: "", MOUNT: "" };
  readonly #details: Record<FrameXmlCompanionType, string> = { CRITTER: "", MOUNT: "" };
  /** The summon state as of the last reconcile: the mount spell worn, the critters in view by spell. */
  #mountSpell: number | undefined;
  readonly #critterGuids = new Map<number, bigint>();
  #summoned = "";
  #seeded = false;
  #collator: Intl.Collator | undefined;
  #collatorLocale: string | undefined;

  constructor(host: FrameXmlCompanionHost) {
    this.#host = host;
  }

  attach(pump: CompanionPump): void {
    this.detach();
    this.#pump = pump;
    this.reconcile();
  }

  detach(): void {
    this.#pump = undefined;
    this.#seeded = false;
    this.#builtFrom = undefined;
    this.#pending = 0;
  }

  /** The seams' 60 ms poll: the known set, the rows that arrived since, the summon state. */
  tick(): void {
    this.reconcile();
  }

  /** The list of one kind, in the client's order. */
  entries(type: FrameXmlCompanionType): readonly FrameXmlCompanionEntry[] {
    return this.#lists[type];
  }

  // ---- the C API ---------------------------------------------------------------------------

  /** `GetNumCompanions(type)`. */
  count(type: FrameXmlCompanionType | undefined): number {
    return type ? this.#lists[type].length : 0;
  }

  /** `GetCompanionInfo(type, index)`: `creatureID, creatureName, spellID, icon, isSummoned`; nothing past the list. */
  info(type: FrameXmlCompanionType | undefined, index: number): readonly unknown[] {
    const entry = this.#entry(type, index);
    if (!entry) return NOTHING;
    return [entry.creatureId, entry.name, entry.spellId, entry.icon, this.summoned(entry)];
  }

  /** Whether the entry's companion is out now, as of the last reconcile. */
  summoned(entry: FrameXmlCompanionEntry): boolean {
    return entry.type === "MOUNT" ? this.#mountSpell === entry.spellId : this.#critterGuids.has(entry.spellId);
  }

  /** `CallCompanion(type, index)`: cast the spell. */
  call(type: FrameXmlCompanionType | undefined, index: number): void {
    const entry = this.#entry(type, index);
    if (entry) this.#host.cast(entry.spellId);
  }

  /**
   * `DismissCompanion(type)`: the mount's spell again (the client's dismount), or
   * CMSG_DISMISS_CRITTER for the critter in view. Nothing is out: nothing is sent.
   */
  dismiss(type: FrameXmlCompanionType | undefined): void {
    if (!type) return;
    this.#refreshSummons();
    if (type === "MOUNT") {
      if (this.#mountSpell !== undefined) this.#host.cast(this.#mountSpell);
      return;
    }
    for (const guid of this.#critterGuids.values()) {
      this.#host.dismissCritter(guid);
      return;
    }
  }

  /** `PickupCompanion(type, index)`. */
  pickup(type: FrameXmlCompanionType | undefined, index: number): void {
    const entry = this.#entry(type, index);
    if (entry && type) this.#host.pickup(entry.spellId, type, index);
  }

  /** `GetCompanionCooldown(type, index)`; nothing past the list, which stock guards for (:340-343). */
  cooldown(type: FrameXmlCompanionType | undefined, index: number): readonly unknown[] {
    const entry = this.#entry(type, index);
    return entry ? [...this.#host.cooldown(entry.spellId)] : NOTHING;
  }

  // ---- reconcile ---------------------------------------------------------------------------

  /**
   * Compare the world with what was last published and raise the differences. Called by attach,
   * by the seams' poll and by a scripted world after it moved; allocation-free while nothing
   * changed and every row has arrived.
   */
  reconcile(): void {
    const known = this.#host.knownSpells();
    if (!known) return;
    const previousKnown = this.#builtFrom;
    if (known !== previousKnown || this.#pending > 0) this.#build(known);
    this.#refreshSummons();
    const summoned = `${this.#mountSpell ?? 0}|${[...this.#critterGuids.keys()].sort((left, right) => left - right).join(",")}`;
    const updated = new Set<FrameXmlCompanionType>();
    if (!this.#seeded) {
      this.#seeded = true;
      for (const type of TYPES) {
        this.#membership[type] = membershipOf(this.#lists[type]);
        this.#details[type] = detailsOf(this.#lists[type]);
        if (this.#lists[type].length > 0) updated.add(type);
      }
      this.#summoned = summoned;
      for (const type of updated) this.#pump?.fire(FRAMEXML_COMPANION_EVENTS.update, type);
      return;
    }
    // Only a replaced spell list can be a learning, and the initial one (SMSG_INITIAL_SPELLS over
    // an empty list) is not; a row or the skill catalog arriving late changes what the same list
    // classifies to, which is an update.
    const learning = known !== previousKnown && previousKnown !== undefined && previousKnown.length > 0;
    let learned = false;
    let unlearned = false;
    const reported = new Set<FrameXmlCompanionType>();
    for (const type of TYPES) {
      const membership = membershipOf(this.#lists[type]);
      if (membership !== this.#membership[type]) {
        const before = new Set(this.#membership[type].split(",").filter((id) => id !== ""));
        const after = new Set(membership.split(",").filter((id) => id !== ""));
        let gained = false;
        let lost = false;
        for (const id of after) if (!before.has(id)) gained = true;
        for (const id of before) if (!after.has(id)) lost = true;
        if (learning && (gained || lost)) {
          // The stock LEARNED/UNLEARNED handlers repaint the page themselves (:132-158).
          learned ||= gained;
          unlearned ||= lost;
          reported.add(type);
        } else {
          updated.add(type);
        }
        this.#membership[type] = membership;
      }
      const details = detailsOf(this.#lists[type]);
      if (details !== this.#details[type]) {
        this.#details[type] = details;
        if (!reported.has(type)) updated.add(type);
      }
    }
    if (summoned !== this.#summoned) {
      const [mountBefore = "", crittersBefore = ""] = this.#summoned.split("|");
      const [mountAfter = "", crittersAfter = ""] = summoned.split("|");
      if (mountBefore !== mountAfter && !reported.has("MOUNT")) updated.add("MOUNT");
      if (crittersBefore !== crittersAfter && !reported.has("CRITTER")) updated.add("CRITTER");
      this.#summoned = summoned;
    }
    const pump = this.#pump;
    if (!pump) return;
    if (learned) pump.fire(FRAMEXML_COMPANION_EVENTS.learned);
    if (unlearned) pump.fire(FRAMEXML_COMPANION_EVENTS.unlearned);
    for (const type of TYPES) if (updated.has(type)) pump.fire(FRAMEXML_COMPANION_EVENTS.update, type);
  }

  // ---- internals ---------------------------------------------------------------------------

  #entry(type: FrameXmlCompanionType | undefined, index: number): FrameXmlCompanionEntry | undefined {
    return type ? this.#lists[type][index - 1] : undefined;
  }

  #build(known: readonly { readonly id: number }[]): void {
    const critters: FrameXmlCompanionEntry[] = [];
    const mounts: FrameXmlCompanionEntry[] = [];
    let pending = 0;
    for (const { id } of known) {
      const spell = this.#host.spell(id);
      const lines = this.#host.skillLines(id);
      if (spell === undefined || lines === undefined) pending += 1;
      const type = frameXmlCompanionKind(spell, lines);
      if (!type) continue;
      const entry: FrameXmlCompanionEntry = {
        type, spellId: id,
        creatureId: frameXmlCompanionCreature(type, spell),
        name: spell?.name ?? "",
        icon: spell?.iconPath ?? "",
      };
      (type === "MOUNT" ? mounts : critters).push(entry);
    }
    const collator = this.#collate();
    const byName = (left: FrameXmlCompanionEntry, right: FrameXmlCompanionEntry): number => {
      if (left.name === "" || right.name === "") {
        if (left.name !== right.name) return left.name === "" ? 1 : -1;
      } else {
        const order = collator.compare(left.name, right.name);
        if (order !== 0) return order;
      }
      return left.spellId - right.spellId;
    };
    critters.sort(byName);
    mounts.sort(byName);
    this.#lists.CRITTER = Object.freeze(critters);
    this.#lists.MOUNT = Object.freeze(mounts);
    this.#critterIds.clear();
    for (const entry of critters) this.#critterIds.add(entry.spellId);
    this.#builtFrom = known;
    this.#pending = pending;
  }

  #collate(): Intl.Collator {
    const locale = this.#host.locale?.();
    if (!this.#collator || locale !== this.#collatorLocale) {
      this.#collatorLocale = locale;
      try {
        this.#collator = new Intl.Collator(locale ? locale.replace("_", "-") : undefined);
      } catch {
        this.#collator = new Intl.Collator();
      }
    }
    return this.#collator;
  }

  /** The mount worn and the critters in view; one object walk, and only while a critter is known. */
  #refreshSummons(): void {
    this.#mountSpell = undefined;
    const mounts = this.#lists.MOUNT;
    if (mounts.length > 0 && this.#host.mounted()) {
      for (const entry of mounts) {
        if (this.#host.hasAura(entry.spellId)) {
          this.#mountSpell = entry.spellId;
          break;
        }
      }
    }
    this.#critterGuids.clear();
    if (this.#critterIds.size > 0) {
      this.#host.forEachSummon((spellId, guid) => {
        if (this.#critterIds.has(spellId)) this.#critterGuids.set(spellId, guid);
      });
    }
  }
}

/** The part of the world seam the bindings read: the model, and the pet page's five calls. */
export interface FrameXmlCompanionSeam {
  readonly companions?: FrameXmlCompanionModel | undefined;
  /** `PetCanBeAbandoned`: the pet's `UNIT_CAN_BE_ABANDONED` flag (a hunter pet). */
  petCanBeAbandoned?(): boolean;
  /** `PetCanBeRenamed`: the pet's `UNIT_CAN_BE_RENAMED` flag. */
  petCanBeRenamed?(): boolean;
  /** `PetAbandon()`: `CMSG_PET_ABANDON`. */
  petAbandon?(): void;
  /** `PetRename(name)`: `CMSG_PET_RENAME`. */
  petRename?(name: string): void;
  /** `GetPetFoodTypes()`: the diet's names when a seam carries them. */
  petFoodTypes?(): readonly string[];
}

export type FrameXmlCompanionBinding = (host: FrameXmlCompanionSeam, args: readonly unknown[]) => readonly unknown[];

const withCompanions = (
  answer: (model: FrameXmlCompanionModel, args: readonly unknown[]) => readonly unknown[],
  fallback: readonly unknown[] = NOTHING,
): FrameXmlCompanionBinding => (host, args) => (host.companions ? answer(host.companions, args) : fallback);

/**
 * The flat C API. `GetCompanionInfo("MOUNT", 1)` is read by PetPaperDollFrame_OnLoad while the
 * corpus loads, before a seam is attached: nothing, as an empty list answers.
 */
export const FRAMEXML_COMPANION_BINDINGS: Readonly<Record<string, FrameXmlCompanionBinding>> = Object.freeze({
  GetNumCompanions: withCompanions((model, args) => [model.count(frameXmlCompanionType(args[0]))], [0]),
  GetCompanionInfo: withCompanions((model, args) => model.info(frameXmlCompanionType(args[0]), indexOf(args[1]))),
  CallCompanion: withCompanions((model, args) => { model.call(frameXmlCompanionType(args[0]), indexOf(args[1])); return NOTHING; }),
  DismissCompanion: withCompanions((model, args) => { model.dismiss(frameXmlCompanionType(args[0])); return NOTHING; }),
  PickupCompanion: withCompanions((model, args) => { model.pickup(frameXmlCompanionType(args[0]), indexOf(args[1])); return NOTHING; }),
  GetCompanionCooldown: withCompanions((model, args) => model.cooldown(frameXmlCompanionType(args[0]), indexOf(args[1]))),
  GetPetFoodTypes: (host) => host.petFoodTypes?.() ?? NOTHING,
  PetCanBeAbandoned: (host) => [host.petCanBeAbandoned?.() ?? false],
  PetCanBeRenamed: (host) => [host.petCanBeRenamed?.() ?? false],
  PetAbandon: (host) => { host.petAbandon?.(); return NOTHING; },
  PetRename: (host, args) => {
    const name = typeof args[0] === "string" ? args[0].trim() : "";
    if (name.length > 0) host.petRename?.(name);
    return NOTHING;
  },
});
