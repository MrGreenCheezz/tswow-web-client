import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import type { ActiveAura } from "../../world/AuraProtocol.js";
import { farSightGuid } from "../../world/FarSight.js";
import {
  ACT_COMMAND, ACT_REACTION, petActionOf, petActionTypeOf, type PetSpells,
} from "../../world/PetProtocol.js";
import {
  POSSESS_BONUS_BAR_OFFSET, POSSESS_FIRST_SLOT, POSSESS_PAGE_SLOTS, controlsVehicle, drivesCharm, isHunterPet,
  ownerWordsInto, possessBarOnMainBar, possessBarUnitUsable, possessMirrorIndex, possessSpellOf, unitCharmed,
  unitPossessed,
} from "../../world/PossessBar.js";
import type { WorldObjectState } from "../../world/WorldState.js";
import { isVehicleActionBar } from "../../world/PetProtocol.js"; // 11.02-F2
import type { VehicleCatalog } from "../../world/VehicleDbc.js"; // 11.02-F2
import { vehicleBarOnMainBar } from "../../world/VehicleUi.js"; // 11.02-F2
import { frameXmlWorldObjects } from "./FrameXmlWorldObjects.js"; // seam-sweep
import type { SpellMetadata } from "../SpellMetadata.js";
import { frameXmlIsAttackSpell } from "./FrameXmlActionRepeat.js";
import {
  FRAMEXML_PET_ACTION_IDLE_COOLDOWN, frameXmlPetActionInfo, type FrameXmlPetActionCooldown,
} from "./FrameXmlPetActionBar.js";

/**
 * 11.02-IF: possession in the stock UI — Mind Control, Eyes of the Beast, Eye of Kilrogg — as Wow.exe
 * 3.3.5a 12340 shows it: the possessed unit's bar on the main action bar (BonusActionBarFrame on page
 * 11), the two possess buttons (BonusActionBarFrame.lua `PossessBar_*`), `PLAYER_FARSIGHT_FOCUS_CHANGED`,
 * `UnitIsPossessed`/`UnitIsCharmed`, and `CancelUnitBuff("player", name)` for the cancel button. The
 * rules and their addresses are in `world/PossessBar.ts`; this file holds the client state they keep
 * and answers the C API over it (`frameXmlWithPossess`).
 *
 * The state moves where Wow.exe moves it: a `PLAYER_FARSIGHT` change (0x006e4fd0: the possess spell,
 * then the main-bar bit 0x005d4ad0 with `PET_BAR_UPDATE`, then `PLAYER_FARSIGHT_FOCUS_CHANGED`
 * 0xA1), a `SMSG_PET_SPELLS` (0x005d6900 → 0x005d4ad0; a bar for another unit forgets that a possess
 * spell was seen) and a change of the character's `UNIT_FIELD_CHARM`/`SUMMON` (0x006d1970, the
 * possess spell only). The seam calls `tick` on its poll, on the far sight field's store edge and on
 * `PET_BAR_CHANGED`. One addition: a scan that met an aura whose spell row this client has not
 * cached yet — Wow.exe reads its DBC on the spot — is repeated on the polls until the rows are there.
 *
 * Slots 121–132 under the main-bar bit answer from the pet bar (0x005a8160 HasAction, 0x005a97f0
 * GetActionTexture, 0x005a8f10 GetActionInfo, 0x005aa240 IsCurrentAction, 0x005a96d0 IsAttackAction,
 * 0x005abbc0 UseAction → 0x005d4210 CastPetAction's core, which `WorldClient.usePetSlot` already is:
 * `CMSG_PET_CAST_SPELL` from the possessed unit, `CMSG_PET_ACTION` for its commands). Not repeated:
 * the spell's ActiveIconID while its aura is up (0x00802cb0 — no route serves the column), the
 * range check from the unit (0x005a94c0 → 0x00809610; nil here), the slots kept after the bit
 * clears (Wow.exe leaves the words in place; here they answer only while the bit is set), and the
 * "GAMEABILITYACTIVATE" sound.
 */

/** The world facts the model reads; `WorldClient` satisfies it structurally. */
export interface FrameXmlPossessWorld {
  readonly state: {
    readonly selfGuid?: bigint | undefined;
    readonly objects: { get(guid: bigint): WorldObjectState | undefined };
  };
  readonly petSpells?: PetSpells | undefined;
  readonly petAttackVictim?: bigint | undefined;
  readonly creatureTemplates?: { get(entry: number): { readonly flags?: number } | undefined } | undefined;
  readonly events?: {
    on(name: "PET_BAR_CHANGED", listener: (change: { readonly guid: bigint }) => void): () => void;
  } | undefined;
  aurasFor?(guid: bigint | undefined): readonly ActiveAura[];
  usePetSlot?(slot: number, targetGuid?: bigint): void;
  cancelAura?(spellId: number): void;
}

/** The stock pet bar model's two per-word answers (FrameXmlPetActionBarLive), for any open bar. */
export interface FrameXmlPossessPetBar {
  wordCooldown?(word: number): FrameXmlPetActionCooldown;
  wordUsable?(word: number): boolean;
}

export interface FrameXmlPossessContext {
  readonly world: () => FrameXmlPossessWorld | undefined;
  /** Cache-only spell rows; a C-API read never fetches. */
  readonly spell: (id: number) => SpellMetadata | undefined;
  /** The seam's unit tokens to a guid. */
  readonly unitGuid: (unit: string) => bigint | undefined;
  readonly petBar?: () => FrameXmlPossessPetBar | undefined;
  /** The seam's own UPDATE_BONUS_ACTIONBAR check (0x005a83c0), run where Wow.exe runs it. */
  readonly bonusBarChanged?: () => void;
  /**
   * 11.02-IF-review: the native bar's own model (ui/PossessActionBar.ts), kept while no stock seam is
   * attached; it never becomes `frameXmlPossessLive()`.
   */
  readonly native?: boolean;
  /**
   * 11.02-F2: the vehicle tables (browser/VehicleClient.ts `vehicleCatalog`). A vehicle's bar goes on the
   * main bar by the seat's VehicleAbilityDisplay (world/VehicleUi.ts `vehicleBarOnMainBar`); without the
   * tables — or this hook — never, as before.
   */
  readonly vehicles?: () => VehicleCatalog | undefined;
}

/** 11.02-IF-review: the model an attached stock seam holds — the one keys 1–= read (ui/PossessActionBar.ts). */
let liveModel: FrameXmlPossessModel | undefined;

/** 11.02-IF-review: the attached stock seam's possess model, undefined while none is attached. */
export function frameXmlPossessLive(): FrameXmlPossessModel | undefined {
  return liveModel;
}

interface FrameXmlPossessPump {
  fire(event: string, ...args: readonly unknown[]): number;
}

export const FRAMEXML_POSSESS_EVENTS = Object.freeze({
  bonusBar: "UPDATE_BONUS_ACTIONBAR",
  pageChanged: "ACTIONBAR_PAGE_CHANGED",
  slotChanged: "ACTIONBAR_SLOT_CHANGED",
  updateState: "ACTIONBAR_UPDATE_STATE",
  petBar: "PET_BAR_UPDATE",
  farSight: "PLAYER_FARSIGHT_FOCUS_CHANGED",
} as const);

/** `GetPossessInfo(2)`'s texture: SpellIcon.dbc row 693 (0x005d5820 pushes `0x2b5`'s path). */
export const FRAMEXML_POSSESS_CANCEL_TEXTURE = "Interface\\Icons\\Spell_Shadow_SacrificialShield";
/** `SPELL_ATTR0_CANT_CANCEL` (SharedDefines.h:438): slot 2 is disabled for such a spell. */
const SPELL_ATTR0_CANT_CANCEL = 0x8000_0000;
/** `SPELL_ATTR1_CHANNELED_1` (SharedDefines.h:446). */
const SPELL_ATTR1_CHANNELED_1 = 0x4;
/** `AFLAG_POSITIVE`/`AFLAG_NEGATIVE` of an aura slot. */
const AURA_FLAG_POSITIVE = 0x10;
const AURA_FLAG_NEGATIVE = 0x80;
const TYPEID_UNIT = 3;
const OBJECT_ENTRY = UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset;

/**
 * `PET_<name>_TEXTURE` for a command (0x00a1a8c0: WAIT FOLLOW ATTACK DISMISS) and a reaction
 * (0x00a1a860: PASSIVE DEFENSIVE AGGRESSIVE), as 0x005a97f0 builds the name; the values are the
 * stock globals PetActionBarFrame.lua:6-12 defines (Wow.exe reads `_G` at the call).
 */
const COMMAND_TEXTURES: readonly string[] = [
  "Interface\\Icons\\Spell_Nature_TimeStop", "Interface\\Icons\\Ability_Tracking",
  "Interface\\Icons\\Ability_GhoulFrenzy", "Interface\\Icons\\Spell_Shadow_Teleport",
];
const REACTION_TEXTURES: readonly string[] = [
  "Interface\\Icons\\Ability_Seal", "Interface\\Icons\\Ability_Defend", "Interface\\Icons\\Ability_Racial_BloodRage",
];

/** `GetPossessInfo`'s texture, name and enabled. */
export type FrameXmlPossessInfo = readonly [texture: string | undefined, name: string | undefined, enabled: boolean | undefined];
const NO_POSSESS_INFO: FrameXmlPossessInfo = Object.freeze([undefined, undefined, undefined]) as FrameXmlPossessInfo;

export class FrameXmlPossessModel {
  readonly #context: FrameXmlPossessContext;
  #pump: FrameXmlPossessPump | undefined;
  #unsubscribe: (() => void) | undefined;
  /** 0x00c234e0: the possess spell; 0 for none. */
  #spell = 0;
  /** 0x00c234d8: a possess spell was found for the current bar. */
  #seen = false;
  /** Bit 0 of 0x00c1e5a0: the pet bar is on the main bar. */
  #active = false;
  /** The last `PLAYER_FARSIGHT` seen; undefined for none. */
  #farSight: bigint | undefined;
  /** The last bar packet seen (its identity) and its unit. */
  #barPacket: PetSpells | undefined;
  #barGuid = 0n;
  /** The character's CHARM/SUMMON words at the last look. */
  readonly #owner = [0, 0, 0, 0];
  readonly #ownerNow = [0, 0, 0, 0];
  /** A scan met an aura whose row was not cached: look again on the polls. */
  #pending = false;
  /** 11.02-F2: the vehicle tables at the last look. */
  #vehicles: VehicleCatalog | undefined;

  constructor(context: FrameXmlPossessContext) {
    this.#context = context;
  }

  /** 11.02-F2: whether the vehicle tables changed since the last look (they land once a session). */
  #vehiclesLanded(): boolean {
    const vehicles = this.#context.vehicles?.();
    if (vehicles === this.#vehicles) return false;
    this.#vehicles = vehicles;
    return true;
  }

  attach(pump: FrameXmlPossessPump): void {
    this.detach();
    this.#pump = pump;
    // The state at attach is the client's own, which outlives a UI reload: read it, announce nothing.
    const world = this.#context.world();
    const self = this.#self(world);
    this.#farSight = farSightGuid(self);
    this.#barPacket = world?.petSpells;
    this.#barGuid = this.#openBar(world)?.guid ?? 0n;
    ownerWordsInto(self, this.#owner);
    this.#spell = 0;
    this.#seen = false;
    this.#pending = false;
    this.#vehicles = this.#context.vehicles?.(); // 11.02-F2
    if (world && this.#farSight !== undefined && frameXmlWorldObjects(world).get(this.#farSight) !== undefined) { // seam-sweep
      this.#scan(world, self);
    }
    this.#active = this.#mainBar(world, self);
    if (typeof world?.events?.on === "function") {
      this.#unsubscribe = world.events.on("PET_BAR_CHANGED", () => this.tick());
    }
    if (this.#context.native !== true) liveModel = this; // 11.02-IF-review
  }

  detach(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#pump = undefined;
    if (liveModel === this) liveModel = undefined; // 11.02-IF-review
  }

  /** 11.02-IF-review: a scan met a spell row not cached yet and looks again on the next tick. */
  get pending(): boolean {
    return this.#pending;
  }

  /** Bring the state up to the world and raise the events Wow.exe raises on the way (see the head). */
  tick(): void {
    const pump = this.#pump;
    const world = this.#context.world();
    if (!pump || !world) return;
    const self = this.#self(world);
    const farSight = farSightGuid(self);
    const bar = this.#openBar(world);
    const barGuid = bar?.guid ?? 0n;
    let barPacket = false;
    if (world.petSpells !== this.#barPacket) {
      this.#barPacket = world.petSpells;
      barPacket = true;
    }
    if (barGuid !== this.#barGuid) {
      // 0x005d6900: a bar for another unit (or none) forgets that a possess spell was seen.
      this.#barGuid = barGuid;
      this.#seen = false;
    }
    ownerWordsInto(self, this.#ownerNow);
    let ownerMoved = false;
    for (let index = 0; index < 4; index++) {
      if (this.#ownerNow[index] === this.#owner[index]) continue;
      this.#owner[index] = this.#ownerNow[index]!;
      ownerMoved = true;
    }
    const before = this.#spell;
    const farMoved = farSight !== this.#farSight;
    if (farMoved) {
      this.#farSight = farSight;
      // 0x006e4fd0: an object in view is scanned for (0x005d62a0); a field without one clears (0x005d30e0(0)).
      if (farSight !== undefined && frameXmlWorldObjects(world).get(farSight) !== undefined) this.#scan(world, self); // seam-sweep
      else {
        this.#spell = 0;
        this.#pending = false;
      }
    } else if (ownerMoved || (this.#pending && farSight !== undefined)) {
      this.#scan(world, self);
    }
    if (this.#spell !== before) pump.fire(FRAMEXML_POSSESS_EVENTS.bonusBar);
    const vehiclesLanded = this.#vehiclesLanded(); // 11.02-F2
    if (farMoved || barPacket) this.#placeBar(world, self, pump, farMoved);
    // 11.02-F2: the vehicle tables landed under an open vehicle bar (Wow.exe holds its DBC from the start).
    else if (vehiclesLanded && bar !== undefined && isVehicleActionBar(bar.bar)) this.#placeBar(world, self, pump, false);
    if (farMoved) pump.fire(FRAMEXML_POSSESS_EVENTS.farSight);
  }

  /** `IsPossessBarVisible()` (0x005a8820): a possess spell that does not control a vehicle. */
  barVisible(): boolean {
    return this.#spell !== 0 && !controlsVehicle(this.#context.spell(this.#spell));
  }

  /** `GetPossessInfo(index)` (0x005d5820): slot 1 the spell, slot 2 the cancel button; three nils otherwise. */
  info(index: number): FrameXmlPossessInfo {
    if (this.#spell === 0 || !this.#pump) return NO_POSSESS_INFO;
    const row = this.#context.spell(this.#spell);
    if (index === 1) return row ? [row.iconPath || undefined, row.name, true] : NO_POSSESS_INFO;
    if (index === 2) {
      const cantCancel = ((row?.attributes?.[0] ?? 0) & SPELL_ATTR0_CANT_CANCEL) !== 0;
      return [FRAMEXML_POSSESS_CANCEL_TEXTURE, row?.name, !cantCancel];
    }
    return NO_POSSESS_INFO;
  }

  /** The possess spell (0x00c234e0); 0 for none. */
  get possessSpell(): number {
    return this.#spell;
  }

  /** Bit 0 of 0x00c1e5a0: `GetBonusBarOffset` 5, `GetActionBarPage` 1, `PetHasActionBar` nil. */
  onMainBar(): boolean {
    return this.#pump !== undefined && this.#active;
  }

  /** The pet bar slot (0-based, -1 for 131–132) an action slot mirrors now; undefined when it does not. */
  mirrorIndex(slot: unknown): number | undefined {
    if (!this.onMainBar()) return undefined;
    return possessMirrorIndex(typeof slot === "number" ? Math.trunc(slot) : Number.NaN);
  }

  /** The word in a mirrored slot; undefined for 131–132 or no bar. */
  #word(index: number): number | undefined {
    if (index < 0) return undefined;
    return this.#openBar(this.#context.world())?.bar[index]?.packed;
  }

  /** 11.02-IF-review: the pet bar word a mirrored slot (0-based, -1 for 131–132) shows; for the native bar. */
  wordAt(index: number): number | undefined {
    return this.#word(index);
  }

  /** 11.02-IF-review: the spell of a mirrored slot's word (0x005a80e0), 0 for a command, reaction or empty. */
  spellAt(index: number): number {
    return mirroredSpell(this.#word(index) ?? 0);
  }

  /** `HasAction` (0x005a8160): a command or reaction, or a spell slot that holds a spell. */
  hasAction(index: number): boolean {
    const word = this.#word(index);
    if (word === undefined || word === 0) return false;
    const type = petActionTypeOf(word) & 0x3f;
    if (type === ACT_REACTION || type === ACT_COMMAND) return true;
    return mirroredSpell(word) !== 0;
  }

  /** `GetActionTexture` (0x005a97f0): the spell's icon, or the stock `PET_<name>_TEXTURE`. */
  texture(index: number): string | undefined {
    const word = this.#word(index);
    if (word === undefined || word === 0) return undefined;
    const type = petActionTypeOf(word) & 0x3f;
    if (type === ACT_REACTION) return REACTION_TEXTURES[petActionOf(word)];
    if (type === ACT_COMMAND) return COMMAND_TEXTURES[petActionOf(word)];
    const spellId = mirroredSpell(word);
    return spellId === 0 ? undefined : this.#context.spell(spellId)?.iconPath || undefined;
  }

  /**
   * `GetActionInfo` (0x005a8f10) for a mirrored slot: `"spell", petBookIndex, "pet", spellId` — the
   * index is the spell's place in the pet book (0x0053b4e0 with book 1) plus one, 0 off the book.
   */
  actionInfo(index: number): readonly unknown[] | undefined {
    if (index < 0 || this.#openBar(this.#context.world()) === undefined) return undefined;
    const word = this.#word(index) ?? 0;
    const spellId = mirroredSpell(word);
    const book = this.#openBar(this.#context.world())?.spells ?? [];
    const place = spellId === 0 ? -1 : book.findIndex((entry) => entry.spellId === spellId);
    return ["spell", place + 1, "pet", spellId];
  }

  /** `IsCurrentAction` (0x005aa240): a reaction or command in force, the attack while the unit swings. */
  current(index: number): boolean {
    const word = this.#word(index);
    const bar = this.#openBar(this.#context.world());
    if (word === undefined || word === 0 || !bar) return false;
    const type = petActionTypeOf(word) & 0x3f;
    if (type !== ACT_REACTION && type !== ACT_COMMAND) return false;
    const state = {
      commandState: bar.commandState, reactState: bar.reactState,
      attacking: this.#context.world()?.petAttackVictim !== undefined,
    };
    return frameXmlPetActionInfo(word, state, () => undefined)?.[4] === true;
  }

  /** `IsAttackAction` (0x005a96d0): the slot's spell has `SPELL_EFFECT_ATTACK` first. */
  attack(index: number): boolean {
    const spellId = mirroredSpell(this.#word(index) ?? 0);
    return spellId !== 0 && frameXmlIsAttackSpell(this.#context.spell(spellId));
  }

  cooldown(index: number): FrameXmlPetActionCooldown {
    const word = this.#word(index);
    return word === undefined ? FRAMEXML_PET_ACTION_IDLE_COOLDOWN
      : this.#context.petBar?.()?.wordCooldown?.(word) ?? FRAMEXML_PET_ACTION_IDLE_COOLDOWN;
  }

  usable(index: number): boolean {
    const word = this.#word(index);
    if (word === undefined || !this.hasAction(index)) return false;
    return this.#context.petBar?.()?.wordUsable?.(word) ?? true;
  }

  /** The tooltip row of a mirrored spell slot; commands and reactions have none here. */
  tooltip(index: number): { readonly kind: "spell"; readonly id: number; readonly name: string; readonly rank?: string } | undefined {
    const spellId = mirroredSpell(this.#word(index) ?? 0);
    const row = spellId === 0 ? undefined : this.#context.spell(spellId);
    if (!row?.name) return undefined;
    return row.rank ? { kind: "spell", id: spellId, name: row.name, rank: row.rank } : { kind: "spell", id: spellId, name: row.name };
  }

  /**
   * `UseAction` on a mirrored slot (0x005abbc0 → 0x005d4210): the pet bar press, aimed at the current
   * target — 0x005abbc0 hands an empty guid, whatever unit the call named — then
   * `ACTIONBAR_UPDATE_STATE` (0x005a7cb0).
   */
  use(index: number): void {
    const word = this.#word(index);
    const pump = this.#pump;
    if (word === undefined || word === 0 || !pump) return;
    this.#context.world()?.usePetSlot?.(index);
    pump.fire(FRAMEXML_POSSESS_EVENTS.updateState);
  }

  /** `UnitIsPossessed(unit)` (0x0060d860). */
  unitIsPossessed(unit: string): boolean {
    return unitPossessed(this.#unitObject(unit));
  }

  /** `UnitIsCharmed(unit)` (0x0060d7d0). */
  unitIsCharmed(unit: string): boolean {
    return unitCharmed(this.#unitObject(unit));
  }

  /**
   * `CancelUnitBuff("player", name [, rank])` (0x00804220 → 0x0072c9b0 → 0x00802f80): the first aura
   * of the character's without `AFLAG_NEGATIVE` whose spell carries that name (case-insensitive) and
   * rank, cancelled when it is flagged positive or its spell is channeled, and only while the
   * character is not charmed; `CMSG_CANCEL_AURA`, which the core turns into the channel's end for a
   * channeled spell (SpellHandler.cpp `HandleCancelAuraOpcode`). A spell the player cannot cancel
   * (`SPELL_ATTR0_CANT_CANCEL`) or a passive one sends nothing. Another unit (a vehicle) is slice F2's.
   * True when the call was a name search, whatever it found.
   */
  cancelBuffByName(unit: unknown, name: unknown, rank: unknown, filter: unknown): boolean {
    if (typeof name !== "string") return false;
    const world = this.#context.world();
    if (unit !== "player" || !world) return true;
    if (typeof filter === "string" && filter.toUpperCase().includes("HARMFUL")) return true;
    const self = this.#self(world);
    if (!self || unitCharmed(self)) return true;
    const wanted = name.toLowerCase();
    for (const aura of world.aurasFor?.(world.state.selfGuid) ?? []) {
      if (aura.spellId <= 0 || (aura.flags & AURA_FLAG_NEGATIVE) !== 0) continue;
      const row = this.#context.spell(aura.spellId);
      if (!row || row.name.toLowerCase() !== wanted) continue;
      if (typeof rank === "string" && (row.rank ?? "").toLowerCase() !== rank.toLowerCase()) continue;
      const channeled = row.attributes ? ((row.attributes[1] ?? 0) & SPELL_ATTR1_CHANNELED_1) !== 0 : row.channeled === true;
      if ((aura.flags & AURA_FLAG_POSITIVE) === 0 && !channeled) return true;
      if (row.passive || ((row.attributes?.[0] ?? 0) & SPELL_ATTR0_CANT_CANCEL) !== 0) return true;
      world.cancelAura?.(aura.spellId);
      return true;
    }
    return true;
  }

  // ---- internals ---------------------------------------------------------------------------------

  #self(world: FrameXmlPossessWorld | undefined): WorldObjectState | undefined {
    const guid = world?.state?.selfGuid; // seam-sweep: a world may carry no state.objects (frameXmlWorldObjects)
    return guid === undefined ? undefined : frameXmlWorldObjects(world).get(guid);
  }

  #unitObject(unit: string): WorldObjectState | undefined {
    const guid = this.#context.unitGuid(unit.toLowerCase());
    return guid === undefined || guid === 0n ? undefined : frameXmlWorldObjects(this.#context.world()).get(guid); // seam-sweep
  }

  #openBar(world: FrameXmlPossessWorld | undefined): PetSpells | undefined {
    const bar = world?.petSpells;
    return bar && !bar.closed && bar.guid !== 0n ? bar : undefined;
  }

  /** 0x005d62a0: a found spell replaces the held one and marks it seen; a miss keeps it. */
  #scan(world: FrameXmlPossessWorld, self: WorldObjectState | undefined): void {
    const found = possessSpellOf(world.aurasFor?.(world.state.selfGuid) ?? [], (id) => this.#context.spell(id), drivesCharm(self));
    this.#pending = found.pending;
    if (found.spellId === 0) return;
    this.#spell = found.spellId;
    this.#seen = true;
  }

  /** 0x005d4ad0's condition (see PossessBar.ts). */
  #mainBar(world: FrameXmlPossessWorld | undefined, self: WorldObjectState | undefined): boolean {
    if (!world || !self) return false;
    const bar = this.#openBar(world);
    const farSight = this.#farSight;
    if (!bar || farSight === undefined || bar.guid !== farSight) return false;
    const objects = frameXmlWorldObjects(world); // seam-sweep
    const unit = objects.get(bar.guid); // seam-sweep
    const usable = unit === undefined || possessBarUnitUsable(
      unit,
      unit.typeId === TYPEID_UNIT ? world.creatureTemplates?.get(unit.fields.get(OBJECT_ENTRY) ?? 0)?.flags : undefined,
      this.#seen && this.#spell === 0,
      isHunterPet(unit, (guid) => objects.get(guid)), // seam-sweep
    );
    // 11.02-F2: a vehicle's bar by the rider's seat — 0x005d4ad0's VehicleAbilityDisplay branch (VehicleUi.ts).
    if (isVehicleActionBar(bar.bar)) {
      return vehicleBarOnMainBar(this.#context.vehicles?.(), objects, world.state.selfGuid, farSight, bar, usable); // seam-sweep
    }
    return possessBarOnMainBar(farSight, bar, usable);
  }

  /**
   * 0x005d4ad0: the main-bar bit; while set, the page's twelve slots are written again (one
   * ACTIONBAR_SLOT_CHANGED each, 0x005ab800 → 0x005aa390); then 0x005a83c0's offset check
   * (ACTIONBAR_PAGE_CHANGED first when the offset leaves 5) and, on a far sight change,
   * `PET_BAR_UPDATE` — on a bar packet the pet bar model raises that one itself.
   */
  #placeBar(world: FrameXmlPossessWorld, self: WorldObjectState | undefined, pump: FrameXmlPossessPump, farMoved: boolean): void {
    const was = this.#active;
    this.#active = this.#mainBar(world, self);
    if (this.#active) {
      for (let slot = POSSESS_FIRST_SLOT; slot < POSSESS_FIRST_SLOT + POSSESS_PAGE_SLOTS; slot++) {
        pump.fire(FRAMEXML_POSSESS_EVENTS.slotChanged, slot);
      }
    }
    if (was !== this.#active) {
      if (was) pump.fire(FRAMEXML_POSSESS_EVENTS.pageChanged);
      pump.fire(FRAMEXML_POSSESS_EVENTS.bonusBar);
    }
    this.#context.bonusBarChanged?.();
    if (farMoved) pump.fire(FRAMEXML_POSSESS_EVENTS.petBar);
  }
}

/** 0x005a80e0: the spell of a pet bar word — state 1 or 8…0x11 — or 0. */
function mirroredSpell(word: number): number {
  const type = petActionTypeOf(word) & 0x3f;
  return type === 1 || (type >= 8 && type <= 0x11) ? petActionOf(word) : 0;
}

// ---- the C API --------------------------------------------------------------------------------

type PossessBinding<Host> = (host: Host, args: readonly unknown[]) => readonly unknown[];

const NOTHING: readonly unknown[] = Object.freeze([]);

function possessOf(host: unknown): FrameXmlPossessModel | undefined {
  const model = (host as { readonly possess?: unknown } | undefined)?.possess;
  return model instanceof FrameXmlPossessModel ? model : undefined;
}

/**
 * The seam's binding table with the possess answers in front: the action-slot names for slots
 * 121–132 while the possessed unit's bar is on the main bar, and the possess names themselves. A
 * seam without the model (the canned world) answers exactly as before.
 */
export function frameXmlWithPossess<Host>(
  bindings: Readonly<Record<string, PossessBinding<Host>>>,
): Record<string, PossessBinding<Host>> {
  const fallback = (name: string, host: Host, args: readonly unknown[]): readonly unknown[] =>
    bindings[name]?.(host, args) ?? NOTHING;
  const slot = (name: string, answer: (model: FrameXmlPossessModel, index: number, args: readonly unknown[]) => readonly unknown[]):
    PossessBinding<Host> => (host, args) => {
    const model = possessOf(host);
    const index = model?.mirrorIndex(args[0]);
    return model && index !== undefined ? answer(model, index, args) : fallback(name, host, args);
  };
  const wrapped: Record<string, PossessBinding<Host>> = {
    HasAction: slot("HasAction", (model, index) => [model.hasAction(index)]),
    GetActionTexture: slot("GetActionTexture", (model, index) => {
      const texture = model.texture(index);
      return texture === undefined ? NOTHING : [texture];
    }),
    GetActionText: slot("GetActionText", () => NOTHING),
    GetActionCount: slot("GetActionCount", () => [0]),
    GetActionCooldown: slot("GetActionCooldown", (model, index) => [...model.cooldown(index)]),
    IsUsableAction: slot("IsUsableAction", (model, index) => [model.usable(index), false]),
    IsConsumableAction: slot("IsConsumableAction", () => [false]),
    IsStackableAction: slot("IsStackableAction", () => [false]),
    IsEquippedAction: slot("IsEquippedAction", () => [false]),
    IsCurrentAction: slot("IsCurrentAction", (model, index) => [model.current(index) ? 1 : undefined]),
    IsAttackAction: slot("IsAttackAction", (model, index) => [model.attack(index) ? 1 : undefined]),
    IsAutoRepeatAction: slot("IsAutoRepeatAction", () => [undefined]),
    IsActionInRange: slot("IsActionInRange", () => NOTHING),
    GetActionInfo: slot("GetActionInfo", (model, index) => model.actionInfo(index) ?? NOTHING),
    GetActionTooltip: slot("GetActionTooltip", (model, index) => {
      const row = model.tooltip(index);
      return row ? [row.kind, row.id, row.name, row.rank ?? ""] : NOTHING;
    }),
    UseAction: slot("UseAction", (model, index) => {
      model.use(index);
      return NOTHING;
    }),
    // 0x005abe70 never picks up slots 0x78–0x83, and the cursor's drop skips them (0x005abbc0).
    PickupAction: slot("PickupAction", () => NOTHING),
    PlaceAction: slot("PlaceAction", () => NOTHING),
    GetBonusBarOffset: (host, args) =>
      possessOf(host)?.onMainBar() ? [POSSESS_BONUS_BAR_OFFSET] : fallback("GetBonusBarOffset", host, args),
    GetActionBarPage: (host, args) => (possessOf(host)?.onMainBar() ? [1] : fallback("GetActionBarPage", host, args)),
    PetHasActionBar: (host, args) => (possessOf(host)?.onMainBar() ? NOTHING : fallback("PetHasActionBar", host, args)),
    IsPossessBarVisible: (host, args) => {
      const model = possessOf(host);
      return model ? [model.barVisible()] : fallback("IsPossessBarVisible", host, args);
    },
    GetPossessInfo: (host, args) => {
      const model = possessOf(host);
      if (!model) return fallback("GetPossessInfo", host, args);
      const index = typeof args[0] === "number" ? Math.trunc(args[0]) : Number(args[0]);
      return [...model.info(index)];
    },
    UnitIsPossessed: (host, args) => {
      const model = possessOf(host);
      return model && typeof args[0] === "string" ? [model.unitIsPossessed(args[0])] : fallback("UnitIsPossessed", host, args);
    },
    // 1 or nil (0x0060d7d0); UIParent.lua:2896 and the Escape handler read it for "player".
    UnitIsCharmed: (host, args) => {
      const model = possessOf(host);
      if (!model) return fallback("UnitIsCharmed", host, args);
      return typeof args[0] === "string" && model.unitIsCharmed(args[0]) ? [1] : NOTHING;
    },
    CancelUnitBuff: (host, args) => {
      const model = possessOf(host);
      if (model && typeof args[1] === "string" && model.cancelBuffByName(args[0], args[1], args[2], args[3])) return NOTHING;
      return fallback("CancelUnitBuff", host, args);
    },
  };
  return { ...bindings, ...wrapped };
}
