/**
 * The live achievement model's world: WorldClient's achievement maps and packets
 * (CharacterProgressProtocol.ts), shaped as FrameXmlAchievementWorld. The catalog is not here — the
 * world mount hands the model the gateway's (FrameXmlAchievementMount.ts), since only it knows the
 * gateway's origin.
 */
import type { WorldClient } from "../../world/WorldClient.js";
import { unit as unitField } from "../../world/Fields.js";
import {
  FrameXmlAchievementModel,
  type FrameXmlAchievementChange,
  type FrameXmlAchievementInspect,
} from "./FrameXmlAchievement.js";

const EMPTY_COMPLETED: ReadonlyMap<number, number> = new Map();
const EMPTY_CRITERIA: ReadonlyMap<number, bigint> = new Map();

/**
 * `world` is read on every call (a reconnect replaces the WorldClient); `faction` is the seam's
 * UnitFactionGroup("player"), «Alliance» or «Horde», which the table spells 1 and 0.
 */
export function createLiveFrameXmlAchievement(
  world: () => WorldClient | undefined,
  faction: () => string | undefined,
): FrameXmlAchievementModel {
  return new FrameXmlAchievementModel({
    completed: () => world()?.achievements ?? EMPTY_COMPLETED,
    criteria: () => world()?.criteria ?? EMPTY_CRITERIA,
    faction: () => {
      const group = faction();
      return group === "Alliance" ? 1 : group === "Horde" ? 0 : undefined;
    },
    selfGuid: () => world()?.state.selfGuid,
    inspect: (): FrameXmlAchievementInspect | undefined => world()?.inspectAchievements,
    queryInspect: (guid) => world()?.queryInspectAchievements(guid),
    gender: (guid) => {
      const object = world()?.state.objects.get(guid);
      return object ? unitField.gender(object) : undefined;
    },
    name: (guid) => world()?.names.get(guid),
    subscribe: (listener: (change: FrameXmlAchievementChange) => void) => {
      const client = world();
      if (!client) return () => {};
      const stopEarned = client.events.on("ACHIEVEMENT_EARNED", (earned) => {
        listener({ kind: "earned", achievementId: earned.achievementId, mine: earned.mine });
      });
      const stopState = client.events.on("ACHIEVEMENT_STATE_CHANGED", (change) => listener(change));
      return () => {
        stopEarned();
        stopState();
      };
    },
  });
}
