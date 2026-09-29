import type { QuestDialog, QuestRewardItem, QuestRewards } from "../../world/NpcProtocol.js";
import type {
  FrameXmlQuestItemInfo, FrameXmlQuestItemMetadata, FrameXmlQuestRewardSpell,
} from "./FrameXmlWorldSeam.js";

/** Cached host data only. These callbacks must not start a query while Lua is painting a row. */
export interface FrameXmlQuestRewardMetadata {
  item(itemId: number, displayId: number): FrameXmlQuestItemMetadata | undefined;
  spell?(spellId: number): FrameXmlQuestRewardSpell | undefined;
  title?(titleId: number): string | undefined;
  /** Override for a host with different honor wire units. */
  honorPoints?(wireHonor: number): number | undefined;
}

export type FrameXmlQuestRewardDataValues =
  | readonly [] | readonly [number] | readonly [string]
  | FrameXmlQuestItemInfo | FrameXmlQuestRewardSpell;

type QuestRewardDataBinding = (
  dialog: QuestDialog | undefined,
  args: readonly unknown[],
  metadata: FrameXmlQuestRewardMetadata,
) => FrameXmlQuestRewardDataValues;

const NOTHING: readonly [] = Object.freeze([]);

/** QuestDef::BuildQuestRewards sends ten wire units per earned honor point. */
export function selectedCoreQuestHonorPoints(wireHonor: number): number | undefined {
  return Number.isSafeInteger(wireHonor) && wireHonor >= 0 && wireHonor % 10 === 0
    ? wireHonor / 10 : undefined;
}

/** Convert an already cached Spell.dbc record to GetRewardSpell's stock tuple. */
export function cachedQuestRewardSpellInfo(
  spell: Readonly<{ name: string; iconPath: string }> | undefined,
  isSpellLearned?: boolean,
): FrameXmlQuestRewardSpell | undefined {
  if (!spell || !spell.name || !spell.iconPath) return undefined;
  // The cache does not establish the native GetRewardSpell trade-skill predicate.
  return [spell.iconPath, spell.name, undefined, isSpellLearned];
}

function value<T extends string | number>(field: T | undefined): readonly [] | readonly [T] {
  return field === undefined ? NOTHING : [field];
}

function rewards(dialog: QuestDialog | undefined): QuestRewards | undefined {
  return dialog?.kind === "details" || dialog?.kind === "reward" ? dialog.rewards : undefined;
}

function questItem(dialog: QuestDialog | undefined, type: unknown, index: unknown): QuestRewardItem | undefined {
  if (!Number.isInteger(index) || (index as number) < 1) return undefined;
  const row = (index as number) - 1; // QuestInfo.lua passes one-based button IDs.
  if (type === "required") return dialog?.kind === "request-items" ? dialog.items[row] : undefined;
  const source = rewards(dialog);
  if (type === "choice") return source?.choices[row];
  if (type === "reward") return source?.items[row];
  return undefined;
}

function itemInfo(
  dialog: QuestDialog | undefined, args: readonly unknown[], metadata: FrameXmlQuestRewardMetadata,
): FrameXmlQuestItemInfo | readonly [] {
  const item = questItem(dialog, args[0], args[1]);
  if (!item || !Number.isInteger(item.id) || item.id <= 0
    || !Number.isInteger(item.count) || item.count <= 0) return NOTHING;
  const cached = metadata.item(item.id, item.displayId);
  // Stock QuestInfo needs both fields to paint a stable row. A packet item id/display id is not
  // its localized name or decoded icon, so unresolved metadata remains Lua nil.
  if (!cached || typeof cached.name !== "string" || cached.name.length === 0
    || typeof cached.texture !== "string" || cached.texture.length === 0) return NOTHING;
  return [cached.name, cached.texture, item.count, cached.quality, cached.isUsable];
}

/**
 * Packet-backed stock QuestInfo/QuestFrame reward getters. The selected 3.3.5a Lua asks for
 * choice/reward counts, GetQuestItemInfo("required"|"choice"|"reward", oneBasedIndex), and the
 * scalar reward fields. LiveWorldSeam registers them as packet-backed C API names, but the stock
 * QuestFrame owner still needs its full event/command gate before it can replace the native dialog.
 */
export const FRAMEXML_QUEST_REWARD_DATA_BINDINGS: Readonly<Record<
  | "GetNumQuestRewards" | "GetNumQuestChoices" | "GetQuestItemInfo"
  | "GetRewardMoney" | "GetRewardHonor" | "GetRewardArenaPoints"
  | "GetRewardTalents" | "GetRewardXP" | "GetRewardTitle" | "GetRewardSpell",
  QuestRewardDataBinding
>> = Object.freeze({
  GetNumQuestRewards: (dialog) => value(rewards(dialog)?.items.length),
  GetNumQuestChoices: (dialog) => value(rewards(dialog)?.choices.length),
  GetQuestItemInfo: itemInfo,
  GetRewardMoney: (dialog) => value(rewards(dialog)?.money),
  GetRewardHonor: (dialog, _args, metadata) => {
    const wireHonor = rewards(dialog)?.honor;
    return value(wireHonor === undefined ? undefined
      : (metadata.honorPoints ?? selectedCoreQuestHonorPoints)(wireHonor));
  },
  GetRewardArenaPoints: (dialog) => value(rewards(dialog)?.arenaPoints),
  GetRewardTalents: (dialog) => value(rewards(dialog)?.talents),
  // QuestDef::BuildQuestRewards writes the player-scaled XP into the giver packet. The identically
  // named field in SMSG_QUEST_QUERY_RESPONSE is a difficulty index and must not be used here.
  GetRewardXP: (dialog) => value(rewards(dialog)?.xpDifficulty),
  GetRewardTitle: (dialog, _args, metadata) => {
    const id = rewards(dialog)?.titleId;
    const title = id && id > 0 ? metadata.title?.(id) : undefined;
    return typeof title === "string" && title.length > 0 ? [title] : NOTHING;
  },
  GetRewardSpell: (dialog, _args, metadata) => {
    const id = rewards(dialog)?.displaySpell;
    const spell = id && id > 0 ? metadata.spell?.(id) : undefined;
    return spell && typeof spell[0] === "string" && spell[0].length > 0
      && typeof spell[1] === "string" && spell[1].length > 0 ? spell : NOTHING;
  },
});
