/**
 * Stock ItemTextFrame as the book/letter reader: the gate and the published owner. The C API is
 * FrameXmlItemText.ts. There is no native reader to replace — before this, reading an item sent
 * `CMSG_USE_ITEM` and a goober's `SMSG_GAMEOBJECT_PAGETEXT` was parsed and shown nowhere.
 *
 * ItemTextFrame.xml loads at its retail slot after ContainerFrame.xml (stock TOC line 98); the frame
 * is `parent="UIParent" hidden="true"`. Its page is a SimpleHTML widget (ItemTextPageText).
 */
import type { FrameXmlBoot } from "./FrameXmlBoot.js";
import type { FrameXmlDomRenderer } from "../ui/framexml_compat/FrameXmlDomRenderer.js";
import type { FrameXmlFrame } from "../ui/framexml_compat/FrameXmlTypes.js";
import type { FrameXmlItemTextModel } from "./FrameXmlItemText.js";
import { frameXmlSilentProbe } from "./FrameXmlGameMenuOwner.js";
import {
  frameXmlNpcClean, frameXmlNpcFrames, frameXmlNpcRegistered, frameXmlNpcRendered,
  type FrameXmlNpcFrameSpec,
} from "./FrameXmlGossipGateKit.js";

const ITEM_TEXT_FRAMES: readonly FrameXmlNpcFrameSpec[] = [
  ["ItemTextFrame", "Frame", ["OnLoad", "OnEvent", "OnShow", "OnHide"]],
  ["ItemTextScrollFrame", "ScrollFrame", []],
  ["ItemTextPageText", "SimpleHTML", []],
  ["ItemTextTitleText", "FontString", []],
  ["ItemTextCurrentPage", "FontString", []],
  ["ItemTextStatusBar", "StatusBar", []],
  ["ItemTextPrevPageButton", "Button", ["OnClick"]],
  ["ItemTextNextPageButton", "Button", ["OnClick"]],
  ["ItemTextCloseButton", "Button", ["OnClick"]],
];

/*
 * ItemTextPageText is a SimpleHTML widget (ItemTextFrame.xml:203) and the DOM renderer draws it
 * (3.35, FrameXmlSimpleHtml.ts): an HTML page as the client lays it out — `<H1>`..`<H3>`/`<P>` blocks
 * with their `align`, `<BR/>`, entities, links — and any other page as plain text. The FontString
 * mirror that stood in for it until 03.10 is gone; with it the page would be painted twice.
 */

export interface FrameXmlItemTextGateResult {
  readonly frame: FrameXmlFrame;
}

/**
 * Structural, rendered and transactional proof that stock ItemTextFrame can read.
 *
 * The probe opens a two-page stone book (BEGIN, READY), requires page 1 with only «next» shown,
 * turns the page through ItemTextNextPage (the model raises READY), requires page 2 with only
 * «previous», and closes; muted, zero new Lua errors or bridge diagnostics, frame ends hidden.
 */
export function frameXmlItemTextGate(
  seam: { readonly itemText?: FrameXmlItemTextModel | undefined },
  boot: Pick<FrameXmlBoot, "vm" | "bridge" | "errorCount">,
  renderer: Pick<FrameXmlDomRenderer, "elementFor">,
): FrameXmlItemTextGateResult | undefined {
  try {
    const itemText = seam.itemText;
    if (!itemText) return undefined;
    const frames = frameXmlNpcFrames(boot, ITEM_TEXT_FRAMES);
    const frame = frames?.get("ItemTextFrame");
    if (!frames || !frame || !frameXmlNpcRendered(renderer, frame)
      || !frameXmlNpcRegistered(frame, ["ITEM_TEXT_BEGIN", "ITEM_TEXT_READY", "ITEM_TEXT_CLOSED"])) return undefined;
    const probe = frameXmlNpcClean(boot, () => itemText.probe(
      { title: "WebClient", pages: ["WebClient 1", "WebClient 2"], material: 2 },
      () => frameXmlSilentProbe(boot, "webclient/itemtext-gate", `
        ItemTextFrame_OnEvent(ItemTextFrame, "ITEM_TEXT_BEGIN")
        ItemTextFrame_OnEvent(ItemTextFrame, "ITEM_TEXT_READY")
        local first = (ItemTextFrame:IsShown() and ItemTextNextPageButton:IsShown()
          and not ItemTextPrevPageButton:IsShown() and ItemTextCurrentPage:GetText() == "1"
          and ItemTextMaterialTopLeft:IsShown()) and 1 or 0
        ItemTextNextPage()
        local second = (ItemTextPrevPageButton:IsShown() and not ItemTextNextPageButton:IsShown()
          and ItemTextCurrentPage:GetText() == "2"
          and string.find(ItemTextPageText:GetText() or "", "WebClient 2", 1, true)) and 1 or 0
        HideUIPanel(ItemTextFrame)
        return first, second, ItemTextFrame:IsShown() and 1 or 0
      `, 3)));
    if (!probe) return undefined;
    const [first, second, still] = probe.map((value) => Number(value));
    if (first !== 1 || second !== 1 || still !== 0 || frame.visible) return undefined;
    return { frame };
  } catch {
    return undefined;
  }
}

export interface FrameXmlItemTextOwner {
  isOpen(): boolean;
  close(): void;
}

export function createFrameXmlItemTextOwner(
  boot: Pick<FrameXmlBoot, "vm" | "bridge">,
  frame: FrameXmlFrame,
): FrameXmlItemTextOwner {
  return {
    isOpen: () => boot.bridge.isVisible(frame),
    close: () => {
      if (boot.bridge.isVisible(frame)) boot.vm.executeReported("HideUIPanel(ItemTextFrame)", "@webclient/itemtext-close");
    },
  };
}
