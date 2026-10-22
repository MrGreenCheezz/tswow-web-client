/** 22.10 (12.14): the page's status lines and notices the resource clients write (app/ResourceStatusLines.ts). */

import { environmentStatus, terrainStatus } from "../ui/Dom.js";
import { notice } from "../ui/Notices.js";
import type { ResourceStatusTargets } from "./ResourceStatusLines.js";

let targets: ResourceStatusTargets | undefined;

export function resourceStatusTargets(): ResourceStatusTargets {
  targets ??= { terrain: terrainStatus, environment: environmentStatus, notice: (message) => notice(message) };
  return targets;
}
