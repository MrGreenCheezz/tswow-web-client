import { formatGlobalStringByName } from "./GlobalStringFormat.js";
import { itemRefundMoneyText } from "./ItemRefundProtocol.js";
import type { LfgPlayerReward } from "./LfgProtocol.js";

/**
 * 3.25 (11.11): the system lines Wow.exe 3.3.5a prints for `SMSG_LFG_PLAYER_REWARD` before it raises
 * LFG_COMPLETION_REWARD (0x0055bdc0, case 0x1ff; `.runtime/re-2026-11-11/api4/d1.c`). In order, each only
 * when above zero (the words compared as signed integers):
 *
 * 1. game message 0xa1, `ERR_QUEST_REWARD_EXP_I`, with the base experience;
 * 2. 0xa1 again with strangers × experience per stranger;
 * 3. game message 0xa4, `ERR_QUEST_REWARD_MONEY_S`, with the base money written by 0x007e7d80 — the
 *    GOLD/SILVER/COPPER_AMOUNT parts joined as the refund lines join them (`itemRefundMoneyText`);
 * 4. 0xa4 again with strangers × money per stranger.
 *
 * Both messages are type 0 in the game-message table (0x00ac9784, 0x00ac97c0: 20-byte rows), which
 * 0x005216f0 prints as a system chat line. TrinityCore sends strangers 1 and both per-stranger words 0
 * (LFGHandler.cpp SendLfgPlayerReward), so its rewards print lines 1 and 3 only.
 */
export function lfgRewardSystemLines(reward: LfgPlayerReward): string[] {
  const lines: string[] = [];
  const strangers = reward.strangers ?? 0;
  const experience = reward.reward.experience | 0;
  const strangerExperience = Math.imul(strangers, reward.experienceVar ?? 0);
  const money = reward.reward.money | 0;
  const strangerMoney = Math.imul(strangers, reward.moneyVar ?? 0);
  const experienceLine = (amount: number): string =>
    formatGlobalStringByName("ERR_QUEST_REWARD_EXP_I", [amount], "Получено опыта: %d.");
  const moneyLine = (amount: number): string =>
    formatGlobalStringByName("ERR_QUEST_REWARD_MONEY_S", [itemRefundMoneyText(amount)], "Получено: %s.");
  if (experience > 0) lines.push(experienceLine(experience));
  if (strangerExperience > 0) lines.push(experienceLine(strangerExperience));
  if (money > 0) lines.push(moneyLine(money));
  if (strangerMoney > 0) lines.push(moneyLine(strangerMoney));
  return lines;
}
