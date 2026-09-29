/**
 * The offline conversation: an innkeeper's `SMSG_GOSSIP_MESSAGE` page and its `npc_text`, and a
 * scripted world that records every command, for `CannedWorldSeam` and its tests.
 *
 * The page has every row GossipFrame draws: a quest to take (icon 2), one to turn in (icon 4), a
 * chat row, a paid binder row with a box message (GOSSIP_CONFIRM) and a vendor row. For the canned
 * level-60 player the level-5 quest is trivial (grey, «низкий уровень») and the level-58 one is not.
 * The wording is illustrative, not copied from a database row.
 */
import type { GossipMessage, NpcText } from "../../world/NpcProtocol.js";
import {
  FrameXmlGossipModel, frameXmlQuestTrivial, type FrameXmlGossipContext, type FrameXmlGossipWorld,
} from "./FrameXmlGossip.js";
import { questGreenRange } from "./FrameXmlWorldSeam.js";

/** The canned creature the page belongs to. */
export const FRAMEXML_CANNED_GOSSIP_GUID = 0xF130000127000123n;

export const FRAMEXML_CANNED_GOSSIP_PAGE: GossipMessage = Object.freeze({
  guid: FRAMEXML_CANNED_GOSSIP_GUID,
  menuId: 1293,
  textId: 1853,
  options: [
    { id: 0, icon: 0, coded: false, money: 0, text: "Расскажи мне об этом городе.", boxText: "" },
    { id: 1, icon: 5, coded: false, money: 0, text: "Я хочу остановиться в этой таверне.", boxText: "Сделать эту таверну своим домом?" },
    { id: 2, icon: 1, coded: false, money: 0, text: "Покажи мне свои товары.", boxText: "" },
    { id: 3, icon: 6, coded: false, money: 1000, text: "Мне нужна комната на ночь.", boxText: "Комната стоит 10 серебряных." },
  ],
  quests: [
    { id: 60, icon: 2, level: 5, flags: 0, repeatable: false, title: "Кобольдские свечи" },
    { id: 47, icon: 4, level: 58, flags: 0, repeatable: false, title: "Золотая пыль" },
  ],
});

export const FRAMEXML_CANNED_GOSSIP_TEXT: NpcText = Object.freeze({
  id: 1853,
  options: [
    { probability: 1, male: "Добро пожаловать в «Златоземье», $N! Путь до Штормграда неблизкий — отдохни у огня.", female: "", language: 0 },
    ...Array.from({ length: 7 }, () => ({ probability: 0, male: "", female: "", language: 0 })),
  ],
});

/** The second page the chat row leads to, so a test can walk from one page to the next. */
export const FRAMEXML_CANNED_GOSSIP_SUBPAGE: GossipMessage = Object.freeze({
  guid: FRAMEXML_CANNED_GOSSIP_GUID,
  menuId: 1294,
  textId: 1854,
  options: [{ id: 0, icon: 0, coded: false, money: 0, text: "Спасибо.", boxText: "" }],
  quests: [],
});

const SUBPAGE_TEXT: NpcText = Object.freeze({
  id: 1854,
  options: [
    { probability: 1, male: "Златоземье стоит на тракте между Штормградом и Западным краем.", female: "", language: 0 },
    ...Array.from({ length: 7 }, () => ({ probability: 0, male: "", female: "", language: 0 })),
  ],
});

export type FrameXmlCannedGossipCall =
  | { readonly kind: "select"; readonly optionId: number; readonly code: string | undefined }
  | { readonly kind: "quest"; readonly questId: number; readonly completion: boolean }
  | { readonly kind: "close" };

/**
 * `WorldClient`'s gossip fields and commands. Commands only record, except the chat row, which
 * opens the second page the way a server menu would; `onChanged` is the `onGossipChanged` slot.
 */
export class FrameXmlCannedGossipWorld implements FrameXmlGossipWorld {
  gossip: GossipMessage | undefined;
  readonly npcTexts = new Map<number, NpcText>();
  readonly calls: FrameXmlCannedGossipCall[] = [];
  onChanged: (() => void) | undefined;

  /** Talk to the innkeeper: the page arrives; its text with it unless `textPending`. */
  talk(page: GossipMessage = FRAMEXML_CANNED_GOSSIP_PAGE, textPending = false): void {
    if (!textPending) this.#learnText(page.textId);
    this.gossip = page;
    this.onChanged?.();
  }

  /** `SMSG_NPC_TEXT_UPDATE` for the open page. */
  answerText(): void {
    if (!this.gossip) return;
    this.#learnText(this.gossip.textId);
    this.onChanged?.();
  }

  #learnText(id: number): void {
    const text = id === FRAMEXML_CANNED_GOSSIP_TEXT.id ? FRAMEXML_CANNED_GOSSIP_TEXT
      : id === SUBPAGE_TEXT.id ? SUBPAGE_TEXT : undefined;
    if (text) this.npcTexts.set(id, text);
  }

  selectGossipOption(optionId: number, code?: string): void {
    this.calls.push({ kind: "select", optionId, code });
    if (this.gossip === FRAMEXML_CANNED_GOSSIP_PAGE && optionId === 0) this.talk(FRAMEXML_CANNED_GOSSIP_SUBPAGE);
  }

  closeGossip(): void {
    this.calls.push({ kind: "close" });
    if (!this.gossip) return;
    this.gossip = undefined;
    this.onChanged?.();
  }

  openQuest(_guid: bigint, questId: number, completion: boolean): void {
    this.calls.push({ kind: "quest", questId, completion });
  }
}

/**
 * The canned model over the scripted world; the world's callback syncs the model like Npc.ts does.
 * `playerLevel` greys the rows the way LiveWorldSeam does; without it triviality stays nil.
 */
export function createCannedFrameXmlGossip(
  context: Omit<FrameXmlGossipContext, "world"> & { readonly playerLevel?: () => number | undefined } = {},
): { readonly model: FrameXmlGossipModel; readonly world: FrameXmlCannedGossipWorld } {
  const world = new FrameXmlCannedGossipWorld();
  const playerLevel = context.playerLevel;
  const questTrivial = context.questTrivial ?? (playerLevel ? (level: number) => {
    const player = playerLevel();
    return frameXmlQuestTrivial(level, player, questGreenRange(player));
  } : undefined);
  const model = new FrameXmlGossipModel({
    world: () => world,
    formatText: context.formatText ?? ((text) => text.replaceAll("$N", "Тестер").replaceAll("$n", "Тестер")),
    questComplete: context.questComplete ?? ((questId) => questId === 47 ? true : undefined),
    ...(questTrivial ? { questTrivial } : {}),
  });
  world.onChanged = () => model.sync();
  return { model, world };
}
