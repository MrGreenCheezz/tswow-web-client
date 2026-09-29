// What a spell looks like, resolved out of four tables into one record per spell.
//
// The chain the client walks is `Spell.SpellVisualID` → `SpellVisual` → `SpellVisualKit` →
// `SpellVisualEffectName` → a model path, and every step of it loses something if it is left for
// the browser: `SpellVisual` is 9,406 rows, `SpellVisualKit` 8,663 and `SpellVisualEffectName`
// 3,965, and a browser that had to hold all three to draw one fireball would be holding most of a
// megabyte to answer a question with two model paths in it. So the walk happens here and the
// browser is told the answer.
//
// Two things about the last table are worth knowing before reading any of this.
//
// The model paths end in `.mdx`, and no such file exists. That extension is Warcraft III's, and
// the client swaps it for `.m2` on the way to the archive: `Spells\SeedOfCorruption_State.mdx` is
// absent and `Spells\SeedOfCorruption_State.m2` is 5,440 bytes of MD20. 3,844 of the 3,965 rows
// name a `.mdx`; the other 110 name a `.mdl` and are all called `zzOLD__` something, and none of
// those files is in the archives either. So `.mdx` is renamed and everything else is dropped.
//
// And the effect columns of a kit are not interchangeable — each one names the place on the body
// the model hangs from. Measured on a human, a wolf and a murloc, the twelve attachment points a
// kit can ask for are present on all three: id 19 is the ground under the feet (exactly the
// origin on every model), 20 the head, 17 the mouth — the wolf's sits 1.39 forward of its body,
// which is the snout — 34 the chest, 21 and 22 the two spell hands. A creature with no gear still
// has every point a spell needs.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { openDbc, type Dbc } from "./Dbc.js";

/**
 * M2 attachment ids, as the twenty playable models and every creature number them.
 *
 * These are the ids a spell visual reaches for, which is a different set from the ones armour
 * uses — a sword hangs on `HAND_RIGHT`, a spell effect on `SPELL_RIGHT_HAND`, and on a human they
 * are 3 centimetres apart.
 */
export const ATTACH_BREATH = 17;
export const ATTACH_BASE = 19;
export const ATTACH_HEAD = 20;
export const ATTACH_SPELL_LEFT_HAND = 21;
export const ATTACH_SPELL_RIGHT_HAND = 22;
export const ATTACH_SPECIAL_TOP = 23;
export const ATTACH_SPECIAL_MIDDLE = 24;
export const ATTACH_SPECIAL_BOTTOM = 25;
export const ATTACH_CHEST = 34;
/** Not an attachment: the effect stands in the world rather than on anybody. */
export const ATTACH_WORLD = -1;

/** One model a kit hangs somewhere, with the scale the table asks for. */
export interface SpellVisualEffect {
  /** MPQ path, already renamed from the `.mdx` the table stores. */
  path: string;
  /** An `ATTACH_*` id, or `ATTACH_WORLD` for an effect that stands on its own. */
  attachment: number;
  scale: number;
  /**
   * Stable source occurrence for rows that can repeat an otherwise identical effect.
   *
   * This is deliberately not an array index: the model-attach DBC row id remains stable when
   * rows are merged from an override or their physical order changes.
   */
  occurrence?: string;
  /** Optional model-attach transform, in the M2 coordinate system and radians. */
  transform?: SpellVisualEffectTransform;
  /**
   * `SpellVisualEffectName.AreaEffectSize`, and only when it says something `Scale` does not.
   *
   * The name promises a radius in yards and the data refuses to be one. Measured on this dataset:
   * 2,928 of the 3,965 rows carry a non-zero value and 2,789 of those are exactly 1; across every
   * kit any of the three area columns names, 552 of the 588 authored values are 1. Of the 139 rows
   * that are neither 0 nor 1, all but ten repeat the row's own `Scale` verbatim. And the two spells the field would
   * be judged on disagree with the promise outright: Blizzard (spell 10) and Consecration (20116,
   * 26573) both resolve through `EffectRadiusIndex` to a `SpellRadius.Radius` of **8 yards**,
   * while their area models — `Blizzard_Spawn` and `consecration_impact_base` — carry
   * `AreaEffectSize` 1 and are already authored ~11 yards wide in their own header box.
   *
   * So it is carried as the raw table value and 1 is dropped: 1 is the identity, the only rule
   * that reads this cannot act on it (`areaEffectScale` in `SpellVisuals.ts`), and carrying it
   * would put `"areaSize":1` on 552 of 588 area placements for nothing. With the identity dropped
   * only 271 of the 81,239 effect placements across all 32,392 answered spells carry the key, and
   * the first 200-spell answer measured on this dataset grew by **zero** bytes.
   */
  areaSize?: number;
}

export interface SpellVisualEffectTransform {
  /** Translation relative to the selected M2 attachment point: x, y, z. */
  offset: readonly [number, number, number];
  /** Rotation in the DBC's yaw, pitch, roll order. */
  rotation: readonly [number, number, number];
}

/**
 * One `SpellVisualKit`: what to show and what the caster does while it shows.
 *
 * `animation` is an `AnimationData` id — the same numbering the client's own animation set uses,
 * so it goes straight to `playUnitEmote`. `startAnimation` is the one-shot that leads into it.
 */
export interface SpellVisualKit {
  startAnimation: number;
  animation: number;
  effects: SpellVisualEffect[];
  /**
   * `SoundID` — a `SoundEntries` row, or zero.
   *
   * The reason a spell was silent. `SMSG_PLAY_SPELL_VISUAL_KIT` names a kit and nothing else, so
   * without this the id arrives, is looked up, and finds a record with the picture in it and no
   * way at all to reach the noise. 2,243 of the 8,663 kits are sound and shake alone; those are
   * still dropped below, but the sound of a kit that *also* shows something now travels with it.
   */
  sound: number;
}

/**
 * One `SpellVisualKit` answered by its own id, for the packets that name a kit and no spell.
 *
 * `kit` is absent when the row resolves to nothing — the same shape the per-spell route uses for
 * "this spell shows nothing", and for the same reason: an answer with no content is still an
 * answer and the browser must be able to stop asking. The kit itself is the *identical* record one
 * phase of a per-spell answer carries, so both routes share one browser-side validator.
 */
export interface SpellVisualKitRecord {
  id: number;
  kit?: SpellVisualKit;
}

/** A missile: one model, flying from a point on the caster to a point on the target. */
export interface SpellVisualMissile {
  path: string;
  scale: number;
  /**
   * Where on the caster it leaves from. −1 on 1,258 of the 1,762 visuals that have a missile,
   * and one of 0..13 on the rest — a hand, an elbow, a shoulder — which is exactly the range of
   * places a bolt is thrown from.
   *
   * There is a matching `MissileDestinationAttachment` in the table and it is not carried, because
   * nothing here can read it: it is 1 on 74% of those visuals, 2 on 19% and 0 on 5%, and as M2
   * attachment ids those are the right hand, the left hand and the shield. A fireball does not
   * land on the target's off hand. Whatever the three values select, it is not an attachment, and
   * a missile is aimed at the middle of the target instead.
   *
   * Reading one of the pair and not the other is a real asymmetry, and it is deliberate rather
   * than an oversight. The two distributions are not alike: this one spreads over the whole
   * small-id range a throwing point plausibly occupies and is absent more often than not, while
   * its neighbour concentrates 98% of its mass on three values that name places nothing arrives
   * at. And the two failures are not alike either — a bolt that leaves from the wrong hand is a
   * bolt from the wrong hand, while one that lands on the wrong hand misses the target.
   */
  attachment: number;
  /**
   * Yards a second, from `Spell.Speed` — the only place the flight time is written down.
   *
   * Nothing on the wire says how long a bolt should be in the air: `SMSG_SPELL_GO` names the
   * caster, the spell and who was hit, and the server has already decided the outcome by the time
   * it sends it. The client works the duration out from this and the distance, which is why it is
   * carried here rather than left out as a property of the spell rather than of its picture.
   * Zero means the DBC did not author a usable speed; the planner applies one named positive
   * fallback for a non-zero distance so an authored missile is never silently dropped.
   */
  speed: number;
  /** SoundEntries row played when this missile is launched, or zero/absent. */
  sound?: number;
}

/**
 * Everything one spell shows, with the phases it has and no key for the phases it does not.
 *
 * A spell that only flashes on impact carries `impact` alone; the shape says so rather than
 * carrying five nulls.
 */
export interface SpellVisualMetadata {
  id: number;
  /** `SPELL_ATTR2_AUTOREPEAT_FLAG`: play a ranged release, not a generic spell cast. */
  autoRepeat?: boolean;
  precast?: SpellVisualKit;
  cast?: SpellVisualKit;
  impact?: SpellVisualKit;
  state?: SpellVisualKit;
  stateDone?: SpellVisualKit;
  channel?: SpellVisualKit;
  casterImpact?: SpellVisualKit;
  targetImpact?: SpellVisualKit;
  missileTargeting?: SpellVisualKit;
  instantArea?: SpellVisualKit;
  impactArea?: SpellVisualKit;
  persistentArea?: SpellVisualKit;
  missile?: SpellVisualMissile;
  /** SoundEntries ids authored directly on SpellVisual rather than on a kit. */
  missileSound?: number;
  animEventSound?: number;
  /** Resolved SpellDuration.Duration in milliseconds; zero means no finite DBC duration. */
  durationMs?: number;
}

/** Which effect column of a kit hangs on which attachment point. */
const KIT_EFFECTS = [
  ["HeadEffect", 0, ATTACH_HEAD],
  ["ChestEffect", 0, ATTACH_CHEST],
  ["BaseEffect", 0, ATTACH_BASE],
  ["LeftHandEffect", 0, ATTACH_SPELL_LEFT_HAND],
  ["RightHandEffect", 0, ATTACH_SPELL_RIGHT_HAND],
  ["BreathEffect", 0, ATTACH_BREATH],
  // The weapon effects hang where the weapon is, not where the spell hand is: a flaming sword
  // burns along the blade.
  ["LeftWeaponEffect", 0, 2],
  ["RightWeaponEffect", 0, 1],
  ["SpecialEffect", 0, ATTACH_SPECIAL_TOP],
  ["SpecialEffect", 1, ATTACH_SPECIAL_MIDDLE],
  ["SpecialEffect", 2, ATTACH_SPECIAL_BOTTOM],
  ["WorldEffect", 0, ATTACH_WORLD],
] as const;

/** The kit columns of a `SpellVisual`, and the phase each becomes. */
const VISUAL_KITS = [
  ["PrecastKit", "precast"],
  ["CastKit", "cast"],
  ["ImpactKit", "impact"],
  ["StateKit", "state"],
  ["StateDoneKit", "stateDone"],
  ["ChannelKit", "channel"],
  ["CasterImpactKit", "casterImpact"],
  ["TargetImpactKit", "targetImpact"],
  ["MissileTargetingKit", "missileTargeting"],
  ["InstantAreaKit", "instantArea"],
  ["ImpactAreaKit", "impactArea"],
  ["PersistentAreaKit", "persistentArea"],
] as const satisfies readonly (readonly [string, keyof SpellVisualMetadata])[];

/** `Spell.SpellVisualID` is two wide: the spell's own visual and the one it falls back to. */
const SPELL_VISUAL_SLOTS = 2;

/**
 * Model paths by `SpellVisualEffectName` id, with the dead rows left out.
 *
 * A row whose file is not a `.mdx` names something the archives do not contain, so it is dropped
 * here rather than turned into a request that will 404 on every cast.
 */
/** One row of `SpellVisualEffectName`, reduced to the three things a kit needs from it. */
interface EffectModel {
  path: string;
  scale: number;
  /** Zero when the table authored nothing usable, or authored its own identity. */
  areaSize: number;
}

function effectPaths(names: Dbc<"SpellVisualEffectName">): Map<number, EffectModel> {
  const paths = new Map<number, EffectModel>();
  for (const row of names.rows()) {
    const file = names.string(row, "FileName");
    const lower = file.toLowerCase();
    // Ten rows name a `.m2` outright and five of those are referenced; dropping everything that
    // was not `.mdx` cost seventeen spells their missile, `Missile_Wave_Ice` among them.
    if (!lower.endsWith(".mdx") && !lower.endsWith(".m2")) continue;
    const scale = names.float(row, "Scale");
    const areaSize = names.float(row, "AreaEffectSize");
    paths.set(names.id(row), {
      path: lower.endsWith(".m2") ? file : `${file.slice(0, -4)}.m2`,
      // A scale of zero would draw nothing; the table's own floor is 0.01.
      scale: Number.isFinite(scale) && scale > 0 ? scale : 1,
      // 1 is the table's identity and is dropped here rather than downstream; see `areaSize`.
      areaSize: Number.isFinite(areaSize) && areaSize > 0 && areaSize !== 1 ? areaSize : 0,
    });
  }
  return paths;
}

/** The optional half of one effect placement, kept in one place so both readers agree. */
function effectExtras(model: EffectModel): { areaSize?: number } {
  return model.areaSize > 0 ? { areaSize: model.areaSize } : {};
}

function readKits(
  kits: Dbc<"SpellVisualKit">,
  paths: ReadonlyMap<number, EffectModel>,
  modelAttaches: ReadonlyMap<number, readonly SpellVisualEffect[]> = new Map(),
): Map<number, SpellVisualKit> {
  const result = new Map<number, SpellVisualKit>();
  for (const row of kits.rows()) {
    const effects: SpellVisualEffect[] = [];
    for (const [field, index, attachment] of KIT_EFFECTS) {
      const model = paths.get(kits.int(row, field, index));
      if (model) effects.push({ path: model.path, attachment, scale: model.scale, ...effectExtras(model) });
    }
    effects.push(...(modelAttaches.get(kits.id(row)) ?? []));
    const startAnimation = kits.int(row, "StartAnimID");
    const animation = kits.int(row, "AnimID");
    const sound = Math.max(0, kits.int(row, "SoundID"));
    // A kit that shows nothing, asks for no pose and makes no noise is not a kit. Screen shake is
    // all that is left of those rows and this client does not shake the screen.
    if (effects.length === 0 && startAnimation < 0 && animation < 0 && sound === 0) continue;
    result.set(kits.id(row), { startAnimation, animation, effects, sound });
  }
  return result;
}

function readModelAttaches(
  attaches: Dbc<"SpellVisualKitModelAttach"> | undefined,
  paths: ReadonlyMap<number, EffectModel>,
): Map<number, SpellVisualEffect[]> {
  const result = new Map<number, SpellVisualEffect[]>();
  if (!attaches) return result;
  for (const row of attaches.rows()) {
    const model = paths.get(attaches.int(row, "SpellVisualEffectNameID"));
    if (!model) continue;
    const offset: [number, number, number] = [
      attaches.float(row, "OffsetX"), attaches.float(row, "OffsetY"), attaches.float(row, "OffsetZ"),
    ];
    const rotation: [number, number, number] = [
      attaches.float(row, "Yaw"), attaches.float(row, "Pitch"), attaches.float(row, "Roll"),
    ];
    // A malformed float must not be turned into an apparently authored zero: omitting the bad
    // placement leaves the rest of the kit truthful and makes the limitation observable.
    if (![...offset, ...rotation].every(Number.isFinite)) continue;
    const parent = attaches.int(row, "ParentSpellVisualKitID");
    const effects = result.get(parent) ?? [];
    effects.push({
      path: model.path,
      attachment: attachmentOr(attaches.int(row, "AttachmentID"), ATTACH_BASE),
      scale: model.scale,
      ...effectExtras(model),
      occurrence: `model-attach:${attaches.id(row)}`,
      // Keep the authored transform even when only one component is non-zero (as with Cone of
      // Cold's 90-degree pitch). The renderer applies this in the effect's local frame.
      transform: { offset, rotation },
    });
    result.set(parent, effects);
  }
  return result;
}

function buffer(payload: Uint8Array): Buffer {
  return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
}

/**
 * The three tables that decide what a kit *is*, resolved once.
 *
 * Both routes go through here rather than each doing its own walk: `/dbc/spell-visuals` needs the
 * model paths for the missile column as well, and `/dbc/spell-visual-kits` needs the kits alone,
 * but a kit answered by id and the same kit answered inside a spell have to be the same record —
 * otherwise the browser would hold two vocabularies for one thing and only one of them would be
 * tested.
 */
function resolveKitTables(
  kitPayload: Uint8Array,
  namePayload: Uint8Array,
  modelAttachPayload: Uint8Array | undefined,
): { paths: ReadonlyMap<number, EffectModel>; kitsById: Map<number, SpellVisualKit> } {
  const kits = openDbc(buffer(kitPayload), "SpellVisualKit");
  const names = openDbc(buffer(namePayload), "SpellVisualEffectName");
  const modelAttaches = modelAttachPayload
    ? openDbc(buffer(modelAttachPayload), "SpellVisualKitModelAttach") : undefined;
  const paths = effectPaths(names);
  return { paths, kitsById: readKits(kits, paths, readModelAttaches(modelAttaches, paths)) };
}

/** Every resolvable kit, by `SpellVisualKit` id — the answer `/dbc/spell-visual-kits` indexes. */
export function parseSpellVisualKits(
  kitPayload: Uint8Array,
  namePayload: Uint8Array,
  modelAttachPayload?: Uint8Array,
): Map<number, SpellVisualKit> {
  return resolveKitTables(kitPayload, namePayload, modelAttachPayload).kitsById;
}

export function parseSpellVisuals(
  spellPayload: Uint8Array,
  visualPayload: Uint8Array,
  kitPayload: Uint8Array,
  namePayload: Uint8Array,
  durationPayload?: Uint8Array,
  modelAttachPayload?: Uint8Array,
): Map<number, SpellVisualMetadata> {
  const spells = openDbc(buffer(spellPayload), "Spell");
  const visuals = openDbc(buffer(visualPayload), "SpellVisual");
  const durations = durationPayload ? openDbc(buffer(durationPayload), "SpellDuration") : undefined;

  const durationById = new Map<number, number>();
  if (durations) {
    for (const row of durations.rows()) durationById.set(durations.id(row), durations.int(row, "Duration"));
  }

  const { paths, kitsById } = resolveKitTables(kitPayload, namePayload, modelAttachPayload);

  // One record per visual, built once and then shared by every spell that names it — 27,133
  // spells reach 9,406 visuals, so building per spell would build each one three times over.
  const byVisual = new Map<number, Omit<SpellVisualMetadata, "id">>();
  for (const row of visuals.rows()) {
    const record: Omit<SpellVisualMetadata, "id"> = {};
    for (const [field, phase] of VISUAL_KITS) {
      const kit = kitsById.get(visuals.int(row, field));
      if (kit) Object.assign(record, { [phase]: kit });
    }
    const missile = paths.get(visuals.int(row, "MissileModel"));
    if (missile) {
      record.missile = {
        path: missile.path,
        scale: missile.scale,
        attachment: attachmentOr(visuals.int(row, "MissileAttachment"), ATTACH_SPELL_RIGHT_HAND),
        // Filled in per spell below: the speed belongs to the spell, not to the visual, and one
        // visual is shared by many spells.
        speed: 0,
      };
    }
    const missileSound = Math.max(0, visuals.int(row, "MissileSound"));
    const animEventSound = Math.max(0, visuals.int(row, "AnimEventSoundID"));
    if (record.missile && missileSound > 0) record.missile = { ...record.missile, sound: missileSound };
    if (missileSound > 0) record.missileSound = missileSound;
    if (animEventSound > 0) record.animEventSound = animEventSound;
    if (Object.keys(record).length > 0) byVisual.set(visuals.id(row), record);
  }

  const result = new Map<number, SpellVisualMetadata>();
  for (const row of spells.rows()) {
    const merged: SpellVisualMetadata = { id: spells.id(row) };
    let found = false;
    // The auto-repeat rows deliberately have no SpellVisualID. The attribute is nevertheless
    // authored animation semantics: their repeated SPELL_GO releases a bow/gun/wand attack and
    // must not fall through to a generic spell cast.
    if ((spells.int(row, "AttributesExB") & 0x00000020) !== 0) {
      merged.autoRepeat = true;
      found = true;
    }
    // The second slot fills only what the first left empty: a spell that overrides its cast
    // keeps its fallback's impact.
    for (let slot = 0; slot < SPELL_VISUAL_SLOTS; slot++) {
      const visual = byVisual.get(spells.int(row, "SpellVisualID", slot));
      if (!visual) continue;
      for (const [key, value] of Object.entries(visual)) {
        if (merged[key as keyof SpellVisualMetadata] === undefined) {
          Object.assign(merged, { [key]: value });
          found = true;
        }
      }
    }
    // The visual record is shared, so the speed is copied onto a record of this spell's own
    // rather than written into the one every other spell using that visual can see.
    if (merged.missile) {
      const speed = spells.float(row, "Speed");
      merged.missile = { ...merged.missile, speed: Number.isFinite(speed) && speed > 0 ? speed : 0 };
    }
    const duration = durationById.get(spells.int(row, "DurationIndex"));
    if (duration !== undefined) merged.durationMs = Number.isFinite(duration) && duration > 0 ? duration : 0;
    if (found) result.set(merged.id, merged);
  }
  return result;
}

/** An attachment the table gives as −1 or out of range falls back to a point every model has. */
function attachmentOr(value: number, fallback: number): number {
  return Number.isInteger(value) && value >= 0 && value <= 63 ? value : fallback;
}

/**
 * `SpellVisualKitModelAttach`, from the visual override directory when one is configured.
 *
 * One reader for both loaders: a kit answered by id must carry the same authored transforms the
 * same kit carries inside a spell, and that is decided entirely by which copy of this table won.
 */
async function readModelAttachTable(
  directory: string,
  visualDbcDirectory: string,
): Promise<Buffer | undefined> {
  if (visualDbcDirectory !== directory) {
    const override = await readFile(join(visualDbcDirectory, "SpellVisualKitModelAttach.dbc"))
      .catch(() => undefined);
    if (override) return override;
  }
  return readFile(join(directory, "SpellVisualKitModelAttach.dbc")).catch(() => undefined);
}

export async function loadSpellVisuals(directory: string, visualDbcDirectory = directory): Promise<Map<number, SpellVisualMetadata>> {
  const [spells, visuals, kits, names, durations, modelAttaches] = await Promise.all([
    readFile(join(directory, "Spell.dbc")),
    readFile(join(directory, "SpellVisual.dbc")),
    readFile(join(directory, "SpellVisualKit.dbc")),
    readFile(join(directory, "SpellVisualEffectName.dbc")),
    readFile(join(directory, "SpellDuration.dbc")).catch(() => undefined),
    readModelAttachTable(directory, visualDbcDirectory),
  ]);
  return parseSpellVisuals(spells, visuals, kits, names, durations, modelAttaches);
}

/**
 * Every kit the dataset can resolve, keyed by `SpellVisualKit` id.
 *
 * Three files instead of six: neither `Spell` nor `SpellVisual` says anything about a kit that is
 * named by number. Measured on this dataset: 8,663 kit rows, 8,217 of which resolve to something
 * with a model, a pose or a sound in it, and 7,023 of those are reachable from some `Spell` row —
 * so 1,194 resolvable kits were reachable through no route this client had at all.
 */
export async function loadSpellVisualKits(directory: string, visualDbcDirectory = directory): Promise<Map<number, SpellVisualKit>> {
  const [kits, names, modelAttaches] = await Promise.all([
    readFile(join(directory, "SpellVisualKit.dbc")),
    readFile(join(directory, "SpellVisualEffectName.dbc")),
    readModelAttachTable(directory, visualDbcDirectory),
  ]);
  return parseSpellVisualKits(kits, names, modelAttaches);
}
