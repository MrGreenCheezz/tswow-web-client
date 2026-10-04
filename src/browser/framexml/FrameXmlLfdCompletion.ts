/**
 * The stock owner of the dungeon finder's completion reward (plan item 3.25, L5c 04.10).
 *
 * In the client SMSG_LFG_PLAYER_REWARD (0x0055bdc0) raises LFG_COMPLETION_REWARD (event 0x205), and
 * AlertFrames.lua's AlertFrame (AlertFrames.lua:3-20) shows DungeonCompletionAlertFrame1 from
 * GetLFGCompletionReward/GetLFGCompletionRewardItem. AlertFrames.xml is not in the vertical TOC; the
 * achievement owner already loads it on demand (`loadFrameXmlAlertFrames`, once per VM), so the
 * reward does the same at its first arrival. The answer says whether the alert frame is there to
 * own the reward; false leaves it to the native prompt.
 */

import type { FrameXmlBoot } from "./FrameXmlBoot.js";
import type { FrameXmlDomRenderer } from "../ui/framexml_compat/FrameXmlDomRenderer.js";
import { loadFrameXmlAlertFrames } from "./FrameXmlAchievementOwner.js";

export function frameXmlLfdCompletionAlert(
  boot: Pick<FrameXmlBoot, "vm" | "bridge" | "corpus">,
  renderer: Pick<FrameXmlDomRenderer, "addRoots" | "sync">,
  load: typeof loadFrameXmlAlertFrames = loadFrameXmlAlertFrames,
): () => Promise<boolean> {
  let pending: Promise<boolean> | undefined;
  return () => {
    pending ??= (async () => {
      const alerts = await load(boot);
      if (alerts.roots.length > 0) renderer.addRoots(alerts.roots);
      renderer.sync();
      const ready = alerts.ok && boot.bridge.getFrame("DungeonCompletionAlertFrame1") !== undefined;
      if (!ready) console.warn(`[FrameXML LFD] the completion alert is off: ${alerts.message ?? "no DungeonCompletionAlertFrame1"}`);
      return ready;
    })().catch(() => false);
    return pending;
  };
}
