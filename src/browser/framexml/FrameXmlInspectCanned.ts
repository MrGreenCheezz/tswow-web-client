/**
 * A scripted inspection for the canned seam, the offline preview and the tests: a friendly mage the
 * preview targets, her equipped items, the canned fire tree as her talents, honor and one arena team.
 *
 * The items are this dataset's (measured through the gateway: `/data/items` for the ruRU name and
 * quality, ItemDisplayInfo.InventoryIcon for the picture); the head piece's two socket enchantments
 * are the canned socketing gems' (FrameXmlSocketCanned.ts). The honor and arena numbers are the
 * fixture's own.
 */
import type { CannedTarget } from "./CannedWorldSeam.js";
import type { FrameXmlTalentSnapshot } from "./FrameXmlTalentResolver.js";
import {
  FrameXmlInspectModel, type FrameXmlInspectArenaTeam, type FrameXmlInspectHonor, type FrameXmlInspectItem,
} from "./FrameXmlInspect.js";
import { frameXmlSocketItemLink } from "./FrameXmlSocketLive.js";

export const FRAMEXML_CANNED_INSPECT_GUID = 0x0000_0000_0000_2001n;

/** The friendly player the inspect preview targets. */
export const CANNED_INSPECT_TARGET: CannedTarget = Object.freeze({
  name: "Алистра",
  level: 80,
  className: "Маг",
  classToken: "MAGE",
  raceName: "Человек",
  raceToken: "Human",
  sex: 3,
  health: 18_400,
  healthMax: 18_400,
  power: 21_000,
  powerMax: 21_000,
  powerType: 0,
  factionGroup: "Alliance",
  reaction: 1,
  classification: "normal",
  isPlayer: true,
  connected: true,
  pvp: false,
  pvpFreeForAll: false,
  tapped: false,
  tappedByPlayer: false,
  tappedByAllThreatList: false,
});

interface CannedInspectItem {
  readonly slot: number;
  readonly entry: number;
  readonly name: string;
  readonly texture: string;
  readonly quality: number;
  /** What the answered inspection carries; the visible fields show only slot 0 of it. */
  readonly enchantments: readonly number[];
}

export const FRAMEXML_CANNED_INSPECT_ITEMS: readonly CannedInspectItem[] = Object.freeze([
  { slot: 1, entry: 40416, name: "Доблестный венец ледяного огня", texture: "Interface\\Icons\\INV_Crown_01", quality: 4, enchantments: [0, 0, 3621, 3518, 0, 0, 0] },
  { slot: 3, entry: 40419, name: "Доблестные наплечные пластины ледяного огня", texture: "Interface\\Icons\\INV_Shoulder_25", quality: 4, enchantments: [] },
  { slot: 5, entry: 40418, name: "Доблестное атласное одеяние ледяного огня", texture: "Interface\\Icons\\INV_Chest_Cloth_43", quality: 4, enchantments: [] },
  { slot: 7, entry: 40417, name: "Доблестные поножи ледяного огня", texture: "Interface\\Icons\\INV_Pants_Cloth_05", quality: 4, enchantments: [] },
  { slot: 10, entry: 40415, name: "Доблестные перчатки ледяного огня", texture: "Interface\\Icons\\INV_Gauntlets_17", quality: 4, enchantments: [] },
  { slot: 13, entry: 40255, name: "Исчезающее проклятие", texture: "Interface\\Icons\\INV_Trinket_Naxxramas03", quality: 4, enchantments: [] },
  { slot: 16, entry: 40489, name: "Большой посох Нексуса", texture: "Interface\\Icons\\INV_Staff_83", quality: 4, enchantments: [] },
]);

export class CannedFrameXmlInspectWorld {
  /** CMSG_INSPECT, MSG_INSPECT_HONOR_STATS requests, in order. */
  readonly requests: string[] = [];
  /** Whether SMSG_INSPECT_TALENT has answered; before it only the visible entries are known. */
  answered = false;
  honorAnswered = false;
  /** Answer each request on the next microtask, as the preview wants. */
  autoAnswer = false;
  model: FrameXmlInspectModel | undefined;

  reset(): void {
    this.requests.length = 0;
    this.answered = false;
    this.honorAnswered = false;
  }

  /** The server's SMSG_INSPECT_TALENT for the canned mage. */
  answer(): void {
    this.answered = true;
    this.model?.talentsReady(FRAMEXML_CANNED_INSPECT_GUID);
  }

  /** The server's MSG_INSPECT_HONOR_STATS and MSG_INSPECT_ARENA_TEAMS. */
  answerHonor(): void {
    this.honorAnswered = true;
    this.model?.honorReady(FRAMEXML_CANNED_INSPECT_GUID);
  }
}

export const FRAMEXML_CANNED_INSPECT_HONOR: FrameXmlInspectHonor = Object.freeze({
  todayKills: 3, todayHonor: 125, yesterdayKills: 12, yesterdayHonor: 480, lifetimeKills: 2104,
});

export const FRAMEXML_CANNED_INSPECT_TEAM: FrameXmlInspectArenaTeam = Object.freeze({
  slot: 0, name: "Ледяные искры", size: 2, rating: 1650, played: 40, wins: 25, playerPlayed: 38, playerRating: 1702,
  backgroundColor: 0xff1a3d8f, emblemStyle: 12, emblemColor: 0xffffffff, borderStyle: 2, borderColor: 0xffc0c0c0,
});

export function createCannedFrameXmlInspect(
  target: () => CannedTarget | undefined,
  talents: () => FrameXmlTalentSnapshot | undefined,
): { readonly model: FrameXmlInspectModel; readonly world: CannedFrameXmlInspectWorld } {
  const world = new CannedFrameXmlInspectWorld();
  const targetGuid = (unit: string): bigint | undefined =>
    unit === "target" && target() === CANNED_INSPECT_TARGET ? FRAMEXML_CANNED_INSPECT_GUID : undefined;
  const later = (run: () => void): void => { if (world.autoAnswer) queueMicrotask(run); };
  const model = new FrameXmlInspectModel({
    unitGuid: targetGuid,
    inspectable: (unit) => targetGuid(unit) !== undefined,
    distance: (unit) => (targetGuid(unit) !== undefined ? 5 : undefined),
    classId: (guid) => (guid === FRAMEXML_CANNED_INSPECT_GUID ? 8 : undefined),
    requestInspect: (guid) => {
      world.requests.push(`inspect:${guid}`);
      later(() => world.answer());
    },
    requestHonor: (guid) => {
      world.requests.push(`honor:${guid}`);
      later(() => world.answerHonor());
    },
    inspected: (guid) => guid === FRAMEXML_CANNED_INSPECT_GUID && world.answered,
    item: (guid, slot): FrameXmlInspectItem | undefined => {
      if (guid !== FRAMEXML_CANNED_INSPECT_GUID) return undefined;
      const item = FRAMEXML_CANNED_INSPECT_ITEMS.find((row) => row.slot === slot);
      if (!item) return undefined;
      // The visible-item fields carry the entry and the permanent enchantment only.
      const enchantments = world.answered ? item.enchantments : [item.enchantments[0] ?? 0];
      return { entry: item.entry, enchantments, randomPropertyId: 0, suffixFactor: 0 };
    },
    itemTexture: (entry) => FRAMEXML_CANNED_INSPECT_ITEMS.find((row) => row.entry === entry)?.texture,
    itemLink: (item) => {
      const row = FRAMEXML_CANNED_INSPECT_ITEMS.find((candidate) => candidate.entry === item.entry);
      return row ? frameXmlSocketItemLink(item.entry, row.name, row.quality, item.enchantments, item.randomPropertyId, item.suffixFactor, 80) : undefined;
    },
    talents: (guid) => (guid === FRAMEXML_CANNED_INSPECT_GUID && world.answered ? talents() : undefined),
    honor: (guid) => (guid === FRAMEXML_CANNED_INSPECT_GUID && world.honorAnswered ? FRAMEXML_CANNED_INSPECT_HONOR : undefined),
    arenaTeams: (guid) => (guid === FRAMEXML_CANNED_INSPECT_GUID && world.honorAnswered ? [FRAMEXML_CANNED_INSPECT_TEAM] : []),
  });
  world.model = model;
  return { model, world };
}
