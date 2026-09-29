/**
 * The live title model's host: the player's chosen-title and known-title update fields, the sex
 * byte of UNIT_FIELD_BYTES_0, `CMSG_SET_TITLE`, and the gateway's `/dbc/char-titles` catalog
 * (CharTitleClient.ts), fetched once when the seam attaches. A C-API read never fetches; a gateway
 * without the route (one started before it existed) leaves every title value nil.
 */
import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import { readField, unit as unitField } from "../../world/Fields.js";
import type { WorldClient } from "../../world/WorldClient.js";
import type { WorldObjectState } from "../../world/WorldState.js";
import { CharTitleClient } from "../CharTitleClient.js";
import { game } from "../game/Context.js";
import {
  FRAMEXML_KNOWN_TITLE_WORDS, FrameXmlTitleModel, frameXmlTitleCatalog,
  type FrameXmlTitleCatalog, type FrameXmlTitleWearer,
} from "./FrameXmlTitles.js";

type TitleWorld = Pick<WorldClient, "state" | "setTitle">;

export interface LiveFrameXmlTitleHost {
  world(): TitleWorld | undefined;
  /** The page's `game.gatewayOrigin` when absent. */
  gatewayOrigin?(): string | undefined;
  fetch?: typeof globalThis.fetch;
}

export interface LiveFrameXmlTitles {
  readonly model: FrameXmlTitleModel;
  /** Fetch the catalog once; resolves whether or not it arrived. */
  prepare(): Promise<void>;
}

/** `UNIT_BYTES_0_OFFSET_GENDER`'s female value (`GENDER_FEMALE`, SharedDefines.h). */
const GENDER_FEMALE = 1;

/** The two fields any player object wears a title by; both undefined without the object. */
export function liveFrameXmlTitleWearer(object: WorldObjectState | undefined): FrameXmlTitleWearer {
  if (!object) return { chosen: undefined, female: undefined };
  const gender = unitField.gender(object);
  return {
    chosen: readField(object, "PLAYER_CHOSEN_TITLE"),
    female: gender === undefined ? undefined : gender === GENDER_FEMALE,
  };
}

export function createLiveFrameXmlTitles(host: LiveFrameXmlTitleHost): LiveFrameXmlTitles {
  let catalog: FrameXmlTitleCatalog | undefined;
  let client: CharTitleClient | undefined;
  const self = (): WorldObjectState | undefined => {
    const world = host.world();
    const guid = world?.state.selfGuid;
    return world && guid !== undefined && typeof world.state.objects?.get === "function"
      ? world.state.objects.get(guid) : undefined;
  };
  const prepare = async (): Promise<void> => {
    if (catalog) return;
    const origin = host.gatewayOrigin ? host.gatewayOrigin() : game.gatewayOrigin;
    if (!origin) return;
    client ??= new CharTitleClient(origin, host.fetch);
    await client.load();
    const rows = client.rows;
    if (rows && !catalog) catalog = frameXmlTitleCatalog(rows);
  };
  const model = new FrameXmlTitleModel({
    catalog: () => catalog,
    knownWords: () => {
      const player = self();
      if (!player) return undefined;
      const first = UPDATE_FIELDS.PLAYER__FIELD_KNOWN_TITLES.offset;
      const words: number[] = [];
      for (let index = 0; index < FRAMEXML_KNOWN_TITLE_WORDS; index++) {
        words.push((player.fields.get(first + index) ?? 0) >>> 0);
      }
      return words;
    },
    wearer: () => liveFrameXmlTitleWearer(self()),
    setTitle: (index) => host.world()?.setTitle(index),
    session: () => host.world(),
    prepare,
  });
  return { model, prepare };
}
