import type { QuestDialog, QuestList } from "../../world/NpcProtocol.js";
import {
  FRAMEXML_QUEST_MENU_DATA_BINDINGS,
  frameXmlQuestMenuSelection,
  type FrameXmlQuestMenuBinding,
  type FrameXmlQuestMenuFacts,
} from "./FrameXmlQuestMenuData.js";
import { FRAMEXML_QUEST_GIVER_DATA_BINDINGS } from "./FrameXmlQuestGiverData.js";
import {
  FRAMEXML_QUEST_REWARD_DATA_BINDINGS,
  type FrameXmlQuestRewardMetadata,
} from "./FrameXmlQuestRewardData.js";
import { FRAMEXML_QUEST_FLAGS_DATA_BINDINGS } from "./FrameXmlQuestFlagsData.js";
import {
  resolveFrameXmlQuestAction,
  type FrameXmlQuestActionName,
  type FrameXmlQuestCommand,
} from "./FrameXmlQuestActions.js";

/** The small WorldClient surface used by the stock quest giver, with the server still authoritative. */
export interface FrameXmlQuestGiverWorld {
  readonly questList: QuestList | undefined;
  readonly questDialog: QuestDialog | undefined;
  openQuest(guid: bigint, questId: number, completion: boolean): void;
  acceptQuest(): void;
  requestQuestReward(): void;
  chooseQuestReward(choice: number): void;
  closeQuest(): void;
}

export interface FrameXmlQuestGiverReadContext {
  readonly menuFacts?: FrameXmlQuestMenuFacts;
  readonly rewardMetadata: FrameXmlQuestRewardMetadata;
}

export type FrameXmlQuestGiverPendingCommand =
  | FrameXmlQuestCommand
  | { readonly method: "openQuest"; readonly expectedList: QuestList;
      readonly guid: bigint; readonly questId: number; readonly completion: boolean };

const ACTIONS: ReadonlySet<string> = new Set([
  "AcceptQuest", "CompleteQuest", "GetQuestReward", "DeclineQuest", "CloseQuest",
]);
const NOTHING: readonly [] = Object.freeze([]);

/**
 * Compose only getters already backed by the selected quest giver packets. The shared seam calls
 * this adapter from the VM, while the stock QuestFrame stays hidden until its remaining helpers,
 * cached reward metadata, lifecycle owner and rendered tree pass one complete gate.
 */
export function frameXmlQuestGiverRead(
  name: string,
  args: readonly unknown[],
  world: Pick<FrameXmlQuestGiverWorld, "questList" | "questDialog">,
  context: FrameXmlQuestGiverReadContext,
): readonly unknown[] | undefined {
  if (world.questList && world.questDialog) return NOTHING;
  const menu = (FRAMEXML_QUEST_MENU_DATA_BINDINGS as Partial<Record<string, FrameXmlQuestMenuBinding>>)[name];
  if (menu) return menu(world.questList, args[0] as number | undefined, context.menuFacts);
  const giver = (FRAMEXML_QUEST_GIVER_DATA_BINDINGS as Partial<Record<string,
    (dialog: QuestDialog | undefined) => readonly unknown[]>>)[name];
  if (giver) return giver(world.questDialog);
  const reward = (FRAMEXML_QUEST_REWARD_DATA_BINDINGS as Partial<Record<string,
    (dialog: QuestDialog | undefined, args: readonly unknown[],
      metadata: FrameXmlQuestRewardMetadata) => readonly unknown[]>>)[name];
  if (reward) return reward(world.questDialog, args, context.rewardMetadata);
  const flags = (FRAMEXML_QUEST_FLAGS_DATA_BINDINGS as Partial<Record<string,
    (dialog: QuestDialog | undefined) => readonly unknown[]>>)[name];
  if (flags) return flags(world.questDialog);
  return undefined;
}

/** Resolve a stock action now, while keeping its page identity for an eventual delayed callback. */
export function resolveFrameXmlQuestGiverCommand(
  name: string,
  args: readonly unknown[],
  world: Pick<FrameXmlQuestGiverWorld, "questList" | "questDialog">,
): FrameXmlQuestGiverPendingCommand | undefined {
  if (world.questList && world.questDialog) return undefined;
  if (name === "SelectActiveQuest" || name === "SelectAvailableQuest") {
    const list = world.questList;
    if (!list) return undefined;
    const selection = frameXmlQuestMenuSelection(list,
      name === "SelectActiveQuest" ? "active" : "available", args[0] as number);
    return selection ? { method: "openQuest", expectedList: list, ...selection } : undefined;
  }
  if (!ACTIONS.has(name)) return undefined;
  const result = resolveFrameXmlQuestAction(name as FrameXmlQuestActionName, world,
    { luaChoice: args[0] });
  return result.ok ? result.command : undefined;
}

/** A stale popup or quest button cannot submit an action for a newer server page. */
export function performFrameXmlQuestGiverCommand(
  world: FrameXmlQuestGiverWorld,
  command: FrameXmlQuestGiverPendingCommand,
): boolean {
  if (command.method === "openQuest") {
    if (world.questList !== command.expectedList || world.questDialog) return false;
    world.openQuest(command.guid, command.questId, command.completion);
    return true;
  }
  if (command.method === "closeQuest") {
    if (world.questDialog !== command.expectedPage && world.questList !== command.expectedPage) return false;
    world.closeQuest();
    return true;
  }
  if (world.questDialog !== command.expectedDialog || world.questList) return false;
  if (command.method === "acceptQuest") world.acceptQuest();
  else if (command.method === "requestQuestReward") world.requestQuestReward();
  else world.chooseQuestReward(command.choice);
  return true;
}
