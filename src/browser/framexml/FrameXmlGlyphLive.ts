/**
 * The live glyph model's host: the player's three glyph update fields, WorldClient's last
 * `SMSG_TALENTS_INFO`, the carried bag slots, `CMSG_USE_ITEM`'s glyph field and `CMSG_REMOVE_GLYPH`,
 * and the gateway's `/dbc/glyphs` catalog (gateway/GlyphCatalog.ts), fetched once by `prepare` when
 * the stock talent frame takes the glyph tab (FrameXmlGlyphOwner.ts) — never under the retail-talents
 * replacement, which has no glyph tab. A C-API read never fetches.
 */
import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import type { WorldClient } from "../../world/WorldClient.js";
import type { WorldObjectState } from "../../world/WorldState.js";
import { playerInventory, slotAt } from "../Inventory.js";
import { game } from "../game/Context.js";
import {
  FRAMEXML_GLYPH_SOCKETS, FrameXmlGlyphModel, frameXmlGlyphCatalog, type FrameXmlGlyphCatalog,
} from "./FrameXmlGlyph.js";

/** gateway/GlyphCatalog.ts `GLYPH_CATALOG_VERSION`; tests/framexml-glyph.test.mjs pins the two together. */
export const FRAMEXML_GLYPH_CATALOG_VERSION = 1;
export const FRAMEXML_GLYPH_CATALOG_PATH = `/dbc/glyphs?v=${FRAMEXML_GLYPH_CATALOG_VERSION}`;

type GlyphWorld = Pick<WorldClient, "state" | "talents" | "useGlyphItem" | "removeGlyph">;

export interface LiveFrameXmlGlyphHost {
  world(): GlyphWorld | undefined;
  /** GetSpellInfo's name for a glyph's spell; undefined until the spell has resolved. */
  spellName(spellId: number): string | undefined;
  /** The page's `game.gatewayOrigin` when absent. */
  gatewayOrigin?(): string | undefined;
  fetch?: typeof globalThis.fetch;
}

export interface LiveFrameXmlGlyphs {
  readonly model: FrameXmlGlyphModel;
  /** Fetch the catalog once; resolves whether or not it arrived (a missing route leaves nils). */
  prepare(): Promise<void>;
}

const offsetOf = (name: "PLAYER_GLYPHS_ENABLED" | "PLAYER_FIELD_GLYPH_SLOTS_1" | "PLAYER_FIELD_GLYPHS_1"): number =>
  UPDATE_FIELDS[name].offset;

export function createLiveFrameXmlGlyphs(host: LiveFrameXmlGlyphHost): LiveFrameXmlGlyphs {
  let catalog: FrameXmlGlyphCatalog | undefined;
  let pending: Promise<void> | undefined;
  const origin = (): string | undefined => (host.gatewayOrigin ? host.gatewayOrigin() : game.gatewayOrigin);
  const self = (): WorldObjectState | undefined => {
    const world = host.world();
    const guid = world?.state.selfGuid;
    return world && guid !== undefined && typeof world.state.objects?.get === "function"
      ? world.state.objects.get(guid) : undefined;
  };
  const field = (offset: number): number | undefined => {
    const value = self()?.fields.get(offset);
    return value === undefined ? undefined : value >>> 0;
  };
  const model = new FrameXmlGlyphModel({
    catalog: () => catalog,
    enabledMask: () => field(offsetOf("PLAYER_GLYPHS_ENABLED")),
    slotId: (index) => index >= 0 && index < FRAMEXML_GLYPH_SOCKETS
      ? field(offsetOf("PLAYER_FIELD_GLYPH_SLOTS_1") + index) : undefined,
    activeGroup: () => {
      const talents = host.world()?.talents;
      return talents && !talents.pet && Number.isInteger(talents.activeSpec) ? talents.activeSpec + 1 : undefined;
    },
    glyph: (index, group) => {
      if (index < 0 || index >= FRAMEXML_GLYPH_SOCKETS) return undefined;
      const talents = host.world()?.talents;
      const active = talents && !talents.pet ? talents.activeSpec + 1 : undefined;
      // Player::SetGlyph writes the active group's socket field at once; SMSG_TALENTS_INFO follows.
      if (group === active) {
        const live = field(offsetOf("PLAYER_FIELD_GLYPHS_1") + index);
        if (live !== undefined) return live;
      }
      const spec = talents && !talents.pet ? talents.specs[group - 1] : undefined;
      return spec?.glyphs[index];
    },
    spellName: (spellId) => host.spellName(spellId),
    holds: (item) => {
      const world = host.world();
      const inventory = world && typeof world.state.objects?.get === "function" ? playerInventory(world.state) : undefined;
      return !!inventory && slotAt(inventory, item.bag, item.slot)?.guid === item.guid;
    },
    place: (item, index) => host.world()?.useGlyphItem(item.bag, item.slot, item.guid, index),
    remove: (index) => host.world()?.removeGlyph(index),
    session: () => host.world(),
    prepare: () => prepare(),
  });
  const fetcher = (): typeof globalThis.fetch => host.fetch ?? globalThis.fetch.bind(globalThis);
  const prepare = async (): Promise<void> => {
    if (catalog) return;
    const base = origin();
    if (!base) return;
    pending ??= (async () => {
      try {
        const response = await fetcher()(new URL(FRAMEXML_GLYPH_CATALOG_PATH, base).href);
        const data = response.ok ? await response.json() as unknown : undefined;
        catalog = frameXmlGlyphCatalog(data, FRAMEXML_GLYPH_CATALOG_VERSION) ?? catalog;
      } catch {
        // No catalog: every glyph value stays nil and a glyph item is used as before.
      } finally {
        pending = undefined;
      }
    })();
    await pending;
  };
  return { model, prepare };
}
