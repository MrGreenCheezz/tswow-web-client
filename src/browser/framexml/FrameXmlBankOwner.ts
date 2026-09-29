/**
 * Stock BankFrame as the bank window: the gate, the published owner and the two answers stock
 * cannot do without. The C API is FrameXmlBank.ts plus the seam's GetNumBankSlots/GetBankSlotCost/
 * CloseBankFrame and its BANKFRAME_OPENED/CLOSED edges (LiveWorldSeam, from `BANK_OPENED`).
 *
 * BankFrame.xml has been in the vertical since the bags slice, loaded because ContainerFrame.lua
 * asks `BankFrame:IsShown()` while placing bags, and CSS-hidden as a native-owned dependency
 * (FrameXmlWorldMount `FRAMEXML_NATIVE_OWNED_DEPENDENCY_SELECTOR`). Publishing lifts that one rule
 * with a higher-specificity one scoped to a body class, so an unpublished bank stays exactly as it
 * was: the native #bank-window with the stock frame invisible behind it.
 */
import type { FrameXmlBoot } from "./FrameXmlBoot.js";
import type { FrameXmlDomRenderer } from "../ui/framexml_compat/FrameXmlDomRenderer.js";
import type { FrameXmlFrame } from "../ui/framexml_compat/FrameXmlTypes.js";
import type { FrameXmlBankModel } from "./FrameXmlBank.js";
import { frameXmlSilentProbe } from "./FrameXmlGameMenuOwner.js";
import {
  frameXmlNpcClean, frameXmlNpcFrames, frameXmlNpcRegistered, frameXmlNpcRendered,
  type FrameXmlNpcFrameSpec,
} from "./FrameXmlGossipGateKit.js";

const BANK_FRAMES: readonly FrameXmlNpcFrameSpec[] = [
  ["BankFrame", "Frame", ["OnLoad", "OnEvent", "OnShow", "OnHide"]],
  ["BankFrameTitleText", "FontString", []],
  ["BankPortraitTexture", "Texture", []],
  ["BankCloseButton", "Button", ["OnClick"]],
  ["BankFramePurchaseInfo", "Frame", []],
  ["BankFramePurchaseButton", "Button", ["OnClick"]],
  ["BankFrameDetailMoneyFrame", "Frame", []],
  ...Array.from({ length: 28 }, (_, index): FrameXmlNpcFrameSpec =>
    [`BankFrameItem${index + 1}`, "Button", ["OnClick", "OnEnter"]]),
  ...Array.from({ length: 7 }, (_, index): FrameXmlNpcFrameSpec =>
    [`BankFrameBag${index + 1}`, "Button", ["OnClick", "OnEnter"]]),
];

/** The body class under which the stock BankFrame is drawn instead of hidden. */
export const FRAMEXML_BANK_OWNS_CLASS = "framexml-world-owns-bank";

/**
 * Beats `#framexml-world-host [data-framexml-name="BankFrame"] { display: none !important }` by
 * specificity, and only while the frame is shown (the renderer sets `hidden` on a hidden frame).
 */
export function frameXmlBankOwnsCss(hostId: string): string {
  return `body.${FRAMEXML_BANK_OWNS_CLASS} #${hostId} [data-framexml-name="BankFrame"]:not([hidden]) { display: block !important; }`;
}

/**
 * `UpdateBagSlotStatus` (BankFrame.lua:117-150) compares `GetMoney() >= GetBankSlotCost(numSlots)`
 * and counts `i <= numSlots` unconditionally. The seam answers nil for a cost it does not know — all
 * seven slots bought (no eighth row is priced) or BankBagSlotPrices not loaded (the gateway's
 * `/dbc/slot-prices` is fetched once and never retried after a failure) — and for the slot count
 * before the player's fields arrive; stock raised «compare number with nil» on both. So the cost
 * answers 0 for the comparison, and a post-hook settles what that 0 would otherwise claim:
 *
 * * all seven bought — the purchase box is hidden by stock itself, 0 is never shown;
 * * a slot left but no price — the client always knows it (BankBagSlotPrices.dbc), this host may
 *   not. Neither the row's money frame nor CONFIRM_BUY_BANK_SLOT (which prints
 *   `BankFrame.nextSlotCost`) may say «0»: the server would charge the real price. The money frame
 *   is hidden and the purchase button disabled until the price is known; the native window said
 *   «Сумму назовёт сервер» for the same case. The next UpdateBagSlotStatus (PLAYER_MONEY,
 *   PLAYERBANKBAGSLOTS_CHANGED, the next BankFrame_OnShow) re-reads it, and so does the purchase
 *   row itself once a second while it is shown and waiting: the prices are fetched once at world
 *   entry and nothing raises an event when they land, so a bank opened before that (a login next
 *   to a banker) would otherwise stay unpriced for the whole visit.
 */
const BANK_ANSWERS = `
do
  local cost, slots = GetBankSlotCost, GetNumBankSlots
  if type(cost) == "function" and type(slots) == "function" then
    GetBankSlotCost = function(...) return (cost(...)) or 0 end
    GetNumBankSlots = function()
      local count, full = slots()
      return count or 0, full
    end
    if type(UpdateBagSlotStatus) == "function" then
      -- BankFramePurchaseInfo has no OnUpdate of its own; this one runs only while the row is
      -- visible and a price is missing, and stops at the first answer.
      local waited = 0
      local function waitForPrice(self, elapsed)
        waited = waited + (tonumber(elapsed) or 0)
        if waited < 1 then return end
        waited = 0
        local count, full = slots()
        if full or cost(count or 0) then
          self:SetScript("OnUpdate", nil)
          UpdateBagSlotStatus()
        end
      end
      hooksecurefunc("UpdateBagSlotStatus", function()
        local info = BankFramePurchaseInfo
        if not info then return end
        local count, full = slots()
        if full then info:SetScript("OnUpdate", nil) return end
        local known = cost(count or 0)
        local money, button = BankFrameDetailMoneyFrame, BankFramePurchaseButton
        if known then
          info:SetScript("OnUpdate", nil)
          if money then money:Show() end
          if button then button:Enable() end
        else
          BankFrame.nextSlotCost = nil
          if money then money:Hide() end
          if button then button:Disable() end
          waited = 0
          info:SetScript("OnUpdate", waitForPrice)
        end
      end)
    end
  end
  -- BankFrameItemButton_Update asks GetInventorySlotInfo(strsub("BankFrameBag1", 10)) = "Bag1".."Bag7"
  -- for an empty bag slot's picture; the seam's table knows only the carried Bag0Slot..Bag3Slot, so
  -- the seven bank bag slots (inventory 68..74) answer with the same bag silhouette here.
  local slotInfo = GetInventorySlotInfo
  if type(slotInfo) == "function" then
    GetInventorySlotInfo = function(name, ...)
      local bag = type(name) == "string" and string.match(name, "^[Bb][Aa][Gg]([1-7])$")
      if bag then return 67 + tonumber(bag), "Interface\\\\Paperdoll\\\\UI-PaperDoll-Slot-Bag" end
      return slotInfo(name, ...)
    end
  end
end
`;

/**
 * BankFrame.xml:523 declares the purchase button inside BankFramePurchaseInfo's `<Frames>` with
 * `virtual="true"`. The 3.3.5 client still creates it — it is the «Купить ячейку» button every bank
 * shows, and add-ons of the era address `BankFramePurchaseButton` — but this host's loader skips a
 * nested virtual element altogether (not instantiated, not registered as a template), measured: the
 * global is nil and CreateFrame from it reports «template is not registered». Until the loader
 * treats a nested `virtual` like the client, the button is built here from that XML, verbatim:
 * UIPanelButtonTemplate, 124x21, RIGHT of its parent at (-10, -10), BANKSLOTPURCHASE, and its OnClick.
 */
const BANK_PURCHASE_BUTTON = `
if BankFramePurchaseInfo and not BankFramePurchaseButton then
  local button = CreateFrame("Button", "BankFramePurchaseButton", BankFramePurchaseInfo, "UIPanelButtonTemplate")
  button:SetWidth(124)
  button:SetHeight(21)
  button:SetPoint("RIGHT", BankFramePurchaseInfo, "RIGHT", -10, -10)
  button:SetText(BANKSLOTPURCHASE)
  button:SetScript("OnClick", function()
    PlaySound("igMainMenuOption")
    StaticPopup_Show("CONFIRM_BUY_BANK_SLOT")
  end)
end
`;

/** The two answers above and the purchase button; run once after load, before the gate. */
export function installFrameXmlBankAnswers(boot: Pick<FrameXmlBoot, "vm">): boolean {
  return boot.vm.executeReported(BANK_ANSWERS, "@webclient/bank-answers")
    && boot.vm.executeReported(BANK_PURCHASE_BUTTON, "@webclient/bank-purchase-button");
}

export interface FrameXmlBankGateResult {
  readonly frame: FrameXmlFrame;
  /** Measured by the probe: generic slot buttons shown (28) and bag slot buttons shown (7). */
  readonly slots: number;
  readonly bags: number;
}

/**
 * Structural, rendered and transactional proof that stock BankFrame can own the bank.
 *
 * The probe runs BankFrame_OnEvent's BANKFRAME_OPENED (ShowUIPanel; OnShow draws all 35 buttons and
 * the purchase row), counts the buttons, then HideUIPanel — with CloseBankFrame silenced for the
 * probe (it would drop a banker's permission) and the model muted — and requires zero new Lua errors
 * or bridge diagnostics with the frame ending hidden.
 */
export function frameXmlBankGate(
  seam: { readonly bank?: FrameXmlBankModel | undefined },
  boot: Pick<FrameXmlBoot, "vm" | "bridge" | "errorCount">,
  renderer: Pick<FrameXmlDomRenderer, "elementFor">,
): FrameXmlBankGateResult | undefined {
  try {
    const bank = seam.bank;
    if (!bank) return undefined;
    const frames = frameXmlNpcFrames(boot, BANK_FRAMES);
    const frame = frames?.get("BankFrame");
    if (!frames || !frame || !frameXmlNpcRendered(renderer, frame)
      || !frameXmlNpcRegistered(frame, ["BANKFRAME_OPENED", "BANKFRAME_CLOSED"])) return undefined;
    const probe = frameXmlNpcClean(boot, () => bank.muted(() => frameXmlSilentProbe(boot, "webclient/bank-gate", `
      local close = CloseBankFrame
      CloseBankFrame = function() end
      local ok, shown, slots, bags = pcall(function()
        BankFrame_OnEvent(BankFrame, "BANKFRAME_OPENED")
        local shown = BankFrame:IsShown() and 1 or 0
        local slots, bags = 0, 0
        for index = 1, NUM_BANKGENERIC_SLOTS do
          if _G["BankFrameItem" .. index]:IsVisible() then slots = slots + 1 end
        end
        for index = 1, NUM_BANKBAGSLOTS do
          if _G["BankFrameBag" .. index]:IsVisible() then bags = bags + 1 end
        end
        HideUIPanel(BankFrame)
        return shown, slots, bags
      end)
      CloseBankFrame = close
      if not ok then error(shown, 0) end
      return shown, slots, bags, BankFrame:IsShown() and 1 or 0
    `, 4)));
    if (!probe) return undefined;
    const [shown, slots, bags, still] = probe.map((value) => Number(value));
    if (shown !== 1 || slots !== 28 || bags !== 7 || still !== 0 || frame.visible) return undefined;
    return { frame, slots: slots ?? 0, bags: bags ?? 0 };
  } catch {
    return undefined;
  }
}

export interface FrameXmlBankOwner {
  isOpen(): boolean;
  close(): void;
}

export function createFrameXmlBankOwner(
  boot: Pick<FrameXmlBoot, "vm" | "bridge">,
  frame: FrameXmlFrame,
): FrameXmlBankOwner {
  return {
    isOpen: () => boot.bridge.isVisible(frame),
    close: () => {
      if (boot.bridge.isVisible(frame)) boot.vm.executeReported("HideUIPanel(BankFrame)", "@webclient/bank-close");
    },
  };
}
