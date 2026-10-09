// What the lab prints beside the model: which geoset, which texture slot, which triangles.
//
// Every number here comes out of the *real* build. `buildModel` is called once, the picture on the
// screen is made of what it returned, and the panel is a walk over the same object — so the panel
// cannot say one thing while the renderer draws another, which is the only way a diagnostic is
// worth reading. Nothing in this file touches the DOM, so a test can drive it against a model
// artifact without a browser.

import * as THREE from "three";
import type { AttachedModel } from "../../gateway/CharacterAppearance.js";
import { attachmentRefusal } from "../Attachment.js";
import { worldAttachmentPoint } from "../SheathPoints.js"; // 05.10-A7a-G2 6.08: the world's walk
import {
  FLAT_SLOT_COLOUR, buildModel, geosetVisible,
  type BuiltModel, type GeosetChoice, type TextureSlots,
} from "../ModelBuild.js";
import {
  TEXTURE_TYPE_BODY, TEXTURE_TYPE_HAIR, TEXTURE_TYPE_OBJECT_SKIN, TEXTURE_TYPE_OWN,
  TEXTURE_TYPE_SKIN_EXTRA, type WvmModel,
} from "../Wvm.js";

/**
 * `M2Texture.type` by name. The client reads five of them — 0, 1, 2, 6 and 8 — and the rest are
 * here so a slot the renderer ignores is named rather than printed as a number.
 */
export const TEXTURE_TYPE_LABELS: Readonly<Record<number, string>> = {
  [TEXTURE_TYPE_OWN]: "own",
  [TEXTURE_TYPE_BODY]: "body",
  [TEXTURE_TYPE_OBJECT_SKIN]: "object skin",
  3: "weapon blade",
  4: "weapon handle",
  5: "environment",
  [TEXTURE_TYPE_HAIR]: "hair",
  7: "facial hair",
  [TEXTURE_TYPE_SKIN_EXTRA]: "skin extra",
  9: "ui skin",
  10: "tauren mane",
  11: "monster 1",
  12: "monster 2",
  13: "monster 3",
  14: "item icon",
};

export interface LabGeosetLine {
  id: number;
  /** The gateway asked for this id. */
  emitted: boolean;
  /** The model file carries a submesh numbered this. */
  inModel: boolean;
  /** Triangles the model holds under this id, whether or not any of them are drawn. */
  triangles: number;
  /** Triangles this build actually drew for it. */
  drawn: number;
  /**
   * The id drawn in this one's place, when the model does not carry the one that was asked for.
   *
   * The distinction the panel could not make before Т5: an emitted line that is absent from the
   * model and drawn nowhere is a boot that simply does not exist here, while one that names a
   * substitute is the same boot drawn as the nearest member of its family — on a tauren, 502, 503
   * or 504 becoming 505, which is what 934 of the 1,327 boot displays ask for.
   */
  drawnAs?: number;
}

export interface LabSlotLine {
  type: number;
  label: string;
  /** What the model named for itself. Only type 0 names anything. */
  declared: string;
  /** The MPQ path the build resolved, "" when nothing filled the slot. */
  filledWith: string;
  kind: "own" | "composed" | "path" | "empty";
  /**
   * Whether anything this build draws actually samples the slot.
   *
   * A model declares slots for looks it is not wearing — the type 2 cloak slot is declared by every
   * character model and sampled only by the cloak batches, which are not drawn on somebody with no
   * cloak. An empty slot nobody samples is not a defect and must not be counted as one; an empty
   * slot something draws is the tauren's horns.
   */
  sampled: boolean;
}

export interface LabMaterialLine {
  index: number;
  /** The geoset the group came from, or undefined if the ranges could not be matched. */
  geoset: number | undefined;
  triangles: number;
  /** MPQ path, «атлас» for a supplied texture, "" for a slot nothing filled. */
  texture: string;
  /** Painted flat `0x71845e` because nothing filled its slot. */
  flat: boolean;
  /**
   * The file switched this batch off where it is being drawn, so nothing of it reaches the screen.
   *
   * Counted apart from `triangles` rather than folded into it: the panel exists to tell "the model
   * has no such geoset" from "the texture never arrived", and "the artist hid it" is a third
   * answer that used to be invisible because the batch was drawn anyway.
   */
  hidden: boolean;
  /** The `M2Texture.type` this batch samples, -1 when the batch names no texture. */
  slot: number;
  /** That type by name, so a flat row says *which* slot came up empty. */
  slotLabel: string;
}

export interface LabPanel {
  geosets: LabGeosetLine[];
  slots: LabSlotLine[];
  materials: LabMaterialLine[];
  /** Triangles this build draws. */
  triangles: number;
  /** Of those, the ones drawn flat because their slot was empty. */
  flatTriangles: number;
  flatMaterials: number;
  /** Triangles the file holds in total, drawn or not. */
  modelTriangles: number;
  /** Distinct MPQ paths the build asked for, in the order it asked. */
  texturePaths: string[];
}

export interface LabBuildOptions {
  modelPath: string;
  slots: TextureSlots;
  geosets: GeosetChoice;
  baseUrl: string;
  loadTexture: (url: string) => THREE.Texture;
  slotTextures?: ReadonlyMap<number, THREE.Texture>;
  skinned?: boolean;
  /** The ids the gateway emitted, so the panel can show one it asked for that is not in the file. */
  emitted?: readonly number[];
}

/**
 * Builds a model the way the renderer builds it, and describes what came out.
 *
 * The `loadTexture` the caller hands in is wrapped rather than replaced: the page passes the
 * client's own loader, so the textures on the screen are loaded by the shipping path, and the
 * wrapper only remembers which URL produced which texture so the panel can name it.
 */
export function buildForLab(model: WvmModel, options: LabBuildOptions): { built: BuiltModel; panel: LabPanel } {
  const urls = new Map<THREE.Texture, string>();
  const built = buildModel(model, {
    modelPath: options.modelPath,
    slots: options.slots,
    geosets: options.geosets,
    baseUrl: options.baseUrl,
    loadTexture: (url) => {
      const texture = options.loadTexture(url);
      urls.set(texture, url);
      return texture;
    },
    ...(options.slotTextures ? { slotTextures: options.slotTextures } : {}),
    ...(options.skinned === undefined ? {} : { skinned: options.skinned }),
  });

  // Groups are matched back to submeshes by their index range rather than by redoing the filter
  // and the sort `buildModel` did. Repeating that arithmetic here is exactly the drift this panel
  // exists to catch: the ranges come from the object that was built, so they cannot disagree.
  const geosetOfRange = new Map<string, number>();
  const trianglesOfGeoset = new Map<number, number>();
  for (const submesh of model.submeshes) {
    const key = `${submesh.indexStart}/${submesh.indexCount}`;
    if (!geosetOfRange.has(key)) geosetOfRange.set(key, submesh.geosetId);
    trianglesOfGeoset.set(submesh.geosetId, (trianglesOfGeoset.get(submesh.geosetId) ?? 0) + submesh.indexCount / 3);
  }

  const materials: LabMaterialLine[] = [];
  const drawnOfGeoset = new Map<number, number>();
  const sampledSlots = new Set<number>();
  let triangles = 0;
  let flatTriangles = 0;
  let flatMaterials = 0;
  for (const group of built.geometry.groups) {
    const index = group.materialIndex ?? 0;
    const material = built.materials[index];
    const map = (material as (THREE.Material & { map?: THREE.Texture | null }) | undefined)?.map ?? undefined;
    const url = map ? urls.get(map) : undefined;
    // No map at all is the flat case: `buildMaterial` reaches for the colour only when neither a
    // supplied texture nor a resolved path filled the slot.
    const flat = !map;
    const count = group.count / 3;
    // What the screen shows, not what the file holds: a batch the file switched off under the
    // sequence being drawn has a material three will skip, and counting it as drawn would put the
    // panel and the picture beside it out of step.
    const hidden = material?.visible === false;
    const geoset = geosetOfRange.get(`${group.start}/${group.count}`);
    if (geoset !== undefined && !hidden) drawnOfGeoset.set(geoset, (drawnOfGeoset.get(geoset) ?? 0) + count);
    // Which slot the batch reached for comes out of the build itself rather than being worked out
    // again here — the build is the only place that knows, and two answers that can disagree are
    // worse than none.
    const slot = built.materialSlots[index] ?? -1;
    if (slot >= 0 && !hidden) sampledSlots.add(slot);
    if (!hidden) triangles += count;
    if (flat && !hidden) {
      flatTriangles += count;
      flatMaterials++;
    }
    materials.push({
      index: materials.length,
      geoset,
      triangles: count,
      texture: url ? texturePathOf(url) : map ? "атлас" : "",
      flat,
      hidden,
      slot,
      slotLabel: slot < 0 ? "нет" : labelOf(slot),
    });
  }

  const ids = new Set<number>([...trianglesOfGeoset.keys(), ...(options.emitted ?? [])]);
  const geosets: LabGeosetLine[] = [...ids].sort((left, right) => left - right).map((id) => ({
    id,
    emitted: options.emitted ? options.emitted.includes(id) : geosetVisible(id, options.geosets),
    inModel: trianglesOfGeoset.has(id),
    triangles: trianglesOfGeoset.get(id) ?? 0,
    drawn: drawnOfGeoset.get(id) ?? 0,
    // From the build rather than worked out again here, for the same reason as `materialSlots`:
    // the substitution is decided inside `buildModel` and a second implementation of the rule in
    // the panel could disagree with the picture beside it.
    ...(built.geosetSubstitutions.has(id) ? { drawnAs: built.geosetSubstitutions.get(id)! } : {}),
  }));

  const slots: LabSlotLine[] = model.textures.map((slot) => {
    const sampled = sampledSlots.has(slot.type);
    if (slot.type === TEXTURE_TYPE_OWN) {
      return {
        type: slot.type, label: labelOf(slot.type), declared: slot.path, filledWith: slot.path,
        kind: "own" as const, sampled,
      };
    }
    if (options.slotTextures?.has(slot.type)) {
      return {
        type: slot.type, label: labelOf(slot.type), declared: "", filledWith: "атлас",
        kind: "composed" as const, sampled,
      };
    }
    const supplied = options.slots.get(slot.type) ?? "";
    return {
      type: slot.type,
      label: labelOf(slot.type),
      declared: "",
      filledWith: supplied,
      kind: supplied ? ("path" as const) : ("empty" as const),
      sampled,
    };
  });

  let modelTriangles = 0;
  for (const count of trianglesOfGeoset.values()) modelTriangles += count;

  return {
    built,
    panel: {
      geosets, slots, materials,
      triangles, flatTriangles, flatMaterials, modelTriangles,
      texturePaths: built.texturePaths,
    },
  };
}

function labelOf(type: number): string {
  return TEXTURE_TYPE_LABELS[type] ?? `тип ${type}`;
}

/** The MPQ path back out of the `/texture?path=…` URL the build asked for. */
export function texturePathOf(url: string): string {
  const query = url.indexOf("?");
  if (query < 0) return url;
  return new URLSearchParams(url.slice(query + 1)).get("path") ?? url;
}

/** The one line at the top of the panel: how much of this character is a missing texture. */
export function labSummary(panel: LabPanel): string {
  const share = panel.triangles === 0 ? 0 : (panel.flatTriangles / panel.triangles) * 100;
  // An id the model does not carry but that was drawn as another member of its family is not
  // missing — that is the tauren's boot, and counting it as a fault would report every dressed
  // tauren as broken.
  const missing = panel.geosets.filter((line) => line.emitted && !line.inModel && line.drawnAs === undefined).length;
  const substituted = panel.geosets.filter((line) => line.drawnAs !== undefined).length;
  // Only the empty slots something drawn actually samples. Counting every declared-and-unfilled
  // slot made a flawless character report a defect: the plain human male the plan uses as its
  // example declares a cloak slot, wears no cloak, draws no cloak batch, and used to print
  // «пустых слотов: 2» with not one flat triangle on him.
  const empty = new Set(panel.materials.filter((line) => line.flat && line.slot >= 0).map((line) => line.slot));
  return `${panel.triangles} тр. из ${panel.modelTriangles} · плоских ${panel.flatTriangles}`
    + ` (${share.toFixed(1)}%, ${panel.flatMaterials} мат.) · геосетов нет в модели: ${missing}`
    + (substituted > 0 ? ` · заменено: ${substituted}` : "")
    + ` · пустых слотов на видимых батчах: ${empty.size}`;
}

/** The colour the panel paints a flat triangle's swatch, so the two agree by construction. */
export const LAB_FLAT_COLOUR = `#${FLAT_SLOT_COLOUR.toString(16).padStart(6, "0")}`;

/**
 * One piece the character hangs off itself: a helmet, a pauldron, whatever is in its hands.
 *
 * These are not geosets and not texture slots — they are separate models on separate bones — and
 * the lab used to drop the gateway's whole `attached` list on the floor, so a helmed character was
 * drawn bare-headed *and* earless (the helmet hides the ear and face geosets) with a panel that
 * called the build clean. Every piece the gateway names gets a line now, drawn or not, and the ones
 * that are not drawn say why.
 */
export interface LabAttachmentLine {
  slot: number;
  side: "left" | "right";
  inventoryType: number;
  model: string;
  texture: string;
  /** The attachment point the client hangs it from; undefined when the client hangs nothing. */
  point: number | undefined;
  /** Why nothing is hung, when nothing is. */
  refusal: string | undefined;
  /** Triangles this piece draws, once its own artifact has been fetched and built. */
  triangles: number;
  /** Of those, the ones painted flat because nothing filled the piece's texture slot. */
  flatTriangles: number;
  /** What happened when the page asked for the piece: "…" until it has an answer. */
  status: string;
}

/** The pieces the gateway named, and for each the point it goes on — or why it does not. */
export function labAttachmentLines(
  attached: readonly AttachedModel[],
  sheath: number,
): LabAttachmentLine[] {
  return attached.map((item) => ({
    slot: item.slot,
    side: item.side,
    inventoryType: item.inventoryType,
    model: item.model,
    texture: item.texture,
    point: worldAttachmentPoint(item, sheath, item.sheathe), // 05.10-A7a-G2 6.08
    refusal: attachmentRefusal(item, sheath),
    triangles: 0,
    flatTriangles: 0,
    status: "…",
  }));
}
