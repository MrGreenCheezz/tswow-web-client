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

/**
 * ItemTextPageText is a SimpleHTML widget (ItemTextFrame.xml:203). The bridge stores its text (Lua
 * reads it back), but the DOM renderer paints text only for FontStrings, EditBoxes and labelled
 * buttons — measured: the page element's textContent stays "" while `GetText()` answers the page.
 * Until the renderer paints SimpleHTML, a FontString in the page's own font object
 * (ItemTextFontNormal: QuestFont_Large, LEFT) sits on the page's TOPLEFT at its 270-unit width and
 * follows its SetText/SetTextColor. Remove it once SimpleHTML draws, or the page would be painted
 * twice.
 *
 * A page is HTML when it begins with `<HTML>` (stock prepends a "\n"); SimpleHTML then lays out
 * blocks: each `<P>`/`<H1>`..`<H3>` on its own line, `<BR/>` a line break, whitespace between tags
 * only layout, `&lt;`-style entities decoded, other tags (`<BODY>`, `<IMG>`, `<A>`) not drawn. The
 * mirror keeps those line breaks — stripping the tags alone ran «Глава первая» into the paragraph
 * after it — but draws every block in the page's one font (SimpleHTML's headers would use the
 * `<H1>` font object, which ItemTextFrame.xml does not declare) and ignores `align`. Any other page
 * is plain text and is shown as it is.
 */
const ITEM_TEXT_PAGE_MIRROR = `
function WebClientItemTextPage(text)
  text = tostring(text or "")
  local html = string.match(text, "^%s*(<[Hh][Tt][Mm][Ll].*)$")
  if not html then return text end
  html = string.gsub(html, ">%s+<", "><")
  html = string.gsub(html, "<[Bb][Rr]%s*/?>", "\\n")
  -- \\001 marks a block's start: it breaks the line only when text precedes it.
  html = string.gsub(html, "<[Pp]>", "\\001")
  html = string.gsub(html, "<[Pp]%s[^>]*>", "\\001")
  html = string.gsub(html, "<[Hh][1-6][^>]*>", "\\001")
  html = string.gsub(html, "</[Pp]%s*>", "\\n")
  html = string.gsub(html, "</[Hh][1-6]%s*>", "\\n")
  html = string.gsub(html, "<[^>]*>", "")
  html = string.gsub(html, "([^\\n])\\001", "%1\\n")
  html = string.gsub(html, "\\001", "")
  html = string.gsub(html, "&lt;", "<")
  html = string.gsub(html, "&gt;", ">")
  html = string.gsub(html, "&quot;", "\\"")
  html = string.gsub(html, "&nbsp;", " ")
  html = string.gsub(html, "&amp;", "&")
  html = string.gsub(html, "^%s+", "")
  html = string.gsub(html, "%s+$", "")
  return html
end
if ItemTextPageText and ItemTextPageScrollChild and not ItemTextPageTextWebClient then
  local page = ItemTextPageText
  local mirror = ItemTextPageScrollChild:CreateFontString("ItemTextPageTextWebClient", "ARTWORK", "ItemTextFontNormal")
  mirror:SetWidth(270)
  mirror:SetPoint("TOPLEFT", page, "TOPLEFT", 0, 0)
  mirror:SetJustifyH("LEFT")
  mirror:SetJustifyV("TOP")
  hooksecurefunc(page, "SetText", function(_, text)
    mirror:SetText(WebClientItemTextPage(text))
  end)
  hooksecurefunc(page, "SetTextColor", function(_, r, g, b, a)
    mirror:SetTextColor(r, g, b, a)
  end)
end
`;

export function installFrameXmlItemTextPage(boot: Pick<FrameXmlBoot, "vm">): boolean {
  return boot.vm.executeReported(ITEM_TEXT_PAGE_MIRROR, "@webclient/itemtext-page");
}

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
          and string.find(ItemTextPageTextWebClient:GetText() or "", "WebClient 2", 1, true)) and 1 or 0
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
