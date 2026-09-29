/**
 * The NPC-window models over scripted worlds, for CannedWorldSeam: the canned innkeeper
 * (FrameXmlGossipCanned.ts), flight master (FrameXmlTaxiCanned.ts), reader
 * (FrameXmlItemTextCanned.ts), guild master, arena organizer and charter (FrameXmlPetitionCanned.ts),
 * stable master (FrameXmlStableCanned.ts),
 * and a bank over the canned seam's own open/slot state. The canned seam has no bank contents (its
 * containers are the carried bags), so the stock BankFrame shows its 28 empty slots and the
 * purchase row.
 */
import { FrameXmlBankModel } from "./FrameXmlBank.js";
import { createCannedFrameXmlGossip } from "./FrameXmlGossipCanned.js";
import { createCannedFrameXmlTaxi } from "./FrameXmlTaxiCanned.js";
import { createCannedFrameXmlItemText } from "./FrameXmlItemTextCanned.js";
import { createCannedFrameXmlCharters, FRAMEXML_CANNED_GUILD_MASTER_GUID } from "./FrameXmlPetitionCanned.js";
import { createCannedFrameXmlStable } from "./FrameXmlStableCanned.js";

export interface FrameXmlCannedBankHost {
  bankOpen(): boolean;
  buyBankSlot(): void;
  /** The canned player's level, which greys the innkeeper's low quests (`frameXmlQuestTrivial`). */
  playerLevel?(): number | undefined;
}

export function createCannedFrameXmlNpcWindows(host: FrameXmlCannedBankHost) {
  const gossip = createCannedFrameXmlGossip(host.playerLevel ? { playerLevel: () => host.playerLevel?.() } : {});
  const taxi = createCannedFrameXmlTaxi();
  const itemText = createCannedFrameXmlItemText();
  const charters = createCannedFrameXmlCharters();
  const stable = createCannedFrameXmlStable();
  const bank = new FrameXmlBankModel({
    world: () => ({
      bankerGuid: host.bankOpen() ? 1n : undefined,
      buyBankSlot: () => host.buyBankSlot(),
      depositToBank: () => undefined,
      withdrawFromBank: () => undefined,
      storeItemInBag: () => undefined,
      splitItem: () => undefined,
    }),
    inventory: () => undefined,
  });
  return {
    gossip,
    taxi,
    itemText,
    bank,
    charters,
    stable,
    /** `UnitName("npc")` while a canned conversation, flight map, bank or charter vendor is open. */
    npcName(): string | undefined {
      if (gossip.world.gossip) return "Трактирщик";
      if (taxi.world.taxiMenu) return "Распорядитель полетов";
      if (host.bankOpen()) return "Банкир";
      if (stable.world.stableMasterGuid !== 0n) return "Хозяин стойл";
      const vendor = charters.world.tabardVendorGuid || charters.world.petitionVendor?.vendorGuid;
      if (vendor === undefined || vendor === 0n) return undefined;
      return vendor === FRAMEXML_CANNED_GUILD_MASTER_GUID ? "Распорядитель гильдий" : "Распорядитель арены";
    },
    attach(pump: { fire(event: string, ...args: readonly unknown[]): number }): void {
      gossip.model.attach(pump);
      taxi.model.attach(pump);
      itemText.model.attach(pump);
      bank.attach(pump);
      charters.tabard.attach(pump);
      charters.registrar.attach(pump);
      charters.petition.attach(pump);
      stable.model.attach(pump);
    },
    detach(): void {
      gossip.model.detach();
      taxi.model.detach();
      itemText.model.detach();
      bank.detach();
      charters.tabard.detach();
      charters.registrar.detach();
      charters.petition.detach();
      stable.model.detach();
    },
  };
}
