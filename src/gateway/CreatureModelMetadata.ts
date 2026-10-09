import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { openDbc } from "./Dbc.js";
import { validAssetPath } from "./AssetPath.js";
import { CharacterAppearanceIndex, type CharacterAppearance } from "./CharacterAppearance.js";
import type { CharacterTextureIndex } from "./CharacterTextures.js";
import { attachParticleColors, parseParticleColors } from "./ParticleColors.js"; // 05.10-A7a-H 6.11а

export interface CreatureModelMetadata {
  /** CreatureDisplayInfo id, which is what UNIT_FIELD_DISPLAYID carries. */
  id: number;
  /** Full MPQ path of the M2, ready for the visual model endpoint. */
  model: string;
  scale: number;
  /**
   * How tall the model counts as for anything that asks whether it is under water or under a
   * ceiling. `Unit::GetCollisionHeight` builds it exactly this way — the model's own
   * `CollisionHeight` times its scale times the display's — so the client reaches the same number
   * the server does about the same character.
   */
  collisionHeight: number;
  /**
   * How high above its own feet this model seats a rider, in model space and before any scale.
   *
   * `Unit::Mount` (`Unit.cpp:8668-8673`) publishes a display id and nothing else, so where the
   * saddle sits has to come from the client's own tables — and this column is that place. Measured
   * over the whole table on this dataset: 414 of the 1,331 rows carry `MountHeight > 0`, 405 of
   * those 414 also carry attachment 0 ("MountMain") in their M2, and 403 of the 405 agree with it
   * to within 0.0001 — the one real disagreement is 0.436 on `NorthrendSkeletonMale`. All 405 have
   * the seat bone's own pivot at exactly the attachment's z, which is what makes "hang the rider
   * off that bone and offset it by the attachment" arithmetic rather than a guess.
   *
   * So this is the answer for the nine models that name no point, not a second opinion about the
   * 405 that do. Unmultiplied, unlike `collisionHeight` beside it: the renderer scales the mount's
   * whole node, and a pre-multiplied seat would apply the display scale a second time.
   */
  mountHeight: number;
  /**
   * The texture slots this display fills by itself, as the `slotType:value` list the model
   * endpoint takes. For a creature that is its skin variations; a character model fills none this
   * way and is described by `appearance` instead.
   */
  textures: string;
  /**
   * How a creature that wears a character model looks: which files paint its body, its hair and
   * cloak textures, and which geosets to draw. 15,451 of the client's displays have a body texture
   * baked ahead of time, and the rest are assembled the same way a player is.
   */
  appearance?: CharacterAppearance;
  /**
   * 05.10-A7a-A 6.11а: `CreatureModelAlpha / 255`, only where the column is not 255 (1,264 of the
   * dataset's displays; 128 on 440 of them, 0 on seven). Absent means opaque.
   */
  alpha?: number;
  /**
   * 05.10-A7a-A 6.11а: `CreatureGeosetData` as stored, only where non-zero — one nibble per geoset
   * group, decoded by `browser/CreatureGeosetData.ts`.
   */
  geosetData?: number;
  /** 05.10-A7a-A 6.11а: `ParticleColorID` (a `ParticleColor.dbc` row), only where positive. */
  particleColor?: number;
  /**
   * 05.10-A7a-H 6.11а: that `ParticleColor.dbc` row's nine `0xAARRGGBB` words (Start[3], MID[3],
   * End[3]), where the row exists — `gateway/ParticleColors.ts`, applied by `browser/CreatureDisplayLook.ts`.
   */
  particleColors?: number[];
  /**
   * 05.10-A7a-G 6.20: the model's `CreatureModelData.Flags` bit 0x400, only where set — Wow.exe
   * 0x0072eb80 jumps rather than playing the mount trick for such a mount (one model on this dataset
   * and on the visual overlay: `Creature\MotorcycleVehicle`).
   */
  noMountSpecial?: true;
}

/** 05.10-A7a-G 6.20: `CreatureModelData.Flags` bit read by Wow.exe 0x0072eb80. */
const MODEL_FLAG_NO_MOUNT_SPECIAL = 0x400;

/**
 * 05.10-A7a-A 6.11а: the three display columns a creature's look takes beside its model, each only
 * where it says something (absent fields keep the payload of the 22,000 ordinary displays as it was).
 */
export function creatureDisplayFields(alphaByte: number, geosetData: number, particleColor: number):
  Pick<CreatureModelMetadata, "alpha" | "geosetData" | "particleColor"> {
  const fields: Pick<CreatureModelMetadata, "alpha" | "geosetData" | "particleColor"> = {};
  if (Number.isInteger(alphaByte) && alphaByte >= 0 && alphaByte < 255) fields.alpha = alphaByte / 255;
  // The word is read signed; the nibbles are what count, so it goes out unsigned.
  if (Number.isInteger(geosetData) && geosetData !== 0) fields.geosetData = geosetData >>> 0;
  if (Number.isInteger(particleColor) && particleColor > 0) fields.particleColor = particleColor;
  return fields;
}

/** Three skin variations per display, held as one array field. */
const SKIN_VARIATIONS = 3;

function buffer(payload: Uint8Array): Buffer {
  return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
}

/**
 * Formats a creature's skin variations as the `slotType:value` list the model endpoint takes.
 * Slots 11 to 13 take a bare name resolved beside the model itself.
 */
export function textureSlots(skins: readonly string[]): string {
  const slots: string[] = [];
  for (let index = 0; index < Math.min(SKIN_VARIATIONS, skins.length); index++) {
    if (skins[index]) slots.push(`${11 + index}:${skins[index]}`);
  }
  return slots.join(",");
}

export function parseCreatureModelMetadata(displayInfo: Uint8Array, modelData: Uint8Array,
  characters?: CharacterAppearanceIndex): Map<number, CreatureModelMetadata> {
  const displays = openDbc(buffer(displayInfo), "CreatureDisplayInfo");
  const models = openDbc(buffer(modelData), "CreatureModelData");

  const paths = new Map<number, {
    path: string; scale: number; collisionHeight: number; mountHeight: number; noMountSpecial: boolean; // 05.10-A7a-G 6.20
  }>();
  for (const row of models.rows()) {
    const id = models.id(row);
    // MDX and MDL are the authoring extensions; the shipped asset is always the M2.
    const path = models.string(row, "ModelName")
      .replaceAll("/", "\\")
      .replace(/\.(mdx|mdl|m2)$/i, ".m2");
    const scale = models.float(row, "ModelScale");
    const collisionHeight = models.float(row, "CollisionHeight");
    const mountHeight = models.float(row, "MountHeight");
    if (id <= 0 || !validAssetPath(path, { extensions: ["m2"] })) continue;
    paths.set(id, {
      path,
      scale: Number.isFinite(scale) && scale > 0 ? scale : 1,
      collisionHeight: Number.isFinite(collisionHeight) && collisionHeight > 0 ? collisionHeight : 0,
      mountHeight: Number.isFinite(mountHeight) && mountHeight > 0 ? mountHeight : 0,
      noMountSpecial: (models.int(row, "Flags") & MODEL_FLAG_NO_MOUNT_SPECIAL) !== 0, // 05.10-A7a-G 6.20
    });
  }

  const result = new Map<number, CreatureModelMetadata>();
  for (const row of displays.rows()) {
    const id = displays.id(row);
    const model = paths.get(displays.int(row, "ModelID"));
    if (id <= 0 || !model) continue;
    const displayScale = displays.float(row, "CreatureModelScale");
    const scale = model.scale * (Number.isFinite(displayScale) && displayScale > 0 ? displayScale : 1);
    // The ninth path class, and the one the slice that merged the other eight walked past: it was
    // written `[A-Za-z0-9_ .-]{1,120}` here, ASCII and with no apostrophe, and it emptied slot 11
    // on the three displays that wear `Kel'Thuzad` — 15945, 23214 and 24787 — although
    // `Creature\KelThuzad\Kel'Thuzad.blp` is 350,724 bytes in `common.MPQ` and there is no
    // apostrophe-less copy anywhere in the chain. Measured over the whole table: 11,685 non-empty
    // values, 3 refused here and 0 refused by the merged validator.
    const skins = Array.from({ length: SKIN_VARIATIONS }, (_, variation) => displays.string(row, "TextureVariation", variation))
      .map((name) => validAssetPath(name, { maxLength: 120, bareName: true }) ? name : "");
    // A creature wearing a character model is described the same way a player is, so it gets a
    // face, hair and ears rather than a bald untextured body.
    //
    // Failing that, the plain look of the race the model itself belongs to. Measured on this
    // dataset: 15,518 of the 24,262 displays wear a `Character\` model and 74 of those have no
    // `ExtendedDisplayInfoID` that resolves — among them every one of the twenty playable base
    // displays, 49 HumanMale through 60 TaurenFemale plus 1563/1564 gnome, 1478/1479 troll,
    // 15476/15475 blood elf and 16125/16126 draenei, which are the most reused humanoid displays
    // in `creature_template`. All 74 also carry an empty texture list, so the type 1 body slot
    // resolved to nothing and the whole torso was painted flat green; and with no appearance the
    // browser previously fell back to geoset 0 alone, which is a character with no shins, thighs,
    // hands or ears. `forModel` reads the race and sex off the path and gives it skin 0, face 0,
    // hair 0.
    const extended = displays.int(row, "ExtendedDisplayInfoID");
    const appearance = (extended > 0 ? characters?.forNpc(extended) : undefined)
      ?? characters?.forModel(model.path);
    const metadata: CreatureModelMetadata = {
      id,
      model: model.path,
      scale: Math.max(0.01, Math.min(50, scale)),
      // Zero where the model declares none, so the reader can fall back to the core's own default
      // rather than deciding a character is a millimetre tall and permanently under water.
      collisionHeight: model.collisionHeight > 0 ? Math.min(50, model.collisionHeight * scale) : 0,
      // Model space, deliberately: the reader multiplies by the scale it draws the mount at, and
      // the tallest seat in the table is 17.145, so a `* scale` here would put a rider in orbit.
      mountHeight: model.mountHeight,
      textures: textureSlots(skins),
      // 05.10-A7a-A 6.11а
      ...creatureDisplayFields(displays.int(row, "CreatureModelAlpha"),
        displays.int(row, "CreatureGeosetData"), displays.int(row, "ParticleColorID")),
    };
    if (appearance) metadata.appearance = appearance;
    if (model.noMountSpecial) metadata.noMountSpecial = true; // 05.10-A7a-G 6.20
    result.set(id, metadata);
  }
  return result;
}

export async function loadCreatureModelMetadata(dbcDirectory: string,
  textures?: Promise<CharacterTextureIndex | undefined>,
  visualDbcDirectory = dbcDirectory,
  coordinatedVisuals = false): Promise<Map<number, CreatureModelMetadata>> {
  const [displayInfo, modelData, characters] = await Promise.all([
    // Display ids stay on the wire, while an HD patch deliberately redirects them to replacement
    // models and skins. Mixing dataset rows with patched M2s produces stretched or flat textures.
    readFile(join(visualDbcDirectory, "CreatureDisplayInfo.dbc")),
    readFile(join(visualDbcDirectory, "CreatureModelData.dbc")),
    // Its own index rather than the route's, because this map is built once and held: the appearance
    // of every display is baked into it. The archives' listing is the shared half — Т7 puts the
    // spelling that exists first, and the eight displays whose bake is not in the client get the
    // body `forPlayer` assembled instead of an empty one.
    CharacterAppearanceIndex.load(
      dbcDirectory, textures, visualDbcDirectory, coordinatedVisuals).catch(() => undefined),
  ]);
  const metadata = parseCreatureModelMetadata(displayInfo, modelData, characters);
  // 05.10-A7a-H 6.11а: the colour rows, from the overlay when it has the file, else the dataset; none
  // readable leaves the displays as they were.
  const colors = await readFile(join(visualDbcDirectory, "ParticleColor.dbc"))
    .catch(() => readFile(join(dbcDirectory, "ParticleColor.dbc"))).catch(() => undefined);
  if (colors) attachParticleColors(metadata, parseParticleColors(colors));
  return metadata;
}
