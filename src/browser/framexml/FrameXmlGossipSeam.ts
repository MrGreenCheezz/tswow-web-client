/**
 * The NPC windows' C API as one table for FRAMEXML_SEAM_BINDINGS: GossipFrame (FrameXmlGossip.ts),
 * BankFrame (FrameXmlBank.ts), TaxiFrame (FrameXmlTaxi.ts), ItemTextFrame (FrameXmlItemText.ts) and
 * the charter windows — TabardFrame (FrameXmlTabard.ts), Guild/ArenaRegistrarFrame
 * (FrameXmlRegistrar.ts) and PetitionFrame (FrameXmlPetition.ts) — and PetStableFrame
 * (FrameXmlStable.ts). Each binding reads only its own optional model on the seam, so a seam without
 * one answers the stub floor's neutral nothing, as before (the stable's slot count and price fall
 * back to FrameXmlServices.ts's answers instead).
 */
import { FRAMEXML_GOSSIP_BINDINGS, type FrameXmlGossipModel } from "./FrameXmlGossip.js";
import { FRAMEXML_BANK_BINDINGS, type FrameXmlBankModel } from "./FrameXmlBank.js";
import { FRAMEXML_TAXI_BINDINGS, type FrameXmlTaxiModel } from "./FrameXmlTaxi.js";
import { FRAMEXML_ITEM_TEXT_BINDINGS, type FrameXmlItemTextModel } from "./FrameXmlItemText.js";
import { FRAMEXML_TABARD_BINDINGS, type FrameXmlTabardModel } from "./FrameXmlTabard.js";
import { FRAMEXML_REGISTRAR_BINDINGS, type FrameXmlRegistrarModel } from "./FrameXmlRegistrar.js";
import { FRAMEXML_PETITION_BINDINGS, type FrameXmlPetitionModel } from "./FrameXmlPetition.js";
import { FRAMEXML_STABLE_BINDINGS, type FrameXmlStableHost } from "./FrameXmlStable.js";

/** The optional models a world seam carries for the NPC windows. */
export interface FrameXmlNpcWindowModels {
  readonly gossip?: FrameXmlGossipModel | undefined;
  readonly bank?: FrameXmlBankModel | undefined;
  readonly taxi?: FrameXmlTaxiModel | undefined;
  readonly itemText?: FrameXmlItemTextModel | undefined;
  readonly tabard?: FrameXmlTabardModel | undefined;
  readonly registrar?: FrameXmlRegistrarModel | undefined;
  readonly petition?: FrameXmlPetitionModel | undefined;
  /** PetStableFrame's model, and the services answers its slot count/price fall back to. */
  readonly stable?: FrameXmlStableHost["stable"];
  readonly services?: FrameXmlStableHost["services"];
}

export type FrameXmlNpcWindowBinding = (host: FrameXmlNpcWindowModels, args: readonly unknown[]) => readonly unknown[];

export const FRAMEXML_NPC_WINDOW_BINDINGS: Readonly<Record<string, FrameXmlNpcWindowBinding>> = Object.freeze({
  ...FRAMEXML_GOSSIP_BINDINGS,
  ...FRAMEXML_BANK_BINDINGS,
  ...FRAMEXML_TAXI_BINDINGS,
  ...FRAMEXML_ITEM_TEXT_BINDINGS,
  ...FRAMEXML_TABARD_BINDINGS,
  ...FRAMEXML_REGISTRAR_BINDINGS,
  ...FRAMEXML_PETITION_BINDINGS,
  ...FRAMEXML_STABLE_BINDINGS,
});
