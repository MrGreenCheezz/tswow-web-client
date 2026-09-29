/**
 * The live barber model's host: the player's appearance bytes, level and stand state, `WorldClient`'s
 * chair flag, `CMSG_ALTER_APPEARANCE`/`CMSG_STANDSTATECHANGE`, the BarberShopStyle rows the native
 * window already fetches (`game.barberStyles`), and three gateway answers fetched once by `prepare`:
 * `/dbc/barber-cost` (gtBarberShopCostBase), `/dbc/character-creation` (the race's customisation
 * words) and `/dbc/character-options` (the hair colours the race, sex and class may choose). A C-API
 * read never fetches.
 */
import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import type { WorldClient } from "../../world/WorldClient.js";
import type { WorldObjectState } from "../../world/WorldState.js";
import { readField, unit as unitField } from "../../world/Fields.js";
import { barberShopResultText } from "../../world/CharacterServiceProtocol.js";
import { game } from "../game/Context.js";
import { FRAMEXML_CREATION_NAMES_PATH } from "./FrameXmlCharacterStats.js";
import { FrameXmlBarberModel, type FrameXmlBarberLook, type FrameXmlBarberStyle } from "./FrameXmlBarber.js";

/** `UNIT_STAND_STATE_SIT_LOW_CHAIR` … `SIT_HIGH_CHAIR` (UnitDefines.h): a barber chair's seats. */
const CHAIR_SEATS_FIRST = 4;
const CHAIR_SEATS_LAST = 6;
const UNIT_STAND_STATE_STAND = 0;
/**
 * `/dbc/character-options` at the version the creation screens read (CharacterAtlas.ts
 * `CHARACTER_OPTIONS_VERSION`), so the browser cache answers; not imported, because that module
 * pulls three.js into the seam. tests/framexml-barber-vertical.test.mjs pins the two together.
 */
export const FRAMEXML_BARBER_OPTIONS_VERSION = 6;
/** `GT_MAX_LEVEL` (DBCStores.h): the price table's last row. */
const GT_MAX_LEVEL = 100;

export interface LiveFrameXmlBarberStyles {
  readonly ready: boolean;
  load(): void;
  stylesFor(type: number, race: number, sex: number): readonly FrameXmlBarberStyle[];
}

export interface LiveFrameXmlBarberHost {
  world(): WorldClient | undefined;
  /** BarberShopStyle rows; the page's `game.barberStyles` when absent. */
  styles?(): LiveFrameXmlBarberStyles | undefined;
  /** The page's `game.gatewayOrigin` when absent. */
  gatewayOrigin?(): string | undefined;
  fetch?: typeof globalThis.fetch;
}

interface Loaded {
  costs?: readonly number[];
  hair?: string;
  facial?: readonly [string, string];
  /** Hair colours keyed `race:sex:class`. */
  colors: Map<string, readonly number[]>;
}

function byteOf(object: WorldObjectState, field: string, index: number): number {
  const offset = (UPDATE_FIELDS as Record<string, { offset: number }>)[field]?.offset;
  const value = offset === undefined ? undefined : object.fields.get(offset);
  return value === undefined ? 0 : (value >>> (index * 8)) & 0xff;
}

export interface LiveFrameXmlBarber {
  readonly model: FrameXmlBarberModel;
  /** Fetch the three gateway answers the stock frame needs; resolves whatever arrived. */
  prepare(): Promise<void>;
}

export function createLiveFrameXmlBarber(host: LiveFrameXmlBarberHost): LiveFrameXmlBarber {
  const loaded: Loaded = { colors: new Map() };
  const client = (): LiveFrameXmlBarberStyles | undefined => (host.styles ? host.styles() : game.barberStyles);
  const origin = (): string | undefined => (host.gatewayOrigin ? host.gatewayOrigin() : game.gatewayOrigin);
  const self = (): WorldObjectState | undefined => {
    const world = host.world();
    const guid = world?.state.selfGuid;
    return world && guid !== undefined && typeof world.state.objects?.get === "function" ? world.state.objects.get(guid) : undefined;
  };
  const raceSex = (): readonly [number, number] | undefined => {
    const player = self();
    // BarberShopStyle.Sex and the options route both count 0 male / 1 female, as the wire does.
    return player ? [unitField.race(player) ?? 0, (unitField.gender(player) ?? 0) === 1 ? 1 : 0] : undefined;
  };
  /**
   * The options route's query and the colours' key: race, sex and class. `Player::ValidateAppearance`
   * refuses a `SECTION_FLAG_DEATH_KNIGHT` CharSections row for any other class, and
   * `HandleAlterAppearance` then returns without a result packet; without `class` the route keeps
   * those rows (measured through CharacterAppearance.options on this dataset, both sexes: hair colours
   * 10-12 of humans, dwarves, night elves, trolls and blood elves, 8-10 of orcs, 9-11 of gnomes and 7-9
   * of draenei are death-knight-only; the undead and tauren have none).
   */
  const colorQuery = (): string | undefined => {
    const player = self();
    const identity = raceSex();
    const classId = player ? unitField.classId(player) ?? 0 : 0;
    return identity && classId > 0 ? `race=${identity[0]}&sex=${identity[1]}&class=${classId}` : undefined;
  };
  // The rows only change when the table lands or the character does: filter once per such change.
  let stylesKey = "";
  const styleRows = new Map<number, readonly FrameXmlBarberStyle[]>();
  const styles = (type: number): readonly FrameXmlBarberStyle[] => {
    const rows = client();
    const identity = raceSex();
    if (!rows?.ready || !identity) return [];
    const key = `${identity[0]}:${identity[1]}`;
    if (key !== stylesKey) {
      stylesKey = key;
      styleRows.clear();
    }
    let typed = styleRows.get(type);
    if (!typed) {
      // An unnamed row comes from the gateway as `Стиль <id>` (BarberMetadata.ts); the DBC's own name is empty.
      typed = rows.stylesFor(type, identity[0], identity[1])
        .map((row) => ({ id: row.id, data: row.data, name: row.name === `Стиль ${row.id}` ? "" : row.name }));
      styleRows.set(type, typed);
    }
    return typed;
  };
  const fetcher = (): typeof globalThis.fetch => host.fetch ?? globalThis.fetch.bind(globalThis);
  const json = async (path: string): Promise<unknown> => {
    const base = origin();
    if (!base) return undefined;
    try {
      const response = await fetcher()(new URL(path, base).href);
      return response.ok ? await response.json() as unknown : undefined;
    } catch {
      return undefined;
    }
  };
  const model = new FrameXmlBarberModel({
    enabled: () => host.world()?.barberShopOpen === true,
    seated: () => {
      const player = self();
      const state = player ? unitField.standState(player) : undefined;
      return state !== undefined && state >= CHAIR_SEATS_FIRST && state <= CHAIR_SEATS_LAST;
    },
    look: (): FrameXmlBarberLook | undefined => {
      const player = self();
      return player ? {
        skin: byteOf(player, "PLAYER_BYTES", 0), hairStyle: byteOf(player, "PLAYER_BYTES", 2),
        hairColor: byteOf(player, "PLAYER_BYTES", 3), facialHair: byteOf(player, "PLAYER_BYTES_2", 0),
      } : undefined;
    },
    appearance: () => {
      const player = self();
      if (!player) return undefined;
      const bytes = player.fields.get(UPDATE_FIELDS.PLAYER_BYTES.offset) ?? 0;
      return (bytes >>> 0) * 256 + byteOf(player, "PLAYER_BYTES_2", 0);
    },
    styles,
    hairColors: () => {
      const query = colorQuery();
      return query ? loaded.colors.get(query) : undefined;
    },
    hairCustomization: () => loaded.hair,
    facialHairCustomization: () => {
      const identity = raceSex();
      return identity && loaded.facial ? loaded.facial[identity[1]] : undefined;
    },
    costBase: () => {
      const player = self();
      const level = player ? readField(player, "UNIT_FIELD_LEVEL") ?? 0 : 0;
      const row = Math.min(level, GT_MAX_LEVEL) - 1;
      return loaded.costs && row >= 0 ? loaded.costs[row] : undefined;
    },
    apply: (hair, color, facial, skin) => host.world()?.alterAppearance(hair, color, facial, skin),
    standUp: () => host.world()?.setStandState(UNIT_STAND_STATE_STAND),
    resultText: (result) => barberShopResultText(result),
    subscribe: (target) => {
      const events = host.world()?.events;
      if (!events || typeof events.on !== "function") return () => {};
      const off = [
        events.on("BARBER_SHOP", ({ open }) => { if (open) target.opened(); }),
        events.on("CHARACTER_SERVICE", ({ kind, result }) => { if (kind === "barber") target.result(result); }),
      ];
      return () => { for (const unsubscribe of off) unsubscribe(); };
    },
  });
  return {
    model,
    prepare: async () => {
      client()?.load();
      const identity = raceSex();
      const query = colorQuery();
      const [costs, creation, options] = await Promise.all([
        loaded.costs ? undefined : json("/dbc/barber-cost?v=1"),
        loaded.hair !== undefined ? undefined : json(FRAMEXML_CREATION_NAMES_PATH),
        !query || loaded.colors.has(query) ? undefined
          : json(`/dbc/character-options?v=${FRAMEXML_BARBER_OPTIONS_VERSION}&${query}`),
      ]);
      const table = (costs as { costs?: unknown } | undefined)?.costs;
      if (Array.isArray(table) && table.every((value) => typeof value === "number" && Number.isFinite(value))) {
        loaded.costs = table as number[];
      }
      const races = (creation as { races?: unknown } | undefined)?.races;
      const race = Array.isArray(races) && identity
        ? races.find((row) => (row as { id?: unknown }).id === identity[0]) as
          { hairCustomization?: unknown; facialHairCustomization?: unknown } | undefined
        : undefined;
      const facial = race?.facialHairCustomization;
      if (race && typeof race.hairCustomization === "string" && Array.isArray(facial)
        && typeof facial[0] === "string" && typeof facial[1] === "string") {
        loaded.hair = race.hairCustomization;
        loaded.facial = [facial[0], facial[1]];
      }
      const colors = (options as { hairColors?: unknown } | undefined)?.hairColors;
      if (query && Array.isArray(colors) && colors.every((value) => Number.isInteger(value))) {
        loaded.colors.set(query, colors as number[]);
      }
    },
  };
}
