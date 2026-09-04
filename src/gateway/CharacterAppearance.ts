// Everything one character's look needs, resolved from the DBCs and sent as a description
// rather than a picture.
//
// The client composes a character's body from a 512x512 base skin with the face, facial hair and
// underwear painted over it in fixed rectangles, then shows exactly one geoset out of each
// family. Neither half existed here: only the base skin and the hair texture were looked up, so
// a face had no eyes or mouth, and no geoset was ever chosen, so every hairstyle, beard, glove
// and cloak in the file drew at once — twelve hairstyles and twelve cloaks on a tauren.
//
// The layers and the geoset choices go to the browser as data. It already fetches each texture
// by path, so the pieces stay shared between every character that uses them and the composite
// costs nothing on disk.

import { openDbcFile } from "./Dbc.js";
import { validAssetPath } from "./AssetPath.js";
import type { CharacterTextureIndex } from "./CharacterTextures.js";

/**
 * Where each piece lands on the 512x512 body texture.
 *
 * 3.3.5 has no CharComponentTextureSections — that table starts at build 3.4.1 — so the client
 * hardcodes this. Confirmed against the models rather than taken on trust: the UV bounding box of
 * every geoset family in HumanMale falls inside the rectangle named here, and the shipped BLPs
 * are exactly these sizes (FaceLower 256x128, FaceUpper 256x64, NakedPelvisSkin 256x128).
 */
export const BODY_TEXTURE_SIZE = 512;
export const BODY_SECTIONS = {
  armUpper: { x: 0, y: 0, width: 256, height: 128 },
  armLower: { x: 0, y: 128, width: 256, height: 128 },
  hand: { x: 0, y: 256, width: 256, height: 64 },
  faceUpper: { x: 0, y: 320, width: 256, height: 64 },
  faceLower: { x: 0, y: 384, width: 256, height: 128 },
  torsoUpper: { x: 256, y: 0, width: 256, height: 128 },
  torsoLower: { x: 256, y: 128, width: 256, height: 64 },
  legUpper: { x: 256, y: 192, width: 256, height: 128 },
  legLower: { x: 256, y: 320, width: 256, height: 128 },
  foot: { x: 256, y: 448, width: 256, height: 64 },
} as const;

export type BodySection = keyof typeof BODY_SECTIONS;

/** CharSections.BaseSection. */
const SECTION_SKIN = 0;
const SECTION_FACE = 1;
const SECTION_FACIAL_HAIR = 2;
const SECTION_HAIR = 3;
const SECTION_UNDERWEAR = 4;

/**
 * CharSections.Flags: this row may be chosen on the creation screen.
 *
 * The core's own name and value (`DBCStructure.h:322-326`), read by `Player::ValidateAppearance`
 * as `create && !entry->HasFlag(SECTION_FLAG_PLAYER) → false` (`Player.cpp:27273-27275`) — a
 * refusal that never looks at the class, so a row without it is refused for everybody, death
 * knights included. Its sibling `SECTION_FLAG_DEATH_KNIGHT` (0x04) is the class-dependent half
 * and is deliberately not applied here; see `options`.
 */
const SECTION_FLAG_PLAYER = 0x01;

/** One texture painted onto the body atlas, or the whole of it when `section` is absent. */
export interface BodyLayer {
  path: string;
  /** Absent means the layer is the full 512x512 base. */
  section?: BodySection;
  /**
   * Tried when `path` is not in the client. An item's component textures carry a gender suffix,
   * `_M`/`_F` when the piece differs and `_U` when it does not, and only the archives know which
   * a given item shipped as — so both are offered and the browser uses whichever answers.
   *
   * Kept beside `candidates` rather than replaced by it: a page built before Т7 reads these two
   * fields and nothing else, and the pair is exactly `candidates[0]` and `candidates[1]`.
   */
  alternate?: string;
  /**
   * Every spelling to try, in the order the archives say to try them.
   *
   * Present only where there is a choice to make — an item's component textures — because
   * `path`/`alternate` alone cannot say which of the two exists. With a listing of the archives to
   * hand the gateway puts the one that is really there first; without one it offers the same two
   * spellings in the same order as before, so this is never worse and is usually one round trip
   * instead of two. Three first requests in four used to be a guaranteed 404; `#paint` carries the
   * measurement.
   */
  candidates?: string[];
}

export interface CharacterAppearance {
  /** Painted in order onto one 512x512 texture, which becomes the model's type 1 slot. */
  body: BodyLayer[];
  /** The type 6 slot: the hair mesh's own texture. */
  hair: string;
  /**
   * The type 2 slot, which on a character model drives the cloak geosets and nothing else.
   * Empty when nothing is worn on the back — geoset 1501, the collar a cloak's clasp covers, is
   * painted from the body atlas instead.
   */
  cloak: string;
  /**
   * The type 8 slot: the second texture on the skin's own `CharSections` row, `…_Extra.blp`.
   *
   * Two of the twenty playable models declare it and they are the only two that declare no hair
   * slot: TaurenMale and TaurenFemale are `[0,1,2,8]` where the other eighteen are `[0,1,2,6]`.
   * Measured against the configured client's models: with this empty a naked tauren male
   * draws 166 of its 1,196 triangles flat green — 94 and 22 on geoset 0 and 50 on geoset 1501,
   * which are the horns, part of the hide and the cloak collar — and a female 132 of 1,224. All
   * 42 tauren skin rows name the file (19 distinct ones) and all 19 are in the archives; among the
   * other eighteen playable profiles not one skin row names it, which is exactly the set with no
   * slot 8. Three non-playable races do use it — Naga, Taunka and NorthrendSkeleton, all of which
   * a creature display can wear. `entity_spawner.cpp:1587-1607` fills the slot the same way.
   *
   * Optional rather than validated, and the choice is between exactly those two. This interface is
   * also the wire shape of `/dbc/character-appearance`, and a browser newer than the gateway it is
   * talking to receives an answer without the field: the gateway ignores the `v=3` it does not
   * know. `isAppearance` (`CreatureModelClient.ts`) rejects a whole display record that fails
   * validation, so demanding a string there would turn a tauren with green horns into a tauren
   * that is a grey capsule — strictly worse. The three readers all spell the absence out instead:
   * `appearanceKey` hashes `?? ""`, `characterSlots` fills the slot only when it is truthy, and
   * `forNpc` carries whatever `forPlayer` produced through the bake.
   */
  skinExtra?: string;
  /**
   * The appearance rows and the model archives are one coordinated visual pack. Optional so an
   * older/classic gateway keeps its original wire shape and model-specific corrections stay off.
   */
  coordinatedVisuals?: true;
  /**
   * Geoset ids to draw. Everything else in the model stays hidden — which is the whole point,
   * since a character file carries every variant of every family.
   */
  geosets: number[];
  /** Helmets, pauldrons and weapons: models of their own, hung off the character's bones. */
  attached: AttachedModel[];
}

/**
 * What the creation form may offer for one race and sex: the indices that have a row, listed.
 *
 * Lists rather than counts, and the difference is 1,900 offered looks the tables cannot describe —
 * see `options()`, which is where every number behind this shape was measured.
 */
export interface CharacterOptions {
  /** `CharSections` base 0 colours that also have at least one face. */
  skins: number[];
  /** Every face that has a row at some offered skin. `facesBySkin` is the one that binds. */
  faces: number[];
  hairStyles: number[];
  hairColors: number[];
  /** `CharacterFacialHairStyles` variations, which is what decides whether anything is drawn. */
  facialHairs: number[];
  /**
   * The faces each skin really has, because a face row is keyed on the pair.
   *
   * The union in `faces` is what any skin might offer; this is what a given one does. On this
   * dataset the two differ for the death-knight skins alone — 780 (face, skin) pairs of the
   * offered rectangle have no row, and all of them are there.
   */
  facesBySkin: Record<number, number[]>;
}

/**
 * Geoset families. An id is `family * 100 + variant`, and family 0 — ids 0 to 25 — is the
 * hairstyle, not equipment.
 *
 * Read off the models rather than a wiki: parsing every submesh of the twenty playable
 * `Character\<Race>\<Sex>` profiles gives families 0..5, 7..13, 15, 17 and 18 and nothing else,
 * and the UV rectangle each one occupies on HumanMale says what it is — 4 covers the forearm and
 * hand (a gauntlet), 5 the lower leg and foot (a boot), 7 the ear, 8 the forearm (a sleeve), 9
 * the knee, 10 the lower torso (a shirt hem), 11 the upper leg (trousers), 12 a narrow strip down
 * the torso (a tabard), 13 both leg sections (1302 is a full-length skirt), 15 the shoulders (a
 * cloak), 18 the waist (a belt). Families 6, 14 and 16 do not exist in any playable model.
 *
 * **Family 20 is the coordinated HD pack's own, and it is the whole of HD-1's missing legs.** Ten
 * of the twenty active patch-W profiles have taken the foot out of geoset 0 and authored it as a
 * family-20 mesh: measured on 2026-08-30 against F:/Circle, HumanMale's geoset 0 spans z 0.71..2.02
 * where the classic one spans -0.00..1.96, and the 630 triangles between z 0.00 and 0.13 are geoset
 * 2001, whose UV box is 258..510 x 448..511 — exactly the `foot` rectangle. Counting triangles in
 * that rectangle over the twenty profiles, those ten have **no** geoset-0 triangle in it at all,
 * so with nothing emitting family 20 an HD human, orc, dwarf, gnome male or blood elf stood on
 * bare stumps. See `FOOT_GEOSET_PROFILES`.
 */
const FAMILY_HAIR = 0;
const FAMILY_FACIAL_1 = 1;
const FAMILY_FACIAL_2 = 2;
const FAMILY_FACIAL_3 = 3;
const FAMILY_GLOVES = 4;
const FAMILY_BOOTS = 5;
const FAMILY_EARS = 7;
const FAMILY_SLEEVES = 8;
const FAMILY_KNEEPADS = 9;
const FAMILY_SHIRT_HEM = 10;
const FAMILY_TROUSERS = 11;
const FAMILY_TABARD = 12;
const FAMILY_LEGS = 13;
const FAMILY_CLOAK = 15;
const FAMILY_EYE_GLOW = 17;
const FAMILY_BELT = 18;
const FAMILY_FEET = 20;

/**
 * The installed HD non-hoof profiles' fifth boot variant carries the foot section, while Tauren's
 * fifth is the only authored worn shaft. The old group variants either stop at the ankle or are
 * absent, so an item with an `_FO` component silently painted pixels that no selected triangles
 * could sample. This is a measured profile table, not a family-wide 501 -> 505 fallback: Troll and
 * Draenei retain their authored bare/hoof spellings, and Tauren keeps its own authored variants.
 */
const FOOT_TEXTURE_BOOT_VARIANT = 5;
const FOOT_TEXTURE_PROFILES = new Set([
  "1/0", "1/1", // Human
  "2/0", "2/1", // Orc
  "3/0", "3/1", // Dwarf
  "4/0", "4/1", // Night Elf
  "5/0", "5/1", // Scourge
  "7/0", "7/1", // Gnome
  "10/0", "10/1", // Blood Elf
]);

/**
 * The foot mesh each coordinated HD profile authored outside geoset 0, by `race/sex`.
 *
 * A profile table and not a family fallback, for two reasons that are both measured rather than
 * argued. First, the variant is not constant: nine of the ten name 2001 and **DwarfMale names
 * 2002**, its only family-20 member. Second, family 20 is not only the foot — NightElfFemale's
 * 2002 is 396 triangles at z 2.04..2.17 over UV 36..507 x 12..506 (the crown) and GnomeMale's is
 * 486 triangles at z 0.75..0.79 — so `resolveGeosetId`'s "lowest member of the family" rule would
 * put a scalp piece on a dwarf's ankle. Each entry below is the one id whose triangles fall inside
 * the `foot` rectangle of the body atlas, with its triangle count and z range measured on
 * 2026-08-30 against F:/Circle:
 *
 *   1/0 HumanMale 2001 (630t, 0.00..0.13)      1/1 HumanFemale 2001 (330t, -0.01..0.10)
 *   2/0 OrcMale 2001 (532t, -0.01..0.23)       2/1 OrcFemale 2001 (512t, -0.00..0.14)
 *   3/0 DwarfMale 2002 (244t, -0.00..0.16)     3/1 DwarfFemale 2001 (264t, -0.00..0.13)
 *   4/1 NightElfFemale 2001 (392t, -0.00..0.14)   7/0 GnomeMale 2001 (440t, -0.00..0.08)
 *   10/0 BloodElfMale 2001 (282t, 0.00..0.14)  10/1 BloodElfFemale 2001 (276t, -0.00..0.12)
 *
 * The other ten profiles are deliberately absent: NightElfMale, both Scourge, both Tauren,
 * GnomeFemale, both Troll and both Draenei keep the foot inside geoset 0 in the active pack exactly
 * as classic does — 386, 324, 249, 420, 400, 448, 408, 512, 256 and 116 geoset-0 triangles in the
 * `foot` rectangle respectively — and none of them carries a family 20 at all.
 */
const FOOT_GEOSET_PROFILES: ReadonlyMap<string, number> = new Map([
  ["1/0", 1], ["1/1", 1],
  ["2/0", 1], ["2/1", 1],
  ["3/0", 2], ["3/1", 1],
  ["4/1", 1],
  ["7/0", 1],
  ["10/0", 1], ["10/1", 1],
]);

/**
 * Active patch-W carries only the equipped-belt variant for these profiles. The table is used
 * solely when an item actually selects family 18: a naked look still requests semantic variant 1,
 * and the browser drops it when the model has no 1801 instead of inventing a worn 1802.
 *
 * Re-measured on 2026-08-30 against the active F:/Circle chain and unchanged: these eight are
 * exactly the profiles whose family 18 is `[1802]`, eleven others carry `[1801, 1802]`, and
 * GnomeMale (7/0) carries no family 18 at all. Measured topology is decisive here: every one of
 * those eight 1802 meshes closes zero body/leg boundary edges and samples BODY over the clothing
 * atlas, while the authored 1801 meshes close the actual waist seam.
 */
const BELT_1802_PROFILES = new Set([
  "1/1", // HumanFemale
  "2/0", // OrcMale
  "3/0", // DwarfMale
  "4/1", // NightElfFemale
  "5/1", // ScourgeFemale
  "6/1", // TaurenFemale
  "7/1", // GnomeFemale
  "10/0", // BloodElfMale
]);

/** An id from a family and the variant number an item or a default names. */
function geosetId(family: number, variant: number): number {
  return family * 100 + variant;
}

/**
 * The scalp cap: the top of the skull, in family 0 beside the hairstyles.
 *
 * Not a hairstyle and not the body. On HumanMale it is 44 triangles spanning z 1.90-2.02 and
 * sampling the body atlas over the faceUpper and faceLower rectangles, where geoset 0 stops at
 * 1.95 and the hairstyles reach 2.03. Eleven of the twenty playable models carry it and no
 * `CharHairGeosets` row in any of them names it, which is why nothing has ever drawn it.
 */
const SCALP_GEOSET = 1;

/**
 * What a character with nothing equipped shows, by family.
 *
 * Families this omits — sleeves, kneepads, the shirt hem, trousers and the tabard — have no
 * neutral variant in any model, so bare skin is genuinely "draw nothing" for them. The waist is
 * seeded separately below as semantic variant 1: models that author 1801 use it as their body/leg
 * bridge, while a model that carries only the worn 1802 draws no naked belt. The families listed
 * here do have a bare variant, and leaving them out is what left a character with no hands and no
 * feet.
 *
 * The ears default to variant 2, not 1. Measured on every race: 701 is a 2 to 10 triangle plug and
 * 702 is the real ear — HumanMale 6 vs 14 triangles, TaurenMale 4 vs 20 — and NightElf and Troll
 * carry no 701 at all. 701 is what a helm leaves behind, not what an ear looks like.
 *
 * This doubles as the list of families that have a variant 1 at all. The others start at 2 in
 * every one of the twenty playable models, so when an item resolves one of them to variant 1 the
 * answer is "this garment has no geometry of its own" rather than "show the plain version".
 */
const NAKED_VARIANTS: ReadonlyMap<number, number> = new Map([
  [FAMILY_GLOVES, 1],
  [FAMILY_BOOTS, 1],
  [FAMILY_EARS, 2],
  [FAMILY_LEGS, 1],
  [FAMILY_CLOAK, 1],
]);

/**
 * Where each of ItemDisplayInfo's eight component textures lands on the body.
 *
 * The order is the table's own and is confirmed by the filenames: the client suffixes each with
 * the region it belongs to — `_AU`, `_AL`, `_HA`, `_TU`, `_TL`, `_LU`, `_LL`, `_FO` — and every
 * one of them lines up with the slot at the same index.
 */
const COMPONENT_SECTIONS: readonly BodySection[] = [
  "armUpper", "armLower", "hand", "torsoUpper", "torsoLower", "legUpper", "legLower", "foot",
];
const COMPONENT_DIRECTORIES = [
  "ArmUpperTexture", "ArmLowerTexture", "HandTexture", "TorsoUpperTexture",
  "TorsoLowerTexture", "LegUpperTexture", "LegLowerTexture", "FootTexture",
] as const;

/**
 * What one inventory slot contributes to a character: which body rectangles its component
 * textures may paint, and which geoset family each of its three GeosetGroup values drives.
 *
 * **The component mask is not decoration.** An ItemDisplayInfo row routinely carries the whole
 * armour set's eight components even though the item is one piece of it: 499 of 2,054 head items,
 * 436 of 2,139 gloves and 339 of 1,913 shoulders name a section outside their own slot. Painting
 * all eight unconditionally puts 26.7 % of layers on the wrong part of the body — a Dark Iron Helm
 * repaints the torso, legs and arms of whoever wears it. The masks here are the sections each slot
 * actually fills, measured over 16,882 equippable items. The waist is the clearest case: every
 * belt fills legUpper, one in twenty also fills torsoLower, and none of them fills anything else.
 *
 * The families are anchored on the UV rectangle each one occupies (see the family constants
 * above). Variant numbers alone cannot distinguish them — several families carry variants 1 to 5
 * on every race — so a wrong entry here would survive a coverage test. The failure is safe either
 * way: a geoset id the model does not carry is simply not drawn.
 */
interface SlotAppearance {
  /** Indices into COMPONENT_SECTIONS this slot is allowed to paint. */
  readonly components: readonly number[];
  /** Geoset family per GeosetGroup index, or undefined where the slot drives none. */
  readonly families: readonly (number | undefined)[];
}

const SLOT_APPEARANCE: Readonly<Record<number, SlotAppearance>> = {
  // shirt
  4: { components: [0, 1, 3, 4], families: [FAMILY_SLEEVES] },
  // chest
  5: { components: [0, 1, 3, 4], families: [FAMILY_SLEEVES, FAMILY_SHIRT_HEM, FAMILY_LEGS] },
  // waist
  6: { components: [4, 5], families: [FAMILY_BELT] },
  // legs
  7: { components: [5, 6], families: [FAMILY_TROUSERS, FAMILY_KNEEPADS, FAMILY_LEGS] },
  // feet
  8: { components: [6, 7], families: [FAMILY_BOOTS] },
  // wrists: a bracer is texture only, it has no geometry of its own
  9: { components: [1], families: [] },
  // hands
  10: { components: [1, 2], families: [FAMILY_GLOVES] },
  // back: a cloak is a mesh with its own texture, never a body layer
  16: { components: [], families: [FAMILY_CLOAK] },
  // tabard
  19: { components: [3, 4], families: [FAMILY_TABARD] },
  // robe: a chest piece that also owns the legs
  20: { components: [0, 1, 3, 4, 5, 6], families: [FAMILY_SLEEVES, FAMILY_SHIRT_HEM, FAMILY_LEGS] },
};

/**
 * The order equipment paints in, innermost first.
 *
 * Twenty-one pairs of slots can land on the same rectangle. Most have an obvious answer: on
 * armLower a chest's sleeve goes under a bracer goes under a gauntlet; on legUpper a belt goes
 * over trousers; on legLower a boot goes over trousers; on the torso a shirt goes under a chest
 * piece goes under a tabard.
 *
 * The one that is not obvious is the robe against the trousers, and it has to agree with the
 * geosets or the picture contradicts itself. A robe wins family 13, so the skirt that is drawn is
 * the robe's — and geoset 1302's triangles land entirely in the legUpper and legLower rectangles,
 * so whatever paints there last is what the skirt wears. With the robe painting first, 745 of the
 * 747 robes in this dataset had their own skirt texture overwritten by the trousers underneath.
 * The robe paints after.
 *
 * This is the gateway's decision rather than the browser's on purpose: the order has to agree with
 * the component masks above, and both belong in one place. Whatever order the equipment arrives
 * in is discarded.
 */
const PAINT_ORDER: readonly number[] = [4, 5, 7, 20, 8, 9, 10, 6, 19, 16];

/**
 * A chest item that claims the long-legs geoset is a robe, whatever its inventory type says.
 *
 * Five real chest displays do it — Astralaan Robe, Archmage Robe, Consortium Robe and two more —
 * and 175 kilts and sarongs do the reverse from the legs slot. Keying the robe off INVTYPE_ROBE
 * would be wrong in both directions, so the geoset group decides here exactly as it does for the
 * geosets themselves, and the item then paints and sorts as a robe.
 */
function effectiveType(inventoryType: number, geosetGroups: readonly number[]): number {
  return inventoryType === INVENTORY_TYPE_CHEST && geosetGroups[2] === 1 ? INVENTORY_TYPE_ROBE : inventoryType;
}

/** INVTYPE_CLOAK: the one slot whose texture is not a body layer. */
const SLOT_BACK = 16;

/**
 * EQUIPMENT_SLOT_*: which of the nineteen PLAYER_VISIBLE_ITEM words an item came from.
 *
 * The inventory type alone cannot say: a one-handed weapon is INVTYPE_WEAPON in either hand, so
 * without the slot there is no telling a main hand from an off hand.
 */
const EQUIPMENT_SLOT_HEAD = 0;
const EQUIPMENT_SLOT_SHOULDERS = 2;
const EQUIPMENT_SLOT_MAINHAND = 15;
const EQUIPMENT_SLOT_OFFHAND = 16;
const EQUIPMENT_SLOT_RANGED = 17;

/**
 * CreatureDisplayInfoExtra.NPCItemDisplay is not an untyped list. In the 3.3.5 client its eleven
 * columns are the visible character slots, in this order: head, shoulders, shirt, chest, waist,
 * legs, feet, wrists, hands, tabard and back. The DBC stores ItemDisplayInfo ids only, so these
 * inventory types are the missing half needed to apply their component textures/geoset groups.
 * Keep this beside the slot constants rather than guessing from an item's model or texture name.
 */
const NPC_ITEM_INVENTORY_TYPES: readonly number[] = [
  1, 3, 4, 5, 6, 7, 8, 9, 10, 19, 16,
];
const NPC_EQUIPMENT_SLOTS: readonly number[] = [
  0, 2, 3, 4, 5, 6, 7, 8, 9, 18, 14,
];

/** INVTYPE_SHIELD, which hangs off the forearm rather than being held. */
const INVENTORY_TYPE_SHIELD = 14;
const INVENTORY_TYPE_CHEST = 5;
const INVENTORY_TYPE_ROBE = 20;

/** What each of HelmetGeosetVisData's seven columns covers up. The last two are always zero. */
const HELMET_HIDES_FAMILY: readonly (number | undefined)[] = [
  FAMILY_HAIR, FAMILY_FACIAL_1, FAMILY_FACIAL_2, FAMILY_FACIAL_3, FAMILY_EARS, undefined, undefined,
];

/**
 * Where an item's own model lives, by the equipment slot it is worn in.
 *
 * Verified by existence check over the model references of every equippable item: shoulders 2,336
 * of 2,336, shields 406 of 406, heads 1,310 of 1,320, weapons 1,360 of 1,362. The twelve misses
 * are all a stray helm or pauldron name sitting on a row of the wrong slot — which is why the
 * directory is chosen from the slot and never from what the DBC string happens to look like.
 * 977 armour rows carry such a leftover, and it must not be allowed to render.
 */
const SLOT_MODEL_DIRECTORY: Readonly<Record<number, string>> = {
  [EQUIPMENT_SLOT_HEAD]: "Head",
  [EQUIPMENT_SLOT_SHOULDERS]: "Shoulder",
  [EQUIPMENT_SLOT_MAINHAND]: "Weapon",
  [EQUIPMENT_SLOT_OFFHAND]: "Weapon",
  [EQUIPMENT_SLOT_RANGED]: "Weapon",
};

/**
 * A shield is the exception: it shares the off hand with held weapons but lives in its own
 * directory, so the slot alone gets it wrong for all 520 of them.
 */
function modelDirectory(slot: number, inventoryType: number): string | undefined {
  if (inventoryType === INVENTORY_TYPE_SHIELD) return "Shield";
  return SLOT_MODEL_DIRECTORY[slot];
}

/** One equipped item, as the browser sees it in PLAYER_VISIBLE_ITEM_*_ENTRYID. */
export interface EquippedItem {
  /** EQUIPMENT_SLOT_*, from which of the nineteen words it came. */
  slot: number;
  inventoryType: number;
  displayId: number;
  /** ItemSubClass, when the item query supplied it; needed to distinguish wands from guns. */
  subClass?: number;
}

/**
 * One model hung off the character, described by the slot it came from rather than by where it
 * goes. Choosing the attachment point needs the sheath state, which changes far more often than
 * an appearance does, so it is left to the browser and never enters the appearance's identity.
 */
export interface AttachedModel {
  /** EQUIPMENT_SLOT_*. */
  slot: number;
  /** INVTYPE_*, which is how a shield is told from a held off-hand weapon. */
  inventoryType: number;
  /** ItemSubClass, when available; ranged animation selection uses it for wand-vs-gun. */
  subClass?: number;
  /** Left or right, for the two-piece slots. Shoulders are two separate meshes. */
  side: "left" | "right";
  /** Full MPQ path of the item's M2. */
  model: string;
  /** Its type 2 slot: an item model almost never names its own diffuse texture. */
  texture: string;
}

function texturePath(value: string): string {
  const path = value.replaceAll("/", "\\");
  return validAssetPath(path, { extensions: ["blp"] }) ? path : "";
}

function modelPath(value: string): string {
  const path = value.replaceAll("/", "\\");
  return validAssetPath(path, { extensions: ["m2"] }) ? path : "";
}

interface SectionRow {
  textures: [string, string, string];
  flags: number;
}

export class CharacterAppearanceIndex {
  /** `base/race/sex/variation/colour` to the row's three texture slots. */
  readonly #sections = new Map<string, SectionRow>();
  /**
   * `race/sex` of every profile CharSections says anything about the hair of.
   *
   * Which is not every profile with a hairstyle. Measured on this dataset: 41 (race, sex) pairs
   * have a `CharHairGeosets` row and **39** of them have at least one `CharSections` hair row —
   * from 1 row on the eleven non-playable pairs that carry a single one to 312 for the human
   * female — while the goblin male (race 9) and the taunka male (race 19) have **none at any
   * variation or colour**. That is the difference between a table that has nothing to say about a
   * combination and a table that has nothing to say about a race, and `#geosets` has to tell them
   * apart or it reads one as the other.
   */
  readonly #hairSections = new Set<string>();
  /** `race/sex/variation` to the hair geoset and whether the scalp shows through it. */
  readonly #hairGeosets = new Map<string, { geoset: number; showScalp: boolean }>();
  /** `race/sex/variation` to the three facial-hair geoset variants. */
  readonly #facialHair = new Map<string, [number, number, number, number]>();
  /** Extended display records: a creature wearing a character model has a full appearance. */
  readonly #npc = new Map<number, {
    race: number; sex: number; skin: number; face: number; hairStyle: number; hairColor: number;
    facialHair: number; items: number[]; bake: string;
  }>();
  /**
   * ItemDisplayInfo: the eight component textures, the three geoset groups, the left and right
   * models, and their textures — one of which, for a cloak, is the cape itself, since a cloak is
   * the one worn thing with no model of its own.
   */
  readonly #itemDisplays = new Map<number, {
    textures: string[]; geosetGroups: number[]; modelTexture: string;
    models: [string, string]; modelTextures: [string, string]; helmetVisibility: [number, number];
  }>();
  /** ChrRaces.ClientPrefix, the two letters a helmet's filename carries. */
  readonly #racePrefixes = new Map<number, string>();
  /**
   * ChrRaces.ClientFileString lowercased, to the race id: the directory a race's models live in.
   *
   * The 21 rows of this dataset name `Human`, `Orc`, … `Naga_`, `NorthrendSkeleton`, and every one
   * of the 74 appearance-less `Character\` displays is under one of them, so `forModel` needs no
   * table of its own and a custom race added by a module is found the same way.
   */
  readonly #raceModels = new Map<string, number>();
  /** HelmetGeosetVisData: seven per-race bitmasks saying what a helmet covers up. */
  readonly #helmetVisibility = new Map<number, number[]>();
  /** True only when character rows come from a coordinated client-visual overlay. */
  #coordinatedVisuals = false;
  /**
   * What the client archives really hold, where the DBCs only name a file.
   *
   * Undefined on a machine with no client, and every use of it below has to answer the same as it
   * did before this field existed when it is: the tables are the contract, the archives are an
   * improvement on the guessing.
   */
  #textures: CharacterTextureIndex | undefined;

  /**
   * @param textures a listing of the archives, as a promise so the caller can start it beside the
   * DBC reads rather than before them. It is the child process of `tools/character-textures.mjs`
   * on the other end, 762 ms from spawn to exit on this machine, and it is shared with
   * `loadCreatureModelMetadata` so the two indexes pay for one run between them.
   */
  static async load(dbcDirectory: string,
    textures?: Promise<CharacterTextureIndex | undefined>,
    visualDbcDirectory = dbcDirectory,
    coordinatedVisuals = false): Promise<CharacterAppearanceIndex> {
    const index = new CharacterAppearanceIndex();
    index.#coordinatedVisuals = coordinatedVisuals;
    const [sections, hair, facial, extra, itemDisplay, races, helmets, held] = await Promise.all([
      // These rows describe the client model and its textures, not server mechanics. An HD model
      // patch changes them together with the M2s, so the two generations must stay paired.
      openDbcFile(visualDbcDirectory, "CharSections"),
      openDbcFile(visualDbcDirectory, "CharHairGeosets"),
      openDbcFile(visualDbcDirectory, "CharacterFacialHairStyles"),
      openDbcFile(visualDbcDirectory, "CreatureDisplayInfoExtra"),
      openDbcFile(dbcDirectory, "ItemDisplayInfo"),
      openDbcFile(dbcDirectory, "ChrRaces"),
      openDbcFile(visualDbcDirectory, "HelmetGeosetVisData"),
      textures,
    ]);
    index.#textures = held;

    for (const row of races.rows()) {
      const prefix = races.string(row, "ClientPrefix");
      if (/^[A-Za-z]{1,4}$/.test(prefix)) index.#racePrefixes.set(races.id(row), prefix);
      // The directory name, which is the only thing that ties a model path back to a race.
      // Underscores are in it — race 13 is `Naga_` — and the first spelling wins, as elsewhere.
      const directory = races.string(row, "ClientFileString");
      if (/^[A-Za-z_]{1,40}$/.test(directory) && races.id(row) > 0) {
        if (!index.#raceModels.has(directory.toLowerCase())) index.#raceModels.set(directory.toLowerCase(), races.id(row));
      }
    }

    for (const row of helmets.rows()) {
      const id = helmets.id(row);
      if (id <= 0) continue;
      index.#helmetVisibility.set(id, HELMET_HIDES_FAMILY.map((_, column) => helmets.int(row, "HideGeoset", column)));
    }

    for (const row of itemDisplay.rows()) {
      const id = itemDisplay.id(row);
      if (id <= 0) continue;
      const textures = [];
      let anyTexture = false;
      for (let component = 0; component < COMPONENT_SECTIONS.length; component++) {
        const name = itemDisplay.string(row, "Texture", component);
        // Component names are bare, with no directory and no extension; anything else is bad data.
        // Three classes stood here, one per field, and they had already drifted from each other by
        // the parentheses of the PvP shoulders — the same way the eight path classes drifted.
        // Measured: 80,988 component textures, 24,337 model names and 25,482 model textures, none
        // holding a separator and none refused by the merged validator either.
        const usable = validAssetPath(name, { maxLength: 120, bareName: true }) ? name : "";
        if (usable) anyTexture = true;
        textures.push(usable);
      }
      const geosetGroups = [0, 1, 2].map((group) => itemDisplay.int(row, "GeosetGroup", group));
      // ModelName is always `.mdx` — 24,337 of 24,337 rows — and the shipped asset is the M2.
      const models = [0, 1].map((piece) => {
        const name = itemDisplay.string(row, "ModelName", piece).replace(/\.(mdx|mdl|m2)$/i, "");
        return validAssetPath(name, { maxLength: 120, bareName: true }) ? name : "";
      }) as [string, string];
      // Five rows name a texture with parentheses in it, one of them with a trailing space —
      // "Shoulder_Plate_PVPAlliance_B_01Gold(Left) " — and the file in the archive is spelt
      // exactly that way, trailing space and all. Taken verbatim, trailing space and all.
      const modelTextures = [0, 1].map((piece) => {
        const name = itemDisplay.string(row, "ModelTexture", piece);
        return validAssetPath(name, { maxLength: 120, bareName: true }) ? name : "";
      }) as [string, string];
      const modelTexture = modelTextures[0];
      const helmetVisibility = [0, 1].map((piece) => itemDisplay.int(row, "HelmetGeosetVisID", piece)) as [number, number];
      if (!anyTexture && !modelTexture && !models[0] && !models[1]
        && helmetVisibility[0] === 0 && helmetVisibility[1] === 0
        && geosetGroups.every((value) => value === 0)) continue;
      index.#itemDisplays.set(id, { textures, geosetGroups, modelTexture, models, modelTextures, helmetVisibility });
    }

    for (const row of sections.rows()) {
      const base = sections.int(row, "BaseSection");
      const key = sectionKey(
        base,
        sections.int(row, "RaceID"),
        sections.int(row, "SexID"),
        sections.int(row, "VariationIndex"),
        sections.int(row, "ColorIndex"),
      );
      if (base === SECTION_HAIR) {
        index.#hairSections.add(`${sections.int(row, "RaceID")}/${sections.int(row, "SexID")}`);
      }
      // The first matching row wins; later ones are alternatives of the same choice.
      if (index.#sections.has(key)) continue;
      index.#sections.set(key, {
        textures: [0, 1, 2].map((slot) => texturePath(sections.string(row, "TextureName", slot))) as [string, string, string],
        flags: sections.int(row, "Flags"),
      });
    }

    for (const row of hair.rows()) {
      index.#hairGeosets.set(
        `${hair.int(row, "RaceID")}/${hair.int(row, "SexID")}/${hair.int(row, "VariationID")}`,
        { geoset: hair.int(row, "GeosetID"), showScalp: hair.int(row, "Showscalp") !== 0 });
    }

    // Five columns, not three. The fifth is the racial eye glow and it is the only reason a night
    // elf's eyes shine at all: it is non-zero on 55 of the 172 playable rows, always 2, and geoset
    // 1702 exists in exactly the six models those rows belong to — night elf, blood elf and
    // scourge, both sexes. The fourth column is zero on every playable row.
    for (const row of facial.rows()) {
      index.#facialHair.set(
        `${facial.int(row, "RaceID")}/${facial.int(row, "SexID")}/${facial.int(row, "VariationID")}`,
        [facial.int(row, "Geoset", 0), facial.int(row, "Geoset", 1), facial.int(row, "Geoset", 2),
          facial.int(row, "Geoset", 4)]);
    }

    for (const row of extra.rows()) {
      const id = extra.id(row);
      if (id <= 0) continue;
      index.#npc.set(id, {
        race: extra.int(row, "DisplayRaceID"),
        sex: extra.int(row, "DisplaySexID"),
        skin: extra.int(row, "SkinID"),
        face: extra.int(row, "FaceID"),
        hairStyle: extra.int(row, "HairStyleID"),
        hairColor: extra.int(row, "HairColorID"),
        facialHair: extra.int(row, "FacialHairID"),
        items: NPC_ITEM_INVENTORY_TYPES.map((_, slot) => extra.int(row, "NPCItemDisplay", slot)),
        bake: texturePath(`Textures\\BakedNpcTextures\\${extra.string(row, "BakeName").replaceAll("/", "\\")}`),
      });
    }
    return index;
  }

  #section(base: number, race: number, sex: number, variation: number, colour: number): SectionRow | undefined {
    return this.#sections.get(sectionKey(base, race, sex, variation, colour));
  }

  /**
   * The picture one hair colour is drawn with, whichever style asked for it.
   *
   * The type 6 slot is not the hairstyle's texture, it is the colour's: measured over the whole
   * table, every variation of an orc male that names anything at colour 3 names
   * `Character\Orc\Hair00_03.blp`, and sixteen of the twenty playable profiles name exactly one
   * file per colour. The four that do not are the human and the scourge of both sexes, with two —
   * `Hair02` and `Hair03` beside `Hair00`, the sheets the barbershop styles of 3.0 brought.
   *
   * It matters because the mesh that samples the slot is not only the wig. Measured on the models:
   * an orc male's beards are geosets 102 to 110 and a gnome male's 102 to 108, and every one of
   * them samples texture type 6. Their bald row — variation 0, the one the creation form sends by
   * default — leaves slot 0 blank, so a bald orc with a beard had **a flat green beard**: 99 of
   * the orc male's offered looks and 84 of the gnome male's, 183 in all over the 28,269 (style,
   * colour, facial hair) combinations the twenty profiles offer. Filling the slot from the colour
   * is not inventing anything; it is reading the same column off a row of the same colour.
   *
   * Which of the two, where there are two, never arises. The orc male and the gnome male are the
   * only profiles whose facial hair samples type 6 at all, and both name one file per colour; on
   * the human and the scourge the only meshes that sample it are the wigs, and every one of their
   * rows whose geoset is not 0 names its own picture, so the fallback is never what a drawn wig is
   * painted with. The tauren is the one profile where a drawn wig has no picture, and his model
   * declares no type 6 at all.
   *
   * Costs a scan only when the row itself names nothing, which is 84 of the 3,230 offered looks.
   */
  #hairColour(race: number, sex: number, colour: number): string {
    for (let variation = 0; variation < 64; variation++) {
      const named = this.#section(SECTION_HAIR, race, sex, variation, colour)?.textures[0];
      if (named) return named;
    }
    return "";
  }

  /**
   * What a character of this race and sex may actually look like.
   *
   * The creation form sent nothing at all — name, race, class, sex and five zeros — and zero is
   * legal, so the server accepted it and the character was born with `skin 0, face 0, hair 0`. For
   * a human male `hair 0` is `CharHairGeosets` row 21: geoset 0, `Showscalp 1`, and all three of
   * its `CharSections` texture slots empty. That is not a bug in the renderer. **It is a bald
   * character, correctly drawn, because a bald character is what was asked for.**
   *
   * So the form needs the choices, and these are they — the indices that have a row, listed, not
   * counted. What was here counted `found = index + 1` on every hit, which is the largest index
   * that exists plus one, and a gap inside that range was offered like any other number: night elf
   * hair carries `ColorIndex 0..7, 10, 11, 12` for every one of its twelve variations and both
   * sexes, 8 and 9 exist nowhere, and `hairColors` answered 13. Measured over the twenty playable
   * profiles, the rectangle the form offered contained **1,900** pairs with no row — 1,820 faces,
   * 48 hair, 32 facial hair, no skin — and each of them produced a character the tables cannot
   * describe: a face with no row leaves the bare base skin with no eyes or mouth, and a hair
   * colour with no row leaves the wig with no texture, which is 48 flat green scalps out of the
   * 3,278 (style, colour) pairs on offer.
   *
   * Two of the five dimensions are not free choices but the second half of a pair, because that is
   * how the rows are keyed — a face row is `(face, skin)` and hair and facial-hair rows are
   * `(variation, hairColor)`. Measured on this dataset: hair and facial hair are square, every
   * offered variation has every offered colour, but **faces are not** — over the offered skins,
   * 780 (face, skin) pairs have no row. They are the death-knight skins, which carry three faces
   * of the twenty-four rather than all of them. So the faces are published per skin as well as in
   * the union, and the form fills its face list from `facesBySkin`; hair and facial hair need no
   * such map today and would need one if a module added a ragged set, which is why the shape of
   * the answer says which dimension is paired with which.
   *
   * A skin with no face row at all is not offered: the character would wear the bare base skin
   * with no eyes and no mouth, and `Player::ValidateAppearance` rejects it outright, since the
   * face row is one of the four it looks up. That is 64 of the 302 skins the five tables name for
   * the twenty playable profiles — and exactly the 64 whose `CharSections.Flags` lacks the core's
   * `SECTION_FLAG_PLAYER` (`DBCStructure.h:322-326`), which is the same set arrived at from the
   * other side.
   *
   * Which is the second rule, and it is the core's and not a guess: a row without
   * `SECTION_FLAG_PLAYER` is refused at creation for **every** class, death knights included
   * (`Player.cpp:27273-27275`). Offering one is offering a look that ends in «Создание отклонено»,
   * which is a hole by another name. Measured over the twenty profiles, the flag takes out **98
   * hairstyles** — five per profile on eighteen of them, four on the troll male and the draenei
   * male, the highest-numbered ones — and **2 hair colours**, the tauren's colour 3 on both sexes;
   * no skin, no face and no facial-hair row on offer lacks it. The region is an exact product —
   * every one of the 65 human-male (style, colour) pairs without the flag lies in those five
   * styles, and all 28 of the tauren male's in those five styles or that one colour — so filtering
   * the two axes separately leaves no ragged remainder, and the test says so.
   *
   * The other half of that gate is **not** applied here, on purpose: `SECTION_FLAG_DEATH_KNIGHT`
   * (0x04) is refused only for classes other than the death knight, and this route is answered
   * without a class. Dropping those rows would take the death-knight skins away from the one class
   * allowed to wear them — the human male's 12, 13 and 14, and 129 of his 249 face rows. So a
   * human male is offered 13 skins and 24 faces where an ordinary class may take 10 and 12, and
   * closing that needs the class, which arrives with the race and class route (Д3).
   *
   * A module adding a look has to set the flag on its rows, and this is where it will notice if it
   * did not: the control goes empty rather than offering a choice the server will refuse.
   */
  options(race: number, sex: number): CharacterOptions {
    // The scan stops well past anything the shipped tables use — the widest is 24 hair colours for
    // a blood elf — and it is a map lookup per candidate. Listing costs more than counting because
    // it walks the second axis as well: measured on this machine, 0.75 ms for a human male and
    // 0.76 for the widest profile, a draenei female, against 0.030 ms for the 320 lookups the
    // counts did. That is paid once per race or sex change, on a route that answers
    // `max-age=3600`, and the answer is 969 bytes for a human male, 703 on average over the twenty.
    const LIMIT = 64;
    /** A row the creation screen may choose: it exists, and the core will take it from any class. */
    const has = (base: number, variation: number, colour: number): boolean => {
      const row = this.#section(base, race, sex, variation, colour);
      return row !== undefined && (row.flags & SECTION_FLAG_PLAYER) !== 0;
    };
    /** Every index on the first axis that has a row at any of `colours`. */
    const variations = (base: number, colours: readonly number[]): number[] => {
      const found: number[] = [];
      for (let variation = 0; variation < LIMIT; variation++) {
        if (colours.some((colour) => has(base, variation, colour))) found.push(variation);
      }
      return found;
    };

    // A skin is a colour of base section 0 at variation 0, and it is offered only if a face goes
    // with it.
    const skins: number[] = [];
    const facesBySkin: Record<number, number[]> = {};
    for (let colour = 0; colour < LIMIT; colour++) {
      if (!has(SECTION_SKIN, 0, colour)) continue;
      const faces = variations(SECTION_FACE, [colour]);
      if (faces.length === 0) continue;
      skins.push(colour);
      facesBySkin[colour] = faces;
    }

    // Hair rows are keyed on the colour, not on the skin, so the colours are the ones that have a
    // row at any variation rather than the ones that have a row at variation 0. Variation 0 is the
    // bald row and exists for every race, but its colour set is not always the whole of them.
    const hairColors: number[] = [];
    for (let colour = 0; colour < LIMIT; colour++) {
      for (let variation = 0; variation < LIMIT; variation++) {
        if (has(SECTION_HAIR, variation, colour)) { hairColors.push(colour); break; }
      }
    }

    // Facial hair comes from `CharacterFacialHairStyles` and not from `CharSections`, because that
    // is the table that decides what is drawn and the table the core insists on. Ten of the twenty
    // playable profiles have no `CharSections` facial-hair row whatsoever — tauren and draenei of
    // both sexes, and every female but the night elf and the undead — and for those ten the core
    // skips the section check entirely (`Player.cpp:27296-27303`); counting sections gave them
    // `facialHairs: 0` and hid the control, so a tauren could not choose his horns and a draenei
    // not her tendrils. Where the sections do exist they agree with the styles exactly, variation
    // for variation, on all ten of the other profiles — so the section is still required there,
    // which is the core's own rule and not a second one.
    const textured = variations(SECTION_FACIAL_HAIR, hairColors);
    const styled: number[] = [];
    for (let variation = 0; variation < LIMIT; variation++) {
      if (this.#facialHair.has(`${race}/${sex}/${variation}`)) styled.push(variation);
    }
    const facialHairs = textured.length === 0 ? styled : styled.filter((variation) => textured.includes(variation));

    return {
      skins,
      faces: variations(SECTION_FACE, skins),
      hairStyles: variations(SECTION_HAIR, hairColors),
      hairColors,
      facialHairs,
      facesBySkin,
    };
  }

  /** The appearance of a player, from the bytes the server publishes and what it is wearing. */
  forPlayer(race: number, sex: number, skin: number, face: number, hairStyle: number, hairColor: number,
    facialHair: number, equipment: readonly EquippedItem[] = []): CharacterAppearance {
    const body: BodyLayer[] = [];

    // The base skin is a finished 512x512 body; everything else is painted over it.
    const skinRow = this.#section(SECTION_SKIN, race, sex, 0, skin);
    if (skinRow?.textures[0]) body.push({ path: skinRow.textures[0] });

    // A face row carries two pieces, upper and lower, at exactly the size of their rectangles.
    const faceRow = this.#section(SECTION_FACE, race, sex, face, skin);
    if (faceRow?.textures[0]) body.push({ path: faceRow.textures[0], section: "faceLower" });
    if (faceRow?.textures[1]) body.push({ path: faceRow.textures[1], section: "faceUpper" });

    // A hair row carries three things: the hair mesh's own texture in slot 0, and the scalp
    // shading that goes on the face in slots 1 and 2. Painted before the beard so a beard covers
    // it, and after the face so a hairline covers the bare forehead.
    const hairRow = this.#section(SECTION_HAIR, race, sex, hairStyle, hairColor);
    if (hairRow?.textures[1]) body.push({ path: hairRow.textures[1], section: "faceLower" });
    if (hairRow?.textures[2]) body.push({ path: hairRow.textures[2], section: "faceUpper" });

    // Facial hair paints over the face at half resolution, so it is scaled into the same rects.
    const facialRow = this.#section(SECTION_FACIAL_HAIR, race, sex, facialHair, hairColor);
    if (facialRow?.textures[0]) body.push({ path: facialRow.textures[0], section: "faceLower" });
    if (facialRow?.textures[1]) body.push({ path: facialRow.textures[1], section: "faceUpper" });

    // Underwear sits on the pelvis, which is the upper-leg rectangle. Armour goes over it.
    const underwearRow = this.#section(SECTION_UNDERWEAR, race, sex, 0, skin);
    if (underwearRow?.textures[0]) body.push({ path: underwearRow.textures[0], section: "legUpper" });

    // Armour paints in a fixed order and in one pass, so the geosets it chooses and the textures
    // it paints cannot disagree about which item won. Note the two halves key on different
    // things, and correctly so: what a garment does to the skin follows its inventory type, where
    // a robe and a chest piece genuinely differ, while what hangs off a bone follows its
    // equipment slot, because a one-handed weapon is the same type in either hand.
    const worn = [...equipment]
      .filter((item) => SLOT_APPEARANCE[this.#effectiveType(item)] !== undefined)
      .sort((left, right) => PAINT_ORDER.indexOf(this.#effectiveType(left)) - PAINT_ORDER.indexOf(this.#effectiveType(right)));

    const families = this.#geosetFamilies(race, sex, worn);
    for (const item of worn) this.#paint(item, sex, body);

    return {
      body,
      // The type 6 slot, which is the hair colour's picture and not the hairstyle's — and the
      // beard's picture too, which is why the bald row's blank is filled in from the colour.
      hair: hairRow?.textures[0] || this.#hairColour(race, sex, hairColor),
      cloak: this.#cloak(worn),
      // The same skin row as the base body, second slot. It is not a layer of the atlas and must
      // not become one: the horns and the hide sample texture type 8 with their own UVs, so
      // painting it into the 512x512 body would put it on the wrong geometry twice over.
      skinExtra: skinRow?.textures[1] ?? "",
      ...(this.#coordinatedVisuals ? { coordinatedVisuals: true as const } : {}),
      geosets: this.#geosets(race, sex, hairStyle, hairColor, facialHair,
        families, this.#hiddenFamilies(race, sex, equipment)),
      attached: this.#attached(race, sex, equipment),
    };
  }

  /**
   * The cape texture, for the type 2 slot.
   *
   * A cloak is the one worn thing with no model of its own: `Item\ObjectComponents\Cape` holds 194
   * BLPs and not a single M2, because the geometry is already in the character file as geosets
   * 1502 to 1506 and only the picture on it changes. Those five geosets are also the only batches
   * of a character model that sample texture type 2 at all.
   *
   * A full path, not the bare name the DBC gives: a bare value is resolved beside the model that
   * asked for it, which for a character is `Character\<Race>\<Sex>` and holds no capes.
   */
  #cloak(worn: readonly EquippedItem[]): string {
    for (const item of worn) {
      if (item.inventoryType !== SLOT_BACK) continue;
      const name = this.#itemDisplays.get(item.displayId)?.modelTexture;
      if (name) return texturePath(`Item\\ObjectComponents\\Cape\\${name}.blp`);
    }
    return "";
  }

  /**
   * The models a character hangs off itself: a helmet, two pauldrons and whatever is in its hands.
   *
   * Every ModelName in ItemDisplayInfo ends in `.mdx` — all 24,337 of them, without one exception —
   * and the shipped asset is the M2, so the rewrite is mandatory rather than a fallback. The
   * texture is `ModelTexture` under the same directory, which resolved 8,006 of 8,007 references.
   *
   * A helmet is the exception to the naming: the DBC gives a bare stem and the archive holds one
   * file per race and sex, suffixed with ChrRaces.ClientPrefix and M or F — `Helm_Leather_D_01`
   * becomes `Helm_Leather_D_01_HuM.m2`. Only the wearer knows which, so it is resolved here.
   *
   * Only the shoulders have a second piece, and their two are separate meshes rather than one
   * mirrored twice. Ten head rows and two weapon rows carry a leftover second name from some other
   * slot — RShoulder_Cloth_AhnQiraj_A_01 on a helmet — which, taken at face value, would look for
   * a pauldron under `Head` and hang it off a shoulder. They are ignored.
   */
  #attached(race: number, sex: number, worn: readonly EquippedItem[]): AttachedModel[] {
    const attached: AttachedModel[] = [];
    for (const item of worn) {
      const directory = modelDirectory(item.slot, item.inventoryType);
      const display = this.#itemDisplays.get(item.displayId);
      if (!directory || !display) continue;
      const sides = item.slot === EQUIPMENT_SLOT_SHOULDERS ? (["left", "right"] as const) : (["left"] as const);
      for (const side of sides) {
        const name = display.models[side === "left" ? 0 : 1];
        if (!name) continue;
        const stem = item.slot === EQUIPMENT_SLOT_HEAD ? `${name}_${this.#racePrefix(race)}${sex === 1 ? "F" : "M"}` : name;
        const model = modelPath(`Item\\ObjectComponents\\${directory}\\${stem}.m2`);
        if (!model) continue;
        const texture = display.modelTextures[side === "left" ? 0 : 1] || display.modelTextures[0] || "";
        attached.push({
          slot: item.slot,
          inventoryType: item.inventoryType,
          side,
          model,
          texture: texture ? texturePath(`Item\\ObjectComponents\\${directory}\\${texture}.blp`) : "",
          ...(item.subClass === undefined ? {} : { subClass: item.subClass }),
        });
      }
    }
    return attached;
  }

  #racePrefix(race: number): string {
    return this.#racePrefixes.get(race) ?? "Hu";
  }

  /** The inventory type an item behaves as, which for a robe-flagged chest piece is a robe. */
  #effectiveType(item: EquippedItem): number {
    const display = this.#itemDisplays.get(item.displayId);
    return display ? effectiveType(item.inventoryType, display.geosetGroups) : item.inventoryType;
  }

  /** The appearance of a creature that wears a character model. */
  forNpc(extendedDisplayId: number): CharacterAppearance | undefined {
    const npc = this.#npc.get(extendedDisplayId);
    if (!npc) return undefined;
    // The eleven NPCItemDisplay columns carry the same ItemDisplayInfo component/geoset data as
    // player equipment. Their position is authoritative for the inventory type; there is no
    // Item.dbc row here from which to recover it. This slice intentionally takes only items painted
    // into the baked body (shirt through cloak). Head and shoulders require their own attached M2s:
    // feeding them through forPlayer and then discarding `attached` would apply helmet hide rules
    // without drawing the helmet, which measurably removed the hair from 53 existing NPC looks.
    const equipment = npc.items
      .map((displayId, slot) => ({
        slot: NPC_EQUIPMENT_SLOTS[slot] ?? -1,
        inventoryType: NPC_ITEM_INVENTORY_TYPES[slot] ?? 0,
        displayId,
      }))
      .filter((item) => item.slot >= 0 && item.displayId > 0
        && item.inventoryType !== 1 && item.inventoryType !== 3);
    const appearance = this.forPlayer(
      npc.race, npc.sex, npc.skin, npc.face, npc.hairStyle, npc.hairColor, npc.facialHair, equipment);
    appearance.attached = [];
    // A baked texture is a finished body and replaces every layer that would have made one.
    // 15,451 of the client's 24,263 displays have one.
    //
    // It replaces the body and nothing else — `skinExtra` deliberately survives it. A bake is the
    // 512x512 type 1 atlas; the horns sample type 8, which no bake can reach, so a baked tauren
    // needs the `_Extra` exactly as much as an assembled one does. Measured: all 825 tauren rows
    // of `CreatureDisplayInfoExtra` name a skin whose `CharSections` row has one, and of the 814
    // displays wearing a tauren model 810 carry one of those rows and every one of the 810 is
    // baked, so this is the common case and not the exception. The four that are not are 59, 60
    // and 1942, which name no extended row at all, and 11280, whose row calls itself another race.
    //
    // Unless the archives do not have it. A bake replaces every other layer, so a display naming a
    // file that is not there had a one-element body that resolved to nothing — and the browser then
    // composed that nothing sixty times a second and left the unit a capsule for ever (Т6).
    // Measured on this dataset: 8 of the 15,453 extended rows that name a bake name one the archives
    // lack (`CreatureDisplayExtra-15377.blp` and six more, plus `56171385eda078fe38ed19d8286ef141`),
    // and they are two gnomes of each sex, a draenei male, a night elf female and two goblin males.
    // All eight now keep the body `forPlayer` just assembled out of `CharSections` — six layers for
    // most of them, eight for the night elf, the bare skin for the two goblins — and all eight
    // paint. Counted layer by layer, which is what the review asked for and what the first form of
    // this sentence did not do: **38 of their 40 layers are in the archives**. The two that are not
    // are display 13665's draenei scalp overlays, and they are not this fallback's doing —
    // `Character\Draenei\` holds 1,373 files and not one of them has "scalp" in the name, against
    // 168 of the gnome's 813, so 53,410 of the 56,290 draenei looks the creation form offers ask
    // for one of 21 scalp files this client does not ship. That is a `CharSections` gap these eight
    // walked into, it costs those two layers a 404 apiece, and it has a row of its own in the plan.
    // With no listing to hand nothing changes here: the bake wins exactly as it did.
    if (npc.bake && !(this.#textures?.knows(npc.bake) && !this.#textures.has(npc.bake))) {
      appearance.body = [{ path: npc.bake }];
    }
    return appearance;
  }

  /**
   * The plain look of whatever race a character model belongs to, for a display that names no
   * appearance at all.
   *
   * Measured on this dataset: of the 24,262 `CreatureDisplayInfo` rows, 15,518 wear a `Character\`
   * model and 74 of those have no `ExtendedDisplayInfoID` that resolves — and all 74 carry an
   * empty texture list too, so before this their whole torso was painted flat green. **All twenty
   * playable base displays are among the 74**: 49-60 for the six original races of each sex, then
   * 1563/1564 gnome, 1478/1479 troll, 15476/15475 blood elf and 16125/16126 draenei. Those are the
   * most reused humanoid displays in `creature_template`, and display 49 is the same number a
   * human male player carries in `UNIT_FIELD_DISPLAYID`.
   *
   * The race comes from the path rather than from a table written out here: `ChrRaces` names the
   * directory itself in `ClientFileString`, so a dataset that adds a race is picked up with it.
   * Skin, face, hair, hair colour and facial hair are all 0, which is the look the creation form
   * produces when it sends nothing — a plain, bald member of the race.
   */
  forModel(modelPath: string): CharacterAppearance | undefined {
    // `Character\<ClientFileString>\<Male|Female>\<file><sex>.m2`, and the case is not stable in
    // the table: four of the 74 spell the first component `CHARACTER\`.
    const parts = modelPath.replaceAll("/", "\\").split("\\");
    if (parts.length < 4 || parts[0]?.toLowerCase() !== "character") return undefined;
    const race = this.#raceModels.get((parts[1] ?? "").toLowerCase());
    const sex = (parts[2] ?? "").toLowerCase() === "female" ? 1 : (parts[2] ?? "").toLowerCase() === "male" ? 0 : undefined;
    if (race === undefined || sex === undefined) return undefined;
    return this.forPlayer(race, sex, 0, 0, 0, 0, 0);
  }

  /**
   * The variant each equipment family settles on, starting from bare skin.
   *
   * GeosetGroup is zero-based and the variants in the file are one-based, so the id is
   * `family * 100 + value + 1` and a value of 0 is meaningful, not absent. That off-by-one is
   * measurable: gloves carry values 0..3 against family 4's variants 1..4, boots 0..4 against
   * family 5's 1..5, cloaks 0..5 against family 15's 1..6. Dropping the +1 emits 401 for a glove
   * that should be 402, and emits 801, 901, 1001, 1101 and 1801. Stock 3.3.5 playable models do
   * not carry those variants, but coordinated HD replacements may: the installed HumanMale adds
   * authored 1801/1802 belt meshes, and several other patch-W profiles add 1802 only. The browser
   * resolves this list against the model it actually loaded, so a missing stock id is harmless while
   * dropping the profile's authored id here makes the HD mesh unreachable.
   *
   * One id per family, because the browser is handed an explicit list and draws everything on it:
   * seeding plain legs (1301) and then adding a robe skirt (1302) would draw both.
  */
  #geosetFamilies(race: number, sex: number, worn: readonly EquippedItem[]): Map<number, number> {
    const families = new Map<number, number>(NAKED_VARIANTS);
    // Variant 1 is the semantic neutral waist. Some coordinated models author it as the bridge
    // between body and legs; others carry only 1802, which is an equipped belt laid over a body
    // that is already closed. Always ask for 1801 and let the model resolver drop an absent
    // variant-1 id. Equipped items below may still select/remap to 1802 deliberately.
    if (this.#coordinatedVisuals) {
      families.set(FAMILY_BELT, 1);
    }
    for (const item of worn) {
      const display = this.#itemDisplays.get(item.displayId);
      if (!display) continue;
      const slot = SLOT_APPEARANCE[effectiveType(item.inventoryType, display.geosetGroups)];
      if (!slot) continue;
      for (let group = 0; group < slot.families.length; group++) {
        const family = slot.families[group];
        if (family === undefined) continue;
        let variant = (display.geosetGroups[group] ?? 0) + 1;
        if (this.#coordinatedVisuals && family === FAMILY_BOOTS && display.textures[7]
          && (FOOT_TEXTURE_PROFILES.has(`${race}/${sex}`)
            || (race === 6 && variant === 1))) {
          variant = FOOT_TEXTURE_BOOT_VARIANT;
        }
        if (this.#coordinatedVisuals && family === FAMILY_BELT && variant === 1
          && BELT_1802_PROFILES.has(`${race}/${sex}`)) {
          variant = 2;
        }
        // In active patch-W, the measured non-hoof profiles use 505 for the authored worn boot
        // shaft, while Troll/Draenei have different bare/hoof semantics. Scope this correction to
        // the profile table and an actual FootTexture component; naked appearances and leg-only
        // rows retain their old family choice.
        // The legs are the one family two slots drive: a chest piece claims them to become a robe,
        // and a trousers item claims them to stay plain. A long garment wins whichever slot it
        // came from, so a robe survives the trousers underneath it.
        if (family === FAMILY_LEGS) families.set(family, Math.max(families.get(family) ?? 1, variant));
        else families.set(family, variant);
      }
    }

    // And the foot, last, because the answer depends on which boot the loop above settled on.
    //
    // On the ten coordinated profiles of `FOOT_GEOSET_PROFILES` the foot is a mesh of its own and
    // has to be asked for by name or the character ends at the ankle. The exception is the fifth
    // boot variant, and it is measured rather than assumed: 505 is the only family-5 member that
    // reaches the sole on all ten — HumanMale -0.01, HumanFemale -0.01, OrcMale -0.03, OrcFemale
    // -0.01, DwarfMale -0.01, DwarfFemale -0.01, NightElfFemale -0.01, GnomeMale -0.01,
    // BloodElfMale -0.02, BloodElfFemale -0.01 — while variants 1 to 4 all start between z 0.05 and
    // 0.20, above the foot entirely. So 505 already carries the foot and the bare one underneath it
    // would only be a second surface in the same place; 501..504 need it.
    if (this.#coordinatedVisuals) {
      const foot = FOOT_GEOSET_PROFILES.get(`${race}/${sex}`);
      if (foot !== undefined && families.get(FAMILY_BOOTS) !== FOOT_TEXTURE_BOOT_VARIANT) {
        families.set(FAMILY_FEET, foot);
      }
    }
    return families;
  }

  /**
   * Which geosets to draw, as ids.
   *
   * Geoset 0 is the character. Not the scalp — the body: two submeshes, 624 of HumanMale's 6,356
   * triangles, spanning z 0.00 to 1.96 and sampling the body atlas. Every other id in family 0 is
   * confined to the head, none of them reaching below z 1.34, so those are the hairstyles and
   * there are up to 25 of them. Geoset 0 is always drawn, and the one hairstyle CharHairGeosets
   * picks is drawn over it.
   *
   * **Geoset 0 is not always the whole body any more.** In the active patch-W pack HumanMale's is
   * 4,410 triangles spanning z 0.71..2.02 — the classic one is 624 spanning -0.00..1.96 — because
   * ten of the twenty profiles moved the foot out into family 20 (`FOOT_GEOSET_PROFILES`) and the
   * legs into families 5 and 13. Nothing here treats geoset 0 as a floor-to-crown body; it is one
   * id among the list, and the list has to name every part the file expects to be asked for.
   *
   * Families 1 to 3 are the three facial-hair pieces and their variants come from the DBC
   * unchanged, with no +1. Everything else is one variant per family, from bare skin or from what
   * is worn. Family 17 is the eye glow and is never added: a human model carries only 1703, the
   * death knight one, which is why every humanoid in this client used to have glowing eyes.
   */
  #geosets(race: number, sex: number, hairStyle: number, hairColor: number, facialHair: number,
    families: ReadonlyMap<number, number>, hidden: ReadonlySet<number>): number[] {
    const geosets = new Set<number>([0]);
    // A style the table does not have is not a reason to draw nothing. The appearance byte comes
    // off the wire and the core never checks it against `CharHairGeosets`, so a character created
    // by any tool that guessed can carry a variation this race has never had. Falling back to
    // variation 0 gives it the race's own bald head rather than a head with a hole where the
    // geoset lookup failed — and for the vast majority of races variation 0 is geoset 0, which is
    // already in the set, so the fallback costs nothing when it is not needed.
    //
    // Which variation was settled on is kept, because the texture question below has to be asked
    // about the same one: a tauren's variation 0 is geoset 2, a real mane, and asking about a
    // variation he does not have would take it off him.
    const variation = this.#hairGeosets.has(`${race}/${sex}/${hairStyle}`) ? hairStyle : 0;
    const hair = this.#hairGeosets.get(`${race}/${sex}/${variation}`);
    if (hair && !hidden.has(FAMILY_HAIR)) {
      // A hairstyle the table has no row for is not drawn. The geoset comes from `CharHairGeosets`
      // and the texture from `CharSections`, two tables that do not have to agree about which
      // (variation, colour) pairs exist, and where they do not the mesh is drawn sampling a slot
      // nothing fills — which the browser paints flat green. That is what a night elf offered hair
      // colour 8 or 9 wore: those two colours have no row for any of the twelve styles, all twelve
      // sample texture type 6, and 24 combinations per sex came out as a green scalp — with the
      // female's 24-triangle brow-and-lash batch of geoset 0 going green along with it. Since this
      // slice the form cannot ask for that pair, but the byte comes off the wire: a stale client,
      // an old tool or a hand-written row still can.
      //
      // **No row**, not "a row with an empty texture", and not "a file the archives do not have".
      // The archives are the easy mistake and the tauren is why: all 75 of his hair rows that name
      // anything name a file that is not there — the same two junk names repeated — his models
      // declare no texture type 6 at all, and his mane is drawn from the body atlas. But the
      // empty-string test is wrong too, and the tauren is again why: his hair colour 3 has a row
      // for every one of the 13 male and 12 female styles with slot 0 left blank, and those
      // geosets are 26 to 138 triangles of real mane sampling type 1 (type 8 for male style 8).
      // Testing the string would shave 25 of his offered looks. A row that exists with nothing in
      // it is a statement that the mesh is textured from elsewhere; a row that does not exist is a
      // combination the client was never given.
      //
      // And a table can only be silent about a combination of a race it speaks of at all. This is
      // the NPC path too — `forNpc` calls `forPlayer` — and the review found the missing half of
      // the rule there: the goblin male and the taunka male have a `CharHairGeosets` row and **not
      // one** `CharSections` hair row at any variation or colour, so the test read the table's
      // total silence as "the combination does not exist" and took the wig off **601 of the 15,475
      // extended display records** (502 goblin, 99 taunka), reached by 627 displays, 517 of them
      // wearing `Character\Goblin\Male\GoblinMale`. His geoset 2 is 90 triangles in two batches:
      // 28 sampling type 1, the baked body the display already supplies, and 62 sampling type 11,
      // which none of those 523 displays fills with a `TextureVariation` and which therefore draws
      // flat — a defect of its own, older than this rule and not this rule's to fix. The taunka
      // asks for geoset 1, which `TaunkaMale` does not carry, so nothing of him ever changed.
      const described = this.#hairSections.has(`${race}/${sex}`);
      if (!described || this.#section(SECTION_HAIR, race, sex, variation, hairColor)) geosets.add(hair.geoset);
      // `Showscalp` means the style leaves the top of the skull bare, and geoset 1 is the cap that
      // closes it. Until now the flag was parsed and read by nothing, and geoset 1 was referenced
      // by no `CharHairGeosets` row in any of the twenty playable models — unreachable geometry in
      // eleven of them (HumanMale 44 triangles, BloodElfFemale 124, TaurenMale 6). Measured with
      // position-matched boundary edges: adding it takes a bald HumanMale from 38 open edges to
      // 28, GnomeMale from 42 to 32 and DraeneiMale from 40 to 30, all at z 1.88..2.01, and the
      // material is `FrontSide`, so the hole was see-through.
      //
      // Added *beside* the style's own geoset, not instead of it. wowee replaces it
      // (`entity_spawner.cpp:718-727`, `useDefaultScalp ? 1 : geosetId`), which measured here
      // would delete all six troll mohawks — the other rows with the flag are TrollMale styles
      // 7,8,9 → geosets 8,9,10 and TrollFemale 5,7,9 → 7,9,11 — and TrollFemale carries no geoset
      // 1 at all, so she would end up with nothing on her head. Adding is a measured no-op on
      // those six (TrollMale style 7: 54 open edges either way) and the browser drops an id the
      // model does not carry, so the nine models without geoset 1 are untouched.
      //
      // Outside the texture test above on purpose: the cap samples the *body* atlas, not the hair
      // slot, and a bald style is exactly the case with no hair texture and a bare crown. All
      // seven playable bald styles would lose their cap again if this moved one line up.
      if (hair.showScalp) geosets.add(SCALP_GEOSET);
    }

    // CharacterFacialHairStyles' three columns are not in family order. Measured by testing all
    // six permutations against the geosets each race's model actually carries: columns 0, 1, 2
    // drive families 1, 3, 2, which scores 185 of 212 against 127 for the obvious 1, 2, 3. The
    // single-family races settle it — GnomeFemale carries only family 2 and is non-zero only in
    // column 2, while five races carry only family 3 and are non-zero only in column 1.
    const facial = this.#facialHair.get(`${race}/${sex}/${facialHair}`);
    if (facial) {
      for (const [family, variant] of [[FAMILY_FACIAL_1, facial[0]], [FAMILY_FACIAL_3, facial[1]], [FAMILY_FACIAL_2, facial[2]]] as const) {
        if (variant > 0 && !hidden.has(family)) geosets.add(geosetId(family, variant));
      }
      // The fifth column of the same row is the racial eye glow: always 2, on 55 of the 172
      // playable rows, and 1702 exists in exactly the six models those rows belong to. A helmet
      // does not cover it, so it is not subject to the hiding rules.
      if (facial[3] > 0) geosets.add(geosetId(FAMILY_EYE_GLOW, facial[3]));
    }

    for (const [family, variant] of families) {
      // In stock data, variant 1 on a non-naked garment family means "draw nothing". A coordinated
      // HD model may author that formerly-empty variant (notably HumanMale's 1801 belt), so only
      // that profile is allowed to publish it.
      if (!this.#coordinatedVisuals && variant === 1 && !NAKED_VARIANTS.has(family)) continue;
      if (hidden.has(family)) continue;
      geosets.add(geosetId(family, variant));
    }
    return [...geosets].sort((left, right) => left - right);
  }

  /**
   * Which geoset families a helmet covers up, from HelmetGeosetVisData.
   *
   * The table is 21 rows of seven columns, and each column is a bitmask over ChrRaces.ID rather
   * than a boolean — the arithmetic settles it: 4094 is bits 1 to 11, exactly the eleven playable
   * race ids; 4194302 is bits 1 to 21, exactly the races in ChrRaces; and the negative values are
   * the same masks written as signed words, so -65 is everything except bit 6.
   *
   * The race exclusions say what each column means. The common male full-helm row hides column 0
   * for every race except tauren, who wear a helm over horns; column 1 for every race except the
   * scourge, whose jaw is facial hair; column 3 for every race except the scourge and trolls,
   * whose tusks live in family 3; and column 4 for every race except night elves and trolls, whose
   * ears stay out. That is hair, then the three facial-hair families, then the ears. What columns 5
   * and 6 mean is not recoverable — only four of the twenty-one rows use them at all — so they are
   * left alone.
   *
   * HelmetGeosetVisID has one entry per sex, and 0 means hide nothing — which is what 169 of the
   * 1,314 head displays in this dataset say.
   */
  #hiddenFamilies(race: number, sex: number, equipment: readonly EquippedItem[]): Set<number> {
    const hidden = new Set<number>();
    for (const item of equipment) {
      if (item.slot !== EQUIPMENT_SLOT_HEAD) continue;
      const row = this.#helmetVisibility.get(this.#itemDisplays.get(item.displayId)?.helmetVisibility[sex === 1 ? 1 : 0] ?? 0);
      if (!row) continue;
      for (let column = 0; column < HELMET_HIDES_FAMILY.length; column++) {
        const family = HELMET_HIDES_FAMILY[column];
        // Signed words, so shift rather than compare: bit n is race n.
        if (family !== undefined && ((row[column] ?? 0) & (1 << race)) !== 0) hidden.add(family);
      }
    }
    return hidden;
  }

  /**
   * One equipped item's component textures, painted onto the body.
   *
   * Only the sections its own slot owns: an ItemDisplayInfo row commonly carries the rest of the
   * armour set as well, and painting those would dress the wearer in a set it is not wearing.
   *
   * Component textures carry a gender suffix — `_M` and `_F`, or `_U` when the piece is the same
   * for both. Measured: `Cloth_B_01Yellow_Glove_AL` ships only as `_U`, while
   * `Leather_A_05Yellow_Pant_LU` ships as `_M` and `_F` and not as `_U`, so both have to be tried.
   *
   * Which of them to try **first** is the whole of Т7, and the table cannot say: `ItemDisplayInfo`
   * names the stem alone. Putting the gendered spelling first, as this did, is a guaranteed 404 for
   * most of them, and the atlas cannot finish until every one of those 404s has come back, so the
   * unit keeps its capsule for the round trip. With a listing of the archives the order is decided
   * here, once, off a Set lookup.
   *
   * Measured on this machine by running both indexes over the 38,609 items of `data/items.json`:
   * of the 35,904 component layers the equippable displays paint on a human of either sex, the
   * first path offered did not exist for **27,364** — 76.2%, and the report's own 76.1% over the
   * whole table from the other direction — against **75** now. Legs alone, which is where the
   * player looked: 2,243 real `INVTYPE_LEGS` items, 1,498 distinct displays, 1,494 `LegUpperTexture`
   * layers over 948 distinct names, **1,291 first-request 404s before and 5 after**.
   *
   * What the listing does to a name is stated exactly, because the first form of this comment said
   * "never removes a spelling, only reorders" and that is not what the code below does. Counted
   * over the 80,988 component names `ItemDisplayInfo` mentions, against the male pair:
   *
   * - **79,772** have exactly one spelling in the archives, and only that one is offered. Dropping
   *   the other is the whole saving — it is a guaranteed 404 and the body waits for it.
   * - **316** have both, and both are offered, the held one first.
   * - **900** have neither, and both are offered in the old order — which is also what a name the
   *   listing has nothing to say about gets (`knows`). That is what the five leftover leg names
   *   are, every one of them a "Deprecated"/"OLD" item, and they pay the two 404s they always paid.
   *
   * `knows` is the guard for an archive that answers an enumeration with nothing because it carries
   * no `(listfile)` — without it a module's textures would be declared missing all at once. On this
   * client it never fires: the listing reaches exactly nine directories and `knows` is true for all
   * 80,988 names. It is not dead weight, though, and it is not the only thing standing there: an
   * archive tswow's own `build package` writes always carries a `(listfile)`, because
   * `misc/mpqbuilder/mpqbuilder.cpp:127` calls `SFileCreateArchive`, which forces one on however it
   * is called — «Backward compatibility: SFileCreateArchive always used to add (listfile)»,
   * `SFileCreateArchive.cpp:93-95` of the StormLib that build fetched. So the residue is an archive
   * some other tool wrote, and for that one `knows` is the answer.
   */
  #paint(item: EquippedItem, sex: number, body: BodyLayer[]): void {
    const display = this.#itemDisplays.get(item.displayId);
    if (!display) return;
    const slot = SLOT_APPEARANCE[effectiveType(item.inventoryType, display.geosetGroups)];
    if (!slot) return;

    for (const component of slot.components) {
      const name = display.textures[component];
      const section = COMPONENT_SECTIONS[component];
      if (!name || !section) continue;
      const directory = `Item\\TextureComponents\\${COMPONENT_DIRECTORIES[component]}`;
      const gendered = texturePath(`${directory}\\${name}_${sex === 1 ? "F" : "M"}.blp`);
      const unisex = texturePath(`${directory}\\${name}_U.blp`);
      if (!gendered && !unisex) continue;
      const spellings = [gendered, unisex].filter((path) => path !== "");
      const held = this.#textures ? spellings.filter((path) => this.#textures!.has(path)) : [];
      const candidates = held.length > 0 ? held : spellings;
      const layer: BodyLayer = { path: candidates[0]!, section, candidates };
      const alternate = candidates[1];
      if (alternate !== undefined) layer.alternate = alternate;
      body.push(layer);
    }
  }
}

function sectionKey(base: number, race: number, sex: number, variation: number, colour: number): string {
  return `${base}/${race}/${sex}/${variation}/${colour}`;
}
