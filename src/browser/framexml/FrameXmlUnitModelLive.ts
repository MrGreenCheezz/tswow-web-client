/**
 * 6.18 / 3.21 (11.11): the live world's answers for a PlayerModel showing a unit
 * (FrameXmlUnitModel.ts FrameXmlUnitModelHost).
 *
 * Wow.exe duplicates the unit's own model (0x005975e0), so the window shows what the world draws for
 * that unit at that moment — a cat for a druid in cat form, a creature's own display, a player's
 * look with the helm and cloak the player chose to show. That is what ui/UnitModels.ts unitModelFor
 * answers for the world renderer, so the copy is a frozen copy of the object's update fields handed
 * to it: the fields stay as they were at SetUnit/RefreshUnit/show, while the item rows and the
 * composed look it asks for may still arrive afterwards.
 */
import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import type { WorldObjectState } from "../../world/WorldState.js";
import type { GlueModelSource } from "../glue/GlueModelStage.js";
import type { GlueWornPiece } from "../glue/GlueWornPieces.js"; // 15.11 6.18
import type { CreatureModelClient, UnitModel } from "../CreatureModelClient.js";
import type { ItemMetadataClient } from "../ItemMetadata.js";
import {
  attachedGlow, enchantGlowSource, enchantGlowTables, itemEnchantments, type GlowSource, type ItemEnchantmentClient,
} from "../ItemEnchantments.js"; // 15.11 6.14
import { attachedOf } from "../NpcWeapons.js"; // 15.11 6.18
import { sheatheOf, worldAttachmentPoint } from "../SheathPoints.js"; // 15.11 6.18
import { glowSlotsKey } from "../WeaponGlow.js"; // 15.11 6.14
import { game } from "../game/Context.js";
import { unitModelFor, type MirrorImageSource } from "../ui/UnitModels.js";
import type { FrameXmlUnitModelHost } from "./FrameXmlUnitModel.js";

const TYPEID_UNIT = 3;
const TYPEID_PLAYER = 4;

/** `frameXmlGuid`'s `0x%016x` text back to the wire value. */
function parseGuid(text: string): bigint | undefined {
  return /^0x[0-9a-f]{1,16}$/i.test(text) ? BigInt(text) : undefined;
}

/** The unit as it is now: its object with a private copy of the fields map. */
export function frameXmlUnitSnapshot(
  objects: ReadonlyMap<bigint, WorldObjectState> | undefined,
  guidText: string,
): WorldObjectState | undefined {
  const guid = parseGuid(guidText);
  const object = guid === undefined ? undefined : objects?.get(guid);
  // 0x005977e0 asks the object manager for TYPEMASK_UNIT (8): a creature or a player.
  if (!object || (object.typeId !== TYPEID_UNIT && object.typeId !== TYPEID_PLAYER)) return undefined;
  return { ...object, fields: new Map(object.fields) };
}

/** Identities for the appearance objects CreatureModelClient caches, so a source key is stable. */
const appearanceIds = new WeakMap<object, number>();
let nextAppearanceId = 1;

/** A unit model as the stage takes it; the key changes only when the picture does. */
export function frameXmlUnitModelSource(model: UnitModel | undefined, pieces?: readonly GlueWornPiece[]): GlueModelSource | undefined {
  if (!model) return undefined;
  let look = "-";
  if (model.appearance) {
    let id = appearanceIds.get(model.appearance);
    if (id === undefined) { id = nextAppearanceId++; appearanceIds.set(model.appearance, id); }
    look = String(id);
  }
  const worn = pieces && pieces.length > 0 ? `:${frameXmlPiecesKey(pieces)}` : ""; // 15.11 6.18
  return {
    key: `unit:${model.model}:${model.textures ?? ""}:${look}${worn}`,
    file: model.model,
    ...(model.textures === undefined ? {} : { textures: model.textures }),
    appearance: model.appearance,
    displayScale: model.scale,
    fitBody: true,
    ...(pieces && pieces.length > 0 ? { pieces } : {}), // 15.11 6.18
  };
}

/** 15.11 6.18: the worn pieces' identity — model, skin, point and glow — for the source key. */
export function frameXmlPiecesKey(pieces: readonly GlueWornPiece[]): string {
  return pieces.map((piece) => `${piece.item.slot}/${piece.item.side}@${piece.point}#${piece.item.model}#${piece.item.texture}`
    + glowSlotsKey(piece.glow)).join(",");
}

/**
 * 15.11 6.18: the worn models of the copy. Wow.exe duplicates the unit's model with what hangs on it
 * (0x005975e0: the copy's attachment list is walked for points 1 and 2 to close the hands) and takes off
 * only the spell effects (0x004eaf70 detaches points 12, 15–25, 29, 34, 35, 38): so the window shows each
 * piece where the world shows it at that moment — a weapon in the hand when drawn, on the back or hip when
 * stowed (UNIT_FIELD_BYTES_2 byte 0, `worldAttachmentPoint`), the helm and cloak as the player shows them
 * (unitModelFor) — and the enchant glows the world hangs on the blade (`attachedGlow`).
 */
export function frameXmlUnitPieces(
  snapshot: WorldObjectState,
  model: UnitModel | undefined,
  glow: GlowSource | undefined,
): GlueWornPiece[] {
  const pieces: GlueWornPiece[] = [];
  const attached = attachedOf(model);
  if (!attached) return pieces;
  const sheath = (snapshot.fields.get(UPDATE_FIELDS.UNIT_FIELD_BYTES_2.offset) ?? 0) & 0xff;
  for (const item of attached) {
    const point = worldAttachmentPoint(item, sheath, sheatheOf(item, model));
    if (point === undefined) continue;
    const slots = glow ? attachedGlow(snapshot, item.slot, glow, item.displayId)?.slots : undefined;
    pieces.push(slots ? { item, point, glow: slots } : { item, point });
  }
  return pieces;
}

export function createLiveFrameXmlUnitModelHost(clients?: {
  readonly objects: () => ReadonlyMap<bigint, WorldObjectState> | undefined;
  readonly creatureModels: () => CreatureModelClient | undefined;
  readonly itemMetadata: () => ItemMetadataClient | undefined;
  readonly mirrorImages: () => MirrorImageSource | undefined;
  /** 15.11 6.14: the enchant tables the world's glows read; absent, nothing glows in the window. */
  readonly enchantments?: () => ItemEnchantmentClient | undefined;
}): FrameXmlUnitModelHost<WorldObjectState> {
  const read = clients ?? {
    objects: () => game.world?.state.objects,
    creatureModels: () => game.creatureModels,
    itemMetadata: () => game.itemMetadata,
    mirrorImages: () => game.world?.mirrorImages,
    // The world's own client (game/Loop.ts loads it); a window opened first asks for it here.
    enchantments: () => {
      if (!game.gatewayOrigin) return undefined;
      const client = itemEnchantments(game.gatewayOrigin);
      if (!client.ready) void client.load().catch(() => {});
      return client;
    },
  };
  return {
    snapshot: (guid) => frameXmlUnitSnapshot(read.objects(), guid),
    source: (snapshot) => {
      const models = read.creatureModels();
      const model = unitModelFor(snapshot, models, read.itemMetadata(), read.mirrorImages());
      if (!model) {
        // The world pass asks for the displays of the units it draws; a unit only a window shows
        // (an inspected player out of draw range) is asked for here. `request` deduplicates.
        const displayId = snapshot.fields.get(UPDATE_FIELDS.UNIT_FIELD_DISPLAYID.offset) ?? 0;
        if (displayId > 0 && !models?.get(displayId)) models?.request(displayId);
      }
      const tables = enchantGlowTables(read.enchantments?.()); // 15.11 6.14/6.18
      return frameXmlUnitModelSource(model, frameXmlUnitPieces(snapshot, model, tables ? enchantGlowSource(tables) : undefined));
    },
  };
}
