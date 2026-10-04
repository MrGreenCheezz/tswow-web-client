import type { WorldObjectState } from "../../world/WorldState.js";
import type { WorldClient } from "../../world/WorldClient.js";
import { game } from "../game/Context.js";
import { canAttackUnit } from "../game/Targeting.js";
import { startFollow, type FollowRefusal, type FollowRules } from "./Follow.js";

/**
 * 5.18: following as the live client asks for it — the FOLLOWTARGET key and the stock
 * `FollowUnit(unit[, exactMatch])` — with the rules that read factions and names wired to `game`.
 */

const FOLLOW_RULES: FollowRules = {
  canAttack: (object) => canAttackUnit(object),
  factionGroup: (templateId) => game.factions?.factionGroupOf?.(templateId),
  // Wow.exe 0x0072A000: the unit's name for AUTOFOLLOW_BEGIN.
  name: (object) => {
    const world = nameWorld ?? game.world;
    return typeof world?.displayName === "function" ? world.displayName(object.guid) : "";
  },
};
/** The world a follow is being started in, for the name (the stock seam's own world). */
let nameWorld: Pick<WorldClient, "displayName"> | undefined;

type FollowCommandWorld = Pick<WorldClient, "state" | "names" | "displayName">;

/** A player in view by name, the way `FollowUnit(fullname, 1)` (UnitPopup) names one. */
function playerNamed(world: FollowCommandWorld, name: string): WorldObjectState | undefined {
  if (name === "") return undefined;
  const wanted = name.toLocaleLowerCase("ru-RU");
  for (const object of world.state.objects.values()) {
    if (object.typeId !== 4) continue;
    const known = world.names.get(object.guid);
    if (known !== undefined && known.toLocaleLowerCase("ru-RU") === wanted) return object;
  }
  return undefined;
}

/**
 * `FollowUnit`: `resolve` is the stock unit-token resolver; a string it does not know is tried as a
 * player's name. Answers the GlobalStrings key of a refusal, or undefined when following began.
 */
export function followUnit(
  world: FollowCommandWorld, unit: string, resolve: (unit: string) => WorldObjectState | undefined,
): FollowRefusal | undefined {
  const target = resolve(unit) ?? playerNamed(world, unit);
  // 0x005224C0: a name other than "target" that finds nobody is ERR_UNIT_NOT_FOUND.
  const named = unit !== "" && unit.toLowerCase() !== "target";
  nameWorld = world;
  try {
    return startFollow(world, target, FOLLOW_RULES, named);
  } finally {
    nameWorld = undefined;
  }
}

/** FOLLOWTARGET (Bindings.xml: `FollowUnit("target")`). */
export function followTarget(): FollowRefusal | undefined {
  const world = game.world;
  if (!world) return "ERR_GENERIC_NO_TARGET";
  const guid = world.targetGuid;
  return followUnit(world, "target", () => (guid === undefined ? undefined : world.state.objects.get(guid)));
}
