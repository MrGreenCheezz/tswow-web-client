/**
 * The offline companion fixture for the canned world: two mounts and one critter — measured rows of
 * this dataset's Spell.dbc, SpellIcon.dbc and SkillLineAbility.dbc — and a stand-in realm that
 * answers a cast, a dismount and a critter dismissal with the core's own outcomes, so the stock
 * page (PetPaperDollFrame.xml) can be driven with no server. `companionWorld` scripts learning,
 * forgetting and summoning from tests and the `framexml.html` previews.
 */
import {
  FrameXmlCompanionModel, type FrameXmlCompanionSpell, type FrameXmlCompanionType,
} from "./FrameXmlCompanions.js";

export interface CannedCompanionSpell extends FrameXmlCompanionSpell {
  readonly id: number;
  /** The spell's `SkillLineAbility` rows: 777 for the mounts, 778 for the critter. */
  readonly skillLines: readonly number[];
}

/**
 * Measured (tools/dbc.mjs over the configured dataset, 2026-09-28): `Name_lang` ruRU,
 * `SpellIcon.TextureFilename`, `Effect`, `EffectAura` and `EffectMiscValue` of 458, 580 and 4055.
 * 580 «Большой лесной волк» sorts before 458 «Гнедой конь», so the mount order is the name's, not the id's.
 */
export const CANNED_COMPANION_SPELLS: readonly CannedCompanionSpell[] = Object.freeze([
  Object.freeze({
    id: 458, name: "Гнедой конь", iconPath: "Interface\\Icons\\Ability_Mount_RidingHorse",
    effects: [6, 6, 0], effectAura: [78, 32, 0], effectMiscValue: [284, 0, 0], skillLines: [777],
  }),
  Object.freeze({
    id: 580, name: "Большой лесной волк", iconPath: "Interface\\Icons\\Ability_Mount_BlackDireWolf",
    effects: [6, 6, 0], effectAura: [78, 32, 0], effectMiscValue: [358, 0, 0], skillLines: [777],
  }),
  Object.freeze({
    id: 4055, name: "Механическая белка", iconPath: "Interface\\Icons\\INV_Crate_01",
    effects: [28, 0, 0], effectAura: [0, 0, 0], effectMiscValue: [2671, 0, 0], skillLines: [778],
  }),
]);

/** The unit guid the stand-in realm gives a summoned critter; a creature guid, never sent anywhere. */
export const CANNED_COMPANION_CRITTER_GUID = 0xF130000A6F000C01n;

/**
 * The rest of the canned book, as one known spell that is no companion: the canned bar's
 * «Кровопускание» (CannedWorldSeam.ts). It keeps the known list non-empty after `forgetAll`, so the
 * first companion learned afterwards is a learning (COMPANION_LEARNED) and not the initial spell
 * list, which the model publishes as COMPANION_UPDATE alone (FrameXmlCompanions.ts).
 */
const BOOK_FILLER = Object.freeze({ id: 772, name: "Кровопускание", iconPath: "" });

export type CannedCompanionRequest =
  | readonly ["cast", number]
  | readonly ["dismiss", bigint]
  | readonly ["pickup", number, FrameXmlCompanionType, number];

export interface CannedFrameXmlCompanionWorld {
  /** What the stand-in realm was asked, in order. */
  readonly sent: readonly CannedCompanionRequest[];
  /** The known companion spell ids now. */
  known(): readonly number[];
  /** SMSG_LEARNED_SPELL / SMSG_REMOVED_SPELL of a fixture spell: the known list is replaced, as WorldClient replaces it. */
  learn(spellId: number): void;
  forget(spellId: number): void;
  /** A character with no companion at all. */
  forgetAll(): void;
  /** The realm's outcome of a mount cast: the aura and the mount display, or none. */
  mounted(): number | undefined;
  /** The realm's outcome of a critter cast: the unit in view, or none. */
  critterOut(): number | undefined;
}

export interface CannedFrameXmlCompanionsOptions {
  /** The seam's cursor: `PickupCompanion` puts the spell there. */
  readonly pickup: (spellId: number, type: FrameXmlCompanionType, index: number) => void;
  /** The seam's own cast log, so a companion cast is visible where every other canned cast is. */
  readonly onCast?: (spellId: number) => void;
  readonly locale?: () => string;
}

export interface CannedFrameXmlCompanions {
  readonly model: FrameXmlCompanionModel;
  readonly world: CannedFrameXmlCompanionWorld;
}

export function createCannedFrameXmlCompanions(options: CannedFrameXmlCompanionsOptions): CannedFrameXmlCompanions {
  const rows = new Map(CANNED_COMPANION_SPELLS.map((spell) => [spell.id, spell]));
  // Replaced, never mutated: WorldClient publishes a new `knownSpells` array on every change and
  // the model reads that identity as its change signal.
  let known: readonly { readonly id: number }[] = [BOOK_FILLER, ...CANNED_COMPANION_SPELLS].map(({ id }) => ({ id }));
  const sent: CannedCompanionRequest[] = [];
  let mounted: number | undefined;
  let critterOut: number | undefined;
  const model = new FrameXmlCompanionModel({
    knownSpells: () => known,
    spell: (id) => rows.get(id) ?? (id === BOOK_FILLER.id ? BOOK_FILLER : undefined),
    skillLines: (id) => rows.get(id)?.skillLines ?? [],
    mounted: () => mounted !== undefined,
    hasAura: (spellId) => mounted === spellId,
    forEachSummon: (visit) => { if (critterOut !== undefined) visit(critterOut, CANNED_COMPANION_CRITTER_GUID); },
    // The core's outcomes: a mount's spell mounts, the worn mount's spell again dismounts
    // (WorldClient sends CMSG_CANCEL_MOUNT_AURA for it), a critter's spell summons it and, cast
    // again, unsummons it (Spell::EffectSummonType's MINIPET rule).
    cast: (spellId) => {
      sent.push(["cast", spellId]);
      options.onCast?.(spellId);
      const row = rows.get(spellId);
      if (!row || !known.some((spell) => spell.id === spellId)) return;
      if (row.skillLines.includes(777)) mounted = mounted === spellId ? undefined : spellId;
      else critterOut = critterOut === spellId ? undefined : spellId;
      model.reconcile();
    },
    dismissCritter: (guid) => {
      sent.push(["dismiss", guid]);
      if (guid === CANNED_COMPANION_CRITTER_GUID) critterOut = undefined;
      model.reconcile();
    },
    cooldown: () => [0, 0, 0],
    pickup: (spellId, type, index) => {
      sent.push(["pickup", spellId, type, index]);
      options.pickup(spellId, type, index);
    },
    ...(options.locale ? { locale: options.locale } : {}),
  });
  const companions = (): readonly number[] => known.map(({ id }) => id).filter((id) => id !== BOOK_FILLER.id);
  const replace = (next: readonly number[]): void => {
    known = [BOOK_FILLER.id, ...next].map((id) => ({ id }));
    if (mounted !== undefined && !next.includes(mounted)) mounted = undefined;
    if (critterOut !== undefined && !next.includes(critterOut)) critterOut = undefined;
    model.reconcile();
  };
  const world: CannedFrameXmlCompanionWorld = {
    sent,
    known: companions,
    learn: (spellId) => {
      if (!rows.has(spellId) || known.some((spell) => spell.id === spellId)) return;
      replace([...companions(), spellId]);
    },
    forget: (spellId) => {
      if (!rows.has(spellId) || !known.some((spell) => spell.id === spellId)) return;
      replace(companions().filter((id) => id !== spellId));
    },
    forgetAll: () => replace([]),
    mounted: () => mounted,
    critterOut: () => critterOut,
  };
  return { model, world };
}
