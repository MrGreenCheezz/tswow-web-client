/**
 * The NPC-interaction windows as one publication unit for the world mount: GossipFrame, BankFrame,
 * TaxiFrame, ItemTextFrame and the charter windows — TabardFrame, Guild/ArenaRegistrarFrame (one
 * gate for both) and PetitionFrame — and PetStableFrame. Each is gated on its own — a failed gate leaves that one window
 * native — and each is published, and unpublished, together with the flag that lets its model raise
 * the stock events (`owned`) and its Escape entry.
 *
 * DOM-free and native-free on purpose: the native side (repainting Npc.ts/Bank.ts windows,
 * Windows.ts Escape, the gateway taxi catalog) is handed in, so this glue runs under the MPQ tests.
 */
import type { FrameXmlBoot } from "./FrameXmlBoot.js";
import type { FrameXmlDomRenderer } from "../ui/framexml_compat/FrameXmlDomRenderer.js";
import type { FrameXmlGossipModel } from "./FrameXmlGossip.js";
import type { FrameXmlBankModel } from "./FrameXmlBank.js";
import type { FrameXmlTaxiCatalogSource, FrameXmlTaxiModel } from "./FrameXmlTaxi.js";
import type { FrameXmlItemTextModel } from "./FrameXmlItemText.js";
import { closeFrameXmlGossip, frameXmlGossipOpen, publishFrameXmlGossip } from "./FrameXmlGossipController.js";
import {
  createFrameXmlGossipOwner, frameXmlGossipGate, installFrameXmlGossipQuestHandoff, installFrameXmlGossipTitleText,
  installFrameXmlNpcPortraits,
} from "./FrameXmlGossipOwner.js";
import { closeFrameXmlBank, frameXmlBankOpen, publishFrameXmlBank } from "./FrameXmlBankController.js";
import {
  FRAMEXML_BANK_OWNS_CLASS, createFrameXmlBankOwner, frameXmlBankGate, frameXmlBankOwnsCss, installFrameXmlBankAnswers,
} from "./FrameXmlBankOwner.js";
import { closeFrameXmlTaxi, frameXmlTaxiOpen, publishFrameXmlTaxi } from "./FrameXmlTaxiController.js";
import { createFrameXmlTaxiOwner, frameXmlTaxiGate, installFrameXmlTaxiMap } from "./FrameXmlTaxiOwner.js";
import { closeFrameXmlItemText, frameXmlItemTextOpen, publishFrameXmlItemText } from "./FrameXmlItemTextController.js";
import { createFrameXmlItemTextOwner, frameXmlItemTextGate, installFrameXmlItemTextPage } from "./FrameXmlItemTextOwner.js";
import type { FrameXmlTabardModel } from "./FrameXmlTabard.js";
import type { FrameXmlRegistrarModel } from "./FrameXmlRegistrar.js";
import type { FrameXmlPetitionModel } from "./FrameXmlPetition.js";
import {
  closeFrameXmlCharterWindow, frameXmlCharterOpen, publishFrameXmlCharterWindow, type FrameXmlCharterOwner,
  type FrameXmlCharterWindow,
} from "./FrameXmlPetitionController.js";
import { createFrameXmlTabardOwner, frameXmlTabardGate } from "./FrameXmlTabardOwner.js";
import { createFrameXmlRegistrarOwner, frameXmlRegistrarGate } from "./FrameXmlRegistrarOwner.js";
import { createFrameXmlPetitionOwner, frameXmlPetitionGate } from "./FrameXmlPetitionOwner.js";
import type { FrameXmlStableModel } from "./FrameXmlStable.js";
import { closeFrameXmlStable, frameXmlStableOpen, publishFrameXmlStable } from "./FrameXmlStableController.js";
import { createFrameXmlStableOwner, frameXmlStableGate } from "./FrameXmlStableOwner.js";

export interface FrameXmlNpcWindowsSeam {
  readonly gossip?: FrameXmlGossipModel | undefined;
  readonly bank?: FrameXmlBankModel | undefined;
  readonly taxi?: FrameXmlTaxiModel | undefined;
  readonly itemText?: FrameXmlItemTextModel | undefined;
  readonly tabard?: FrameXmlTabardModel | undefined;
  readonly registrar?: FrameXmlRegistrarModel | undefined;
  readonly petition?: FrameXmlPetitionModel | undefined;
  readonly stable?: FrameXmlStableModel | undefined;
}

interface EscapableEntry {
  isOpen(): boolean;
  close(): void;
}

export interface FrameXmlNpcWindowsNative {
  /** Repaint the native NPC windows from the world; each steps aside while its stock owner is published. */
  refresh?(): void;
  /** Windows.ts `registerEscapable`. */
  registerEscapable?(entry: EscapableEntry): () => void;
  /** The gateway's TaxiNodes/TaxiPath client, fetched on the first flight map. */
  taxiCatalog?: FrameXmlTaxiCatalogSource | undefined;
  /** Where the bank's CSS goes and whose body class it keys on; absent in a DOM-less host. */
  document?: Document | undefined;
  /** The world host element id the CSS is scoped to. */
  hostId?: string;
}

export interface FrameXmlNpcWindows {
  /** Which gates passed (the window that failed stays native). */
  readonly gates: {
    readonly gossip: boolean; readonly bank: boolean; readonly taxi: boolean; readonly itemText: boolean;
    readonly tabard: boolean; readonly registrar: boolean; readonly petition: boolean; readonly stable: boolean;
  };
  /** Publish every gated window; the cleanup unpublishes them and repaints the native fallbacks. */
  publish(): () => void;
}

/**
 * Gate every NPC window over a loaded boot. Installs the host answers each needs first (they are
 * harmless when a gate then fails): the bank's cost/slot-count/bag-slot answers and purchase button,
 * `SetTaxiMap`, the gossip rows' LEFT justification, the NPC portraits' stand-in art, the item-text
 * page painter and the QuestFrame → GossipFrame hand-off.
 */
export function createFrameXmlNpcWindows(
  seam: FrameXmlNpcWindowsSeam,
  boot: Pick<FrameXmlBoot, "vm" | "bridge" | "errorCount">,
  renderer: Pick<FrameXmlDomRenderer, "elementFor">,
  native: FrameXmlNpcWindowsNative = {},
): FrameXmlNpcWindows {
  if (seam.bank) installFrameXmlBankAnswers(boot);
  if (seam.taxi) installFrameXmlTaxiMap(boot, seam.taxi);
  if (seam.gossip) installFrameXmlGossipTitleText(boot);
  if (seam.gossip || seam.bank || seam.taxi) installFrameXmlNpcPortraits(boot);
  if (seam.itemText) installFrameXmlItemTextPage(boot);
  const gossip = frameXmlGossipGate(seam, boot, renderer);
  if (gossip) installFrameXmlGossipQuestHandoff(boot, gossip.frame);
  const bank = frameXmlBankGate(seam, boot, renderer);
  const taxi = frameXmlTaxiGate(seam, boot, renderer);
  const itemText = frameXmlItemTextGate(seam, boot, renderer);
  const tabard = frameXmlTabardGate(seam, boot, renderer);
  const registrar = frameXmlRegistrarGate(seam, boot, renderer);
  const petition = frameXmlPetitionGate(seam, boot, renderer);
  const stable = frameXmlStableGate(seam, boot, renderer);
  return {
    gates: {
      gossip: !!gossip, bank: !!bank, taxi: !!taxi, itemText: !!itemText,
      tabard: !!tabard, registrar: !!registrar, petition: !!petition, stable: !!stable,
    },
    publish: () => {
      const cleanups: (() => void)[] = [];
      const escape = (entry: EscapableEntry): void => {
        const unregister = native.registerEscapable?.(entry);
        if (unregister) cleanups.push(unregister);
      };
      /** One charter window: published with its Escape entry; unpublished muted, then disowned. */
      const charter = (
        window: FrameXmlCharterWindow,
        owner: FrameXmlCharterOwner & { dispose(): void },
        own: () => void,
      ): void => {
        const unpublish = publishFrameXmlCharterWindow(window, owner);
        cleanups.push(() => {
          unpublish();
          owner.dispose();
        });
        escape({ isOpen: () => frameXmlCharterOpen(window), close: () => { closeFrameXmlCharterWindow(window); } });
        own();
      };
      if (tabard && seam.tabard) {
        const model = seam.tabard;
        // A save's answer is said in UIErrorsFrame in the client's words (ERR_GUILDEMBLEM_*).
        model.useGlobalStrings((name) => boot.vm.globalString(name));
        cleanups.push(() => model.useGlobalStrings(undefined));
        charter("tabard", createFrameXmlTabardOwner(boot, tabard.frame, model), () => { model.owned = true; });
      }
      if (registrar && seam.registrar) {
        const model = seam.registrar;
        charter("registrar", createFrameXmlRegistrarOwner(boot, registrar, model), () => { model.owned = true; });
      }
      if (petition && seam.petition) {
        const model = seam.petition;
        charter("petition", createFrameXmlPetitionOwner(boot, petition.frame, model), () => { model.owned = true; });
      }
      if (stable && seam.stable) {
        const model = seam.stable;
        // A refusal is said in UIErrorsFrame in the client's words (ERR_NOT_ENOUGH_MONEY…).
        model.useGlobalStrings((name) => boot.vm.globalString(name));
        const owner = createFrameXmlStableOwner(boot, stable.frame, model);
        const unpublish = publishFrameXmlStable(owner);
        cleanups.push(() => {
          unpublish();
          owner.dispose();
          model.useGlobalStrings(undefined);
        });
        escape({ isOpen: frameXmlStableOpen, close: () => { closeFrameXmlStable(); } });
        // Taking ownership replays a stable the world holds open (PET_STABLE_SHOW).
        model.owned = true;
      }
      if (gossip && seam.gossip) {
        const model = seam.gossip;
        const owner = createFrameXmlGossipOwner(boot, gossip.frame, model);
        const unpublish = publishFrameXmlGossip(owner);
        cleanups.push(() => {
          unpublish();
          owner.dispose();
        });
        escape({ isOpen: frameXmlGossipOpen, close: closeFrameXmlGossip });
        // Taking ownership replays a page the native window may be showing (GOSSIP_SHOW).
        model.owned = true;
      }
      if (bank) {
        const unpublish = publishFrameXmlBank(createFrameXmlBankOwner(boot, bank.frame));
        // A refused purchase is said in UIErrorsFrame from now on, in the client's words.
        seam.bank?.useGlobalStrings((name) => boot.vm.globalString(name));
        if (seam.bank) seam.bank.owned = true;
        const document = native.document;
        const style = document?.createElement("style");
        if (document && style) {
          style.dataset.framexmlBank = "";
          style.textContent = frameXmlBankOwnsCss(native.hostId ?? "framexml-world-host");
          document.head.append(style);
          document.body.classList.add(FRAMEXML_BANK_OWNS_CLASS);
        }
        cleanups.push(() => {
          unpublish();
          if (seam.bank) seam.bank.owned = false;
          seam.bank?.useGlobalStrings(undefined);
          document?.body.classList.remove(FRAMEXML_BANK_OWNS_CLASS);
          style?.remove();
        });
        escape({ isOpen: frameXmlBankOpen, close: closeFrameXmlBank });
      }
      if (taxi && seam.taxi) {
        const model = seam.taxi;
        if (native.taxiCatalog) model.catalogSource = native.taxiCatalog;
        const owner = createFrameXmlTaxiOwner(boot, taxi.frame);
        const unpublish = publishFrameXmlTaxi({ ...owner, sync: () => model.sync() });
        cleanups.push(() => {
          unpublish();
          // TaxiFrame's OnHide calls CloseTaxiMap; muted, the menu survives for the native list.
          model.muted(() => owner.close());
          model.owned = false;
        });
        escape({ isOpen: frameXmlTaxiOpen, close: closeFrameXmlTaxi });
        model.owned = true;
      }
      if (itemText && seam.itemText) {
        const model = seam.itemText;
        const owner = createFrameXmlItemTextOwner(boot, itemText.frame);
        const unpublish = publishFrameXmlItemText(owner);
        cleanups.push(() => {
          unpublish();
          model.muted(() => owner.close());
          model.owned = false;
        });
        escape({ isOpen: frameXmlItemTextOpen, close: closeFrameXmlItemText });
        model.owned = true;
      }
      native.refresh?.();
      let cleaned = false;
      return () => {
        if (cleaned) return;
        cleaned = true;
        for (const cleanup of cleanups.reverse()) {
          try { cleanup(); } catch { /* one window's teardown must not strand the others */ }
        }
        native.refresh?.();
      };
    },
  };
}
