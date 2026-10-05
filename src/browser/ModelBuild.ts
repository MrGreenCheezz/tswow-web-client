// Turning a WVM5 model plus one appearance into three.js geometry and materials.
//
// This is where the decisions the artifact deliberately does not make get made: which submeshes
// this particular character shows, which file fills each texture slot, and what each batch's
// blend mode and material flags mean in three.js terms.
//
// What it replaces built one MeshStandardMaterial per texture URL with `side: DoubleSide` and
// `alphaTest: 0.15` for everything, never set `transparent`, and drew every geoset at once. On a
// tauren that is twelve hairstyles and twelve cloaks stacked on each other; on every humanoid it
// is an opaque blue rectangle across the eyes, because the additive eye-glow batch was composited
// as if it were solid.

import * as THREE from "three";
import { installGroundCoverFade, type GroundCoverFadeUniforms } from "./GroundCoverFade.js";
import {
  BLEND_ADD, BLEND_ALPHA, BLEND_ALPHA_KEY, BLEND_BLEND_ADD, BLEND_MOD, BLEND_MOD2X,
  BLEND_NO_ALPHA_ADD, BLEND_OPAQUE,
  MATERIAL_NO_DEPTH_TEST, MATERIAL_NO_DEPTH_WRITE, MATERIAL_TWO_SIDED, MATERIAL_UNFOGGED, MATERIAL_UNLIT,
  TEXTURE_TYPE_HAIR, TEXTURE_TYPE_OBJECT_SKIN, TEXTURE_TYPE_OWN, TEXTURE_TYPE_SKIN_EXTRA,
  TEXTURE_WRAP_X, TEXTURE_WRAP_Y,
  textureUrl, type WvmBatch, type WvmColour, type WvmModel, type WvmTextureTransform, type WvmTrack,
} from "./Wvm.js";
import { sampleTrack } from "./Particles.js";
import { renderSwitches } from "./RenderSwitches.js"; // 05.10-A7a-F1
import { resolvedCombiner, secondUnitTransform } from "./M2Combiners.js"; // 05.10-A7a-F2
import type { CharacterAppearance } from "../gateway/CharacterAppearance.js";
import { applyWorldLight, type WorldLightUniforms } from "./WorldLighting.js";
import {
  installVegetationWind, isVegetationWindBatch, vegetationWindProfile as modelVegetationWindProfile,
  type VegetationWindProfile,
} from "./VegetationWind.js";
import { syncModelPlacementTintMaterials } from "./ModelPlacementTint.js";
import { registerPendingTextureView } from "./TextureLoad.js";

/**
 * Which geoset of each family to draw.
 *
 * Geoset numbering is `family * 100 + variant`, and the client shows at most one variant per
 * family: 0 is the body and always draws, 1xx is the hairstyle, 2xx and 3xx facial hair, 5xx
 * gloves, 8xx sleeves, 9xx trouser legs, 10xx and 13xx boots, 11xx hands, 15xx the cloak,
 * 17xx the eye glow. A character's own choices come from CharSections and the appearance bytes;
 * everything else follows from what it is wearing, which nothing equips yet.
 */
export interface GeosetChoice {
  /** family (1, 2, 3, …) to variant. A family that is absent shows nothing. */
  readonly variants: ReadonlyMap<number, number>;
  /** When present, exactly these ids are drawn and `variants` is ignored. */
  readonly explicit?: ReadonlySet<number>;
  /** Draw everything the file contains, whatever it is numbered. */
  readonly everything?: boolean;
}

/**
 * The families whose ids are not variants of one part, so the nearest one is not a substitute.
 *
 * The substitution rule below reads a geoset id as "part F, spelling V", and answers the question
 * an item asks: the display says boot variant 3 and the model spells its only boot 505, so 505 is
 * the boot. Three families do not ask that question, and the numbers here are measured on this
 * machine.
 *
 * **0 — the body and the hair.** Its members are not alternatives: 0 is the body itself (624 of
 * HumanMale's 6,356 triangles, z 0.00 to 1.96), 1 is the crown cap Т4 added, and 2 upwards are the
 * hairstyles. The lowest present member of a hairstyle is therefore the torso. Over the 15,444 NPC
 * displays on a readable character model every family-0 substitution landed on geoset 0 and drew
 * nothing new, geoset 0 being on every list already — FelOrcMale 2 → 0 on 136 displays,
 * VrykulMale 5 → 0 on 30 and 6 → 0 on 26, IceTrollMale 7 → 0 on 1 — so all the rule did there was
 * make the lab report 193 substitutions that put no triangle on the screen. wowee agrees by
 * construction: 0 is its "draw nothing" return value and `resolveGeoset` cannot hand it back.
 *
 * **1, 2 and 3 — the facial hair.** The number is the look's own index and not a spelling of a
 * part: measured over the 172 playable `CharacterFacialHairStyles` rows, 29 name nothing at all
 * and **131 of the remaining 143 put the same number in every non-zero column**, so "variation 4"
 * means piece 4 of the beard, piece 4 of the horns and piece 4 of the tusks. A model authors the
 * pieces its looks have and no others, and a family with no member of that index is a look with no
 * piece there, not a piece spelt differently: TaurenMale's look 4 is horn 105 alone, and resolving
 * gave it 202 and 302 as well, the head-plate and the snout-piece of look 2 (measured on the
 * model, the three families sit in three different places — 105 at x 0.35..0.74 z 1.58..1.78, 202
 * at 0.28..0.42 / 1.49..2.02, 302 at 0.67..0.77 / 1.69..1.77 — so it is a mixed face, not a second
 * horn). It also collapses distinct choices: NightElfMale carries family 1 as 103, 106, 107 only,
 * and resolving made his looks 1, 2, 3 and 4 all wear 103. Eleven of the 172 offered variations
 * moved this way, 868 times over the offered (style, colour, facial) rectangle. wowee's player
 * path does not resolve them either and says so (`entity_spawner_player.cpp:434`); its NPC path
 * resolves group 300 alone, with a hand-written 300/301 fallback (`entity_spawner.cpp:1477-1482`).
 *
 * **17 — the racial eye glow.** The nearest member is another race's eyes. wowee never meets the
 * case because it only ever asks for 1701 (`entity_spawner.cpp:1490`), which is variant 1 and
 * therefore "none"; this gateway emits 1702 out of the fifth column of `CharacterFacialHairStyles`,
 * and 1702 on a model carrying only 1703 resolved to the death knight's glow — the exact defect
 * the bare-geoset comment above warns about. Five NPC displays did it: 11810 and 19379 on
 * `Character\Human\Female`, 16157 and 16427 on `Character\Human\Male`, 18242 on
 * `Character\Orc\Male`, every one of them a slot-type-0 batch that carries its own texture and
 * would have rendered.
 *
 * Family 7 is deliberately *not* here. 701 and 702 are the helmet plug and the ear, and a model
 * that carries only the plug is a model whose ear hole wants closing: the substitution fires on
 * 137 NPC displays and is the rule working as intended.
 *
 * Spelt out here rather than imported from the gateway's own constants: that module reads DBCs off
 * disk and must not be bundled into the page.
 */
const UNRESOLVED_FAMILIES: ReadonlySet<number> = new Set([0, 1, 2, 3, 17]);

/**
 * The colour a batch is painted when nothing fills its texture slot.
 *
 * Named because it is a diagnosis and not a decoration: it is what a tauren's horns are drawn in
 * (slot 8, which nothing fills), and what the torso of every display without a texture list is
 * drawn in. `character-lab.html` counts the triangles wearing it.
 */
export const FLAT_SLOT_COLOUR = 0x71845e;

/**
 * Nothing but geoset 0. This remains the defensive default for callers that do not know what kind
 * of model they are building; a unit always goes through `unitGeosets` below, which can distinguish
 * a character from a pre-composed creature.
 */
export const BODY_ONLY: GeosetChoice = { variants: new Map() };

/**
 * Everything in the file. Right for an item model, whose submeshes are not variants of anything:
 * of 2,125 weapon, shield and shoulder models in the client, 2,124 put every submesh on geoset 0
 * and the one exception is a staff that splits itself across several — none of them is a choice.
 */
export const EVERY_GEOSET: GeosetChoice = { variants: new Map(), everything: true };

/**
 * A bare character: what to draw when nobody has said what this one looks like.
 *
 * Geoset 0 is the torso and head, 401 the hands, 501 the shins, 702 the ears, 1301 the thighs and
 * 1501 the collar. It is the naked half of what the gateway emits for a real appearance — the
 * hairstyle and the facial hair are the only things missing, and neither can be guessed.
 *
 * Written down here because geoset 0 alone is *not* a whole character. Measured over the twenty
 * playable models with position-matched boundary edges below 60% of each body's height: geoset 0
 * by itself leaves 16 to 52 open edges running from the ankle to the hip — HumanMale 30 over
 * z 0.13..1.11, GnomeMale 52 over 0.06..0.78, TaurenMale 48 over 0.22..1.40 — against 0 for
 * sixteen of the twenty with this list and an authored seam on the other four (ScourgeMale 8,
 * ScourgeFemale 24, TrollMale 2, TrollFemale 2, every one of them fewer than geoset 0 alone left).
 * That is "the legs are not visible", exactly.
 *
 * What was here before was `family 7 → variant 1` and 801/901/1001/1101/1201/1801, which no
 * playable model carries at all, and it was called from nowhere. 701 is not the ear: the 700
 * family *is* the ears, 701 is the two-to-ten-triangle plug a helmet leaves behind and 702 is the
 * ear itself — HumanMale 6 triangles against 14, TaurenMale 4 against 20, and NightElf and Troll
 * carry no 701 whatsoever.
 */
export function defaultCharacterGeosets(): GeosetChoice {
  return geosetList([0, 401, 501, 702, 1301, 1501]);
}

/**
 * What one unit draws: the gateway's list where there is one, the naked default where the model is
 * a character and nobody has said what it looks like, and every authored geoset for a pre-composed
 * creature with no appearance.
 *
 * `isCharacter` is the model's own type 1 body slot, and the distinction is measured rather than
 * cautious. The M2 itself is the source of truth for a pre-composed creature: child models such as
 * HumanMaleKid put their legs in 401/501/503, while Ogre and HumanMalePeasant use 501/1301 and
 * 401/501/503 respectively. None has a gateway appearance to select those parts. Treating such a
 * model as BODY_ONLY therefore drops authored geometry. This also matches wowee's entity path:
 * an NPC instance starts with an empty active-geoset set, so the renderer draws the model's batches
 * as authored; only the character-composition path installs a geoset mask.
 */
export function unitGeosets(appearance: CharacterAppearance | undefined, isCharacter: boolean): GeosetChoice {
  if (appearance) return geosetList(appearance.geosets);
  return isCharacter ? defaultCharacterGeosets() : EVERY_GEOSET;
}

/**
 * The world renderer's character choice, checked against the WVM that actually arrived.
 *
 * Patch-W's ordinary boot group is not a portable shape contract: several of its playable models
 * carry ordinary family-5 variants only to the ankle, while another authored variant in the same
 * file reaches the foot atlas rectangle. The gateway has a measured patch-W profile table for
 * known player looks; validate it here after the model is known as well, because this is also the
 * path for baked NPC appearances and stale/custom gateway callers. The generic resolver still must
 * not guess a family member. A lower-leg-only model is still drawn; it is an asset boundary, not
 * permission to invent geometry.
 */
const BOOT_FAMILY = 5;
const FOOT_ATLAS_MIN_V = 0.8755;
/**
 * A few authored ankle vertices can cross the foot row without making a foot. Count triangles,
 * not the largest V, and require a meaningful share of the boot's own surface before accepting
 * it as a foot-capable mesh. This deliberately leaves hoof models (whose authored foot row is
 * absent or only a seam) on their original variant.
 */
const FOOT_TRIANGLE_SHARE_MIN = 0.10;

function submeshFootCoverage(model: WvmModel, geosetId: number): {
  triangles: number; footTriangles: number; legLowerTriangles: number;
} {
  let triangles = 0;
  let footTriangles = 0;
  let legLowerTriangles = 0;
  for (const submesh of model.submeshes) {
    if (submesh.geosetId !== geosetId || submesh.indexCount <= 0) continue;
    for (let i = submesh.indexStart; i < submesh.indexStart + submesh.indexCount; i += 3) {
      triangles++;
      const uv = [0, 1, 2].map((corner) => {
        const vertex = model.indices[i + corner] ?? 0;
        return [model.uv0[vertex * 2] ?? 0, model.uv0[vertex * 2 + 1] ?? 0] as const;
      });
      if (uv.every(([u, v]) => u >= 0.49 && v >= FOOT_ATLAS_MIN_V)) footTriangles++;
      if (uv.every(([u, v]) => u >= 0.49 && v >= 0.625 && v < FOOT_ATLAS_MIN_V)) {
        legLowerTriangles++;
      }
    }
  }
  return { triangles, footTriangles, legLowerTriangles };
}

export function worldCharacterGeosets(
  model: WvmModel,
  appearance: CharacterAppearance | undefined,
  isCharacter: boolean,
): GeosetChoice {
  const choice = unitGeosets(appearance, isCharacter);
  if (!appearance?.coordinatedVisuals) return choice;
  const hasFootTexture = appearance?.body.some((layer) => layer.section === "foot")
    || appearance?.body.length === 1
      && appearance.body[0]?.section === undefined
      && /^Textures\\BakedNpcTextures\\/i.test(appearance.body[0]?.path ?? "");
  if (!hasFootTexture || !choice.explicit) return choice;

  const selected = [...choice.explicit].find((id) => Math.floor(id / 100) === BOOT_FAMILY);
  if (selected === undefined) return choice;
  const selectedCoverage = submeshFootCoverage(model, selected);
  const hasMeaningfulFoot = selectedCoverage.triangles > 0
    && selectedCoverage.legLowerTriangles > 0
    && selectedCoverage.footTriangles / selectedCoverage.triangles >= FOOT_TRIANGLE_SHARE_MIN;
  if (hasMeaningfulFoot) return choice;

  const candidateIds = [...new Set(model.submeshes
    .filter((submesh) => Math.floor(submesh.geosetId / 100) === BOOT_FAMILY && submesh.indexCount > 0)
    .map((submesh) => submesh.geosetId))];
  const candidate = candidateIds
    .map((id) => ({ id, coverage: submeshFootCoverage(model, id) }))
    .filter(({ coverage }) => coverage.triangles > 0
      && coverage.legLowerTriangles > 0
      && coverage.footTriangles / coverage.triangles >= FOOT_TRIANGLE_SHARE_MIN)
    .sort((left, right) => {
      const share = right.coverage.footTriangles / right.coverage.triangles
        - left.coverage.footTriangles / left.coverage.triangles;
      return share || left.id - right.id;
    })[0];
  if (!candidate) return choice;

  return geosetList([...choice.explicit].filter((id) => Math.floor(id / 100) !== BOOT_FAMILY).concat(candidate.id));
}

export function chooseGeosets(entries: Iterable<readonly [number, number]>): GeosetChoice {
  return { variants: new Map(entries) };
}

/**
 * An explicit list of geoset ids, which is what the gateway sends for a character: the hairstyle
 * chosen from CharHairGeosets, the three facial-hair pieces from CharacterFacialHairStyles, and
 * the ears. Anything not listed stays hidden.
 */
export function geosetList(ids: Iterable<number>): GeosetChoice {
  return { variants: new Map(), explicit: new Set(ids) };
}

/**
 * The geoset a model should actually draw for one the gateway asked for.
 *
 * The gateway chooses from the DBCs and the DBCs do not know what is in a given file: an item's
 * `GeosetGroup` says "boot variant 3" and whether the model carries a boot variant 3 is a question
 * only the model can answer. Measured over 11,685 distinct (inventoryType, displayId) pairs against
 * the twenty playable models: family 5 exists on both tauren as **variant 5 only**, and the 1,327
 * distinct `INVTYPE_FEET` displays emit 501×362, 502×471, 503×161, 504×302, 505×31 — so **934 of
 * the 1,327 (70.4%)** name a boot the tauren does not have and used to draw no shaft at all.
 * Family 11 exists in all twenty as variants 2 and 4, and one item — "Legguards of the Vault",
 * entry 9396, display 18274, `GeosetGroup[0] = 2` — asks all twenty for 1103.
 *
 * The rule is the reference client's, written down at `geoset_rules.hpp:81-100`: the id if the
 * model has it; nothing if the id means "none", which is variant 0 or 1; otherwise the lowest
 * member of the same family the model does carry. `undefined` is "draw nothing", which is what an
 * empty family means as well.
 *
 * `UNRESOLVED_FAMILIES` are outside it, and the review found all three cases by measuring the NPCs
 * and the offered looks rather than the outfit sweep, which pins hair and facial hair at zero.
 */
export function resolveGeosetId(geosetId: number, present: ReadonlySet<number>): number | undefined {
  if (present.has(geosetId)) return geosetId;
  const variant = geosetId % 100;
  // 0 and 1 are both spellings of "this character has none of it": the geoset tables use variant 1
  // — 501 is bare feet, 1501 is no cloak — and a DBC that stores the variant directly uses 0.
  if (variant <= 1) return undefined;
  const family = Math.floor(geosetId / 100);
  if (UNRESOLVED_FAMILIES.has(family)) return undefined;
  let lowest: number | undefined;
  for (const candidate of present) {
    if (Math.floor(candidate / 100) !== family) continue;
    if (lowest === undefined || candidate < lowest) lowest = candidate;
  }
  return lowest;
}

/**
 * The list the gateway sent, resolved against what this model carries.
 *
 * Only the explicit list, which is the one a character is built from; `variants` and `everything`
 * name no ids to resolve. The substitutions are handed back rather than worked out again by
 * whoever wants to show them: `character-lab.html` prints "the gateway asked for 502, the model
 * drew 505", and a second implementation of this arithmetic in the panel is exactly the drift the
 * panel exists to catch.
 */
export function resolveGeosets(choice: GeosetChoice, present: ReadonlySet<number>): {
  choice: GeosetChoice; substitutions: Map<number, number>;
} {
  const substitutions = new Map<number, number>();
  if (!choice.explicit) return { choice, substitutions };
  const drawn = new Set<number>();
  for (const geosetId of choice.explicit) {
    const resolved = resolveGeosetId(geosetId, present);
    if (resolved === undefined) continue;
    drawn.add(resolved);
    if (resolved !== geosetId) substitutions.set(geosetId, resolved);
  }
  return { choice: { ...choice, explicit: drawn }, substitutions };
}

/** True when this submesh should be drawn for the chosen appearance. */
export function geosetVisible(geosetId: number, choice: GeosetChoice): boolean {
  if (choice.everything) return true;
  if (choice.explicit) return choice.explicit.has(geosetId);
  if (geosetId === 0) return true;
  const family = Math.floor(geosetId / 100);
  const variant = geosetId % 100;
  const chosen = choice.variants.get(family);
  // A family nobody chose for is hidden rather than drawn wholesale — that is the bug this exists
  // to fix, and showing nothing is much closer to right than showing every variant at once.
  return chosen !== undefined && chosen === variant;
}

/** The textures the client supplies for the slots the model leaves open, by M2Texture.type. */
export type TextureSlots = ReadonlyMap<number, string>;

/** Parses the gateway's `slotType:path` list into a map. */
export function parseTextureSlots(spec: string): TextureSlots {
  const slots = new Map<number, string>();
  for (const entry of spec.split(",")) {
    const separator = entry.indexOf(":");
    if (separator <= 0) continue;
    const type = Number.parseInt(entry.slice(0, separator), 10);
    const value = entry.slice(separator + 1).trim();
    if (Number.isInteger(type) && type > 0 && type < 64 && value) slots.set(type, value);
  }
  return slots;
}

/**
 * The files that fill a model's open texture slots: what the display record supplies, plus the
 * two a character resolves from its own appearance.
 *
 * Both were computed and then dropped. The hair slot was left empty, so every hairstyle in the
 * game rendered as the flat green a missing texture falls back to; and nothing had ever filled
 * the type 2 slot, which on a character model is the cloak and only the cloak.
 *
 * It lives here rather than in `WorldRenderer3D`, where it was written, because `character-lab.html`
 * has to fill a character's slots exactly the way the renderer does and must not import the whole
 * renderer to do it — and every other decision about what fills a slot is already in this file.
 */
export function characterSlots(textures: string, appearance: CharacterAppearance | undefined): TextureSlots {
  const slots = new Map(parseTextureSlots(textures));
  if (appearance?.hair) slots.set(TEXTURE_TYPE_HAIR, appearance.hair);
  if (appearance?.cloak) slots.set(TEXTURE_TYPE_OBJECT_SKIN, appearance.cloak);
  // The tauren's slot, and only theirs among the playable twenty: TaurenMale and TaurenFemale are
  // the only models that declare type 8 and the only two that declare no type 6. With it empty,
  // 166 of a naked tauren male's 1,196 drawn triangles and 132 of a female's 1,224 were painted
  // flat green — the horns, part of the hide and the cloak collar. Measured through this very
  // function: supplying it takes both to zero.
  if (appearance?.skinExtra) slots.set(TEXTURE_TYPE_SKIN_EXTRA, appearance.skinExtra);
  return slots;
}

/**
 * The MPQ path for one texture slot of a model, or "" when nothing fills it.
 *
 * A monster skin arrives as a bare name that lives beside the model; a body, hair or baked NPC
 * texture arrives as a full path. The separator tells them apart.
 */
export function resolveSlot(slot: { type: number; path: string }, slots: TextureSlots, modelDirectory: string): string {
  if (slot.type === TEXTURE_TYPE_OWN) return slot.path;
  const supplied = slots.get(slot.type);
  if (!supplied) return "";
  if (supplied.includes("\\")) return supplied;
  return modelDirectory ? `${modelDirectory}\\${supplied}.blp` : "";
}

export function modelDirectoryOf(modelPath: string): string {
  const separator = modelPath.lastIndexOf("\\");
  return separator < 0 ? "" : modelPath.slice(0, separator);
}

/**
 * Below this a batch is not drawn at all, whatever its blend mode.
 *
 * The reference client's own threshold — `character_renderer.cpp:2758` culls on
 * `batchColorAlpha <= 0.01f` — and not drawing is the only thing that works across the modes: an
 * opaque batch ignores alpha entirely, so an artist who switched one off by weighting it to zero
 * is obeyed only by leaving it out of the frame.
 */
const BATCH_INVISIBLE = 0.01;

/**
 * The animation sequence a model nobody is posing is in.
 *
 * Both tracks nest one sub-array per *sequence*, and a sequence with no keys is not "invisible",
 * it is "this track has nothing to say while that plays" — the reference client's samplers return
 * their default there (`m2_track_sampler.hpp:68-74`). Which sequence to read therefore decides
 * what is on the screen, and it is measured rather than assumed. Two findings settle it on 0:
 *
 * * **The body of every playable model carries an alpha track, and its keys are under Death.**
 *   HumanMale's is sequence 7 (animation 1, Death) and 120 (131, Drown), HumanFemale's 28 and 97,
 *   and so on for all twenty — ramping 1 → 0, which is the corpse fading out. Reading the first
 *   sub-track on a shared clock instead would have faded every character in the game out and back
 *   every two seconds.
 * * **A doodad's alternatives are spelt as sequences.** `dalaran_fountain_01.m2` has three:
 *   Stand, Closed and Opened. Under Stand 12 of its 25 batches draw for 5,285 triangles — the
 *   water — and under Opened 15 draw for 32,616 — the statues. The two sets are complementary,
 *   and this client used to draw both at once.
 *
 * Sequence 0 is Stand on the doodads that matter and is what the original client plays for a model
 * with no state. A unit's own clip cannot drive this without one material per unit, which would
 * undo the build cache; carrying the animation-to-sequence map and reading the played one is the
 * next slice, and what it buys is the death fade.
 *
 * 05.10-A7a-F1 correction: HumanMale's track keyed under Death is the texture weight of its two
 * death-knight eye-glow cards (geoset 1703), which blink 1 → 0 → 1 within 433 ms — not a body fade.
 * The real Death fades are creatures' (922 batches in 184 models: elementals, voidwalkers, wraiths);
 * `BatchDeathFade.ts` reads them per unit from the played Death clip.
 */
const REST_SEQUENCE = 0;

/**
 * One batch's two tracks, resolved out of the model's tables.
 *
 * `colorIndex` is a raw `uint16` with 0xFFFF for "none", and `textureWeight` has already been
 * resolved through the texture-weight combo table by `tools/m2.mjs`, so both are direct indices.
 * Neither is ever out of range in this client — measured, 0 of 61,190 batches — but a module's own
 * model is not this client, and a batch pointing past the end must not throw.
 */
function batchTracks(model: WvmModel, batch: WvmBatch): { colour?: WvmColour; weight?: WvmTrack } {
  const colour = model.colours?.[batch.colorIndex];
  const weight = batch.textureWeight >= 0 ? model.textureWeights?.[batch.textureWeight] : undefined;
  return { ...(colour ? { colour } : {}), ...(weight ? { weight } : {}) };
}

/**
 * A batch whose colour or opacity the file paints, and the material it paints.
 *
 * The material is shared by every placement of the model — that is what makes a hundred barrels
 * one set of GPU buffers — so the whole set moves on one clock. For a doodad that is exactly
 * right; for two units of one appearance it means their eye-glow blinks in step, which is the same
 * approximation the emitter path has made since it arrived.
 */
export interface AnimatedBatch {
  material: THREE.Material & { color: THREE.Color; opacity: number };
  colour?: WvmColour;
  weight?: WvmTrack;
  /**
   * The `M2TextureTransform` this batch names, and the texture it writes into.
   *
   * The texture is carried rather than reached through `material.map` because the two are not the
   * same question: a batch with a transform always has a map of its own (see `privateTextureView` below),
   * and a batch without one must not have its matrix written at all.
   */
  transform?: WvmTextureTransform;
  map?: THREE.Texture;
  /** 05.10-A7a-F2 (6.16б): the second stage's own transform and the texture it moves (`alphaMap`). */
  transform2?: WvmTextureTransform;
  map2?: THREE.Texture;
  /** Loop durations a track may be bound to, carried so the entry can be sampled on its own. */
  globalSequences: Uint32Array;
  /** Whether the tint reaches `material.color`; a batch with no texture keeps its diagnosis colour. */
  tinted: boolean;
}

/**
 * Moves every painted batch of a build to where its tracks say it is now: its colour, its opacity
 * and — since WVM9 — where its texture sits.
 *
 * Called once per build rather than once per placement, because the materials are the build's.
 * `animationMs` is normally the wall clock, but spell builds pass their local phase age so two
 * concurrent casts do not share a global alpha window. `worldMs` remains the wall clock for tracks
 * bound to a global loop. A track that is not bound to one wraps on the span of its own keys, which
 * is what makes the ZZZZ's three letters rise 0 → 1 → 0 on three staggered clocks.
 */
export function updateBatchAppearance(
  batches: readonly AnimatedBatch[], animationMs: number, worldMs = animationMs,
): void {
  for (const entry of batches) {
    const sequences = entry.globalSequences;
    const at = (track: WvmTrack | undefined, component = 0, fallback = 1): number =>
      sampleTrack(track, animationMs, worldMs, sequences, fallback, component, REST_SEQUENCE);
    const opacity = Math.max(0, Math.min(1, at(entry.colour?.alpha) * at(entry.weight)));
    if (entry.tinted) {
      entry.material.color.setRGB(at(entry.colour?.rgb, 0), at(entry.colour?.rgb, 1), at(entry.colour?.rgb, 2));
    }
    entry.material.opacity = opacity;
    // Not a fade to nothing: an opaque batch ignores alpha and an alpha-keyed one would still draw
    // its texture's opaque fragments. The reference client skips the draw; three's equivalent is a
    // material that is not visible, and three checks that per geometry group.
    entry.material.visible = opacity > BATCH_INVISIBLE;
    if (entry.transform && entry.map) writeTextureMatrix(entry.transform, entry.map.matrix, at);
    if (entry.transform2 && entry.map2) writeTextureMatrix(entry.transform2, entry.map2.matrix, at); // 05.10-A7a-F2
    syncModelPlacementTintMaterials(entry.material);
  }
}

/**
 * The name this had while it only moved colours, kept as an alias.
 *
 * The five call sites are in `WorldRenderer3D.ts` — the import at :37, the per-frame pass at
 * :3267-3272 and the spell clock at :3064 — and every one of them lies outside the line ranges
 * this slice's lane owns in that file. Renaming them is a one-word edit and belongs to whichever
 * slice next has that file open.
 */
export const updateBatchColours = updateBatchAppearance;

/**
 * One `M2TextureTransform` at a moment, as three's UV matrix.
 *
 * The file stores translation, rotation and scaling apart, and the client composes them about the
 * texture's own centre: scale and turn around (0.5, 0.5), then slide. `Matrix3.setUvTransform`
 * builds that in one call, which is why nothing here multiplies matrices by hand — with two
 * caveats about which way it turns and in which order, both settled below.
 *
 * Only the turn about Z survives: the record's rotation is a full quaternion but UVs are flat, and
 * `2·atan2(z, w)` is that quaternion's angle about Z. Measured over the 84 rotation keys of the 418
 * records under `spells\`, 80 are rotations about Z alone with x and y at 0 to the bit; the other
 * four are one 0.5° tilt about X (−0.004363 in x), authored four times as the shieldwall impact's
 * colour variants, and a tilt out of the UV plane is nothing this can apply anyway.
 *
 * The angle goes in **negated**, and that is the whole of the difference between a rune that turns
 * the way the artist drew it and one that turns backwards. `setUvTransform`'s `rotation` argument
 * is `Texture.rotation`, which turns the *image*, so the matrix it builds is `S·R(−rotation)`:
 * its linear part is `[[c, s], [−s, c]]` (`three.core.js:6434-6447` in 0.185.1, and `updateMatrix`
 * below it is what passes `Texture.rotation` in). The record turns the coordinate instead, so the
 * two are inverses. Measured on the key the corpus actually holds, q = (0, 0, sin 45°, cos 45°) —
 * a +90° turn about Z: applied as the record states it, about (0.5, 0.5), it takes UV (1, 0) to
 * (1, 1), and `setUvTransform` with the angle un-negated takes that point to (0, 0), the opposite
 * corner. 80 of the 84 keys are affected, which is every rune and every portal in the set.
 *
 * That leaves `S·R` where the file writes `R·S`, and the order shows only under an anisotropic
 * scale: all 28 scaling keys under `spells\` have `sx === sy` to the bit, so there is nothing in
 * the corpus that can tell the two apart. The reference client settles neither question —
 * `m2_renderer_render.cpp:1581-1600` takes `translation` out of a texture transform and reads
 * neither the rotation nor the scale.
 */
function writeTextureMatrix(
  transform: WvmTextureTransform,
  matrix: THREE.Matrix3,
  at: (track: WvmTrack | undefined, component?: number, fallback?: number) => number,
): void {
  const angle = 2 * Math.atan2(at(transform.rotation, 2, 0), at(transform.rotation, 3, 1));
  matrix.setUvTransform(
    at(transform.translation, 0, 0), at(transform.translation, 1, 0),
    at(transform.scaling, 0, 1), at(transform.scaling, 1, 1),
    -angle, 0.5, 0.5);
}

/** Draw order: the client sorts on priorityPlane, then the material layer, then file order. */
function batchOrder(left: { batch: WvmBatch; index: number }, right: { batch: WvmBatch; index: number }): number {
  if (left.batch.priorityPlane !== right.batch.priorityPlane) return left.batch.priorityPlane - right.batch.priorityPlane;
  if (left.batch.materialLayer !== right.batch.materialLayer) return left.batch.materialLayer - right.batch.materialLayer;
  return left.index - right.index;
}

interface ModelDrawBatch {
  batch: WvmBatch;
  index: number;
  indexStart: number;
  indexCount: number;
}

function sameBatchMaterial(left: WvmBatch, right: WvmBatch): boolean {
  // Two-sided transparent rendering has a back/front pass per draw; joining those draws could
  // change compositing order during spawn fades. UV1 selection can also depend on each submesh.
  // Keep both on the authored path, along with explicitly blended/depth-independent batches.
  if ((left.blendMode !== BLEND_OPAQUE && left.blendMode !== BLEND_ALPHA_KEY)
    || (left.materialFlags & (MATERIAL_TWO_SIDED | MATERIAL_NO_DEPTH_WRITE | MATERIAL_NO_DEPTH_TEST)) !== 0
    || left.uvSets.some((uv) => uv !== 0)) return false;
  return left.blendMode === right.blendMode && left.materialFlags === right.materialFlags
    && left.priorityPlane === right.priorityPlane && left.materialLayer === right.materialLayer
    && left.shaderId === right.shaderId && left.colorIndex === right.colorIndex
    && left.textureWeight === right.textureWeight && left.textureTransform === right.textureTransform
    && (left.textureTransform2 ?? -1) === (right.textureTransform2 ?? -1) // 05.10-A7a-F2
    && left.textures.length === right.textures.length
    && left.textures.every((texture, index) => texture === right.textures[index])
    && left.uvSets.length === right.uvSets.length
    && left.uvSets.every((uv, index) => uv === right.uvSets[index]);
}

/**
 * Puts every joinable pass beside the first pass of its own state, so `modelDrawBatches` can join
 * them into one draw.
 *
 * A character's authored order alternates its states — body atlas, hair, skin extra, atlas again —
 * and joining only *adjacent* equals left DwarfMale at 11 draws for 3 states and HumanMalGuard at
 * 8 for 5 (the step-18 census). Every draw is a group in the main pass and again in each shadow
 * cascade: a city crowd of 64 spent 452 main and 294 shadow draws on its units. Only passes
 * `sameBatchMaterial` admits move — opaque or alpha-keyed, single-sided, depth-tested and
 * depth-written, on the first UV set — and among those the depth test makes the order between
 * different states immaterial except at exactly coplanar seams. Each joined state keeps the place
 * of its first pass, so a blended, two-sided or depth-independent pass never changes its position
 * relative to the states around it, and the triangles inside a state stay in authored order.
 */
function gatherEqualBatches(ordered: Array<{ batch: WvmBatch; index: number }>): Array<{ batch: WvmBatch; index: number }> {
  const groups: Array<Array<{ batch: WvmBatch; index: number }>> = [];
  for (const entry of ordered) {
    let joined = false;
    if (sameBatchMaterial(entry.batch, entry.batch)) {
      for (const group of groups) {
        if (sameBatchMaterial(group[0]!.batch, entry.batch)) {
          group.push(entry);
          joined = true;
          break;
        }
      }
    }
    if (!joined) groups.push([entry]);
  }
  return groups.flat();
}

/** Combine adjacent equal passes without changing the ordered triangle stream or vertex data. */
function modelDrawBatches(model: WvmModel, ordered: Array<{ batch: WvmBatch; index: number }>,
  coalesce: boolean): { batches: ModelDrawBatch[]; indices: WvmModel["indices"] } {
  const batches: ModelDrawBatch[] = [];
  let merged = false;
  let totalIndices = 0;
  for (const entry of ordered) {
    const submesh = model.submeshes[entry.batch.submesh]!;
    const previous = batches[batches.length - 1];
    if (coalesce && previous && sameBatchMaterial(previous.batch, entry.batch)) {
      previous.indexCount += submesh.indexCount;
      merged = true;
    } else {
      batches.push({ ...entry, indexStart: submesh.indexStart, indexCount: submesh.indexCount });
    }
    totalIndices += submesh.indexCount;
  }
  if (!merged) return { batches, indices: model.indices };

  // Selected geosets are often disjoint slices. Concatenate exactly their existing draw order:
  // duplicate/layered passes remain duplicate indices, and hidden alternatives stay absent.
  const indices = model.indices instanceof Uint32Array
    ? new Uint32Array(totalIndices) : new Uint16Array(totalIndices);
  let offset = 0;
  for (const { batch } of ordered) {
    const submesh = model.submeshes[batch.submesh]!;
    indices.set(model.indices.subarray(submesh.indexStart, submesh.indexStart + submesh.indexCount), offset);
    offset += submesh.indexCount;
  }
  offset = 0;
  for (const batch of batches) {
    batch.indexStart = offset;
    offset += batch.indexCount;
  }
  return { batches, indices };
}

export interface BuiltModel {
  geometry: THREE.BufferGeometry;
  materials: THREE.Material[];
  /** Height of the visible geometry, for name plates. */
  height: number;
  /** MPQ paths of every texture this build wants, so the caller can prefetch them. */
  texturePaths: string[];
  /**
   * The textures this build owns, so a caller that discards it can free them.
   *
   * `Material.dispose()` releases the shader program and nothing else — a texture is freed only by
   * its own `dispose()`, and `TextureLoader.load` hands back a new Texture every call rather than
   * caching. Anything supplied from outside, like a composed body atlas shared with other builds,
   * is deliberately absent: it is not this build's to free. A build that borrows cached bases also
   * excludes those bases while retaining every private material Texture view here.
   */
  ownedTextures: THREE.Texture[];
  /**
   * The `M2Texture.type` each material samples, parallel to `materials`; -1 for a batch that names
   * no texture at all.
   *
   * Recorded here because it is known here and nowhere else: which slot a batch reaches for follows
   * from the batch's own texture list, and the sort that decides material order happens inside this
   * function. Working it out again from outside means repeating that sort, which is exactly the
   * drift a diagnostic exists to catch. `character-lab.html` reads it to say *which* slot a flat
   * green triangle wanted — the tauren's horns are slot 8, and the panel used to be able to say
   * only that something was empty.
   */
  materialSlots: number[];
  /**
   * Ids the gateway asked for that this model does not carry, against the ones drawn instead.
   *
   * Empty for a model that has everything on its list, which is every playable model for its own
   * body. It is the tauren's boots that fill it: 934 of the 1,327 boot displays name 502, 503 or
   * 504 and he carries only 505.
   */
  geosetSubstitutions: Map<number, number>;
  /**
   * The batches whose colour or opacity moves, for whoever advances the model's clock.
   *
   * Empty on most of the world — 9,395 of the corpus's 61,190 batches move at all, in 1,795 of
   * its 22,112 models — and a build with an empty list costs the per-frame pass a length check.
   */
  animatedBatches: AnimatedBatch[];
}

/** One restrained model-relative wind profile; z is the authored M2 up axis. */
export function vegetationWindProfile(
  bounds: Pick<WvmModel, "bounds">["bounds"], modelPath = "",
): VegetationWindProfile | undefined {
  return modelVegetationWindProfile(bounds, modelPath);
}

/**
 * Builds one drawable model in authored draw order. An opted-in unit build can combine adjacent
 * identical passes into one geometry group and material.
 */
export function buildModel(
  model: WvmModel,
  options: {
    modelPath: string;
    slots?: TextureSlots;
    geosets?: GeosetChoice;
    baseUrl: string;
    loadTexture: (url: string) => THREE.Texture;
    /** Cached bases are borrowed; per-material Texture views created below remain build-owned. */
    borrowLoadedTextures?: boolean;
    /** Load each URL once within this build; materials keep private views of its shared pixels. */
    deduplicateLoadedTextures?: boolean;
    /**
     * Every loaded material map is a private Texture view over the borrowed base's shared Source.
     * Spell builds use this because wrap/flip/colour/anisotropy are per Texture, not per Source.
     */
    privateLoadedTextureViews?: boolean;
    /**
     * Textures supplied directly rather than by path, keyed on M2Texture.type. A player's body is
     * a canvas composed from five pieces, so it has no path of its own.
     */
    slotTextures?: ReadonlyMap<number, THREE.Texture>;
    skinned?: boolean;
    /** Join adjacent identical unit passes while preserving all triangles and their draw order. */
    coalesceAdjacentBatches?: boolean;
    /**
     * `renderer.capabilities.getMaxAnisotropy()`, when the caller has a renderer to ask.
     *
     * Absent it stays at three.js's default of 1, which is what the character lab and the tests
     * get. The world should not: every batch built here is sampled at a glancing angle sooner or
     * later — a foliage card, a shoulder plate, a cloak, a tabard — and at 1 the hardware picks a
     * mip a level or more too deep and the surface turns to mush. The ground splat
     * (`WorldRenderer3D.ts:3374`), the WMO batches (`:4194`) and the merged doodad build (`:5366`)
     * were the only three places in the client asking for the maximum; this is the same value
     * reaching the models — every creature, every doodad, every spell effect, every slot that
     * resolves to a path — that were left out of it.
     *
     * It reaches a slot and not a model, which leaves one surface out and it is the largest one a
     * player has: a character's body is handed to `buildMaterial` as a texture object rather than
     * as a path (`WorldRenderer3D.ts:4802`), and `supplied` returns before the path branch that
     * sets this (`:628-629` against `:645`). Hair, cloak and the armour slots that do resolve by
     * path are sampled at the maximum; the composed body is not, and it is still at 1 until
     * `CharacterAtlas.ts:346` sets it beside the wrap and colour-space flags it already sets.
     */
    anisotropy?: number;
    /** Shared authored outdoor light. Omitted by isolated model viewers and tests. */
    worldLight?: WorldLightUniforms;
    /** Local lift for additive spell meshes only; scenery and character materials never set it. */
    fantasyGlow?: boolean;
    /** GPU wind for strictly classified static foliage/ground-cover batches. */
    vegetationWind?: boolean;
    /** Only the separately cached ground-cover build uses the player's live distance fade. */
    groundCoverFade?: GroundCoverFadeUniforms;
  },
): BuiltModel {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(model.positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(model.normals, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(model.uv0, 2));
  // three.js names the second set `uv1`; only env-mapped batches sample it.
  geometry.setAttribute("uv1", new THREE.BufferAttribute(model.uv1, 2));
  if (options.skinned && model.boneIndices && model.boneWeights) {
    geometry.setAttribute("skinIndex", new THREE.BufferAttribute(model.boneIndices, 4));
    geometry.setAttribute("skinWeight", new THREE.BufferAttribute(model.boneWeights, 4));
  }
  geometry.setIndex(new THREE.BufferAttribute(model.indices, 1));

  const slots = options.slots ?? new Map<number, string>();
  const directory = modelDirectoryOf(options.modelPath);

  // What this file actually carries, once per build rather than once per submesh: the resolution
  // below asks it for every id on the list. Measured on HumanMale — 61 submeshes, 54 of them with
  // triangles, against the ten ids of a bare appearance — building the set and resolving the list
  // costs 0.0031 ms of a 0.063 ms build, one part in twenty.
  const present = new Set<number>();
  for (const submesh of model.submeshes) if (submesh.indexCount > 0) present.add(submesh.geosetId);
  const { choice: geosets, substitutions: geosetSubstitutions } =
    resolveGeosets(options.geosets ?? BODY_ONLY, present);

  const ordered = model.batches
    .map((batch, index) => ({ batch, index }))
    .filter(({ batch }) => {
      const submesh = model.submeshes[batch.submesh];
      return submesh !== undefined && submesh.indexCount > 0 && geosetVisible(submesh.geosetId, geosets);
    })
    .sort(batchOrder);

  const vegetationWind = options.vegetationWind === true
    ? vegetationWindProfile(model.bounds, options.modelPath)
    : undefined;
  // Wind classification depends on the original batch ordinal. Leave such builds untouched.
  const coalesce = options.coalesceAdjacentBatches === true && !vegetationWind;
  const draw = modelDrawBatches(model, coalesce ? gatherEqualBatches(ordered) : ordered, coalesce);
  if (draw.indices !== model.indices) geometry.setIndex(new THREE.BufferAttribute(draw.indices, 1));

  const materials: THREE.Material[] = [];
  const materialSlots: number[] = [];
  const texturePaths: string[] = [];
  const ownedTextures: THREE.Texture[] = [];
  const borrowedTextures = new Set<THREE.Texture>();
  const loadedTextures = options.deduplicateLoadedTextures === true ? new Map<string, THREE.Texture>() : undefined;
  const privateViews = options.privateLoadedTextureViews === true || loadedTextures !== undefined;
  const ownsLoadedTextures = options.borrowLoadedTextures !== true && options.privateLoadedTextureViews !== true;
  const materialOptions = options.borrowLoadedTextures === true || privateViews
    ? {
        ...options,
        privateLoadedTextureViews: privateViews,
        loadTexture: (url: string) => {
          let texture = loadedTextures?.get(url);
          if (!texture) {
            texture = options.loadTexture(url);
            loadedTextures?.set(url, texture);
            // The map only lives during this build. Keep its uncached sources in the existing
            // disposal list, including sources whose maps have a transform or a second UV set.
            if (loadedTextures && ownsLoadedTextures) ownedTextures.push(texture);
          }
          borrowedTextures.add(texture);
          return privateViews ? privateTextureView(texture) : texture;
        },
      }
    : options;
  const animatedBatches: AnimatedBatch[] = [];
  for (const { batch, index: batchIndex, indexStart, indexCount } of draw.batches) {
    geometry.addGroup(indexStart, indexCount, materials.length);

    const slotIndex = batch.textures[0] ?? -1;
    const slot = slotIndex >= 0 ? model.textures[slotIndex] : undefined;
    const supplied = slot ? options.slotTextures?.get(slot.type) : undefined;
    const path = supplied || !slot ? "" : resolveSlot(slot, slots, directory);
    if (path) texturePaths.push(path);
    const material = buildMaterial(model, batch, slot, path, supplied, materialOptions);
    if (vegetationWind && isVegetationWindBatch(model, batchIndex, path, options.modelPath)) {
      // Installed after buildMaterial so its second-layer/fog/world-light chain is preserved.
      // The caller gives this build a wind-specific cache key; no static material is mutated.
      installVegetationWind(material, vegetationWind);
    }
    if (options.groundCoverFade) installGroundCoverFade(material, options.groundCoverFade);
    // Loaded here, so freed here unless the caller explicitly supplies/leases the cached base.
    // A transform/uv1 clone is a different object and remains owned by this build.
    const map = (material as THREE.Material & { map?: THREE.Texture | null }).map;
    if (map && map !== supplied && !borrowedTextures.has(map)) ownedTextures.push(map);
    // The second layer, when there is one, is the material's `alphaMap` slot — see `secondLayer`.
    const layer = (material as THREE.Material & { alphaMap?: THREE.Texture | null }).alphaMap;
    if (layer) ownedTextures.push(layer);

    // What the file says this batch is painted, and where it says the texture sits. Applied below
    // at time zero even when nothing will ever advance the clock — a doodad out of animation range,
    // a model in the character lab — because the still frame the file describes is much closer to
    // right than white at full strength, which is what every batch in this game was drawn as until
    // now.
    const { colour, weight } = batchTracks(model, batch);
    const transform = model.textureTransforms?.[batch.textureTransform];
    const transform2 = layer ? secondUnitTransform(model, batch) : undefined; // 05.10-A7a-F2 (6.16б)
    if (colour || weight || (transform && map) || transform2) {
      const entry: AnimatedBatch = {
        material,
        globalSequences: model.globalSequences,
        // The flat colour is a diagnosis — `character-lab.html` counts the triangles wearing it —
        // so a batch with no texture keeps it rather than having the file's tint multiplied in.
        tinted: Boolean(supplied || path),
        ...(colour ? { colour } : {}),
        ...(weight ? { weight } : {}),
        ...(transform && map ? { transform, map } : {}),
        ...(transform2 && layer ? { transform2, map2: layer } : {}), // 05.10-A7a-F2
      };
      animatedBatches.push(entry);
    }
    materials.push(material);
    materialSlots.push(slot?.type ?? -1);
  }
  // Every batch is painted once, here; only the ones that move are kept for the per-frame pass.
  // Almost every batch in the game carries a texture-weight track and most of those hold the
  // single key 1, so keeping them all would be a frame's work spent writing the number that was
  // already there: over the 465 distinct models the four Orgrimmar tiles name, the filter below
  // takes 724 entries to none at all, and the city's doodads cost the per-frame pass nothing.
  updateBatchAppearance(animatedBatches, 0);

  // Nothing visible: keep the model rather than dropping it, but say so with an empty group list.
  geometry.computeBoundingBox();
  // And its sphere, out of the box that was just walked rather than from three's own lazy pass.
  // Without this the sphere is computed the first time the model is drawn — a second walk over
  // every vertex, on the one frame the doodad appears, which is the worst frame to spend it on.
  // Taken from the box rather than from the file's own radius so that it is certain to enclose:
  // half the diagonal of a box that contains the geometry contains it too.
  if (geometry.boundingBox) {
    const centre = geometry.boundingBox.getCenter(new THREE.Vector3());
    const half = geometry.boundingBox.getSize(new THREE.Vector3()).multiplyScalar(0.5);
    geometry.boundingSphere = new THREE.Sphere(centre, Math.max(0.001, half.length()));
  }
  const height = geometry.boundingBox ? Math.max(0.4, geometry.boundingBox.max.z) : 2;
  return {
    geometry, materials, height, texturePaths: [...new Set(texturePaths)], ownedTextures,
    materialSlots, geosetSubstitutions,
    animatedBatches: animatedBatches.filter(batchMoves),
  };
}

/**
 * Whether any of a batch's tracks has something to say after the first frame.
 *
 * Two keys anywhere, or a binding to a global loop, which runs on the world's clock and so moves
 * even when the model does not. Anything else is a still value, already written.
 */
function batchMoves(entry: AnimatedBatch): boolean {
  return [
    entry.colour?.rgb, entry.colour?.alpha, entry.weight,
    entry.transform?.translation, entry.transform?.rotation, entry.transform?.scaling,
    entry.transform2?.translation, entry.transform2?.rotation, entry.transform2?.scaling, // 05.10-A7a-F2
  ].some((track) =>
    track !== undefined && (track.globalSequence >= 0 || track.tracks.some((sub) => sub.times.length > 1)));
}

/** What `onBeforeCompile` is handed. Taken off the material's own signature so it cannot drift. */
type ShaderSource = Parameters<THREE.Material["onBeforeCompile"]>[0];

/** One link of a material's `onBeforeCompile` chain, with the key that tells its program apart. */
interface ShaderStep {
  key: string;
  apply: (shader: ShaderSource) => void;
}

/**
 * Additive blending ignores the surface it lands on, so a batch using it is never shaded.
 *
 * The `MATERIAL_UNLIT` bit says so for most of them and 153 of the 2,625 additive batches under
 * `spells\` do not set it — measured over the 1,565 readable models there — and those were being
 * built as `MeshStandardMaterial` and multiplied by `N·L`. A glow card is a flat quad: as it turns
 * away from the sun its own light dims and the effect flickers as the caster turns, which is the
 * exact argument `ParticleRender.buildDrawn` already makes for the emitters ("an additive quad
 * shaded as if it were a surface is ruined"). The two additive modes are the file's 3 and 4; 7 is
 * `One/OneMinusSrcAlpha`, which does composite over what is behind it, so it keeps its shading.
 */
function alwaysUnlit(blendMode: number): boolean {
  return blendMode === BLEND_NO_ALPHA_ADD || blendMode === BLEND_ADD;
}

interface SpellFantasyGlowBinding {
  previousCompile: THREE.Material["onBeforeCompile"];
  previousKey: string;
  enabled: boolean;
}

const SPELL_FANTASY_GLOW_BINDINGS = new WeakMap<THREE.Material, SpellFantasyGlowBinding>();

/** Installs one reversible wrapper around an additive spell material's existing shader chain. */
function bindSpellFantasyGlow(material: THREE.Material, blendMode: number, enabled: boolean | undefined): void {
  if (enabled === undefined || !alwaysUnlit(blendMode)) return;
  const existing = SPELL_FANTASY_GLOW_BINDINGS.get(material);
  if (existing) {
    if (existing.enabled !== enabled) {
      existing.enabled = enabled;
      material.needsUpdate = true;
    }
    return;
  }
  const binding: SpellFantasyGlowBinding = {
    previousCompile: material.onBeforeCompile,
    previousKey: material.customProgramCacheKey(),
    enabled,
  };
  SPELL_FANTASY_GLOW_BINDINGS.set(material, binding);
  material.onBeforeCompile = (shader, renderer) => {
    binding.previousCompile.call(material, shader, renderer);
    if (!binding.enabled) return;
    const marker = "#include <color_fragment>";
    if (shader.fragmentShader.split(marker).length - 1 !== 1) {
      throw new Error("Spell fantasy glow expected exactly one MeshBasic color marker");
    }
    shader.fragmentShader = shader.fragmentShader.replace(marker, `${marker}
      /* spell-fantasy-glow-v1: texture/vertex alpha controls a restrained additive energy lift. */
      float spellFantasyEnergy = smoothstep(0.08, 0.92, diffuseColor.a);
      diffuseColor.rgb *= 1.18 + spellFantasyEnergy * 0.22;`);
  };
  material.customProgramCacheKey = () => binding.enabled
    ? `${binding.previousKey}|spell-fantasy-glow-v1`
    : binding.previousKey;
  if (enabled) material.needsUpdate = true;
}

/** Rebinds only already-built spell materials; geometry, textures and animation state stay intact. */
export function setBuiltModelFantasyGlow(built: Pick<BuiltModel, "materials">, enabled: boolean): void {
  for (const material of built.materials) {
    const binding = SPELL_FANTASY_GLOW_BINDINGS.get(material);
    if (!binding || binding.enabled === enabled) continue;
    binding.enabled = enabled;
    material.needsUpdate = true;
  }
}

/**
 * A texture this material may write per-frame state into, without any other material seeing it.
 *
 * A clone rather than a fresh load: three keys its GPU upload on `Texture.source`, which a clone
 * shares, so the pixels are uploaded once and `dispose` only drops a reference
 * (`WebGLTextures.deallocateTexture` counts `usedTimes`). What the clone gets of its own is the
 * matrix, the channel and the sampler settings — the state a texture transform writes every frame.
 *
 * It is needed because the spell texture loader caches by URL (`ModelTextureLoader({cache: true})`,
 * `WorldRenderer3D.ts:1391`), so two batches of one model that name the same file are handed the
 * *same* `THREE.Texture`. Measured over `spells\`: **176 batches in 98 models** share a texture
 * slot with a batch that names a different transform, and without this the last one written would
 * decide where both of their textures sat.
 *
 * A clone copies once, and one thing about a texture is decided long after: whether its fetch
 * failed. `TextureLoad.substituteMissingPixel` turns a 404 into one opaque white pixel by writing
 * `image`, which is an accessor over `source.data` (`three.core.js:7632` in 0.185.1) and so does
 * reach the clone, and six flags, which are per texture and land on the object the *loader* holds.
 * One of the six decides anything: three picks the upload branch on `isDataTexture` alone
 * (`three.module.js:11976`), and a clone without it takes the image branch, hands the bare
 * `{data, width, height}` object to `texSubImage2D`, and leaves the zero-filled 1×1 bound after
 * `WebGLState` swallows the `TypeError` — transparent black, which is the exact thing the white
 * pixel exists to prevent (`TextureLoad.ts:41-59`). So the clone answers that one from its source
 * instead of from a copy taken before the fetch had finished. The other five are `DataTexture`'s
 * own constructor settings and none of them changes what a one-texel image samples as: every
 * filter of a 1×1 returns that texel, its mip chain is one level, and four bytes to a row need no
 * padding at either alignment.
 *
 * Ordinary transformed maps still reach this after their uncached load. Spell maps now reach it
 * earlier, before *any* sampler mutation: corpus audit found four spell URLs authored with flags
 * 0 and 3, fourteen shared by mesh and emitter use, and two in both groups. The cached Texture is
 * therefore only a canonical request/Source handle; each material owns one private view over it.
 */
export function privateTextureView(texture: THREE.Texture): THREE.Texture {
  const owned = texture.clone();
  Object.defineProperty(owned, "isDataTexture", {
    configurable: true,
    get: () => sourceHoldsPixels(owned.source.data),
  });
  // `clone()` marks the view for upload, but a still-pending canonical has no pixels yet: that
  // mark is exactly what three warns about on the first draw. Park it until `#applyCompletion`
  // publishes the shared source (ready image or missing pixel); an already-resolved canonical
  // keeps the clone's own mark and uploads at once.
  registerPendingTextureView(texture, owned);
  return owned;
}

/** Whether a `Source` holds raw pixels rather than an image — three's own distinction. */
function sourceHoldsPixels(data: unknown): boolean {
  return ArrayBuffer.isView((data as { data?: unknown } | null | undefined)?.data);
}

/**
 * Whether the second UV set this batch asks for is one the artist actually filled in.
 *
 * `uvSets[0] === 1` says the batch samples `uv1`, and behind that number the set is often not
 * there: the original client *generates* environment coordinates from the vertex normal and the
 * eye rather than storing them, so a file may point a unit at the second set and leave the
 * vertices' own copy at zero. Measured over the archives — under `item\`, 85 batches in 82 of the
 * 8,205 readable models set it and **43 of those, in 43 models, carry a second set that is zero to
 * the bit on their own vertices**: every `helm_cloth_pvpmage_b_01_*` and
 * `stave_2h_caster_pvp_c_01` among them. `spells\` has none of it in 1,565 models, `character\`
 * none in 38, and `creature\` has 3 batches in 2 of 946 whose second set is genuinely filled in.
 *
 * Taking the number at face value is worse than ignoring it, which is why this is a test and not a
 * comment: every fragment of such a batch samples texel (0, 0) and the layer becomes one flat
 * colour. The PvP mage helm's third batch is the 102-vertex cap over the head, and it would be
 * painted the corner pixel of whatever the browser put in its slot. It is the same argument the
 * second texture unit is already left alone by (`secondLayer`), applied to the first.
 */
function authoredSecondUvSet(model: WvmModel, batch: WvmBatch): boolean {
  const submesh = model.submeshes[batch.submesh];
  if (!submesh) return false;
  // The batch's own vertices are reached through its indices: a `WvmSubmesh` carries the index
  // span and not the vertex one. Walked once per batch that names the second set on either unit,
  // and by no other batch at all.
  for (let at = submesh.indexStart; at < submesh.indexStart + submesh.indexCount; at++) {
    const vertex = (model.indices[at] ?? 0) * 2;
    if (model.uv1[vertex] !== 0 || model.uv1[vertex + 1] !== 0) return true;
  }
  return false;
}

function buildMaterial(
  model: WvmModel,
  batch: WvmBatch,
  slot: { type: number; flags: number; path: string } | undefined,
  path: string,
  supplied: THREE.Texture | undefined,
  options: {
    baseUrl: string;
    loadTexture: (url: string) => THREE.Texture;
    privateLoadedTextureViews?: boolean;
    anisotropy?: number;
    worldLight?: WorldLightUniforms;
    fantasyGlow?: boolean;
  },
): THREE.MeshBasicMaterial | THREE.MeshStandardMaterial {
  const unlit = (batch.materialFlags & MATERIAL_UNLIT) !== 0 || alwaysUnlit(batch.blendMode);
  // An unlit batch must not be shaded by the sun; that is what makes an eye glow a glow rather
  // than a lit surface with a bright texture.
  const material = unlit
    ? new THREE.MeshBasicMaterial()
    : new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0 });

  material.side = (batch.materialFlags & MATERIAL_TWO_SIDED) !== 0 ? THREE.DoubleSide : THREE.FrontSide;
  material.fog = (batch.materialFlags & MATERIAL_UNFOGGED) === 0;
  // The 0x10 bit is not "draw me through the wall". Read as a depth-test switch it did two wrong
  // things at once to every torch in the game: the flame card was drawn over the stone in front of
  // it *and*, because the write was left on, punched its own quad out of the wall behind it. There
  // is no point light in this scene and no shadow, so light through a wall was never light — it
  // was this card. The reference client bans the write for the bit and leaves the test alone.
  material.depthTest = true;
  material.depthWrite = (batch.materialFlags & (MATERIAL_NO_DEPTH_WRITE | MATERIAL_NO_DEPTH_TEST)) === 0;

  applyBlendMode(material, batch.blendMode);

  if (supplied) {
    material.map = supplied;
  } else if (path) {
    const texture = options.loadTexture(textureUrl(options.baseUrl, path));
    // The wrap flags are per texture and mostly clamp: of 244 slots measured across 62 client
    // models only 16 asked to tile. Forcing Repeat on the rest makes a face pull in the opposite
    // edge of its atlas wherever a UV strays outside [0, 1].
    texture.wrapS = slot && (slot.flags & TEXTURE_WRAP_X) ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
    texture.wrapT = slot && (slot.flags & TEXTURE_WRAP_Y) ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
    texture.colorSpace = THREE.SRGBColorSpace;
    // The client's UVs are D3D's: v = 0 is the top row of the image. three uploads with
    // `UNPACK_FLIP_Y_WEBGL` on by default, so every texture in the world was being sampled mirrored
    // top to bottom. Stone and most tiling surfaces hide it — a flipped brick is a brick — but
    // anything with a top and a bottom does not: measured by rasterising STORMWINDPLANTER out of
    // its own artifact both ways, the flipped one is the torn red and green spikes on the screen
    // and the unflipped one is a stone box with tulips in it.
    texture.flipY = false;
    texture.anisotropy = options.anisotropy ?? 1;
    material.map = texture;
  } else {
    // Nothing fills this slot. Flat colour is what the old pipeline did silently for every
    // unresolvable slot; here it is at least confined to the batch that asked.
    material.color = new THREE.Color(FLAT_SLOT_COLOUR);
  }

  // Two things this batch may want are written into the texture object rather than into the
  // material — where the texture sits, and which UV set reads it — so when it wants either, the
  // texture has to be this material's own. See `privateTextureView` for what "own" costs and why sharing
  // is not an option.
  //
  // `matrixAutoUpdate` off because three would otherwise recompute the matrix from
  // `offset`/`repeat`/`rotation` before every draw and undo what `updateBatchAppearance` wrote.
  //
  // `channel` is three's own way of saying "this map reads the second UV set": it puts
  // `#define MAP_UV uv1` in the prefix and, crucially, declares the `uv1` attribute at all
  // (`WebGLPrograms` sets `vertexUv1s` from the channels its maps ask for). What stood here was a
  // string replacement of `vMapUv = ( mapTransform * vec3( MAP_UV, 1 ) ).xy;` in `onBeforeCompile`,
  // and it never did anything: when a handler runs, three has not resolved its `#include`s, so the
  // vertex source is `#include <uv_vertex>` and the literal being searched for is not in it —
  // checked directly, `THREE.ShaderLib.basic.vertexShader.includes("vMapUv")` is `false`. Had it
  // matched, it would not have compiled either, because `uv1` is undeclared unless a map claims it.
  //
  // What guards it is the *file's* second set and not the geometry's: `buildModel` gives every
  // build a `uv1` attribute, so asking the geometry for one was a test that could not fail. See
  // `authoredSecondUvSet` for what the file has to have put in it.
  const transform = model.textureTransforms?.[batch.textureTransform];
  const secondUvSet = batch.uvSets[0] === 1 && authoredSecondUvSet(model, batch);
  if (material.map && (transform || secondUvSet)) {
    // An opt-in private loaded view was already cloned before any sampler mutation above. Supplied
    // maps are not loaded views and still need the historical clone when their UV state moves.
    if (!(options.privateLoadedTextureViews === true && !supplied && path)) {
      material.map = privateTextureView(material.map);
    }
    if (transform) material.map.matrixAutoUpdate = false;
    if (secondUvSet) material.map.channel = 1;
  }

  const steps: ShaderStep[] = [];
  // 05.10-A7a-F2 (6.22, 6.16е, 6.16б): an extended artifact folds its stages by the id the client
  // resolved (`M2Combiners.ts`); an older one, and a 0x8000 special id, keep `secondLayer`.
  const combiner = resolvedCombiner(model, batch, material instanceof THREE.MeshStandardMaterial, {
    ...options, privateView: privateTextureView, authoredSecondUvSet: () => authoredSecondUvSet(model, batch),
  });
  const second = combiner ?? secondLayer(model, batch, options);
  if (second?.texture) material.alphaMap = second.texture; // 05.10-A7a-F2: a one-stage step has none
  if (second?.step) steps.push(second.step);
  const fog = fogStep(batch.blendMode);
  if (fog) steps.push(fog);
  applyShaderSteps(material, steps);
  // Installed last so Э1's second-layer/fog chain runs first. Unlit and additive batches retain
  // their authored flat path and never receive a sun merely because they share the same model.
  if (material instanceof THREE.MeshStandardMaterial && options.worldLight) {
    applyWorldLight(material, options.worldLight, "surface");
  }
  bindSpellFantasyGlow(material, batch.blendMode, options.fantasyGlow);

  return material;
}

/**
 * Hangs a chain of substitutions off one material, and tells three that its program is its own.
 *
 * A chain and not an assignment: two substitutions can land on one batch — the second texture layer
 * and the fog its blend mode wants — and a second `material.onBeforeCompile = …` silently throws
 * the first away, with no error anywhere. Ш1 adds a third link here. `customProgramCacheKey`
 * is the other half — three caches compiled programs across materials, and two materials that
 * differ only in what their handler substitutes would otherwise share whichever program was built
 * first.
 */
function applyShaderSteps(material: THREE.Material, steps: readonly ShaderStep[]): void {
  if (steps.length === 0) return;
  material.onBeforeCompile = (shader) => {
    for (const step of steps) step.apply(shader);
  };
  const key = steps.map((step) => step.key).join("|");
  material.customProgramCacheKey = () => key;
}

/**
 * M2 fog, which is not three's fog for five of the eight blend modes.
 *
 * three's `fog_fragment` chunk is `mix( gl_FragColor.rgb, fogColor, fogFactor )` unconditionally.
 * That is right for an opaque or alpha-blended surface and wrong for everything that composites by
 * something other than source alpha: an additive card mixed towards the fog colour *adds* the fog
 * colour to the scene, so the card's own black corners light up and a glow quad becomes a visible
 * rectangle hanging in the air. The reference client branches on exactly this
 * (`wowee/assets/shaders/m2.frag.glsl:261-269`: `if (blendMode >= 3) result *= fogFactor;` where
 * its `fogFactor` is visibility, i.e. three's `1.0 - fogFactor`).
 *
 * The scale is named honestly rather than talked up. Of the 2,625 additive batches under `spells\`,
 * 1,943 already carry `MATERIAL_UNFOGGED` and are already right. And `fogFactor` at cast range is
 * nothing over most of the world. What a fog range is has to be said for the number to be worth
 * anything, because the same table counts three ways: this one is one range per *map × parameter
 * set × band key*, the keys being the union of the `fogEnd` and `fogScale` band times, which is
 * what the browser samples and interpolates between. `loadLightMetadata` on this dataset yields
 * **1,501** of them, **714** with the fog starting in front of the camera; over those 714,
 * `smoothstep` at 20 yards is **0.000% at the median, 0.000% at p90 and 3.256% at p99** — so where
 * a player walks about, **this is a fix for the far ambient** and not for what is at their feet.
 * (Deduplicating the same reading by parameter set gives 1,240 and 550, and by the (start, end)
 * pair 262 and 121; the percentiles move by less than a point.) The exception is the deliberately
 * thick set: map 595's set 720 fogs from 0 to 25 yards, which is **89.6% at 20 yards**, and that is
 * a whole card's worth of fog colour added to the frame.
 *
 * Modes 5 and 6 multiply what is already in the frame, so distance has to take them towards their
 * own identity instead: white for `DstColor*SrcColor`. Mod2x's identity is strictly 0.5 and it
 * rides the same branch, which is worth exactly what it costs — 1 mod and 11 mod2x batches in the
 * whole of `spells\`, measured.
 */
export function applyFogMode(material: THREE.Material, blendMode: number): void {
  const step = fogStep(blendMode);
  if (step) applyShaderSteps(material, [step]);
}

function fogStep(blendMode: number): ShaderStep | undefined {
  const body = blendMode === BLEND_NO_ALPHA_ADD || blendMode === BLEND_ADD || blendMode === BLEND_BLEND_ADD
    ? "gl_FragColor.rgb *= ( 1.0 - fogFactor );"
    : blendMode === BLEND_MOD || blendMode === BLEND_MOD2X
      ? "gl_FragColor.rgb = mix( gl_FragColor.rgb, vec3( 1.0 ), fogFactor );"
      : undefined;
  if (body === undefined) return undefined;
  // The chunk is rewritten whole rather than patched, because three has not resolved its
  // `#include`s when a handler runs: what arrives is the directive, not the code behind it.
  const replacement = [
    "#ifdef USE_FOG",
    "\t#ifdef FOG_EXP2",
    "\t\tfloat fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );",
    "\t#else",
    "\t\tfloat fogFactor = smoothstep( fogNear, fogFar, vFogDepth );",
    "\t#endif",
    `\t${body}`,
    "#endif",
  ].join("\n");
  return {
    key: `wvm-fog-${blendMode}`,
    apply: (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace("#include <fog_fragment>", replacement);
    },
  };
}

/**
 * The second texture unit, for a batch that names one and gives it coordinates of its own.
 *
 * `buildModel` used to take `batch.textures[0]` and stop, so **528 batches in 207 models** under
 * `spells\` drew one layer of two. The layer travels in the material's `alphaMap` slot: three then
 * binds the sampler, computes the varying and declares the `uv1` attribute for free, and the one
 * thing it does with it on its own — `diffuseColor.a *= texture2D( alphaMap, vAlphaMapUv ).g;` — is
 * the single `#include` this replaces.
 *
 * Only a batch whose second unit names UV set 1 **and has one** is taken, which is 423 of the 528:
 * 95 of the rest put both units on UV set 0, and the last 10 name set 1 over vertices whose copy of
 * it is zero, which `authoredSecondUvSet` turns away for the same reason the first unit does.
 * Outside `spells\` the first of those shapes is the whole story: `item\` has 3,893 two-unit
 * batches in 3,081 models and 3,608 of them are `ARMORREFLECT4.BLP` and its neighbours on UV set 0
 * — a reflection whose coordinates the original client *generates* from the vertex normal and the
 * eye, not coordinates the file stores. Folding a reflection map in at the mesh's own UVs would put
 * a picture of a sky on a sword. Those stay on one layer until something generates the coordinates
 * they want.
 *
 * How the two layers fold is `shaderId`, and this is the part that cannot be settled offline. The
 * client's own two-layer combiner table is not in this tree and the reference client never reads a
 * second unit (`wowee/assets/shaders/m2.frag.glsl` declares one `uTexture`), so the three values —
 * 0, 1 and 2, and no others in the whole of `spells\` — are read as the first three combiners of
 * that table: multiply, add, multiply doubled. What that guess is worth is measurable and small:
 * of the 423 batches taken here, **398 are shaderId 0** and only 19 and 6 are 1 and 2.
 */
function secondLayer(
  model: WvmModel,
  batch: WvmBatch,
  options: {
    baseUrl: string;
    loadTexture: (url: string) => THREE.Texture;
    anisotropy?: number;
    privateLoadedTextureViews?: boolean;
  },
): { texture: THREE.Texture; step: ShaderStep } | undefined {
  const index = batch.textures[1] ?? -1;
  // The set has to be filled in as well as named — `authoredSecondUvSet` for why. It is a much
  // smaller matter on this unit than on the first: of the batches that name set 1 on it, 10 of 433
  // under `spells\`, 1 of 107 under `item\` and 3 of 62 under `creature\` have a second set that is
  // zero, and what they would get is a layer folded in at one flat colour rather than a whole
  // surface flattened.
  if (index < 0 || batch.uvSets[1] !== 1 || !authoredSecondUvSet(model, batch)) return undefined;
  const slot = model.textures[index];
  // Only a self-named slot: a second layer the client would have to fill is a slot this build
  // cannot resolve, and drawing it flat green would be worse than drawing one layer.
  if (!slot || slot.type !== TEXTURE_TYPE_OWN || !slot.path) return undefined;

  const loaded = options.loadTexture(textureUrl(options.baseUrl, slot.path));
  const texture = options.privateLoadedTextureViews === true
    ? loaded
    : privateTextureView(loaded);
  texture.wrapS = (slot.flags & TEXTURE_WRAP_X) ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  texture.wrapT = (slot.flags & TEXTURE_WRAP_Y) ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = false;
  texture.anisotropy = options.anisotropy ?? 1;
  texture.channel = 1;

  const fold = batch.shaderId === 1
    ? "\tdiffuseColor.rgb += wvmLayer.rgb;"
    : batch.shaderId === 2
      ? "\tdiffuseColor.rgb *= wvmLayer.rgb * 2.0;"
      : "\tdiffuseColor.rgb *= wvmLayer.rgb;\n\tdiffuseColor.a *= wvmLayer.a;";
  const replacement = [
    "#ifdef USE_ALPHAMAP",
    "\tvec4 wvmLayer = texture2D( alphaMap, vAlphaMapUv );",
    fold,
    "#endif",
  ].join("\n");
  return {
    texture,
    step: {
      key: `wvm-layer2-${batch.shaderId}`,
      apply: (shader) => {
        shader.fragmentShader = shader.fragmentShader.replace("#include <alphamap_fragment>", replacement);
      },
    },
  };
}

/**
 * M2's blend modes in three.js terms.
 *
 * Measured across the client: of 459 batches in 62 models, 166 are opaque and the other 293 are
 * not — 140 alpha-key, 20 alpha, 58 additive, 12 mod2x. All of them used to render as opaque
 * cut-outs with a fixed alphaTest.
 */
export function applyBlendMode(material: THREE.Material & { alphaTest: number }, blendMode: number): void {
  switch (blendMode) {
    case BLEND_OPAQUE:
      material.transparent = false;
      material.alphaTest = 0;
      break;
    case BLEND_ALPHA_KEY:
      // A hard cut-out, which is what hair cards, foliage and cloth fringes want. The client's
      // threshold is 224/255 for this mode, not the 0.15 that used to be applied to everything.
      material.transparent = false;
      material.alphaTest = 224 / 255;
      break;
    case BLEND_ALPHA:
      material.transparent = true;
      material.alphaTest = 0;
      material.blending = THREE.NormalBlending;
      // 05.10-A7a-F1 (6.16д): the wowee reading, behind a switch until lookdev/14.25 frames decide.
      if (!renderSwitches.m2AlphaDepthWrite) material.depthWrite = false;
      break;
    case BLEND_NO_ALPHA_ADD:
      material.transparent = true;
      material.blending = THREE.CustomBlending;
      material.blendSrc = THREE.OneFactor;
      material.blendDst = THREE.OneFactor;
      material.depthWrite = false;
      break;
    case BLEND_ADD:
      material.transparent = true;
      material.blending = THREE.CustomBlending;
      material.blendSrc = THREE.SrcAlphaFactor;
      material.blendDst = THREE.OneFactor;
      material.depthWrite = false;
      break;
    case BLEND_MOD:
      material.transparent = true;
      material.blending = THREE.CustomBlending;
      material.blendSrc = THREE.DstColorFactor;
      material.blendDst = THREE.ZeroFactor;
      material.depthWrite = false;
      break;
    case BLEND_MOD2X:
      material.transparent = true;
      material.blending = THREE.CustomBlending;
      material.blendSrc = THREE.DstColorFactor;
      material.blendDst = THREE.SrcColorFactor;
      material.depthWrite = false;
      break;
    case BLEND_BLEND_ADD:
      material.transparent = true;
      material.blending = THREE.CustomBlending;
      material.blendSrc = THREE.OneFactor;
      material.blendDst = THREE.OneMinusSrcAlphaFactor;
      material.depthWrite = false;
      break;
    default:
      material.transparent = false;
      material.alphaTest = 0;
      break;
  }
  // Unlit additive contributions commute: both faces can use one unculled draw.
  // Keep ordered alpha blends and separate alpha equations on Three's two-pass path.
  material.forceSinglePass = material instanceof THREE.MeshBasicMaterial && !material.depthWrite
    && material.blendEquation === THREE.AddEquation
    && material.blendSrcAlpha === null && material.blendDstAlpha === null
    && (material.blendEquationAlpha === null || material.blendEquationAlpha === THREE.AddEquation)
    && (blendMode === BLEND_NO_ALPHA_ADD || blendMode === BLEND_ADD);
}

/**
 * A private copy of one built material, faded by `factor`, for a unit the server says is stealthed,
 * invisible or a ghost.
 *
 * A copy and not a mutation, because the materials of a build are *shared*: every human male
 * wearing the same look draws from one array (`#unitKey`), so writing an opacity into it would fade
 * a whole street for one rogue. Restoring is therefore giving the shared array back and disposing
 * these, which is what makes the round trip exact.
 *
 * Three.js resets `onBeforeCompile` and `customProgramCacheKey` on `clone()` (they are not in
 * `Material.copy`'s list), and an M2 material may carry a chain of three: the second texture layer,
 * the blend-mode fog and the world light. Unlike `cloneMaterialForPortrait` — which deliberately
 * unwinds the world-light wrapper because a portrait is lit differently — this copy stays in the
 * world and wants the chain exactly as it stands, so the hook is carried over as-is. The hooks
 * close over the *source* material and only ever write into the shader object handed to them, so
 * sharing them is safe; the cache key is evaluated once here rather than delegated, so the copy
 * cannot ask a disposed source for it.
 */
export function cloneMaterialFaded(material: THREE.Material, factor: number): THREE.Material {
  const clone = material.clone();
  clone.onBeforeCompile = material.onBeforeCompile;
  const key = material.customProgramCacheKey();
  clone.customProgramCacheKey = () => key;
  fadeMaterial(clone, factor);
  return clone;
}

/**
 * The smallest factor a faded cut-out threshold is scaled by.
 *
 * Scaling 224/255 by a factor of exactly zero made the threshold zero, and `alphaTest` crossing
 * zero is a different three.js program (the `ALPHATEST` define): the spawn fade's first frame
 * (factor 0) linked one variant and its second frame another, inside the draw — measured on
 * city-arrival as 105 and 145 ms first draws. With the floor the threshold stays positive for
 * the whole fade. The first frame shows the same colours: its opacity is zero, so every fragment's
 * alpha is zero, and the positive threshold discards the fragments that would have blended to
 * nothing — which also keeps a body nobody can see yet out of the depth buffer.
 */
export const FADE_ALPHA_TEST_FLOOR = 1 / 1024;

/**
 * Fades one material by `factor`, honouring what its blend mode actually does with alpha.
 *
 * The blend state is read back rather than remembered, because `applyBlendMode` above is the only
 * thing that ever wrote it and each of its eight cases leaves a distinguishable signature. Four
 * outcomes, and each is the algebra of that mode's blend equation rather than a preference:
 *
 * * **`blendSrc = One`** — `noAlphaAdd` (One/One) and `blendAdd` (One/OneMinusSrcAlpha). The source
 *   colour is *not* multiplied by alpha, so lowering opacity alone fades nothing at all in the
 *   first and makes the second lighten instead of fade. The colour carries the fade, and the
 *   opacity goes down with it so `blendAdd`'s destination term opens as the source closes.
 * * **`blendSrc = DstColor`** — `mod` and `mod2x` multiply what is already in the frame. There is
 *   no per-material number that fades that towards its identity: the multiplier is the *texture*,
 *   and `material.color` only tints it. Left exactly as authored, and said so rather than faked.
 *   Measured, this is a no-op on the units this exists for: HumanMale carries none, and the whole
 *   of `spells\` carries 1 mod and 11 mod2x batches.
 * * **an alpha test** — the hair, fringe and cloth cut-outs, whose threshold is 224/255. Fading
 *   multiplies the fragment's alpha by `factor`, so a threshold left where it was would discard
 *   *every* fragment at 0.35 and the character would lose its hair rather than fade it. The
 *   threshold is scaled by the same factor, which reproduces the identical cut-out: `a > t` and
 *   `a·f > t·f` are the same test. The factor it is scaled by never goes below
 *   `FADE_ALPHA_TEST_FLOOR`: see there.
 * * **everything else** — opaque, alpha and the ordinary additive (SrcAlpha/One), all of which
 *   scale their contribution by alpha exactly. `transparent` is turned on because an opaque
 *   material ignores the number otherwise; `depthWrite` is left as authored, so a body that wrote
 *   depth still does and its own far side does not blend through it.
 *
 * Nothing program-relevant moves after the first call: `transparent` is the same at every factor
 * below one, and a threshold that is above zero stays above zero, so a fade draws one shader
 * variant from its first frame to its last.
 */
export function fadeMaterial(material: THREE.Material, factor: number, source = material): void {
  const clamped = Math.max(0, Math.min(1, factor));
  const tinted = material as THREE.Material & { color?: THREE.Color };
  const original = source as THREE.Material & { color?: THREE.Color };
  // A retained private copy is always scaled from its shared source, including after factor=0.
  // Multiplying its previous faded values would compound opacity and permanently blacken additive
  // batches. Only the final alphaTest is assigned: crossing zero changes a Three shader variant.
  const custom = source.blending === THREE.CustomBlending;
  const modulated = custom && source.blendSrc === THREE.DstColorFactor;
  const colourFade = custom && source.blendSrc === THREE.OneFactor;
  if (original.color && tinted.color) tinted.color.copy(original.color);
  tinted.opacity = original.opacity * (modulated ? 1 : clamped);
  tinted.alphaTest = original.alphaTest
    * (modulated || colourFade ? 1 : Math.max(clamped, FADE_ALPHA_TEST_FLOOR));
  if (colourFade) tinted.color?.multiplyScalar(clamped);
  material.transparent = modulated || colourFade ? source.transparent : true;
}
